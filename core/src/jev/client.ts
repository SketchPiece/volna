import { z } from 'zod';
import { openRouterUsage, scopedPurpose, type UsageMeter } from '../usage/ledger.ts';

/**
 * Клиент Jev (TypeSafe AI): System One модель, которая не пишет текст, а отвечает на заранее заданные вопросы
 * типизированными значениями с вероятностями. Протокол: docs.typesafe.ai/api, `POST /v1/systemone`, сентябрь 2026.
 * Ключ только из `.env` (`TYPESAFE_API_KEY`); тексты запроса и ответа не логируются.
 */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * Где брать Jev. Протокол одинаковый; OpenRouter (openrouter.ai/docs/guides/community/typesafe-sdk) проксирует тот же
 * `/v1/systemone` со своим ключом и добавляет в ответ `id`, `provider`, `usage.cost`.
 */
export type JevProvider = 'typesafe' | 'openrouter';
export const JEV_PROVIDERS: Readonly<Record<JevProvider, { url: string; model: string }>> = Object.freeze({
  typesafe: { url: JEV_URL, model: 'jev-latest' },
  openrouter: { url: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13' }
});

export type Criterion = string | Record<string, unknown> | unknown[];
export type JevQuestion =
  | { type: 'noul'; instructions: Criterion; criteria: { true: Criterion; false: Criterion } }
  | { type: 'choice'; instructions: Criterion; criteria: Record<string, Criterion | null> }
  | { type: 'score'; instructions: Criterion; criteria: string[] };

export interface JevRequest {
  state: Criterion;
  questions: Record<string, JevQuestion>;
}

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number().optional() }),
  z.object({ type: z.literal('score'), score: z.number(), probabilities: z.record(z.string(), z.number()).optional(), confidence: z.number().optional() })
]);
const responseSchema = z.object({
  model: z.string().default(''),
  answers: z.record(z.string(), answerSchema),
  // OpenRouter добавляет `cost` в долларах; TypeSafe напрямую — только токены.
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cost: z.number().optional() }).loose().optional()
});
export type JevAnswer = z.infer<typeof answerSchema>;
export type JevResponse = z.infer<typeof responseSchema>;

/** Всё, что нужно предвыборке; в тестах подменяется. */
export interface DecisionModel {
  decide(request: JevRequest, signal: AbortSignal): Promise<JevResponse>;
}

export class JevError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Jev responded ${status}`); this.name = 'JevError'; this.status = status; }
}

export interface JevClientOptions {
  apiKey: string;
  model: string;
  url?: string;
  fetchImpl?: typeof fetch;
  /** В разговоре поздний ответ бесполезен: без повторов, сразу отказ. */
  timeoutMs?: number;
  /** Учёт расходов; назначение (маршрут, честность, прощание) приходит из контекста вызова. */
  meter?: UsageMeter;
}

export function jevClient({ apiKey, model, url = JEV_URL, fetchImpl = fetch, timeoutMs = 1500, meter }: JevClientOptions): DecisionModel {
  return {
    async decide(request, signal) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...request }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      });
      if (!response.ok) throw new JevError(response.status);
      const parsed = responseSchema.parse(await response.json());
      meter?.record({ purpose: scopedPurpose('jev'), model, ...openRouterUsage(parsed.usage) });
      return parsed;
    }
  };
}
