import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTools } from './assistant/tools/index.ts';
import { MemoryStore } from './memory/store.ts';
import { MemoryService } from './memory/service.ts';
import { memoryTools } from './memory/tools.ts';
import { SkillStore } from './skills/store.ts';
import { techCardTools } from './skills/tools.ts';
import { OPENROUTER_CHAT_URL } from './delegation/llm.ts';
import { LIVE_SESSIONS_URL } from './realtime/openai-calls.ts';
import { silentLogger } from './log.ts';
import { TaskStore } from './tasks/store.ts';
import { run, post, offer, json, live, FakeSocket, tick, fakeDelegation, scriptedModel } from './test-support.ts';

const now = new Date('2026-09-22T10:00:00Z');

/** Ядро с памятью, поддельным OpenAI (звонки и модель памяти) и поддельным sideband. */
async function server(level: 'cold' | 'explicit' | 'attentive' | 'involved', exercise: (url: string, store: MemoryStore, sessions: any[], offered: string[][]) => Promise<void>) {
  FakeSocket.reset();
  const store = new MemoryStore(await mkdtemp(join(tmpdir(), 'wave-flow-')));
  await store.update(s => { s.level = level; }, now);
  const sessions: any[] = [];
  const fetchImpl = (async (url: string, options: any) => {
    if (url === LIVE_SESSIONS_URL) {
      sessions.push(JSON.parse(options.body).session);
      return live(offer, 'live_flow');
    }
    assert.equal(url, OPENROUTER_CHAT_URL);
    const update = { profile: 'Любит кофе.', operations: [{ op: 'add', text: 'Пьёт кофе по утрам', kind: 'preference', sensitive: false, when: null }] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(update) } }] }));
  }) as unknown as typeof fetch;
  const memory = new MemoryService({ store, log: silentLogger, now: () => now, extractor: { apiKey: 'secret', model: 'mini', timeZone: 'UTC', log: silentLogger, fetchImpl } });
  // Делегирование сначала зовёт remember, затем отвечает: так память пишется в звонке.
  const model = scriptedModel(
    { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'remember', arguments: '{"text":"Сестру зовут Аня"}' } }], usage: { inTokens: null, outTokens: null } },
    { content: 'Запомнила.', toolCalls: [], usage: { inTokens: null, outTokens: null } }
  );
  // Какие инструменты звонка видит модель делегирования (в голосовом промпте их списка нет).
  const offered: string[][] = [];
  const spy: typeof model = { ...model, complete: async (messages, tools, signal) => {
    offered.push(tools.map(t => t.function.name));
    // Проба `delegatedOnce` только смотрит на инструменты: память она не трогает.
    if (messages.at(-1)?.content === PROBE) return { content: 'Десять часов.', toolCalls: [], usage: { inTokens: null, outTokens: null } };
    return model.complete(messages, tools, signal);
  } };
  await run({ apiKey: 'secret', token: 't', tools: defaultTools([...memoryTools(store), ...techCardTools(new SkillStore({ ownerDir: join(store.dir, 'skills') }))]), memory, socketFactory: FakeSocket.factory, fetchImpl, clientDelegation: fakeDelegation(spy) },
    url => exercise(url, store, sessions, offered));
  await memory.idle;
  return store;
}

const auth = { Authorization: 'Bearer t' };

/** Одно делегирование в звонке: ждёт ответа ядра, чтобы увидеть инструменты, которые получила модель. */
const PROBE = 'который час';
async function delegatedOnce(socket: any) {
  socket.message({ type: 'session.input_transcript.delta', delta: PROBE });
  socket.message({ type: 'session.delegation.created', delegation: { id: 'item_probe', type: 'delegation', target: 'client' } });
  for (let i = 0; i < 200 && !socket.sent.some((e: any) => e.type === 'session.commentary.append'); i++) await new Promise(resolve => setTimeout(resolve, 5));
}

test('attentive: session carries memory section and memory tools; built-in transcript deltas are recorded and extracted on close', async () => {
  const store = await server('attentive', async (url, _store, sessions, offered) => {
    await _store.apply([{ op: 'add', text: 'Живёт в Берлине', kind: 'fact', sensitive: false, when: null }], { origin: 'explicit', now });
    assert.equal((await post(url, offer, auth)).status, 200);
    const [session] = sessions;
    assert.match(session.instructions, /Память\. Уровень близости: «Замечает сама»/);
    assert.match(session.instructions, /Живёт в Берлине/);
    assert.match(session.instructions, /Приветствие:/);
    // Эксперимент 363cc0e: имена инструментов снова в голосовых инструкциях.
    assert.match(session.instructions, /Инструменты бэкенда: .*techcard_read/);
    await tick();
    const [socket] = FakeSocket.instances;
    await delegatedOnce(socket!);
    for (const name of ['about_wave', 'end_call', 'remember', 'forget', 'recall', 'techcard_read', 'techcard_write', 'techcard_delete']) assert.ok(offered[0]!.includes(name), name);
    assert.ok(!offered[0]!.includes('current_time'), 'the time is in the instructions, the model does not get current_time');
    socket!.message({ type: 'session.input_transcript.delta', delta: 'Я пью кофе', start_ms: 0, end_ms: 800 });
    socket!.message({ type: 'session.input_transcript.delta', delta: ' по утрам', start_ms: 800, end_ms: 1400 });
    socket!.message({ type: 'session.output_transcript.delta', delta: 'Понятно.', start_ms: 1900, end_ms: 2400 });
    socket!.close();
  });
  assert.deepEqual(store.state.facts.map(f => f.text), ['Живёт в Берлине', 'Пьёт кофе по утрам']);
  assert.equal(store.state.profile, 'Любит кофе.');
  assert.equal((await store.listTranscripts()).length, 1);
});

test('cold: no memory section, no memory tools, nothing recorded', async () => {
  const store = await server('cold', async (url, _store, sessions, offered) => {
    assert.equal((await post(url, offer, auth)).status, 200);
    const [session] = sessions;
    assert.doesNotMatch(session.instructions, /Память\./);
    await tick();
    await delegatedOnce(FakeSocket.instances[0]!);
    assert.ok(offered[0]!.includes('about_wave'));
    assert.ok(!offered[0]!.some(name => ['remember', 'forget', 'recall', 'history_read', 'techcard_read'].includes(name)), 'cold: no memory or tech card tools');
    FakeSocket.instances[0]!.message({ type: 'session.input_transcript.delta', delta: 'секрет', start_ms: 0, end_ms: 500 });
    FakeSocket.instances[0]!.close();
  });
  assert.deepEqual(store.state.facts, []);
  assert.deepEqual(await store.listTranscripts(), []);
});

test('explicit: memory tools without recording; remember from the delegation is saved and the answer goes to Live', async () => {
  const store = await server('explicit', async (url, _store, sessions) => {
    assert.equal((await post(url, offer, auth)).status, 200);
    assert.match(sessions[0].instructions, /только по явной просьбе/);
    await tick();
    const socket = FakeSocket.instances[0]!;
    socket.message({ type: 'session.input_transcript.delta', delta: 'запомни, сестру зовут Аня' });
    socket.message({ type: 'session.delegation.created', delegation: { id: 'item_c1', type: 'delegation', target: 'client' } });
    const commentary = () => socket.sent.filter((e: any) => e.type === 'session.commentary.append') as any[];
    for (let i = 0; i < 200 && !commentary().length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(commentary()[0].content, /Запомнила/);
    socket.close();
  });
  assert.equal(store.state.facts[0]!.origin, 'explicit');
});

test('memory API: requires the core token, exposes notes, changes level, deletes and wipes', async () => {
  await server('involved', async (url, store) => {
    assert.equal((await fetch(`${url}/memory`)).status, 401);
    await store.apply([{ op: 'add', text: 'Играет в теннис', kind: 'fact', sensitive: false, when: null }], { origin: 'inferred', now });
    let view = await json(await fetch(`${url}/memory`, { headers: auth }));
    assert.equal(view.level, 'involved');
    assert.equal(view.levelTitle, 'Вовлечённая');
    assert.equal(view.levels.length, 4);
    assert.equal(view.facts[0].text, 'Играет в теннис');
    assert.equal(view.transcripts, 0);

    const bad = await fetch(`${url}/memory/settings`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'hot' }) });
    assert.equal(bad.status, 400);
    view = await json(await fetch(`${url}/memory/settings`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'cold', allowSensitive: true }) }));
    assert.equal(view.level, 'cold');
    assert.equal(view.allowSensitive, true);
    assert.equal((await json(await fetch(`${url}/health`))).memory, 'cold');

    view = await json(await fetch(`${url}/memory/facts`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Любит джаз' }) }));
    assert.equal(view.facts.length, 2);
    const jazz = view.facts.find((f: any) => f.text === 'Любит джаз');
    assert.equal(jazz.origin, 'explicit');
    const tennis = view.facts.find((f: any) => f.text === 'Играет в теннис');
    view = await json(await fetch(`${url}/memory/facts/${tennis.id}`, { method: 'DELETE', headers: auth }));
    assert.deepEqual(view.facts.map((f: any) => f.text), ['Любит джаз']);
    assert.equal((await fetch(`${url}/memory/facts/nope`, { method: 'DELETE', headers: auth })).status, 404);
    await store.apply([
      { op: 'card', id: null, kind: 'person', title: 'Мама', aliases: [], summary: 'Живёт в Берлине' },
      { op: 'add', text: 'Мама любит розы', kind: 'preference', sensitive: false, when: null, cards: ['Мама'] }
    ], { origin: 'inferred', now });
    view = await json(await fetch(`${url}/memory`, { headers: auth }));
    const mom = view.cards.find((c: any) => c.title === 'Мама');
    assert.equal(view.categories.length, 7);
    assert.deepEqual(view.facts.find((f: any) => f.text === 'Мама любит розы').cards, [mom.id]);
    view = await json(await fetch(`${url}/memory/cards/${mom.id}`, { method: 'DELETE', headers: auth }));
    assert.deepEqual(view.cards, []);
    assert.deepEqual(view.facts.map((f: any) => f.text), ['Любит джаз'], 'the card takes its notes with it');
    assert.equal((await fetch(`${url}/memory/cards/nope`, { method: 'DELETE', headers: auth })).status, 404);
    view = await json(await fetch(`${url}/memory`, { method: 'DELETE', headers: auth }));
    assert.deepEqual(view.facts, []);
    assert.equal(view.level, 'cold', 'settings survive a wipe');
  });
});

/**
 * Нить для приветствия (вопрос о теме из памяти) отмечается поднятой только после принятого звонка, как и фраза приветствия;
 * перезвон и готовые итоги работы её не выбирают и не сжигают. `answers`: коды ответа OpenAI по очереди (201 — принят).
 */
async function threadCalls(answers: number[], exercise: (url: string, sessions: any[]) => Promise<void>, tasks?: TaskStore) {
  const store = new MemoryStore(await mkdtemp(join(tmpdir(), 'wave-thread-')));
  await store.update(s => { s.level = 'involved'; }, now);
  await store.apply([{ op: 'add', text: 'Экзамен', kind: 'thread', sensitive: false, when: '2026-09-20' }], { origin: 'inferred', now });
  const sessions: any[] = [];
  const fetchImpl = (async (_url: string, options: any) => {
    sessions.push(JSON.parse(options.body).session);
    const status = answers.shift() ?? 201;
    return status === 201 ? live(offer, null) : new Response('{}', { status });
  }) as unknown as typeof fetch;
  const memory = new MemoryService({ store, log: silentLogger, now: () => now, extractor: { apiKey: 'secret', model: 'mini', timeZone: 'UTC', log: silentLogger, fetchImpl } });
  await run({ apiKey: 'secret', memory, tasks, fetchImpl }, url => exercise(url, sessions));
  await tick();
  return store.state.facts.find(f => f.text === 'Экзамен')!;
}

const asksThread = /Нить для приветствия: Экзамен/;

test('a failed POST /session does not use up the greeting thread; the accepted call does', async () => {
  const fact = await threadCalls([500, 201], async (url, sessions) => {
    assert.equal((await post(url)).status, 502);
    assert.equal((await post(url)).status, 200);
    assert.match(sessions[0].instructions, asksThread);
    assert.match(sessions[1].instructions, asksThread, 'the retry still asks about the thread');
  });
  assert.ok(fact.askedAt, 'the accepted call marks the thread as asked');
});

test('a callback neither raises nor uses up the thread; ready work pushes it to the next call', async () => {
  const tasks = new TaskStore(await mkdtemp(join(tmpdir(), 'wave-thread-tasks-')));
  await tasks.load();
  const done = await tasks.create({ title: 'Перелёты', prompt: 'p', callback: 'call' });
  await tasks.patch(done.id, { status: 'done', result: 'Лучший второй.', finishedAt: now.toISOString(), delivery: 'ringing' });
  const callback = await threadCalls([], async (url, sessions) => {
    assert.equal((await post(url, offer, { 'X-Callback-Task': done.id })).status, 200);
    assert.match(sessions[0].instructions, /Перезваниваю по заданию/);
    assert.doesNotMatch(sessions[0].instructions, /Нить для приветствия/);
  }, tasks);
  assert.equal(callback.askedAt, null);

  const pending = new TaskStore(await mkdtemp(join(tmpdir(), 'wave-thread-tasks-')));
  await pending.load();
  const ready = await pending.create({ title: 'Отели', prompt: 'p', callback: 'notify' });
  await pending.patch(ready.id, { status: 'done', result: 'Нашёл два.', finishedAt: now.toISOString(), delivery: 'pending' });
  const withResults = await threadCalls([], async (url, sessions) => {
    assert.equal((await post(url)).status, 200);
    // Правило приветствия об итогах убрано экспериментом 363cc0e (todo в greeting/composer.test.ts); итог в инструкциях есть.
    assert.match(sessions[0].instructions, /Готова работа, о которой пользователь ещё не слышал/);
    assert.doesNotMatch(sessions[0].instructions, /Нить для приветствия/);
  }, pending);
  assert.equal(withResults.askedAt, null, 'the thread waits for the next call');
});

test('a callback without results (no such task) is an ordinary call: it asks about the thread and uses it up', async () => {
  const tasks = new TaskStore(await mkdtemp(join(tmpdir(), 'wave-thread-tasks-')));
  await tasks.load();
  const fact = await threadCalls([], async (url, sessions) => {
    assert.equal((await post(url, offer, { 'X-Callback-Task': '0123456789abcdef' })).status, 200);
    assert.match(sessions[0].instructions, asksThread);
    assert.doesNotMatch(sessions[0].instructions, /Перезваниваю по заданию/);
  }, tasks);
  assert.ok(fact.askedAt);
});
