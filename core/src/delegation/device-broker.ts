import { randomBytes } from 'node:crypto';

/**
 * Инструменты телефона при своём делегировании. В режиме Responses телефон видит вызовы в событиях бэкенда по data
 * channel; здесь бэкенд — ядро, поэтому вызов кладётся в очередь, телефон забирает её долгим опросом
 * `GET /device-tools` и отвечает `POST /device-tools/:id` (http/device-tool-routes.ts). Один пользователь и один телефон:
 * очередь общая для идущих звонков, вызов идентифицируется случайным id.
 */
export interface RelayedCall { id: string; name: string; arguments: string }

interface Pending extends RelayedCall {
  taken: boolean;
  resolve(output: string): void;
  timer: NodeJS.Timeout;
}

/** Сколько ждать ответа телефона: EventKit отвечает за доли секунды, дольше значит, что телефон не опрашивает. */
export const DEVICE_TIMEOUT_MS = 15_000;
export const MAX_WAIT_MS = 25_000;

export class DeviceBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #waiters = new Set<() => void>();
  readonly #timeoutMs: number;

  constructor(timeoutMs = DEVICE_TIMEOUT_MS) { this.#timeoutMs = timeoutMs; }

  /** Вызов инструмента телефона; всегда JSON-строка, как у ToolRegistry.call. */
  request(name: string, args: string, signal?: AbortSignal): Promise<string> {
    const id = randomBytes(16).toString('hex');
    return new Promise(resolve => {
      const finish = (output: string) => {
        const entry = this.#pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.#pending.delete(id);
        resolve(output);
      };
      const timer = setTimeout(() => {
        const taken = this.#pending.get(id)?.taken;
        finish(JSON.stringify({ error: taken ? 'device_timeout' : 'device_unavailable' }));
      }, this.#timeoutMs);
      this.#pending.set(id, { id, name, arguments: args, taken: false, resolve: finish, timer });
      signal?.addEventListener('abort', () => finish(JSON.stringify({ error: 'cancelled' })), { once: true });
      for (const wake of this.#waiters) wake();
    });
  }

  /** Невыданные вызовы; если их нет, ждёт до waitMs. Выданные помечаются и повторно не отдаются. */
  async next(waitMs: number, signal?: AbortSignal): Promise<RelayedCall[]> {
    const take = () => [...this.#pending.values()].filter(p => !p.taken).map(p => { p.taken = true; return { id: p.id, name: p.name, arguments: p.arguments }; });
    const ready = take();
    if (ready.length || waitMs <= 0) return ready;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.min(waitMs, MAX_WAIT_MS));
      this.#waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    return signal?.aborted ? [] : take();
  }

  /** Ответ телефона. false, если вызов уже закрыт (таймаут, отмена) или неизвестен. */
  answer(id: string, output: string): boolean {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    entry.resolve(output);
    return true;
  }

  /** Будит ждущий опрос без вызовов: изменилось состояние, которое телефон читает из ответа (идущие работы). */
  notify(): void {
    for (const wake of this.#waiters) wake();
  }

  get size(): number { return this.#pending.size; }
}
