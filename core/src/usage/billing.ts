import { z } from 'zod';

/**
 * Счета провайдеров для сверки с учётом ядра (docs/core.md, 4o). Только чтение, ключи не пишутся ни в лог, ни в ответ.
 * - OpenRouter: баланс (`/api/v1/credits`) и траты ключа за день и месяц (`/api/v1/key`) обычным ключом ядра.
 * - OpenAI: Costs API (`/v1/organization/costs`) ключом администратора `OPENAI_ADMIN_KEY`, только по дням.
 */
export interface OpenRouterBill { balance: number | null; day: number | null; month: number | null }
export interface OpenAiBill { days: { date: string; usd: number }[]; total: number }
export type Bill<T> = { ok: true; at: string; data: T } | { ok: false; at: string; error: string };

const creditsSchema = z.object({ data: z.object({ total_credits: z.number(), total_usage: z.number() }) });
const keySchema = z.object({ data: z.object({ usage_daily: z.number().nullish(), usage_monthly: z.number().nullish() }) });
const costsSchema = z.object({
  data: z.array(z.object({
    start_time: z.number(),
    results: z.array(z.object({ amount: z.object({ value: z.coerce.number() }).nullish() }))
  })),
  has_more: z.boolean().optional(),
  next_page: z.string().nullish()
});

const failure = (error: unknown) => error instanceof BillError ? error.message : error instanceof Error ? error.name : 'unknown';
class BillError extends Error {}

async function getJson(fetchImpl: typeof fetch, url: string, key: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new BillError(`http_${response.status}`);
  return response.json();
}

export async function openRouterBill(key: string, fetchImpl: typeof fetch = fetch): Promise<OpenRouterBill> {
  const [credits, info] = await Promise.all([
    getJson(fetchImpl, 'https://openrouter.ai/api/v1/credits', key).then(body => creditsSchema.parse(body).data).catch(() => null),
    getJson(fetchImpl, 'https://openrouter.ai/api/v1/key', key).then(body => keySchema.parse(body).data)
  ]);
  return {
    balance: credits ? Math.round((credits.total_credits - credits.total_usage) * 1e6) / 1e6 : null,
    day: info.usage_daily ?? null, month: info.usage_monthly ?? null
  };
}

/** Траты организации (или проекта) OpenAI по дням с `from`; Costs API отдаёт только дневные корзины по UTC. */
export async function openAiBill(adminKey: string, from: Date, { project, fetchImpl = fetch }: { project?: string | null; fetchImpl?: typeof fetch } = {}): Promise<OpenAiBill> {
  const days = new Map<string, number>();
  let page: string | null = null;
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ start_time: String(Math.floor(from.getTime() / 1000)), bucket_width: '1d', limit: '31' });
    if (project) params.append('project_ids', project);
    if (page) params.set('page', page);
    const body = costsSchema.parse(await getJson(fetchImpl, `https://api.openai.com/v1/organization/costs?${params}`, adminKey));
    for (const bucket of body.data) {
      const date = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
      days.set(date, (days.get(date) ?? 0) + bucket.results.reduce((sum, r) => sum + (r.amount?.value ?? 0), 0));
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  const list = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, usd]) => ({ date, usd: Math.round(usd * 1e6) / 1e6 }));
  return { days: list, total: Math.round(list.reduce((sum, d) => sum + d.usd, 0) * 1e6) / 1e6 };
}

/** Кэш запроса счёта: консоль спрашивает часто, провайдеры обновляют счёт редко. Ошибка тоже кэшируется, но короче. */
export class Cached<T> {
  readonly #load: () => Promise<T>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #value: { bill: Bill<T>; until: number } | null = null;
  #pending: Promise<Bill<T>> | null = null;

  constructor(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now) {
    this.#load = load; this.#ttlMs = ttlMs; this.#now = now;
  }

  get(): Promise<Bill<T>> {
    if (this.#value && this.#value.until > this.#now()) return Promise.resolve(this.#value.bill);
    this.#pending ??= this.#load()
      .then((data): Bill<T> => ({ ok: true, at: new Date(this.#now()).toISOString(), data }))
      .catch((error): Bill<T> => ({ ok: false, at: new Date(this.#now()).toISOString(), error: failure(error) }))
      .then(bill => {
        this.#value = { bill, until: this.#now() + (bill.ok ? this.#ttlMs : Math.min(this.#ttlMs, 60_000)) };
        this.#pending = null;
        return bill;
      });
    return this.#pending;
  }
}
