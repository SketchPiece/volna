import { HelmClient } from './client.ts';
import { HelmRpcError } from './rpc.ts';

/**
 * Поддельный «Штурвал» для тестов: отвечает на те же пути и RPC, что настоящий (0.0.45, протокол 2), помнит команды
 * и заголовки. Тест ведёт тред в прежней короткой форме (`latestTurn`, `messages`, `activities`, флаги ожидания),
 * а подделка отдаёт его снимками протокола 2: так тесты проверяют настоящий разбор клиента.
 *
 * Команды записываются как ушли, запуск треда — как `{ type: 'thread.launch', ...вход launchThread }`.
 */
export function fakeHelm(init: { version?: string; protocol?: number; projects?: object[] } = {}) {
  const commands: any[] = [];
  const auth: string[] = [];
  const headers: Record<string, string>[] = [];
  const threads = new Map<string, any>();
  const shell = { projects: [...(init.projects ?? [])] as any[], threads: [] as any[] };
  let ids = 0;
  let offline = false;
  /** Команды этих типов (и `thread.launch`) падают как обрыв сети (сбой между записью задания и командой). */
  const failing = new Set<string>();
  const polls = new Map<string, number>();
  /** Ход треда по опросам: тест меняет снимок перед каждым ответом (n — номер опроса этого треда, с 1). */
  const state = { script: null as null | ((thread: any, n: number) => void) };
  const fetchImpl: typeof fetch = async (input, request) => {
    if (offline) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const sent = (request?.headers ?? {}) as Record<string, string>;
    auth.push(String(sent.Authorization ?? ''));
    headers.push(sent);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/.well-known/t3/environment') {
      return reply(200, { environmentId: 'e', label: 'Mac', platform: { os: 'darwin' }, serverVersion: init.version ?? '0.0.45', capabilities: {}, orchestrationProtocolVersion: init.protocol ?? 2 });
    }
    if (url.pathname === '/api/orchestration/shell') {
      return reply(200, { schemaVersion: 1, snapshotSequence: 1, projects: shell.projects, threads: shell.threads.map(shellV2), archivedThreads: [] });
    }
    const threadPath = url.pathname.match(/^\/api\/orchestration\/threads\/(.+)\/bounded$/);
    if (threadPath) {
      const id = decodeURIComponent(threadPath[1]!);
      const thread = threads.get(id);
      if (thread && state.script) { polls.set(id, (polls.get(id) ?? 0) + 1); state.script(thread, polls.get(id)!); }
      return thread ? reply(200, { snapshotSequence: 1, projection: projectionV2(thread), historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: null }) : reply(404, { _tag: 'EnvironmentResourceNotFoundError' });
    }
    if (url.pathname === '/api/projects/mutate' && request?.method === 'POST') {
      const mutation = JSON.parse(String(request.body));
      if (failing.has(mutation.type)) throw new TypeError('fetch failed');
      commands.push(mutation);
      shell.projects.push({ id: mutation.projectId, title: mutation.title, workspaceRoot: mutation.workspaceRoot, defaultModelSelection: mutation.defaultModelSelection ?? null, scripts: [], createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z' });
      return reply(200, shell.projects.at(-1));
    }
    return reply(404, {});
  };
  const rpc = async (method: string, payload: any) => {
    if (offline) throw new HelmRpcError('offline');
    if (method === 'orchestration.launchThread') {
      if (failing.has('thread.launch')) throw new HelmRpcError('offline');
      const command = { type: 'thread.launch', ...payload };
      commands.push(command);
      const threadId = payload.threadId ?? `launched-${commands.length}`;
      threads.set(threadId, thread(threadId, payload.title, { branch: payload.workspaceStrategy?.branch ?? null }));
      return { threadId, projection: projectionV2(threads.get(threadId)), resumed: false };
    }
    if (method === 'orchestration.dispatchCommand') {
      if (failing.has(payload.type)) throw new HelmRpcError('offline');
      commands.push(payload);
      return { sequence: commands.length };
    }
    throw new HelmRpcError('fail', 'UnknownMethod');
  };
  const client = new HelmClient({ url: 'http://helm.test/', token: 'secret-token', fetchImpl, rpc, now: () => new Date('2026-09-25T10:00:00Z'), newId: () => `id-${++ids}` });
  return {
    client, commands, auth, headers, threads, shell, failing, setOffline(value: boolean) { offline = value; },
    set script(run: (thread: any, n: number) => void) { state.script = run; }
  };
}

const RUN_STATUS: Record<string, string> = { running: 'running', completed: 'completed', interrupted: 'interrupted', error: 'failed' };

/** Тред списка в короткой форме теста → `OrchestrationV2ThreadShell`. */
function shellV2(t: any): object {
  const sessionActive = t.session?.status === 'running' || t.session?.status === 'starting';
  const latestRunId = t.latestTurn?.turnId ?? (sessionActive ? 'run-session' : null);
  const status = t.latestTurn ? RUN_STATUS[t.latestTurn.state] ?? t.latestTurn.state : sessionActive ? 'running' : 'idle';
  const pending = t.hasPendingUserInput ? { id: 'rq-shell', kind: 'user_input', createdAt: t.updatedAt }
    : t.hasPendingApprovals ? { id: 'ap-shell', kind: 'command', createdAt: t.updatedAt } : null;
  return {
    createdBy: 'user', creationSource: 'web', id: t.id, projectId: t.projectId, title: t.title, providerInstanceId: 'claudeAgent',
    modelSelection: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' }, runtimeMode: 'auto', interactionMode: 'default',
    branch: null, worktreePath: null, latestRunId, activeRunId: status === 'running' ? latestRunId : null, status,
    lastError: t.session?.status === 'error' ? t.session.lastError ?? 'error' : null, pendingRuntimeRequest: pending,
    latestVisibleMessage: null, latestUserMessageAt: null, hasActionableProposedPlan: false, itemCount: 0, visibleItemCount: 0,
    createdAt: '2026-09-25T10:00:00Z', updatedAt: t.updatedAt, archivedAt: t.archivedAt ?? null, settledOverride: t.settledOverride ?? null, settledAt: t.settledAt ?? null, snoozedUntil: t.snoozedUntil ?? null, deletedAt: null,
    lineage: t.lineage ?? { rootThreadId: t.id, parentThreadId: null, relationshipToParent: null }
  };
}

/** Тред в короткой форме теста → `OrchestrationV2ThreadProjection` (запуски, заявки, сообщения, элементы хода). */
function projectionV2(t: any): object {
  const runs = t.latestTurn ? [{ id: t.latestTurn.turnId, ordinal: 1, status: RUN_STATUS[t.latestTurn.state] ?? t.latestTurn.state, userMessageId: 'u1' }] : [];
  const runtimeRequests: any[] = [];
  const turnItems: any[] = [];
  const base = (a: any) => ({ threadId: t.id, runId: a.turnId ?? null, nodeId: null, status: 'completed', title: null, updatedAt: a.createdAt });
  for (const a of t.activities as any[]) {
    const p = a.payload ?? {};
    const known = runtimeRequests.find(r => r.id === p.requestId);
    if (a.kind === 'user-input.requested') {
      if (!known) runtimeRequests.push({ id: p.requestId, kind: 'user_input', status: 'pending', createdAt: a.createdAt });
      turnItems.push({ ...base(a), id: a.id, type: 'user_input_request', requestId: p.requestId, questions: p.questions ?? [] });
    } else if (a.kind === 'approval.requested') {
      if (!known) runtimeRequests.push({ id: p.requestId, kind: p.requestKind ?? 'command', status: 'pending', createdAt: a.createdAt });
      turnItems.push({ ...base(a), id: a.id, type: 'approval_request', requestId: p.requestId, requestKind: p.requestKind ?? 'command', ...(p.detail ? { prompt: p.detail } : {}), ...(p.appName ? { appName: p.appName } : {}) });
    } else if (a.kind === 'user-input.resolved' || a.kind === 'approval.resolved') {
      if (known) known.status = 'resolved';
    } else if (a.kind.endsWith('.respond.failed')) {
      // Отказ «stale pending» прежнего протокола: заявка уже закрыта.
      if (known && /(stale|unknown) pending/i.test(String(p.detail ?? ''))) known.status = 'expired';
    } else {
      turnItems.push({ ...base(a), id: a.id, type: 'command_execution', title: a.summary, input: a.summary });
    }
  }
  return {
    thread: { id: t.id, title: t.title, projectId: t.projectId }, runs, attempts: [], nodes: [], subagents: [], providerSessions: [], providerThreads: [], providerTurns: [],
    runtimeRequests, plans: [], checkpointScopes: [], checkpoints: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], updatedAt: t.updatedAt,
    messages: (t.messages as any[]).map(m => ({ id: m.id, threadId: t.id, runId: m.turnId ?? null, nodeId: null, role: m.role, text: m.text, attachments: [], streaming: m.streaming, createdAt: m.createdAt, updatedAt: m.updatedAt, createdBy: 'agent', creationSource: 'provider' })),
    turnItems
  };
}

/** Тред в короткой форме теста (только поля, которые нужны подделке, плюс несколько лишних). */
export function thread(id: string, title = 'Задание', patch: object = {}) {
  return {
    id, projectId: 'p1', title, modelSelection: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' }, runtimeMode: 'auto',
    interactionMode: 'default', branch: null, worktreePath: null, latestTurn: null, createdAt: '2026-09-25T10:00:00Z',
    updatedAt: '2026-09-25T10:00:00Z', archivedAt: null, deletedAt: null, messages: [], activities: [], session: null, ...patch
  };
}

export const turn = (state: string, patch: object = {}) => ({
  turnId: 't1', state, requestedAt: '2026-09-25T10:00:00Z', startedAt: null, completedAt: null, assistantMessageId: null, ...patch
});

/** Событие треда: `user-input.requested`/`approval.requested` становятся заявками, `*.resolved` закрывают их, прочее — строкой журнала. */
export const activity = (id: string, kind: string, payload: object = {}, patch: object = {}) => ({
  id, tone: kind.startsWith('approval') ? 'approval' : 'info', kind, summary: kind, payload, turnId: 't1', createdAt: `2026-09-25T10:00:0${id.length % 10}Z`, ...patch
});

export const message = (id: string, text: string, patch: object = {}) => ({
  id, role: 'assistant', text, turnId: 't1', streaming: false, createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z', ...patch
});
