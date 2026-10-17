import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import { extractsAfterCall, type Transcript, type Turn } from './model.ts';
import { score, tokens, type MemoryStore } from './store.ts';
import type { Task, TaskStore } from '../tasks/store.ts';

/**
 * Техкарта «История» (skills/history): что было в прошлых звонках и заданиях. Звонки берутся из сохранённых транскриптов
 * (только на уровнях, где они хранятся), задания из tasks.json. Память (`recall`) хранит факты о пользователе, а не
 * события; здесь наоборот. Текст разговора уходит только модели в результате инструмента, в лог не пишется.
 */
export const HISTORY_TOOL_NAMES: readonly string[] = ['history_read'];

/** Сколько символов выдержек из звонков на весь ответ: столько модель прочтёт без ущерба для задержки. */
const EXCERPT_BUDGET = 4000;
/** Меньше этого на звонок выдержка теряет смысл: лишние звонки дня отбрасываются, старшие первыми. */
const MIN_PER_CALL = 700;
/** Одна реплика в выдержке не длиннее этого. */
const MAX_TURN = 400;
/** Сколько последних транскриптов просматривать без даты. */
const SCAN_RECENT = 60;
/** Сколько звонков вернуть по запросу без даты. */
const MAX_MATCHED_CALLS = 3;
const MAX_TASKS = 6;
const MAX_RESULT = 300;

export interface HistoryCall {
  /** Время начала по часовому поясу пользователя: `YYYY-MM-DD HH:MM`. */
  at: string;
  minutes: number;
  excerpt: string;
}

export interface HistoryTask {
  title: string;
  status: Task['status'];
  created: string;
  finished: string | null;
  result: string | null;
}

/** Инструмент чтения истории. `tasks` — функция: хранилище заданий есть только со «Штурвалом» и создаётся позже. */
export function historyTools(store: MemoryStore, tasks: () => TaskStore | undefined = () => undefined): Tool[] {
  const read = defineTool({
    name: 'history_read',
    effect: 'read',
    description: 'Read what happened in past calls and background tasks: what you and the user discussed on a given day or last time, what was done before. Returns call excerpts and tasks. Without day: the latest earlier call, or with query the latest calls about it.',
    parameters: z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null).describe('Day in the user\'s time zone, YYYY-MM-DD (yesterday = today minus one day), or null for the latest calls.'),
      query: z.string().default('').describe('Words about the topic to focus on, e.g. «переезд»; empty for the whole call.')
    }),
    async execute({ day, query }, context) {
      const state = await store.load(context.now());
      const terms = tokens(query);
      const local = (iso: string) => localTime(new Date(iso), context.timeZone);
      const transcripts = await readTranscripts(store, day);
      let calls: Transcript[];
      if (day) calls = transcripts.filter(t => local(t.startedAt).startsWith(day));
      else if (terms.length) calls = transcripts.filter(t => relevance(t.turns, terms) > 0).slice(-MAX_MATCHED_CALLS);
      else calls = transcripts.slice(-1);
      // Звонков больше, чем помещается: остаются последние.
      calls = calls.slice(-Math.max(1, Math.floor(EXCERPT_BUDGET / MIN_PER_CALL)));
      const perCall = Math.floor(EXCERPT_BUDGET / Math.max(1, calls.length));

      const taskDay = day ?? (calls.length && !terms.length ? local(calls.at(-1)!.startedAt).slice(0, 10) : null);
      const allTasks = tasks()?.tasks ?? [];
      const found = taskDay
        ? allTasks.filter(t => local(t.createdAt).startsWith(taskDay) || (t.finishedAt && local(t.finishedAt).startsWith(taskDay)))
        : terms.length ? allTasks.filter(t => score(tokens(`${t.title} ${t.result ?? ''}`), terms) > 0) : [];

      const recording = extractsAfterCall(state.level);
      const result: Record<string, unknown> = {
        day: day ?? taskDay,
        calls: calls.map(t => ({
          at: local(t.startedAt),
          minutes: Math.max(1, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 60_000)),
          excerpt: excerpt(t.turns, terms, perCall)
        }) satisfies HistoryCall),
        tasks: found.slice(-MAX_TASKS).map(t => ({
          title: t.title, status: t.status, created: local(t.createdAt), finished: t.finishedAt ? local(t.finishedAt) : null,
          result: t.result ? clip(t.result, MAX_RESULT) : t.error ? `ошибка: ${t.error}` : null
        }) satisfies HistoryTask)
      };
      const notes: string[] = [];
      if (!recording) notes.push('Разговоры сейчас не сохраняются (уровень памяти ниже «Замечает сама»): звонков в истории может не быть. Скажи об этом честно, не додумывай.');
      if (!calls.length && !found.length) notes.push('Ничего не найдено. Не выдумывай, что было: скажи, что не помнишь этого разговора.');
      if (notes.length) result.note = notes.join(' ');
      return result;
    }
  });
  return [read];
}

/**
 * Транскрипты по возрастанию времени. Имя файла начинается с даты UTC, поэтому для дня берутся соседние даты,
 * а точный день по поясу пользователя проверяется после чтения.
 */
async function readTranscripts(store: MemoryStore, day: string | null): Promise<Transcript[]> {
  const names = await store.listTranscripts();
  let chosen: string[];
  if (day) {
    const base = Date.parse(`${day}T00:00:00Z`);
    const near = [-1, 0, 1].map(shift => new Date(base + shift * 86_400_000).toISOString().slice(0, 10));
    chosen = names.filter(name => near.includes(name.slice(0, 10)));
  } else chosen = names.slice(-SCAN_RECENT);
  const read = await Promise.all(chosen.map(name => store.readTranscript(name).catch(() => null)));
  return read.filter((t): t is Transcript => Boolean(t?.startedAt && Array.isArray(t.turns)))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Сколько реплик звонка касается запроса. */
function relevance(turns: Turn[], terms: string[]): number {
  return turns.filter(turn => score(tokens(turn.text), terms) > 0).length;
}

/**
 * Выдержка из звонка в пределах `budget` символов. С запросом: самые подходящие реплики с соседями (вопрос и ответ);
 * без запроса или если совпадений нет: начало разговора и его конец, где обычно договорённости. Пропуски помечены «…».
 */
export function excerpt(turns: Turn[], terms: string[], budget: number): string {
  const lines = turns.map(turn => `${turn.role === 'user' ? 'Пользователь' : 'Волна'}: ${clip(turn.text.trim(), MAX_TURN)}`);
  const cost = (i: number) => lines[i]!.length + 1;
  const picked = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    if (i < 0 || i >= lines.length || picked.has(i) || used + cost(i) > budget) return false;
    picked.add(i); used += cost(i); return true;
  };
  const ranked = terms.length
    ? turns.map((turn, i) => ({ i, s: score(tokens(turn.text), terms) })).filter(r => r.s > 0).sort((a, b) => b.s - a.s || a.i - b.i)
    : [];
  if (ranked.length) {
    for (const { i } of ranked) { take(i); take(i + 1); take(i - 1); }
  } else {
    for (let i = 0; i < lines.length && used < budget * 0.6; i++) if (!take(i)) break;
    for (let i = lines.length - 1; i >= 0 && !picked.has(i); i--) if (!take(i)) break;
  }
  const order = [...picked].sort((a, b) => a - b);
  const out: string[] = [];
  order.forEach((i, k) => {
    if ((k === 0 && i > 0) || (k > 0 && i !== order[k - 1]! + 1)) out.push('…');
    out.push(lines[i]!);
  });
  if (order.length && order.at(-1)! < lines.length - 1) out.push('…');
  return out.join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** `YYYY-MM-DD HH:MM` по часовому поясу пользователя. */
function localTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
