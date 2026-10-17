import { randomBytes } from 'node:crypto';

/**
 * «Узел» (docs/relay.md): помощник на Mac владельца, через которого ядро в облаке работает со «Штурвалом». Mac снаружи не
 * виден, поэтому «Узел» сам держит WebSocket с ядром (http/relay-socket.ts; старый долгий опрос — http/relay-routes.ts).
 * Операций четыре: запрос к HTTP-API «Штурвала», команда по его WebSocket-RPC, есть ли папка, git-репозиторий ли это
 * (worktree с 05.10.2026 создаёт сам «Штурвал»). Токен живёт только на Mac, «Узел» сам проверяет, что ядро просит.
 */
export type RelayOp =
  | { op: 't3.request'; method: 'GET' | 'POST'; path: string; body?: unknown }
  | { op: 'folder.exists'; path: string }
  | { op: 'git.repository'; path: string }
  | { op: 'helm.rpc'; method: string; payload: unknown };

export type RelayCall = RelayOp & { id: string };
export type RelayResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Что «Узел» сообщает о себе при подключении; ядро только пишет это в лог. */
export interface RelayHello { version: string; t3: { ok: boolean; version: string | null; reason: string | null } }

/** Ошибка связи с «Узлом»: `relay_offline` (давно не опрашивал) или `relay_timeout` (взял вызов и не ответил). */
export class RelayError extends Error {
  constructor(code: 'relay_offline' | 'relay_timeout') {
    super(`relay: ${code}`);
    this.name = code;
  }
}

interface Pending {
  call: RelayCall;
  taken: boolean;
  resolve(result: RelayResult): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

/** Сколько ждать ответа: HTTP-клиент «Штурвала» сам обрывает запрос через 8 с, git worktree дольше. */
export const RELAY_TIMEOUT_MS = 60_000;
export const RELAY_MAX_WAIT_MS = 25_000;
/** «Узел» на связи, если опрашивал не раньше этого: опрос длится до 25 с, между опросами доли секунды. */
export const RELAY_ONLINE_MS = 45_000;
/** Сколько вызов ждёт «Узел», если тот сейчас не на связи: домашняя сеть рвётся на секунды, а «Узел» переподключается за 1–5 с. */
export const RELAY_GRACE_MS = 20_000;

export class RelayLink {
  readonly #pending = new Map<string, Pending>();
  readonly #waiters = new Set<() => void>();
  /** Вызовы, ждущие возвращения «Узла» (RELAY_GRACE_MS). */
  readonly #online = new Set<() => void>();
  /** Открытый WebSocket «Узла» (http/relay-socket.ts): вызовы уходят сразу, без опроса. */
  #push: ((call: RelayCall) => void) | null = null;
  readonly #now: () => number;
  readonly #graceMs: number;
  #seenAt = 0;
  #hello: RelayHello | null = null;

  constructor(options: { now?: () => number; graceMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs ?? RELAY_GRACE_MS;
  }

  /** «Узел» опрашивал недавно: вызовы дойдут. Иначе вызов сразу падает с `relay_offline`, а не ждёт минуту. */
  get connected(): boolean { return this.#now() - this.#seenAt < RELAY_ONLINE_MS; }

  get hello(): RelayHello | null { return this.connected ? this.#hello : null; }

  /**
   * Вызов на Mac. Если «Узел» сейчас не на связи, ждёт его до graceMs, потом бросает `relay_offline`. Бросает RelayError при
   * потере связи и причину отмены при отмене.
   */
  async call(op: RelayOp, signal?: AbortSignal, timeoutMs = RELAY_TIMEOUT_MS): Promise<RelayResult> {
    if (signal?.aborted) throw signal.reason;
    if (!this.connected) await this.#waitOnline(signal);
    return this.#enqueue(op, signal, timeoutMs);
  }

  #waitOnline(signal?: AbortSignal): Promise<void> {
    if (this.#graceMs <= 0) return Promise.reject(new RelayError('relay_offline'));
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        this.#online.delete(online);
        signal?.removeEventListener('abort', aborted);
        if (error === undefined) resolve(); else reject(error);
      };
      const online = () => finish();
      const aborted = () => finish(signal!.reason);
      const timer = setTimeout(() => finish(new RelayError('relay_offline')), this.#graceMs);
      this.#online.add(online);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  #seen(): void {
    this.#seenAt = this.#now();
    for (const online of [...this.#online]) online();
  }

  #enqueue(op: RelayOp, signal: AbortSignal | undefined, timeoutMs: number): Promise<RelayResult> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const close = () => { const entry = this.#pending.get(id); if (entry) { clearTimeout(entry.timer); this.#pending.delete(id); } return entry; };
      const timer = setTimeout(() => { const entry = close(); if (entry) reject(new RelayError(entry.taken ? 'relay_timeout' : 'relay_offline')); }, timeoutMs);
      this.#pending.set(id, {
        call: { ...op, id }, taken: false, timer,
        resolve: result => { if (close()) resolve(result); },
        reject: error => { if (close()) reject(error); }
      });
      signal?.addEventListener('abort', () => this.#pending.get(id)?.reject(signal.reason), { once: true });
      if (this.#push) this.#flush();
      else for (const wake of this.#waiters) wake();
    });
  }

  /**
   * WebSocket «Узла» открыт: невыданные вызовы уходят в него сейчас, новые — сразу по появлении. Возвращает отключение;
   * после него «Узел» считается не на связи, и новые вызовы ждут переподключения (RELAY_GRACE_MS). Уже выданные вызовы
   * дождутся ответа, который «Узел» пришлёт по новому соединению, или своего таймаута.
   */
  attach(push: (call: RelayCall) => void): () => void {
    this.#push = push;
    this.#seen();
    this.#flush();
    return () => {
      if (this.#push !== push) return;
      this.#push = null;
      this.#seenAt = 0;
    };
  }

  /** Любое сообщение «Узла» по WebSocket: он на связи. */
  touch(): void { this.#seen(); }

  #take(): RelayCall[] {
    return [...this.#pending.values()].filter(p => !p.taken).map(p => { p.taken = true; return p.call; });
  }

  #flush(): void {
    const push = this.#push;
    if (!push) return;
    for (const call of this.#take()) push(call);
  }

  /** Невыданные вызовы; если их нет, ждёт до waitMs. Каждый опрос отмечает «Узел» на связи. */
  async next(waitMs: number, signal?: AbortSignal): Promise<RelayCall[]> {
    this.#seen();
    const take = () => this.#take();
    const ready = take();
    if (ready.length || waitMs <= 0) return ready;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.min(waitMs, RELAY_MAX_WAIT_MS));
      this.#waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    this.#seen();
    return signal?.aborted ? [] : take();
  }

  /** Ответ «Узла». false, если вызов уже закрыт (таймаут, отмена) или неизвестен. */
  answer(id: string, result: RelayResult): boolean {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    entry.resolve(result);
    return true;
  }

  greet(hello: RelayHello): void {
    this.#hello = hello;
    this.#seen();
  }

  get size(): number { return this.#pending.size; }
}

/** Папка и git-репозиторий на Mac через «Узел» (helm/projects.ts, tasks/tools.ts). Ошибка «Узла» становится исключением. */
export function relayMac(link: RelayLink) {
  const data = async (op: RelayOp, signal?: AbortSignal) => {
    const result = await link.call(op, signal);
    if (!result.ok) throw new Error(`relay: ${result.error}`);
    return result.data;
  };
  return {
    exists: async (path: string, signal?: AbortSignal): Promise<boolean> => (await data({ op: 'folder.exists', path }, signal)) === true,
    isRepository: async (path: string, signal?: AbortSignal): Promise<boolean> => (await data({ op: 'git.repository', path }, signal)) === true
  };
}

/**
 * Команды «Штурвала» по его WebSocket-RPC через «Узел» (helm/rpc.ts): RPC-соединение держит «Узел» на Mac. Ошибка приходит
 * строкой (`helm_offline`, `helm_fail:<тег>`, `helm_die`, `not_allowed`), клиент переводит её в свой код.
 */
export function relayRpc(link: RelayLink) {
  return async (method: string, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    const result = await link.call({ op: 'helm.rpc', method, payload }, signal);
    if (!result.ok) throw new Error(`relay: ${result.error}`);
    return result.data;
  };
}

/** Адрес «Штурвала» для клиента ядра, когда он доступен только через «Узел»: хост ничего не значит, важен путь. */
export const RELAY_HELM_URL = 'http://relay.helm';

/**
 * `fetch` для HelmClient через «Узел»: метод, путь и тело уходят на Mac, «Узел» добавляет токен «Штурвала» и возвращает статус и
 * JSON. Сбой связи бросает TypeError, как обычный fetch без сети: клиент «Штурвала» превращает его в `helm_offline`.
 */
export function relayFetch(link: RelayLink): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new TypeError(`relay: method ${method}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    let result: RelayResult;
    try {
      result = await link.call({ op: 't3.request', method, path: url.pathname + url.search, ...(body === undefined ? {} : { body }) }, init?.signal ?? undefined);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      throw new TypeError(error instanceof Error ? error.message : 'relay: failed');
    }
    if (!result.ok) throw new TypeError(`relay: ${result.error}`);
    const { status, body: data } = (result.data ?? {}) as { status?: unknown; body?: unknown };
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) throw new TypeError('relay: bad_status');
    const empty = data === undefined || data === null || status === 204 || status === 304;
    return new Response(empty ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
