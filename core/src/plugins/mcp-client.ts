import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Минимальный клиент MCP (Model Context Protocol, JSON-RPC 2.0): `initialize`, `tools/list`, `tools/call`, отмена.
 * Два транспорта: stdio (процесс, сообщения построчно) и streamable HTTP (POST, ответ JSON или SSE, `Mcp-Session-Id`).
 * Свой, а не `@modelcontextprotocol/sdk`: ядру нужна только клиентская половина из трёх методов, а SDK тянет серверную
 * часть с express и десятком зависимостей; здесь же под контролем, что попадает в лог (ничего из заголовков, окружения,
 * аргументов и результатов). OAuth нет: HTTP-сервер работает со статическим заголовком из `.mcp.json`.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'wave-core', version: '1.0.0' };

/** Сервер после подстановки переменных. Значения `env` и `headers` секретны: только в процесс и в запрос. */
export type McpServerSpec =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { transport: 'http'; url: string; headers: Record<string, string> };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpCallResult {
  content?: { type: string; text?: string; resource?: { text?: string; uri?: string } }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Сбой без подробностей, которые могли бы унести секрет: только вид и код. */
export class McpError extends Error {
  readonly kind: 'timeout' | 'aborted' | 'closed' | 'rpc' | 'http' | 'spawn';
  readonly code: number | null;
  constructor(kind: McpError['kind'], code: number | null = null, message: string = kind) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
    this.code = code;
  }
}

type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

interface Transport {
  send(message: Message, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/**
 * Переменные окружения процесса ядра, которые получает stdio-сервер: только то, без чего не запустится `npx` или `bun`.
 * Остальное окружение (там ключи ядра из core/.env) сервер не видит; свои переменные он получает через `env` в `.mcp.json`.
 */
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM'];

export class McpClient {
  readonly #transport: Transport;
  #nextId = 0;
  #closed = false;
  readonly #pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
  /** Вызывается один раз, когда соединение потеряно (процесс вышел, сессия HTTP истекла). */
  onclose?: () => void;

  private constructor(open: (client: McpClient) => Transport) {
    this.#transport = open(this);
  }

  /** Запускает транспорт и проходит рукопожатие `initialize` → `notifications/initialized`. */
  static async connect(spec: McpServerSpec, { timeoutMs = 20_000 }: { timeoutMs?: number } = {}): Promise<McpClient> {
    const client = new McpClient(self => spec.transport === 'stdio' ? stdioTransport(spec, self) : httpTransport(spec, self));
    try {
      await client.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, { timeoutMs });
      await client.#transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get closed(): boolean { return this.#closed; }

  /** Все инструменты сервера, с учётом постраничной выдачи. */
  async listTools({ timeoutMs = 20_000 }: { timeoutMs?: number } = {}): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs }) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools ?? []).filter(tool => typeof tool?.name === 'string'));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    return this.request('tools/call', { name, arguments: args }, options) as Promise<McpCallResult>;
  }

  /** Запрос JSON-RPC. По тайм-ауту и отмене сервер получает `notifications/cancelled`. */
  request(method: string, params: unknown, { signal, timeoutMs = 30_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new McpError('closed'));
    if (signal?.aborted) return Promise.reject(new McpError('aborted'));
    const id = ++this.#nextId;
    const stop = new AbortController();
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, result?: unknown) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Поток SSE ответа больше не нужен, даже если сервер его не закрыл.
        stop.abort();
        if (!error) return resolve(result);
        if (error instanceof McpError && (error.kind === 'timeout' || error.kind === 'aborted') && !this.#closed) {
          this.#transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: error.kind } }).catch(() => {});
        }
        reject(error);
      };
      const onAbort = () => finish(new McpError('aborted'));
      const timer = setTimeout(() => finish(new McpError('timeout')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve: result => finish(null, result), reject: error => finish(error) });
      this.#transport.send({ jsonrpc: '2.0', id, method, params }, stop.signal).catch(error => finish(error instanceof McpError ? error : new McpError('closed')));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#lost();
    await this.#transport.close().catch(() => {});
  }

  /** Входящее сообщение от транспорта: ответ на запрос, запрос сервера (ping) или уведомление. */
  receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const m = message as Message;
    if (m.method && m.id !== undefined) {
      // Сервер спрашивает клиента: на ping отвечаем, остального (sampling, roots, elicitation) у сервера нет.
      const reply: Message = m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
      this.#transport.send(reply).catch(() => {});
      return;
    }
    if (m.method || typeof m.id !== 'number') return;
    const pending = this.#pending.get(m.id);
    if (!pending) return;
    if (m.error) pending.reject(new McpError('rpc', typeof m.error.code === 'number' ? m.error.code : null, typeof m.error.message === 'string' ? m.error.message.slice(0, 200) : 'rpc'));
    else pending.resolve(m.result ?? {});
  }

  /** Транспорт сообщает, что соединения больше нет: ждущие запросы получают `closed`. */
  #lost(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#pending.values()]) pending.reject(new McpError('closed'));
    this.onclose?.();
  }

  static lost(client: McpClient): void { client.#lost(); }
}

function stdioTransport(spec: Extract<McpServerSpec, { transport: 'stdio' }>, client: McpClient): Transport {
  const env = Object.fromEntries(INHERITED_ENV.flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
  // stderr сервера не читается и не логируется: туда серверы пишут что угодно, включая токены.
  const child: ChildProcess = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...env, ...spec.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new McpError('spawn')));
  });
  spawned.catch(() => McpClient.lost(client));
  child.once('exit', () => McpClient.lost(client));
  child.stdin!.on('error', () => {});
  createInterface({ input: child.stdout! }).on('line', line => {
    if (!line.trim()) return;
    try { client.receive(JSON.parse(line)); } catch { /* не JSON: сервер печатает лишнее в stdout */ }
  });
  return {
    async send(message) {
      await spawned;
      if (!child.stdin!.writable) throw new McpError('closed');
      child.stdin!.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      child.stdin!.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      child.kill('SIGTERM');
      await exited;
      clearTimeout(kill);
    }
  };
}

function httpTransport(spec: Extract<McpServerSpec, { transport: 'http' }>, client: McpClient): Transport {
  let session: string | null = null;
  let initialized = false;
  const headers = () => ({
    ...spec.headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(session ? { 'mcp-session-id': session } : {}),
    ...(initialized ? { 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {})
  });
  return {
    async send(message, signal) {
      let response: Response;
      try {
        response = await fetch(spec.url, { method: 'POST', headers: headers(), body: JSON.stringify(message), signal });
      } catch (error) {
        throw error instanceof Error && error.name === 'AbortError' ? new McpError('aborted') : new McpError('http');
      }
      session = response.headers.get('mcp-session-id') ?? session;
      if (message.method === 'notifications/initialized') initialized = true;
      if (response.status === 404 && session) {
        // Сессия на сервере истекла: соединение считается потерянным, обёртка переподключится.
        McpClient.lost(client);
        throw new McpError('closed');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new McpError('http', response.status);
      }
      if (response.status === 202 || !response.body) return;
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream')) {
        await readEvents(response.body, data => { try { client.receive(JSON.parse(data)); } catch { /* пропускаем */ } });
      } else if (type.includes('json')) {
        const body = await response.json().catch(() => null) as unknown;
        for (const item of Array.isArray(body) ? body : [body]) client.receive(item);
      } else {
        await response.body.cancel().catch(() => {});
      }
    },
    async close() {
      if (!session) return;
      await fetch(spec.url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2_000) }).catch(() => {});
    }
  };
}

/** SSE: события разделены пустой строкой, данные в строках `data:`. */
async function readEvents(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data) onData(data);
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
      flush(buffer.slice(0, index));
      buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
    }
  }
  if (buffer.trim()) flush(buffer);
}
