import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HelmRpc, HelmRpcError, type RpcTransport } from './rpc.ts';

/**
 * Клиент «Штурвала» (Helm, форк T3 Code на этом Mac; с 05.10.2026 вместо самого T3 Code). Сервер держит проекты,
 * треды и агентов (Claude, Codex); ядро читает снимки по HTTP и шлёт команды оркестрации по WebSocket-RPC (rpc.ts).
 * Протокол оркестрации 2, сверено по исходникам 0.0.45 (`packages/contracts/src/orchestrationV2.ts`,
 * `environmentHttp.ts`, `apps/server/src/orchestration-v2/`); здесь зеркало только нужных полей.
 *
 * Снимки протокола 2 (запуски `runs`, заявки `runtimeRequests`, элементы хода `turnItems`) клиент сводит к прежней
 * модели ядра: последний ход (`latestTurn`, его id — id запуска), сообщения, журнал хода (`activities`) и открытые
 * вопросы и разрешения (`requests`). Так исполнитель, инструменты и синхронизация не зависят от формы протокола.
 *
 * Токен (`auth session issue`, docs/core.md, 4l) идёт только в заголовок и никогда в лог.
 * Id тредов, сообщений и команд создаёт клиент (UUID); команды идемпотентны по `commandId`.
 */
export interface HelmOptions {
  /** Адрес сервера, например http://127.0.0.1:3783 у «Штурвала» (порт в ~/.helm/userdata/server-runtime.json). */
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Команды по WebSocket-RPC; без него клиент открывает соединение сам (через «Узел» его подставляет relay/link.ts). */
  rpc?: RpcTransport;
  timeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Проверенная линия: мажорная версия сервера и версия протокола оркестрации (`orchestrationProtocolVersion`).
 * При расхождении ядро не шлёт команд: чужой формат мог бы запустить не то.
 */
export const HELM_SUPPORTED = { major: 0, protocol: 2, tested: '0.0.45' } as const;
/** Заголовок, без которого «Штурвал» не отдаёт снимки оркестрации. */
const PROTOCOL_HEADER = { 'x-t3-orchestration-protocol': String(HELM_SUPPORTED.protocol) };

/**
 * Режим разрешений нового треда. `auto`: Claude в режиме auto, Codex с `approvalsReviewer: auto_review`, рискованное
 * всё равно спрашивается. `full-access` (bypass) ядро не включает никогда.
 */
export const HELM_RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto'] as const;
export type HelmRuntimeMode = typeof HELM_RUNTIME_MODES[number];

/**
 * Модель по умолчанию для инстансов. Claude — Opus 5.5 по решению владельца 26.09.2026 (у самого T3 по умолчанию Fable 5.1).
 * У Codex своей нет (gpt-6-astra, модель Астры, убрана 05.10.2026): берётся модель проекта или сервера, либо HELM_MODEL.
 */
export const HELM_DEFAULT_MODELS: Record<string, string> = { claudeAgent: 'claude-opus-5-5' };

/** Кто и откуда пишет в «Штурвал»: владелец, сказавший это в звонке на телефоне. */
const AUTHOR = { createdBy: 'user', creationSource: 'mobile' } as const;

const environmentSchema = z.object({
  serverVersion: z.string(),
  orchestrationProtocolVersion: z.number().int().optional()
});

const modelSelectionSchema = z.object({ instanceId: z.string(), model: z.string() });

const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
  defaultModelSelection: modelSelectionSchema.nullable().catch(null).default(null)
});

/** Тред в снимке «Штурвала» (`OrchestrationV2ThreadShell`): только то, что читает ядро. */
const threadShellV2 = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  latestRunId: z.string().nullable().default(null),
  activeRunId: z.string().nullable().default(null),
  /** `idle` или состояние запуска: preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back. */
  status: z.string(),
  lastError: z.string().nullable().optional(),
  pendingRuntimeRequest: z.object({ id: z.string(), kind: z.string() }).nullable().default(null),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
  /** Тред разобран (settle): «Штурвал» убирает его из активных; `settledOverride: 'active'` — вернули вручную. */
  settledAt: z.string().nullable().catch(null).default(null),
  settledOverride: z.string().nullable().catch(null).default(null),
  /** Отложен (snooze) до этого времени. */
  snoozedUntil: z.string().nullable().catch(null).default(null),
  /** Родитель: `subagent` — дочерний тред (субагент, делегированная задача), в списке «Штурвала» его нет; `fork` — ответвление, виден. */
  lineage: z.object({
    parentThreadId: z.string().nullable().catch(null).default(null),
    relationshipToParent: z.string().nullable().catch(null).default(null)
  }).nullable().catch(null).default(null)
});

const shellV2 = z.object({ projects: z.array(projectSchema), threads: z.array(threadShellV2) });

const runV2 = z.object({ id: z.string(), ordinal: z.number(), status: z.string(), userMessageId: z.string().optional() });

const messageV2 = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  runId: z.string().nullable().default(null),
  streaming: z.boolean().default(false)
});

const runtimeRequestV2 = z.object({ id: z.string(), kind: z.string(), status: z.string(), createdAt: z.string() });

const questionSchema = z.object({
  id: z.string(),
  header: z.string().default(''),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().default(''), value: z.string().optional() })).default([]),
  allowCustomAnswer: z.boolean().optional(),
  multiSelect: z.boolean().default(false)
});

/** Элемент хода: вопросы и разрешения берут текст отсюда, остальное идёт в журнал хода. */
// Элементов хода много видов, и форма полей у них разная (`input` у вызова инструмента — объект): поле чужого типа
// отбрасывается, а не роняет разбор всего снимка.
const loose = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const turnItemV2 = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().nullable().catch(null).default(null),
  requestId: loose(z.string()),
  questions: loose(z.array(z.unknown())),
  requestKind: loose(z.string()),
  prompt: loose(z.string()),
  appName: loose(z.string()),
  input: loose(z.string()),
  fileName: loose(z.string())
});

const projectionV2 = z.object({
  thread: z.object({ id: z.string(), title: z.string() }).passthrough(),
  runs: z.array(runV2),
  runtimeRequests: z.array(runtimeRequestV2),
  messages: z.array(messageV2),
  turnItems: z.array(turnItemV2)
});

export type HelmProject = z.output<typeof projectSchema>;
export type HelmModelSelection = z.output<typeof modelSelectionSchema>;
export type HelmQuestion = z.output<typeof questionSchema>;
export interface HelmUserInput { requestId: string; createdAt: string; questions: HelmQuestion[] }
export interface HelmApproval { requestId: string; createdAt: string; kind: string; detail: string | null; appName: string | null }

/** Ход в модели ядра: id запуска «Штурвала» и его состояние, сведённое к running, completed, interrupted, error. */
export interface HelmTurn { turnId: string; state: string; assistantMessageId: string | null }
export interface HelmThreadShell {
  id: string;
  projectId: string;
  title: string;
  /** Состояние «Штурвала» как есть: idle, preparing, queued, starting, running, waiting, completed, interrupted, failed… */
  status: string;
  latestTurn: HelmTurn | null;
  session: { status: string; lastError: string | null } | null;
  updatedAt: string;
  archivedAt: string | null;
  settled: boolean;
  /** Отложен до этого времени (в будущем), иначе null. */
  snoozedUntil: string | null;
  /** Тред, от которого этот пошёл (субагент, делегированная задача или ответвление), иначе null. */
  parentThreadId: string | null;
  /** Дочерний тред: «Штурвал» не показывает его в списке, только внутри родителя. */
  child: boolean;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}
export interface HelmShell { projects: HelmProject[]; threads: HelmThreadShell[] }
/** Строка журнала хода: что агент делает (команда, правка файла, поиск). */
export interface HelmActivity { id: string; kind: string; summary: string }
export interface HelmMessage { id: string; role: string; text: string; turnId: string | null; streaming: boolean }
export interface HelmRequests {
  userInputs: HelmUserInput[];
  approvals: HelmApproval[];
  /** Последний вопрос агента уже закрыт (ответили в окне «Штурвала» или отменили). */
  lastInputClosed: boolean;
}
export interface HelmThread {
  id: string;
  title: string;
  latestTurn: HelmTurn | null;
  session: { status: string; lastError: string | null } | null;
  /** Идущий запуск: его останавливает `run.interrupt`. */
  activeRunId: string | null;
  messages: HelmMessage[];
  activities: HelmActivity[];
  requests: HelmRequests;
}

/** Ошибка с кодом в `name`: его видят задание (`Task.error`) и модель, подробностей нет. */
export class HelmError extends Error {
  readonly status: number | null;
  constructor(code: 'helm_offline' | 'helm_unauthorized' | 'helm_incompatible' | 'helm_not_found' | 'helm_rejected' | 'helm_error', status: number | null = null) {
    super(`helm: ${code}`);
    this.name = code;
    this.status = status;
  }
}

/** Итог проверки сервера при старте ядра и перед командами. */
export type HelmCheck = { ok: true; version: string } | { ok: false; version: string | null; reason: string };

/** Запуск с веткой ждёт, пока «Штурвал» создаст worktree; «Узел» держит вызов до 50 с, ядро ждёт его до 60 с. */
const LAUNCH_TIMEOUT_MS = 55_000;

const ACTIVE_RUN = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
/** Заявки, которых владелец не решает: обновление токенов и инструменты клиента. */
const SILENT_REQUESTS = new Set(['auth_refresh', 'dynamic_tool_call']);
/** Элементы хода без строки журнала: реплики, размышления, вопросы и разрешения (о них говорят заметки). */
const QUIET_ITEMS = new Set(['user_message', 'assistant_message', 'reasoning', 'user_input_request', 'approval_request', 'checkpoint', 'notification', 'proposed_plan']);

/** Состояние запуска в словах модели ядра (как ходы T3 0.0.42). */
export function turnState(status: string): string {
  if (ACTIVE_RUN.has(status)) return 'running';
  if (status === 'completed' || status === 'idle') return 'completed';
  if (status === 'failed') return 'error';
  return 'interrupted';
}

export class HelmClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #rpc: RpcTransport;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  /** Когда сервер последний раз прошёл проверку версии: не чаще раза в минуту. */
  #checkedAt = 0;

  constructor(options: HelmOptions) {
    this.#base = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#rpc = options.rpc ?? new HelmRpc({ url: this.#base, token: this.#token }).call;
    this.#timeoutMs = options.timeoutMs ?? 8000;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  get url(): string { return this.#base; }

  /** Новый UUID для треда: исполнитель пишет его в задание до запуска (docs/task-sync.md, 7). */
  newThreadId(): string { return this.#newId(); }

  /** Версия сервера и совместимость с проверенной линией; сеть и токен не бросают, а дают причину. */
  async check(signal: AbortSignal = AbortSignal.timeout(this.#timeoutMs)): Promise<HelmCheck> {
    let raw: unknown;
    try { raw = await this.#request('GET', '/.well-known/t3/environment', signal); }
    catch (error) { return { ok: false, version: null, reason: error instanceof Error ? error.name : 'helm_error' }; }
    const parsed = environmentSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, version: null, reason: 'helm_incompatible' };
    const { serverVersion: version, orchestrationProtocolVersion: protocol = 1 } = parsed.data;
    const major = Number(version.split('.')[0]);
    if (major !== HELM_SUPPORTED.major || protocol !== HELM_SUPPORTED.protocol) return { ok: false, version, reason: 'helm_incompatible' };
    return { ok: true, version };
  }

  /** Проекты и живые треды (архивные «Штурвал» отдаёт отдельным списком, ядру они не нужны). */
  async shell(signal: AbortSignal): Promise<HelmShell> {
    const data = parse(shellV2, await this.#request('GET', '/api/orchestration/shell', signal));
    return { projects: data.projects, threads: data.threads.map(shellThread) };
  }

  /**
   * Снимок треда: все запуски и заявки, сообщения и элементы хода за последнее окно (`/bounded`, а не вся история:
   * исполнитель опрашивает тред раз в 2,5 с).
   */
  async thread(threadId: string, signal: AbortSignal): Promise<HelmThread> {
    const data = await this.#request('GET', `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, signal);
    return threadView(parse(projectionV2, (data as { projection?: unknown } | null)?.projection));
  }

  /**
   * Проект для папки: существующий по `workspaceRoot` или новый (`project.create`, папка создаётся при нужде).
   * `model`: модель нового проекта (с 26.09.2026 Opus 5.5), чтобы и в окне он открывался на ней; модель
   * существующего проекта не трогается. Команда только после проверки версии.
   */
  async ensureProject(workspaceRoot: string, title: string, signal: AbortSignal, model: HelmModelSelection | null = null): Promise<HelmProject> {
    const root = trimSlash(workspaceRoot);
    const found = (await this.shell(signal)).projects.find(p => trimSlash(p.workspaceRoot) === root);
    if (found) return found;
    await this.#ensureCompatible(signal);
    const projectId = this.#newId();
    await this.#request('POST', '/api/projects/mutate', signal, {
      type: 'project.create', commandId: this.#newId(), projectId, title, workspaceRoot: root, createWorkspaceRootIfMissing: true,
      ...(model ? { defaultModelSelection: model } : {})
    });
    return { id: projectId, title, workspaceRoot: root, defaultModelSelection: model };
  }

  /**
   * Новый тред с первым сообщением одним вызовом `orchestration.launchThread`. С `branch` «Штурвал» сам создаёт
   * git worktree от текущего HEAD проекта (`workspaceStrategy: worktree`), иначе тред работает в папке проекта.
   */
  async startThread(input: {
    projectId: string; title: string; text: string; modelSelection: { instanceId: string; model: string }; runtimeMode: HelmRuntimeMode;
    /** Ветка отдельного worktree (`wave/<id задания>`); null — папка проекта. */
    branch?: string | null;
    /** Id, заранее записанный в задание (`newThreadId`); без него новый. */
    threadId?: string;
    /** `plan`: агент сначала предлагает план (Helm MCP, mcp/tools.ts); по умолчанию обычный режим. */
    interactionMode?: 'default' | 'plan';
  }, signal: AbortSignal): Promise<{ threadId: string }> {
    await this.#ensureCompatible(signal);
    const threadId = input.threadId ?? this.#newId();
    await this.#call('orchestration.launchThread', {
      commandId: this.#newId(), creationSource: AUTHOR.creationSource, threadId, projectId: input.projectId, title: input.title,
      modelSelection: input.modelSelection, runtimeMode: input.runtimeMode, interactionMode: input.interactionMode ?? 'default',
      workspaceStrategy: input.branch ? { type: 'worktree', baseRef: 'HEAD', branch: input.branch } : { type: 'root' },
      initialMessage: { messageId: this.#newId(), text: input.text, attachments: [] }
    }, signal, LAUNCH_TIMEOUT_MS);
    return { threadId };
  }

  /**
   * Сообщение в существующий тред: идёт в идущий запуск (steer) или начинает новый; тратит токены владельца.
   * Куда именно, решает «Штурвал» под своей блокировкой треда (`deliveryIntent: steer`).
   */
  async sendMessage(threadId: string, text: string, signal: AbortSignal): Promise<{ messageId: string }> {
    const messageId = this.#newId();
    await this.dispatch({
      type: 'message.dispatch', ...AUTHOR, threadId, messageId, text, attachments: [],
      deliveryIntent: 'steer', dispatchMode: { type: 'start_immediately' }
    }, signal);
    return { messageId };
  }

  /** Остановить идущий запуск. Без проверки версии: остановка нужна и тогда, когда остальное запрещено. */
  async interrupt(threadId: string, signal: AbortSignal): Promise<number> {
    const { activeRunId } = await this.thread(threadId, signal);
    if (!activeRunId) return 0;
    return this.dispatch({ type: 'run.interrupt', threadId, runId: activeRunId }, signal, { skipCheck: true });
  }

  /** Ответ на вопрос агента: `answers` по id вопроса — строка (вариант или свой текст) или массив при нескольких выборах. */
  answerUserInput(threadId: string, requestId: string, answers: Record<string, string | string[]>, signal: AbortSignal): Promise<number> {
    return this.dispatch({ type: 'runtime-request.respond', threadId, requestId, answers }, signal);
  }

  /** Разобрать тред (settle) или вернуть его в активные. Работу не трогает, только место в списке «Штурвала». */
  setSettled(threadId: string, settled: boolean, signal: AbortSignal): Promise<number> {
    return this.dispatch(settled ? { type: 'thread.settle', threadId } : { type: 'thread.unsettle', threadId, reason: 'user' }, signal);
  }

  /** Отложить тред до `until` (ISO) или разбудить сейчас (null). */
  snooze(threadId: string, until: string | null, signal: AbortSignal): Promise<number> {
    return this.dispatch(until ? { type: 'thread.snooze', threadId, snoozedUntil: until } : { type: 'thread.unsnooze', threadId, reason: 'user' }, signal);
  }

  /** Команда оркестрации; `commandId` добавляется здесь. Ответ сервера — номер события. */
  async dispatch(command: Record<string, unknown> & { type: string }, signal: AbortSignal, options: { skipCheck?: boolean } = {}): Promise<number> {
    if (!options.skipCheck) await this.#ensureCompatible(signal);
    const data = await this.#call('orchestration.dispatchCommand', { ...command, commandId: this.#newId() }, signal);
    const sequence = (data as { sequence?: unknown } | null)?.sequence;
    return typeof sequence === 'number' ? sequence : 0;
  }

  async #ensureCompatible(signal: AbortSignal): Promise<void> {
    if (Date.now() - this.#checkedAt < 60_000) return;
    const checked = await this.check(signal);
    if (!checked.ok) throw new HelmError(checked.reason === 'helm_offline' || checked.reason === 'helm_unauthorized' ? checked.reason : 'helm_incompatible');
    this.#checkedAt = Date.now();
  }

  async #call(method: string, payload: unknown, signal: AbortSignal, timeoutMs = Math.max(this.#timeoutMs, 15_000)): Promise<unknown> {
    try {
      return await this.#rpc(method, payload, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw rpcFailure(error);
    }
  }

  async #request(method: 'GET' | 'POST', path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method, signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
        headers: { Authorization: `Bearer ${this.#token}`, ...PROTOCOL_HEADER, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      // Отмена задания пробрасывается как есть: исполнитель отличает её от сбоя сети.
      if (signal.aborted) throw signal.reason;
      throw new HelmError('helm_offline');
    }
    let data: unknown = null;
    try { data = await response.json(); } catch { /* пустое тело */ }
    if (response.status === 401 || response.status === 403) throw new HelmError('helm_unauthorized', response.status);
    if (response.status === 404) throw new HelmError('helm_not_found', 404);
    // Отказ сервера (неверная команда, инвариант треда): 400 и 422; 5xx — сбой сервера.
    if (response.status === 400 || response.status === 422) throw new HelmError('helm_rejected', response.status);
    if (!response.ok) throw new HelmError('helm_error', response.status);
    return data;
  }
}

/** Ошибка RPC в код HelmError. Через «Узел» она приходит строкой: `helm_offline`, `helm_fail:<тег>`, `helm_die`. */
function rpcFailure(error: unknown): HelmError {
  const kind = error instanceof HelmRpcError ? error.kind : error instanceof Error ? error.message.replace(/^relay: /, '') : '';
  const tag = error instanceof HelmRpcError ? error.tag ?? '' : kind.split(':')[1] ?? '';
  // `t3_offline` — старое имя кода в «Узле» (relay/src/ops.ts), он уже стоит на Mac.
  if (/^(offline|timeout|helm_offline|relay_offline|relay_timeout|t3_offline)/.test(kind)) return new HelmError('helm_offline');
  if (/unauthori[sz]ed|auth/i.test(tag) || kind === 'helm_unauthorized') return new HelmError('helm_unauthorized');
  if (/NotFound/.test(tag)) return new HelmError('helm_not_found');
  if (kind === 'fail' || kind.startsWith('helm_fail')) return new HelmError('helm_rejected');
  return new HelmError('helm_error');
}

/** Дочерние треды по id, даже без lineage (старый «Штурвал»): субагенты провайдера и делегированные задачи. */
const CHILD_ID = /^thread:(provider|delegated-task):/;

function shellThread(thread: z.output<typeof threadShellV2>): HelmThreadShell {
  const request = thread.pendingRuntimeRequest && !SILENT_REQUESTS.has(thread.pendingRuntimeRequest.kind) ? thread.pendingRuntimeRequest : null;
  return {
    id: thread.id, projectId: thread.projectId, title: thread.title, status: thread.status, updatedAt: thread.updatedAt, archivedAt: thread.archivedAt,
    settled: thread.settledAt !== null && thread.settledOverride !== 'active',
    snoozedUntil: thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now() ? thread.snoozedUntil : null,
    parentThreadId: thread.lineage?.parentThreadId ?? null,
    child: thread.lineage?.relationshipToParent === 'subagent' || CHILD_ID.test(thread.id),
    latestTurn: thread.latestRunId ? { turnId: thread.latestRunId, state: turnState(thread.status), assistantMessageId: null } : null,
    session: thread.lastError ? { status: 'error', lastError: thread.lastError } : null,
    hasPendingUserInput: request?.kind === 'user_input',
    hasPendingApprovals: Boolean(request && request.kind !== 'user_input')
  };
}

function threadView(projection: z.output<typeof projectionV2>): HelmThread {
  const runs = [...projection.runs].sort((a, b) => a.ordinal - b.ordinal);
  const last = runs.at(-1);
  const active = runs.findLast(run => ACTIVE_RUN.has(run.status));
  const items = projection.turnItems;
  const activities = items.filter(item => !QUIET_ITEMS.has(item.type)).map(item => ({ id: item.id, kind: item.type, summary: itemSummary(item) }));
  return {
    id: projection.thread.id, title: projection.thread.title,
    latestTurn: last ? { turnId: last.id, state: turnState(last.status), assistantMessageId: null } : null,
    session: null,
    activeRunId: active?.id ?? null,
    messages: projection.messages.map(m => ({ id: m.id, role: m.role, text: m.text, turnId: m.runId, streaming: m.streaming })),
    activities,
    requests: requestsOf(projection.runtimeRequests, items)
  };
}

/** Строка журнала по элементу хода: заголовок, иначе команда, файл или вид действия. */
function itemSummary(item: z.output<typeof turnItemV2>): string {
  if (item.title?.trim()) return item.title.trim();
  if (item.type === 'command_execution' && item.input) return `команда: ${item.input.slice(0, 200)}`;
  if (item.type === 'file_change' && item.fileName) return `правка файла ${item.fileName}`;
  return item.type.replace(/_/g, ' ');
}

/**
 * Открытые вопросы и разрешения по заявкам `runtimeRequests` (только `pending`), текст — из элементов хода
 * `user_input_request` и `approval_request` с тем же `requestId`. Вопрос без текста в окне снимка пропускается.
 */
function requestsOf(requests: z.output<typeof runtimeRequestV2>[], items: z.output<typeof turnItemV2>[]): HelmRequests {
  const byRequest = new Map(items.filter(i => i.requestId).map(i => [i.requestId!, i]));
  const userInputs: HelmUserInput[] = [];
  const approvals: HelmApproval[] = [];
  for (const request of requests) {
    if (request.status !== 'pending' || SILENT_REQUESTS.has(request.kind)) continue;
    const item = byRequest.get(request.id);
    if (request.kind === 'user_input') {
      const questions = (item?.questions ?? []).flatMap(q => {
        const parsed = questionSchema.safeParse(q);
        return parsed.success && (parsed.data.options.length || parsed.data.allowCustomAnswer !== false) ? [parsed.data] : [];
      });
      if (questions.length) userInputs.push({ requestId: request.id, createdAt: request.createdAt, questions });
      continue;
    }
    approvals.push({
      requestId: request.id, createdAt: request.createdAt, kind: item?.requestKind ?? request.kind,
      detail: item?.prompt?.trim() || null, appName: item?.appName?.trim() || null
    });
  }
  const byTime = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);
  const lastInput = requests.filter(r => r.kind === 'user_input').sort(byTime).at(-1);
  return { userInputs: userInputs.sort(byTime), approvals: approvals.sort(byTime), lastInputClosed: Boolean(lastInput && lastInput.status !== 'pending') };
}

/** Открытые вопросы и разрешения треда. */
export function pendingRequests(thread: Pick<HelmThread, 'requests'>): { userInputs: HelmUserInput[]; approvals: HelmApproval[] } {
  return { userInputs: thread.requests.userInputs, approvals: thread.requests.approvals };
}

/**
 * Последний ответ агента в последнем ходе: сообщение `latestTurn.assistantMessageId`, иначе последнее законченное
 * сообщение ассистента этого хода, иначе последнее вообще. null, если ответа нет.
 */
export function latestAssistantText(thread: Pick<HelmThread, 'latestTurn' | 'messages'>): string | null {
  const assistant = thread.messages.filter(m => m.role === 'assistant' && !m.streaming && m.text.trim());
  const turn = thread.latestTurn;
  const exact = turn?.assistantMessageId ? assistant.find(m => m.id === turn.assistantMessageId) : undefined;
  const inTurn = turn ? assistant.filter(m => m.turnId === turn.turnId).at(-1) : undefined;
  return (exact ?? inTurn ?? assistant.at(-1))?.text.trim() ?? null;
}

/**
 * Ответы для `thread.user-input.respond` по словам пользователя. Совпадение с меткой или значением варианта даёт
 * значение варианта (как у окна T3); иначе свой текст, если вопрос его допускает. При нескольких выборах слова
 * делятся по запятой и «и». null и причина, если ответ не подходит.
 */
export function buildAnswers(questions: readonly HelmQuestion[], replies: readonly string[]): { answers: Record<string, string | string[]> } | { error: string; question: string } {
  const answers: Record<string, string | string[]> = {};
  for (const [index, question] of questions.entries()) {
    const reply = replies[index]?.trim();
    if (!reply) return { error: 'missing_answer', question: question.question };
    const match = (text: string) => {
      const key = normalize(text);
      const option = question.options.find(o => normalize(o.label) === key || (o.value !== undefined && normalize(o.value) === key));
      return option ? option.value ?? option.label : null;
    };
    if (question.multiSelect) {
      const picked = reply.split(/\s*(?:,|;|\sи\s|\sand\s)\s*/i).map(match);
      if (picked.length && picked.every((p): p is string => p !== null)) { answers[question.id] = [...new Set(picked)]; continue; }
    } else {
      const picked = match(reply);
      if (picked !== null) { answers[question.id] = picked; continue; }
    }
    if (question.allowCustomAnswer === false) return { error: 'not_an_option', question: question.question };
    answers[question.id] = reply;
  }
  return { answers };
}

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
const trimSlash = (path: string) => path.length > 1 ? path.replace(/\/+$/, '') : path;

function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HelmError('helm_incompatible');
  return parsed.data;
}
