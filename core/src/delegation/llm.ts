import { z } from 'zod';
import { openRouterUsage, type UsageMeter, type UsagePurpose } from '../usage/ledger.ts';

/**
 * Бэкенд-модель клиентского делегирования: OpenAI-совместимый `chat/completions` (по умолчанию OpenRouter), так что
 * подходит любая модель с вызовом функций. Модели OpenAI с 29.09.2026 идут напрямую в Responses API (`responsesModel`):
 * OpenRouter для них всё равно ходит туда же, лишнее звено стоило ~0,1 с на круг. Без стриминга: результат отдаётся
 * Live целиком, одной репликой.
 */
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

export interface ChatResult {
  content: string | null; toolCalls: ChatToolCall[]; usage: { inTokens: number | null; outTokens: number | null; reasoningTokens?: number | null; cachedTokens?: number | null; costUsd?: number | null };
  /** Кто ответил у OpenRouter и id запроса (`/api/v1/generation?id=`): по ним видно, какой провайдер медленный. */
  provider?: string | null; id?: string | null;
  /** Тариф, на котором OpenAI реально ответил (`default`, `priority`, `flex`): Fast при наплыве может молча стать `default`. */
  serviceTier?: string | null;
}

export interface ChatModel {
  readonly model: string;
  complete(messages: ChatMessage[], tools: ChatTool[], signal: AbortSignal): Promise<ChatResult>;
}

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(),
        function: z.object({ name: z.string(), arguments: z.string().default('{}') })
      })).nullable().optional()
    })
  })).min(1),
  // Поля usage разбирает openRouterUsage: токены, кэш, размышления и цена (`cost`, доллары).
  usage: z.record(z.string(), z.unknown()).optional(),
  id: z.string().optional(),
  provider: z.string().optional(),
  service_tier: z.string().nullable().optional()
});

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Chat backend responded ${status}`); this.name = 'ChatError'; this.status = status; }
}

export interface ChatModelOptions {
  apiKey: string;
  model: string;
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Предел ответа вместе с рассуждениями. Звонок 25.09.2026: при 600 рассуждения съедали весь предел, вызов инструмента
   * обрезался, а пустой ответ после чтения сходил за «Готово.». Длину реплики для голоса держит fitAppend, не этот предел.
   */
  maxTokens?: number;
  /** Доп. поля запроса, например `plugins` для поиска OpenRouter. */
  extra?: Record<string, unknown>;
  /** Учёт расходов: каждый ответ — одна запись с этим назначением (usage/ledger.ts). */
  meter?: { ledger: UsageMeter; purpose: UsagePurpose };
}

export function chatModel({ apiKey, model, url = OPENROUTER_CHAT_URL, fetchImpl = fetch, timeoutMs = 20_000, maxTokens = 2000, extra = {}, meter }: ChatModelOptions): ChatModel {
  return {
    model,
    async complete(messages, tools, signal) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages, max_tokens: maxTokens,
          ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
          // OpenRouter: провайдер с наименьшей задержкой.
          provider: { sort: 'latency' },
          // Цена вызова в ответе (`usage.cost`): по ней считает консоль.
          usage: { include: true },
          ...extra
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      });
      if (!response.ok) throw new ChatError(response.status);
      const parsed = responseSchema.parse(await response.json());
      const message = parsed.choices[0]!.message;
      const usage = openRouterUsage(parsed.usage);
      meter?.ledger.record({ purpose: meter.purpose, model, ...usage });
      return {
        content: message.content ?? null,
        toolCalls: (message.tool_calls ?? []).map(call => ({ id: call.id, type: 'function', function: call.function })),
        usage,
        provider: parsed.provider ?? null, id: parsed.id ?? null, serviceTier: parsed.service_tier ?? null
      };
    }
  };
}

/**
 * Цена моделей OpenAI за 1М токенов (вход, вход из кэша, выход) на обычном тарифе: Responses API цену не присылает,
 * а консоль считает расходы по записям (usage/ledger.ts). `priority` вдвое дороже, `flex` вдвое дешевле.
 */
const OPENAI_PRICES: Readonly<Record<string, readonly [number, number, number]>> = { 'gpt-5.6-luna': [0.2, 0.02, 1.2] };
const TIER_PRICE: Readonly<Record<string, number>> = { priority: 2, flex: 0.5 };

const responsesSchema = z.object({
  id: z.string().optional(),
  output: z.array(z.object({
    type: z.string(),
    call_id: z.string().optional(), name: z.string().optional(), arguments: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional()
  }).passthrough()),
  usage: z.record(z.string(), z.unknown()).optional(),
  service_tier: z.string().nullable().optional()
});

/** Диалог в формате Responses: инструкции отдельно, вызовы и их результаты — элементы `function_call`/`function_call_output`. */
export function toResponsesInput(messages: ChatMessage[]): { instructions: string; input: unknown[] } {
  const system: string[] = [], input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') system.push(message.content);
    else if (message.role === 'user') input.push({ role: 'user', content: message.content });
    else if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
    else if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return { instructions: system.join('\n\n'), input };
}

/** Модель OpenAI напрямую через Responses API (`store: false`, без сохранения на стороне OpenAI). `model` без префикса `openai/`. */
export function responsesModel({ apiKey, model, url = OPENAI_RESPONSES_URL, fetchImpl = fetch, timeoutMs = 20_000, maxTokens = 2000, extra = {}, meter }: ChatModelOptions): ChatModel {
  const name = model.replace(/^openai\//, '');
  return {
    model,
    async complete(messages, tools, signal) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: name, ...toResponsesInput(messages), max_output_tokens: maxTokens, store: false,
          // strict по умолчанию в Responses требует все поля обязательными; наши схемы так не устроены.
          ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })), tool_choice: 'auto', parallel_tool_calls: true } : {}),
          ...extra
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      });
      if (!response.ok) throw new ChatError(response.status);
      const parsed = responsesSchema.parse(await response.json());
      const text = parsed.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
      const toolCalls: ChatToolCall[] = parsed.output.filter(item => item.type === 'function_call' && item.call_id && item.name)
        .map(item => ({ id: item.call_id!, type: 'function', function: { name: item.name!, arguments: item.arguments || '{}' } }));
      const tokens = openRouterUsage(parsed.usage);
      const price = OPENAI_PRICES[name];
      const tier = parsed.service_tier ?? 'default';
      const costUsd = price && tokens.inTokens !== null && tokens.outTokens !== null
        ? ((tokens.inTokens - (tokens.cachedTokens ?? 0)) * price[0] + (tokens.cachedTokens ?? 0) * price[1] + tokens.outTokens * price[2]) / 1e6 * (TIER_PRICE[tier] ?? 1)
        : null;
      const usage = { ...tokens, costUsd };
      meter?.ledger.record({ purpose: meter.purpose, model, ...usage });
      return { content: text || null, toolCalls, usage, provider: 'OpenAI', id: parsed.id ?? null, serviceTier: parsed.service_tier ?? null };
    }
  };
}

/**
 * Модель по имени OpenRouter: `openai/*` при ключе OpenAI идёт напрямую в Responses API, остальное через OpenRouter.
 * `openRouterKey` — ключ OpenRouter, `openAiKey` — ключ OpenAI (тот же, что у GPT-Live); без него всё через OpenRouter.
 * Прямой запрос ждём не дольше `directTimeoutMs`: прогон 30.09.2026 дал два долгих ответа OpenAI на ~150 запросов (9 с и
 * обрыв по таймауту 20 с), OpenRouter таких хвостов не давал. Опоздание или ошибка прямого запроса — тот же запрос через
 * OpenRouter (`provider` в ответе с пометкой `fallback`).
 */
export function backendModel({ openRouterKey, openAiKey, directTimeoutMs = 8000, ...options }: Omit<ChatModelOptions, 'apiKey' | 'url'> & { openRouterKey: string; openAiKey?: string | null; directTimeoutMs?: number }): ChatModel {
  const viaRouter = chatModel({ ...options, apiKey: openRouterKey });
  if (!openAiKey || !options.model.startsWith('openai/')) return viaRouter;
  const direct = responsesModel({ ...options, apiKey: openAiKey, timeoutMs: directTimeoutMs });
  return {
    model: options.model,
    async complete(messages, tools, signal) {
      try {
        return await direct.complete(messages, tools, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const result = await viaRouter.complete(messages, tools, signal);
        return { ...result, provider: `${result.provider ?? 'OpenRouter'} (fallback: ${error instanceof ChatError ? error.status : error instanceof Error ? error.name : 'error'})` };
      }
    }
  };
}
