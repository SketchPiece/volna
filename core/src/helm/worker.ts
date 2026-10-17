import type { Task, TaskStore } from '../tasks/store.ts';
import type { TaskWorker } from '../tasks/runner.ts';
import {
  latestAssistantText, pendingRequests, HELM_DEFAULT_MODELS, HelmError,
  type HelmApproval, type HelmClient, type HelmRuntimeMode, type HelmUserInput
} from './client.ts';

/**
 * Исполнитель «Работы» (с 25.09.2026 в T3 Code, с 05.10.2026 в «Штурвале»; HELM_TOKEN или RELAY_TOKEN): каждое задание —
 * новый тред в проекте для папки `projectDir`, агент и модель из настроек. Ядро опрашивает тред, пока запуск не кончится;
 * итог — последний ответ агента. Отмена задания останавливает запуск (`run.interrupt`), тред остаётся.
 *
 * Вопросы агента (заявки `user_input`) приходят заметкой в идущий звонок, ответ голосом идёт через work_answer.
 * Разрешения голосом не даются никогда: владелец отвечает в «Штурвале» (на Mac или в телефоне), Волна только говорит,
 * что работа ждёт.
 */
export interface HelmWorkerOptions {
  client: HelmClient;
  /** Хранилище заданий: сюда пишутся тред «Штурвала» и то, чего исполнитель ждёт (`waiting`). */
  store: TaskStore;
  /** Папка проекта «Штурвала» для «Работы»; проект находится по `workspaceRoot` или создаётся. */
  projectDir: string;
  projectTitle?: string;
  /** Инстанс провайдера в «Штурвале» (`claudeAgent`, `codex` или свой из настроек «Штурвала»). */
  instance: string;
  /** Модель; null — модель проекта для того же инстанса, иначе встроенная по умолчанию. */
  model: string | null;
  runtimeMode: HelmRuntimeMode;
  /** Заметка модели во всех идущих звонках (LiveCalls.announce). */
  announce?: (content: string) => void;
  pollMs?: number;
  /**
   * Сколько ждать после хода, в который владелец дописал (steer): Codex может начать для сообщения новый ход, и итог
   * первого хода был бы без него. Начался новый ход — ждём его, нет — итог прежний.
   */
  steerGraceMs?: number;
  /** Сколько опросов подряд без ответа сервера терпим, прежде чем считать задание потерянным. */
  maxMisses?: number;
  /** Сколько терпеть тред без новых активностей, сообщений и смены хода (`helm_stalled`); по умолчанию 20 минут. */
  stallMs?: number;
}

export function helmWorker(options: HelmWorkerOptions): TaskWorker {
  const { client, store, projectDir, projectTitle = 'Волна: Работа', instance, runtimeMode, announce, pollMs = 2500, maxMisses = 5, steerGraceMs = 8000, stallMs = 20 * 60_000 } = options;
  return async (task, signal, note = () => {}) => {
    // Задание с тредом шло до перезапуска ядра (TaskRunner.resume): работа в «Штурвале» продолжалась, начинать её заново нельзя.
    let pending = Boolean(task.helmPending);
    let threadId = task.helmThread;
    if (threadId) {
      note('наблюдение за работой продолжено после перезапуска ядра');
    } else {
      // Проект, выбранный голосом при запуске (helm/projects.ts); иначе проект «Работы» по умолчанию.
      const chosen = task.helmProject ? (await client.shell(signal)).projects.find(p => p.id === task.helmProject) : undefined;
      if (task.helmProject && !chosen) throw failure('helm_project_lost');
      const project = chosen ?? await client.ensureProject(projectDir, projectTitle, signal, newProjectModel(instance, options.model));
      const fallback = project.defaultModelSelection?.instanceId === instance ? project.defaultModelSelection.model : HELM_DEFAULT_MODELS[instance];
      const model = options.model ?? fallback;
      if (!model) throw failure('helm_no_model');
      // Ветка wave/<id задания>: имя уникально, по нему видно, откуда работа. Worktree создаёт сам «Штурвал».
      const branch = task.worktree ? `wave/${task.id}` : null;
      // Сначала id в задание, потом команда: сбой между ними не оставит треда без задания (docs/task-sync.md, 7).
      threadId = client.newThreadId();
      pending = true;
      await store.patch(task.id, { helmThread: threadId, helmPending: true });
      await client.startThread({
        projectId: project.id, title: task.title, text: task.prompt, modelSelection: { instanceId: instance, model }, runtimeMode, branch, threadId
      }, signal).catch(error => {
        // Отказ запуска с веткой — чаще всего git (не репозиторий, занятая ветка).
        if (branch && error instanceof HelmError && error.name === 'helm_rejected') throw failure('worktree_failed');
        throw error;
      });
      pending = false;
      await store.patch(task.id, { helmPending: undefined });
      note(branch ? `задание ушло агенту, ветка ${branch}` : 'задание ушло агенту');
    }
    const seen = new Set<string>();
    const announced = new Set<string>();
    let waitingKey: string | null = null;
    let misses = 0;
    let graceSince: number | null = null;
    // Когда в треде последний раз что-то менялось: без перемен дольше stallMs задание считается зависшим.
    let fingerprint = '';
    let changedAt = Date.now();
    try {
      for (;;) {
        await sleep(pollMs, signal);
        let thread;
        try { thread = await client.thread(threadId, signal); }
        catch (error) {
          if (signal.aborted) throw error;
          // «Штурвал» закрыли или перезапускают: несколько промахов терпим, потом задание потеряно. Треда, чей запуск
          // не подтвердился до перезапуска ядра, нет: задание прервано.
          const lost = error instanceof HelmError && error.name === 'helm_not_found';
          if (++misses >= maxMisses) throw failure(lost && pending ? 'interrupted' : lost ? 'helm_thread_lost' : 'helm_lost');
          continue;
        }
        misses = 0;
        if (pending) { pending = false; await store.patch(task.id, { helmPending: undefined }); }
        for (const activity of thread.activities) {
          if (seen.has(activity.id)) continue;
          seen.add(activity.id);
          note(activity.summary);
        }
        for (const message of thread.messages) {
          if (message.role !== 'assistant' || message.streaming || seen.has(message.id)) continue;
          seen.add(message.id);
          if (message.text.trim()) note(message.text.trim().slice(0, 300));
        }
        const { userInputs, approvals } = pendingRequests(thread);
        for (const input of userInputs) {
          if (announced.has(input.requestId)) continue;
          announced.add(input.requestId);
          note('агент спрашивает владельца и ждёт ответа');
          announce?.(questionNote(task, input));
        }
        for (const approval of approvals) {
          if (announced.has(approval.requestId)) continue;
          announced.add(approval.requestId);
          note('агент ждёт разрешения в «Штурвале»');
          announce?.(approvalNote(task, approval));
        }
        const waiting = userInputs[0] ? { kind: 'question' as const, text: questionText(userInputs[0]) }
          : approvals[0] ? { kind: 'approval' as const, text: approvalLabel(approvals[0]) } : null;
        const key = waiting ? `${waiting.kind}:${userInputs[0]?.requestId ?? approvals[0]?.requestId}` : null;
        if (key !== waitingKey) { waitingKey = key; await store.patch(task.id, { waiting }); }
        const turn = thread.latestTurn;
        const last = thread.messages.at(-1);
        const now = `${turn?.turnId}:${turn?.state}:${thread.activities.length}:${thread.activities.at(-1)?.id}:${thread.messages.length}:${last?.text.length}`;
        // Ожидание владельца (вопрос, разрешение) зависанием не считается: он может ответить и через час.
        if (now !== fingerprint || waiting) { fingerprint = now; changedAt = Date.now(); }
        else if (Date.now() - changedAt > stallMs) {
          // Зависший ход останавливаем: задание закрыто, агент не должен работать дальше без присмотра.
          void client.interrupt(threadId, AbortSignal.timeout(5000)).catch(() => {});
          throw failure('helm_stalled');
        }
        if (!turn) {
          if (thread.session?.status === 'error') throw failure('helm_session_error');
          continue;
        }
        // Вопрос с ответом сообщением может остаться открытым и после хода: ждём ответа, итог будет в следующем ходе.
        if (turn.state === 'running' || userInputs.length) { graceSince = null; continue; }
        if (turn.state === 'completed') {
          const steer = store.get(task.id)?.steer;
          if (steer && (steer.turnId === null || steer.turnId === turn.turnId)) {
            graceSince ??= Date.now();
            if (Date.now() - graceSince < steerGraceMs) continue;
          }
          return latestAssistantText(thread) ?? 'Работа закончена, но итога нет.';
        }
        if (turn.state === 'interrupted') throw failure('helm_interrupted');
        if (turn.state === 'error') throw failure('helm_turn_error');
      }
    } finally {
      if (waitingKey) void store.patch(task.id, { waiting: null });
      if (signal.aborted) void client.interrupt(threadId, AbortSignal.timeout(5000)).catch(() => {});
    }
  };
}

/** Модель нового проекта: `HELM_MODEL` или модель сервера по умолчанию для инстанса (Opus 5.5 у Claude); null — модель «Штурвала». */
export function newProjectModel(instance: string, model: string | null): { instanceId: string; model: string } | null {
  const chosen = model ?? HELM_DEFAULT_MODELS[instance];
  return chosen ? { instanceId: instance, model: chosen } : null;
}

/** Вопрос агента одной строкой: текст и варианты. */
export function questionText(input: Pick<HelmUserInput, 'questions'>): string {
  return input.questions.map(q => {
    const options = q.options.map(o => o.label);
    return options.length ? `${q.question} Варианты: ${options.join('; ')}.` : q.question;
  }).join(' ');
}

/** Заметка в звонок: агент задания спрашивает; ответить можно голосом через work_answer. */
export function questionNote(task: Pick<Task, 'id' | 'title'>, input: Pick<HelmUserInput, 'questions'>): string {
  return `Агент по заданию «${task.title}» спрашивает: ${questionText(input)} Как будет пауза (сейчас, если пользователь молчит), задай ему этот вопрос коротко, своими словами. Ответ пользователя передай инструментом work_answer (id задания ${task.id}); выбирать за пользователя нельзя.`;
}

/** Заметка в звонок: задание ждёт разрешения. Голосом его не дать: только в «Штурвале» на Mac или в телефоне. */
export function approvalNote(task: Pick<Task, 'title'>, approval: HelmApproval): string {
  return `Задание «${task.title}» ждёт разрешения: ${approvalLabel(approval)}. Голосом его дать нельзя, только на компьютере или в приложении «Штурвал» на телефоне. Как будет пауза (сейчас, если пользователь молчит), скажи об этом одной короткой фразой.`;
}

function approvalLabel(approval: Pick<HelmApproval, 'kind' | 'appName'>): string {
  switch (approval.kind) {
    case 'command': return 'выполнить команду';
    case 'file-read': return 'прочитать файлы';
    case 'file-change': return 'изменить файлы';
    case 'mcp-elicitation': return approval.appName ? `доступ к приложению ${approval.appName}` : 'доступ к приложению';
    default: return approval.appName ? `доступ к ${approval.appName}` : 'действие агента';
  }
}

function failure(name: string): Error {
  return Object.assign(new Error(`helm task: ${name}`), { name });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}
