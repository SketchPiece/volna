import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { score, tokens } from '../memory/store.ts';
import {
  allowedTools, buildFrontmatter, field, skillTier, type SkillTier, isValidName, MAX_DESCRIPTION, metadataField, parseSkillFile, readRules,
  serializeSkillFile, SKILL_FILE, slugify, writeRules
} from './format.ts';

/**
 * Техкарты в формате скиллов (docs/skills.md). Четыре источника, по возрастанию приоритета:
 * - builtin: `core/skills/` в репозитории, приходят вместе с расширениями; голосом не правятся;
 * - external: папки из SKILLS_EXTRA_DIRS (например, ~/.claude/skills), только чтение;
 * - plugin: `skills/` включённых плагинов в `data/plugins/` (plugins/store.ts), только чтение, список папок спрашивается
 *   при каждом вызове, поэтому выключенный плагин пропадает сразу;
 * - owner: `data/skills/`, сюда пишет голос и `npm run skills -- add`.
 * Одноимённый скилл владельца заменяет скилл из другого источника, а скилл владельца с `metadata.overlay` только
 * добавляет правила поверх него: заводские инструкции остаются, правила владельца идут следом.
 */
export type SkillSource = 'builtin' | 'external' | 'plugin' | 'owner';
export interface SkillRoot { dir: string; source: SkillSource }

export const MAX_SKILL_RULES = 30;
export const MAX_SKILL_HISTORY = 10;
/** Сколько текста скилла и приложенного файла отдаётся модели за один вызов. */
export const MAX_READ_CHARS = 12_000;
const MAX_FILES = 40;
const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html?|css|js|ts|py|sh|rb|swift|sql|toml|ini)$/i;

export interface Skill {
  name: string;
  /** Название для людей: `metadata.title` или имя. */
  title: string;
  description: string;
  source: SkillSource;
  /** Заведена голосом в Волне; у неё голос правит и описание, а не только правила. */
  byWave: boolean;
  /** Правила владельца лежат слоем поверх скилла из другого источника. */
  overlay: boolean;
  dir: string;
  body: string;
  rules: string[];
  /** Файлы рядом со SKILL.md, пути от папки скилла. */
  files: string[];
  /** `allowed-tools`: с ними техкарта участвует в маршруте Jev; без них это только текст для модели. */
  tools: string[];
  /** `metadata.tier`: нижняя планка маршрута; null — класс выбирает Jev. */
  tier: SkillTier | null;
  /** `metadata.route: "off"`: не прошла проверку на Jev (skills/check.ts) и остаётся текстом, в маршрут не идёт. */
  routed: boolean;
  /** `metadata.system`: встроенная техкарта маршрута (время, планы…); экран «Память» и список в инструкциях её не показывают. */
  system: boolean;
  updatedAt: string;
}

const versionSchema = z.object({ at: z.string(), title: z.string(), description: z.string(), rules: z.array(z.string()) });
const historySchema = z.record(z.string(), z.array(versionSchema));
type History = z.infer<typeof historySchema>;

export interface RulesDraft { title: string; when: string; rules: string[] }

export class SkillStore {
  readonly #roots: SkillRoot[];
  readonly #ownerDir: string;
  readonly #log: Logger | undefined;
  readonly #pluginDirs: (() => Promise<string[]>) | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor({ ownerDir, builtinDir, externalDirs = [], pluginDirs, log }: {
    ownerDir: string; builtinDir?: string; externalDirs?: string[]; pluginDirs?: () => Promise<string[]>; log?: Logger;
  }) {
    this.#ownerDir = resolve(ownerDir);
    this.#log = log;
    this.#pluginDirs = pluginDirs;
    this.#roots = [
      ...(builtinDir ? [{ dir: resolve(builtinDir), source: 'builtin' as const }] : []),
      ...externalDirs.map(dir => ({ dir: resolve(dir), source: 'external' as const })),
      { dir: this.#ownerDir, source: 'owner' as const }
    ];
  }

  get ownerDir(): string { return this.#ownerDir; }

  /** Все скиллы, заново с диска: скилл, положенный в папку руками, виден со следующего вызова. */
  async list(): Promise<Skill[]> {
    const byName = new Map<string, Skill>();
    const plugins = (await this.#pluginDirs?.().catch(() => []) ?? []).map(dir => ({ dir: resolve(dir), source: 'plugin' as const }));
    for (const root of [...this.#roots.slice(0, -1), ...plugins, this.#roots.at(-1)!]) {
      for (const skill of await this.#scan(root)) {
        const base = byName.get(skill.name);
        byName.set(skill.name, skill.overlay && base ? mergeOverlay(base, skill) : { ...skill, overlay: false });
      }
    }
    return [...byName.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  }

  /** Скилл по имени или названию: точное совпадение без регистра, иначе лучший по словам названия и описания. */
  async find(query: string): Promise<Skill | null> {
    return pick(await this.list(), query);
  }

  /** Строка для инструкций бэкенда: какие техкарты есть. Пусто, если их нет. */
  async index(): Promise<string> {
    const skills = (await this.list()).filter(skill => !skill.system);
    if (!skills.length) return '';
    return `Техкарты: ${skills.map(skill => `«${skill.title}» (${clip(skill.description, 240)})`).join('; ')}.`;
  }

  async history(name: string): Promise<History[string]> {
    return (await this.#readHistory())[name] ?? [];
  }

  /** Приложенный к скиллу текстовый файл; путь только внутри папки скилла. */
  async readFile(skill: Skill, path: string): Promise<{ text: string; truncated: boolean } | null> {
    const target = resolve(skill.dir, path);
    if (!target.startsWith(skill.dir + sep) || !TEXT_FILE.test(target)) return null;
    try {
      const text = await readFile(target, 'utf8');
      return { text: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS };
    } catch {
      return null;
    }
  }

  /**
   * Записывает правила владельца целиком: в свою техкарту, поверх скилла из другого источника (слоем) или в новую.
   * Прежняя версия уходит в историю. У техкарты, заведённой голосом, меняются и название с описанием; у чужого скилла
   * только раздел «Правила владельца».
   */
  writeRules(draft: RulesDraft): Promise<{ skill: Skill; created: boolean }> {
    return this.#serial(async () => {
      const rules = [...new Set(draft.rules.map(rule => rule.trim()).filter(Boolean))].slice(0, MAX_SKILL_RULES);
      const title = draft.title.trim();
      const when = clip(draft.when.trim(), MAX_DESCRIPTION);
      const all = await this.list();
      const existing = exact(all, title) ?? pick(all, title);
      if (existing) await this.#remember(existing);
      let dir: string;
      if (!existing) {
        dir = await this.#freeDir(slugify(title));
        const name = dir.split(sep).at(-1)!;
        await this.#write(dir, buildFrontmatter({ name, description: when, metadata: { title, origin: 'volna' } }), writeRules(`# ${title}\n`, rules));
      } else if (existing.source === 'owner' && existing.byWave && !existing.overlay) {
        dir = existing.dir;
        const nextTitle = title || existing.title;
        await this.#write(dir, buildFrontmatter({ name: existing.name, description: when || existing.description, metadata: { title: nextTitle, origin: 'volna' } }),
          writeRules(existing.body.replace(/^#\s+.*$/m, `# ${nextTitle}`), rules));
      } else if (existing.source === 'owner' && !existing.overlay) {
        dir = existing.dir;
        const file = parseSkillFile(await readFile(join(dir, SKILL_FILE), 'utf8'));
        await this.#write(dir, file.rawFrontmatter, writeRules(file.body, rules));
      } else {
        // Скилл встроенный или внешний: правила владельца ложатся слоем в data/skills/<имя>.
        dir = join(this.#ownerDir, existing.name);
        await this.#write(dir, buildFrontmatter({ name: existing.name, description: existing.description, metadata: { title: existing.title, overlay: 'true' } }), writeRules('', rules));
      }
      const skill = (await this.list()).find(s => s.dir === dir || s.name === dir.split(sep).at(-1))!;
      return { skill, created: !existing };
    });
  }

  /** Удаляет техкарту владельца (для слоя: только правила поверх). Встроенные и внешние не удаляются. */
  remove(name: string): Promise<'removed' | 'missing' | 'readonly'> {
    return this.#serial(async () => {
      const skill = (await this.list()).find(s => s.name === name);
      if (!skill) return 'missing';
      if (skill.source !== 'owner' && !skill.overlay) return 'readonly';
      await rm(join(this.#ownerDir, skill.name), { recursive: true, force: true });
      const history = await this.#readHistory();
      delete history[skill.name];
      await this.#writeHistory(history);
      return 'removed';
    });
  }

  /** «Забыть всё»: техкарты, заведённые голосом, и правила владельца поверх чужих скиллов. Установленные скиллы остаются. */
  wipeOwn(): Promise<number> {
    return this.#serial(async () => {
      const own = (await this.#scan({ dir: this.#ownerDir, source: 'owner' })).filter(skill => skill.byWave || skill.overlay);
      for (const skill of own) await rm(skill.dir, { recursive: true, force: true });
      const history = await this.#readHistory();
      for (const skill of own) delete history[skill.name];
      await this.#writeHistory(history);
      return own.length;
    });
  }

  /** Установка скилла из папки (npm run skills -- add): копия в data/skills/<name>. */
  install(from: string, { force = false }: { force?: boolean } = {}): Promise<Skill> {
    return this.#serial(async () => {
      const source = resolve(from);
      const parsed = parseSkillFile(await readFile(join(source, SKILL_FILE), 'utf8'));
      const name = field(parsed.frontmatter, 'name') ?? source.split(sep).at(-1)!;
      if (!isValidName(name)) throw new Error(`Invalid skill name «${name}»: lowercase letters, digits and hyphens`);
      if (!field(parsed.frontmatter, 'description')) throw new Error('SKILL.md has no description');
      const target = join(this.#ownerDir, name);
      if (await exists(target)) {
        if (!force) throw new Error(`Skill «${name}» is already installed; pass --force to replace it`);
        await rm(target, { recursive: true, force: true });
      }
      await mkdir(this.#ownerDir, { recursive: true });
      await cp(source, target, { recursive: true, filter: path => !path.split(sep).includes('.git') });
      return (await this.list()).find(skill => skill.name === name)!;
    });
  }

  /** Перенос техкарт из memory.json (до 23.09.2026 они жили там) в скиллы; история переезжает вместе с ними. */
  migrate(cards: readonly { title: string; when: string; rules: string[]; updatedAt: string; history: { at: string; title: string; when: string; rules: string[] }[] }[]): Promise<number> {
    return this.#serial(async () => {
      let moved = 0;
      const history = await this.#readHistory();
      for (const card of cards) {
        if (exact(await this.list(), card.title)) continue;
        const dir = await this.#freeDir(slugify(card.title));
        const name = dir.split(sep).at(-1)!;
        await this.#write(dir, buildFrontmatter({ name, description: clip(card.when, MAX_DESCRIPTION), metadata: { title: card.title, origin: 'volna' } }), writeRules(`# ${card.title}\n`, card.rules));
        history[name] = card.history.map(v => ({ at: v.at, title: v.title, description: v.when, rules: v.rules })).slice(-MAX_SKILL_HISTORY);
        moved++;
      }
      await this.#writeHistory(history);
      return moved;
    });
  }

  async #scan(root: SkillRoot): Promise<Skill[]> {
    let entries: string[];
    try {
      entries = (await readdir(root.dir, { withFileTypes: true })).filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map(e => e.name);
    } catch {
      return [];
    }
    const skills: Skill[] = [];
    for (const entry of entries.sort()) {
      const dir = join(root.dir, entry);
      let text: string;
      try { text = await readFile(join(dir, SKILL_FILE), 'utf8'); } catch { continue; }
      try {
        const { frontmatter, body } = parseSkillFile(text);
        const name = field(frontmatter, 'name') ?? entry;
        const description = field(frontmatter, 'description');
        const overlay = metadataField(frontmatter, 'overlay') === 'true';
        if (!description && !overlay) { this.#log?.warn('skill.skipped', { dir: entry, reason: 'no_description' }); continue; }
        skills.push({
          name, title: metadataField(frontmatter, 'title') ?? name, description: description ?? '', source: root.source,
          byWave: metadataField(frontmatter, 'origin') === 'volna', overlay, dir, body, rules: readRules(body),
          tools: allowedTools(frontmatter), tier: skillTier(frontmatter), system: metadataField(frontmatter, 'system') === 'true',
          routed: metadataField(frontmatter, 'route') !== 'off',
          files: await listFiles(dir), updatedAt: (await stat(join(dir, SKILL_FILE))).mtime.toISOString()
        });
      } catch {
        this.#log?.warn('skill.skipped', { dir: entry, reason: 'bad_frontmatter' });
      }
    }
    return skills;
  }

  async #remember(skill: Skill): Promise<void> {
    const history = await this.#readHistory();
    const versions = history[skill.name] ?? [];
    history[skill.name] = [...versions, { at: skill.updatedAt, title: skill.title, description: skill.description, rules: skill.rules }].slice(-MAX_SKILL_HISTORY);
    await this.#writeHistory(history);
  }

  async #freeDir(slug: string): Promise<string> {
    const taken = new Set((await this.list()).map(skill => skill.name));
    let name = slug;
    for (let i = 2; taken.has(name) || await exists(join(this.#ownerDir, name)); i++) name = `${slug.slice(0, 60)}-${i}`;
    return join(this.#ownerDir, name);
  }

  async #write(dir: string, frontmatter: string, body: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const target = join(dir, SKILL_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, serializeSkillFile(frontmatter, body));
    await rename(temp, target);
  }

  async #readHistory(): Promise<History> {
    try {
      return historySchema.parse(JSON.parse(await readFile(join(this.#ownerDir, '.history.json'), 'utf8')));
    } catch {
      return {};
    }
  }

  async #writeHistory(history: History): Promise<void> {
    await mkdir(this.#ownerDir, { recursive: true });
    const target = join(this.#ownerDir, '.history.json');
    await writeFile(`${target}.tmp`, JSON.stringify(history, null, 2));
    await rename(`${target}.tmp`, target);
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }
}

function mergeOverlay(base: Skill, overlay: Skill): Skill {
  return { ...base, source: base.source, overlay: true, rules: overlay.rules, body: writeRules(base.body, overlay.rules), updatedAt: overlay.updatedAt };
}

function exact(skills: readonly Skill[], query: string): Skill | null {
  const wanted = query.trim().toLowerCase();
  return skills.find(skill => skill.title.toLowerCase() === wanted || skill.name === wanted) ?? null;
}

function pick(skills: readonly Skill[], query: string): Skill | null {
  if (!query.trim()) return null;
  const found = exact(skills, query);
  if (found) return found;
  const terms = tokens(query);
  if (!terms.length) return null;
  const best = skills
    .map(skill => ({ skill, score: Math.max(score(tokens(`${skill.title} ${skill.name.replace(/-/g, ' ')}`), terms), score(tokens(`${skill.title} ${skill.description}`), terms) * 0.8) }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score)[0];
  return best?.skill ?? null;
}

async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string, depth: number) => {
    if (depth > 3 || found.length >= MAX_FILES) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || found.length >= MAX_FILES) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.name !== SKILL_FILE) found.push(relative(dir, path));
    }
  };
  await walk(dir, 0);
  return found;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
