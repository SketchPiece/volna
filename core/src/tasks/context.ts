import type { Task, TaskStore } from './store.ts';

/** Сколько неуслышанных итогов поднимать в начале звонка. */
const MAX_PENDING = 3;

export interface TaskContext {
  /** Секция инструкций голосовой модели; пустая, если говорить не о чем. */
  section: string;
  /** Задания, итог которых этот звонок сообщит: ядро помечает их услышанными. */
  heard: string[];
  /** Перезвон Волны: правило начала звонка вместо приветствия (assistant/persona.ts); пустое в обычном звонке. */
  opening: string;
  /** Есть неуслышанные итоги вне перезвона: правило приветствия велит упомянуть их после фразы. */
  results: boolean;
}

/**
 * Итоги фоновых заданий в начале звонка. `callbackId`: звонок начала Волна (VoIP-пуш), телефон передал id первого
 * задания пачки в `X-Callback-Task`; тогда приветствие заменяется рассказом об итогах всей пачки (задания с
 * `delivery: ringing`); это правило идёт в `opening` на место правила приветствия. Без него поднимаются итоги,
 * которые ещё не дошли до пользователя (пушей нет, звонок не приняли, уведомление не дошло).
 */
export function taskContext(store: TaskStore, callbackId: string | null): TaskContext {
  const finished = (t: Task) => t.status === 'done' || t.status === 'failed';
  const anchor = callbackId ? store.get(callbackId) : undefined;
  const parts: string[] = [];
  const heard: string[] = [];
  let opening = '';
  if (anchor && finished(anchor)) {
    const batch = [anchor, ...store.tasks.filter(t => finished(t) && t.delivery === 'ringing' && t.id !== anchor.id)].slice(0, MAX_PENDING + 2);
    const what = batch.length === 1 ? `фоновое задание «${anchor.title}» готово` : 'все фоновые задания закончены';
    opening = `Начало звонка: этот звонок начал ты сам, перезваниваешь пользователю, потому что ${what}, а он просил перезвонить.
${batch.map(t => `- «${t.title}». ${outcome(t)}`).join('\n')}
Когда попросят начать звонок, не здоровайся обычной фразой и не жди вопроса: начни с «Перезваниваю по заданию» (или «по заданиям») и сразу своими словами расскажи, что сделано и какой результат, всего до пяти предложений; подробности — если попросят. Если пользователь заговорил раньше («Алло»), всё равно сразу переходи к итогам. Потом слушай.`;
    heard.push(...batch.map(t => t.id));
  }
  const pending = store.tasks
    .filter(t => finished(t) && (t.delivery === 'pending' || t.delivery === 'ringing') && !heard.includes(t.id))
    .slice(-MAX_PENDING);
  if (pending.length) {
    parts.push(`Готова работа, о которой пользователь ещё не слышал:\n${pending.map(t => `- «${t.title}». ${outcome(t)}`).join('\n')}
Итог уже здесь: когда пользователь захочет, рассказывай сам, бэкенд не спрашивай; всего до пяти предложений, подробности — если попросит.`);
    heard.push(...pending.map(t => t.id));
  }
  const running = store.active;
  if (running.length) {
    parts.push(`Сейчас в работе фоновых заданий: ${running.length} (${running.map(t => `«${t.title}»`).join(', ')}). Сам о них не заговаривай; как идут, узнаешь у бэкенда.`);
  }
  return { section: parts.join('\n'), heard, opening, results: pending.length > 0 };
}

function outcome(task: Task): string {
  return task.status === 'done' ? `Итог: ${task.summary ?? task.result}` : 'Выполнить не получилось; так честно и скажи.';
}
