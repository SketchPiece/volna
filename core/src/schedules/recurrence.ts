import { parseWhen } from '../callbacks/time.ts';

/** Дни недели в порядке ISO: понедельник первый. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = typeof WEEKDAYS[number];

/** Правило повтора: время «ЧЧ:ММ» у пользователя и дни недели; пустой список дней — каждый день. */
export interface Recurrence {
  time: string;
  days: readonly Weekday[];
}

export function validTime(time: string): boolean {
  const m = time.match(/^(\d{2}):(\d{2})$/);
  return Boolean(m && +m[1]! < 24 && +m[2]! < 60);
}

/**
 * Ближайший запуск строго позже `after` в часовом поясе пользователя. Время, которого в этот день нет (переход на
 * летнее время), parseWhen сдвигает на час вперёд; повторы того же местного времени при переходе на зимнее берут первый.
 */
export function nextRun(rule: Recurrence, after: Date, timeZone: string): Date {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(after);
  const [y, m, d] = local.split('-').map(Number) as [number, number, number];
  for (let shift = 0; shift <= 8; shift++) {
    const day = new Date(Date.UTC(y, m - 1, d + shift));
    const weekday = WEEKDAYS[(day.getUTCDay() + 6) % 7]!;
    if (rule.days.length && !rule.days.includes(weekday)) continue;
    const at = parseWhen(`${day.toISOString().slice(0, 10)}T${rule.time}`, timeZone);
    if (at && at.getTime() > after.getTime()) return at;
  }
  throw new Error('no next run');
}

const DAY_NAMES: Record<Weekday, string> = { mon: 'понедельникам', tue: 'вторникам', wed: 'средам', thu: 'четвергам', fri: 'пятницам', sat: 'субботам', sun: 'воскресеньям' };

/** «каждый день в 08:00», «по будням в 09:30», «по понедельникам и пятницам в 10:00» — для голоса и списка. */
export function spokenRule(rule: Recurrence): string {
  const days = WEEKDAYS.filter(day => rule.days.includes(day));
  const time = `в ${rule.time}`;
  if (!days.length || days.length === 7) return `каждый день ${time}`;
  if (days.join() === 'mon,tue,wed,thu,fri') return `по будням ${time}`;
  if (days.join() === 'sat,sun') return `по выходным ${time}`;
  const names = days.map(day => DAY_NAMES[day]);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} и ${names.at(-1)}`;
  return `по ${list} ${time}`;
}
