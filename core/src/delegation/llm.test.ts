import test from 'node:test';
import assert from 'node:assert/strict';
import { backendModel, OPENAI_RESPONSES_URL, OPENROUTER_CHAT_URL, responsesModel, toResponsesInput, type ChatMessage, type ChatTool } from './llm.ts';
import type { UsageInput } from '../usage/ledger.ts';

const TOOLS: ChatTool[] = [{ type: 'function', function: { name: 'remember', description: 'Запомнить.', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }];

function fakeFetch(body: unknown, seen: { url: string; init: any }[] = []): typeof fetch {
  return (async (url: string, init: any) => {
    seen.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

test('the dialog becomes Responses input: instructions apart, calls and results as function_call items', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Ты бэкенд.' },
    { role: 'user', content: 'запомни хлеб' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'remember', arguments: '{"text":"хлеб"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"saved":true}' },
    { role: 'assistant', content: 'Запомнил.' },
    { role: 'user', content: 'не от пользователя: проверь' }
  ];
  assert.deepEqual(toResponsesInput(messages), {
    instructions: 'Ты бэкенд.',
    input: [
      { role: 'user', content: 'запомни хлеб' },
      { type: 'function_call', call_id: 'c1', name: 'remember', arguments: '{"text":"хлеб"}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"saved":true}' },
      { role: 'assistant', content: 'Запомнил.' },
      { role: 'user', content: 'не от пользователя: проверь' }
    ]
  });
});

test('responsesModel asks OpenAI directly and reads text, calls, tier and the price', async () => {
  const seen: { url: string; init: any }[] = [];
  const recorded: UsageInput[] = [];
  const model = responsesModel({
    apiKey: 'sk-openai', model: 'openai/gpt-5.6-luna', extra: { reasoning: { effort: 'low' } }, meter: { ledger: { record: e => recorded.push(e) }, purpose: 'delegation' },
    fetchImpl: fakeFetch({
      id: 'resp_1', service_tier: 'default',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Запоминаю.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'remember', arguments: '{"text":"хлеб"}' }
      ],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 } }
    }, seen)
  });
  const result = await model.complete([{ role: 'system', content: 'Ты бэкенд.' }, { role: 'user', content: 'запомни хлеб' }], TOOLS, new AbortController().signal);
  assert.equal(seen[0]!.url, OPENAI_RESPONSES_URL);
  assert.equal(seen[0]!.init.headers.Authorization, 'Bearer sk-openai');
  const body = seen[0]!.init.body;
  assert.equal(body.model, 'gpt-5.6-luna', 'without the OpenRouter prefix');
  assert.equal(body.store, false);
  assert.equal(body.instructions, 'Ты бэкенд.');
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.deepEqual(body.tools, [{ type: 'function', name: 'remember', description: 'Запомнить.', parameters: TOOLS[0]!.function.parameters, strict: false }]);
  assert.equal(result.content, 'Запоминаю.');
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'remember', arguments: '{"text":"хлеб"}' } }]);
  assert.equal(result.serviceTier, 'default');
  assert.equal(result.usage.reasoningTokens, 40);
  // 600 × $0,2 + 400 × $0,02 + 100 × $1,2 за миллион.
  assert.ok(Math.abs(result.usage.costUsd! - 0.000248) < 1e-9);
  assert.equal(recorded[0]!.model, 'openai/gpt-5.6-luna');
  assert.equal(recorded[0]!.costUsd, result.usage.costUsd);
});

test('the priority tier costs twice as much; an unknown model has no price', async () => {
  const usage = { input_tokens: 1000, output_tokens: 0 };
  const fast = await responsesModel({ apiKey: 'k', model: 'openai/gpt-5.6-luna', fetchImpl: fakeFetch({ service_tier: 'priority', output: [], usage }) }).complete([], [], new AbortController().signal);
  assert.ok(Math.abs(fast.usage.costUsd! - 0.0004) < 1e-9);
  assert.equal(fast.content, null);
  const other = await responsesModel({ apiKey: 'k', model: 'openai/gpt-7', fetchImpl: fakeFetch({ output: [], usage }) }).complete([], [], new AbortController().signal);
  assert.equal(other.usage.costUsd, null);
});

test('backendModel sends openai/* straight to OpenAI when there is a key, everything else through OpenRouter', async () => {
  const seen: { url: string; init: any }[] = [];
  const openAiBody = { output: [], usage: {} };
  const routerBody = { choices: [{ message: { content: 'ок' } }] };
  const fetchImpl = (async (url: string, init: any) => fakeFetch(url === OPENAI_RESPONSES_URL ? openAiBody : routerBody, seen)(url, init)) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  await backendModel({ openRouterKey: 'or', openAiKey: 'oa', model: 'openai/gpt-5.6-luna', fetchImpl }).complete([], [], signal);
  await backendModel({ openRouterKey: 'or', openAiKey: 'oa', model: 'google/gemini-3.5-flash-lite', fetchImpl }).complete([], [], signal);
  await backendModel({ openRouterKey: 'or', openAiKey: null, model: 'openai/gpt-5.6-luna', fetchImpl }).complete([], [], signal);
  assert.deepEqual(seen.map(s => [s.url, s.init.headers.Authorization]), [
    [OPENAI_RESPONSES_URL, 'Bearer oa'], [OPENROUTER_CHAT_URL, 'Bearer or'], [OPENROUTER_CHAT_URL, 'Bearer or']
  ]);
});

test('a late or failed direct request is repeated through OpenRouter; the caller\'s abort is not', async () => {
  const seen: string[] = [];
  const hanging = (async (url: string, init: any) => {
    seen.push(url);
    if (url === OPENAI_RESPONSES_URL) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ок' } }], provider: 'Azure' }));
  }) as unknown as typeof fetch;
  const model = backendModel({ openRouterKey: 'or', openAiKey: 'oa', model: 'openai/gpt-5.6-luna', fetchImpl: hanging, directTimeoutMs: 20 });
  const result = await model.complete([], [], new AbortController().signal);
  assert.deepEqual(seen, [OPENAI_RESPONSES_URL, OPENROUTER_CHAT_URL]);
  assert.equal(result.content, 'ок');
  assert.equal(result.provider, 'Azure (fallback: TimeoutError)');

  const failing = (async (url: string) => url === OPENAI_RESPONSES_URL ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ choices: [{ message: { content: 'ок' } }] }))) as unknown as typeof fetch;
  assert.equal((await backendModel({ openRouterKey: 'or', openAiKey: 'oa', model: 'openai/gpt-5.6-luna', fetchImpl: failing }).complete([], [], new AbortController().signal)).provider, 'OpenRouter (fallback: 500)');

  seen.length = 0;
  const abort = new AbortController();
  const pending = backendModel({ openRouterKey: 'or', openAiKey: 'oa', model: 'openai/gpt-5.6-luna', fetchImpl: hanging }).complete([], [], abort.signal);
  abort.abort();
  await assert.rejects(pending);
  assert.deepEqual(seen, [OPENAI_RESPONSES_URL], 'the call ended: no second request');
});
