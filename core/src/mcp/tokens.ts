import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Подписанные токены Helm MCP (`<payload>.<hmac>`): регистрации клиентов, коды входа, токены доступа и обновления,
 * коды подтверждения записи. Базы нет: всё проверяется подписью и сроком. Смена `MCP_SIGNING_SECRET` отзывает всё сразу.
 * Вид токена (`kind`) входит в подпись, поэтому код подтверждения не сойдёт за токен доступа, и наоборот.
 */
export type TokenKind = 'client' | 'code' | 'access' | 'refresh' | 'confirm';
export type Payload = Record<string, unknown> & { exp?: number };

export class Signer {
  readonly #secret: string;
  readonly #now: () => number;
  /** Одноразовые коды (вход, подтверждение): id → срок, в памяти до истечения. После перезапуска ядра коды умирают по сроку. */
  readonly #used = new Map<string, number>();

  constructor(secret: string, now: () => number = Date.now) {
    if (secret.length < 32) throw new Error('MCP_SIGNING_SECRET must be at least 32 characters.');
    this.#secret = secret;
    this.#now = now;
  }

  sign(kind: TokenKind, payload: Payload, ttlSeconds?: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, ...(ttlSeconds ? { exp: Math.floor(this.#now() / 1000) + ttlSeconds } : {}) })).toString('base64url');
    return `${body}.${this.#hmac(kind, body)}`;
  }

  /** Содержимое токена или null, если не та подпись, не тот вид или срок вышел. */
  verify(kind: TokenKind, token: unknown): Payload | null {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.#hmac(kind, body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let payload: Payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp === 'number' && payload.exp < this.#now() / 1000) return null;
    return payload;
  }

  /** true при первом использовании id, false при повторе. */
  consumeOnce(id: string, expSeconds: number | undefined): boolean {
    const now = this.#now() / 1000;
    for (const [key, exp] of this.#used) if (exp < now) this.#used.delete(key);
    if (this.#used.has(id)) return false;
    this.#used.set(id, expSeconds ?? now + 3600);
    return true;
  }

  #hmac(kind: TokenKind, body: string): string {
    return createHmac('sha256', this.#secret).update(`${kind}.${body}`).digest('base64url');
  }
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/** Сравнение пароля без утечки длины и времени. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

/** Устойчивый JSON (ключи по порядку, undefined отброшены): подтверждение привязано к точным аргументам. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
