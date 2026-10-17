import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import type { TaskRunner } from './runner.ts';
import type { TaskStore } from './store.ts';
import type { ProjectPick } from '../helm/projects.ts';
import { HelmError } from '../helm/client.ts';
import { helmFailure } from '../helm/tools.ts';
import { isRepository as gitRepository } from '../helm/worktree.ts';
import { recentWork, type WorkSync } from '../work-sync/sync.ts';

/**
 * Инструменты «Работы» (tasks/runner.ts): задания делает агент в «Штурвале» (helm/worker.ts). Запуск тратит токены, поэтому `act`.
 * Как сообщить итог, при запуске не спрашивается: когда закончатся все задания, приходит одно уведомление
 * (tasks/delivery.ts); перезвон только по просьбе пользователя через tasks_call_back.
 */
export interface WorkToolsOptions {
  /** Со «Штурвалом»: проект по словам пользователя, по умолчанию «Волна: Работа» (helm/projects.ts). */
  pickProject?: (asked: string | null, create: boolean, signal: AbortSignal) => Promise<ProjectPick>;
  /** Можно ли дать проекту отдельную ветку (git worktree); по умолчанию git на этом Mac. */
  isRepository?: (dir: string, signal: AbortSignal) => Promise<boolean>;
  /** Один список работы (docs/task-sync.md): tasks_list добавляет собственные треды владельца в «Штурвале». */
  work?: WorkSync;
  /** Ядро в облаке: на связи ли «Узел»; без связи work_start отвечает `mac_offline` с фразой (helm/tools.ts, helmFailure). */
  macOnline?: () => boolean;
  now?: () => Date;
}

const startParameters = z.object({
  title: z.string().min(2).max(80).describe('Two to five words naming the task, in the user\'s language.'),
  task: z.string().min(5).max(4000).describe('The task, compact and self-contained, in the user\'s language: what to find or do, where, what to report, with every detail the user named. Say what, not how: no steps or method. The agent does not hear the conversation.'),
  callback: z.enum(['call', 'notify']).optional().describe('call only when the user asked Volna to phone back; omit otherwise.')
});
const projectParameters = startParameters.extend({
  project: z.string().nullable().default(null).describe('Project the work belongs to, by name or folder, when the user named one; null for the default work project.'),
  newProject: z.boolean().default(false).describe('True only when the user asked for a new project with this name.'),
  worktree: z.boolean().default(false).describe('True when the user asks to do it in a separate branch or worktree of the project (a git repository).')
});

export function workTools(runner: TaskRunner, store: TaskStore, options: WorkToolsOptions = {}): Tool[] {
  const { pickProject, isRepository = gitRepository, work, macOnline, now = () => new Date() } = options;
  const start = pickProject ? defineTool({
    name: 'work_start',
    effect: 'act',
    startsWork: true,
    description: AGENT_START,
    parameters: projectParameters,
    async execute({ title, task, callback = 'notify', project, newProject, worktree }, context) {
      let picked: ProjectPick;
      // Mac или «Штурвал» недоступны: Волна говорит, что именно проверить, а не безликое tool_failed.
      try { picked = await pickProject(project, newProject, context.signal); }
      catch (error) { if (error instanceof HelmError) return helmFailure(error, macOnline); throw error; }
      if ('error' in picked) return picked;
      let repository = false;
      // В облаке git проверяет «Узел» на Mac: пропала связь — та же фраза, что и без Mac.
      if (worktree) {
        try { repository = await isRepository(picked.project.workspaceRoot, context.signal); }
        catch (error) { if (context.signal.aborted) throw error; return helmFailure(new HelmError('helm_offline'), macOnline); }
      }
      if (worktree && !repository) {
        return { error: 'not_a_repository', project: picked.project.title, hint: 'This project is not a git repository, so there is no separate branch: offer to do it in the project itself.' };
      }
      const started = await runner.start({ title, prompt: task, callback, helmProject: picked.project.id, worktree: worktree || undefined });
      return { started: true, id: started.id, title, project: picked.project.title, createdProject: picked.created || undefined, worktree: worktree || undefined, callback, say: callback === 'call' ? 'Принято. Как всё будет готово, перезвоню.' : 'Принято, работаю.' };
    }
  }) : defineTool({
    name: 'work_start',
    effect: 'act',
    // С 25.09.2026 задание — большая работа: модель предлагает его через offer_work, ядро запускает после «да» (delegation/client.ts).
    startsWork: true,
    description: AGENT_START,
    parameters: startParameters,
    async execute({ title, task, callback = 'notify' }) {
      const started = await runner.start({ title, prompt: task, callback });
      return { started: true, id: started.id, title, callback, say: callback === 'call' ? 'Принято. Как всё будет готово, перезвоню.' : 'Принято, работаю.' };
    }
  });

  const list = defineTool({
    name: 'tasks_list',
    effect: 'read',
    jev: { when: 'The user asks about background tasks Volna was doing for them, or about their own work in Helm, the agent app on their computer: whether one is done, what it found, what is still running, what waits for them.' },
    description: 'Recent background tasks with their state (queued, running, done, failed, cancelled) and results; with Helm also the user\'s own agent threads there (threads: working, needs_you, idle, failed), without their content. Call when the user asks how a task is going, what it found, or what their work is doing. If helm is present, Helm did not answer: say the list is as of asOf.',
    parameters: z.object({}),
    async execute() {
      const recent = store.tasks.slice(-10).reverse();
      // Итог, который бэкенд сейчас перескажет, считается услышанным: в следующем звонке он не всплывёт.
      for (const task of recent) if (task.result && task.delivery !== 'heard') await store.patch(task.id, { delivery: 'heard' });
      return {
        count: recent.length,
        tasks: recent.map(t => ({
          id: t.id, title: t.title, status: t.status, callback: t.callback, createdAt: t.createdAt, finishedAt: t.finishedAt,
          // Ход работы только у идущих: у законченных есть итог.
          progress: t.status === 'running' ? t.progress : null, progressAt: t.status === 'running' ? t.progressAt : null,
          // Вопрос агента ждёт ответа голосом (work_answer); разрешение — только в окне «Штурвала».
          waiting: t.status === 'running' ? t.waiting ?? null : null,
          summary: t.summary ?? null, result: t.result?.slice(0, 800) ?? null
        })),
        // Собственные треды владельца: только заголовок, проект, состояние и вид ожидания (docs/task-sync.md, 8).
        ...(work ? {
          threads: recentWork(work.items().filter(i => i.origin === 'owner'), now()).slice(0, 8)
            .map(i => ({ id: i.thread, title: i.title, project: i.project?.title ?? null, status: i.status, waiting: i.waiting?.kind ?? null })),
          helm: work.access === 'ok' ? undefined : { access: work.access, asOf: work.fetchedAt }
        } : {})
      };
    }
  });

  const callBack = defineTool({
    name: 'tasks_call_back',
    effect: 'write',
    description: 'Volna will phone the user once, when all running background tasks are finished, instead of sending a notification. Call only when the user asks to be called back, for example when saying goodbye («перезвони, как всё будет готово»); then end_call in the same reply unless they add a new request or question: asking for a call back ends the conversation.',
    parameters: z.object({}),
    async execute() {
      const waiting = store.tasks.filter(t => t.status === 'queued' || t.status === 'running' || ((t.status === 'done' || t.status === 'failed') && t.delivery === 'pending'));
      if (!store.active.length) return { callBack: false, reason: 'nothing_running', say: 'Сейчас ничего не выполняется, перезванивать не по чему.' };
      for (const task of waiting) await store.patch(task.id, { callback: 'call' });
      return { callBack: true, running: store.active.length, say: 'Договорились, перезвоню, когда всё будет готово.' };
    }
  });

  const cancel = defineTool({
    name: 'task_cancel',
    effect: 'write',
    description: 'Cancel a queued or running background task. Only when the user asks to stop it; take the id from tasks_list.',
    parameters: z.object({ id: z.string().min(1).describe('Task id from tasks_list.') }),
    async execute({ id }) {
      return (await runner.cancel(id)) ? { cancelled: true, id } : { cancelled: false, id, reason: 'not_running' };
    }
  });

  return [start, list, cancel, callBack];
}

/**
 * work_start, когда «Работу» делает агент на Mac (с HELM_TOKEN — в «Штурвале», helm/worker.ts): одна работа и для кода,
 * и для остального (решение владельца 26.09.2026). Приложений Mac и кнопки на телефоне там нет, вопросы агента Волна
 * задаёт в разговоре, разрешения даются только на Mac.
 */
const AGENT_START = 'Give a piece of work to the agent on the user\'s Mac, running in the background: anything done on a computer — programming in a project, files and folders, research on the internet, documents and data, a plan, an analysis, a script. In a project the user named, pass project; a new project only on the user\'s request (newProject), it becomes a new empty folder; without a project the work goes to the default work folder. worktree: a separate git branch of the project, only when the user asks. Follow it with tasks_list, stop it with task_cancel. If the agent asks the user something, the core announces it; answer with work_answer. Permissions the agent asks for are given only on the Mac, never by voice. The task goes to the agent exactly as you write it: do not give it tasks that enter passwords, pay or send messages for the user. Deleting is allowed only for files or folders the user named, inside the project; never delete whole projects or anything outside them. Do not ask how to report the result: one notification comes when all tasks are finished.';
