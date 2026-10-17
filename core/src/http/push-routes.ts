import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { DeviceTokens } from '../push/devices.ts';

const registerSchema = z.object({
  voip: z.string().regex(/^[0-9a-f]{64,200}$/).nullable().optional(),
  alert: z.string().regex(/^[0-9a-f]{64,200}$/).nullable().optional(),
  environment: z.enum(['development', 'production'])
});

/**
 * `POST /push/register`: приложение присылает PushKit-токен (звонок Волны) и токен уведомлений при каждом запуске
 * и смене. Только с токеном ядра. Ответ говорит, может ли ядро звонить и слать уведомления (есть ли ключ APNs).
 */
export function pushRoutes(options: { devices: DeviceTokens; auth: MiddlewareHandler; configured: boolean }): Hono {
  const { devices, auth, configured } = options;
  const app = new Hono();
  app.use(auth);
  app.post('/register', async c => {
    const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Нужны environment и хотя бы один токен в hex.' }, 400);
    const device = await devices.register(parsed.data);
    return c.json({ ok: true, apns: configured, call: configured && Boolean(device.voip), notify: configured && Boolean(device.alert) });
  });
  return app;
}
