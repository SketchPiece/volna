import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { json, run } from '../test-support.ts';
import type { UsageInput } from '../usage/ledger.ts';
import { HelmPush } from './helm-push.ts';
import { openAiTranscriber, type Transcriber } from './transcribe.ts';

async function withHelm(transcribe: Transcriber | undefined, exercise: (url: string) => Promise<void>) {
  const push = new HelmPush({ dir: await mkdtemp(join(tmpdir(), 'helm-')), log: silentLogger, apns: null });
  await run({ helm: { push, serverToken: 'server', deviceToken: 'device', transcribe } }, exercise);
}

const send = (url: string, token: string, form: FormData) =>
  fetch(`${url}/helm/v1/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });

function recording(fields: Record<string, string | string[]> = {}) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), 'clip.m4a');
  for (const [name, value] of Object.entries(fields)) for (const item of [value].flat()) form.append(name, item);
  return form;
}

test('the Helm server gets text back; OpenAI sees the clip, language and term hints, and the minute is billed', async () => {
  const sent: FormData[] = [];
  const usage: UsageInput[] = [];
  const transcribe = openAiTranscriber({
    apiKey: 'sk', model: 'gpt-transcribe', meter: { record: entry => usage.push(entry) },
    fetchImpl: async (_url, init) => { sent.push(init!.body as FormData); return Response.json({ text: ' Сделай commit в main \n' }); }
  });
  await withHelm(transcribe, async url => {
    const response = await send(url, 'server', recording({
      'languages[]': ['ru', 'en'], 'keywords[]': ['useEffect', 'Thread\nComposer<x>', 'useEffect', ' '], prompt: 'Helm', seconds: '60'
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { text: 'Сделай commit в main' });
  });
  const form = sent[0];
  assert.equal(form.get('model'), 'gpt-transcribe');
  assert.equal((form.get('file') as File).name, 'clip.m4a');
  assert.deepEqual(form.getAll('languages[]'), ['ru', 'en']);
  const keywords = form.getAll('keywords[]');
  assert.deepEqual(keywords.slice(0, 2), ['useEffect', 'Thread Composer x'], 'deduped, no line breaks or angle brackets');
  assert.ok(keywords.includes('worktree') && keywords.filter(k => k === 'useEffect').length === 1, 'the coding words follow the request\'s own');
  assert.equal(form.get('prompt'), 'Helm');
  assert.deepEqual(usage, [{ purpose: 'helm_transcribe', model: 'gpt-transcribe', seconds: 60, costUsd: 0.0045 }]);
});

test('without hints from the request OpenAI still hears Russian and English', async () => {
  const sent: FormData[] = [];
  const transcribe = openAiTranscriber({
    apiKey: 'sk', model: 'gpt-transcribe',
    fetchImpl: async (_url, init) => { sent.push(init!.body as FormData); return Response.json({ text: 'ok', usage: { seconds: 4 } }); }
  });
  assert.deepEqual(await transcribe({ audio: new Blob([new Uint8Array([1])]), fileName: 'a.m4a', languages: [], keywords: [], prompt: null, seconds: null }), { text: 'ok', seconds: 4 });
  assert.deepEqual(sent[0].getAll('languages[]'), ['ru', 'en']);
});

test('the phone transcribes with its own token, within a daily allowance and a clip size', async () => {
  const calls: number[] = [];
  const transcribe: Transcriber = async request => { calls.push(request.audio.size); return { text: 'привет', seconds: 30 * 60 }; };
  await withHelm(transcribe, async url => {
    assert.equal((await send(url, 'nobody', recording())).status, 401);
    const first = await send(url, 'device', recording());
    assert.equal(first.status, 200);
    assert.deepEqual(await json(first), { text: 'привет' }, 'the length stays inside the core');
    const big = new FormData();
    big.set('file', new Blob([new Uint8Array(5 * 1024 * 1024)]), 'long.m4a');
    assert.equal((await send(url, 'device', big)).status, 413, 'a phone clip is never this long');
    assert.equal((await send(url, 'device', recording())).status, 200, 'an hour a day');
    assert.equal((await send(url, 'device', recording())).status, 429, 'the allowance is spent');
    assert.equal((await send(url, 'server', recording())).status, 200, 'the Helm server is not limited');
  });
  assert.equal(calls.length, 3, 'refused clips never reach OpenAI');
});

test('a missing clip, a missing key and an OpenAI failure are told apart', async () => {
  const failing = openAiTranscriber({ apiKey: 'sk', model: 'gpt-transcribe', fetchImpl: async () => new Response('busy', { status: 500 }) });
  await withHelm(failing, async url => {
    assert.equal((await send(url, 'server', new FormData())).status, 400);
    assert.equal((await send(url, 'server', recording())).status, 502);
  });
  await withHelm(undefined, async url => assert.equal((await send(url, 'server', recording())).status, 503));
});
