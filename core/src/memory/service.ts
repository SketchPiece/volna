import type { Logger } from '../log.ts';
import { extractsAfterCall, type MemoryState, type Transcript } from './model.ts';
import { MemoryStore, staleThreads } from './store.ts';
import { buildMemoryContext, type MemoryContext } from './context.ts';
import { dream, extractFromTranscript, type ExtractorOptions } from './extractor.ts';
import { CallRecorder } from './recorder.ts';

export const DREAM_INTERVAL_MS = 24 * 3600 * 1000;
/** Столько открытых эпизодов запускают «сон» раньше суток: их сливает только он. */
export const DREAM_EPISODES = 15;
/** «Сон» по числу эпизодов не чаще: если модель ничего не слила, он не должен идти после каждого звонка. */
export const DREAM_MIN_INTERVAL_MS = 3 * 3600 * 1000;

export interface MemoryServiceOptions {
  store: MemoryStore;
  extractor: ExtractorOptions;
  log: Logger;
  now?: () => Date;
  /** Работа после извлечения и «сна», например пересмотр характера (persona/review.ts). */
  afterCall?: () => Promise<unknown>;
}

/**
 * Единая точка входа для ядра: контекст в сессию, запись звонка, извлечение после звонка, «сон».
 * Ошибки извлечения не роняют ядро и не влияют на звонок: память вторична по отношению к разговору.
 */
export class MemoryService {
  readonly store: MemoryStore;
  readonly #extractor: ExtractorOptions;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #afterCall?: () => Promise<unknown>;
  #working: Promise<void> = Promise.resolve();

  constructor({ store, extractor, log, now = () => new Date(), afterCall }: MemoryServiceOptions) {
    this.store = store; this.#extractor = extractor; this.#log = log; this.#now = now; this.#afterCall = afterCall;
  }

  get state(): MemoryState { return this.store.state; }

  /** Завершение фоновой работы; нужно тестам и graceful shutdown. */
  get idle(): Promise<void> { return this.#working; }

  /**
   * Контекст памяти для начинающегося звонка. Нить в нём ещё не отмечена поднятой: `commitThread()` зовут, когда OpenAI принял
   * звонок (http/session-route.ts), иначе неудачная попытка сжигала бы нить, как раньше приветствие (greeting/composer.ts).
   * `thread: false`: нить не выбирать (перезвон, готовые итоги работы), она ждёт следующего звонка.
   */
  async context({ thread = true }: { thread?: boolean } = {}): Promise<MemoryContext & { commitThread: () => Promise<void> }> {
    const now = this.#now();
    if (staleThreads(await this.store.load(now), now).length) {
      const closed = await this.store.update(s => { const stale = staleThreads(s, now); for (const fact of stale) fact.closedAt = now.toISOString(); return stale.length; }, now);
      this.#log.info('memory threads expired', { closed });
    }
    const state = this.store.state;
    const context = buildMemoryContext(state, this.#now(), { thread });
    const id = context.thread?.id;
    const commitThread = async () => {
      if (!id) return;
      await this.store.update(s => { const fact = s.facts.find(f => f.id === id); if (fact && !fact.askedAt) fact.askedAt = this.#now().toISOString(); }, this.#now());
    };
    return { ...context, commitThread };
  }

  /** Нужна ли транскрипция входа в этой сессии. */
  get recordsCalls(): boolean { return extractsAfterCall(this.state.level); }

  startCall(callId: string): CallRecorder | null {
    return this.recordsCalls ? new CallRecorder(callId, this.#now) : null;
  }

  /** После закрытия sideband: сохранить транскрипт, извлечь память, при необходимости «поспать». */
  endCall(recorder: CallRecorder): Promise<void> {
    const transcript = recorder.finish();
    const work = async () => {
      if (!transcript.turns.some(t => t.role === 'user')) return;
      await this.store.saveTranscript(transcript);
      await this.#extract(transcript);
      if (this.#dreamDue()) await this.runDream();
      await this.#afterCall?.();
    };
    this.#working = this.#working.then(work, work).catch(error => {
      // Только имя ошибки или код ответа модели («memory model 402»: кончились кредиты OpenRouter), без тела и без текста разговора.
      const reason = error instanceof Error ? (/^(responses|memory model) \d+$/.test(error.message) ? error.message : error.name) : 'unknown';
      this.#log.warn('memory update failed', { callId: transcript.callId, error: reason });
    });
    return this.#working;
  }

  #dreamDue(): boolean {
    const since = this.#now().getTime() - (this.state.lastDreamAt ? Date.parse(this.state.lastDreamAt) : 0);
    const episodes = this.state.facts.filter(f => f.kind === 'episode' && !f.closedAt).length;
    // Память до карточек (26.09.2026): первый «сон» раскладывает её, не дожидаясь суток.
    const unsorted = !this.state.cards.length && this.state.facts.some(f => !f.closedAt && f.kind !== 'episode' && f.kind !== 'thread');
    return since > DREAM_INTERVAL_MS || ((episodes > DREAM_EPISODES || unsorted) && since > DREAM_MIN_INTERVAL_MS);
  }

  async #extract(transcript: Transcript): Promise<void> {
    const now = this.#now();
    const update = await extractFromTranscript(this.#extractor, this.state, transcript, now);
    const result = await this.store.apply(update.operations, { origin: 'inferred', callId: transcript.callId, now });
    if (update.profile) await this.store.update(s => { s.profile = update.profile!; }, now);
    this.#log.info('memory extracted', { callId: transcript.callId, added: result.added.length, updated: result.updated.length, merged: result.merged.length, closed: result.closed.length, cards: result.cards.length, skipped: result.skipped });
  }

  async runDream(): Promise<void> {
    const now = this.#now();
    if (!this.state.facts.some(f => !f.closedAt)) { await this.store.update(s => { s.lastDreamAt = now.toISOString(); }, now); return; }
    const update = await dream(this.#extractor, this.state, now);
    const result = await this.store.apply(update.operations, { origin: 'inferred', now });
    await this.store.update(s => { if (update.profile) s.profile = update.profile; s.lastDreamAt = now.toISOString(); }, now);
    this.#log.info('memory dream', { added: result.added.length, updated: result.updated.length, merged: result.merged.length, closed: result.closed.length, cards: result.cards.length });
  }
}
