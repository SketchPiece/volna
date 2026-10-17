import test from 'node:test';
import assert from 'node:assert/strict';
import { jevClient, JevError, JEV_URL } from './client.ts';

test('Jev request carries the model, state and questions with a bearer key; answers are parsed', async () => {
  let seen: { url: string; init: any } | null = null;
  const client = jevClient({ apiKey: 'ts-key', model: 'jev-latest', fetchImpl: async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {
      goodbye: { type: 'noul', noul: 0.02 },
      tool: { type: 'choice', choice: 'current_time', probabilities: { none: 0.1, current_time: 0.9 }, confidence: 0.85 }
    }, usage: { input_tokens: 300, output_tokens: 20 } }), { status: 200 });
  } });
  const response = await client.decide({ state: 'который час', questions: { goodbye: { type: 'noul', instructions: 'bye?', criteria: { true: 'y', false: 'n' } } } }, new AbortController().signal);
  assert.equal(seen!.url, JEV_URL);
  assert.equal(seen!.init.headers.Authorization, 'Bearer ts-key');
  const body = JSON.parse(seen!.init.body);
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.state, 'который час');
  assert.equal(response.answers.tool!.type, 'choice');
  assert.equal(response.model, 'jev-1.13.0');
});

test('the OpenRouter endpoint is used when given', async () => {
  let url = '';
  const client = jevClient({ apiKey: 'or', model: 'typesafe/jev-1.13', url: 'https://openrouter.ai/api/v1/systemone', fetchImpl: async u => {
    url = String(u);
    return new Response(JSON.stringify({ id: 'gen-1', provider: 'TypeSafe', model: 'typesafe/jev-1.13', answers: {}, usage: { input_tokens: 1, cost: 0 } }), { status: 200 });
  } });
  assert.equal((await client.decide({ state: '', questions: {} }, new AbortController().signal)).model, 'typesafe/jev-1.13');
  assert.equal(url, 'https://openrouter.ai/api/v1/systemone');
});

test('Jev errors surface the status only', async () => {
  const client = jevClient({ apiKey: 'k', model: 'm', fetchImpl: async () => new Response('{"detail":"secret"}', { status: 429 }) });
  await assert.rejects(client.decide({ state: '', questions: {} }, new AbortController().signal), (error: unknown) => error instanceof JevError && error.status === 429);
});
