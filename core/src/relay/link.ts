/**
 * «Узел» (helm-cloud/docs/relay.md): помощник на Mac владельца, через которого облако ходит в «Штурвал». С 21.10.2026 его
 * держит helm-cloud, отдельный сервис на Railway; Волна просит его `POST /internal/relay` своим токеном по внутренней сети.
 * Операций четыре: запрос к HTTP-API «Штурвала», команда по его WebSocket-RPC, есть ли папка, git-репозиторий ли это.
 * Токен «Штурвала» живёт только на Mac, «Узел» сам проверяет, что у него просят.
 */
export type RelayOp =
  | { op: 't3.request'; method: 'GET' | 'POST'; path: string; body?: unknown }
  | { op: 'folder.exists'; path: string }
  | { op: 'git.repository'; path: string }
  | { op: 'helm.rpc'; method: string; payload: unknown };

export type RelayResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Ошибка связи с «Узлом»: `relay_offline` (не на связи или helm-cloud недоступен) или `relay_timeout` (взял вызов и не ответил). */
export class RelayError extends Error {
  constructor(code: 'relay_offline' | 'relay_timeout') {
    super(`relay: ${code}`);
    this.name = code;
  }
}

/** Сколько «Узел» ждёт ответа на вызов (так же в helm-cloud): HTTP-клиент «Штурвала» сам обрывает запрос раньше. */
export const RELAY_TIMEOUT_MS = 60_000;

export interface RelayCaller {
  call(op: RelayOp, signal?: AbortSignal, timeoutMs?: number): Promise<RelayResult>;
}

/**
 * «Узел» через helm-cloud. На связи ли он, Волна узнаёт опросом `/internal/relay/status` раз в pollMs и по исходу вызовов;
 * `onOnline` — переход «не на связи → на связи», по нему ядро проверяет «Штурвал» всем путём.
 */
export class HelmCloudRelay implements RelayCaller {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  readonly #onOnline: (() => void) | undefined;
  #connected = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: { url: string; token: string; fetchImpl?: typeof fetch; pollMs?: number; onOnline?: () => void }) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#pollMs = options.pollMs ?? 10_000;
    this.#onOnline = options.onOnline;
  }

  get connected(): boolean { return this.#connected; }

  start(): void {
    if (this.#timer) return;
    const tick = () => { void this.refresh().finally(() => { if (this.#timer) this.#timer = setTimeout(tick, this.#pollMs); }); };
    this.#timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Спрашивает helm-cloud, на связи ли «Узел». Недоступный helm-cloud — тоже «не на связи». */
  async refresh(): Promise<boolean> {
    let connected = false;
    try {
      const response = await this.#fetch(`${this.#url}/internal/relay/status`, { headers: this.#headers(), signal: AbortSignal.timeout(5000) });
      connected = response.ok && ((await response.json()) as { connected?: unknown }).connected === true;
    } catch { /* сеть или helm-cloud перезапускается */ }
    this.#mark(connected);
    return connected;
  }

  async call(op: RelayOp, signal?: AbortSignal, timeoutMs = RELAY_TIMEOUT_MS): Promise<RelayResult> {
    if (signal?.aborted) throw signal.reason;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/internal/relay?timeoutMs=${timeoutMs}`, {
        method: 'POST', headers: { ...this.#headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(op), signal
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.#mark(false);
      throw new RelayError('relay_offline');
    }
    if (response.status === 503) {
      const { error } = await response.json().catch(() => ({})) as { error?: unknown };
      if (error === 'relay_timeout') throw new RelayError('relay_timeout');
      this.#mark(false);
      throw new RelayError('relay_offline');
    }
    if (!response.ok) throw new RelayError('relay_offline');
    this.#mark(true);
    return await response.json() as RelayResult;
  }

  #headers(): Record<string, string> { return { Authorization: `Bearer ${this.#token}` }; }

  #mark(connected: boolean): void {
    const came = connected && !this.#connected;
    this.#connected = connected;
    if (came) this.#onOnline?.();
  }
}

/** Папка и git-репозиторий на Mac через «Узел» (helm/projects.ts, tasks/tools.ts). Ошибка «Узла» становится исключением. */
export function relayMac(link: RelayCaller) {
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
export function relayRpc(link: RelayCaller) {
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
export function relayFetch(link: RelayCaller): typeof fetch {
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
