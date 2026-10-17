import type { CallTraceFile, TraceEvent, TraceValue } from './trace.ts';

/**
 * Разбор замеров на ходы разговора. Ход начинается с фразы пользователя (последний фрагмент `in` перед реакцией)
 * и длится до следующей фразы пользователя после ответа. Все интервалы в мс по времени прихода событий в ядро.
 *
 * - `speak`   конец фразы пользователя → первый звук Волны (`out`). При делегировании это филлер «Сейчас посмотрю».
 * - `answer`  конец фразы → первый звук Волны после первого текста бэкенда: когда слышен настоящий ответ. Главная цифра.
 * - `decide`  конец фразы → `session.delegation.created`: сколько Live решает делегировать.
 * - `decideAudio` то же по часам сессии (`offset_ms` делегирования − `end_ms` фразы), без сетевых задержек.
 * - `select`  делегирование → готовый `function_call`: выбор инструмента и аргументов бэкендом.
 * - `tool`    исполнение инструмента ядром.
 * - `resume`  ответ инструмента отправлен → первый текст бэкенда: второй проход модели.
 * - `backend` делегирование → последний `response.done` хода.
 * - `jev`     задержка Jev и совпадение его выбора с первым инструментом бэкенда.
 */
export interface Turn {
  callId: string;
  config: string;
  index: number;
  userEnd: number;
  speak: number | null;
  answer: number | null;
  decide: number | null;
  decideAudio: number | null;
  select: number | null;
  tool: number | null;
  resume: number | null;
  backend: number | null;
  /** Инструменты бэкенда в этом ходе по порядку. */
  tools: string[];
  reasoningTokens: number | null;
  jevMs: number | null;
  jevTool: string | null;
  jevAction: string | null;
  jevGoodbye: number | null;
  prefetched: string | null;
  /** Маршрут клиентского делегирования: `jev` (быстрый путь) или последний `класс/набор`; null без делегирования. */
  route: string | null;
  /** Сколько раз маршрут поднимали (`client.escalate`). */
  escalations: number;
}

/** Ключ настроек для сравнения: какие модели, reasoning, tier и режим Jev были у звонка. */
export function configKey(config: Record<string, TraceValue>): string {
  return ['delegation', 'backendModel', 'reasoning', 'serviceTier', 'jev'].map(k => `${k}=${config[k] ?? '-'}`).join(' ');
}

export function turnsOf(file: CallTraceFile): Turn[] {
  const events = file.events;
  const config = configKey(file.config);
  const turns: Turn[] = [];
  let i = 0;
  while (i < events.length) {
    // Пропускаем до первой фразы пользователя, затем до её конца: последнего `in` перед любой реакцией.
    while (i < events.length && events[i]!.type !== 'in') i++;
    if (i >= events.length) break;
    let lastIn = events[i]!;
    let j = i + 1;
    for (; j < events.length; j++) {
      const e = events[j]!;
      if (e.type === 'in') lastIn = e;
      else if (e.type === 'out' || e.type === 'session.delegation.created') break;
    }
    // Ход длится до следующего `in` после того, как Волна начала реагировать.
    let end = j;
    while (end < events.length && events[end]!.type !== 'in') end++;
    const within = events.slice(events.indexOf(lastIn) + 1, end);
    turns.push(measure(file.callId, config, turns.length, lastIn, within));
    i = end;
  }
  return turns;
}

function measure(callId: string, config: string, index: number, lastIn: TraceEvent, within: TraceEvent[]): Turn {
  const find = (predicate: (e: TraceEvent) => boolean, from = 0) => within.slice(from).find(predicate) ?? null;
  const userEnd = lastIn.t;
  const out = find(e => e.type === 'out');
  // Ответ бэкенда: первый текст Responses или реплика своего делегирования (`client.commentary.sent`).
  const textIndex = within.findIndex(e => e.type === 'r.response.output_text.delta' || e.type === 'client.commentary.sent');
  const answered = textIndex >= 0 ? find(e => e.type === 'out', textIndex + 1) : null;
  const delegation = find(e => e.type === 'session.delegation.created');
  const calls = within.filter(e => (e.type === 'r.response.output_item.done' && (e.item === 'function_call' || e.item === 'web_search_call'))
    || (e.type === 'tool.start' && (e.origin === 'client' || e.origin === 'jev' || e.origin === 'device')));
  const toolStart = find(e => e.type === 'tool.start' && e.origin !== 'prefetch');
  const toolEnd = toolStart ? find(e => e.type === 'tool.end' && e.tool === toolStart.tool && e.t >= toolStart.t) : null;
  const sentIndex = within.findIndex(e => e.type === 'tool.output.sent');
  const sentAt = sentIndex >= 0 ? sentIndex : within.findLastIndex(e => e.type === 'tool.end' && (e.origin === 'client' || e.origin === 'jev' || e.origin === 'device'));
  const resumed = sentAt >= 0 ? find(e => e.type === 'r.response.output_text.delta' || e.type === 'client.commentary.sent', sentAt + 1) : null;
  const done = within.filter(e => e.type === 'r.response.done' || e.type === 'r.response.completed');
  const jev = [...within].reverse().find(e => e.type === 'jev.result' && e.action !== 'stale') ?? null;
  const prefetched = find(e => e.type === 'prefetch.sent');
  const reasoning = done.reduce<number | null>((sum, e) => typeof e.reasoningTokens === 'number' ? (sum ?? 0) + e.reasoningTokens : sum, null);
  const firstCall = calls[0] ?? null;
  const routeMark = [...within].reverse().find(e => e.type === 'client.route') ?? null;
  const route = jev?.action === 'answer' ? 'jev' : routeMark ? `${routeMark.tier}/${routeMark.card ?? routeMark.pack}` : null;
  return {
    callId, config, index, userEnd,
    speak: out ? out.t - userEnd : null,
    answer: answered ? answered.t - userEnd : delegation ? null : out ? out.t - userEnd : null,
    decide: delegation ? delegation.t - userEnd : null,
    decideAudio: delegation && typeof delegation.offset === 'number' && typeof lastIn.e === 'number' ? delegation.offset - lastIn.e : null,
    select: delegation && firstCall ? firstCall.t - delegation.t : null,
    tool: toolStart && toolEnd ? toolEnd.t - toolStart.t : null,
    resume: sentAt >= 0 && resumed ? resumed.t - within[sentAt]!.t : null,
    backend: delegation && done.length ? done.at(-1)!.t - delegation.t : null,
    tools: calls.map(e => String(e.tool ?? e.item)),
    reasoningTokens: reasoning,
    jevMs: typeof jev?.ms === 'number' ? jev.ms : null,
    jevTool: typeof jev?.tool === 'string' ? jev.tool : null,
    jevAction: typeof jev?.action === 'string' ? jev.action : null,
    jevGoodbye: typeof jev?.goodbye === 'number' ? jev.goodbye : null,
    prefetched: typeof prefetched?.tool === 'string' ? prefetched.tool : null,
    route,
    escalations: within.filter(e => e.type === 'client.escalate').length
  };
}

export interface Stat { n: number; p50: number | null; p90: number | null; mean: number | null }

export function stat(values: readonly (number | null)[]): Stat {
  const sorted = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, p50: null, p90: null, mean: null };
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { n: sorted.length, p50: Math.round(at(0.5)), p90: Math.round(at(0.9)), mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
}

export const METRICS: readonly (keyof Turn)[] = ['answer', 'speak', 'decide', 'decideAudio', 'select', 'tool', 'resume', 'backend', 'jevMs', 'reasoningTokens'];

export interface Summary {
  calls: number;
  turns: number;
  groups: {
    config: string;
    calls: number;
    turns: number;
    /** `speak` отдельно для ходов с инструментом и без: делегирование должно быть видно. */
    answerWithTools: Stat;
    answerDirect: Stat;
    metrics: Record<string, Stat>;
    perTool: Record<string, { select: Stat; tool: Stat; answer: Stat }>;
    jev: { evaluated: number; agree: number; actions: Record<string, number> } | null;
    /** По маршрутам клиентского делегирования: когда ответ слышен и сколько ходов пришлось поднимать. */
    perRoute: Record<string, { answer: Stat; escalated: number }>;
  }[];
}

/**
 * Совпадение Jev с бэкендом: Jev сказал `none`, и бэкенд ничего не звал, или назвал первый инструмент бэкенда.
 * Инструменты вне кандидатов предвыборки (поиск, напоминания) Jev честно называет `none`, это считается совпадением.
 */
export function jevAgrees(turn: Turn, candidates: readonly string[]): boolean | null {
  if (!turn.jevTool) return null;
  const actual = turn.tools.find(t => candidates.includes(t)) ?? 'none';
  return turn.jevTool === actual;
}

export function summarize(files: readonly CallTraceFile[], candidates: readonly string[]): Summary {
  const all = files.flatMap(turnsOf);
  const byConfig = new Map<string, Turn[]>();
  for (const turn of all) byConfig.set(turn.config, [...(byConfig.get(turn.config) ?? []), turn]);
  const groups = [...byConfig.entries()].map(([config, turns]) => {
    const metrics = Object.fromEntries(METRICS.map(m => [m, stat(turns.map(t => t[m] as number | null))]));
    const perTool: Record<string, { select: Stat; tool: Stat; answer: Stat }> = {};
    for (const name of new Set(turns.flatMap(t => t.tools))) {
      const subset = turns.filter(t => t.tools[0] === name);
      perTool[name] = { select: stat(subset.map(t => t.select)), tool: stat(subset.map(t => t.tool)), answer: stat(subset.map(t => t.answer)) };
    }
    const perRoute: Record<string, { answer: Stat; escalated: number }> = {};
    for (const route of new Set(turns.map(t => t.route).filter((r): r is string => r !== null))) {
      const subset = turns.filter(t => t.route === route);
      perRoute[route] = { answer: stat(subset.map(t => t.answer)), escalated: subset.filter(t => t.escalations > 0).length };
    }
    const judged = turns.map(t => jevAgrees(t, candidates)).filter((v): v is boolean => v !== null);
    const actions: Record<string, number> = {};
    for (const t of turns) if (t.jevAction) actions[t.jevAction] = (actions[t.jevAction] ?? 0) + 1;
    return {
      config,
      calls: new Set(turns.map(t => t.callId)).size,
      turns: turns.length,
      answerWithTools: stat(turns.filter(t => t.tools.length).map(t => t.answer)),
      answerDirect: stat(turns.filter(t => !t.tools.length && t.decide === null).map(t => t.answer)),
      metrics,
      perTool,
      jev: judged.length ? { evaluated: judged.length, agree: judged.filter(Boolean).length, actions } : null,
      perRoute
    };
  });
  return { calls: files.length, turns: all.length, groups };
}

/** Ходы в CSV для таблиц: одна строка на ход. */
export function turnsCsv(files: readonly CallTraceFile[]): string {
  const columns: (keyof Turn)[] = ['callId', 'config', 'index', 'answer', 'speak', 'decide', 'decideAudio', 'select', 'tool', 'resume', 'backend', 'tools', 'reasoningTokens', 'jevMs', 'jevTool', 'jevAction', 'jevGoodbye', 'prefetched', 'route', 'escalations'];
  const cell = (value: unknown) => {
    const text = Array.isArray(value) ? value.join('|') : value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(','), ...files.flatMap(turnsOf).map(t => columns.map(c => cell(t[c])).join(','))].join('\n') + '\n';
}

/**
 * Приветствие по отметкам `greeting.*` (telemetry/greeting-probe.ts): сколько звонков с командой поздороваться,
 * в скольких Волна заговорила до 4 с, за сколько, и уровень входа за секунду до первой команды у тех и других.
 */
export interface GreetingSummary { calls: number; said: number; late: number; silent: number; saidMs: Stat; inDbSaid: Stat; inDbSilent: Stat }

export function greetingSummary(files: readonly CallTraceFile[]): GreetingSummary {
  const result = { calls: 0, said: 0, late: 0, silent: 0, ms: [] as number[], inSaid: [] as (number | null)[], inSilent: [] as (number | null)[] };
  for (const file of files) {
    const trigger = file.events.find(e => e.type === 'greeting.trigger');
    if (!trigger) continue;
    result.calls++;
    const said = file.events.find(e => e.type === 'greeting.said');
    const silent = file.events.some(e => e.type === 'greeting.silent');
    const inDb = typeof trigger.inDb === 'number' ? trigger.inDb : null;
    if (said && !silent) { result.said++; result.ms.push(said.ms as number); result.inSaid.push(inDb); }
    else { if (said) result.late++; else result.silent++; result.inSilent.push(inDb); }
  }
  return { calls: result.calls, said: result.said, late: result.late, silent: result.silent, saidMs: stat(result.ms), inDbSaid: stat(result.inSaid), inDbSilent: stat(result.inSilent) };
}
