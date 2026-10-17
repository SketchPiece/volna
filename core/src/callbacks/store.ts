import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Перезвоны по времени (callbacks/scheduler.ts): «перезвони в шесть и напомни про отчёт». Файл `callbacks.json` рядом
 * с памятью, запись атомарная, как у заданий (tasks/store.ts).
 *
 * `scheduled`: ждёт своего времени; `ringing`: ушёл VoIP-пуш, телефон звонит; `answered`: напоминание прозвучало
 * (звонок принят или сказано в идущем разговоре); `notified`: вместо звонка ушло уведомление; `missed`: ни звонок,
 * ни уведомление не дошли, напоминание скажется в начале следующего звонка; `cancelled`: отменён голосом.
 */
export const CALLBACK_STATUSES = ['scheduled', 'ringing', 'answered', 'notified', 'missed', 'cancelled'] as const;

const callbackSchema = z.object({
  /** 16 hex, как у заданий: телефон возвращает его в `X-Callback-Task`, приложение различать их не должно. */
  id: z.string(),
  /** Когда звонить, ISO в UTC. */
  at: z.string(),
  /** Два-пять слов: имя звонящего на экране iPhone и заголовок уведомления. */
  title: z.string(),
  /** О чём напомнить, словами пользователя; в лог не пишется. */
  reason: z.string(),
  status: z.enum(CALLBACK_STATUSES),
  createdAt: z.string(),
  firedAt: z.string().nullable()
});
export type ScheduledCallback = z.infer<typeof callbackSchema>;
const fileSchema = z.object({ callbacks: z.array(callbackSchema) });

/** Сколько прошедших перезвонов хранить. */
const KEEP = 30;

export class CallbackStore {
  readonly #dir: string;
  #items: ScheduledCallback[] | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) { this.#dir = dir; }

  /** Загрузка; звонок, который звонил во время остановки ядра, считается не дошедшим. */
  async load(): Promise<ScheduledCallback[]> {
    if (this.#items) return this.#items;
    await mkdir(this.#dir, { recursive: true });
    try {
      this.#items = fileSchema.parse(JSON.parse(await readFile(join(this.#dir, 'callbacks.json'), 'utf8'))).callbacks;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#items = [];
    }
    const interrupted = this.#items.filter(c => c.status === 'ringing');
    for (const item of interrupted) item.status = 'missed';
    if (interrupted.length) await this.#persist();
    return this.#items;
  }

  get all(): readonly ScheduledCallback[] { return this.#items ?? []; }
  /** Ещё не наступившие, по времени. */
  get scheduled(): ScheduledCallback[] { return this.all.filter(c => c.status === 'scheduled').sort((a, b) => a.at.localeCompare(b.at)); }
  get(id: string): ScheduledCallback | undefined { return this.#items?.find(c => c.id === id); }

  update<T>(mutate: (items: ScheduledCallback[]) => T): Promise<T> {
    const run = async () => {
      const items = await this.load();
      const result = mutate(items);
      const past = items.filter(c => c.status !== 'scheduled').sort((a, b) => a.at.localeCompare(b.at));
      for (const old of past.slice(0, Math.max(0, past.length - KEEP))) items.splice(items.indexOf(old), 1);
      await this.#persist();
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  create(input: Pick<ScheduledCallback, 'at' | 'title' | 'reason'>, now: Date = new Date()): Promise<ScheduledCallback> {
    const item: ScheduledCallback = { id: randomBytes(8).toString('hex'), ...input, status: 'scheduled', createdAt: now.toISOString(), firedAt: null };
    return this.update(items => { items.push(item); return { ...item }; });
  }

  patch(id: string, changes: Partial<ScheduledCallback>): Promise<ScheduledCallback | undefined> {
    return this.update(items => {
      const item = items.find(c => c.id === id);
      if (item) Object.assign(item, changes);
      return item ? { ...item } : undefined;
    });
  }

  async #persist(): Promise<void> {
    const target = join(this.#dir, 'callbacks.json');
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ callbacks: this.#items }, null, 2));
    await rename(temp, target);
  }
}
