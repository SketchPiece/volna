import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { WEEKDAYS } from './recurrence.ts';

/**
 * Повторяющиеся задания (schedules/scheduler.ts): «каждое утро в восемь собирай сводку», «по пятницам звони и напоминай
 * про отчёт». Файл `schedules.json` рядом с памятью, запись атомарная, как у перезвонов (callbacks/store.ts).
 *
 * `work`: в назначенное время ядро запускает «Работу» (tasks/runner.ts) с этим текстом задания, итог приходит, как у
 * любого задания (tasks/delivery.ts). `call`: Волна звонит и напоминает, как разовый перезвон (callbacks/scheduler.ts).
 */
export const SCHEDULE_KINDS = ['work', 'call'] as const;

const scheduleSchema = z.object({
  id: z.string(),
  kind: z.enum(SCHEDULE_KINDS),
  /** Два-пять слов: название в списке, заголовок задания и имя звонящего. */
  title: z.string(),
  /** Текст задания агенту (`work`) или о чём напомнить (`call`); в лог не пишется. */
  prompt: z.string(),
  /** «ЧЧ:ММ» в часовом поясе пользователя (TIME_ZONE ядра). */
  time: z.string(),
  /** Дни недели; пустой — каждый день. */
  days: z.array(z.enum(WEEKDAYS)),
  /** Как сообщить итог `work`: как у work_start, `notify` по умолчанию, `call` по просьбе. */
  callback: z.enum(['call', 'notify']).default('notify'),
  /** Проект и отдельная ветка «Работы», как у work_start. */
  helmProject: z.string().optional(),
  worktree: z.boolean().optional(),
  /** Следующий запуск, ISO в UTC. */
  nextAt: z.string(),
  createdAt: z.string(),
  lastRunAt: z.string().nullable(),
  /** Задание (`work`) или перезвон (`call`) последнего запуска. */
  lastRunId: z.string().nullable(),
  /** Чем кончился последний срок: запущено, пропущено (ядро было выключено, прошлая работа ещё идёт) или сбой. */
  lastOutcome: z.enum(['started', 'skipped_late', 'skipped_busy', 'failed']).nullable()
});
export type Schedule = z.infer<typeof scheduleSchema>;
const fileSchema = z.object({ schedules: z.array(scheduleSchema) });

export type ScheduleInput = Pick<Schedule, 'kind' | 'title' | 'prompt' | 'time' | 'days' | 'nextAt'> & Partial<Pick<Schedule, 'callback' | 'helmProject' | 'worktree'>>;

export class ScheduleStore {
  readonly #dir: string;
  #items: Schedule[] | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) { this.#dir = dir; }

  async load(): Promise<Schedule[]> {
    if (this.#items) return this.#items;
    await mkdir(this.#dir, { recursive: true });
    try {
      this.#items = fileSchema.parse(JSON.parse(await readFile(join(this.#dir, 'schedules.json'), 'utf8'))).schedules;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#items = [];
    }
    return this.#items;
  }

  /** По времени следующего запуска. */
  get all(): Schedule[] { return [...this.#items ?? []].sort((a, b) => a.nextAt.localeCompare(b.nextAt)); }
  get(id: string): Schedule | undefined { return this.#items?.find(s => s.id === id); }

  update<T>(mutate: (items: Schedule[]) => T): Promise<T> {
    const run = async () => {
      const items = await this.load();
      const result = mutate(items);
      await this.#persist();
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  create(input: ScheduleInput, now: Date = new Date()): Promise<Schedule> {
    const item: Schedule = { id: randomBytes(8).toString('hex'), callback: 'notify', ...input, createdAt: now.toISOString(), lastRunAt: null, lastRunId: null, lastOutcome: null };
    return this.update(items => { items.push(item); return { ...item }; });
  }

  patch(id: string, changes: Partial<Schedule>): Promise<Schedule | undefined> {
    return this.update(items => {
      const item = items.find(s => s.id === id);
      if (item) Object.assign(item, changes);
      return item ? { ...item } : undefined;
    });
  }

  remove(id: string): Promise<Schedule | undefined> {
    return this.update(items => {
      const index = items.findIndex(s => s.id === id);
      return index < 0 ? undefined : items.splice(index, 1)[0];
    });
  }

  async #persist(): Promise<void> {
    const target = join(this.#dir, 'schedules.json');
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ schedules: this.#items }, null, 2));
    await rename(temp, target);
  }
}
