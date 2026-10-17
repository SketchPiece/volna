import { basename } from 'node:path';
import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import type { TaskStore } from '../tasks/store.ts';
import { buildAnswers, pendingRequests, HelmError, type HelmClient, type HelmRuntimeMode, type HelmShell, type HelmThreadShell } from './client.ts';
import { threadState } from '../work-sync/status.ts';

/**
 * Инструменты «Работы», которые исполнитель в «Штурвале» (helm/client.ts) добавляет к work_start (tasks/tools.ts): `work_answer`
 * отвечает на вопрос агента, `work_add` добавляет слова владельца в идущую работу, `work_threads` и `work_send` — треды
 * агентов на Mac (включаются, когда задан HELM_TOKEN).
 *
 * Steer (с 26.09.2026): сообщение в тред с идущим ходом не прерывает его. С 05.10.2026 («Штурвал», протокол 2) куда
 * его деть, решает сервер (`message.dispatch` с `deliveryIntent: steer`): в идущий запуск или новым, если тот уже
 * кончается. Как и окно «Штурвала», не пишем в идущий ход, пока агент ждёт ответа на вопрос или разрешения.
 * Имена без названия программы (решение владельца 26.09.2026): исполнителя можно заменить, не трогая промпты и техкарты.
 * Новый тред — только через work_start: у него есть прогресс, вопросы и итог. Разрешений агентам здесь нет и не будет:
 * их дают только в «Штурвале» (на Mac или в телефоне).
 */
export interface HelmToolsOptions {
  client: HelmClient;
  /** Задания «Работы»: по ним work_answer находит тред. */
  store?: TaskStore;
  runtimeMode: HelmRuntimeMode;
  /** Отмена задания Волны (TaskRunner.cancel): work_stop в треде идущего задания отменяет само задание. */
  cancelTask?: (id: string) => Promise<boolean>;
  /** Ядро в облаке: на связи ли «Узел» (relay/link.ts). Без него «Штурвал» рядом с ядром, и `helm_offline` значит «Штурвал» не открыт. */
  macOnline?: () => boolean;
}

export function helmTools(options: HelmToolsOptions): Tool[] {
  const { client, store, runtimeMode, cancelTask, macOnline } = options;
  const failure = (error: unknown) => helmFailure(error, macOnline);

  const answer = defineTool({
    name: 'work_answer',
    effect: 'act',
    description: 'Answer a question that the agent doing a piece of work (or any agent thread on the Mac) asked; the core announced it during the call (task, question, options). Put the option label the user chose, or their own words, in answer; when the agent asked several questions at once, use answers, one per question in the same order. Only with the user\'s explicit choice, never choose for them. This never grants permissions: those are given only on the Mac.',
    parameters: z.object({
      id: z.string().nullable().default(null).describe('Task id from the core note or tasks_list, or a thread id from work_threads; null: the only waiting question.'),
      answer: z.string().nullable().default(null).describe('The chosen option label or the user\'s own answer, for a single question.'),
      answers: z.array(z.string().min(1)).nullable().default(null).describe('One answer per question, in the order the agent asked them.')
    }),
    async execute({ id, answer: single, answers }, context) {
      const replies = answers?.length ? answers : single?.trim() ? [single.trim()] : [];
      if (!replies.length) return { error: 'no_answer', hint: 'Ask the user what to answer.' };
      try {
        const target = await questionThread(id?.trim() || null, context.signal);
        if ('error' in target) return target;
        const thread = await client.thread(target.threadId, context.signal);
        const input = pendingRequests(thread).userInputs[0];
        if (!input) return thread.requests.lastInputClosed ? ALREADY_ANSWERED : { error: 'no_question', hint: 'The agent is not waiting for an answer any more.' };
        const built = buildAnswers(input.questions, replies);
        if ('error' in built) {
          return { ...built, hint: 'Ask the user again and pass one answer per question.', questions: input.questions.map(q => ({ question: q.question, options: q.options.map(o => o.label) })) };
        }
        try { await client.answerUserInput(target.threadId, input.requestId, built.answers, context.signal); }
        catch (error) {
          // Двойной ответ (голосом и в окне): сервер отклоняет второй, заявка уже закрыта (docs/task-sync.md, 7).
          if (!(error instanceof HelmError) || error.name !== 'helm_rejected') throw error;
          const fresh = await client.thread(target.threadId, context.signal);
          if (pendingRequests(fresh).userInputs.some(q => q.requestId === input.requestId)) throw error;
          if (target.taskId) await store?.patch(target.taskId, { waiting: null });
          return ALREADY_ANSWERED;
        }
        if (target.taskId) await store?.patch(target.taskId, { waiting: null });
        return { answered: true, task: target.taskId, thread: target.threadId, say: 'Ответ передан, работа продолжается.' };
      } catch (error) { return failure(error); }
    }
  });

  const add = defineTool({
    name: 'work_add',
    effect: 'act',
    description: 'Add the user\'s words to a piece of work that is running now: an extra detail, a correction, a new wish, or their answer to a question you asked about it. The agent gets it at once and goes on without stopping. Pass it right away, no read-back needed. For a question the agent itself asked use work_answer; for other agent threads use work_send.',
    parameters: z.object({
      id: z.string().nullable().default(null).describe('Task id from work_start or tasks_list; null: the only running work.'),
      text: z.string().min(1).describe('What to tell the agent, self-contained, in the user\'s language: the agent does not hear the conversation.')
    }),
    async execute({ id, text }, context) {
      const running = (store?.tasks ?? []).filter(t => t.status === 'running' && t.helmThread);
      const task = id?.trim() ? running.find(t => t.id === id.trim()) : running.length === 1 ? running[0] : undefined;
      if (!task) {
        return running.length > 1 && !id?.trim()
          ? { error: 'which_work', hint: 'Several pieces of work are running: ask the user which one, then call again with its id.', running: running.map(t => ({ id: t.id, title: t.title })) }
          : { error: 'not_running', hint: 'No such work is running now: if it has finished, offer new work.' };
      }
      try {
        const shell = await client.shell(context.signal);
        const thread = shell.threads.find(t => t.id === task.helmThread);
        if (!thread) return { error: 'helm_thread_lost', hint: 'The thread of this work is gone from Helm.' };
        const blocked = steerBlocked(thread);
        if (blocked) return blocked;
        await client.sendMessage(thread.id, text, context.signal);
        await store?.patch(task.id, { steer: { at: context.now().toISOString(), turnId: thread.latestTurn?.turnId ?? null } });
        return { added: true, task: task.id, title: task.title, say: 'Передал, агент учтёт.' };
      } catch (error) { return failure(error); }
    }
  });

  const list = defineTool({
    name: 'work_threads',
    effect: 'read',
    jev: {
      when: 'The user asks what the agents on the Mac are doing, which threads wait for them, or whether an agent has finished.',
      args: {
        state: {
          instructions: 'Which threads does the user ask about?',
          options: { all: 'All of them or unclear', needs_you: 'Those waiting for the user', working: 'Those still working', idle: 'Those that are idle or finished' }
        }
      },
      fixed: { project: null }
    },
    description: 'List the agent threads on the user\'s Mac (Claude, Codex), including those of started work, with their state: needs_you (a question or a permission waits), working, idle, failed, and the names of all projects. Call when the user asks what the agents are doing, who is waiting, before messaging a thread, or to check a project name.',
    parameters: z.object({
      state: z.enum(['all', 'needs_you', 'working', 'idle']).default('all').describe('Filter by state.'),
      project: z.string().nullable().default(null).describe('Only threads of this project (name or folder name), or null.')
    }),
    async execute({ state, project }, context) {
      try {
        const shell = await client.shell(context.signal);
        const threads = shell.threads.filter(t => !t.archivedAt)
          .filter(t => state === 'all' || threadState(t) === state || (state === 'idle' && threadState(t) === 'failed'))
          .filter(t => !project || projectMatches(shell, t.projectId, project))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return {
          count: threads.length,
          // Проекты отдельно: без них модель искала проект «сайт для мамы» среди названий тредов (звонок 25.09.2026).
          projects: shell.projects.map(p => p.title),
          threads: threads.slice(0, 15).map(t => ({
            id: t.id, title: t.title, project: projectName(shell, t.projectId), state: threadState(t), updatedAt: t.updatedAt,
            waitingFor: t.hasPendingUserInput ? 'question' : t.hasPendingApprovals ? 'permission in Helm (on the Mac or the phone)' : null
          }))
        };
      } catch (error) { return failure(error); }
    }
  });

  const send = defineTool({
    name: 'work_send',
    effect: 'act',
    description: 'Send a message (a prompt or an instruction) into an existing agent thread on the Mac, for example to continue earlier work there. If the agent is working, it gets the message at once without stopping. It spends the user\'s tokens: use only when the user explicitly asks to tell or ask a thread something; read the text and the thread back first and wait for their yes. To answer an agent\'s question use work_answer; to add to work running from this call use work_add.',
    parameters: z.object({
      id: z.string().min(1).describe('Thread id from work_threads, or the thread title.'),
      text: z.string().min(1).describe('Message text, in the language the user dictated it.')
    }),
    async execute({ id: asked, text }, context) {
      try {
        const shell = await client.shell(context.signal);
        const found = resolveThread(shell, asked);
        if ('error' in found) return found;
        const steered = found.thread.latestTurn?.state === 'running';
        if (steered) {
          const blocked = steerBlocked(found.thread);
          if (blocked) return blocked;
        }
        await client.sendMessage(found.thread.id, text, context.signal);
        const owner = store?.tasks.find(t => t.helmThread === found.thread.id && t.status === 'running');
        if (owner) await store?.patch(owner.id, { steer: { at: context.now().toISOString(), turnId: found.thread.latestTurn?.turnId ?? null } });
        return { sent: true, steered: steered || undefined, id: found.thread.id, title: found.thread.title };
      } catch (error) { return failure(error); }
    }
  });

  const stop = defineTool({
    name: 'work_stop',
    effect: 'act',
    description: 'Stop what an agent is doing right now in any agent thread on the Mac, including the user\'s own threads and running work: the current turn is interrupted, the thread and its history stay. Use only when the user explicitly asks to stop it: first say which thread you will stop and wait for their yes. For a piece of work started from a call this cancels the work.',
    parameters: z.object({
      id: z.string().min(1).describe('Task id from tasks_list, thread id from work_threads or tasks_list, or the thread title.')
    }),
    async execute({ id: asked }, context) {
      try {
        const raw = asked.trim();
        const task = store?.tasks.find(t => t.id === raw && t.helmThread);
        const shell = await client.shell(context.signal);
        const found = task ? { thread: shell.threads.find(t => t.id === task.helmThread) } : resolveThread(shell, raw);
        if ('error' in found) return found;
        if (!found.thread) return { error: 'helm_thread_lost', hint: 'The thread of this work is gone from Helm.' };
        const thread = found.thread;
        const owner = store?.tasks.find(t => t.helmThread === thread.id && (t.status === 'running' || t.status === 'queued'));
        if (owner && cancelTask) {
          await cancelTask(owner.id);
          return { stopping: true, task: owner.id, id: thread.id, title: thread.title, say: 'Останавливаю.' };
        }
        const state = threadState(thread);
        if (state !== 'working' && state !== 'needs_you') return { error: 'not_working', id: thread.id, title: thread.title, hint: 'Nothing runs in this thread now.' };
        // Команда статус не меняет: список покажет остановку, когда «Штурвал» отметит ход прерванным.
        await client.interrupt(thread.id, context.signal);
        return { stopping: true, id: thread.id, title: thread.title, say: 'Останавливаю.' };
      } catch (error) { return failure(error); }
    }
  });

  /** Тред, где ждёт вопрос: по заданию, по id треда или единственный ждущий (сначала задания, потом все треды «Штурвала»). */
  async function questionThread(id: string | null, signal: AbortSignal): Promise<{ threadId: string; taskId: string | null } | { error: string; hint: string; waiting?: unknown }> {
    const tasks = store?.tasks ?? [];
    if (id) {
      const task = tasks.find(t => t.id === id);
      if (task?.helmThread) return { threadId: task.helmThread, taskId: task.id };
      if (task) return { error: 'not_a_t3_task', hint: 'This task does not run in Helm.' };
      const owner = tasks.find(t => t.helmThread === id);
      return { threadId: id, taskId: owner?.id ?? null };
    }
    const asking = tasks.filter(t => t.status === 'running' && t.helmThread && t.waiting?.kind === 'question');
    if (asking.length === 1) return { threadId: asking[0]!.helmThread!, taskId: asking[0]!.id };
    const shell = await client.shell(signal);
    const waiting = shell.threads.filter(t => !t.archivedAt && t.hasPendingUserInput);
    if (waiting.length === 1) return { threadId: waiting[0]!.id, taskId: tasks.find(t => t.helmThread === waiting[0]!.id)?.id ?? null };
    return waiting.length
      ? { error: 'which_question', hint: 'Several agents wait for an answer: ask the user which one, then call again with its id.', waiting: waiting.map(t => ({ id: t.id, title: t.title, task: tasks.find(k => k.helmThread === t.id)?.id ?? null })) }
      : { error: 'no_question', hint: 'No agent is waiting for an answer.' };
  }

  const status = defineTool({
    name: 'computer_status',
    effect: 'read',
    jev: { when: 'The user asks whether their computer (the Mac) is connected or reachable, or whether Volna can do work on it right now.' },
    description: 'Check the connection to the user\'s computer (the Mac where work is done): whether it is reachable and ready to take work now. Call when the user asks «компьютер на связи?», «можешь сейчас сделать работу?», «есть подключение к маку?». Say the phrase from say; do not name programs or services.',
    parameters: z.object({}),
    async execute(_args, context) {
      // «Узел» не на связи: отвечаем сразу, не ждём его 20 с, как вызов работы.
      if (macOnline && !macOnline()) return { connected: false, ready: false, say: SAY.macOffline };
      const checked = await client.check(AbortSignal.any([context.signal, AbortSignal.timeout(15_000)])).catch(() => ({ ok: false as const, version: null, reason: 'helm_offline' }));
      if (checked.ok) return { connected: true, ready: true, say: 'Компьютер на связи, работу взять могу.' };
      if (checked.reason === 'helm_offline') {
        // Без «Узла» ядро на том же Mac: закрыта программа. С «Узлом», который пропал за время проверки, — нет связи.
        if (macOnline && !macOnline()) return { connected: false, ready: false, say: SAY.macOffline };
        return { connected: true, ready: false, say: SAY.appClosed };
      }
      return { connected: true, ready: false, say: 'Компьютер на связи, но работу сейчас не возьму: на нём что-то не так с настройкой.' };
    }
  });

  return [answer, add, list, send, stop, status];
}

const ALREADY_ANSWERED = { error: 'already_answered', hint: 'The question was already answered on the computer or in the Helm app; the agent goes on.', say: 'На этот вопрос уже ответили.' };

/** Почему в идущий ход сейчас писать нельзя: агент ждёт ответа на вопрос или разрешения (так держит и окно «Штурвала»). */
function steerBlocked(thread: HelmThreadShell): { error: string; hint: string; id: string } | null {
  if (thread.hasPendingUserInput) return { error: 'agent_asks', id: thread.id, hint: 'The agent waits for an answer to its question: ask the user and answer with work_answer first.' };
  if (thread.hasPendingApprovals) return { error: 'waiting_permission', id: thread.id, hint: 'The agent waits for a permission in Helm (on the Mac or the phone); the message can go once it is given.' };
  return null;
}

/**
 * Тред по id или названию: точный id, точное название, единственное совпадение по подстроке. Результат списка
 * не переживает делегирование, поэтому следующая модель часто передаёт название.
 */
function resolveThread(shell: HelmShell, asked: string): { thread: HelmThreadShell } | { error: string; asked: string; hint: string; threads: unknown[] } {
  const live = shell.threads.filter(t => !t.archivedAt);
  const raw = asked.trim();
  const key = normalize(raw);
  const exact = live.find(t => t.id === raw);
  if (exact) return { thread: exact };
  if (key) {
    const named = live.filter(t => normalize(t.title) === key);
    if (named.length === 1) return { thread: named[0]! };
    const partial = live.filter(t => normalize(t.title).includes(key));
    if (partial.length === 1) return { thread: partial[0]! };
  }
  return {
    error: 'unknown_thread', asked: raw, hint: 'Pick the id from this list and call again; if several fit, ask the user which one.',
    threads: live.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 15).map(t => ({ id: t.id, title: t.title, project: projectName(shell, t.projectId), state: threadState(t) }))
  };
}

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
const projectKeys = (project: { title: string; workspaceRoot: string }) => [normalize(project.title), normalize(basename(project.workspaceRoot))];
const projectName = (shell: HelmShell, id: string) => shell.projects.find(p => p.id === id)?.title ?? null;
const projectMatches = (shell: HelmShell, id: string, asked: string) => {
  const project = shell.projects.find(p => p.id === id);
  return Boolean(project && projectKeys(project).includes(normalize(asked)));
};

/**
 * Ошибка «Штурвала» для модели: код, подсказка и готовая фраза, без подробностей. `helm_offline` в облаке делится на два случая:
 * нет связи с Mac (`mac_offline`: «Узел» не на связи, Mac выключен, спит или без сети) и Mac на связи, но «Штурвал» не открыт.
 */
/** Фразы о связи с компьютером: без названий программ, для владельца это просто подключение к компьютеру (28.09.2026). */
const SAY = {
  macOffline: 'Нет связи с твоим компьютером. Проверь, что он включён, не спит и в сети.',
  appClosed: 'Компьютер на связи, но программа для работы на нём закрыта. Открой её, и можно работать.'
};

export function helmFailure(error: unknown, macOnline?: () => boolean): Record<string, unknown> {
  // Отмена и чужие ошибки идут дальше: реестр ответит модели tool_failed.
  if (!(error instanceof HelmError)) throw error;
  const code = error.name;
  if (code === 'helm_offline' && macOnline && !macOnline()) {
    return {
      error: 'mac_offline',
      hint: 'There is no connection to the user\'s computer, so nothing was started. Say the phrase from say; do not name programs or services.',
      say: 'Не могу: нет связи с твоим компьютером. Проверь, что он включён, не спит и в сети, и попроси ещё раз.'
    };
  }
  const hints: Record<string, string> = {
    helm_offline: 'The computer is connected but the program for work on it is closed: nothing was started. Say the phrase from say; do not name the program.',
    helm_unauthorized: 'The Helm token is not accepted; the owner issues a new one on the Mac.',
    helm_incompatible: 'This Helm version is not supported by the core yet.',
    helm_not_found: 'The thread is gone in Helm.',
    helm_rejected: 'Helm refused the request.'
  };
  const say = code === 'helm_offline' ? 'Не могу: компьютер на связи, но программа для работы на нём закрыта. Открой её и попроси ещё раз.' : undefined;
  return { error: code, hint: hints[code] ?? 'Helm did not answer.', ...(say ? { say } : {}) };
}
