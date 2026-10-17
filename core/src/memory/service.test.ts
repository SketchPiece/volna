import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './store.ts';
import { DREAM_EPISODES, MemoryService } from './service.ts';
import { CallRecorder } from './recorder.ts';
import { OPENROUTER_CHAT_URL } from '../delegation/llm.ts';
import { silentLogger } from '../log.ts';
import type { MemoryUpdate } from './model.ts';

const now = new Date('2026-09-22T10:00:00Z');

/** Поддельный chat/completions моделей памяти: запоминает запросы и отвечает заданными обновлениями по очереди. */
function fakeResponses(updates: MemoryUpdate[]) {
  const requests: any[] = [];
  const fetchImpl = (async (url: string, options: any) => {
    assert.equal(url, OPENROUTER_CHAT_URL);
    const body = JSON.parse(options.body);
    requests.push({ headers: options.headers, body });
    const update = updates.shift() ?? { profile: null, operations: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(update) } }] }));
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

async function service(updates: MemoryUpdate[], level: 'cold' | 'explicit' | 'attentive' | 'involved' = 'attentive') {
  const store = new MemoryStore(await mkdtemp(join(tmpdir(), 'wave-service-')));
  await store.update(s => { s.level = level; }, now);
  const fake = fakeResponses(updates);
  const memory = new MemoryService({ store, log: silentLogger, now: () => now, extractor: { apiKey: 'k', model: 'm', deepModel: 'deep', timeZone: 'UTC', log: silentLogger, fetchImpl: fake.fetchImpl } });
  return { store, memory, ...fake };
}

test('recorder joins transcript deltas into turns split by speaker change or a long pause', () => {
  const recorder = new CallRecorder('live_1', () => now);
  recorder.observe({ type: 'session.usage.updated', usage: { seconds: 1 } });
  recorder.observe({ type: 'session.output_transcript.delta', delta: 'Волна', start_ms: 0, end_ms: 400 });
  recorder.observe({ type: 'session.output_transcript.delta', delta: ' на связи', start_ms: 400, end_ms: 900 });
  recorder.observe({ type: 'session.input_transcript.delta', delta: '  Запомни, у меня', start_ms: 1500, end_ms: 2200 });
  recorder.observe({ type: 'session.input_transcript.delta', delta: ' собака Рекс ', start_ms: 2200, end_ms: 2900 });
  recorder.observe({ type: 'session.input_transcript.delta', delta: 'И ещё кот', start_ms: 6000, end_ms: 6500 });
  recorder.observe({ type: 'session.input_transcript.delta', delta: '   ', start_ms: 6500, end_ms: 6600 });
  recorder.observe({ type: 'session.input_transcript.delta' });
  const transcript = recorder.finish();
  assert.deepEqual(transcript.turns.map(t => [t.role, t.text]), [
    ['assistant', 'Волна на связи'], ['user', 'Запомни, у меня собака Рекс'], ['user', 'И ещё кот']
  ]);
  assert.equal(transcript.callId, 'live_1');
});

test('after a call the transcript is stored, the extractor sees memory and dialogue, operations are applied as inferred', async () => {
  const { store, memory, requests } = await service([
    { profile: 'Хозяин собаки Рекса.', operations: [
      { op: 'add', text: 'Собаку зовут Рекс', kind: 'fact', sensitive: false, when: null },
      { op: 'add', text: 'Принимает антидепрессанты', kind: 'fact', sensitive: true, when: null },
      { op: 'add', text: 'Обсуждали собаку', kind: 'episode', sensitive: false, when: null }
    ] },
    { profile: null, operations: [] }
  ]);
  const recorder = memory.startCall('rtc_1')!;
  recorder.observe({ type: 'session.input_transcript.delta', delta: 'У меня собака Рекс', start_ms: 0, end_ms: 900 });
  recorder.observe({ type: 'session.output_transcript.delta', delta: 'Отличное имя.', start_ms: 1200, end_ms: 1800 });
  await memory.endCall(recorder);
  await memory.idle;
  assert.equal(requests[0].headers.Authorization, 'Bearer k');
  assert.equal(requests[0].body.model, 'm');
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.equal(requests[0].body.response_format.json_schema.strict, true);
  assert.match(requests[0].body.messages[0].content, /Записи сейчас/);
  assert.match(requests[0].body.messages[0].content, /update этого id объединённым текстом/, 'a repeated topic updates the episode instead of adding');
  assert.match(requests[0].body.messages[1].content, /Пользователь: У меня собака Рекс\nВолна: Отличное имя\./);
  assert.deepEqual(store.state.facts.map(f => [f.text, f.origin, f.callId]), [['Собаку зовут Рекс', 'inferred', 'rtc_1'], ['Обсуждали собаку', 'inferred', 'rtc_1']]);
  assert.equal(store.state.profile, 'Хозяин собаки Рекса.');
  assert.equal((await store.listTranscripts()).length, 1);
  assert.equal(requests.length, 2, 'first call also triggers a dream because none happened yet');
  assert.match(requests[1].body.messages[0].content, /консолидация/);
  assert.equal(requests[1].body.model, 'deep', 'the dream uses the deep model');
  assert.equal(store.state.lastDreamAt, now.toISOString());
});

test('calls without user speech are neither stored nor extracted; extractor failures do not throw', async () => {
  const { store, memory, requests } = await service([]);
  const silent = memory.startCall('rtc_2')!;
  silent.observe({ type: 'session.output_transcript.delta', delta: 'Волна на связи', start_ms: 0, end_ms: 700 });
  await memory.endCall(silent);
  assert.equal(requests.length, 0);
  assert.deepEqual(await store.listTranscripts(), []);

  const failing = new MemoryService({ store, log: silentLogger, now: () => now, extractor: { apiKey: 'k', model: 'm', timeZone: 'UTC', log: silentLogger, fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch } });
  const recorder = failing.startCall('rtc_3')!;
  recorder.observe({ type: 'session.input_transcript.delta', delta: 'привет', start_ms: 0, end_ms: 300 });
  await failing.endCall(recorder);
  assert.equal(store.state.facts.length, 0);
});

test('recording depends on the closeness level; involved greeting marks the thread as asked', async () => {
  const { memory: explicit } = await service([], 'explicit');
  assert.equal(explicit.startCall('rtc'), null);
  assert.equal(explicit.recordsCalls, false);
  const { store, memory } = await service([], 'involved');
  await store.apply([{ op: 'add', text: 'Экзамен', kind: 'thread', sensitive: false, when: '2026-09-20' }], { origin: 'inferred', now });
  const first = await memory.context();
  assert.equal(first.thread?.text, 'Экзамен');
  assert.equal(store.state.facts[0]!.askedAt, null, 'building the context does not use the thread up');
  assert.equal((await memory.context({ thread: false })).thread, null);
  const second = await memory.context();
  assert.equal(second.thread?.text, 'Экзамен', 'an attempt without commit leaves the thread');
  await second.commitThread();
  assert.ok(store.state.facts[0]!.askedAt);
  assert.equal((await memory.context()).thread, null, 'a thread is raised only once');
});

test('the extractor sees when each record was learned; many open episodes trigger a dream before a day has passed', async () => {
  const { store, memory, requests } = await service([]);
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
  await store.update(s => { s.lastDreamAt = hoursAgo(4); }, now);
  const topics = ['погода', 'рецепт борща', 'аниме', 'детский сад', 'тарифы связи', 'скалолазание', 'новости', 'кофе', 'бургеры', 'таймеры', 'аудит', 'музыка', 'танцы', 'звёзды', 'сны', 'политика'];
  const episodes = (count: number) => topics.slice(0, count).map(topic => ({ op: 'add' as const, text: `Говорили про ${topic}`, kind: 'episode' as const, sensitive: false, when: null }));
  await store.apply(episodes(DREAM_EPISODES), { origin: 'inferred', now: new Date('2026-09-20T08:00:00Z') });
  const call = async () => {
    const recorder = memory.startCall('rtc')!;
    recorder.observe({ type: 'session.input_transcript.delta', delta: 'привет', start_ms: 0, end_ms: 300 });
    await memory.endCall(recorder);
  };
  await call();
  assert.equal(requests.length, 1, `${DREAM_EPISODES} episodes are not yet enough`);
  assert.match(requests[0].body.messages[0].content, / · episode · 2026-09-20 · - · Говорили про погода/);
  await store.apply(episodes(DREAM_EPISODES + 1).slice(DREAM_EPISODES), { origin: 'inferred', now });
  await call();
  assert.equal(requests.length, 3, 'one more episode: extraction and a dream');
  assert.match(requests[2].body.messages[0].content, /консолидация/);
  assert.match(requests[2].body.messages[0].content, /какой бы давности они ни были/);
  await call();
  assert.equal(requests.length, 4, 'right after a dream the episode count alone does not start another');
});

test('memory from before cards is sorted by a dream soon after the next call, and only while there are no cards', async () => {
  const { store, memory, requests } = await service([]);
  await store.update(s => { s.lastDreamAt = new Date(now.getTime() - 4 * 3600 * 1000).toISOString(); }, now);
  await store.apply([{ op: 'add', text: 'Маму зовут Оля', kind: 'fact', sensitive: false, when: null }], { origin: 'inferred', now });
  const call = async () => {
    const recorder = memory.startCall('rtc')!;
    recorder.observe({ type: 'session.input_transcript.delta', delta: 'привет', start_ms: 0, end_ms: 300 });
    await memory.endCall(recorder);
  };
  await call();
  assert.equal(requests.length, 2, 'extraction and a dream');
  assert.match(requests[1].body.messages[0].content, /Разложи по карточкам записи без карточек/);
  await store.update(s => { s.lastDreamAt = new Date(now.getTime() - 4 * 3600 * 1000).toISOString(); }, now);
  await store.apply([{ op: 'card', id: null, kind: 'person', title: 'Мама', aliases: [], summary: '' }], { origin: 'inferred', now });
  await call();
  assert.equal(requests.length, 3, 'once there are cards, only extraction');
});

test('threads nobody mentioned for a week are closed before the call and do not reach the prompt', async () => {
  const { store, memory } = await service([], 'involved');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000);
  await store.apply([{ op: 'add', text: 'Записать ребёнка в садик', kind: 'thread', sensitive: false, when: null }], { origin: 'inferred', now: daysAgo(11) });
  await store.apply([{ op: 'add', text: 'Встреча с Олегом', kind: 'thread', sensitive: false, when: '2026-09-12' }], { origin: 'inferred', now: daysAgo(12) });
  await store.apply([{ op: 'add', text: 'Отпуск в Лиссабоне', kind: 'thread', sensitive: false, when: '2026-10-05' }], { origin: 'inferred', now: daysAgo(10) });
  await store.apply([{ op: 'add', text: 'Купить батарейки', kind: 'thread', sensitive: false, when: null }], { origin: 'inferred', now: daysAgo(2) });
  await store.apply([{ op: 'add', text: 'Любит бургеры', kind: 'preference', sensitive: false, when: null }], { origin: 'inferred', now: daysAgo(30) });
  const context = await memory.context();
  const open = store.state.facts.filter(f => !f.closedAt).map(f => f.text);
  assert.deepEqual(open.sort(), ['Купить батарейки', 'Любит бургеры', 'Отпуск в Лиссабоне'], 'an old undated thread and a long-past event close; a future event, a fresh thread and other records stay');
  assert.doesNotMatch(context.section, /садик|Олегом/);
  assert.match(context.section, /Купить батарейки/);
});
