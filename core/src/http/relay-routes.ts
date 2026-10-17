import { gunzipSync } from 'node:zlib';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { RelayLink } from '../relay/link.ts';

const idPattern = /^[0-9a-f]{32}$/;
export const MAX_BODY = 8 * 1024 * 1024;

/** Тело ответа «Узла»: крупные ответы (снимок всех тредов) он сжимает gzip, путь до облака длинный. null, если не JSON. */
async function answerBody(c: Context): Promise<unknown> {
  if (c.req.header('Content-Encoding')?.toLowerCase() !== 'gzip') return c.req.json().catch(() => null);
  try { return JSON.parse(gunzipSync(Buffer.from(await c.req.arrayBuffer()), { maxOutputLength: MAX_BODY }).toString('utf8')); }
  catch { return null; }
}
export const answerSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(200) })
]);
export const helloSchema = z.object({
  version: z.string().max(40),
  // Поле `t3` — старое имя в протоколе «Узла» (relay/src/main.ts): так «Узел» шлёт состояние «Штурвала».
  t3: z.object({ ok: z.boolean(), version: z.string().max(40).nullable(), reason: z.string().max(80).nullable() })
});

/**
 * «Узел» на Mac (relay/link.ts, docs/relay.md) со своим токеном `RELAY_TOKEN`, не токеном телефона. `GET /?wait=25000`
 * отдаёт вызовы или ждёт их до 25 с, `POST /:id` принимает ответ, `POST /hello` — версию «Узла» и состояние «Штурвала».
 * Содержимое вызовов и ответов (снимки тредов, тексты заданий) не логируется.
 */
export function relayRoutes(options: { link: RelayLink; auth: MiddlewareHandler; log: Logger; onHello?: () => void }): Hono {
  const { link, auth, log, onHello } = options;
  const app = new Hono();
  app.use(auth);
  // Снимок треда или список проектов бывает крупным, но не больше нескольких мегабайт.
  app.use('*', bodyLimit({ maxSize: MAX_BODY, onError: c => c.json({ error: 'Ответ слишком большой.' }, 413) }));

  app.get('/', async c => {
    const wait = Number(c.req.query('wait') ?? 0);
    const calls = await link.next(Number.isFinite(wait) ? Math.max(0, wait) : 0, c.req.raw.signal);
    return c.json({ calls });
  });

  app.post('/hello', async c => {
    const parsed = helloSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Нужны version и t3.' }, 400);
    const first = !link.connected;
    link.greet(parsed.data);
    if (first) log.info('relay.connected', { version: parsed.data.version, t3: parsed.data.t3.ok ? parsed.data.t3.version : parsed.data.t3.reason });
    onHello?.();
    return c.json({ ok: true });
  });

  app.post('/:id', async c => {
    const id = c.req.param('id');
    if (!idPattern.test(id)) return c.json({ error: 'Неизвестный вызов.' }, 404);
    const parsed = answerSchema.safeParse(await answerBody(c));
    if (!parsed.success) return c.json({ error: 'Нужен ok и data или error.' }, 400);
    return link.answer(id, parsed.data) ? c.json({ ok: true }) : c.json({ error: 'Вызов уже закрыт.' }, 404);
  });

  return app;
}
