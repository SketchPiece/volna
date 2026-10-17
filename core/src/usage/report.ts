import type { UsageEntry, UsagePurpose, UsageService } from './ledger.ts';

/** Порядок служб постоянный: по нему идут цвета графиков консоли, от него не зависит сортировка по цене. */
export const SERVICES: readonly UsageService[] = ['voice', 'delegation', 'memory', 'jev', 'service'];
export type Period = 'today' | '7d' | '30d' | 'month';
export const PERIODS: readonly Period[] = ['today', '7d', '30d', 'month'];

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** Дата `YYYY-MM-DD` в часовом поясе владельца. */
export function dayKey(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

/** Полночь дня `date` в часовом поясе владельца как момент времени. */
export function zonedMidnight(date: string, timeZone: string): Date {
  const utc = new Date(`${date}T00:00:00Z`);
  // Смещение пояса в этот момент: разница между «стенными часами» пояса и UTC.
  const wall = new Date(new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(utc).replace(' ', 'T') + 'Z');
  return new Date(utc.getTime() - (wall.getTime() - utc.getTime()));
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface Range { period: Period; from: Date; to: Date; days: string[]; previous: { from: Date; to: Date } }

/** Границы периода по дням владельца: сегодня, последние 7 или 30 дней, текущий месяц. `to` — сейчас. */
export function rangeOf(period: Period, now: Date, timeZone: string): Range {
  const today = dayKey(now, timeZone);
  const first = period === 'today' ? today : period === '7d' ? addDays(today, -6) : period === '30d' ? addDays(today, -29) : `${today.slice(0, 8)}01`;
  const days: string[] = [];
  for (let day = first; day <= today; day = addDays(day, 1)) days.push(day);
  const from = zonedMidnight(first, timeZone);
  // Прошлый период той же длины: для месяца — прошлый месяц до того же числа.
  const previousFirst = period === 'month' ? `${addDays(first, -1).slice(0, 8)}01` : addDays(first, -days.length);
  const previousFrom = zonedMidnight(previousFirst, timeZone);
  const previousTo = new Date(previousFrom.getTime() + (now.getTime() - from.getTime()));
  return { period, from, to: now, days, previous: { from: previousFrom, to: previousTo < from ? previousTo : from } };
}

export interface ModelRow {
  model: string;
  services: UsageService[];
  purposes: UsagePurpose[];
  count: number;
  calls: number;
  inTokens: number;
  cachedTokens: number;
  outTokens: number;
  reasoningTokens: number;
  seconds: number;
  cost: number;
  /** Вызовы без цены (провайдер её не прислал): итог по модели меньше настоящего. */
  unpriced: number;
}

export interface CostReport {
  period: Period;
  from: string;
  to: string;
  total: number;
  previous: number;
  /** Только для месяца: если тратить так же до конца месяца. */
  forecast: number | null;
  calls: number;
  voiceSeconds: number;
  perCall: number | null;
  services: { service: UsageService; cost: number; count: number }[];
  days: { date: string; services: Record<UsageService, number>; total: number }[];
  models: ModelRow[];
  unpriced: number;
}

function modelRows(entries: UsageEntry[]): ModelRow[] {
  const rows = new Map<string, ModelRow & { callSet: Set<string> }>();
  for (const entry of entries) {
    let row = rows.get(entry.model);
    if (!row) rows.set(entry.model, row = { model: entry.model, services: [], purposes: [], count: 0, calls: 0, inTokens: 0, cachedTokens: 0, outTokens: 0, reasoningTokens: 0, seconds: 0, cost: 0, unpriced: 0, callSet: new Set() });
    if (!row.services.includes(entry.service)) row.services.push(entry.service);
    if (!row.purposes.includes(entry.purpose)) row.purposes.push(entry.purpose);
    row.count++;
    if (entry.callId) row.callSet.add(entry.callId);
    row.inTokens += entry.inTokens ?? 0;
    row.cachedTokens += entry.cachedTokens ?? 0;
    row.outTokens += entry.outTokens ?? 0;
    row.reasoningTokens += entry.reasoningTokens ?? 0;
    row.seconds += entry.seconds ?? 0;
    row.cost += entry.costUsd ?? 0;
    if (entry.costUsd === null) row.unpriced++;
  }
  return [...rows.values()]
    .map(({ callSet, ...row }) => ({ ...row, calls: callSet.size, cost: round(row.cost) }))
    .sort((a, b) => b.cost - a.cost || b.count - a.count);
}

export function costReport(all: UsageEntry[], range: Range, timeZone: string): CostReport {
  const lo = range.from.toISOString(), hi = range.to.toISOString();
  const entries = all.filter(e => e.at >= lo && e.at <= hi);
  const plo = range.previous.from.toISOString(), phi = range.previous.to.toISOString();
  const total = round(sum(entries.map(e => e.costUsd)));
  const voice = entries.filter(e => e.service === 'voice');
  const calls = new Set(voice.map(e => e.callId).filter(Boolean)).size;
  const inCalls = round(sum(entries.filter(e => e.callId).map(e => e.costUsd)));
  const days = range.days.map(date => ({ date, services: Object.fromEntries(SERVICES.map(s => [s, 0])) as Record<UsageService, number>, total: 0 }));
  const byDay = new Map(days.map(day => [day.date, day]));
  for (const entry of entries) {
    const day = byDay.get(dayKey(entry.at, timeZone));
    if (!day) continue;
    day.services[entry.service] += entry.costUsd ?? 0;
    day.total += entry.costUsd ?? 0;
  }
  for (const day of days) { day.total = round(day.total); for (const s of SERVICES) day.services[s] = round(day.services[s]); }
  let forecast: number | null = null;
  if (range.period === 'month') {
    const today = range.days.at(-1)!;
    const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    const elapsed = Math.max((range.to.getTime() - range.from.getTime()) / 86_400_000, 1);
    forecast = round(total / elapsed * daysInMonth);
  }
  return {
    period: range.period, from: lo, to: hi, total,
    previous: round(sum(all.filter(e => e.at >= plo && e.at < phi).map(e => e.costUsd))),
    forecast, calls, voiceSeconds: sum(voice.map(e => e.seconds)),
    perCall: calls ? round(inCalls / calls) : null,
    services: SERVICES.map(service => {
      const own = entries.filter(e => e.service === service);
      return { service, cost: round(sum(own.map(e => e.costUsd))), count: own.length };
    }),
    days, models: modelRows(entries),
    unpriced: entries.filter(e => e.costUsd === null).length
  };
}

export interface ModelReport {
  model: string;
  row: ModelRow | null;
  share: number | null;
  days: { date: string; cost: number }[];
  purposes: { purpose: UsagePurpose; cost: number; count: number }[];
  entries: UsageEntry[];
}

/** Одна модель подробно: по дням, на что уходит и последние вызовы (до `limit`, новые сверху). */
export function modelReport(all: UsageEntry[], model: string, range: Range, timeZone: string, limit = 200): ModelReport {
  const lo = range.from.toISOString(), hi = range.to.toISOString();
  const inRange = all.filter(e => e.at >= lo && e.at <= hi);
  const entries = inRange.filter(e => e.model === model);
  const total = sum(inRange.map(e => e.costUsd));
  const row = modelRows(entries)[0] ?? null;
  const days = range.days.map(date => ({ date, cost: 0 }));
  const byDay = new Map(days.map(day => [day.date, day]));
  for (const entry of entries) { const day = byDay.get(dayKey(entry.at, timeZone)); if (day) day.cost += entry.costUsd ?? 0; }
  for (const day of days) day.cost = round(day.cost);
  const purposes = new Map<UsagePurpose, { purpose: UsagePurpose; cost: number; count: number }>();
  for (const entry of entries) {
    const p = purposes.get(entry.purpose) ?? { purpose: entry.purpose, cost: 0, count: 0 };
    p.cost += entry.costUsd ?? 0; p.count++;
    purposes.set(entry.purpose, p);
  }
  return {
    model, row, share: row && total ? round(row.cost / total) : null, days,
    purposes: [...purposes.values()].map(p => ({ ...p, cost: round(p.cost) })).sort((a, b) => b.cost - a.cost),
    entries: entries.slice(-limit).reverse()
  };
}

export interface CallCost { callId: string; total: number; seconds: number | null; services: { service: UsageService; cost: number; count: number }[] }

/** Цена одного звонка: всё, что записано с его id, в том числе разбор памяти после него. */
export function callCost(all: UsageEntry[], callId: string): CallCost {
  const entries = all.filter(e => e.callId === callId);
  return {
    callId, total: round(sum(entries.map(e => e.costUsd))),
    seconds: entries.find(e => e.service === 'voice')?.seconds ?? null,
    services: SERVICES.map(service => {
      const own = entries.filter(e => e.service === service);
      return { service, cost: round(sum(own.map(e => e.costUsd))), count: own.length };
    }).filter(s => s.count)
  };
}
