/**
 * Формат скилла (Agent Skills, agentskills.io): папка с `SKILL.md`, во frontmatter `name` и `description`,
 * дальше markdown-инструкции; рядом могут лежать `references/`, `assets/`, `scripts/`. В интерфейсе Волны это техкарта
 * (docs/skills.md). Правила, продиктованные голосом, живут в разделе «Правила владельца», остальной текст скилла
 * голосом не правится: так скилл из интернета не затирается.
 */

export const SKILL_FILE = 'SKILL.md';
export const RULES_HEADING = '## Правила владельца';
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;

export type Frontmatter = Record<string, unknown>;

export interface SkillFile {
  frontmatter: Frontmatter;
  /** Frontmatter как в файле: при правке правил чужого скилла он пишется обратно без изменений. */
  rawFrontmatter: string;
  body: string;
}

export function parseSkillFile(text: string): SkillFile {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) throw new Error('SKILL.md must start with a --- frontmatter block');
  return { frontmatter: parseYaml(match[1]!), rawFrontmatter: match[1]!, body: normalized.slice(match[0].length).replace(/^\n+/, '') };
}

export function serializeSkillFile(frontmatter: string, body: string): string {
  return `---\n${frontmatter.replace(/\n+$/, '')}\n---\n\n${body.replace(/^\n+/, '').replace(/\n*$/, '\n')}`;
}

/** Frontmatter скилла, который пишет сама Волна: только строки, в двойных кавычках (подмножество YAML, совпадающее с JSON). */
export function buildFrontmatter(fields: { name: string; description: string; metadata?: Record<string, string> }): string {
  const lines = [`name: ${fields.name}`, `description: ${JSON.stringify(fields.description)}`];
  const metadata = Object.entries(fields.metadata ?? {});
  if (metadata.length) lines.push('metadata:', ...metadata.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`));
  return lines.join('\n');
}

/** Строковое поле frontmatter, иначе null. */
export function field(frontmatter: Frontmatter, key: string): string | null {
  const value = frontmatter[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * `allowed-tools` по спецификации — строка через пробел; принимаем и список YAML. Для Волны это инструменты,
 * которые модель увидит, когда Jev выберет техкарту (docs/tools-routing.md).
 */
export function allowedTools(frontmatter: Frontmatter): string[] {
  const value = frontmatter['allowed-tools'];
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return [...new Set(items.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

/** Уровень техкарты (`metadata.tier`): решается при создании и служит нижней планкой маршрута. */
export type SkillTier = 'simple' | 'standard' | 'work';
export const SKILL_TIERS: readonly SkillTier[] = ['simple', 'standard', 'work'];
export function skillTier(frontmatter: Frontmatter): SkillTier | null {
  const value = metadataField(frontmatter, 'tier');
  return SKILL_TIERS.includes(value as SkillTier) ? value as SkillTier : null;
}

export function metadataField(frontmatter: Frontmatter, key: string): string | null {
  const metadata = frontmatter.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? field(metadata as Frontmatter, key) : null;
}

/** Имя по спецификации: строчные латинские буквы, цифры и дефисы, без дефиса в начале, конце и подряд. */
export function isValidName(name: string): boolean {
  return name.length <= MAX_NAME && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

/** Имя папки и `name` для техкарты, заведённой голосом: «Разработка Волны» → razrabotka-volny. */
export function slugify(title: string): string {
  const latin = [...title.toLowerCase()].map(ch => TRANSLIT[ch] ?? ch).join('');
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME).replace(/-+$/, '');
  return slug || 'card';
}

/** Правила из раздела «Правила владельца»: пункты нумерованного или маркированного списка. */
export function readRules(body: string): string[] {
  const section = findRulesSection(body);
  if (!section) return [];
  const rules: string[] = [];
  for (const line of body.slice(section.start, section.end).split('\n').slice(1)) {
    const item = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
    if (item) rules.push(item[1]!.trim());
    else if (line.trim() && rules.length) rules[rules.length - 1] += ` ${line.trim()}`;
  }
  return rules.filter(Boolean);
}

/** Тело с новым списком правил владельца: раздел заменяется, а если его не было, дописывается в конец. Пустой список убирает раздел. */
export function writeRules(body: string, rules: readonly string[]): string {
  const block = rules.length ? `${RULES_HEADING}\n\n${rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}\n` : '';
  const section = findRulesSection(body);
  if (section) {
    const before = body.slice(0, section.start).replace(/\n+$/, '');
    const after = body.slice(section.end).replace(/^\n+/, '');
    return [before, block.trimEnd(), after.trimEnd()].filter(Boolean).join('\n\n') + '\n';
  }
  return [body.trimEnd(), block.trimEnd()].filter(Boolean).join('\n\n') + '\n';
}

/** Тело без раздела правил владельца и без заголовка первого уровня: то, что написал автор скилла. */
export function authorText(body: string): string {
  const section = findRulesSection(body);
  const rest = section ? body.slice(0, section.start) + body.slice(section.end) : body;
  return rest.replace(/^#\s+.*\n?/, '').trim();
}

function findRulesSection(body: string): { start: number; end: number } | null {
  const lines = body.split('\n');
  let offset = 0;
  let start = -1;
  for (const line of lines) {
    if (start < 0 && line.trim().toLowerCase() === RULES_HEADING.toLowerCase()) start = offset;
    else if (start >= 0 && /^#{1,2}\s/.test(line)) return { start, end: offset };
    offset += line.length + 1;
  }
  return start >= 0 ? { start, end: body.length } : null;
}

/**
 * Небольшое подмножество YAML, которого хватает frontmatter скиллов: скаляры (простые и в кавычках), многострочные
 * `|` и `>`, вложенные словари, списки `- x` и `[a, b]`. Неизвестное не ломает разбор: такое поле просто не читается.
 */
export function parseYaml(source: string): Frontmatter {
  const lines = source.split('\n').filter(line => !/^\s*#/.test(line));
  const [value] = parseBlock(lines, 0, 0);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Frontmatter : {};
}

function indentOf(line: string): number { return line.length - line.trimStart().length; }

function parseBlock(lines: string[], start: number, indent: number): [unknown, number] {
  let i = start;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length) return [null, i];
  if (lines[i]!.trimStart().startsWith('- ') || lines[i]!.trim() === '-') {
    const list: unknown[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) { i++; continue; }
      if (indentOf(line) !== indent || !(line.trimStart().startsWith('- ') || line.trim() === '-')) break;
      list.push(scalar(line.trimStart().slice(1).trim()));
      i++;
    }
    return [list, i];
  }
  const map: Frontmatter = {};
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const own = indentOf(line);
    if (own < indent) break;
    const pair = /^([^:#]+?):(?:\s+(.*))?$/.exec(line.trim());
    if (own > indent || !pair) { i++; continue; }
    const key = pair[1]!.trim().replace(/^["']|["']$/g, '');
    const rest = (pair[2] ?? '').trim();
    i++;
    if (/^[|>][+-]?$/.test(rest)) {
      const block: string[] = [];
      let blockIndent = -1;
      while (i < lines.length && (!lines[i]!.trim() || indentOf(lines[i]!) > own)) {
        if (lines[i]!.trim() && blockIndent < 0) blockIndent = indentOf(lines[i]!);
        block.push(lines[i]!.slice(Math.max(blockIndent, 0)));
        i++;
      }
      const text = block.join('\n').replace(/\s+$/, '');
      map[key] = rest.startsWith('>') ? text.split(/\n\s*\n/).map(p => p.replace(/\n/g, ' ').trim()).join('\n') : text;
    } else if (!rest) {
      let next = i;
      while (next < lines.length && !lines[next]!.trim()) next++;
      const child = next < lines.length ? indentOf(lines[next]!) : 0;
      const nested = next < lines.length && (child > own || (child === own && lines[next]!.trimStart().startsWith('-')));
      if (nested) [map[key], i] = parseBlock(lines, next, child);
      else map[key] = null;
    } else {
      let text = rest;
      // Простой скаляр может продолжаться на следующих строках с отступом.
      if (!/^["'[{]/.test(rest)) {
        while (i < lines.length && lines[i]!.trim() && indentOf(lines[i]!) > own && !/^[^:]+:(\s|$)/.test(lines[i]!.trim())) text += ` ${lines[i++]!.trim()}`;
      }
      map[key] = scalar(text);
    }
  }
  return [map, i];
}

function scalar(text: string): unknown {
  const value = text.replace(/\s+#.*$/, '');
  if (text.startsWith('"')) {
    try { return JSON.parse(text.slice(0, text.lastIndexOf('"') + 1)) as string; } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'")) return text.slice(1, text.lastIndexOf("'")).replace(/''/g, "'");
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').map(item => scalar(item.trim())).filter(item => item !== '');
  if (value === 'true' || value === 'false') return value === 'true';
  if (value === 'null' || value === '~') return null;
  return value;
}
