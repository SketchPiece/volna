import type { SidebandListener } from '../realtime/sideband.ts';
import type { CallTrace, TraceValue } from './trace.ts';

/**
 * Прозвучало ли приветствие и что было на входе в этот момент (26.09.2026: в 12 из 30 звонков Волна молчала после
 * команды телефона «поздоровайся», а в логах разница не видна). GPT-Live исполняет команду, только когда идёт входной
 * звук, поэтому пишется уровень входа вокруг каждой команды. Только числа: звук и текст в замеры не попадают.
 *
 * - `greeting.trigger`: команда дошла (`session.instructions.appended` до первой реплики), `n` — номер команды,
 *   `inDb`/`inPeakDb` — средний и пиковый уровень входа за секунду до неё (дБ от полной шкалы), `chunks` — сколько
 *   кусков звука пришло за эту секунду;
 * - `greeting.said`: первая реплика Волны, `ms` от первой команды;
 * - `greeting.silent`: за `silenceMs` после команды Волна не заговорила; `inDb`/`inPeakDb`/`chunks` за это окно,
 *   `outPeakDb` — пик её выходного звука (не тишина ли она «говорит»), `userSpoke` — был ли текст пользователя.
 */
export interface GreetingProbeOptions {
  trace: CallTrace;
  /** Сколько ждать первую реплику после команды. */
  silenceMs?: number;
  /** После этого времени от начала звонка приветствие уже не ищется, звук не разбирается. */
  windowMs?: number;
  /** Монотонные миллисекунды; в тестах подставляется. */
  clock?: () => number;
}

/** Ниже этого уровень считается тишиной: пустой кусок даёт -Infinity. */
const FLOOR_DB = -100;

/** Уровень куска PCM16 (little-endian) в дБ от полной шкалы: средний (RMS) и пиковый. */
export function levelOf(base64: string): { rmsDb: number; peakDb: number } | null {
  const bytes = Buffer.from(base64, 'base64');
  const samples = Math.floor(bytes.length / 2);
  if (!samples) return null;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const v = bytes.readInt16LE(i * 2);
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const db = (x: number) => (x > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(x / 32768)) : FLOOR_DB);
  return { rmsDb: db(Math.sqrt(sum / samples)), peakDb: db(peak) };
}

interface Level { t: number; rmsDb: number; peakDb: number }

export class GreetingProbe implements SidebandListener {
  readonly #trace: CallTrace;
  readonly #silenceMs: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  readonly #origin: number;
  readonly #input: Level[] = [];
  readonly #output: Level[] = [];
  #triggers = 0;
  #firstTrigger: number | null = null;
  #userSpoke = false;
  #done = false;
  #timer: NodeJS.Timeout | null = null;

  constructor({ trace, silenceMs = 4000, windowMs = 30_000, clock = () => performance.now() }: GreetingProbeOptions) {
    this.#trace = trace;
    this.#silenceMs = silenceMs;
    this.#windowMs = windowMs;
    this.#clock = clock;
    this.#origin = clock();
  }

  observe(message: any): void {
    if (this.#done) return;
    const now = this.#clock() - this.#origin;
    if (now > this.#windowMs) { this.#finish(); return; }
    switch (message?.type) {
      case 'session.input_audio.append':
        this.#record(this.#input, now, message.audio);
        break;
      case 'session.output_audio.delta':
        this.#record(this.#output, now, message.delta);
        break;
      case 'session.input_transcript.delta':
        this.#userSpoke = true;
        break;
      case 'session.instructions.appended':
        this.#trigger(now);
        break;
      case 'session.output_transcript.delta':
        if (this.#firstTrigger !== null) this.#trace.mark('greeting.said', { n: this.#triggers, ms: Math.round(now - this.#firstTrigger), userSpoke: this.#userSpoke });
        this.#finish();
        break;
    }
  }

  close(): void { this.#finish(); }

  #record(levels: Level[], t: number, audio: unknown): void {
    if (typeof audio !== 'string') return;
    const level = levelOf(audio);
    if (!level) return;
    levels.push({ t, ...level });
    // Нужны только последние секунды: окно команды и окно ожидания.
    while (levels.length && levels[0]!.t < t - this.#silenceMs - 1000) levels.shift();
  }

  #trigger(now: number): void {
    this.#triggers++;
    if (this.#firstTrigger === null) this.#firstTrigger = now;
    this.#trace.mark('greeting.trigger', { n: this.#triggers, ...summary(this.#input, now - 1000, now) });
    if (this.#timer) clearTimeout(this.#timer);
    const n = this.#triggers;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#done) return;
      const end = this.#clock() - this.#origin;
      const out = summary(this.#output, now, end);
      this.#trace.mark('greeting.silent', { n, ...summary(this.#input, now, end), outPeakDb: out.inPeakDb, userSpoke: this.#userSpoke });
    }, this.#silenceMs);
    this.#timer.unref?.();
  }

  #finish(): void {
    this.#done = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#input.length = 0;
    this.#output.length = 0;
  }
}

/** Средний и пиковый уровень за окно [from, to) и число кусков; без кусков — null. */
function summary(levels: readonly Level[], from: number, to: number): Record<string, TraceValue> {
  const inside = levels.filter(l => l.t >= from && l.t < to);
  if (!inside.length) return { inDb: null, inPeakDb: null, chunks: 0 };
  // Средний по мощности, а не по децибелам: тихие куски не тянут среднее к -100.
  const power = inside.reduce((sum, l) => sum + 10 ** (l.rmsDb / 10), 0) / inside.length;
  const round = (x: number) => Math.round(x * 10) / 10;
  return { inDb: round(Math.max(FLOOR_DB, 10 * Math.log10(power))), inPeakDb: round(Math.max(...inside.map(l => l.peakDb))), chunks: inside.length };
}
