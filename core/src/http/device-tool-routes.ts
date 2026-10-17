import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { DeviceBroker } from '../delegation/device-broker.ts';

const answerSchema = z.object({ output: z.string().max(64 * 1024) });
const idPattern = /^[0-9a-f]{32}$/;

/**
 * Инструменты телефона при своём делегировании (delegation/device-broker.ts). Только для приложения на iPhone, с его
 * токеном ядра. `GET /?wait=25000` отдаёт новые вызовы или ждёт их до 25 с; `POST /:id` принимает ответ телефона.
 * В ответе опроса и `working`: id идущих работ, по ним телефон включает музыку ожидания (опрос будит `broker.notify`).
 * Аргументы и результаты не логируются.
 */
export function deviceToolRoutes(options: { broker: DeviceBroker; auth: MiddlewareHandler; working?: () => string[] }): Hono {
  const { broker, auth, working = () => [] } = options;
  const app = new Hono();
  app.use(auth);

  app.get('/', async c => {
    const wait = Number(c.req.query('wait') ?? 0);
    const calls = await broker.next(Number.isFinite(wait) ? Math.max(0, wait) : 0, c.req.raw.signal);
    return c.json({ calls, working: working() });
  });

  app.post('/:id', async c => {
    const id = c.req.param('id');
    if (!idPattern.test(id)) return c.json({ error: 'Неизвестный вызов.' }, 404);
    const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Нужен output: строка JSON.' }, 400);
    return broker.answer(id, parsed.data.output) ? c.json({ ok: true }) : c.json({ error: 'Вызов уже закрыт.' }, 404);
  });

  return app;
}
