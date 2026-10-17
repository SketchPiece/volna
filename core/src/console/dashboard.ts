import type { MemoryState } from '../memory/model.ts';
import type { HelmCheck } from '../helm/client.ts';
import type { TraceStore } from '../telemetry/trace.ts';
import { turnsOf } from '../telemetry/summary.ts';
import type { Health, WarningGroup } from '../telemetry/health.ts';
import type { UsageLedger } from '../usage/ledger.ts';
import { Cached, type Bill, type OpenAiBill, type OpenRouterBill } from '../usage/billing.ts';
import { callCost, costReport, dayKey, modelReport, PERIODS, rangeOf, type CallCost, type CostReport, type ModelReport, type Period } from '../usage/report.ts';
import type { WorkAccess, WorkItem } from '../work-sync/sync.ts';
import type { ConsoleStore, RecordSummary } from './store.ts';

/**
 * Данные вкладок «Сводка» и «Расходы» консоли (docs/core.md, 4k и 4o). Только чтение: консоль ничего не меняет
 * в учёте и не шлёт провайдерам ничего, кроме запросов счёта.
 */
export interface DashboardDeps {
  ledger: UsageLedger;
  timeZone: string;
  health: Health;
  openRouter?: Cached<OpenRouterBill>;
  openAi?: Cached<OpenAiBill>;
  store?: ConsoleStore;
  work?: { items(): WorkItem[]; readonly access: WorkAccess };
  memory?: () => MemoryState;
  metrics?: TraceStore;
  helm?: () => Promise<HelmCheck>;
  push?: { apns: boolean; devices: () => number };
  plugins?: { servers: number };
  now?: () => Date;
}

/** Строка работы в «Сводке»: без текста вопроса, хода и итога — они видны в окне «Штурвала». */
export type WorkRow = Pick<WorkItem, 'id' | 'origin' | 'title' | 'status' | 'project' | 'updatedAt' | 'error'> & { waiting: 'question' | 'approval' | null };

export interface Latency { speak: number | null; answer: number | null; turns: number }

export interface Summary {
  now: string;
  startedAt: string;
  live: { at: string; error: string | null } | null;
  openRouter: Bill<OpenRouterBill> | null;
  helm: HelmCheck | null;
  push: { apns: boolean; devices: number } | null;
  plugins: { servers: number; failed: number } | null;
  today: { cost: number; calls: number; seconds: number; month: number; week: number };
  latency: Latency | null;
  memory: { notes: number; today: number; lastDreamAt: string | null } | null;
  calls: (RecordSummary & { cost: number | null })[];
  work: { access: WorkAccess; items: WorkRow[] } | null;
  warnings: WarningGroup[];
  spark: { date: string; total: number }[];
}

export interface Costs extends CostReport {
  openRouter: Bill<OpenRouterBill> | null;
  /** Сверка с OpenAI: счёт организации за месяц и то, что насчитало ядро по секундам GPT-Live. */
  openAi: (Bill<OpenAiBill> & { ours: number }) | null;
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
};

export class Dashboard {
  readonly #d: DashboardDeps;
  readonly #now: () => Date;
  readonly #latency: Cached<Latency> | null;
  readonly #helm: Cached<HelmCheck> | null;

  constructor(deps: DashboardDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => new Date());
    const metrics = deps.metrics;
    // Задержки за неделю: сотня файлов замеров, пересчёт раз в пять минут.
    this.#latency = metrics ? new Cached(async () => {
      const since = new Date(this.#now().getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
      const turns = (await metrics.load(since)).flatMap(turnsOf);
      return {
        speak: median(turns.map(t => t.speak).filter((v): v is number => v !== null)),
        answer: median(turns.filter(t => t.route).map(t => t.answer).filter((v): v is number => v !== null)),
        turns: turns.length
      };
    }, 5 * 60_000) : null;
    const helm = deps.helm;
    this.#helm = helm ? new Cached(() => helm(), 60_000) : null;
  }

  costs(period: Period): Promise<Costs> { return this.#costs(period); }

  async #costs(period: Period): Promise<Costs> {
    const { ledger, timeZone } = this.#d;
    const now = this.#now();
    const report = costReport(ledger.entries(), rangeOf(period, now, timeZone), timeZone);
    const [openRouter, openAi] = await Promise.all([this.#d.openRouter?.get() ?? null, this.#d.openAi?.get() ?? null]);
    let reconciled: Costs['openAi'] = null;
    if (openAi) {
      // Счёт OpenAI по дням UTC: сравниваем с секундами GPT-Live за те же дни.
      const days = new Set(openAi.ok ? openAi.data.days.map(d => d.date) : []);
      const ours = ledger.entries().filter(e => e.service === 'voice' && days.has(e.at.slice(0, 10))).reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
      reconciled = { ...openAi, ours: Math.round(ours * 1e6) / 1e6 };
    }
    return { ...report, openRouter, openAi: reconciled };
  }

  model(model: string, period: Period): ModelReport {
    const { ledger, timeZone } = this.#d;
    return modelReport(ledger.entries(), model, rangeOf(period, this.#now(), timeZone), timeZone);
  }

  call(callId: string): CallCost { return callCost(this.#d.ledger.entries(), callId); }

  async summary(): Promise<Summary> {
    const d = this.#d;
    const now = this.#now();
    const entries = d.ledger.entries();
    const today = rangeOf('today', now, d.timeZone);
    const todayReport = costReport(entries, today, d.timeZone);
    const month = costReport(entries, rangeOf('month', now, d.timeZone), d.timeZone);
    const week = costReport(entries, rangeOf('7d', now, d.timeZone), d.timeZone);
    const spark = costReport(entries, rangeOf('30d', now, d.timeZone), d.timeZone).days.slice(-14).map(({ date, total }) => ({ date, total }));
    const [openRouter, helm, latency, records] = await Promise.all([
      d.openRouter?.get() ?? null,
      this.#helm?.get().then(bill => bill.ok ? bill.data : { ok: false as const, version: null, reason: bill.error }) ?? null,
      this.#latency?.get().then(bill => bill.ok ? bill.data : null) ?? null,
      d.store?.list() ?? []
    ]);
    const warnings = d.health.warnings(new Date(now.getTime() - 86_400_000));
    const state = d.memory?.();
    const todayKey = dayKey(now, d.timeZone);
    return {
      now: now.toISOString(), startedAt: d.health.startedAt.toISOString(), live: d.health.live,
      openRouter, helm,
      push: d.push ? { apns: d.push.apns, devices: d.push.devices() } : null,
      plugins: d.plugins ? { servers: d.plugins.servers, failed: d.health.warnings(d.health.startedAt).filter(w => w.message === 'plugin.mcp_failed').reduce((n, w) => n + w.count, 0) } : null,
      today: { cost: todayReport.total, calls: todayReport.calls, seconds: todayReport.voiceSeconds, month: month.total, week: week.calls },
      latency,
      memory: state ? {
        notes: state.facts.filter(f => !f.closedAt).length,
        today: state.facts.filter(f => dayKey(f.learnedAt, d.timeZone) === todayKey).length,
        lastDreamAt: state.lastDreamAt
      } : null,
      calls: records.slice(0, 10).map(record => {
        const cost = callCost(entries, record.callId);
        return { ...record, cost: cost.services.length ? cost.total : null };
      }),
      work: d.work ? {
        access: d.work.access,
        items: d.work.items().slice(0, 10).map(item => ({
          id: item.id, origin: item.origin, title: item.title, status: item.status, project: item.project,
          updatedAt: item.updatedAt, error: item.error, waiting: item.waiting?.kind ?? null
        }))
      } : null,
      warnings: warnings.slice(0, 12),
      spark
    };
  }
}

export const isPeriod = (value: unknown): value is Period => PERIODS.includes(value as Period);
