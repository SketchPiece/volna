import { z } from 'zod';

/**
 * Состояние агентов «Штурвала» для уведомлений и Live Activity. Порт агрегата релея T3 Connect
 * (infra/relay/src/agentActivity в репозитории t3code): сервер «Штурвала» присылает состояние каждого
 * треда, ядро собирает из всех тредов одну карточку для телефона. Форма карточки — пропсы виджета
 * AgentActivity в мобильном «Штурвале»; менять её только вместе с ним.
 */

export const phaseSchema = z.enum(['starting', 'running', 'waiting_for_approval', 'waiting_for_input', 'completed', 'failed', 'stale']);
export type Phase = z.infer<typeof phaseSchema>;

const text = z.string().trim().min(1);
export const stateSchema = z.object({
  environmentId: text,
  threadId: text,
  projectTitle: text,
  threadTitle: text,
  phase: phaseSchema,
  headline: text,
  detail: text.optional(),
  modelTitle: text,
  updatedAt: text,
  deepLink: text
});
export type AgentState = z.infer<typeof stateSchema>;

export interface ActivityRow {
  environmentId: string;
  threadId: string;
  projectTitle: string;
  threadTitle: string;
  modelTitle: string;
  phase: Phase;
  status: string;
  updatedAt: string;
  deepLink: string;
}

export interface Aggregate {
  title: string;
  subtitle: string;
  activeCount: number;
  updatedAt: string;
  activities: ActivityRow[];
}

export const MINUTE = 60_000;
/** Сколько висит закончившийся тред в карточке. */
const TERMINAL_DISPLAY_MS = 15 * MINUTE;
const MAX_ROWS = 5;
const TITLE = 'Helm';

const STATUS: Readonly<Record<Phase, string>> = {
  waiting_for_approval: 'Approval', waiting_for_input: 'Input', completed: 'Done', failed: 'Failed',
  starting: 'Connecting', running: 'Working', stale: 'Waiting'
};

export const isTerminal = (phase: Phase) => phase === 'completed' || phase === 'failed';
export const isWaiting = (phase: Phase) => phase === 'waiting_for_approval' || phase === 'waiting_for_input';
export const rowKey = (row: { environmentId: string; threadId: string }) => `${row.environmentId}/${row.threadId}`;
const time = (iso: string) => Date.parse(iso) || 0;
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);

/** Работающий тред без вестей дольше двух часов, остальные дольше суток — потерян, не показываем. */
function expired(state: AgentState, nowMs: number): boolean {
  const ttl = state.phase === 'running' || state.phase === 'starting' ? 2 * 60 * MINUTE : 24 * 60 * MINUTE;
  return nowMs - time(state.updatedAt) > ttl;
}

const priority = (phase: Phase) => (isWaiting(phase) ? 0 : phase === 'failed' ? 1 : phase === 'running' || phase === 'starting' ? 2 : 3);

export function rowForState(state: AgentState): ActivityRow {
  const deepLink = state.deepLink.startsWith('/') && !state.deepLink.startsWith('//') ? state.deepLink.slice(0, 512) : '/';
  return {
    environmentId: state.environmentId, threadId: state.threadId,
    projectTitle: clip(state.projectTitle, 120), threadTitle: clip(state.threadTitle, 120), modelTitle: clip(state.modelTitle, 120),
    phase: state.phase, status: STATUS[state.phase], updatedAt: state.updatedAt, deepLink
  };
}

function finished(row: ActivityRow): Aggregate {
  return {
    title: TITLE, subtitle: row.phase === 'failed' ? 'Agent work failed' : 'Agent work completed',
    activeCount: 0, updatedAt: row.updatedAt, activities: [row]
  };
}

/**
 * Карточка из всех тредов. Есть активные: ждущие владельца первыми, потом ошибки, потом работа, в хвосте
 * недавно закончившиеся. Активных нет: только что закончившийся тред (`terminal`) или самый свежий из
 * закончившихся за 15 минут. Пусто: null, карточку закрывают.
 */
export function makeAggregate(states: readonly AgentState[], terminal: AgentState | null, nowMs: number): Aggregate | null {
  const active = states.filter(state => !isTerminal(state.phase) && !expired(state, nowMs))
    .map(rowForState)
    .sort((a, b) => priority(a.phase) - priority(b.phase));
  const recentTerminal = states.filter(state => isTerminal(state.phase) && nowMs - time(state.updatedAt) <= TERMINAL_DISPLAY_MS)
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt))
    .map(rowForState);
  if (active.length === 0) {
    if (terminal) return finished(rowForState(terminal));
    return recentTerminal[0] ? finished(recentTerminal[0]) : null;
  }
  const activities = [...active, ...recentTerminal].slice(0, MAX_ROWS);
  const updatedAt = active.reduce((latest, row) => (time(row.updatedAt) > time(latest) ? row.updatedAt : latest), active[0]!.updatedAt);
  return { title: TITLE, subtitle: 'Agent work in progress', activeCount: active.length, updatedAt, activities };
}

export interface Preferences {
  liveActivitiesEnabled: boolean;
  notificationsEnabled: boolean;
  notifyOnApproval: boolean;
  notifyOnInput: boolean;
  notifyOnCompletion: boolean;
  notifyOnFailure: boolean;
}

/** Закончившийся тред сообщает о себе только первые две минуты: старый итог после переподключения — шум. */
const TERMINAL_ALERT_FRESH_MS = 2 * MINUTE;

export function alertAllowed(preferences: Preferences, row: ActivityRow, nowMs: number): boolean {
  if (!preferences.notificationsEnabled) return false;
  if (isTerminal(row.phase) && nowMs - time(row.updatedAt) > TERMINAL_ALERT_FRESH_MS) return false;
  switch (row.phase) {
    case 'waiting_for_approval': return preferences.notifyOnApproval;
    case 'waiting_for_input': return preferences.notifyOnInput;
    case 'completed': return preferences.notifyOnCompletion;
    case 'failed': return preferences.notifyOnFailure;
    default: return false;
  }
}

/** Треды, которые с прошлой карточки начали ждать владельца или закончились. */
export function changedRows(previous: Aggregate | null, next: Aggregate): { waiting: ActivityRow[]; finished: ActivityRow[] } {
  const before = new Map((previous?.activities ?? []).map(row => [rowKey(row), row.phase]));
  return {
    waiting: previous ? next.activities.filter(row => isWaiting(row.phase) && !isWaiting(before.get(rowKey(row)) ?? 'running')) : [],
    finished: next.activities.filter(row => isTerminal(row.phase) && !isTerminal(before.get(rowKey(row)) ?? 'running'))
  };
}

/**
 * Текст уведомления. Ключи `HELM_*` переведены в самом приложении (Localizable.strings «Штурвала»):
 * ядро не знает язык телефона. title/body — английский запас, если ключа нет.
 */
export interface Alert {
  title: string;
  body: string;
  'title-loc-key'?: string;
  'title-loc-args'?: string[];
  'loc-key'?: string;
  'loc-args'?: string[];
}

const ROW_KEYS: Partial<Record<Phase, { key: string; english: string }>> = {
  waiting_for_approval: { key: 'HELM_ALERT_APPROVAL', english: 'Approval needed' },
  waiting_for_input: { key: 'HELM_ALERT_INPUT', english: 'Waiting for input' },
  completed: { key: 'HELM_ALERT_DONE', english: 'Done' },
  failed: { key: 'HELM_ALERT_FAILED', english: 'Failed' }
};

export function alertForRows(rows: readonly ActivityRow[]): Alert | null {
  const [first] = rows;
  if (!first) return null;
  if (rows.length === 1) {
    const copy = ROW_KEYS[first.phase];
    return {
      title: first.threadTitle,
      body: `${copy?.english ?? first.status}: ${first.projectTitle}`,
      ...(copy ? { 'loc-key': copy.key, 'loc-args': [first.projectTitle] } : {})
    };
  }
  const attention = rows.some(row => isWaiting(row.phase));
  const count = String(rows.length);
  return {
    title: attention ? `${count} agents need attention` : `${count} agents finished`,
    body: rows.map(row => row.threadTitle).join(', '),
    'title-loc-key': attention ? 'HELM_ALERT_MANY_WAITING' : 'HELM_ALERT_MANY_DONE',
    'title-loc-args': [count]
  };
}
