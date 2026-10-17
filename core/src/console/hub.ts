import type { SidebandControl, SidebandListener } from '../realtime/sideband.ts';
import type { DelegationGate, GateDecision, ManualAnswer } from '../delegation/client.ts';
import type { Turn } from '../realtime/conversation.ts';
import type { TraceEvent } from '../telemetry/trace.ts';
import type { Logger } from '../log.ts';
import type { ConsoleRecord, ConsoleStore } from './store.ts';

/**
 * Консоль ядра (docs/core.md, 4k): всё, что происходит в идущих звонках, для страницы на 127.0.0.1.
 * Каждый звонок пишет события sideband (`in`), отправленное ядром (`out`), отметки ядра (`mark`) и решения консоли
 * (`console`). Консоль может ответить на делегирование вместо автомата и дописать модели комментарий, мысль или инструкцию.
 * Текст звонка живёт в памяти и в записи истории (`data/console/`), в лог не попадает.
 */
export type ConsoleMode = 'auto' | 'next' | 'manual';
export type EventKind = 'in' | 'out' | 'mark' | 'console';
export interface ConsoleEvent { t: number; k: EventKind; type: string; data: unknown }
export interface CallInfo { model: string; voice: string }
export type AppendKind = 'commentary' | 'thinking' | 'instructions';

export type HubMessage =
  | { type: 'state'; mode: ConsoleMode; preset: ManualAnswer | null; holdMs: number }
  | { type: 'call'; callId: string; startedAt: string; info: CallInfo }
  | { type: 'e'; callId: string; e: ConsoleEvent }
  | { type: 'end'; callId: string };

/** Страховка от бесконечного звонка, как у замеров. */
export const MAX_CALL_EVENTS = 20_000;
export const DEFAULT_HOLD_MS = 20_000;
/** Текст из консоли: с запасом больше лимита Live в 500 токенов, чтобы можно было проверить и его. */
export const MAX_CONSOLE_TEXT = 4000;

export interface ConsoleHubOptions {
  store?: ConsoleStore;
  log: Logger;
  /** Сколько делегирование ждёт ответа в ручном режиме, потом уходит автомату. */
  holdMs?: number;
  clock?: () => number;
  now?: () => Date;
}

export class ConsoleCall {
  readonly callId: string;
  readonly startedAt: string;
  readonly info: CallInfo;
  readonly events: ConsoleEvent[] = [];
  readonly #hub: ConsoleHub;
  readonly #origin: number;
  #control: SidebandControl | null = null;
  #ended = false;

  constructor(hub: ConsoleHub, callId: string, info: CallInfo, origin: number, startedAt: string) {
    this.#hub = hub;
    this.callId = callId;
    this.info = info;
    this.#origin = origin;
    this.startedAt = startedAt;
  }

  get ended(): boolean { return this.#ended; }

  /** Участник sideband: видит все события звонка и может отправлять в сессию. */
  listener(): SidebandListener {
    return {
      attach: control => { this.#control = control; },
      observe: message => { if (typeof message?.type === 'string') this.record('in', message.type, message); },
      close: () => this.#end()
    };
  }

  /** Отправленное ядром (`SidebandOptions.onSend`). */
  sent(event: unknown): void {
    const type = (event as { type?: unknown })?.type;
    if (typeof type === 'string') this.record('out', type, event);
  }

  /** Отметка ядра из замеров: маршрут Jev, круги модели, инструменты. */
  mark(event: TraceEvent): void {
    const { t: _t, type, ...fields } = event;
    this.record('mark', type, fields);
  }

  record(k: EventKind, type: string, data: unknown): void {
    if (this.#ended || this.events.length >= MAX_CALL_EVENTS) return;
    const e: ConsoleEvent = { t: Math.round((this.#hub.clock() - this.#origin) * 10) / 10, k, type, data };
    this.events.push(e);
    this.#hub.broadcast({ type: 'e', callId: this.callId, e });
  }

  send(event: unknown): boolean {
    if (this.#ended || !this.#control) return false;
    this.#control.send(event);
    return true;
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#hub.ended(this);
  }
}

interface Hold { callId: string; resolve: (decision: GateDecision) => void }

export class ConsoleHub {
  readonly clock: () => number;
  readonly holdMs: number;
  readonly #now: () => Date;
  readonly #store: ConsoleStore | undefined;
  readonly #log: Logger;
  readonly #calls = new Map<string, ConsoleCall>();
  readonly #subscribers = new Set<(message: HubMessage) => void>();
  /** Делегирования, которые ждут ответа из консоли. Ключ: `звонок/делегирование`. */
  readonly #holds = new Map<string, Hold>();
  /** Идущие автоматические ответы, которые можно перехватить. */
  readonly #running = new Map<string, (answer: ManualAnswer) => void>();
  #mode: ConsoleMode = 'auto';
  #preset: ManualAnswer | null = null;

  constructor({ store, log, holdMs = DEFAULT_HOLD_MS, clock = () => performance.now(), now = () => new Date() }: ConsoleHubOptions) {
    this.#store = store;
    this.#log = log;
    this.holdMs = holdMs;
    this.clock = clock;
    this.#now = now;
  }

  get mode(): ConsoleMode { return this.#mode; }
  get store(): ConsoleStore | undefined { return this.#store; }

  startCall(callId: string, info: CallInfo): ConsoleCall {
    const call = new ConsoleCall(this, callId, info, this.clock(), this.#now().toISOString());
    this.#calls.set(callId, call);
    this.broadcast({ type: 'call', callId, startedAt: call.startedAt, info });
    return call;
  }

  /** Решает за звонок, кто отвечает на делегирование: автомат, заготовка или человек в консоли. */
  gate(call: ConsoleCall): DelegationGate {
    return {
      decide: (id, turns, signal, takeOver) => this.#decide(call, id, turns, signal, takeOver)
    };
  }

  #decide(call: ConsoleCall, id: string, turns: readonly Turn[], signal: AbortSignal, takeOver: (answer: ManualAnswer) => void): Promise<GateDecision> {
    const key = `${call.callId}/${id}`;
    call.record('console', 'console.context', { d: id, turns });
    if (this.#mode === 'next' && this.#preset) {
      const preset = this.#preset;
      this.setMode('auto');
      call.record('console', 'console.decision', { d: id, by: 'preset', kind: preset.kind });
      return Promise.resolve(preset);
    }
    if (this.#mode !== 'manual') {
      this.#running.set(key, answer => {
        call.record('console', 'console.decision', { d: id, by: 'operator', kind: answer.kind, takeover: true });
        takeOver(answer);
      });
      return Promise.resolve({ kind: 'auto' });
    }
    call.record('console', 'console.hold', { d: id, holdMs: this.holdMs });
    return new Promise<GateDecision>(resolve => {
      const finish = (decision: GateDecision, by: string) => {
        if (!this.#holds.has(key)) return;
        this.#holds.delete(key);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        call.record('console', 'console.decision', { d: id, by, kind: decision.kind });
        resolve(decision);
      };
      const onAbort = () => finish({ kind: 'auto' }, 'cancelled');
      const timer = setTimeout(() => finish({ kind: 'auto' }, 'timeout'), this.holdMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.#holds.set(key, { callId: call.callId, resolve: decision => finish(decision, 'operator') });
    });
  }

  /** Ответ из консоли на делегирование: ждущее получает его сразу, идущее автоматическое перехватывается. */
  answer(callId: string, id: string, decision: GateDecision): boolean {
    const key = `${callId}/${id}`;
    const hold = this.#holds.get(key);
    if (hold) { hold.resolve(decision); return true; }
    const running = this.#running.get(key);
    if (running && decision.kind !== 'auto') {
      this.#running.delete(key);
      running(decision);
      return true;
    }
    return false;
  }

  /** Комментарий, мысль или инструкция модели: к делегированию или ко всей сессии (`null`). */
  append(callId: string, kind: AppendKind, delegationId: string | null, content: string): boolean {
    const call = this.#calls.get(callId);
    if (!call || call.ended) return false;
    // Отметка перед отправкой: страница отличает вставку из консоли от вставки ядра.
    call.record('console', 'console.append', { kind, d: delegationId });
    return call.send({ type: `session.${kind}.append`, delegation_id: delegationId, content });
  }

  setMode(mode: ConsoleMode, preset: ManualAnswer | null = null): void {
    this.#mode = mode === 'next' && !preset ? 'auto' : mode;
    this.#preset = this.#mode === 'next' ? preset : null;
    this.broadcast(this.state());
  }

  state(): HubMessage & { type: 'state' } {
    return { type: 'state', mode: this.#mode, preset: this.#preset, holdMs: this.holdMs };
  }

  /** Всё для только что открытой страницы: режим и идущие звонки с событиями. */
  snapshot() {
    return {
      ...this.state(),
      calls: [...this.#calls.values()].map(call => ({ callId: call.callId, startedAt: call.startedAt, info: call.info, events: call.events }))
    };
  }

  subscribe(listener: (message: HubMessage) => void): () => void {
    this.#subscribers.add(listener);
    return () => { this.#subscribers.delete(listener); };
  }

  broadcast(message: HubMessage): void {
    for (const listener of this.#subscribers) {
      try { listener(message); } catch { /* страница не должна ломать звонок */ }
    }
  }

  ended(call: ConsoleCall): void {
    this.#calls.delete(call.callId);
    for (const [key, hold] of this.#holds) if (hold.callId === call.callId) hold.resolve({ kind: 'auto' });
    for (const key of this.#running.keys()) if (key.startsWith(`${call.callId}/`)) this.#running.delete(key);
    this.broadcast({ type: 'end', callId: call.callId });
    if (!this.#store) return;
    const last = call.events.at(-1)?.t ?? 0;
    const record: ConsoleRecord = { version: 1, callId: call.callId, startedAt: call.startedAt, durationMs: Math.round(last), info: call.info, events: call.events };
    this.#store.save(record).catch(error => this.#log.warn('console record not saved', { error: error instanceof Error ? error.name : 'unknown' }));
  }
}
