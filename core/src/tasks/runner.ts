import type { Logger } from '../log.ts';
import type { Task, TaskStore } from './store.ts';
import type { ProgressSink } from './progress.ts';

/** Исполнитель задания: итог для пересказа; `note` пишет журнал хода для сводок (tasks/progress.ts). */
export type TaskWorker = (task: Task, signal: AbortSignal, note: (line: string) => void) => Promise<string>;

export interface TaskRunnerOptions {
  store: TaskStore;
  /**
   * Кто делает «Работу»: с 26.09.2026 только агент на Mac, с 05.10.2026 в «Штурвале» (helm/worker.ts, docs/task-sync.md). Исполнитель видит
   * `task.helmThread` у задания, продолженного после перезапуска ядра, и не начинает работу заново.
   */
  worker: TaskWorker;
  log: Logger;
  /** Итог готов (или задание не удалось): доставка решает, звонить, слать уведомление или сказать в звонке. */
  onFinished: (task: Task) => void | Promise<void>;
  /** Задание отменено: доставка проверяет, не пора ли сообщить об остальных. */
  onCancelled?: (task: Task) => void | Promise<void>;
  /** Журнал хода работы для сводок (tasks/progress.ts). */
  progress?: ProgressSink;
  concurrency?: number;
  /** Предел задания от `startedAt`: у продолженного после перезапуска остаётся только остаток. */
  timeoutMs?: number;
  now?: () => Date;
}

const RESULT_CHARS = 2000;

/**
 * Очередь фоновых заданий: не больше `concurrency` одновременно, каждое не дольше `timeoutMs`.
 * Отмена останавливает исполнителя. Текст заданий и итогов в лог не пишется.
 */
export class TaskRunner {
  readonly #options: TaskRunnerOptions;
  readonly #running = new Map<string, AbortController>();

  constructor(options: TaskRunnerOptions) { this.#options = options; }

  async start(input: Pick<Task, 'title' | 'prompt'> & Partial<Pick<Task, 'kind' | 'callback' | 'helmProject' | 'worktree'>>): Promise<Task> {
    const task = await this.#options.store.create(input, this.#now());
    this.#options.log.info('task queued', { task: task.id, callback: task.callback });
    void this.#pump();
    return task;
  }

  /** Отменяет ждущее или идущее задание; false, если оно уже закончено или не найдено. */
  async cancel(id: string): Promise<boolean> {
    const task = this.#options.store.get(id);
    if (!task || (task.status !== 'queued' && task.status !== 'running')) return false;
    this.#running.get(id)?.abort();
    const cancelled = await this.#options.store.patch(id, { status: 'cancelled', delivery: 'heard', finishedAt: this.#now().toISOString() });
    this.#options.progress?.forget(id);
    if (cancelled) await this.#options.onCancelled?.(cancelled);
    return true;
  }

  /**
   * Снова наблюдать задания, которые шли до перезапуска ядра (TaskStore, `resumable`): статус остаётся `running`,
   * исполнитель продолжает с треда задания. Звать один раз после `store.load()`.
   */
  resume(): number {
    const resumed = this.#options.store.tasks.filter(t => t.status === 'running' && !this.#running.has(t.id));
    for (const task of resumed) {
      const abort = new AbortController();
      this.#running.set(task.id, abort);
      this.#options.log.info('task resumed', { task: task.id });
      void this.#run(task.id, abort, true).finally(() => { this.#running.delete(task.id); void this.#pump(); });
    }
    return resumed.length;
  }

  get active(): number { return this.#running.size; }

  #now(): Date { return (this.#options.now ?? (() => new Date()))(); }

  async #pump(): Promise<void> {
    const { store, concurrency = 2 } = this.#options;
    while (this.#running.size < concurrency) {
      const next = store.tasks.find(t => t.status === 'queued' && !this.#running.has(t.id));
      if (!next) return;
      const abort = new AbortController();
      this.#running.set(next.id, abort);
      void this.#run(next.id, abort).finally(() => { this.#running.delete(next.id); void this.#pump(); });
    }
  }

  async #run(id: string, abort: AbortController, resumed = false): Promise<void> {
    const { store, log, timeoutMs = 10 * 60_000 } = this.#options;
    const task = resumed ? store.get(id) : await store.patch(id, { status: 'running', startedAt: this.#now().toISOString() });
    if (!task || abort.signal.aborted) return;
    const elapsed = task.startedAt ? this.#now().getTime() - Date.parse(task.startedAt) : 0;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1000, timeoutMs - elapsed))]);
    let finished: Task | undefined;
    try {
      const result = await this.#work(task, signal);
      // abort.signal срабатывает только от cancel(); тайм-аут идёт отдельным сигналом и считается сбоем.
      if (abort.signal.aborted) return;
      finished = await store.patch(id, { status: 'done', result: result.slice(0, RESULT_CHARS), finishedAt: this.#now().toISOString() });
      log.info('task done', { task: id });
    } catch (error) {
      if (abort.signal.aborted) return;
      const name = error instanceof Error ? error.name : 'unknown';
      finished = await store.patch(id, { status: 'failed', error: name, finishedAt: this.#now().toISOString() });
      log.warn('task failed', { task: id, error: name });
    } finally {
      this.#options.progress?.forget(id);
    }
    if (finished) await this.#options.onFinished(finished);
  }

  async #work(task: Task, signal: AbortSignal): Promise<string> {
    return this.#options.worker(task, signal, line => this.#options.progress?.note(task.id, line));
  }
}
