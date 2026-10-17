import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import type { ProjectPick } from '../helm/projects.ts';
import { HelmError } from '../helm/client.ts';
import { helmFailure } from '../helm/tools.ts';
import { spokenTime } from '../callbacks/time.ts';
import type { ScheduleStore } from './store.ts';
import type { ScheduleScheduler } from './scheduler.ts';
import { WEEKDAYS, nextRun, spokenRule } from './recurrence.ts';

export interface ScheduleToolsOptions {
  /** Проект «Работы» по словам пользователя (helm/projects.ts), только существующий. */
  pickProject?: (asked: string, signal: AbortSignal) => Promise<ProjectPick>;
  macOnline?: () => boolean;
  /** Есть ли перезвоны (ключ APNs): без них расписаний `call` нет. */
  canCall: boolean;
}

/** Больше — уже не расписание, а шум; лишнее пользователь удалит голосом. */
const MAX_SCHEDULES = 20;

/**
 * Повторяющиеся задания (schedules/scheduler.ts). Создание — большая работа (`startsWork`): модель предлагает его через
 * offer_work, Волна спрашивает «<план>. Сделать?», ядро записывает после «да» (delegation/client.ts).
 */
export function scheduleTools(store: ScheduleStore, scheduler: ScheduleScheduler, options: ScheduleToolsOptions): Tool[] {
  const { pickProject, macOnline, canCall } = options;
  const create = defineTool({
    name: 'schedule_create',
    effect: 'act',
    startsWork: true,
    description: `Make something repeat on a schedule: every day or on given weekdays at a set time. kind work: at that time the agent on the user's Mac does the task (like work_start) and the result comes as usual («каждое утро в восемь собирай сводку новостей по ИИ», «по пятницам в шесть проверяй, что изменилось в проекте»).${canCall ? ' kind call: at that time Volna phones the user and reminds them by voice («каждый день в девять звони и напоминай про таблетки»).' : ''} Only for repeating requests; a one-time call at a time is callback_schedule, work right now is work_start. For a one-off silent reminder use create_reminder.`,
    parameters: z.object({
      kind: z.enum(canCall ? ['work', 'call'] : ['work']).describe('work: the agent does the task each time; call: Volna phones and reminds.'),
      title: z.string().min(2).max(60).describe('Two to five words naming it, in the user\'s language.'),
      task: z.string().min(3).max(3000).describe('work: the task for the agent, compact and self-contained, as for work_start, with every detail the user named; the agent does not hear the conversation and runs it anew each time. call: what to remind about, only as the user said it.'),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('Local time of the user, HH:MM, 24-hour.'),
      days: z.array(z.enum(WEEKDAYS)).max(7).default([]).describe('Weekdays it repeats on; empty for every day; «по будням» is mon, tue, wed, thu, fri.'),
      callback: z.enum(['call', 'notify']).optional().describe('work only: call when the user asked Volna to phone with the result each time; omit otherwise.'),
      project: z.string().nullable().default(null).describe('work only: an existing project the work belongs to, when the user named one; null for the default work folder.'),
      worktree: z.boolean().default(false).describe('work only: a separate git branch of the project, only when the user asks.')
    }),
    // «Да, и ещё…» ядро дописывает к task при согласии (delegation/client.ts): работе это нужно, напоминанию звонком нет.
    async execute({ kind, title, task, time, days, callback = 'notify', project, worktree }, context) {
      if (store.all.length >= MAX_SCHEDULES) return { error: 'too_many', hint: 'Too many schedules: tell the user and offer to delete old ones from schedules_list.' };
      let helmProject: string | undefined;
      let projectTitle: string | undefined;
      if (kind === 'work' && project?.trim() && pickProject) {
        let picked: ProjectPick;
        try { picked = await pickProject(project, context.signal); }
        catch (error) { if (error instanceof HelmError) return helmFailure(error, macOnline); throw error; }
        if ('error' in picked) return picked;
        helmProject = picked.project.id;
        projectTitle = picked.project.title;
      }
      const now = context.now();
      const rule = { time, days: [...new Set(days)] };
      const nextAt = nextRun(rule, now, context.timeZone);
      const item = await store.create({
        kind, title, prompt: (kind === 'call' ? task.split('\n\nПри согласии')[0]! : task).trim(), ...rule, nextAt: nextAt.toISOString(),
        ...(kind === 'work' ? { callback, helmProject, worktree: worktree || undefined } : {})
      }, now);
      scheduler.arm();
      const when = spokenRule(item);
      const first = spokenDay(nextAt, now, context.timeZone);
      return { scheduled: true, id: item.id, kind, title, when, first, project: projectTitle, say: `Договорились: ${when}. Первый раз ${first}.` };
    }
  });

  const list = defineTool({
    name: 'schedules_list',
    effect: 'read',
    jev: { when: 'The user asks what Volna does for them regularly on a schedule: repeating tasks, daily or weekly reports, repeating reminder calls.' },
    description: 'Repeating tasks and reminder calls on a schedule: what, when it repeats, when next, how the last run went. Call when the user asks what runs regularly or wants to change or delete a schedule.',
    parameters: z.object({}),
    async execute(_args, context) {
      const now = context.now();
      return {
        count: store.all.length,
        schedules: store.all.map(s => ({
          id: s.id, kind: s.kind, title: s.title, task: s.prompt.slice(0, 300), when: spokenRule(s),
          next: spokenDay(new Date(s.nextAt), now, context.timeZone), callback: s.kind === 'work' ? s.callback : undefined,
          lastRun: s.lastRunAt, lastOutcome: s.lastOutcome
        }))
      };
    }
  });

  const remove = defineTool({
    name: 'schedule_delete',
    effect: 'write',
    description: 'Delete a repeating task or reminder call so it no longer runs. Only when the user asks; take the id from schedules_list. To change a schedule, delete it and offer a new one. Work already started by it keeps going: stop that with task_cancel.',
    parameters: z.object({ id: z.string().min(1).describe('Schedule id from schedules_list.') }),
    async execute({ id }) {
      const removed = await store.remove(id);
      if (!removed) return { deleted: false, id, reason: 'not_found' };
      scheduler.arm();
      return { deleted: true, id, title: removed.title, say: `Готово, «${removed.title}» больше не повторяется.` };
    }
  });

  return [create, list, remove];
}

/** «сегодня в 08:00», «завтра в 08:00», «9 октября в 18:00»: у расписания «в 08:00» без дня звучит как «каждый раз». */
function spokenDay(at: Date, now: Date, timeZone: string): string {
  const spoken = spokenTime(at, now, timeZone);
  return spoken.startsWith('в ') ? `сегодня ${spoken}` : spoken;
}
