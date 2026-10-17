import type { Logger } from '../log.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import { pendingRequests, HelmError, type HelmClient, type HelmShell, type HelmThreadShell } from '../helm/client.ts';
import { questionText } from '../helm/worker.ts';
import { threadState, threadWaiting } from './status.ts';

/**
 * Один список работы (docs/task-sync.md): задания Волны и собственные треды владельца в «Штурвале» (до 05.10.2026 в T3 Code). Работа идёт только
 * в «Штурвале», здесь её только читают: синхронизация зовёт `shell` и `threads/:id`, команд не шлёт никогда.
 *
 * Реестр в памяти: он целиком собирается из `tasks.json` и снимка `shell`, поэтому отдельного файла у него нет.
 * Источник правды: «Штурвал» для состояния треда, задание Волны для итога и доставки.
 *
 * В лог только id, статусы и коды ошибок: заголовки, вопросы, итоги туда не попадают (тест в sync.test.ts).
 */
export type WorkStatus = 'queued' | 'working' | 'needs_you' | 'idle' | 'done' | 'failed' | 'cancelled' | 'gone';
/** Доступ к «Штурвалу»: `offline` и `incompatible` показывают последнее известное, `unauthorized` останавливает опрос. */
export type WorkAccess = 'unknown' | 'ok' | 'offline' | 'unauthorized' | 'incompatible';

export interface WorkItem {
  /** `helm:<id треда>`; у задания Волны без треда `task:<id задания>`. */
  id: string;
  /** Кто начал: Волна (`work_start`) или владелец сам («Штурвал»). */
  origin: 'volna' | 'owner';
  task: string | null;
  thread: string | null;
  project: { id: string; title: string } | null;
  title: string;
  status: WorkStatus;
  /** Текст вопроса только у заданий Волны: у собственных тредов наружу идёт лишь вид ожидания. */
  waiting: { kind: 'question' | 'approval'; text: string | null } | null;
  /** Фраза хода только у заданий Волны: для собственных тредов её не строим (docs/task-sync.md, 8). */
  progress: string | null;
  /** Короткий итог (≤ 600) только у заданий Волны. */
  result: string | null;
  /** Код ошибки задания, без подробностей. */
  error: string | null;
  updatedAt: string;
  finishedAt: string | null;
  /** «Штурвал» сейчас не отвечает: состояние треда последнее известное. */
  stale: boolean;
}

export interface WorkSyncOptions {
  client: HelmClient;
  /** Задания Волны; без них в списке только треды «Штурвала». */
  tasks?: TaskStore;
  log: Logger;
  /** Заметка в идущие звонки (LiveCalls.announce): вопрос или разрешение в собственном треде владельца. */
  announce?: (note: string) => void;
  /** Идёт ли звонок: тогда опрос чаще и вопросы собственных тредов объявляются. */
  inCall?: () => boolean;
  now?: () => Date;
  /** Опрос, пока идёт звонок или есть работа (`working`, `needs_you`); по умолчанию 10 с. */
  fastMs?: number;
  /** Опрос в остальное время; по умолчанию 60 с. */
  slowMs?: number;
}

const RESULT_CHARS = 600;
const TITLE_CHARS = 120;
/** Сколько заметок о вопросах собственных тредов за один опрос: не заваливать звонок. */
const ANNOUNCE_PER_POLL = 3;

export class WorkSync {
  readonly #options: WorkSyncOptions;
  /** Последний применённый снимок каждого треда: более старый (гонка с опросом helmWorker) не применяется. */
  readonly #threads = new Map<string, HelmThreadShell>();
  #projects: HelmShell['projects'] = [];
  #access: WorkAccess = 'unknown';
  #fetchedAt: string | null = null;
  /** О каких ожиданиях собственных тредов уже сказано в звонке (id треда и запроса). */
  readonly #announced = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;

  constructor(options: WorkSyncOptions) { this.#options = options; }

  get access(): WorkAccess { return this.#access; }
  /** Когда «Штурвал» последний раз ответил; null, если ещё ни разу. */
  get fetchedAt(): string | null { return this.#fetchedAt; }

  start(): void {
    this.#stopped = false;
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #loop(): Promise<void> {
    if (this.#stopped) return;
    await this.poll(AbortSignal.timeout(15_000)).catch(() => {});
    // Без доступа (`helm_unauthorized`) опрос не повторяется: новый токен — это перезапуск ядра.
    if (this.#stopped || this.#access === 'unauthorized') return;
    const { fastMs = 10_000, slowMs = 60_000, inCall = () => false } = this.#options;
    const busy = inCall() || this.items().some(i => i.status === 'working' || i.status === 'needs_you');
    this.#timer = setTimeout(() => void this.#loop(), busy ? fastMs : slowMs);
  }

  /** Один опрос `shell`. Сбой «Штурвала» не бросается: список остаётся прежним и помечается `stale`. */
  async poll(signal: AbortSignal): Promise<void> {
    const { client, log } = this.#options;
    let shell: HelmShell;
    try { shell = await client.shell(signal); }
    catch (error) {
      const code = error instanceof HelmError ? error.name : 'helm_error';
      const access: WorkAccess = code === 'helm_unauthorized' ? 'unauthorized' : code === 'helm_incompatible' ? 'incompatible' : 'offline';
      // Одна строка на смену состояния, а не на каждый опрос.
      if (access !== this.#access) log.warn(`sync.helm.${access}`, { code });
      this.#access = access;
      return;
    }
    if (this.#access !== 'ok' && this.#access !== 'unknown') log.info('sync.helm.online', { threads: shell.threads.length });
    this.#access = 'ok';
    this.#fetchedAt = this.#now().toISOString();
    this.#projects = shell.projects;
    const seen = new Set<string>();
    for (const thread of shell.threads) {
      seen.add(thread.id);
      const known = this.#threads.get(thread.id);
      if (known && known.updatedAt > thread.updatedAt) continue;
      this.#threads.set(thread.id, thread);
    }
    for (const id of [...this.#threads.keys()]) if (!seen.has(id)) this.#threads.delete(id);
    await this.#announceWaiting(signal);
  }

  /** Весь список: задания Волны и неархивные треды, новые сверху. */
  items(): WorkItem[] {
    const tasks = this.#options.tasks?.tasks ?? [];
    const linked = new Set(tasks.flatMap(t => t.helmThread ? [t.helmThread] : []));
    const stale = this.#access !== 'ok';
    const fromTasks = tasks.map(task => this.#taskItem(task, stale));
    const owner = [...this.#threads.values()]
      .filter(t => !t.archivedAt && !linked.has(t.id))
      .map((t): WorkItem => {
        const kind = threadWaiting(t);
        const state = threadState(t);
        return {
          id: `helm:${t.id}`, origin: 'owner', task: null, thread: t.id, project: this.#project(t.projectId), title: t.title.slice(0, TITLE_CHARS),
          status: state, waiting: kind ? { kind, text: null } : null, progress: null, result: null, error: null,
          updatedAt: t.updatedAt, finishedAt: null, stale
        };
      });
    return [...fromTasks, ...owner].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  #taskItem(task: Task, stale: boolean): WorkItem {
    const thread = task.helmThread ? this.#threads.get(task.helmThread) : undefined;
    const live = thread && !thread.archivedAt ? thread : undefined;
    const state = live ? threadState(live) : null;
    let status: WorkStatus;
    if (task.status === 'queued') status = 'queued';
    else if (task.status === 'running') {
      // Пока задание идёт, итог решает helmWorker; здесь только то, что видно в «Штурвале». Пропавший тред — `gone`, если он отвечает.
      status = state === 'needs_you' ? 'needs_you' : state === 'failed' ? 'failed' : live ? 'working'
        : task.helmThread && !task.helmPending && this.#access === 'ok' ? 'gone' : 'working';
    } else {
      // Владелец продолжил законченное задание в том же треде: задание остаётся законченным, запись показывает новый ход.
      status = state === 'working' || state === 'needs_you' ? state : task.status;
    }
    const kind = live ? threadWaiting(live) : null;
    const waiting = task.status === 'running' && task.waiting ? { kind: task.waiting.kind, text: task.waiting.text }
      : status === 'needs_you' && kind ? { kind, text: null } : null;
    const updatedAt = [task.createdAt, task.startedAt, task.progressAt, task.finishedAt, live?.updatedAt].filter((v): v is string => Boolean(v)).sort().at(-1)!;
    return {
      id: task.helmThread ? `helm:${task.helmThread}` : `task:${task.id}`, origin: 'volna', task: task.id, thread: task.helmThread ?? null,
      project: live ? this.#project(live.projectId) : task.helmProject ? this.#project(task.helmProject) : null,
      title: task.title.slice(0, TITLE_CHARS), status, waiting,
      progress: task.status === 'running' ? task.progress : null,
      result: (task.summary ?? task.result)?.slice(0, RESULT_CHARS) ?? null, error: task.error,
      updatedAt, finishedAt: task.finishedAt, stale: stale && Boolean(task.helmThread)
    };
  }

  #project(id: string): { id: string; title: string } | null {
    const project = this.#projects.find(p => p.id === id);
    return project ? { id: project.id, title: project.title } : null;
  }

  /**
   * Вопрос или разрешение в собственном треде владельца — заметкой в идущий звонок, один раз на запрос. Задания Волны
   * объявляет их исполнитель (helm/worker.ts), здесь они пропускаются.
   */
  async #announceWaiting(signal: AbortSignal): Promise<void> {
    const { announce, inCall = () => false, client, log } = this.#options;
    if (!announce || !inCall()) return;
    const running = new Set((this.#options.tasks?.tasks ?? []).flatMap(t => t.status === 'running' && t.helmThread ? [t.helmThread] : []));
    let told = 0;
    for (const shell of this.#threads.values()) {
      if (told >= ANNOUNCE_PER_POLL) break;
      if (shell.archivedAt || running.has(shell.id) || !threadWaiting(shell)) continue;
      let thread;
      try { thread = await client.thread(shell.id, signal); }
      catch { continue; }
      const { userInputs, approvals } = pendingRequests(thread);
      const input = userInputs.find(q => !this.#announced.has(`${shell.id}:${q.requestId}`));
      const approval = input ? undefined : approvals.find(a => !this.#announced.has(`${shell.id}:${a.requestId}`));
      const request = input ?? approval;
      if (!request) continue;
      this.#announced.add(`${shell.id}:${request.requestId}`);
      const project = this.#project(shell.projectId)?.title;
      announce(input ? ownerQuestionNote(shell, project, questionText(input)) : ownerApprovalNote(shell, project));
      log.info('sync.announced', { thread: shell.id, kind: input ? 'question' : 'approval' });
      told++;
    }
  }

  #now(): Date { return (this.#options.now ?? (() => new Date()))(); }
}

/** Законченное и простаивающее видно сутки (docs/task-sync.md, 10: предложение принято по умолчанию). */
const RECENT_MS = 24 * 60 * 60 * 1000;

/** Идущее и ждущее всегда, законченное и простаивающее за сутки (для телефона и tasks_list). */
export function recentWork(items: readonly WorkItem[], now: Date): WorkItem[] {
  const active = (i: WorkItem) => i.status === 'queued' || i.status === 'working' || i.status === 'needs_you';
  return items.filter(i => active(i) || now.getTime() - Date.parse(i.finishedAt ?? i.updatedAt) < RECENT_MS);
}

/** Заметка в звонок: агент в собственном треде владельца спрашивает; ответ голосом через work_answer. */
export function ownerQuestionNote(thread: Pick<HelmThreadShell, 'id' | 'title'>, project: string | undefined, question: string): string {
  return `Агент в собственном треде пользователя «${thread.title}»${project ? ` (проект ${project})` : ''} спрашивает: ${question} Как будет пауза (сейчас, если пользователь молчит), скажи об этом коротко и спроси, что ответить. Ответ передай инструментом work_answer (id треда ${thread.id}); выбирать за пользователя нельзя.`;
}

/** Заметка в звонок: собственный тред ждёт разрешения; голосом его не дать. */
export function ownerApprovalNote(thread: Pick<HelmThreadShell, 'title'>, project: string | undefined): string {
  return `Собственный тред пользователя «${thread.title}»${project ? ` (проект ${project})` : ''} ждёт разрешения. Голосом его дать нельзя, только на компьютере или в приложении «Штурвал» на телефоне. Как будет пауза (сейчас, если пользователь молчит), скажи об этом одной короткой фразой.`;
}
