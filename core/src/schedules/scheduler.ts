import type { Logger } from '../log.ts';
import type { Schedule, ScheduleStore } from './store.ts';
import { nextRun, spokenRule } from './recurrence.ts';

export interface ScheduleSchedulerOptions {
  store: ScheduleStore;
  timeZone: string;
  log: Logger;
  /** Запуск «Работы» тем же путём, что work_start (tasks/runner.ts): итог приходит, как у любого задания. */
  startWork: (input: { title: string; prompt: string; callback: 'call' | 'notify'; helmProject?: string; worktree?: boolean }) => Promise<{ id: string }>;
  /** Идёт ли ещё задание прошлого запуска: тогда новый срок пропускается, работа не копится. */
  isRunning: (taskId: string) => boolean;
  /** Перезвон с напоминанием сейчас (callbacks/scheduler.ts); без ключа APNs нет, и расписаний `call` тоже. */
  remind?: (input: { title: string; reason: string }) => Promise<{ id: string }>;
  /** Ядро было выключено и срок прошёл давно: пропустить его, а не запускать с опозданием. */
  lateMs?: number;
  now?: () => Date;
}

/** setTimeout держит не больше ~24,8 дня. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Повторяющиеся задания по времени. Один таймер на ближайший срок; когда он пришёл:
 * - `work`: задание «Работы» с текстом расписания и датой запуска; если задание прошлого запуска ещё идёт, срок пропускается;
 * - `call`: разовый перезвон на сейчас, дальше его ведёт CallbackScheduler (звонок, заметка в идущий звонок или уведомление);
 * - срок прошёл больше чем на `lateMs` (ядро было выключено): пропускается.
 * После любого исхода `nextAt` переходит на следующий срок по правилу.
 */
export class ScheduleScheduler {
  readonly #options: ScheduleSchedulerOptions;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: ScheduleSchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  arm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const next = this.#options.store.all[0];
    if (!next) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(next.nextAt) - this.#now().getTime()));
    this.#timer = setTimeout(() => { this.#timer = null; void this.due(); }, delay);
    this.#timer.unref();
  }

  /** Исполнить наступившие сроки и взвести таймер заново. */
  async due(): Promise<void> {
    const now = this.#now();
    for (const item of this.#options.store.all.filter(s => Date.parse(s.nextAt) <= now.getTime())) {
      // Сбой одного расписания (например, записи на диск) не должен оставить остальные без таймера.
      try { await this.fire(item, now); }
      catch (error) { this.#options.log.warn('schedule failed', { schedule: item.id, error: error instanceof Error ? error.name : 'unknown' }); }
    }
    this.arm();
  }

  /** Один срок расписания; `nextAt` переходит дальше при любом исходе. */
  async fire(item: Schedule, now: Date = this.#now()): Promise<Schedule['lastOutcome']> {
    const { store, timeZone, log, isRunning, lateMs = 2 * 3_600_000 } = this.#options;
    let outcome: Schedule['lastOutcome'];
    let runId = item.lastRunId;
    if (now.getTime() - Date.parse(item.nextAt) > lateMs) outcome = 'skipped_late';
    else if (item.kind === 'work' && item.lastRunId && isRunning(item.lastRunId)) outcome = 'skipped_busy';
    else {
      try {
        runId = (await this.#run(item, now)).id;
        outcome = 'started';
      } catch (error) {
        outcome = 'failed';
        log.warn('schedule failed', { schedule: item.id, error: error instanceof Error ? error.name : 'unknown' });
      }
    }
    await store.patch(item.id, {
      nextAt: nextRun(item, now, timeZone).toISOString(), lastOutcome: outcome,
      ...(outcome === 'started' ? { lastRunAt: now.toISOString(), lastRunId: runId } : {})
    });
    log.info('schedule fired', { schedule: item.id, kind: item.kind, outcome });
    return outcome;
  }

  #run(item: Schedule, now: Date): Promise<{ id: string }> {
    const { startWork, remind, timeZone } = this.#options;
    if (item.kind === 'call') {
      if (!remind) throw new Error('no_push');
      return remind({ title: item.title, reason: item.prompt });
    }
    const today = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
    const prompt = `${item.prompt}\n\nЭто регулярное задание «${item.title}» (${spokenRule(item)}), сегодняшний запуск: ${today}.`;
    return startWork({ title: item.title, prompt: prompt.slice(0, 4000), callback: item.callback, helmProject: item.helmProject, worktree: item.worktree });
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
