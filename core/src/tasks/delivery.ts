import type { Logger } from '../log.ts';
import type { LiveCalls } from '../realtime/live-calls.ts';
import type { PushSender } from '../push/apns.ts';
import type { Task, TaskStore } from './store.ts';
import type { ResultSummarizer } from './summary.ts';
import { fitAppend } from '../realtime/append-limit.ts';

export interface TaskDeliveryOptions {
  store: TaskStore;
  calls: LiveCalls;
  /** Без него итог ждёт следующего звонка. */
  push?: PushSender;
  log: Logger;
  /** Сжимает итог до одной-трёх фраз для голоса (tasks/summary.ts); без него итог обрезается по лимиту. */
  summarize?: ResultSummarizer;
  /** Сколько ждать ответа на звонок Волны; потом запасное уведомление. */
  fallbackMs?: number;
}

/** `waiting`: другие задания ещё идут, итог ждёт их, чтобы прийти одной пачкой. */
export type DeliveryOutcome = 'announced' | 'waiting' | 'ringing' | 'notified' | 'pending';

/** Сколько итогов собирать в одну пачку; старые неуслышанные останутся для следующего звонка. */
const BATCH = 5;

/**
 * Куда девать готовый итог. По порядку:
 * 1. идёт звонок: заметка голосовой модели, она скажет, когда пользователь договорит;
 * 2. другие задания ещё идут: итог ждёт, чтобы не дёргать пользователя по каждому заданию;
 * 3. всё закончилось: одна пачка неуслышанных итогов. Если хоть для одного просили перезвонить (tasks_call_back),
 *    VoIP-пуш, телефон звонит голосом Волны; не ответил за `fallbackMs` — уведомление. Иначе сразу уведомление;
 * 4. пушей нет или не дошли: итоги скажутся в начале следующего звонка (tasks/context.ts).
 */
export class TaskDelivery {
  readonly #options: TaskDeliveryOptions;
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(options: TaskDeliveryOptions) { this.#options = options; }

  async deliver(task: Task): Promise<DeliveryOutcome> {
    const { store, calls, log } = this.#options;
    if (task.status !== 'done' && task.status !== 'failed') return 'pending';
    if (calls.count > 0) {
      const said = task.status === 'done' ? fitAppend(await this.#summary(task) ?? task.result ?? '', 300) : '';
      calls.announce(`Ядро: фоновое задание «${task.title}» ${task.status === 'done' ? `готово. Итог: ${said}` : 'не получилось выполнить.'} Скажи ему об этом сразу, не дожидаясь паузы, даже если он сейчас говорит: коротко, своими словами; подробности есть в tasks_list.`, { urgent: true });
      await store.patch(task.id, { delivery: 'heard' });
      log.info('task delivered', { task: task.id, how: 'announced' });
      return 'announced';
    }
    return this.flush();
  }

  /** Короткий итог для голоса: из задания, если уже сжат, иначе от модели; сохраняется в задании. */
  async #summary(task: Task): Promise<string | null> {
    if (task.summary) return task.summary;
    const summary = await this.#options.summarize?.(task) ?? null;
    if (summary) await this.#options.store.patch(task.id, { summary });
    return summary;
  }

  /**
   * Сообщает о неуслышанных итогах, если ничего больше не идёт. Зовётся после каждого законченного или отменённого
   * задания; пока хоть одно задание в работе, ничего не делает.
   */
  async flush(): Promise<DeliveryOutcome> {
    const { store, calls, push, log, fallbackMs = 45_000 } = this.#options;
    if (store.active.length) {
      log.info('task delivery waits', { active: store.active.length });
      return 'waiting';
    }
    // Итоги, готовые до начала звонка, ушли в его инструкции (tasks/context.ts).
    if (calls.count > 0) return 'pending';
    const batch = unheard(store);
    if (!batch.length) return 'pending';
    const ids = batch.map(t => t.id);
    const call = push && batch.some(t => t.callback === 'call') && push.canCall();
    // Выжимка до звонка: разговор начнётся с итогов (tasks/context.ts), а сырой отчёт агента слишком длинный для голоса.
    if (call) await Promise.all(batch.filter(t => t.status === 'done').map(t => this.#summary(t)));
    if (call && await push.call({ task: ids[0], title: callTitle(batch) })) {
      for (const id of ids) await store.patch(id, { delivery: 'ringing' });
      log.info('task delivered', { tasks: ids.length, how: 'ringing' });
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        // Звонок принят: ядро пометило итоги услышанными при открытии сессии (tasks/context.ts).
        const missed = ids.map(id => store.get(id)).filter((t): t is Task => t?.delivery === 'ringing');
        if (missed.length) void this.#notify(missed, 'missed');
      }, fallbackMs);
      timer.unref();
      this.#timers.add(timer);
      return 'ringing';
    }
    return this.#notify(batch, 'first');
  }

  async #notify(batch: Task[], attempt: 'first' | 'missed'): Promise<DeliveryOutcome> {
    const { store, push, log } = this.#options;
    const ids = batch.map(t => t.id);
    if (push?.canNotify() && await push.notify({ title: 'Волна', body: notificationBody(batch) }, { task: ids[0], tasks: ids })) {
      for (const id of ids) await store.patch(id, { delivery: 'notified' });
      log.info('task delivered', { tasks: ids.length, how: attempt === 'missed' ? 'notified_after_call' : 'notified' });
      return 'notified';
    }
    // Итоги остаются pending (или ringing сбрасывается в pending): скажутся в следующем звонке.
    for (const id of ids) await store.patch(id, { delivery: 'pending' });
    log.info('task delivered', { tasks: ids.length, how: 'pending' });
    return 'pending';
  }

  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}

/** Законченные задания, о которых пользователь ещё не знает, последние `BATCH`. */
function unheard(store: TaskStore): Task[] {
  return store.tasks.filter(t => (t.status === 'done' || t.status === 'failed') && t.delivery === 'pending').slice(-BATCH);
}

function callTitle(batch: Task[]): string {
  return batch.length === 1 ? batch[0]!.title : 'Задания готовы';
}

/** Текст уведомления. Одно задание: название и первое предложение итога; несколько: названия. Подробности Волна расскажет в звонке. */
export function notificationBody(batch: Task[]): string {
  if (batch.length === 1) {
    const task = batch[0]!;
    if (task.status !== 'done' || !task.result) return `«${task.title}»: не получилось. Позвоните, расскажу, что пошло не так.`;
    const first = task.result.match(/^.+?[.!?](\s|$)/)?.[0]?.trim() ?? task.result;
    const short = first.length > 160 ? `${first.slice(0, 157)}…` : first;
    return `«${task.title}» готово. ${short}`;
  }
  const done = batch.filter(t => t.status === 'done').map(t => `«${t.title}»`);
  const failed = batch.filter(t => t.status !== 'done').map(t => `«${t.title}»`);
  const parts = [done.length ? `Готово: ${done.join(', ')}.` : '', failed.length ? `Не получилось: ${failed.join(', ')}.` : ''];
  return `${parts.filter(Boolean).join(' ')} Позвоните, расскажу.`;
}
