import type { SidebandControl, SidebandListener } from './sideband.ts';
import { fitAppend } from './append-limit.ts';

/** Короткая просьба, если Волна промолчала после заметки: полный текст уже в контексте, второй раз его не шлём. */
export const ANNOUNCE_NUDGE = 'Скажи пользователю сейчас то, о чём последняя заметка ядра выше: коротко, своими словами, одной-двумя фразами, затем слушай.';
/** То же для важного (итог работы): владелец хочет услышать его сразу, даже перебив его (решение 26.09.2026). */
export const ANNOUNCE_NUDGE_URGENT = 'Скажи пользователю сейчас, не дожидаясь паузы, то, о чём последняя заметка ядра выше: коротко, своими словами, затем слушай.';

export interface LiveCallsOptions {
  /** Сколько ждать речи Волны после заметки, прежде чем попросить ещё раз. */
  nudgeMs?: number;
  /** Пользователь говорил позже этого: не перебиваем, проверяем снова через это же время. */
  quietMs?: number;
  /** Дольше не ждём: разговор ушёл дальше, заметка осталась в контексте. */
  maxWaitMs?: number;
  now?: () => number;
}

interface Call {
  control: SidebandControl;
  lastOutput: number;
  lastInput: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Идущие звонки, которым ядро может сообщить что-то вне хода разговора (например, итог подтверждения с телефона).
 * Каждый звонок добавляет своего участника sideband; после закрытия sideband он удаляется.
 *
 * Заметка сама Волну не озвучивает: полнодуплексная модель говорит, когда сочтёт нужным, и в звонке 26.09.2026 итог
 * работы так и остался несказанным, пока владелец не спросил. Поэтому после заметки ядро слушает звонок: если за
 * `nudgeMs` Волна не заговорила и пользователь молчит (для `urgent` пауза не нужна), один раз шлёт короткую просьбу сказать сейчас (так же телефон
 * повторяет просьбу поздороваться, architecture.md, GreetingGate).
 */
export class LiveCalls {
  private readonly calls = new Set<Call>();
  private readonly nudgeMs: number;
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;

  constructor(options: LiveCallsOptions = {}) {
    this.nudgeMs = options.nudgeMs ?? 6000;
    this.quietMs = options.quietMs ?? 2000;
    this.maxWaitMs = options.maxWaitMs ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  listener(): SidebandListener {
    let call: Call | null = null;
    return {
      attach: control => { call = { control, lastOutput: 0, lastInput: 0, timer: null }; this.calls.add(call); },
      observe: message => {
        if (!call) return;
        if (message?.type === 'session.output_transcript.delta') call.lastOutput = this.now();
        if (message?.type === 'session.input_transcript.delta') call.lastInput = this.now();
      },
      close: () => {
        if (!call) return;
        if (call.timer) clearTimeout(call.timer);
        this.calls.delete(call);
        call = null;
      }
    };
  }

  get count(): number { return this.calls.size; }

  /**
   * Короткая заметка модели во всех идущих звонках; она сама решает, как сказать это вслух. `urgent`: сказать сразу,
   * даже если пользователь говорит (итог работы); повтор тогда не ждёт паузы.
   */
  announce(content: string, { urgent = false }: { urgent?: boolean } = {}): void {
    // У session.instructions.append поле delegation_id обязательно (проверено 22.09.2026, см. sideband.ts).
    // Больше 500 токенов Live не принимает и рвёт звонок (realtime/append-limit.ts).
    const text = fitAppend(content);
    const sentAt = this.now();
    for (const call of this.calls) {
      call.control.send({ type: 'session.instructions.append', delegation_id: null, content: text });
      if (call.timer) clearTimeout(call.timer);
      const check = () => {
        call.timer = null;
        if (!this.calls.has(call) || call.lastOutput >= sentAt) return;
        const now = this.now();
        if (now - sentAt >= this.maxWaitMs) return;
        if (!urgent && now - call.lastInput < this.quietMs) { call.timer = setTimeout(check, this.quietMs); return; }
        call.control.send({ type: 'session.instructions.append', delegation_id: null, content: urgent ? ANNOUNCE_NUDGE_URGENT : ANNOUNCE_NUDGE });
      };
      call.timer = setTimeout(check, this.nudgeMs);
    }
  }
}
