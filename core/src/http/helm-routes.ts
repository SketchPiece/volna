import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { stateSchema } from '../helm/aggregate.ts';
import { deviceRegistrationSchema, type HelmPush } from '../helm/helm-push.ts';
import { MAX_TRANSCRIBE_BYTES, TranscribeError, type Transcriber } from '../helm/transcribe.ts';

/**
 * `/helm` для «Штурвала» (docs/helm-push.md). Пути и тела повторяют релей T3 Connect, чтобы сервер и приложение
 * «Штурвала» ходили сюда без своей обвязки. Подпись `proof` от сервера не нужна. Публиковать может только сервер
 * «Штурвала» (HELM_SERVER_TOKEN), телефон (HELM_DEVICE_TOKEN) — только регистрироваться и читать карточку.
 * Голос распознают оба: сервер «Штурвала» пересылает запись, телефон шлёт её сам (без лишнего перехода через Mac).
 * Телефонный токен вшит в сборку, поэтому ему лимит минут в сутки и предел размера файла.
 */
export function helmRoutes(options: { push: HelmPush; serverAuth: MiddlewareHandler; deviceAuth: MiddlewareHandler; transcribe?: Transcriber }): Hono {
  const { push, serverAuth, deviceAuth, transcribe } = options;
  const deviceUsage = { day: '', seconds: 0 };
  const deviceSecondsToday = () => {
    const day = new Date().toISOString().slice(0, 10);
    if (deviceUsage.day !== day) Object.assign(deviceUsage, { day, seconds: 0 });
    return deviceUsage;
  };
  const app = new Hono();
  app.use('/v1/environments/*', serverAuth);
  app.use('/v1/mobile/*', deviceAuth);

  // multipart: file (запись), languages[] и keywords[] (подсказки), prompt, seconds. Ответ { text }.
  app.post('/v1/transcriptions', bodyLimit({ maxSize: MAX_TRANSCRIBE_BYTES + 64 * 1024, onError: c => c.json({ error: 'Запись слишком длинная.' }, 413) }), async c => {
    const fromDevice = !(await passes(serverAuth, c));
    if (fromDevice && !(await passes(deviceAuth, c))) return c.json({ error: 'Неверный токен ядра.' }, 401);
    if (!transcribe) return c.json({ error: 'В ядре нет ключа OpenAI.' }, 503);
    if (fromDevice && deviceSecondsToday().seconds >= DEVICE_TRANSCRIBE_MINUTES_PER_DAY * 60) return c.json({ error: 'Лимит распознавания на сегодня исчерпан.' }, 429);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !(file instanceof Blob) || file.size === 0) return c.json({ error: 'Нужен файл записи.' }, 400);
    if (fromDevice && file.size > MAX_DEVICE_TRANSCRIBE_BYTES) return c.json({ error: 'Запись слишком длинная.' }, 413);
    const texts = (name: string) => form.getAll(name).filter((value): value is string => typeof value === 'string');
    const seconds = Number(form.get('seconds'));
    try {
      const result = await transcribe({
        audio: file, fileName: file instanceof File && file.name ? file.name : 'audio.m4a',
        languages: texts('languages[]'), keywords: texts('keywords[]'),
        prompt: typeof form.get('prompt') === 'string' ? form.get('prompt') as string : null,
        seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null
      }, c.req.raw.signal);
      // Без длины от OpenAI и от телефона считаем по пределу записи на телефоне: лимит не должен течь.
      if (fromDevice) deviceSecondsToday().seconds += result.seconds ?? MAX_DEVICE_CLIP_SECONDS;
      return c.json({ text: result.text });
    } catch (error) {
      const status = error instanceof TranscribeError ? error.status : 502;
      return c.json({ error: 'Не удалось распознать запись.' }, status as 400 | 413 | 502);
    }
  });

  app.post('/v1/environments/:environmentId/threads/:threadId/agent-activity', async c => {
    const parsed = z.object({ state: stateSchema.nullable() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Нужно state (или null).' }, 400);
    const key = { environmentId: c.req.param('environmentId'), threadId: c.req.param('threadId') };
    const state = parsed.data.state;
    if (state && (state.environmentId !== key.environmentId || state.threadId !== key.threadId)) return c.json({ error: 'Тред в пути и в state разный.' }, 400);
    // Пуши уходят после ответа: сервер «Штурвала» не ждёт APNs.
    void push.publish(key, state);
    return c.json({ ok: true, deliveries: [] });
  });

  app.post('/v1/mobile/devices', async c => {
    const parsed = deviceRegistrationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Неверная регистрация устройства.' }, 400);
    await push.registerDevice(parsed.data);
    return c.json({ ok: true });
  });

  app.delete('/v1/mobile/devices/:deviceId', async c => {
    await push.unregisterDevice(c.req.param('deviceId'));
    return c.json({ ok: true });
  });

  app.post('/v1/mobile/live-activities', async c => {
    const parsed = z.object({ deviceId: z.string().trim().min(1), activityPushToken: z.string().regex(/^[0-9a-fA-F]{32,400}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Нужны deviceId и activityPushToken.' }, 400);
    if (!(await push.registerLiveActivity(parsed.data))) return c.json({ error: 'Сначала зарегистрируй устройство.' }, 404);
    return c.json({ ok: true });
  });

  app.get('/v1/mobile/agent-activity', async c => {
    await push.load();
    return c.json({ aggregate: push.snapshot() });
  });

  return app;
}

/** Минут распознавания в сутки (UTC) по телефонному токену; счёт в памяти, перезапуск ядра его обнуляет. */
export const DEVICE_TRANSCRIBE_MINUTES_PER_DAY = 60;
/** Телефон пишет до 5 минут AAC 16 кГц 32 кбит/с (~1,2 МБ); старые сборки писали 44,1 кГц, им хватает 4 МБ. */
const MAX_DEVICE_TRANSCRIBE_BYTES = 4 * 1024 * 1024;
const MAX_DEVICE_CLIP_SECONDS = 5 * 60;

/** Пропускает ли проверка токена запрос, не отвечая за маршрут. */
async function passes(auth: MiddlewareHandler, c: Context): Promise<boolean> {
  let passed = false;
  await auth(c, async () => { passed = true; });
  return passed;
}
