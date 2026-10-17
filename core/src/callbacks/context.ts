import type { CallbackStore } from './store.ts';
import { spokenTime } from './time.ts';

export interface CallbackContext {
  /** Правило начала звонка вместо приветствия (assistant/persona.ts); пустое, если звонок не перезвон по времени. */
  opening: string;
  /** Секция инструкций: напоминания, которые не дошли, и ближайшие перезвоны; пустая, если говорить не о чем. */
  section: string;
  /** Перезвоны, которые этот звонок озвучит: ядро отмечает их `answered` после принятого звонка. */
  heard: string[];
}

/** Сколько ближайших перезвонов показывать модели, чтобы на «когда ты мне звонишь?» ответить без бэкенда. */
const UPCOMING = 3;

/**
 * Перезвоны по времени в начале звонка. `callbackId`: звонок начала Волна (VoIP-пуш), телефон вернул id в
 * `X-Callback-Task`; если это id перезвона, а не задания, звонок начинается с напоминания. Напоминания со статусом
 * `missed` (ни звонок, ни уведомление не дошли) поднимаются в любом звонке.
 */
export function callbackContext(store: CallbackStore, callbackId: string | null, timeZone: string, now: Date = new Date()): CallbackContext {
  const anchor = callbackId ? store.get(callbackId) : undefined;
  const heard: string[] = [];
  let opening = '';
  if (anchor && (anchor.status === 'ringing' || anchor.status === 'missed' || anchor.status === 'notified')) {
    opening = `Начало звонка: этот звонок начал ты сам. Пользователь просил перезвонить ${spokenTime(new Date(anchor.at), now, timeZone)} и напомнить: «${anchor.reason}».
Когда попросят начать звонок, не здоровайся обычной фразой и не жди вопроса: начни с «Перезваниваю, как договаривались» и сразу своими словами напомни, одним-двумя предложениями. Если пользователь заговорил раньше («Алло»), всё равно сразу напомни. Если напоминание о фоновой работе, о её ходе узнай у бэкенда. Потом слушай.`;
    heard.push(anchor.id);
  }
  const parts: string[] = [];
  const missed = store.all.filter(c => c.status === 'missed' && !heard.includes(c.id)).slice(-3);
  if (missed.length) {
    parts.push(`Напоминания, до которых не удалось дозвониться:\n${missed.map(c => `- ${spokenTime(new Date(c.at), now, timeZone)}: «${c.reason}»`).join('\n')}
Скажи о них в начале разговора, коротко.`);
    heard.push(...missed.map(c => c.id));
  }
  const upcoming = store.scheduled.slice(0, UPCOMING);
  if (upcoming.length) {
    parts.push(`Запланированы твои перезвоны: ${upcoming.map(c => `${spokenTime(new Date(c.at), now, timeZone)} («${c.title}»)`).join('; ')}. Сам об этом не заговаривай.`);
  }
  return { opening, section: parts.join('\n'), heard };
}
