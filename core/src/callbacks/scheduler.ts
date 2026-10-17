import type { Logger } from '../log.ts';
import type { LiveCalls } from '../realtime/live-calls.ts';
import type { PushSender } from '../push/apns.ts';
import type { CallbackStore, ScheduledCallback } from './store.ts';

export interface CallbackSchedulerOptions {
  store: CallbackStore;
  calls: LiveCalls;
  push: PushSender;
  log: Logger;
  /** Сколько ждать ответа на звонок Волны; потом запасное уведомление. */
  fallbackMs?: number;
  /** Ядро было выключено и время прошло давно: не звонить, а прислать уведомление «пропущено». */
  lateMs?: number;
  now?: () => Date;
}

export type FireOutcome = 'announced' | 'ringing' | 'notified' | 'missed';

/** setTimeout держит не больше ~24,8 дня; дальние перезвоны взводятся заново. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Перезвон в назначенное время (callback_schedule). Когда время пришло:
 * 1. идёт звонок: срочная заметка голосовой модели, она сразу напомнит;
 * 2. иначе VoIP-пуш, телефон звонит голосом Волны (тот же путь, что у перезвона по заданиям, tasks/delivery.ts);
 *    звонок принят — ядро отметит напоминание при открытии сессии (callbacks/context.ts); не принят за `fallbackMs` —
 *    уведомление с текстом напоминания;
 * 3. ядро было выключено дольше `lateMs` или звонок не ушёл: сразу уведомление;
 * 4. ничего не дошло: напоминание скажется в начале следующего звонка.
 * Ближайший перезвон держит один таймер; после каждого изменения он взводится заново (`arm`).
 */
export class CallbackScheduler {
  readonly #options: CallbackSchedulerOptions;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;
  readonly #fallbacks = new Set<NodeJS.Timeout>();

  constructor(options: CallbackSchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Взвести таймер на ближайший перезвон; наступившие исполняются сразу. */
  arm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const next = this.#options.store.scheduled[0];
    if (!next) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(next.at) - this.#now().getTime()));
    this.#timer = setTimeout(() => { this.#timer = null; void this.#due(); }, delay);
    this.#timer.unref();
  }

  async #due(): Promise<void> {
    const now = this.#now().getTime();
    for (const item of this.#options.store.scheduled.filter(c => Date.parse(c.at) <= now)) {
      try { await this.fire(item); }
      catch (error) { this.#options.log.warn('callback failed', { error: error instanceof Error ? error.name : 'unknown' }); }
    }
    this.arm();
  }

  async fire(item: ScheduledCallback): Promise<FireOutcome> {
    const { store, calls, push, log, fallbackMs = 45_000, lateMs = 2 * 3_600_000 } = this.#options;
    const firedAt = this.#now().toISOString();
    if (calls.count > 0) {
      calls.announce(`Ядро: пора напомнить. Пользователь просил перезвонить в это время и напомнить: «${item.reason}». Скажи ему об этом сразу, не дожидаясь паузы: коротко, своими словами.`, { urgent: true });
      await store.patch(item.id, { status: 'answered', firedAt });
      log.info('callback fired', { how: 'announced' });
      return 'announced';
    }
    const late = this.#now().getTime() - Date.parse(item.at) > lateMs;
    if (!late && push.canCall() && await push.call({ task: item.id, title: item.title })) {
      await store.patch(item.id, { status: 'ringing', firedAt });
      log.info('callback fired', { how: 'ringing' });
      const timer = setTimeout(() => {
        this.#fallbacks.delete(timer);
        // Звонок принят: статус уже `answered` (callbacks/context.ts).
        if (store.get(item.id)?.status === 'ringing') void this.#notify(item, 'missed');
      }, fallbackMs);
      timer.unref();
      this.#fallbacks.add(timer);
      return 'ringing';
    }
    return this.#notify(item, late ? 'late' : 'first', firedAt);
  }

  async #notify(item: ScheduledCallback, attempt: 'first' | 'missed' | 'late', firedAt = this.#now().toISOString()): Promise<FireOutcome> {
    const { store, push, log } = this.#options;
    // Интерфейс без рода (решение владельца): не «не дозвонилась».
    const body = attempt === 'missed' ? `Пропущенный звонок. Напоминаю: ${item.reason}` : `Напоминаю: ${item.reason}`;
    if (push.canNotify() && await push.notify({ title: 'Волна', body: body.length > 200 ? `${body.slice(0, 199)}…` : body }, { callback: item.id })) {
      await store.patch(item.id, { status: 'notified', firedAt: store.get(item.id)?.firedAt ?? firedAt });
      log.info('callback fired', { how: attempt === 'first' ? 'notified' : `notified_${attempt}` });
      return 'notified';
    }
    await store.patch(item.id, { status: 'missed', firedAt: store.get(item.id)?.firedAt ?? firedAt });
    log.info('callback fired', { how: 'missed' });
    return 'missed';
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const timer of this.#fallbacks) clearTimeout(timer);
    this.#fallbacks.clear();
  }
}
