import test from 'node:test';
import assert from 'node:assert/strict';
import { run, json } from '../test-support.ts';
import type { ChatMessage, ChatModel } from '../delegation/llm.ts';
import { cleanTitle, transcriptText, TITLE_TRANSCRIPT_CHARS, MAX_TITLE } from './call-title-routes.ts';

const model = (answer: string | Error, seen: ChatMessage[][] = []): ChatModel => ({
  model: 'openai/gpt-5.6-luna',
  async complete(messages) {
    seen.push(messages);
    if (answer instanceof Error) throw answer;
    return { content: answer, toolCalls: [], usage: { inTokens: null, outTokens: null } };
  }
});
const titled = (url: string, body: unknown, token = 't') => fetch(`${url}/calls/title`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
});
const lines = [
  { speaker: 'volna', text: 'Слушаю.' },
  { speaker: 'you', text: 'Привет, слушай, что взять к ужину, нас будет шестеро?' },
  { speaker: 'volna', text: 'Запечённую курицу и два салата.' }
];

test('the model names the call from the whole transcript; the answer is trimmed to one clean line', () => {
  const seen: ChatMessage[][] = [];
  return run({ token: 't', titleModel: model('«Ужин на шестерых».\nЛишнее', seen) }, async url => {
    assert.equal((await titled(url, { lines }, 'wrong')).status, 401);
    const response = await titled(url, { lines });
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { title: 'Ужин на шестерых' });
    assert.match(seen[0][1].content as string, /^Волна: Слушаю\.\nВладелец: Привет/);
  });
});

test('no words, a failing model or an empty answer leave the phone its own title', async () => {
  await run({ token: 't', titleModel: model(new Error('down')) }, async url => {
    assert.equal((await titled(url, { lines: [] })).status, 400);
    assert.equal((await titled(url, { lines: [{ speaker: 'you', text: '  ' }] })).status, 400);
    assert.equal((await titled(url, { lines })).status, 502);
  });
  await run({ token: 't', titleModel: model('  ') }, async url => assert.equal((await titled(url, { lines })).status, 502));
  await run({ token: 't' }, async url => assert.equal((await titled(url, { lines })).status, 404));
});

test('long transcripts and titles are cut', () => {
  const long = transcriptText([{ speaker: 'you', text: 'а'.repeat(4000) }, { speaker: 'volna', text: 'б'.repeat(4000) }]);
  assert.ok(long.length <= TITLE_TRANSCRIPT_CHARS + 2);
  const title = cleanTitle(`заголовок: ${'слово '.repeat(20)}`)!;
  assert.ok(title.length <= MAX_TITLE + 1);
  assert.match(title, /^Слово .*…$/);
});
