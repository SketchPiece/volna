import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachSideband } from '../realtime/sideband.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { currentTime } from '../assistant/tools/current-time.ts';
import { silentLogger } from '../log.ts';
import { FakeSocket, fakeDelegation, live, offer, post, run, scriptedModel } from '../test-support.ts';
import { CallTrace } from '../telemetry/trace.ts';
import { ClientDelegate } from '../delegation/client.ts';
import type { ChatModel, ChatResult } from '../delegation/llm.ts';
import { ConsoleHub } from './hub.ts';
import { ConsoleStore, type ConsoleRecord } from './store.ts';
import { consoleApp } from './routes.ts';

// Закрытый sideband снимает свой таймер жизни, иначе процесс теста не завершится.
afterEach(() => { for (const socket of FakeSocket.instances) if (!socket.closedByUs) socket.close(); });

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const reply = (content: string): ChatResult => ({ content, toolCalls: [], usage: { inTokens: 1, outTokens: 1 } });

/** Модель, которая считает вызовы; `hang` держит ответ до отмены. */
function countingModel(content: string, hang = false): ChatModel & { calls: number; aborted: boolean } {
  const model = {
    model: 'fake/model', calls: 0, aborted: false,
    complete: async (_m: unknown, _t: unknown, signal: AbortSignal) => {
      model.calls++;
      if (hang) await new Promise((_, reject) => signal.addEventListener('abort', () => { model.aborted = true; reject(new DOMException('aborted', 'AbortError')); }));
      return reply(content);
    }
  };
  return model;
}

function setup(model: ChatModel, holdMs = 1000) {
  FakeSocket.reset();
  const hub = new ConsoleHub({ log: silentLogger, holdMs });
  const call = hub.startCall('live_1', { model: 'gpt-live-1', voice: 'meridian' });
  const trace = new CallTrace({ callId: 'live_1', config: {}, onMark: event => call.mark(event) });
  const tools = new ToolRegistry([currentTime]);
  const delegate = new ClientDelegate({
    models: { simple: model, standard: model }, tools, instructions: 'Ты бэкенд.', timeZone: 'UTC', log: silentLogger, callId: 'live_1', trace,
    settleMs: 5, maxSettleMs: 20, gate: hub.gate(call)
  });
  attachSideband({ apiKey: 'k', callId: 'live_1', tools, log: silentLogger, timeZone: 'UTC', socketFactory: FakeSocket.factory, trace,
    listeners: [call.listener(), delegate], onSend: event => call.sent(event) });
  const socket = FakeSocket.instances[0]!;
  const commentary = () => socket.sent.filter((e: any) => e.type === 'session.commentary.append') as any[];
  const delegate_ = (id: string) => socket.message({ type: 'session.delegation.created', delegation: { id, target: 'client' } });
  socket.message({ type: 'session.input_transcript.delta', delta: 'поставь напоминание' });
  return { hub, call, socket, commentary, delegate: delegate_ };
}

test('in manual mode a delegation waits for the console and gets its text instead of the model', async () => {
  const model = countingModel('от модели');
  const { hub, call, commentary, delegate } = setup(model);
  hub.setMode('manual');
  delegate('d1');
  await wait(60);
  assert.equal(commentary().length, 0);
  const context = call.events.find(e => e.type === 'console.context');
  assert.deepEqual((context?.data as any).turns, [{ role: 'user', text: 'поставь напоминание' }]);
  assert.ok(call.events.some(e => e.type === 'console.hold'));

  assert.equal(hub.answer('live_1', 'd1', { kind: 'text', text: 'Напоминание стоит на девять.' }), true);
  await wait(10);
  assert.deepEqual(commentary(), [{ type: 'session.commentary.append', delegation_id: 'd1', content: 'Напоминание стоит на девять.' }]);
  assert.equal(model.calls, 0);
  // Отправленное ядром и решение консоли попали в запись звонка.
  assert.ok(call.events.some(e => e.k === 'out' && e.type === 'session.commentary.append'));
  assert.ok(call.events.some(e => e.type === 'console.decision' && (e.data as any).by === 'operator'));
  assert.ok(call.events.some(e => e.k === 'mark' && e.type === 'client.manual'));
  assert.equal(hub.answer('live_1', 'd1', { kind: 'failure' }), false, 'second answer is refused');
});

test('an unanswered manual delegation goes to the model after the hold time', async () => {
  const model = countingModel('Ответ модели.');
  const { hub, call, commentary, delegate } = setup(model, 40);
  hub.setMode('manual');
  delegate('d1');
  await wait(120);
  assert.equal(model.calls, 1);
  assert.equal(commentary()[0].content, 'Ответ модели.');
  assert.ok(call.events.some(e => e.type === 'console.decision' && (e.data as any).by === 'timeout'));
});

test('a preset answers only the next delegation, then the mode returns to auto', async () => {
  const model = countingModel('Ответ модели.');
  const { hub, commentary, delegate } = setup(model);
  hub.setMode('next', { kind: 'failure' });
  delegate('d1');
  await wait(60);
  assert.equal(hub.mode, 'auto');
  assert.equal(model.calls, 0);
  assert.match(commentary()[0].content, /Не получилось/);
  delegate('d2');
  await wait(60);
  assert.equal(model.calls, 1);
  assert.equal(commentary()[1].delegation_id, 'd2');
});

test('silence sends nothing to the model', async () => {
  const { hub, commentary, delegate } = setup(countingModel('x'));
  hub.setMode('next', { kind: 'silence' });
  delegate('d1');
  await wait(60);
  assert.equal(commentary().length, 0);
});

test('the console takes over an automatic answer that is still running', async () => {
  const model = countingModel('поздно', true);
  const { hub, commentary, delegate } = setup(model);
  delegate('d1');
  await wait(60);
  assert.equal(model.calls, 1);
  assert.equal(hub.answer('live_1', 'd1', { kind: 'text', text: 'Сам отвечу.' }), true);
  await wait(20);
  assert.equal(model.aborted, true);
  assert.deepEqual(commentary().map(c => c.content), ['Сам отвечу.']);
});

test('console appends reach the session and are marked as coming from the console', async () => {
  const { hub, call, socket } = setup(countingModel('x'));
  assert.equal(hub.append('live_1', 'thinking', null, 'Пользователь за рулём.'), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'session.thinking.append', delegation_id: null, content: 'Пользователь за рулём.' });
  const i = call.events.findIndex(e => e.type === 'console.append');
  assert.equal(call.events[i + 1]?.type, 'session.thinking.append');
  socket.close();
  assert.equal(hub.append('live_1', 'thinking', null, 'после звонка'), false);
});

test('the store keeps only the latest records and refuses odd ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'console-'));
  try {
    const store = new ConsoleStore(dir, 2);
    const record = (callId: string, startedAt: string): ConsoleRecord => ({ version: 1, callId, startedAt, durationMs: 1000, info: { model: 'm', voice: 'v' }, events: [
      { t: 10, k: 'in', type: 'session.delegation.created', data: {} }, { t: 20, k: 'in', type: 'error', data: {} }
    ] });
    await store.save(record('a', '2026-09-25T10:00:00.000Z'));
    await store.save(record('b', '2026-09-25T11:00:00.000Z'));
    const newest = await store.save(record('c', '2026-09-25T12:00:00.000Z'));
    const list = await store.list();
    assert.deepEqual(list.map(r => r.callId), ['c', 'b']);
    assert.deepEqual([list[0]!.delegations, list[0]!.errors], [1, 1]);
    assert.equal((await readdir(dir)).length, 2);
    assert.equal((await store.read(newest))?.callId, 'c');
    assert.equal(await store.read('../memory'), null);
    assert.equal(await store.delete('../memory'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the console answers only this Mac and only its own page may change things', async () => {
  const hub = new ConsoleHub({ log: silentLogger });
  const app = consoleApp({ hub, port: 25452 });
  const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(`http://127.0.0.1:25452${path}`, { ...init, headers: { host: '127.0.0.1:25452', ...init.headers } });

  assert.equal((await req('/live', { headers: { host: 'evil.example:25452' } })).status, 403);
  const page = await req('/live');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Консоль ядра<\/title>/);

  const put = (headers: Record<string, string>, body: unknown) => req('/api/mode', { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await put({}, { mode: 'manual' })).status, 403);
  assert.equal((await put({ origin: 'https://evil.example' }, { mode: 'manual' })).status, 403);
  assert.equal((await put({ origin: 'http://127.0.0.1:25452' }, { mode: 'next' })).status, 400);
  const ok = await put({ origin: 'http://localhost:25452' }, { mode: 'manual' });
  assert.equal(ok.status, 200);
  assert.equal(hub.mode, 'manual');
  assert.equal((await req('/api/calls/none/append', { method: 'POST', headers: { origin: 'http://127.0.0.1:25452', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'thinking', delegationId: null, content: 'x' }) })).status, 409);
});

test('a call through the core is visible in the console and saved to history when it ends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'console-'));
  FakeSocket.reset();
  try {
    const store = new ConsoleStore(dir);
    const hub = new ConsoleHub({ log: silentLogger, store });
    const seen: string[] = [];
    hub.subscribe(message => seen.push(message.type));
    await run({ apiKey: 'k', fetchImpl: async () => live(), socketFactory: FakeSocket.factory, console: hub, clientDelegation: fakeDelegation(scriptedModel(reply('Готово.'))) }, async url => {
      assert.equal((await post(url, offer)).status, 200);
      const socket = FakeSocket.instances[0]!;
      socket.message({ type: 'session.input_transcript.delta', delta: 'который час' });
      socket.message({ type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } });
      await wait(700);
      const events = hub.snapshot().calls[0]!.events;
      assert.ok(events.some(e => e.k === 'mark' && e.type === 'client.context'), 'core marks reach the console even without metrics');
      assert.ok(events.some(e => e.k === 'out' && e.type === 'session.commentary.append'));
      socket.close();
      await wait(50);
    });
    assert.deepEqual(seen.filter(t => t === 'call' || t === 'end'), ['call', 'end']);
    const [saved] = await store.list();
    assert.equal(saved?.callId, 'live_1');
    assert.equal(saved?.delegations, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
