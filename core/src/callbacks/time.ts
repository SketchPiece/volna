/**
 * Время перезвона. Модель передаёт его как ISO 8601; без смещения время считается местным для часового пояса
 * пользователя (TIME_ZONE ядра), так «2026-09-26T18:00» значит шесть вечера у пользователя, а не в UTC.
 */
export function parseWhen(value: string, timeZone: string): Date | null {
  const text = value.trim();
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  // Date.UTC переносит «13-й месяц» и «25 часов» дальше; такое время не принимаем.
  const check = new Date(wall);
  if (check.getUTCMonth() !== +m[2]! - 1 || check.getUTCDate() !== +m[3]! || check.getUTCHours() !== +m[4]! || check.getUTCMinutes() !== +m[5]!) return null;
  // Смещение пояса в этот момент; второй проход — на случай перехода на летнее время между двумя оценками.
  let instant = wall - zoneOffset(wall, timeZone);
  const second = zoneOffset(instant, timeZone);
  if (wall - second !== instant) instant = wall - second;
  return new Date(instant);
}

function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** «в 18:00», «завтра в 09:30», «3 октября в 18:00» — для голоса и уведомлений. */
export function spokenTime(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
  if (day(at) === day(now)) return `в ${time}`;
  if (day(at) === day(new Date(now.getTime() + 86_400_000))) return `завтра в ${time}`;
  return `${new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long' }).format(at)} в ${time}`;
}
