import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import type { CallbackStore } from './store.ts';
import type { CallbackScheduler } from './scheduler.ts';
import { parseWhen, spokenTime } from './time.ts';

/** Дальше месяца — это уже напоминание в календаре, а не перезвон. */
const MAX_AHEAD_MS = 31 * 86_400_000;

/**
 * Перезвон в назначенное время: Волна сама звонит на iPhone (VoIP-пуш) и напоминает (callbacks/scheduler.ts).
 * Нужен ключ APNs; без него инструментов нет: обещать звонок, который не придёт, нельзя.
 */
export function callbackTools(store: CallbackStore, scheduler: CallbackScheduler): Tool[] {
  /** Звонки, в которых о теме перезвона уже спросили. */
  const asked = new Map<string, number>();
  const schedule = defineTool({
    name: 'callback_schedule',
    effect: 'write',
    description: 'Volna phones the user at a given time and reminds them of something by voice. Call whenever the user asks Volna to call or ring them at a time or after a while, with or without a reminder («перезвони в шесть и напомни про отчёт», «позвони мне через пять минут», «набери через полчаса», «позвонишь в семь?»): Volna cannot call right now, only at a set time through this tool, so never answer «наберу» without calling it. Not for «when the work is done»: that is tasks_call_back. Not for a silent reminder in the Reminders app: that is create_reminder. Pass either at or inMinutes.',
    parameters: z.object({
      at: z.string().optional().describe('When to call, ISO 8601 local time of the user, e.g. 2026-09-26T18:00; compute «tomorrow at nine» from current_time.'),
      inMinutes: z.number().int().min(1).max(1440).optional().describe('Call after this many minutes, for «через полчаса», «через час».'),
      reason: z.string().max(300).default('').describe('What to remind about, only as the user said it; leave empty if they did not say: the tool then asks them.'),
      title: z.string().min(2).max(60).describe('Two to four words naming the reminder, in the user\'s language.')
    }),
    async execute({ at, inMinutes, reason, title }, context) {
      const now = context.now();
      // Как у напоминания, тему спрашиваем, а не придумываем (решение владельца 27.09.2026). Вопрос задаёт Jev (missing), но когда
      // он опаздывает, Flash Lite ставила тему «просто перезвонить» сама (6 из 6, даже с флагом «только если сказал»). Поэтому
      // перезвон без темы в звонке один раз обязательно спрашивает; после вопроса принимается любой ответ, и «ни о чём» тоже.
      // Спросить могла и сама Волна по подсказке Jev: тогда её последняя реплика перед ответом спрашивает, о чём напомнить.
      if (isPlain(reason) && !asked.has(context.callId) && !askedInCall(context.turns?.() ?? [])) {
        asked.set(context.callId, now.getTime());
        return { error: 'no_reason', say: 'О чём напомнить, когда позвоню?', hint: 'Ask the user exactly this and call again with their answer; nothing is scheduled yet.' };
      }
      const when = inMinutes ? new Date(now.getTime() + inMinutes * 60_000) : at ? parseWhen(at, context.timeZone) : null;
      if (!when) return { error: 'bad_time', hint: 'Pass at as ISO 8601 local time or inMinutes.' };
      if (when.getTime() <= now.getTime() + 30_000) return { error: 'time_in_past', now: now.toISOString(), hint: 'The time has already passed: check current_time and ask the user.' };
      if (when.getTime() - now.getTime() > MAX_AHEAD_MS) return { error: 'too_far', hint: 'More than a month ahead: offer a reminder in the Reminders app instead.' };
      asked.delete(context.callId);
      const item = await store.create({ at: when.toISOString(), title, reason: reason.trim() || 'просто перезвонить' }, now);
      scheduler.arm();
      const spoken = spokenTime(when, now, context.timeZone);
      return { scheduled: true, id: item.id, at: item.at, when: spoken, say: `Договорились, перезвоню ${spoken}.` };
    }
  });

  const list = defineTool({
    name: 'callbacks_list',
    effect: 'read',
    jev: { when: 'The user asks when Volna is going to call them back or which call-backs are planned.' },
    description: 'Planned call-backs by time: when and what about. Call when the user asks when Volna will call or wants to change or cancel a call-back.',
    parameters: z.object({}),
    async execute(_args, context) {
      const now = context.now();
      return { count: store.scheduled.length, callbacks: store.scheduled.map(c => ({ id: c.id, when: spokenTime(new Date(c.at), now, context.timeZone), at: c.at, title: c.title, reason: c.reason })) };
    }
  });

  const cancel = defineTool({
    name: 'callback_cancel',
    effect: 'write',
    description: 'Cancel a planned call-back. Only when the user asks; take the id from callbacks_list. To move a call-back, cancel it and schedule a new one.',
    parameters: z.object({ id: z.string().min(1).describe('Call-back id from callbacks_list.') }),
    async execute({ id }) {
      if (store.get(id)?.status !== 'scheduled') return { cancelled: false, id, reason: 'not_scheduled' };
      await store.patch(id, { status: 'cancelled' });
      scheduler.arm();
      return { cancelled: true, id };
    }
  });

  return [schedule, list, cancel];
}

/** Тема, по которой не понять, о чём напоминать: пусто или сам перезвон («просто перезвонить», «звонок»). */
export function isPlain(reason: string): boolean {
  const text = reason.toLowerCase().replace(/[^а-яёa-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length < 3 || /^(просто |ну )?(пере)?(звон|звонить|звони|позвонить|набрать|набери|вызов)[а-яё]*( (мне|меня|вам|тебе))?$/.test(text) || /^(напоминание|напомнить|перезвон)$/.test(text);
}

/** Волна только что спросила, о чём напомнить: её последняя реплика перед последним ответом пользователя. */
export function askedInCall(turns: readonly { role: 'user' | 'assistant'; text: string }[]): boolean {
  const last = turns.findLastIndex(t => t.role === 'user');
  const before = turns.slice(0, Math.max(0, last)).findLast(t => t.role === 'assistant');
  return Boolean(before && /напомн|о ч[её]м|что сказать|зачем/i.test(before.text) && /\?/.test(before.text));
}
