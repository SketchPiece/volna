import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Замеры звонка: время каждого события sideband и отметки ядра (инструменты, Jev, завершение).
 * Инвариант как у лога: никакого текста разговора и аргументов, только типы событий, имена инструментов,
 * тайминги, длины фрагментов, счётчики токенов. Разбор: telemetry/summary.ts и `npm run metrics`.
 */
export type TraceValue = string | number | boolean | null;
export interface TraceEvent { t: number; type: string; [field: string]: TraceValue }

/** Настройки звонка, по которым потом сравниваются замеры. */
export interface TraceConfig { [field: string]: TraceValue }

export interface CallTraceFile {
  version: 1;
  callId: string;
  startedAt: string;
  config: TraceConfig;
  events: TraceEvent[];
}

export interface CallTraceOptions {
  callId: string;
  config: TraceConfig;
  /** Монотонные миллисекунды; в тестах подставляется. */
  clock?: () => number;
  now?: () => Date;
  /** Отметки ядра (не события sideband) по мере появления: их показывает консоль ядра. */
  onMark?: (event: TraceEvent) => void;
}

/** Страховка от бесконечного звонка: дальше события не пишутся, файл остаётся разумного размера. */
export const MAX_TRACE_EVENTS = 20_000;

export class CallTrace {
  readonly callId: string;
  readonly startedAt: string;
  readonly config: TraceConfig;
  readonly #events: TraceEvent[] = [];
  readonly #clock: () => number;
  readonly #origin: number;
  /** Первый фрагмент потокового события бэкенда на элемент: остальные дельты не пишутся. */
  readonly #seenDeltas = new Set<string>();
  readonly #onMark: ((event: TraceEvent) => void) | undefined;

  constructor({ callId, config, clock = () => performance.now(), now = () => new Date(), onMark }: CallTraceOptions) {
    this.#onMark = onMark;
    this.callId = callId;
    this.config = config;
    this.#clock = clock;
    this.#origin = clock();
    this.startedAt = now().toISOString();
  }

  get events(): readonly TraceEvent[] { return this.#events; }

  /** Отметка ядра: `tool.start`, `jev.result` и т. п. Поля только из разрешённых типов. */
  mark(type: string, fields: Record<string, TraceValue> = {}): void {
    const event = this.#push(type, fields);
    if (event && this.#onMark) try { this.#onMark(event); } catch { /* консоль не должна ломать замеры */ }
  }

  #push(type: string, fields: Record<string, TraceValue>): TraceEvent | null {
    if (this.#events.length >= MAX_TRACE_EVENTS) return null;
    const event = { ...fields, t: Math.round((this.#clock() - this.#origin) * 10) / 10, type };
    this.#events.push(event);
    return event;
  }

  /** Событие sideband как есть: время прихода и безопасные поля. */
  observe(message: any): void {
    const type = typeof message?.type === 'string' ? message.type : null;
    if (!type) return;
    if (type === 'session.input_transcript.delta' || type === 'session.output_transcript.delta') {
      this.#push(type === 'session.input_transcript.delta' ? 'in' : 'out', {
        s: numberOrNull(message.start_ms), e: numberOrNull(message.end_ms),
        n: typeof message.delta === 'string' ? message.delta.length : 0
      });
      return;
    }
    if (type === 'response.event') { this.#observeBackend(message); return; }
    const fields: Record<string, TraceValue> = {};
    if (typeof message.offset_ms === 'number') fields.offset = message.offset_ms;
    if (type === 'session.delegation.created') {
      fields.target = stringOrNull(message.delegation?.target);
      fields.d = stringOrNull(message.delegation?.id);
    }
    if (type === 'session.closed') fields.reason = stringOrNull(message.reason);
    if (type === 'error') {
      fields.code = stringOrNull(message.error?.code);
      // Текст ошибки OpenAI описывает запрос, а не разговор; нужен, чтобы понять, что именно Live отверг.
      fields.message = typeof message.error?.message === 'string' ? message.error.message.slice(0, 160) : null;
    }
    this.#push(type, fields);
  }

  #observeBackend(message: any): void {
    const inner = message.event;
    const innerType = typeof inner?.type === 'string' ? inner.type : 'unknown';
    const d = stringOrNull(message.delegation_id);
    if (innerType.endsWith('.delta')) {
      const key = `${innerType}:${inner.item_id ?? ''}:${inner.response_id ?? ''}:${d ?? ''}`;
      if (this.#seenDeltas.has(key)) return;
      this.#seenDeltas.add(key);
    }
    const fields: Record<string, TraceValue> = { d };
    const item = inner?.item;
    if (item && typeof item === 'object') {
      fields.item = stringOrNull(item.type);
      if (item.type === 'function_call') fields.tool = stringOrNull(item.name);
      if (item.type === 'web_search_call') fields.tool = 'web_search';
    }
    const usage = inner?.response?.usage;
    if (usage && typeof usage === 'object') {
      fields.inTokens = numberOrNull(usage.input_tokens);
      fields.outTokens = numberOrNull(usage.output_tokens);
      fields.reasoningTokens = numberOrNull(usage.output_tokens_details?.reasoning_tokens);
      fields.cachedTokens = numberOrNull(usage.input_tokens_details?.cached_tokens);
    }
    if (typeof inner?.response?.status === 'string') fields.status = inner.response.status;
    this.#push(`r.${innerType}`, fields);
  }

  toJSON(): CallTraceFile {
    return { version: 1, callId: this.callId, startedAt: this.startedAt, config: this.config, events: [...this.#events] };
  }
}

/** Файлы замеров: `<каталог>/<дата-время>-<звонок>.json`, один на звонок. */
export class TraceStore {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  async save(trace: CallTrace): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const file = trace.toJSON();
    const name = `${file.startedAt.slice(0, 19).replace(/[:T]/g, '-')}-${file.callId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
    await writeFile(join(this.dir, name), JSON.stringify(file));
    return name;
  }

  /** Все сохранённые звонки по порядку; битые файлы пропускаются. `since`: префикс даты `YYYY-MM-DD`. */
  async load(since?: string): Promise<CallTraceFile[]> {
    let names: string[];
    try { names = (await readdir(this.dir)).filter(n => n.endsWith('.json')).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const files: CallTraceFile[] = [];
    for (const name of names) {
      if (since && name.slice(0, since.length) < since) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.dir, name), 'utf8'));
        if (parsed?.version === 1 && Array.isArray(parsed.events)) files.push(parsed);
      } catch { /* битый файл не мешает остальным */ }
    }
    return files;
  }
}

function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' ? value : null; }
