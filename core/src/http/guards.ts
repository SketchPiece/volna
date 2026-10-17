import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/** Нативные клиенты не шлют Origin. Платное создание сессии для страниц закрыто. */
export const rejectBrowsers: MiddlewareHandler = async (c, next) => {
  if (c.req.header('origin')) return c.json({ error: 'Browser requests are disabled.' }, 403);
  await next();
};

export const noStore: MiddlewareHandler = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
};

/** Bearer-токен ядра. Пустой токен означает, что ядро доступно только с localhost (проверяется в config). */
export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (token) {
      const actual = Buffer.from(c.req.header('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return c.json({ error: 'Неверный токен ядра.' }, 401);
      }
    }
    await next();
  };
}

export interface RateLimits {
  /** Попыток с одного адреса за минуту. */
  perMinute: number;
  /** Одновременных обменов SDP на всё ядро. */
  concurrent: number;
}

export const DEFAULT_LIMITS: RateLimits = { perMinute: 10, concurrent: 2 };

/** Защита кошелька: окно на адрес и общий счётчик одновременных запросов. */
export function rateLimit(limits: RateLimits = DEFAULT_LIMITS): MiddlewareHandler {
  let pending = 0;
  const attempts = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const now = Date.now();
    for (const [address, window] of attempts) if (now - window.start > 60_000) attempts.delete(address);
    const address = getConnInfo(c).remote.address ?? 'unknown';
    const window = attempts.get(address) ?? { start: now, count: 0 };
    attempts.set(address, window);
    if (++window.count > limits.perMinute || pending >= limits.concurrent) {
      return c.json({ error: 'Слишком много попыток. Подождите минуту.' }, 429);
    }
    pending++;
    try { await next(); } finally { pending--; }
  };
}
