/**
 * WebSocket-RPC «Штурвала» (форк T3 Code, протокол оркестрации 2): команды идут не HTTP, а запросами Effect RPC по `/ws`.
 * Сверено по исходникам 0.0.45 (`effect/unstable/rpc`, `RpcSerialization.layerJson`): один JSON на кадр;
 * запрос `{_tag: 'Request', id, tag, payload, headers: []}`, ответ `{_tag: 'Exit', requestId, exit}`, где exit —
 * `{_tag: 'Success', value}` или `{_tag: 'Failure', cause: [{_tag: 'Fail', error} | {_tag: 'Die', defect} | ...]}`.
 *
 * Без зависимостей: этот файл импортирует и «Узел» (relay/src/ops.ts), который исполняет RPC на Mac для ядра в облаке.
 * Токен идёт только в заголовок подключения и никогда в лог.
 */
export const HELM_PROTOCOL = 2;

/** Отказ сервера: `fail` — ошибка домена (команда отклонена), `die` — сбой сервера, `offline` — нет соединения. */
export class HelmRpcError extends Error {
  readonly kind: 'fail' | 'die' | 'offline' | 'timeout';
  readonly tag: string | null;
  constructor(kind: HelmRpcError['kind'], tag: string | null = null) {
    super(`helm rpc: ${kind}${tag ? ` ${tag}` : ''}`);
    this.name = 'HelmRpcError';
    this.kind = kind;
    this.tag = tag;
  }
}

export type RpcTransport = (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;

type Socket = WebSocket;
const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => Socket;

interface Waiting { resolve(value: unknown): void; reject(error: unknown): void }

/**
 * Одно соединение на клиента, открывается по первому запросу и после обрыва заново. Запросы идут параллельно,
 * ответ находится по id. Соединение без запросов дольше `idleMs` закрывается: опрос ядра раз в 2,5 с идёт по HTTP.
 */
export class HelmRpc {
  readonly #url: string;
  readonly #token: string;
  readonly #idleMs: number;
  #socket: Promise<Socket> | null = null;
  #ids = 0;
  readonly #waiting = new Map<string, Waiting>();
  #idle: NodeJS.Timeout | null = null;

  constructor(options: { url: string; token: string; idleMs?: number }) {
    const base = options.url.replace(/\/+$/, '').replace(/^http/, 'ws');
    this.#url = `${base}/ws?orchestrationProtocol=${HELM_PROTOCOL}`;
    this.#token = options.token;
    this.#idleMs = options.idleMs ?? 30_000;
  }

  readonly call: RpcTransport = async (method, payload, signal) => {
    if (signal.aborted) throw signal.reason;
    const socket = await this.#open(signal);
    const id = String(++this.#ids);
    this.#touch();
    return new Promise((resolve, reject) => {
      const stop = () => { this.#waiting.delete(id); reject(signal.reason); };
      signal.addEventListener('abort', stop, { once: true });
      this.#waiting.set(id, {
        resolve: value => { signal.removeEventListener('abort', stop); resolve(value); },
        reject: error => { signal.removeEventListener('abort', stop); reject(error); }
      });
      socket.send(JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] }));
    });
  };

  close(): void {
    void this.#socket?.then(socket => socket.close(), () => {});
    this.#socket = null;
  }

  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => { if (!this.#waiting.size) this.close(); else this.#touch(); }, this.#idleMs);
    this.#idle.unref?.();
  }

  #open(signal: AbortSignal): Promise<Socket> {
    this.#socket ??= new Promise<Socket>((resolve, reject) => {
      const socket = new Socket(this.#url, { headers: { Authorization: `Bearer ${this.#token}` } });
      const timer = setTimeout(() => { socket.close(); fail(); }, 10_000);
      const fail = () => { clearTimeout(timer); this.#socket = null; reject(new HelmRpcError('offline')); };
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); });
      socket.addEventListener('error', fail);
      socket.addEventListener('message', event => this.#receive(socket, String(event.data)));
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (this.#socket) this.#socket = null;
        for (const [id, waiting] of this.#waiting) { this.#waiting.delete(id); waiting.reject(new HelmRpcError('offline')); }
        reject(new HelmRpcError('offline'));
      });
    });
    return this.#socket.then(socket => {
      if (signal.aborted) throw signal.reason;
      return socket;
    });
  }

  #receive(socket: Socket, raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]) {
      if (message?._tag === 'Ping') { socket.send('{"_tag":"Pong"}'); continue; }
      if (message?._tag === 'Defect') {
        for (const [id, waiting] of this.#waiting) { this.#waiting.delete(id); waiting.reject(new HelmRpcError('die')); }
        continue;
      }
      if (message?._tag !== 'Exit') continue;
      const waiting = this.#waiting.get(String(message.requestId));
      if (!waiting) continue;
      this.#waiting.delete(String(message.requestId));
      const exit = message.exit as { _tag?: string; value?: unknown; cause?: { _tag?: string; error?: { _tag?: unknown } }[] } | undefined;
      if (exit?._tag === 'Success') { waiting.resolve(exit.value); continue; }
      const failed = exit?.cause?.find(c => c._tag === 'Fail');
      const tag = typeof failed?.error?._tag === 'string' ? failed.error._tag : null;
      waiting.reject(new HelmRpcError(failed ? 'fail' : 'die', tag));
    }
  }
}
