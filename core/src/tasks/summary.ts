import type { ChatModel } from '../delegation/llm.ts';
import type { Task } from './store.ts';

/**
 * Итог задания для голоса: агент пишет сколько угодно (таблицы, списки), а в звонок влезает не больше 500 токенов
 * (realtime/append-limit.ts), и слушать длинное неудобно. Дешёвая модель сжимает итог до одной-трёх фраз; полный итог
 * остаётся в задании (tasks_list, «Штурвал»). Ошибка или тайм-аут модели — null, тогда итог обрезается.
 */
export type ResultSummarizer = (task: Pick<Task, 'title' | 'result'>) => Promise<string | null>;

const SYSTEM = 'Ты сжимаешь итог фоновой работы для голосового ассистента. Напиши по-русски одну-три короткие фразы: главный вывод и самое важное для решения. Без списков, таблиц, ссылок и разметки, не больше 60 слов. Только то, что есть в итоге.';

export function resultSummarizer(model: ChatModel, timeoutMs = 8000): ResultSummarizer {
  return async task => {
    if (!task.result?.trim()) return null;
    try {
      const reply = await model.complete([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Задание: «${task.title}».\nИтог:\n${task.result.slice(0, 12_000)}` }
      ], [], AbortSignal.timeout(timeoutMs));
      return reply.content?.trim() || null;
    } catch {
      return null;
    }
  };
}
