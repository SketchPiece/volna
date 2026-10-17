import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import type { ChatModel } from './llm.ts';

/**
 * Поиск в интернете для клиентского делегирования: встроенного `web_search` бэкенда Responses здесь нет, поэтому
 * ядро спрашивает модель с веб-плагином OpenRouter (`plugins: [{ id: 'web' }]`) и отдаёт короткую сводку.
 */
export function webSearchTool(searcher: ChatModel): Tool {
  return defineTool({
    name: 'web_search',
    effect: 'read',
    description: 'Search the web for fresh, verifiable information (news, weather, prices, schedules, facts that change). Returns a short summary.',
    parameters: z.object({ query: z.string().min(2).describe('What to search for, in the language that works best.') }),
    async execute({ query }, context) {
      const result = await searcher.complete([
        { role: 'system', content: 'Найди ответ в интернете и изложи его по-русски в 2–4 предложениях, с цифрами и датами, без ссылок и разметки.' },
        { role: 'user', content: query }
      ], [], context.signal);
      return { summary: (result.content ?? '').slice(0, 1200) };
    }
  });
}
