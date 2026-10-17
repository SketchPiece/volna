import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { buildFrontmatter, serializeSkillFile, SKILL_FILE } from '../skills/format.ts';
import {
  fingerprint, MANIFEST_FILE, MCP_FILE, parseManifest, parseServers, PLUGIN_SKILLS_DIR, PLUGIN_WORDS, toolPrefix, type ServerConfig
} from './format.ts';

/**
 * Плагины в `data/plugins/<имя>/` (`MEMORY_DIR/plugins`) и их состояние в `data/plugins/.state.json`.
 * Инвариант доступа: плагин с MCP-серверами включается только `npm run plugins -- enable` на Mac (позже кнопкой на телефоне),
 * никогда голосом. Включение запоминает отпечаток `.mcp.json`; если конфигурация серверов потом поменялась, плагин не
 * загружается, пока владелец не включит его снова. Выключить можно откуда угодно: выключение доступ только забирает.
 */
export type PluginStatus = 'enabled' | 'disabled' | 'changed';

export interface Plugin {
  name: string;
  description: string;
  version: string | null;
  dir: string;
  status: PluginStatus;
  servers: ServerConfig[];
  /** Серверы, которые ядро не умеет запускать, с причиной. */
  skipped: { name: string; reason: string }[];
  /** Имена папок техкарт в `skills/`. */
  skills: string[];
  skillsDir: string;
}

const stateSchema = z.record(z.string(), z.object({
  enabled: z.boolean(),
  /** Отпечаток одобренной конфигурации серверов; пустая строка — серверов не было. */
  approved: z.string().nullable(),
  changedAt: z.string()
}));
type State = z.infer<typeof stateSchema>;

export class PluginStore {
  readonly #dir: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = resolve(dir);
  }

  get dir(): string { return this.#dir; }

  /** Все установленные плагины, заново с диска. Плагин с битым plugin.json пропускается. */
  async list(): Promise<Plugin[]> {
    const state = await this.#readState();
    let entries: string[];
    try {
      entries = (await readdir(this.#dir, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
    } catch {
      return [];
    }
    const plugins: Plugin[] = [];
    for (const entry of entries.sort()) {
      const plugin = await readPlugin(join(this.#dir, entry), state).catch(() => null);
      if (plugin && plugin.name === entry) plugins.push(plugin);
    }
    return plugins;
  }

  async get(name: string): Promise<Plugin | null> {
    return (await this.list()).find(plugin => plugin.name === name) ?? null;
  }

  /** Включённые и одобренные в текущей конфигурации: их техкарты видны, их MCP-серверы ядро Волны запускает. */
  async active(): Promise<Plugin[]> {
    return (await this.list()).filter(plugin => plugin.status === 'enabled');
  }

  /** Папки техкарт активных плагинов для SkillStore; перечитываются при каждом вызове, выключение действует сразу. */
  async skillDirs(): Promise<string[]> {
    return (await this.active()).filter(plugin => plugin.skills.length).map(plugin => plugin.skillsDir);
  }

  async isActive(name: string): Promise<boolean> {
    return (await this.get(name))?.status === 'enabled';
  }

  /**
   * Установка из папки с `.claude-plugin/plugin.json`: копия в data/plugins/<name> без `.git`. Если у плагина нет ни одной
   * техкарты, ядро дописывает свою (`skills/<name>/SKILL.md` с `allowed-tools: <name>_*`), иначе его инструменты
   * никогда не попадут в звонок. Плагин без серверов включается сразу: доступа он не даёт, это только текст.
   */
  install(from: string, { force = false }: { force?: boolean } = {}): Promise<Plugin> {
    return this.#serial(async () => {
      const source = resolve(from);
      const manifest = parseManifest(await readFile(join(source, MANIFEST_FILE), 'utf8'));
      const target = join(this.#dir, manifest.name);
      if (await exists(target)) {
        if (!force) throw new Error(`${PLUGIN_WORDS.one} «${manifest.name}» is already installed; pass --force to replace it`);
        await rm(target, { recursive: true, force: true });
      }
      await mkdir(this.#dir, { recursive: true });
      await cp(source, target, { recursive: true, filter: path => !path.split(sep).includes('.git') && !path.split(sep).includes('node_modules') });
      const state = await this.#readState();
      let plugin = await readPlugin(target, state);
      if (!plugin.skills.length) {
        await writeGeneratedSkill(plugin);
        plugin = await readPlugin(target, state);
      }
      // Переустановка забирает прежнее одобрение, если серверы поменялись: так работает сравнение отпечатков.
      if (!plugin.servers.length && !state[plugin.name]?.enabled) {
        state[plugin.name] = { enabled: true, approved: '', changedAt: new Date().toISOString() };
        await this.#writeState(state);
      }
      return readPlugin(target, await this.#readState());
    });
  }

  /**
   * Включает плагин и одобряет его текущие MCP-серверы. Зовётся только из `npm run plugins -- enable`: это решение,
   * открывающее доступ, и голосом оно не принимается (docs/skills.md).
   */
  enable(name: string): Promise<Plugin | null> {
    return this.#serial(async () => {
      const plugin = await this.get(name);
      if (!plugin) return null;
      const state = await this.#readState();
      state[name] = { enabled: true, approved: fingerprint(plugin.servers), changedAt: new Date().toISOString() };
      await this.#writeState(state);
      return this.get(name);
    });
  }

  /** Выключает плагин: техкарты пропадают сразу, инструменты отвечают `plugin_disabled`, серверы остановятся при перезапуске. */
  disable(name: string): Promise<Plugin | null> {
    return this.#serial(async () => {
      const plugin = await this.get(name);
      if (!plugin) return null;
      const state = await this.#readState();
      state[name] = { enabled: false, approved: null, changedAt: new Date().toISOString() };
      await this.#writeState(state);
      return this.get(name);
    });
  }

  remove(name: string): Promise<boolean> {
    return this.#serial(async () => {
      const plugin = await this.get(name);
      const state = await this.#readState();
      delete state[name];
      await this.#writeState(state);
      if (!plugin) return false;
      await rm(plugin.dir, { recursive: true, force: true });
      return true;
    });
  }

  async #readState(): Promise<State> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(join(this.#dir, '.state.json'), 'utf8')));
    } catch {
      return {};
    }
  }

  async #writeState(state: State): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const target = join(this.#dir, '.state.json');
    await writeFile(`${target}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${target}.tmp`, target);
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }
}

async function readPlugin(dir: string, state: State): Promise<Plugin> {
  const manifest = parseManifest(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
  const mcpFile = await readFile(join(dir, MCP_FILE), 'utf8').then(text => JSON.parse(text) as unknown, () => undefined);
  const { servers, skipped } = parseServers([mcpFile, manifest.mcpServers]);
  const skillsDir = join(dir, PLUGIN_SKILLS_DIR);
  const skills: string[] = [];
  for (const entry of await readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    if ((entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && await exists(join(skillsDir, entry.name, SKILL_FILE))) skills.push(entry.name);
  }
  const saved = state[manifest.name];
  const status: PluginStatus = !saved?.enabled ? 'disabled' : saved.approved === fingerprint(servers) ? 'enabled' : 'changed';
  return { name: manifest.name, description: manifest.description, version: manifest.version ?? null, dir, status, servers, skipped, skills: skills.sort(), skillsDir };
}

/** Техкарта для плагина без своих: описание из plugin.json, все инструменты плагина по маске. */
async function writeGeneratedSkill(plugin: Plugin): Promise<void> {
  const dir = join(plugin.skillsDir, plugin.name);
  await mkdir(dir, { recursive: true });
  const frontmatter = `${buildFrontmatter({ name: plugin.name, description: plugin.description || plugin.name, metadata: { origin: 'plugin' } })}\nallowed-tools: ${toolPrefix(plugin.name)}_*`;
  await writeFile(join(dir, SKILL_FILE), serializeSkillFile(frontmatter, `# ${plugin.name}\n\n${plugin.description}\n`));
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** Папки плагинов внутри источника (репозиторий-маркетплейс держит их много): где есть `.claude-plugin/plugin.json`. */
export async function findPlugins(dir: string, depth = 0): Promise<string[]> {
  if (await exists(join(dir, MANIFEST_FILE))) return [dir];
  if (depth >= 4) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => findPlugins(join(dir, e.name), depth + 1)));
  return nested.flat();
}
