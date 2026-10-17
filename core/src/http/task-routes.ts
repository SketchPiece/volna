import { Hono, type MiddlewareHandler } from 'hono';
import type { Task, TaskStore } from '../tasks/store.ts';

/** Сколько заданий отдавать телефону: на главном экране помещается шесть строк. */
const LIMIT = 10;
/** Законченное задание видно на главном экране сутки. */
const RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * Работа на главном экране телефона (docs/design/canvas/home-idle, доска Д): идущие задания, вопросы исполнителя
 * и законченное за сутки. Только чтение, с токеном ядра. Текст задания (`prompt`) и итог не отдаются: телефону
 * хватает заголовка, а итог Волна говорит в звонке.
 */
export function taskRoutes(options: { tasks: TaskStore; auth: MiddlewareHandler; now?: () => Date }): Hono {
  const { tasks, auth, now = () => new Date() } = options;
  const app = new Hono();
  app.use(auth);
  app.get('/', async c => {
    await tasks.load();
    return c.json({ tasks: phoneTasks(tasks.tasks, now()) });
  });
  return app;
}

export function phoneTasks(all: readonly Task[], now: Date) {
  const recent = (t: Task) => t.finishedAt !== null && now.getTime() - Date.parse(t.finishedAt) < RECENT_MS;
  return all
    .filter(t => t.status === 'queued' || t.status === 'running' || t.waiting || recent(t))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIMIT)
    .map(t => ({
      id: t.id, title: t.title, status: t.status, waiting: t.waiting ?? null, progress: t.progress,
      createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt
    }));
}
