import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ToolEffect } from '../assistant/tools/registry.ts';
import { isValidName } from '../skills/format.ts';

/**
 * Плагин в формате плагинов Claude Code: папка с `.claude-plugin/plugin.json` (name, description, version),
 * техкартами в `skills/<имя>/SKILL.md` и MCP-серверами в `.mcp.json`. Техкарта плагина маршрутизируется как любая другая
 * (`allowed-tools`), а инструменты его MCP-серверов ядро Волны добавляет в реестр под именами `<плагин>_<инструмент>`.
 * Устройство: docs/skills.md, раздел о плагинах.
 */

/**
 * Как плагины называются для людей (CLI, ответы модели, источник техкарты). Название ещё не выбрано владельцем,
 * поэтому оно живёт только здесь: переименование — правка этих строк.
 */
export const PLUGIN_WORDS = { one: 'плагин', many: 'плагины', from: 'из плагина' } as const;

export const MANIFEST_FILE = '.claude-plugin/plugin.json';
export const MCP_FILE = '.mcp.json';
export const PLUGIN_SKILLS_DIR = 'skills';

const manifestSchema = z.object({
  name: z.string().refine(isValidName, 'lowercase letters, digits and hyphens, up to 64 characters'),
  description: z.string().default(''),
  version: z.string().optional(),
  // Claude Code разрешает держать серверы прямо в plugin.json; строка (путь к другому файлу) не поддерживается.
  mcpServers: z.unknown().optional()
});
export type PluginManifest = z.output<typeof manifestSchema>;

export function parseManifest(text: string): PluginManifest {
  return manifestSchema.parse(JSON.parse(text));
}

const stdioSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({})
});
const httpSchema = z.object({
  type: z.enum(['http', 'streamable-http']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({})
});

/** MCP-сервер плагина как в `.mcp.json`, до подстановки переменных. */
export type ServerConfig =
  | { name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: 'http'; url: string; headers: Record<string, string> };

/**
 * Серверы из `.mcp.json` (обе формы: `{ "mcpServers": { … } }` и сразу `{ "<сервер>": { … } }`) и из `mcpServers`
 * в plugin.json. Сервер, который ядро не умеет (например, `sse`), попадает в `skipped` с причиной.
 */
export function parseServers(sources: readonly unknown[]): { servers: ServerConfig[]; skipped: { name: string; reason: string }[] } {
  const servers: ServerConfig[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const source of sources) {
    if (!isObject(source)) continue;
    const entries = isObject(source.mcpServers) ? source.mcpServers : source;
    for (const [name, raw] of Object.entries(entries)) {
      if (servers.some(server => server.name === name)) continue;
      const stdio = stdioSchema.safeParse(raw);
      const http = httpSchema.safeParse(raw);
      if (stdio.success) servers.push({ name, transport: 'stdio', command: stdio.data.command, args: stdio.data.args, env: stdio.data.env });
      else if (http.success) servers.push({ name, transport: 'http', url: http.data.url, headers: http.data.headers });
      else skipped.push({ name, reason: isObject(raw) && typeof raw.type === 'string' ? `unsupported type ${raw.type}` : 'invalid config' });
    }
  }
  return { servers, skipped };
}

/**
 * Отпечаток конфигурации серверов. Владелец одобряет именно её: если `.mcp.json` потом поменялся (переустановка,
 * правка руками), плагин снова ждёт `enable`.
 */
export function fingerprint(servers: readonly ServerConfig[]): string {
  if (!servers.length) return '';
  return createHash('sha256').update(JSON.stringify(servers)).digest('hex').slice(0, 16);
}

/**
 * Секреты самого ядра. Плагин не получает их ни подстановкой `${…}`, ни через окружение процесса: иначе чужой сервер
 * мог бы попросить ключ OpenAI в своём `.mcp.json`.
 */
export const BRIDGE_SECRETS: readonly string[] = [
  'OPENAI_API_KEY', 'BRIDGE_TOKEN', 'OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'APNS_KEY_PATH',
  'HELM_TOKEN', 'T3_TOKEN', 'HELM_SERVER_TOKEN', 'HELM_DEVICE_TOKEN', 'RELAY_TOKEN', 'OPENAI_ADMIN_KEY'
];

/**
 * Подстановка как в Claude Code: `${CLAUDE_PLUGIN_ROOT}` — папка плагина, `${VAR}` и `${VAR:-запасное}` — окружение ядра
 * (`core/.env`), кроме секретов ядра. Возвращает имена обязательных переменных, которых нет, чтобы сервер не запускался
 * с пустым ключом. Значения не логируются никогда.
 */
export function substitute(text: string, env: Record<string, string | undefined>, root: string): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    if (name === 'CLAUDE_PLUGIN_ROOT') return root;
    const found = BRIDGE_SECRETS.includes(name) ? undefined : env[name];
    if (found) return found;
    if (fallback === undefined) missing.push(name);
    return fallback ?? '';
  });
  return { value, missing };
}

/** Имена переменных, которые просит сервер: для `npm run plugins` (что задать в core/.env), без значений. */
export function variablesOf(server: ServerConfig): string[] {
  const texts = server.transport === 'stdio' ? [server.command, ...server.args, ...Object.values(server.env)] : [server.url, ...Object.values(server.headers)];
  const names = texts.flatMap(text => [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]!));
  return [...new Set(names.filter(name => name !== 'CLAUDE_PLUGIN_ROOT'))];
}

export const MAX_TOOL_NAME = 64;

/**
 * Имя инструмента MCP в реестре ядра: `<плагин>_<инструмент>`, только `[a-z0-9_]`, с буквы, не длиннее 64.
 * Слишком длинное имя обрезается и получает хвост из хеша, чтобы два длинных инструмента не совпали.
 */
export function mcpToolName(plugin: string, tool: string): string {
  const name = `${toolPrefix(plugin)}_${clean(tool)}`.replace(/_+$/, '');
  if (name.length <= MAX_TOOL_NAME) return name;
  const hash = createHash('sha256').update(`${plugin}\u0000${tool}`).digest('hex').slice(0, 6);
  return `${name.slice(0, MAX_TOOL_NAME - 7).replace(/_+$/, '')}_${hash}`;
}

/** Начало имён всех инструментов плагина: `allowed-tools: <префикс>_*` в техкарте берёт их все. */
export function toolPrefix(plugin: string): string {
  const prefix = clean(plugin) || 'plugin';
  return /^[a-z]/.test(prefix) ? prefix.slice(0, 40) : `p_${prefix}`.slice(0, 40);
}

function clean(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Эффект инструмента по подсказкам MCP. `readOnlyHint` — `read`. Иначе по спецификации MCP `destructiveHint` по умолчанию
 * true, поэтому без явного `destructiveHint: false` инструмент считается действующим вовне (`act`): отправка письма
 * у сервера без подсказок не станет `write`. Явный `destructiveHint: false` — `write`.
 */
export function mcpEffect(annotations: { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined): ToolEffect {
  if (annotations?.readOnlyHint === true) return 'read';
  return annotations?.destructiveHint === false ? 'write' : 'act';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
