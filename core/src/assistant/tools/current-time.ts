import { z } from 'zod';
import { defineTool } from './registry.ts';

/** Первый инструмент: настоящее время. Без сети и побочных эффектов, показывает контракт остальным. */
export const currentTime = defineTool({
  name: 'current_time',
  effect: 'read',
  jev: { when: 'The user asks what time, date or weekday it is now.' },
  description: 'Current date, time and weekday for the user. Call it whenever the answer depends on today\'s date or the current time.',
  parameters: z.object({
    timeZone: z.string().optional().describe('IANA time zone, e.g. Europe/Moscow. Defaults to the user\'s zone.')
  }),
  execute({ timeZone }, context) {
    const zone = timeZone ?? context.timeZone;
    const now = context.now();
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('ru-RU', {
        timeZone: zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch {
      return { error: 'unknown_time_zone', timeZone: zone };
    }
    return { iso: now.toISOString(), local: formatter.format(now), timeZone: zone };
  }
});
