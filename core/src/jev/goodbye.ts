import type { Logger } from '../log.ts';
import { usageScope } from '../usage/ledger.ts';
import type { SidebandControl, SidebandListener } from '../realtime/sideband.ts';
import type { CallTrace } from '../telemetry/trace.ts';
import { Conversation } from '../realtime/conversation.ts';
import type { DecisionModel, JevQuestion } from './client.ts';
import { CALLBACK_GOODBYE_QUESTION, GOODBYE_QUESTION, jevState, round } from './questions.ts';

/**
 * Раннее завершение звонка на Jev. Через 350 мс тишины во входной стенограмме ядро спрашивает Jev, прощается ли
 * пользователь. Уверенное прощание сразу взводит завершение (как `end_call`: тишина после прощания Волны, потом
 * `session.close`) и просит Live коротко попрощаться. Если пользователь заговорил снова, завершение отменяется,
 * Live получает поправку, Jev оценивает новую фразу. Если бэкенд сам позвал `end_call`, отменить уже нельзя.
 *
 * Предвыборка инструментов в режиме Responses отсюда удалена 22.09.2026: Live ждёт свой бэкенд и справкой со стороны
 * не пользуется (замеры в docs/core.md, 4g); выбор инструмента на Jev живёт в клиентском делегировании.
 * Режим `shadow` только пишет решения в замеры.
 *
 * С 26.09.2026, пока идёт работа, тем же запросом Jev узнаёт прощание с просьбой перезвонить («пока, перезвони, как всё
 * будет готово»): ядро само зовёт `tasks_call_back` и кладёт трубку, не дожидаясь модели делегирования.
 */
export type GoodbyeMode = 'shadow' | 'on';

export const GOODBYE_DEBOUNCE_MS = 350;
/**
 * Порог «прощания с перезвоном» ниже общего: на пробе 26.09.2026 (9 фраз × 3) голые просьбы «перезвони, как будет
 * готово» Jev оценивал 0.89–0.92, а самое высокое «нет» («а ты можешь перезванивать?») 0.38.
 */
export const CALLBACK_THRESHOLD = 0.75;
export const GOODBYE_NOTE = 'Ядро: пользователь прощается. Попрощайся одной короткой фразой без вопросов, звонок закроется сам; бэкенду это передавать не нужно.';
export const CALLBACK_NOTE = 'Ядро: пользователь прощается и просит перезвонить; перезвон уже записан. Попрощайся одной короткой фразой без вопросов и скажи, что перезвонишь, когда всё будет готово; звонок закроется сам, бэкенду это передавать не нужно.';
export const GOODBYE_CANCEL_NOTE = 'Ядро: пользователь продолжает говорить, звонок не завершается. Слушай дальше.';

export interface GoodbyeWatcherOptions {
  jev: DecisionModel;
  mode: GoodbyeMode;
  threshold: number;
  /** Порог для прощания с перезвоном; по умолчанию `CALLBACK_THRESHOLD`. */
  callbackThreshold?: number;
  log: Logger;
  callId: string;
  trace?: CallTrace;
  debounceMs?: number;
  /** Есть ли идущая работа: только тогда Jev спрашивают о прощании с перезвоном. Без него вопроса нет. */
  workRunning?: () => boolean;
}

export class GoodbyeWatcher implements SidebandListener {
  readonly #options: GoodbyeWatcherOptions;
  readonly #conversation = new Conversation();
  #control: SidebandControl | null = null;
  #timer: NodeJS.Timeout | null = null;
  #inflight: AbortController | null = null;
  /** Растёт с каждым фрагментом пользователя: ответ Jev на устаревшую фразу отбрасывается. */
  #seq = 0;
  #armed = false;
  #noted = false;
  #closed = false;

  constructor(options: GoodbyeWatcherOptions) { this.#options = options; }

  attach(control: SidebandControl): void { this.#control = control; }

  observe(message: any): void {
    if (this.#closed || this.#conversation.observe(message) !== 'user') return;
    this.#seq++;
    if (this.#armed) this.#cancel();
    if (this.#timer) clearTimeout(this.#timer);
    this.#inflight?.abort();
    this.#inflight = null;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#evaluate(); }, this.#options.debounceMs ?? GOODBYE_DEBOUNCE_MS);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#inflight?.abort();
  }

  async #evaluate(): Promise<void> {
    const control = this.#control;
    if (!control || this.#closed) return;
    const seq = this.#seq;
    const started = performance.now();
    const abort = new AbortController();
    this.#inflight = abort;
    const { trace, mode, threshold } = this.#options;
    trace?.mark('jev.request', { seq });
    let goodbye: number;
    let callback: number | null = null;
    try {
      const asksCallback = this.#options.workRunning?.() ?? false;
      const questions: Record<string, JevQuestion> = asksCallback ? { goodbye: GOODBYE_QUESTION, callback: CALLBACK_GOODBYE_QUESTION } : { goodbye: GOODBYE_QUESTION };
      const { answers } = await usageScope({ purpose: 'jev_goodbye' }, () => this.#options.jev.decide({ state: jevState(this.#conversation.turns.slice(-16)), questions }, abort.signal));
      goodbye = answers.goodbye?.type === 'noul' ? answers.goodbye.noul : 0;
      if (asksCallback) callback = answers.callback?.type === 'noul' ? answers.callback.noul : 0;
    } catch (error) {
      if (abort.signal.aborted) return; // заменён новой фразой или звонок закончился
      trace?.mark('jev.error', { seq, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.name : 'unknown', status: (error as any)?.status ?? null });
      this.#options.log.warn('jev failed', { callId: this.#options.callId, error: error instanceof Error ? error.name : 'unknown' });
      return;
    } finally {
      if (this.#inflight === abort) this.#inflight = null;
    }
    let action: string;
    const ms = Math.round(performance.now() - started);
    if (seq !== this.#seq || this.#closed) action = 'stale';
    else if (callback !== null && callback >= (this.#options.callbackThreshold ?? CALLBACK_THRESHOLD)) action = mode === 'shadow' ? 'shadow_callback' : await this.#callBack(control, seq);
    else if (goodbye < threshold) action = 'below';
    else if (mode === 'shadow') action = 'shadow_goodbye';
    else action = this.#arm(control);
    trace?.mark('jev.result', { seq, ms, goodbye: round(goodbye), callback: round(callback), action });
  }

  /** Пользователь заговорил после угаданного прощания: трубку не кладём, Live узнаёт об этом. */
  #cancel(): void {
    this.#armed = false;
    if (!this.#control?.cancelEndCall('prefetch')) return;
    if (this.#noted) {
      this.#noted = false;
      this.#control.send({ type: 'session.thinking.append', delegation_id: null, content: GOODBYE_CANCEL_NOTE });
    }
  }

  #arm(control: SidebandControl, note = GOODBYE_NOTE, action = 'goodbye'): string {
    if (this.#armed) return 'goodbye_armed';
    this.#armed = true;
    control.endCall('prefetch');
    if (!this.#noted) {
      this.#noted = true;
      control.send({ type: 'session.thinking.append', delegation_id: null, content: note });
    }
    return action;
  }

  /** Прощание с перезвоном: ядро само ставит перезвон; если ставить не по чему, это обычное прощание. */
  async #callBack(control: SidebandControl, seq: number): Promise<string> {
    let output: string;
    try { output = await control.runTool('tasks_call_back', {}, 'jev'); } catch { return 'callback_failed'; }
    if (seq !== this.#seq || this.#closed) return 'stale';
    return /"callBack":true/.test(output) ? this.#arm(control, CALLBACK_NOTE, 'callback') : this.#arm(control);
  }
}
