/**
 * Стенограмма разговора в памяти ядра для участников звонка (Jev, клиентское делегирование): реплики из
 * `session.input_transcript.delta` и `session.output_transcript.delta`, смена говорящего открывает новую реплику.
 * На диск не пишется; долговременный транскрипт ведёт memory/recorder.ts.
 */
export interface Turn { role: 'user' | 'assistant'; text: string }

const MAX_TURNS = 40;

export class Conversation {
  readonly #turns: Turn[] = [];
  #lastInputAt = 0;
  readonly #clock: () => number;

  constructor(clock: () => number = () => performance.now()) { this.#clock = clock; }

  /** Возвращает роль фрагмента, если это фрагмент стенограммы. */
  observe(message: any): Turn['role'] | null {
    const role = message?.type === 'session.input_transcript.delta' ? 'user'
      : message?.type === 'session.output_transcript.delta' ? 'assistant' : null;
    if (!role || typeof message.delta !== 'string') return null;
    if (this.#turns.at(-1)?.role !== role) this.#turns.push({ role, text: '' });
    this.#turns.at(-1)!.text += message.delta;
    if (role === 'user') this.#lastInputAt = this.#clock();
    if (this.#turns.length > MAX_TURNS) this.#turns.splice(0, this.#turns.length - MAX_TURNS);
    return role;
  }

  get turns(): readonly Turn[] { return this.#turns; }
  get lastInputAt(): number { return this.#lastInputAt; }

  /** Реплики до последней реплики пользователя включительно: филлер «Сейчас посмотрю» после неё не нужен бэкенду. */
  untilLastUser(limit = 16): Turn[] {
    const last = this.#turns.findLastIndex(t => t.role === 'user');
    return this.#turns.slice(0, last + 1).filter(t => t.text.trim()).slice(-limit).map(t => ({ role: t.role, text: t.text.trim() }));
  }
}
