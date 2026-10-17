import { Hono, type MiddlewareHandler } from 'hono';
import { recentWork, type WorkSync } from '../work-sync/sync.ts';

/** Сколько записей отдавать телефону. */
const LIMIT = 20;

/**
 * Один список работы для телефона (docs/task-sync.md, 6): задания Волны и собственные треды владельца в «Штурвале». Только чтение,
 * с токеном ядра. Телефон пока читает `/tasks`; этот маршрут для экрана после одобрения доски на холсте (этап 3).
 * Текст заданий, сообщения и промпты не отдаются; у собственных тредов нет ни текста вопроса, ни хода, ни итога.
 */
export function workRoutes(options: { work: WorkSync; auth: MiddlewareHandler; now?: () => Date }): Hono {
  const { work, auth, now = () => new Date() } = options;
  const app = new Hono();
  app.use(auth);
  app.get('/', c => c.json({ access: work.access, asOf: work.fetchedAt, items: recentWork(work.items(), now()).slice(0, LIMIT) }));
  return app;
}
