import { z } from 'zod';
import { ESCALATE, OFFER_WORK, START_OFFERED, type Tool } from '../assistant/tools/registry.ts';
import type { Logger } from '../log.ts';
import { mcpEffect, mcpToolName, substitute, type ServerConfig } from './format.ts';
import { McpClient, McpError, type McpCallResult, type McpServerSpec, type McpTool } from './mcp-client.ts';
import type { Plugin, PluginStore } from './store.ts';

/** Сколько ждать один MCP-сервер при старте ядра: `npx -y` в первый раз скачивает пакет. */
export const MCP_CONNECT_TIMEOUT_MS = 20_000;
/** Тайм-аут одного вызова инструмента MCP. */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Сколько текста результата уходит модели. */
export const MAX_RESULT_CHARS = 8_000;
const MAX_DESCRIPTION = 1_000;
const RECONNECT_PAUSE_MS = 30_000;

/**
 * Соединение с одним MCP-сервером плагина. Если процесс упал или HTTP-сессия истекла, следующий вызов инструмента
 * переподключается (не чаще раза в 30 с). Список инструментов берётся один раз при старте ядра.
 */
export class McpConnection {
  readonly plugin: string;
  readonly server: string;
  readonly #spec: McpServerSpec;
  readonly #log: Logger;
  #client: McpClient | null = null;
  #connecting: Promise<McpClient> | null = null;
  #lastAttempt = 0;

  constructor({ plugin, server, spec, log }: { plugin: string; server: string; spec: McpServerSpec; log: Logger }) {
    this.plugin = plugin;
    this.server = server;
    this.#spec = spec;
    this.#log = log;
  }

  get transport(): McpServerSpec['transport'] { return this.#spec.transport; }

  async client(timeoutMs = MCP_CONNECT_TIMEOUT_MS): Promise<McpClient> {
    if (this.#client && !this.#client.closed) return this.#client;
    if (this.#connecting) return this.#connecting;
    if (this.#lastAttempt && Date.now() - this.#lastAttempt < RECONNECT_PAUSE_MS) throw new McpError('closed');
    this.#lastAttempt = Date.now();
    this.#connecting = McpClient.connect(this.#spec, { timeoutMs }).then(client => {
      this.#client = client;
      this.#lastAttempt = 0;
      client.onclose = () => this.#log.warn('plugin.mcp_closed', { plugin: this.plugin, server: this.server });
      return client;
    }).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = null;
  }
}

/**
 * Серверы включённых плагинов, поднятые при старте ядра, и их инструменты для реестра.
 * `stop()` закрывает процессы при выходе ядра.
 */
export interface PluginRuntime {
  tools: Tool[];
  connections: McpConnection[];
  stop(): Promise<void>;
}

/**
 * Поднимает MCP-серверы активных плагинов параллельно, каждый не дольше `timeoutMs`; упавший сервер только пишется в лог
 * (имя плагина, сервера и вид сбоя, без заголовков и окружения), ядро стартует без его инструментов.
 * `taken` — имена, уже занятые в реестре: одноимённый инструмент плагина пропускается.
 */
export async function startPlugins({ store, log, env = process.env, taken = [], timeoutMs = MCP_CONNECT_TIMEOUT_MS }: {
  store: PluginStore; log: Logger; env?: Record<string, string | undefined>; taken?: readonly string[]; timeoutMs?: number;
}): Promise<PluginRuntime> {
  const plugins = await store.list();
  for (const plugin of plugins.filter(p => p.status === 'changed')) log.warn('plugin.needs_enable', { plugin: plugin.name, reason: 'mcp_config_changed' });
  const connections: McpConnection[] = [];
  const found = await Promise.all(plugins.filter(p => p.status === 'enabled').flatMap(plugin => plugin.servers.map(async server => {
    const resolved = resolveServer(plugin, server, env);
    if ('missing' in resolved) {
      log.warn('plugin.mcp_skipped', { plugin: plugin.name, server: server.name, missing: resolved.missing.join(',') });
      return [];
    }
    const connection = new McpConnection({ plugin: plugin.name, server: server.name, spec: resolved.spec, log });
    connections.push(connection);
    try {
      const client = await connection.client(timeoutMs);
      const tools = await client.listTools({ timeoutMs });
      log.info('plugin.mcp_ready', { plugin: plugin.name, server: server.name, transport: server.transport, tools: tools.length });
      return tools.map(tool => ({ connection, tool }));
    } catch (error) {
      log.warn('plugin.mcp_failed', { plugin: plugin.name, server: server.name, transport: server.transport, reason: failure(error) });
      return [];
    }
  })));
  const names = new Set([...taken, ESCALATE, OFFER_WORK, START_OFFERED]);
  const tools: Tool[] = [];
  for (const { connection, tool } of found.flat()) {
    const bridgeTool = mcpTool(connection, tool, store);
    if (names.has(bridgeTool.name)) {
      log.warn('plugin.tool_skipped', { plugin: connection.plugin, tool: bridgeTool.name, reason: 'duplicate_name' });
      continue;
    }
    names.add(bridgeTool.name);
    tools.push(bridgeTool);
  }
  return { tools, connections, stop: () => Promise.all(connections.map(c => c.close())).then(() => {}) };
}

/** Подстановка переменных в конфигурацию сервера; без обязательной переменной сервер не запускается. */
export function resolveServer(plugin: Plugin, server: ServerConfig, env: Record<string, string | undefined>): { spec: McpServerSpec } | { missing: string[] } {
  const missing: string[] = [];
  const sub = (text: string) => { const result = substitute(text, env, plugin.dir); missing.push(...result.missing); return result.value; };
  const map = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sub(value)]));
  const spec: McpServerSpec = server.transport === 'stdio'
    ? { transport: 'stdio', command: sub(server.command), args: server.args.map(sub), env: map(server.env), cwd: plugin.dir }
    // Пустой заголовок (`${KEY:-}` без ключа) не отправляется: сервер работает анонимно.
    : { transport: 'http', url: sub(server.url), headers: Object.fromEntries(Object.entries(map(server.headers)).filter(([, value]) => value.trim())) };
  return missing.length ? { missing: [...new Set(missing)] } : { spec };
}

/**
 * Инструмент MCP как инструмент ядра. Схему аргументов сервера модель видит как есть (`jsonSchema`), ядро аргументы
 * не проверяет: это делает сервер. Выключенный плагин отвечает `plugin_disabled` без обращения к серверу.
 */
export function mcpTool(connection: McpConnection, tool: McpTool, store: Pick<PluginStore, 'isActive'>): Tool {
  const description = (tool.description?.trim() || tool.annotations?.title || tool.name).slice(0, MAX_DESCRIPTION);
  return {
    name: mcpToolName(connection.plugin, tool.name),
    description,
    parameters: z.looseObject({}),
    jsonSchema: inputSchema(tool.inputSchema),
    effect: mcpEffect(tool.annotations),
    async execute(args, context) {
      if (!await store.isActive(connection.plugin)) return { error: 'plugin_disabled', plugin: connection.plugin };
      try {
        const client = await connection.client();
        return mcpResult(await client.callTool(tool.name, args, { signal: context.signal, timeoutMs: MCP_CALL_TIMEOUT_MS }));
      } catch (error) {
        const reason = failure(error);
        context.log.warn('plugin.tool_failed', { plugin: connection.plugin, tool: tool.name, reason });
        return reason === 'rpc' && error instanceof McpError
          ? { error: 'mcp_error', code: error.code, detail: error.message }
          : { error: ERRORS[reason] ?? 'plugin_offline', plugin: connection.plugin };
      }
    }
  };
}

/** Результат `tools/call` для модели: текст частей через перевод строки, иначе `structuredContent`; ошибка сервера — `{ error }`. */
export function mcpResult(result: McpCallResult): unknown {
  const parts = (result.content ?? []).map(part =>
    part.type === 'text' && typeof part.text === 'string' ? part.text
      : part.type === 'resource' && typeof part.resource?.text === 'string' ? part.resource.text
        : `[${part.type}]`);
  let text = parts.join('\n').trim();
  if (!text && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  const clipped = text.length > MAX_RESULT_CHARS ? { text: text.slice(0, MAX_RESULT_CHARS), truncated: true } : { text };
  return result.isError ? { error: 'tool_error', detail: clipped.text.slice(0, 1_000) } : clipped;
}

/** Схема аргументов MCP для модели; не объект — пустой объект, `$schema` убирается. */
function inputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return { type: 'object', properties: {} };
  const { $schema: _, ...rest } = schema;
  return { properties: {}, ...rest };
}

const ERRORS: Record<string, string> = { timeout: 'mcp_timeout', aborted: 'cancelled', http_401: 'plugin_unauthorized', http_403: 'plugin_unauthorized' };

function failure(error: unknown): string {
  return error instanceof McpError ? (error.kind === 'http' && error.code ? `http_${error.code}` : error.kind) : 'unknown';
}
