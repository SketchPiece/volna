import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Фоновые задания (docs/tools-routing.md, шаг 4): Волна запускает долгую работу, разговор идёт дальше, итог приходит
 * звонком Волны или уведомлением. Файл `tasks.json` рядом с памятью, запись атомарная; для одного человека достаточно.
 */
export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
/**
 * Как итог дошёл до пользователя. `pending`: ещё никак (скажем в следующем звонке); `ringing`: Волна звонит;
 * `notified`: ушло уведомление; `heard`: сказано в разговоре.
 */
export const DELIVERIES = ['pending', 'ringing', 'notified', 'heard'] as const;
/**
 * Кто делал задание. С 23.09.2026 все задания `computer`: агент на Mac (с 05.10.2026 в «Штурвале»); `think` (модель
 * заданий на Opus) остался только для чтения старых записей в tasks.json.
 */
export const TASK_KINDS = ['think', 'computer'] as const;

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  kind: z.enum(TASK_KINDS).default('think'),
  /**
   * Как сообщить итог, когда закончатся все задания: `notify` по умолчанию, `call`, если пользователь попросил перезвонить
   * (tasks_call_back). Итоги доставляются одной пачкой (tasks/delivery.ts).
   */
  callback: z.enum(['call', 'notify']).default('notify'),
  status: z.enum(TASK_STATUSES),
  delivery: z.enum(DELIVERIES),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Итог для пересказа голосом; null до завершения. */
  result: z.string().nullable(),
  /** Итог для голоса, одна-три фразы (tasks/summary.ts); у старых записей и без модели нет. */
  summary: z.string().nullable().optional(),
  /** Имя ошибки без подробностей. */
  error: z.string().nullable(),
  /** Что исполнитель делает сейчас: одна фраза от дешёвой модели (tasks/progress.ts); null, пока сводки не было. */
  progress: z.string().nullable().default(null),
  progressAt: z.string().nullable().default(null),
  /** Тред «Штурвала», в котором идёт задание (helm/worker.ts); у старых записей нет. */
  helmThread: z.string().optional(),
  /**
   * Id треда записан, `thread.create` ещё не подтверждён (docs/task-sync.md, 7): ядро сначала пишет id, потом шлёт
   * команду, чтобы сбой между ними не оставил в «Штурвале» тред без задания.
   */
  helmPending: z.boolean().optional(),
  /** Проект «Штурвала», выбранный голосом (helm/projects.ts); без него — проект «Работы» по умолчанию. */
  helmProject: z.string().optional(),
  /** Работа в отдельной ветке проекта (git worktree, helm/worktree.ts). */
  worktree: z.boolean().optional(),
  /**
   * Чего исполнитель ждёт от владельца: вопрос агента (ответ голосом, work_answer) или разрешение (только в окне «Штурвала»).
   * Текст вопроса хранится, как и текст задания; в лог не пишется.
   */
  waiting: z.object({ kind: z.enum(['question', 'approval']), text: z.string() }).nullable().optional(),
  /** Последнее сообщение владельца в идущую работу (work_add, work_send) и ход, в который оно пришло (helm/worker.ts). */
  steer: z.object({ at: z.string(), turnId: z.string().nullable() }).nullable().optional()
});
export type Task = z.infer<typeof taskSchema>;
/** До 07.10.2026 поля «Штурвала» назывались t3Thread, t3Pending, t3Project: старые записи читаются под новыми именами. */
const LEGACY_FIELDS = { t3Thread: 'helmThread', t3Pending: 'helmPending', t3Project: 'helmProject' } as const;
const storedTask = z.preprocess(raw => {
  if (!raw || typeof raw !== 'object') return raw;
  const task: Record<string, unknown> = { ...raw };
  for (const [old, next] of Object.entries(LEGACY_FIELDS)) {
    if (old in task) { if (!(next in task)) task[next] = task[old]; delete task[old]; }
  }
  return task;
}, taskSchema);
const fileSchema = z.object({ tasks: z.array(storedTask) });

/** Сколько законченных заданий хранить: старые удаляются. */
const KEEP = 50;

export interface TaskStoreOptions {
  /**
   * Задание, которое переживает перезапуск ядра: остаётся `running`, и раннер снова берёт его под наблюдение
   * (TaskRunner.resume). Со «Штурвалом» это задания с тредом: работа в «Штурвале» идёт и без ядра. Остальные идущие — `failed/interrupted`.
   */
  resumable?: (task: Task) => boolean;
}

export class TaskStore {
  readonly #dir: string;
  readonly #resumable: (task: Task) => boolean;
  #tasks: Task[] | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  /** Вызывается после каждого созданного или изменённого задания. */
  onChange?: (task: Task) => void;
  readonly #listeners = new Set<(task: Task) => void>();

  constructor(dir: string, options: TaskStoreOptions = {}) {
    this.#dir = dir;
    this.#resumable = options.resumable ?? (() => false);
  }

  /** Ещё один слушатель изменений, кроме `onChange` (музыка ожидания на телефоне будит опрос `/device-tools`). */
  subscribe(listener: (task: Task) => void): void { this.#listeners.add(listener); }

  #changed(task: Task): void {
    this.onChange?.({ ...task });
    for (const listener of this.#listeners) listener({ ...task });
  }

  /** Загрузка; задания, прерванные остановкой ядра, считаются неудавшимися, кроме тех, что можно продолжить. */
  async load(now: Date = new Date()): Promise<Task[]> {
    if (this.#tasks) return this.#tasks;
    await mkdir(this.#dir, { recursive: true });
    try {
      this.#tasks = fileSchema.parse(JSON.parse(await readFile(join(this.#dir, 'tasks.json'), 'utf8'))).tasks;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#tasks = [];
    }
    const interrupted = this.#tasks.filter(t => (t.status === 'queued' || t.status === 'running') && !(t.status === 'running' && this.#resumable(t)));
    for (const task of interrupted) Object.assign(task, { status: 'failed', error: 'interrupted', finishedAt: now.toISOString() });
    if (interrupted.length) await this.#persist();
    return this.#tasks;
  }

  get tasks(): readonly Task[] { return this.#tasks ?? []; }
  /** Задания, которые ещё ждут очереди или идут. */
  get active(): Task[] { return this.tasks.filter(t => t.status === 'queued' || t.status === 'running'); }
  get(id: string): Task | undefined { return this.#tasks?.find(t => t.id === id); }

  /** Последовательное изменение с сохранением. */
  update<T>(mutate: (tasks: Task[]) => T): Promise<T> {
    const run = async () => {
      const tasks = await this.load();
      const result = mutate(tasks);
      const finished = tasks.filter(t => t.finishedAt).sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!));
      for (const old of finished.slice(0, Math.max(0, finished.length - KEEP))) tasks.splice(tasks.indexOf(old), 1);
      await this.#persist();
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  create(input: Pick<Task, 'title' | 'prompt'> & Partial<Pick<Task, 'kind' | 'callback' | 'helmProject' | 'worktree'>>, now: Date = new Date()): Promise<Task> {
    const task: Task = {
      id: randomBytes(8).toString('hex'), kind: 'computer', callback: 'notify', ...input, status: 'queued', delivery: 'pending',
      createdAt: now.toISOString(), startedAt: null, finishedAt: null, result: null, error: null, progress: null, progressAt: null
    };
    return this.update(tasks => { tasks.push(task); return task; }).then(created => { this.#changed(created); return created; });
  }

  patch(id: string, changes: Partial<Task>): Promise<Task | undefined> {
    return this.update(tasks => {
      const task = tasks.find(t => t.id === id);
      if (task) Object.assign(task, changes);
      return task;
    }).then(task => { if (task) this.#changed(task); return task; });
  }

  async #persist(): Promise<void> {
    const target = join(this.#dir, 'tasks.json');
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ tasks: this.#tasks }, null, 2));
    await rename(temp, target);
  }
}
