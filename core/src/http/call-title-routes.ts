import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { ChatModel } from '../delegation/llm.ts';
import type { Logger } from '../log.ts';

/**
 * Заголовок разговора для главного экрана телефона: после звонка телефон присылает стенограмму, модель стандартного
 * класса (Luna) называет разговор по смыслу. Ядро ничего не хранит и текст не пишет в журнал; без ответа модели
 * телефон оставляет свой заголовок из первой просьбы (`CallRecord.title`).
 */
const bodySchema = z.object({
  lines: z.array(z.object({ speaker: z.enum(['you', 'volna']), text: z.string().max(4000) })).min(1).max(400)
});

/** Сколько знаков стенограммы видит модель: суть разговора почти всегда в начале. */
export const TITLE_TRANSCRIPT_CHARS = 6000;
export const MAX_TITLE = 60;

const INSTRUCTIONS = `Ты называешь разговор владельца с голосовым ассистентом Волной для списка разговоров в приложении.
Дай заголовок по смыслу всего разговора: о чём шла речь или что сделали. 2–6 слов, по-русски, с заглавной буквы,
без кавычек, эмодзи и точки в конце. Не пиши «Разговор о», «Обсуждение», «Звонок». Приветствия и прощания не в счёт.
Примеры: «Что купить к ужину на шестерых», «Перенос встречи с Олегом на пятницу», «Погода в Тбилиси на выходные».
Ответь только заголовком.`;

export function transcriptText(lines: z.infer<typeof bodySchema>['lines']): string {
  const text = lines.filter(line => line.text.trim()).map(line => `${line.speaker === 'you' ? 'Владелец' : 'Волна'}: ${line.text.trim()}`).join('\n');
  return text.length > TITLE_TRANSCRIPT_CHARS ? `${text.slice(0, TITLE_TRANSCRIPT_CHARS)}\n…` : text;
}

/** Первая строка ответа без кавычек, точки и лишних пробелов; null, если модель ничего внятного не дала. */
export function cleanTitle(raw: string | null): string | null {
  const line = raw?.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  let title = line.replace(/^(заголовок|название)\s*:\s*/i, '').replace(/^[«"'“„\s]+|[»"'”.。\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (title.length < 2) return null;
  if (title.length > MAX_TITLE) {
    const cut = title.slice(0, MAX_TITLE);
    title = `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : MAX_TITLE)}…`;
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function callTitleRoutes({ model, auth, log }: { model: ChatModel; auth: MiddlewareHandler; log: Logger }): Hono {
  const app = new Hono();
  app.use(auth);

  app.post('/title', async c => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Нужна стенограмма разговора.' }, 400);
    const transcript = transcriptText(parsed.data.lines);
    if (!transcript) return c.json({ error: 'В разговоре нет слов.' }, 400);
    try {
      const result = await model.complete([
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: transcript }
      ], [], c.req.raw.signal);
      const title = cleanTitle(result.content);
      if (!title) return c.json({ error: 'Модель не дала заголовок.' }, 502);
      return c.json({ title });
    } catch (error) {
      log.warn('call title failed', { model: model.model, error: error instanceof Error ? error.name : 'unknown' });
      return c.json({ error: 'Заголовок сейчас не придумать.' }, 502);
    }
  });

  return app;
}
