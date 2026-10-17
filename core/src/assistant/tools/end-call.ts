import { z } from 'zod';
import { defineTool } from './registry.ts';

/**
 * Волна сама кладёт трубку. Инструмент только просит ядро закрыть сессию после прощания (`ToolContext.endCall`);
 * закрытие делает sideband через `session.close`, телефон получает `session.closed` и завершает звонок штатно.
 */
export const endCall = defineTool({
  name: 'end_call',
  always: true,
  effect: 'act',
  description: 'End the phone call. Call when the user says goodbye, asks to hang up or to finish the conversation, or when the conversation has clearly reached its end. The call closes by itself a couple of seconds after your short farewell.',
  parameters: z.object({
    reason: z.enum(['user_goodbye', 'user_request', 'conversation_over']).default('user_goodbye').describe('Why the call ends; for logs only.')
  }),
  execute({ reason }, context) {
    if (!context.endCall) return { error: 'end_call_unavailable' };
    context.log.info('end call requested', { callId: context.callId, reason });
    context.endCall();
    return { ending: true, next: 'Попрощайся одной короткой фразой. Больше ничего не спрашивай: звонок завершится сам через пару секунд.' };
  }
});
