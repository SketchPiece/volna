import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSideband } from '../realtime/sideband.ts';
import { z } from 'zod';
import { defineTool, ToolRegistry } from '../assistant/tools/registry.ts';
import { endCall } from '../assistant/tools/end-call.ts';
import { silentLogger } from '../log.ts';
import { FakeSocket, toolCaller } from '../test-support.ts';
import { CallTrace } from '../telemetry/trace.ts';
import { GoodbyeWatcher, GOODBYE_NOTE, GOODBYE_CANCEL_NOTE, CALLBACK_NOTE, type GoodbyeMode } from './goodbye.ts';
import type { DecisionModel, JevRequest, JevResponse } from './client.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const answers = (goodbye: number): JevResponse => ({ model: 'jev-test', answers: { goodbye: { type: 'noul', noul: goodbye } } });

function setup(mode: GoodbyeMode, respond: (request: JevRequest) => JevResponse | Promise<JevResponse>, farewellMaxMs = 200) {
  FakeSocket.reset();
  const requests: JevRequest[] = [];
  const jev: DecisionModel = { decide: async request => { requests.push(request); return respond(request); } };
  const trace = new CallTrace({ callId: 'live_1', config: {} });
  const caller = toolCaller();
  const watcher = new GoodbyeWatcher({ jev, mode, threshold: 0.9, log: silentLogger, callId: 'live_1', trace, debounceMs: 5 });
  attachSideband({ apiKey: 'k', callId: 'live_1', tools: new ToolRegistry([endCall]), log: silentLogger, timeZone: 'UTC', socketFactory: FakeSocket.factory, trace, listeners: [watcher, caller], farewellQuietMs: 20, farewellMaxMs });
  const socket = FakeSocket.instances[0]!;
  const say = (delta: string) => socket.message({ type: 'session.input_transcript.delta', delta });
  const notes = () => socket.sent.filter((e: any) => e.type === 'session.thinking.append').map((e: any) => e.content as string);
  const actions = () => trace.events.filter(e => e.type === 'jev.result').map(e => e.action);
  return { socket, say, notes, actions, requests, trace, control: caller.control() };
}

test('Jev is asked only about the goodbye, once per phrase, with the conversation as state', async () => {
  const { socket, say, requests, actions, notes } = setup('on', () => answers(0.02));
  say('который');
  say(' час?');
  await wait(30);
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]!.questions), ['goodbye']);
  assert.deepEqual((requests[0]!.state as any).conversation, [{ role: 'user', text: 'который час?' }]);
  assert.deepEqual(actions(), ['below']);
  assert.deepEqual(notes(), []);
  socket.close();
});

test('shadow mode only records what Jev would do', async () => {
  const { socket, say, notes, actions } = setup('shadow', () => answers(0.99));
  say('пока');
  await wait(30);
  assert.deepEqual(actions(), ['shadow_goodbye']);
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(notes(), []);
  socket.close();
});

test('an answer about a phrase the user has since extended is dropped', async () => {
  const releases: (() => void)[] = [];
  const { socket, say, notes } = setup('on', () => new Promise(resolve => { releases.push(() => resolve(answers(0.99))); }));
  say('пока');
  await wait(15);
  say(' не надо');
  releases[0]!();
  await wait(15);
  assert.deepEqual(notes(), [], 'the first answer is about an outdated phrase');
  releases[1]!();
  await wait(5);
  socket.close();
});

test('goodbye arms the call end at once; the session closes after the farewell without the backend', async () => {
  const { socket, say, notes, trace } = setup('on', () => answers(0.97));
  say('всё, спасибо, пока');
  await wait(30);
  assert.deepEqual(notes(), [GOODBYE_NOTE]);
  assert.ok(trace.events.some(e => e.type === 'endcall.armed' && e.origin === 'prefetch'));
  socket.message({ type: 'session.output_transcript.delta', delta: 'До связи' });
  await wait(40);
  assert.deepEqual(socket.sent.at(-1), { type: 'session.close' });
  socket.close();
});

test('the user speaking again cancels a guessed goodbye and tells Live; a confirmed end_call cannot be cancelled', async () => {
  let goodbye = 0.97;
  const { socket, say, notes } = setup('on', () => answers(goodbye), 60);
  say('пока');
  await wait(20);
  goodbye = 0.02;
  say(' не надо, подожди');
  await wait(80);
  assert.deepEqual(notes(), [GOODBYE_NOTE, GOODBYE_CANCEL_NOTE]);
  assert.ok(!socket.sent.some((e: any) => e.type === 'session.close'), 'the call stays open');
  socket.close();

  goodbye = 0.97;
  const confirmed = setup('on', () => answers(goodbye), 60);
  confirmed.say('пока');
  await wait(20);
  await confirmed.control.runTool('end_call', {});
  await wait(5);
  goodbye = 0.02;
  confirmed.say(' спасибо');
  await wait(80);
  assert.deepEqual(confirmed.socket.sent.at(-1), { type: 'session.close' }, 'end_call confirmed, so the call ends');
  confirmed.socket.close();
});

test('a farewell spoken before the guess still closes the call after the quiet gap, not the maximum', async () => {
  const { socket, say } = setup('on', () => answers(0.97), 1000);
  say('всё, спасибо, пока');
  socket.message({ type: 'session.output_transcript.delta', delta: 'До свидания.' });
  await wait(60);
  assert.deepEqual(socket.sent.at(-1), { type: 'session.close' }, 'closed after 20 ms of quiet, not after 1000 ms');
  socket.close();
});

test('Jev failures are recorded and never touch the call', async () => {
  const { socket, say, trace } = setup('on', () => { throw Object.assign(new Error('x'), { status: 529 }); });
  say('алло');
  await wait(30);
  assert.ok(trace.events.some(e => e.type === 'jev.error' && e.status === 529));
  assert.deepEqual(socket.sent, []);
  socket.close();
});

function callbackSetup(running: boolean, response: Record<string, number>, callBack = true) {
  FakeSocket.reset();
  const requests: JevRequest[] = [];
  const jev: DecisionModel = { decide: async request => {
    requests.push(request);
    return { model: 'jev-test', answers: Object.fromEntries(Object.entries(response).filter(([q]) => request.questions[q]).map(([q, p]) => [q, { type: 'noul', noul: p }])) } as JevResponse;
  } };
  const calls: string[] = [];
  const back = defineTool({ name: 'tasks_call_back', effect: 'write', description: 'x', parameters: z.object({}), execute: () => { calls.push('tasks_call_back'); return { callBack }; } });
  const trace = new CallTrace({ callId: 'live_1', config: {} });
  const watcher = new GoodbyeWatcher({ jev, mode: 'on', threshold: 0.9, log: silentLogger, callId: 'live_1', trace, debounceMs: 5, workRunning: () => running });
  attachSideband({ apiKey: 'k', callId: 'live_1', tools: new ToolRegistry([endCall, back]), log: silentLogger, timeZone: 'UTC', socketFactory: FakeSocket.factory, trace, listeners: [watcher], farewellQuietMs: 20, farewellMaxMs: 200 });
  const socket = FakeSocket.instances[0]!;
  const notes = () => socket.sent.filter((e: any) => e.type === 'session.thinking.append').map((e: any) => e.content as string);
  const actions = () => trace.events.filter(e => e.type === 'jev.result').map(e => e.action);
  return { socket, requests, calls, notes, actions, say: (delta: string) => socket.message({ type: 'session.input_transcript.delta', delta }) };
}

test('«пока, перезвони» while work runs: the core records the call back and ends the call without the model', async () => {
  const { socket, requests, calls, notes, actions, say } = callbackSetup(true, { goodbye: 0.1, callback: 0.95 });
  say('пока, перезвони, как всё будет готово');
  await wait(60);
  assert.deepEqual(Object.keys(requests[0]!.questions).sort(), ['callback', 'goodbye']);
  assert.deepEqual(calls, ['tasks_call_back']);
  assert.deepEqual(actions(), ['callback']);
  assert.deepEqual(notes(), [CALLBACK_NOTE]);
  await wait(250);
  assert.ok(socket.sent.some((e: any) => e.type === 'session.close'), 'the call is closed');
  socket.close();
});

test('without running work Jev is not asked about a call back; nothing to call back about is a plain goodbye', async () => {
  const idle = callbackSetup(false, { goodbye: 0.1, callback: 0.95 });
  idle.say('пока, перезвони');
  await wait(40);
  assert.deepEqual(Object.keys(idle.requests[0]!.questions), ['goodbye']);
  assert.deepEqual(idle.calls, []);
  idle.socket.close();

  const nothing = callbackSetup(true, { goodbye: 0.1, callback: 0.95 }, false);
  nothing.say('пока, перезвони');
  await wait(40);
  assert.deepEqual(nothing.actions(), ['goodbye']);
  assert.deepEqual(nothing.notes(), [GOODBYE_NOTE]);
  nothing.socket.close();
});

// Звонок 26.09.2026: «Ты можешь мне перезвонить, когда она закончится» без «пока»; на пробе Jev давал таким фразам
// 0.89–0.92, ниже общего порога прощания 0.9, поэтому у перезвона свой порог.
test('a bare call-back request ends the call at the lower call-back threshold, a doubtful one does not', async () => {
  const bare = callbackSetup(true, { goodbye: 0.1, callback: 0.89 });
  bare.say('ты можешь мне перезвонить, когда она закончится');
  await wait(60);
  assert.deepEqual(bare.calls, ['tasks_call_back']);
  assert.deepEqual(bare.actions(), ['callback']);
  bare.socket.close();

  const question = callbackSetup(true, { goodbye: 0.1, callback: 0.38 });
  question.say('а ты можешь перезванивать, когда работа заканчивается?');
  await wait(40);
  assert.deepEqual(question.calls, []);
  assert.deepEqual(question.actions(), ['below']);
  question.socket.close();
});
