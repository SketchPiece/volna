import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { noStore } from '../http/guards.ts';
import { MAX_CONSOLE_TEXT, type ConsoleHub, type HubMessage } from './hub.ts';
import { isPeriod, type Dashboard } from './dashboard.ts';

/** «ВОЛНА» на кнопках телефона: В·О·Л·Н·А → 2·5·4·5·2. */
export const CONSOLE_PORT = 25452;
export const CONSOLE_HOST = '127.0.0.1';

const PAGE = readFileSync(join(import.meta.dirname, 'page.html'), 'utf8');

const manual = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(MAX_CONSOLE_TEXT) }),
  z.object({ kind: z.literal('failure') }),
  z.object({ kind: z.literal('silence') })
]);
const decision = z.union([z.object({ kind: z.literal('auto') }), manual]);
const modeBody = z.object({ mode: z.enum(['auto', 'next', 'manual']), preset: manual.nullish() });
const appendBody = z.object({
  kind: z.enum(['commentary', 'thinking', 'instructions']),
  delegationId: z.string().min(1).max(128).nullable(),
  content: z.string().trim().min(1).max(MAX_CONSOLE_TEXT)
});

/**
 * Только этот Mac: ядро слушает 127.0.0.1, а заголовок `Host` защищает от подмены DNS. Ngrok смотрит на порт ядра,
 * не сюда. Меняющие запросы принимаются только со страницы самой консоли (`Origin`).
 */
export function localOnly(port: number): MiddlewareHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  return async (c, next) => {
    if (!hosts.has(c.req.header('host') ?? '')) return c.json({ error: 'Console is local only.' }, 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !origins.has(c.req.header('origin') ?? '')) {
      return c.json({ error: 'Console changes are accepted only from its page.' }, 403);
    }
    await next();
  };
}

export function consoleApp({ hub, dashboard, port = CONSOLE_PORT }: { hub: ConsoleHub; dashboard?: Dashboard; port?: number }) {
  const app = new Hono();
  app.use(noStore, localOnly(port));
  app.use('/api/*', bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: 'Too large.' }, 413) }));
  app.notFound(c => c.json({ error: 'Not found.' }, 404));

  const page = (c: Context) => c.html(PAGE);
  // «Сводка» первой вкладкой (решение владельца 27.09.2026); без учёта расходов консоль открывается на «Эфире».
  app.get('/', c => c.redirect(dashboard ? '/summary' : '/live'));
  app.get('/summary', page);
  app.get('/costs', page);
  app.get('/costs/:model{.+}', page);
  app.get('/live', page);
  app.get('/history', page);
  app.get('/history/:id', page);

  app.get('/api/state', c => c.json(hub.snapshot()));

  app.get('/api/stream', c => streamSSE(c, async stream => {
    const queue: HubMessage[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = hub.subscribe(message => { queue.push(message); wake?.(); });
    stream.onAbort(() => { unsubscribe(); wake?.(); });
    await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(hub.snapshot()) });
    while (!stream.aborted) {
      if (!queue.length) {
        await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 15_000); });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
        continue;
      }
      const message = queue.shift()!;
      await stream.writeSSE({ event: message.type, data: JSON.stringify(message) });
    }
    unsubscribe();
  }));

  app.put('/api/mode', async c => {
    const body = modeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid mode.' }, 400);
    if (body.data.mode === 'next' && !body.data.preset) return c.json({ error: 'Preset is required for the next delegation.' }, 400);
    hub.setMode(body.data.mode, body.data.preset ?? null);
    return c.json(hub.state());
  });

  app.post('/api/calls/:callId/append', async c => {
    const body = appendBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid append.' }, 400);
    const { kind, delegationId, content } = body.data;
    return hub.append(c.req.param('callId'), kind, delegationId, content) ? c.json({ ok: true }) : c.json({ error: 'The call is over.' }, 409);
  });

  app.post('/api/calls/:callId/delegations/:id', async c => {
    const body = decision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid answer.' }, 400);
    return hub.answer(c.req.param('callId'), c.req.param('id'), body.data) ? c.json({ ok: true }) : c.json({ error: 'The delegation is already answered.' }, 409);
  });

  if (dashboard) {
    app.get('/api/summary', async c => c.json(await dashboard.summary()));
    app.get('/api/costs', async c => {
      const period = c.req.query('period') ?? 'month';
      return isPeriod(period) ? c.json(await dashboard.costs(period)) : c.json({ error: 'Invalid period.' }, 400);
    });
    app.get('/api/costs/models/:model{.+}', c => {
      const period = c.req.query('period') ?? 'month';
      return isPeriod(period) ? c.json(dashboard.model(c.req.param('model'), period)) : c.json({ error: 'Invalid period.' }, 400);
    });
    app.get('/api/calls/:callId/cost', c => c.json(dashboard.call(c.req.param('callId'))));
  }

  app.get('/api/history', async c => c.json(hub.store ? await hub.store.list() : []));
  app.get('/api/history/:id', async c => {
    const record = await hub.store?.read(c.req.param('id'));
    return record ? c.json(record) : c.json({ error: 'Not found.' }, 404);
  });
  app.delete('/api/history/:id', async c => (await hub.store?.delete(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'Not found.' }, 404));

  return app;
}
