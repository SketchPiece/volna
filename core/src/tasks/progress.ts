import type { Logger } from '../log.ts';
import type { ChatModel } from '../delegation/llm.ts';
import type { TaskStore } from './store.ts';

/** Куда исполнитель пишет журнал хода работы. */
export interface ProgressSink {
  note(taskId: string, line: string): void;
  forget(taskId: string): void;
}

export interface TaskProgressOptions {
  store: TaskStore;
  /** Дешёвая быстрая модель (`TASK_PROGRESS_MODEL`). */
  model: ChatModel;
  log: Logger;
  /** Как часто сворачивать новые записи в фразу (`TASK_PROGRESS_SECONDS`). */
  intervalMs?: number;
  now?: () => Date;
}

const LINE_CHARS = 300;
const KEEP_LINES = 40;
const SYSTEM = `Ты коротко сообщаешь, как идёт фоновое задание голосового ассистента «Волна». По журналу исполнителя напиши одно предложение по-русски, до 15 слов: что делается сейчас или что уже выяснилось. Настоящее время, безлично, без указания пола («сравниваются цены», «открыт Finder, идёт поиск файла»). Без кавычек, разметки, ссылок и имён инструментов. Не выдумывай того, чего нет в журнале.`;

/**
 * Ход фонового задания одной фразой. Исполнитель (агент в «Штурвале» на Mac) по ходу оставляет строки журнала:
 * что зовёт, что думает, что пишет. Раз в `intervalMs` дешёвая модель сворачивает новые строки идущих заданий в фразу
 * «что сейчас происходит» (`Task.progress`); её читает tasks_list. Журнал живёт только в памяти и в лог не пишется.
 */
export class TaskProgress implements ProgressSink {
  readonly #options: TaskProgressOptions;
  readonly #fresh = new Map<string, string[]>();
  #timer: NodeJS.Timeout | null = null;
  #busy = false;

  constructor(options: TaskProgressOptions) { this.#options = options; }

  note(taskId: string, line: string): void {
    const text = line.replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS);
    if (!text) return;
    const lines = this.#fresh.get(taskId) ?? [];
    lines.push(text);
    this.#fresh.set(taskId, lines.slice(-KEEP_LINES));
  }

  forget(taskId: string): void { this.#fresh.delete(taskId); }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs ?? 30_000);
    this.#timer.unref();
  }

  /** Один проход: для каждого идущего задания с новыми строками одна фраза. */
  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (const [id, lines] of [...this.#fresh]) {
        const task = this.#options.store.get(id);
        if (!task || task.status !== 'running') { this.#fresh.delete(id); continue; }
        if (!lines.length) continue;
        this.#fresh.set(id, []);
        await this.#summarize(id, task.title, task.progress, lines);
      }
    } finally {
      this.#busy = false;
    }
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #summarize(id: string, title: string, previous: string | null, lines: string[]): Promise<void> {
    const { store, model, log, now = () => new Date() } = this.#options;
    try {
      const result = await model.complete([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Задание: «${title}».\nПрошлая сводка: ${previous ?? 'нет'}.\nНовые записи журнала:\n${lines.map(l => `- ${l}`).join('\n')}` }
      ], [], AbortSignal.timeout(15_000));
      const text = result.content?.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return;
      // Пока шла сводка, задание могло закончиться: итог важнее фразы о ходе.
      if (store.get(id)?.status !== 'running') return;
      await store.patch(id, { progress: text, progressAt: now().toISOString() });
      log.info('task progress', { task: id });
    } catch (error) {
      log.warn('task progress failed', { task: id, error: error instanceof Error ? error.name : 'unknown' });
    }
  }
}
