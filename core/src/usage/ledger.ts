import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../log.ts';
import type { SidebandListener } from '../realtime/sideband.ts';

/**
 * Учёт расходов (docs/core.md, 4o): одна запись на каждый платный вызов, по файлу на месяц
 * `MEMORY_DIR/usage/YYYY-MM.jsonl`. В записи только служба, модель, токены, секунды и цена: ни текста, ни аргументов.
 * Звонок и назначение вызова приходят из контекста (`usageScope`), поэтому клиентам моделей не нужно их знать.
 */
export type UsageService = 'voice' | 'delegation' | 'memory' | 'jev' | 'service';
export type UsagePurpose =
  | 'voice' | 'delegation' | 'search' | 'title' | 'task_summary' | 'task_progress' | 'helm_transcribe'
  | 'memory_extract' | 'memory_dream' | 'persona_review' | 'jev_route' | 'jev_honesty' | 'jev_goodbye' | 'jev';

export const PURPOSE_SERVICE: Readonly<Record<UsagePurpose, UsageService>> = Object.freeze({
  voice: 'voice', delegation: 'delegation', search: 'delegation', title: 'service', task_summary: 'service', task_progress: 'service', helm_transcribe: 'service',
  memory_extract: 'memory', memory_dream: 'memory', persona_review: 'memory', jev_route: 'jev', jev_honesty: 'jev', jev_goodbye: 'jev', jev: 'jev'
});

export interface UsageEntry {
  at: string;
  service: UsageService;
  purpose: UsagePurpose;
  model: string;
  callId: string | null;
  inTokens: number | null;
  cachedTokens: number | null;
  outTokens: number | null;
  reasoningTokens: number | null;
  /** Секунды разговора GPT-Live; у текстовых моделей null. */
  seconds: number | null;
  /** Цена в долларах: от OpenRouter как есть, у GPT-Live — секунды по цене из настроек. null, если цену не прислали. */
  costUsd: number | null;
}

export type UsageInput = Partial<Omit<UsageEntry, 'at' | 'service' | 'purpose' | 'model'>> & { purpose: UsagePurpose; model: string };

/** Куда клиенты моделей пишут расход; в тестах подменяется. */
export interface UsageMeter { record(input: UsageInput): void }

interface Scope { callId?: string | null; purpose?: UsagePurpose }
const scope = new AsyncLocalStorage<Scope>();

/** Всё, что начнётся внутри `fn` (в том числе таймеры и промисы), запишется с этим звонком или назначением. */
export function usageScope<T>(patch: Scope, fn: () => T): T {
  return scope.run({ ...scope.getStore(), ...patch }, fn);
}

/** Назначение из контекста: один клиент Jev служит маршруту, проверке честности и прощанию. */
export function scopedPurpose(fallback: UsagePurpose): UsagePurpose {
  return scope.getStore()?.purpose ?? fallback;
}

/** Участник sideband, всё асинхронное у которого относится к звонку `callId`. */
export function scopedListener(listener: SidebandListener, callId: string): SidebandListener {
  const run = <T>(fn: () => T) => usageScope({ callId }, fn);
  return {
    attach: listener.attach && (control => run(() => listener.attach!(control))),
    observe: listener.observe && (message => run(() => listener.observe!(message))),
    close: listener.close && (() => run(() => listener.close!()))
  };
}

/** Поле `usage` ответа OpenRouter (`chat/completions` и `systemone`): токены, кэш, размышления и цена в долларах. */
export function openRouterUsage(usage: any): Pick<UsageEntry, 'inTokens' | 'cachedTokens' | 'outTokens' | 'reasoningTokens' | 'costUsd'> {
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    inTokens: num(usage?.prompt_tokens ?? usage?.input_tokens),
    cachedTokens: num(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens),
    outTokens: num(usage?.completion_tokens ?? usage?.output_tokens),
    reasoningTokens: num(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens),
    costUsd: num(usage?.cost)
  };
}

export interface UsageLedgerOptions {
  dir: string;
  log: Logger;
  now?: () => Date;
}

export class UsageLedger implements UsageMeter {
  readonly dir: string;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #entries: UsageEntry[] = [];
  #writing: Promise<void> = Promise.resolve();

  constructor({ dir, log, now = () => new Date() }: UsageLedgerOptions) {
    this.dir = dir;
    this.#log = log;
    this.#now = now;
  }

  /** Все месяцы в память: запись занимает ~200 байт, за год это несколько мегабайт. */
  async load(): Promise<void> {
    let names: string[];
    try { names = (await readdir(this.dir)).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) {
      for (const line of (await readFile(join(this.dir, name), 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try { this.#entries.push(JSON.parse(line) as UsageEntry); } catch { /* недописанная строка при сбое */ }
      }
    }
  }

  record(input: UsageInput): void {
    const store = scope.getStore();
    const entry: UsageEntry = {
      at: this.#now().toISOString(), service: PURPOSE_SERVICE[input.purpose], purpose: input.purpose, model: input.model,
      callId: input.callId !== undefined ? input.callId : store?.callId ?? null,
      inTokens: input.inTokens ?? null, cachedTokens: input.cachedTokens ?? null, outTokens: input.outTokens ?? null,
      reasoningTokens: input.reasoningTokens ?? null, seconds: input.seconds ?? null, costUsd: input.costUsd ?? null
    };
    this.#entries.push(entry);
    const file = join(this.dir, `${entry.at.slice(0, 7)}.jsonl`);
    this.#writing = this.#writing
      .then(() => mkdir(this.dir, { recursive: true }))
      .then(() => appendFile(file, `${JSON.stringify(entry)}\n`))
      .catch(error => this.#log.warn('usage not saved', { error: error instanceof Error ? error.name : 'unknown' }));
  }

  /** Записи с `from` включительно до `to` не включая, по времени. */
  entries(from?: Date, to?: Date): UsageEntry[] {
    const lo = from?.toISOString() ?? '', hi = to?.toISOString() ?? '￿';
    return this.#entries.filter(entry => entry.at >= lo && entry.at < hi);
  }

  /** Для тестов и остановки: дождаться записи на диск. */
  flush(): Promise<void> { return this.#writing; }
}

/**
 * Секунды GPT-Live: `session.usage.updated` приходит раз в ~15 с, `session.closed` несёт итог. Запись одна, когда звонок
 * закончился; цена — секунды по `pricePerMinute` (gpt-live-1: $0,05 за минуту, посекундно, сентябрь 2026).
 */
export function voiceUsage(meter: UsageMeter, { callId, model, pricePerMinute }: { callId: string; model: string; pricePerMinute: number }): SidebandListener {
  let seconds: number | null = null;
  let recorded = false;
  const read = (message: any) => {
    const value = message?.usage?.seconds;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) seconds = Math.max(seconds ?? 0, value);
  };
  const flush = () => {
    if (recorded || seconds === null) return;
    recorded = true;
    meter.record({ purpose: 'voice', model, callId, seconds, costUsd: Math.round(seconds * pricePerMinute / 60 * 1e6) / 1e6 });
  };
  return {
    observe(message) {
      if (message?.type === 'session.usage.updated') read(message);
      if (message?.type === 'session.closed') { read(message); flush(); }
    },
    close: flush
  };
}
