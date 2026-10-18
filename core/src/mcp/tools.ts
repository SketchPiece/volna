import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildAnswers, HELM_DEFAULT_MODELS, HelmError, type HelmClient, type HelmRuntimeMode, type HelmShell, type HelmThreadShell } from '../helm/client.ts';
import { canonicalJson, sha256, type Signer } from './tokens.ts';

/**
 * Инструменты Helm MCP (docs/helm-mcp.md, 2): Claude владельца видит и ведёт треды «Штурвала». Всё идёт через тот же
 * клиент, что «Работа» (helm/client.ts), а в облаке — через «Узел» и его белый список: новых операций на Mac нет.
 *
 * Два правила, ради которых сервер сделан. Сообщение агенту — дословно словами владельца, без переписывания.
 * Запись — только после явного «да»: первый вызов возвращает превью и код, подписанный по точным аргументам
 * (15 минут, одноразовый), исполняет только повторный вызов с кодом.
 */
export const INSTRUCTIONS = `Helm MCP lets you see and steer the user's Helm app (Штурвал): coding-agent threads running on their computer, grouped by project.

Rules:
1. Relay the user's words, not yours. When a tool takes a "message" for an agent, pass the user's own words for that agent verbatim, in the language they used. Do not rewrite, expand, summarise, translate, fix, add context, add instructions or turn it into a bigger prompt. Only leave out the part addressed to you (e.g. "send to the Volna thread:"). If you are unsure what exactly to send, ask the user instead of composing it.
2. Writes need the user's OK. Write tools (send message, start thread, stop thread, answer question, settle, snooze) first return a preview and a confirmation code. Show the user the preview exactly as returned and ask whether to proceed. Call the tool again with the code only after the user explicitly agrees in their reply. Never confirm on the user's behalf, and never reuse a code for different arguments.
3. Reading is free: use helm_overview first to see what is going on, then helm_read_thread for details. Ask which thread the user means when more than one fits.
4. Unsettled threads are the default. To list threads, use helm_list_unsettled_threads: these still need the user's attention. Use helm_list_threads (all, settled too) only when the user asks about settled, old or all threads, or the thread they mean is not among the unsettled ones.
5. Permission requests of agents (run a command, edit files) cannot be approved here; tell the user to approve them in Helm on the computer or the phone.`;

export interface McpToolsOptions {
  client: HelmClient;
  signer: Signer;
  /** Ядро в облаке: на связи ли «Узел». Без него «Штурвал» рядом с ядром. */
  macOnline?: () => boolean;
  /** Режим разрешений новых тредов, как у «Работы» (`HELM_RUNTIME_MODE`); `full-access` не бывает. */
  runtimeMode: HelmRuntimeMode;
  instance: string;
  model: string | null;
  /** false: подтверждает сам клиент (Claude спрашивает по annotations), двухшагового кода нет. */
  confirmWrites?: boolean;
}

export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface McpTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const CONFIRM_TTL = 15 * 60;
const MAX_MESSAGE_CHARS = 20_000;

const text = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const write = (destructive: boolean) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false });

const confirmation = z.string().max(4096).optional()
  .describe('Leave empty on the first call. Fill only with the code from the preview, after the user explicitly agreed.');

const listInput = z.object({
  projectId: z.string().max(200).optional().describe('Project id from helm_overview or helm_list_projects; omit for all projects.'),
  statuses: z.array(z.enum(['idle', 'preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled'])).optional(),
  titleContains: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
  offset: z.number().int().min(0).optional().describe('nextOffset from the previous page.'),
  includeChildren: z.boolean().optional()
    .describe('Also list child threads (subagents and delegated tasks, which have parentThreadId). Default false: only top-level threads, as in the Helm app.')
});
const unsettledInput = listInput.extend({
  includeSnoozed: z.boolean().optional().describe('Also list snoozed threads (marked with snoozedUntil). Default false, as in the Helm app.')
});

const MAX_SNOOZE_MS = 366 * 24 * 3600_000;

const quote = (value: string) => value.split('\n').map(line => `> ${line}`).join('\n');
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}… [${value.length - max} more chars]` : value;

const compactThread = (thread: HelmThreadShell) => ({
  threadId: thread.id, title: thread.title, status: thread.status, parentThreadId: thread.parentThreadId ?? undefined,
  waitingFor: thread.hasPendingUserInput ? 'answer' : thread.hasPendingApprovals ? 'permission' : undefined,
  settled: thread.settled || undefined, snoozedUntil: thread.snoozedUntil ?? undefined,
  lastError: thread.session?.lastError ?? undefined, updatedAt: thread.updatedAt
});

const newestFirst = (a: HelmThreadShell, b: HelmThreadShell) => b.updatedAt.localeCompare(a.updatedAt);

/** Ошибка «Штурвала» понятными словами для Claude. */
function explain(error: unknown, macOnline?: () => boolean): string {
  const code = error instanceof HelmError ? error.name : error instanceof Error && /^relay_/.test(error.name) ? 'helm_offline' : 'helm_error';
  if (code === 'helm_offline') {
    return macOnline && !macOnline()
      ? 'The user\'s computer is not connected (asleep, off or offline). Nothing was read or sent.'
      : 'The computer is connected but Helm is not running on it. Nothing was read or sent.';
  }
  return ({
    helm_not_found: 'No such thread or project in Helm.',
    helm_rejected: 'Helm refused the command (for example the thread or question is no longer in that state). Nothing changed.',
    helm_unauthorized: 'Helm rejected the core\'s access token; the owner has to renew it on the computer.',
    helm_incompatible: 'Helm runs a version this server does not know; commands are blocked to stay safe.'
  } as Record<string, string>)[code] ?? 'Helm did not answer properly. Try again later.';
}

export function mcpTools(options: McpToolsOptions): McpTool[] {
  const { client, signer, macOnline, confirmWrites = true } = options;
  const shell = (signal: AbortSignal) => client.shell(signal);

  /** Тред для превью; нет треда или нет связи — превью не будет, и спрашивать владельца не о чем. */
  const threadLabel = async (threadId: string, signal: AbortSignal) => {
    const found = (await shell(signal)).threads.find(t => t.id === threadId);
    if (!found) throw new HelmError('helm_not_found');
    return `"${found.title}" (${found.status})`;
  };

  /**
   * Запись в два шага. `describe` строит превью (и проверяет, что действие возможно), `act` исполняет; `once` —
   * id подтверждения, по нему повтор того же кода не исполнит действие второй раз.
   */
  const confirmed = (
    name: string,
    describe: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
    act: (args: Record<string, unknown>, signal: AbortSignal, once: string) => Promise<ToolResult>
  ) => async ({ confirmation: code, ...args }: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> => {
    const hash = sha256(`${name}:${canonicalJson(args)}`);
    if (!confirmWrites) return act(args, signal, randomUUID());
    if (!code) {
      const preview = await describe(args, signal);
      const token = signer.sign('confirm', { h: hash, jti: randomUUID() }, CONFIRM_TTL);
      return text(`NOT DONE YET. Show the user this preview exactly and ask whether to go ahead:\n\n${preview}\n\n`
        + `Only if the user explicitly agrees in their reply, call ${name} again with exactly the same arguments plus confirmation="${token}". `
        + `If they want changes, call ${name} again without confirmation to get a new preview. The code expires in 15 minutes.`);
    }
    const payload = signer.verify('confirm', code);
    if (!payload) return failure('The confirmation code is invalid or expired. Call again without confirmation for a fresh preview.');
    if (payload.h !== hash) return failure('The arguments differ from the previewed ones. Call again without confirmation, show the new preview and ask the user.');
    if (!signer.consumeOnce(`confirm:${payload.jti}`, payload.exp)) return failure('This confirmation code was already used; nothing was done again.');
    return act(args, signal, String(payload.jti));
  };

  /**
   * Страница списка тредов без архива; какие треды берутся, решает `keep` (все или только неразобранные). Дочерние
   * треды (субагенты, делегированные задачи) — только по `includeChildren`: в списке «Штурвала» их тоже нет.
   */
  const listThreads = async (args: Record<string, unknown>, signal: AbortSignal, keep: (thread: HelmThreadShell) => boolean): Promise<ToolResult> => {
    const { projectId, statuses, titleContains, limit = 20, offset = 0, includeChildren = false } = args as { projectId?: string; statuses?: string[]; titleContains?: string; limit?: number; offset?: number; includeChildren?: boolean };
    const { projects, threads } = await shell(signal);
    const needle = titleContains?.toLowerCase();
    const matching = threads.filter(t => !t.archivedAt && (includeChildren || !t.child) && keep(t) && (!projectId || t.projectId === projectId) && (!statuses?.length || statuses.includes(t.status))
      && (!needle || t.title.toLowerCase().includes(needle))).sort(newestFirst);
    const page = matching.slice(offset, offset + limit);
    const projectTitle = (id: string) => projects.find(p => p.id === id)?.title;
    return text({
      threads: page.map(t => ({ ...compactThread(t), project: projectId ? undefined : projectTitle(t.projectId) })),
      total: matching.length, nextOffset: offset + limit < matching.length ? offset + limit : undefined
    });
  };

  const tools: McpTool[] = [
    {
      name: 'helm_overview',
      title: 'Helm overview',
      description: 'What is going on in Helm right now: whether the computer is reachable, and every active thread (preparing, queued, starting, running, or waiting for the user) grouped by project. Start here.',
      input: z.object({}),
      annotations: READ,
      async run(_args, signal) {
        if (macOnline && !macOnline()) return text({ computer: 'offline', note: 'The user\'s computer is not connected; nothing can be read or sent right now.' });
        const { projects, threads } = await shell(signal);
        const active = threads.filter(t => !t.archivedAt && (ACTIVE.has(t.status) || t.hasPendingUserInput || t.hasPendingApprovals)).sort(newestFirst);
        const groups = projects.map(p => ({ projectId: p.id, project: p.title, activeThreads: active.filter(t => t.projectId === p.id).map(compactThread) }));
        return text({
          computer: 'online',
          projects: groups.filter(g => g.activeThreads.length > 0),
          projectsWithoutActiveWork: groups.filter(g => g.activeThreads.length === 0).map(g => g.project)
        });
      }
    },
    {
      name: 'helm_list_projects',
      title: 'List projects',
      description: 'List Helm projects with their ids, folders and how many threads each has.',
      input: z.object({}),
      annotations: READ,
      async run(_args, signal) {
        const { projects, threads } = await shell(signal);
        return text(projects.map(p => ({ projectId: p.id, title: p.title, folder: p.workspaceRoot, threads: threads.filter(t => t.projectId === p.id && !t.archivedAt).length })));
      }
    },
    {
      name: 'helm_list_unsettled_threads',
      title: 'List unsettled threads',
      description: 'Default thread list: exactly what the Helm app shows as unsettled. Top-level threads not yet settled (not marked as dealt with) and not snoozed, newest first: in one project or across all. This is what still needs the user\'s attention. Filter by status or title; includeSnoozed and includeChildren add snoozed and child threads. Archived threads are not listed.',
      input: unsettledInput,
      annotations: READ,
      run: (args, signal) => listThreads(args, signal, t => !t.settled && (args.includeSnoozed === true || !t.snoozedUntil))
    },
    {
      name: 'helm_list_threads',
      title: 'List all threads',
      description: 'List all top-level threads, settled, unsettled and snoozed, newest first: in one project or across all. Filter by status or title; includeChildren adds child threads (subagents, delegated tasks). Archived threads are not listed. Use only when settled threads are needed too; by default use helm_list_unsettled_threads.',
      input: listInput,
      annotations: READ,
      run: (args, signal) => listThreads(args, signal, () => true)
    },
    {
      name: 'helm_search_threads',
      title: 'Search threads',
      description: 'Find threads by words in their titles across all projects (thread content is not searched; read a thread for that).',
      input: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }),
      annotations: READ,
      async run(args, signal) {
        const { query, limit = 20 } = args as { query: string; limit?: number };
        const { projects, threads } = await shell(signal);
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const found = threads.filter(t => !t.archivedAt && words.every(w => t.title.toLowerCase().includes(w))).sort(newestFirst).slice(0, limit);
        return text(found.map(t => ({ ...compactThread(t), project: projects.find(p => p.id === t.projectId)?.title })));
      }
    },
    {
      name: 'helm_read_thread',
      title: 'Read thread',
      description: 'Read a thread: its state, the latest messages (user and agent), what the agent did lately (commands, file edits), and pending questions or permission requests. Covers the recent part of the thread.',
      input: z.object({
        threadId: z.string().min(1).max(200),
        latest: z.number().int().min(1).max(50).optional().describe('How many of the latest messages to return (default 10).'),
        maxCharsPerMessage: z.number().int().min(200).max(50_000).optional().describe('Default 4000.')
      }),
      annotations: READ,
      async run(args, signal) {
        const { threadId, latest = 10, maxCharsPerMessage = 4000 } = args as { threadId: string; latest?: number; maxCharsPerMessage?: number };
        const [thread, overview] = await Promise.all([client.thread(threadId, signal), shell(signal).catch(() => null as HelmShell | null)]);
        const listed = overview?.threads.find(t => t.id === threadId);
        return text({
          thread: {
            threadId: thread.id, title: thread.title, status: listed?.status ?? thread.latestTurn?.state ?? 'idle',
            project: listed ? overview?.projects.find(p => p.id === listed.projectId)?.title : undefined,
            running: Boolean(thread.activeRunId), lastError: listed?.session?.lastError ?? undefined
          },
          messages: thread.messages.slice(-latest).map(m => ({ role: m.role, text: clip(m.text, maxCharsPerMessage), streaming: m.streaming || undefined })),
          recentActivity: thread.activities.slice(-15).map(a => clip(a.summary, 300)),
          questions: thread.requests.userInputs,
          permissionRequests: thread.requests.approvals.map(a => ({ kind: a.kind, detail: a.detail, app: a.appName, note: 'Approve in Helm on the computer or phone.' }))
        });
      }
    },
    {
      name: 'helm_list_questions',
      title: 'List questions',
      description: 'Questions a thread\'s agent is waiting for the user to answer, with their options, so they can be answered with helm_answer_question. Permission requests are listed separately and cannot be answered here.',
      input: z.object({ threadId: z.string().min(1).max(200) }),
      annotations: READ,
      async run(args, signal) {
        const thread = await client.thread((args as { threadId: string }).threadId, signal);
        return text({
          questions: thread.requests.userInputs.map(input => ({
            requestId: input.requestId, askedAt: input.createdAt,
            questions: input.questions.map(q => ({ question: q.question, header: q.header || undefined, options: q.options.map(o => o.label), multiSelect: q.multiSelect || undefined, customAnswerAllowed: q.allowCustomAnswer !== false }))
          })),
          permissionRequests: thread.requests.approvals.length
        });
      }
    },
    {
      name: 'helm_send_message',
      title: 'Send message to thread',
      description: 'Send the user\'s message to a thread\'s agent: it joins the running turn or starts a new one. The message must be the user\'s own words, verbatim and in their language: no rewriting, expanding, translating or added instructions. Asks for confirmation first (see the server instructions).',
      input: z.object({
        threadId: z.string().min(1).max(200),
        message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('The user\'s words for the agent, verbatim.'),
        confirmation
      }),
      annotations: write(false),
      run: confirmed('helm_send_message',
        async (args, signal) => `Send to thread ${await threadLabel(String(args.threadId), signal)}:\n${quote(String(args.message))}`,
        async (args, signal) => {
          await client.sendMessage(String(args.threadId), String(args.message), signal);
          return text('Sent.');
        })
    },
    {
      name: 'helm_start_thread',
      title: 'Start new thread',
      description: 'Start a new thread in a project with the user\'s task. The message must be the user\'s own words, verbatim and in their language. The title may be a short label you choose. Uses the project\'s default model and runs in the project folder. Asks for confirmation first.',
      input: z.object({
        projectId: z.string().min(1).max(200),
        title: z.string().min(1).max(120),
        message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('The user\'s task for the agent, verbatim.'),
        planMode: z.boolean().optional().describe('Start in plan mode: the agent proposes a plan before changing anything.'),
        confirmation
      }),
      annotations: write(false),
      run: confirmed('helm_start_thread',
        async (args, signal) => {
          const project = (await shell(signal)).projects.find(p => p.id === args.projectId);
          if (!project) throw new HelmError('helm_not_found');
          return `Start a new thread "${args.title}" in project "${project.title}"${args.planMode ? ' in plan mode' : ''} with the task:\n${quote(String(args.message))}`;
        },
        async (args, signal) => {
          const project = (await shell(signal)).projects.find(p => p.id === args.projectId);
          if (!project) throw new HelmError('helm_not_found');
          const model = project.defaultModelSelection ?? { instanceId: options.instance, model: options.model ?? HELM_DEFAULT_MODELS[options.instance] ?? '' };
          if (!model.model) return failure('The project has no default model in Helm; set one there first.');
          const { threadId } = await client.startThread({
            projectId: project.id, title: String(args.title), text: String(args.message), modelSelection: model,
            runtimeMode: options.runtimeMode, branch: null, interactionMode: args.planMode ? 'plan' : 'default'
          }, signal);
          return text({ started: true, threadId });
        })
    },
    {
      name: 'helm_interrupt_thread',
      title: 'Stop thread',
      description: 'Stop the running turn in a thread. Asks for confirmation first.',
      input: z.object({ threadId: z.string().min(1).max(200), confirmation }),
      annotations: write(true),
      run: confirmed('helm_interrupt_thread',
        async (args, signal) => `Stop the running work in thread ${await threadLabel(String(args.threadId), signal)}.`,
        async (args, signal) => text((await client.interrupt(String(args.threadId), signal)) ? 'Stopped.' : 'Nothing was running in this thread.'))
    },
    {
      name: 'helm_answer_question',
      title: 'Answer agent question',
      description: 'Answer a pending question from a thread\'s agent with the user\'s choice or words. Read it first with helm_list_questions. answers holds one answer per question, in order: an option label or the user\'s own words (several options separated by commas when multiSelect). Asks for confirmation first.',
      input: z.object({
        threadId: z.string().min(1).max(200),
        requestId: z.string().min(1).max(200),
        answers: z.array(z.string().min(1).max(MAX_MESSAGE_CHARS)).min(1).max(20).describe('The user\'s answers, one per question, verbatim.'),
        confirmation
      }),
      annotations: write(false),
      run: confirmed('helm_answer_question',
        async (args, signal) => {
          const { input, answers } = await prepareAnswers(args, signal);
          const lines = input.questions.map(q => `${q.question}\n${quote(formatAnswer(answers[q.id]))}`);
          return `Answer in thread ${await threadLabel(String(args.threadId), signal)}:\n\n${lines.join('\n\n')}`;
        },
        async (args, signal) => {
          const { answers } = await prepareAnswers(args, signal);
          await client.answerUserInput(String(args.threadId), String(args.requestId), answers, signal);
          return text('Answered.');
        })
    },
    {
      name: 'helm_settle_thread',
      title: 'Settle thread',
      description: 'Settle a thread: mark it as dealt with, so Helm moves it out of the active list. settled=false brings a settled thread back. Does not stop or change the agent\'s work. Asks for confirmation first.',
      input: z.object({
        threadId: z.string().min(1).max(200),
        settled: z.boolean().optional().describe('Default true; false to bring the thread back to active.'),
        confirmation
      }),
      annotations: write(false),
      run: confirmed('helm_settle_thread',
        async (args, signal) => `${args.settled === false ? 'Bring back to active' : 'Settle'} thread ${await threadLabel(String(args.threadId), signal)}.`,
        async (args, signal) => {
          await client.setSettled(String(args.threadId), args.settled !== false, signal);
          return text(args.settled === false ? 'Back in active.' : 'Settled.');
        })
    },
    {
      name: 'helm_snooze_thread',
      title: 'Snooze thread',
      description: 'Snooze a thread until a time: Helm hides it from the list and brings it back then. Give until as an ISO 8601 date-time with the user\'s UTC offset (e.g. 2026-10-16T09:00:00-07:00). Omit until to wake a snoozed thread now. Does not stop or change the agent\'s work. Asks for confirmation first.',
      input: z.object({
        threadId: z.string().min(1).max(200),
        until: z.iso.datetime({ offset: true }).optional().describe('When the thread comes back, with UTC offset; omit to wake it now.'),
        confirmation
      }),
      annotations: write(false),
      run: confirmed('helm_snooze_thread',
        async (args, signal) => {
          const until = snoozeUntil(args.until);
          return until ? `Snooze thread ${await threadLabel(String(args.threadId), signal)} until ${args.until}.` : `Wake thread ${await threadLabel(String(args.threadId), signal)} now.`;
        },
        async (args, signal) => {
          const until = snoozeUntil(args.until);
          await client.snooze(String(args.threadId), until, signal);
          return text(until ? `Snoozed until ${args.until}.` : 'Woken.');
        })
    }
  ];

  /** Ответы по словам владельца в форме «Штурвала» (значение варианта или свой текст); бросает, если не подходят. */
  async function prepareAnswers(args: Record<string, unknown>, signal: AbortSignal) {
    const thread = await client.thread(String(args.threadId), signal);
    const input = thread.requests.userInputs.find(i => i.requestId === args.requestId);
    if (!input) throw new ToolError('This question is no longer pending (answered, cancelled, or a wrong requestId). Check helm_list_questions.');
    const built = buildAnswers(input.questions, args.answers as string[]);
    if ('error' in built) {
      throw new ToolError(built.error === 'missing_answer'
        ? `Missing an answer for: ${built.question}`
        : `"${built.question}" accepts only its options; ask the user to pick one.`);
    }
    return { input, answers: built.answers };
  }

  // Ошибки «Штурвала» и проверок отдаются Claude текстом с isError, а не обрывом протокола.
  return tools.map(tool => ({
    ...tool,
    async run(args, signal) {
      try { return await tool.run(args, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        return failure(error instanceof ToolError ? error.message : explain(error, macOnline));
      }
    }
  }));
}

class ToolError extends Error {}

/** Время, до которого отложить, в UTC; бросает, если оно в прошлом или дальше года. */
function snoozeUntil(value: unknown): string | null {
  if (value === undefined) return null;
  const at = Date.parse(String(value));
  if (!(at > Date.now())) throw new ToolError('until must be in the future.');
  if (at - Date.now() > MAX_SNOOZE_MS) throw new ToolError('until must be within a year.');
  return new Date(at).toISOString();
}

const formatAnswer = (answer: string | string[] | undefined) => Array.isArray(answer) ? answer.join(', ') : answer ?? '';
