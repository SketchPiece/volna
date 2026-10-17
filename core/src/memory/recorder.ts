import type { Transcript, Turn } from './model.ts';

/** Пауза между фрагментами одной стороны, после которой начинается новая реплика. */
export const TURN_GAP_MS = 2000;

/**
 * Собирает транскрипт звонка из событий GPT-Live. Транскрипция встроена в сессию и приходит фрагментами
 * (`session.input_transcript.delta`, `session.output_transcript.delta`) с таймингами; реплика закрывается сменой
 * говорящего, паузой длиннее TURN_GAP_MS или концом звонка. Ничего не пишет на диск: решение хранить принимает MemoryService.
 */
export class CallRecorder {
  readonly callId: string;
  readonly startedAt: string;
  readonly #turns: Turn[] = [];
  readonly #now: () => Date;
  #current: { role: Turn['role']; text: string; end: number | null } | null = null;

  constructor(callId: string, now: () => Date = () => new Date()) {
    this.callId = callId;
    this.#now = now;
    this.startedAt = now().toISOString();
  }

  get turns(): readonly Turn[] { this.#flush(); return this.#turns; }

  /** Принимает любое событие сессии; интересны только фрагменты транскрипта обеих сторон. */
  observe(message: any): void {
    if (message?.type === 'session.input_transcript.delta') this.#append('user', message);
    else if (message?.type === 'session.output_transcript.delta') this.#append('assistant', message);
  }

  finish(): Transcript {
    this.#flush();
    return { callId: this.callId, startedAt: this.startedAt, endedAt: this.#now().toISOString(), turns: [...this.#turns] };
  }

  #append(role: Turn['role'], message: any): void {
    if (typeof message.delta !== 'string') return;
    const start = typeof message.start_ms === 'number' ? message.start_ms : null;
    const end = typeof message.end_ms === 'number' ? message.end_ms : null;
    const current = this.#current;
    if (current && (current.role !== role || (start !== null && current.end !== null && start - current.end > TURN_GAP_MS))) this.#flush();
    if (!this.#current) this.#current = { role, text: '', end };
    this.#current.text += message.delta;
    if (end !== null) this.#current.end = end;
  }

  #flush(): void {
    const current = this.#current;
    this.#current = null;
    if (!current) return;
    const text = current.text.replace(/\s+/g, ' ').trim();
    if (text) this.#turns.push({ role: current.role, text, at: this.#now().toISOString() });
  }
}
