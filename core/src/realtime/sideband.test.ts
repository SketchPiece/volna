import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { attachSideband } from './sideband.ts';
import { defineTool, ToolRegistry } from '../assistant/tools/registry.ts';
import { silentLogger } from '../log.ts';
import { endCall } from '../assistant/tools/end-call.ts';
import { FakeSocket, tick, toolCaller } from '../test-support.ts';

const echo = defineTool({
  name: 'echo', effect: 'read', description: 'Echoes text.', parameters: z.object({ text: z.string() }),
  execute: ({ text }) => ({ echoed: text })
});

function attach(tools = new ToolRegistry([echo]), options: { farewellQuietMs?: number; farewellMaxMs?: number } = {}) {
  FakeSocket.reset();
  const caller = toolCaller();
  const sideband = attachSideband({ apiKey: 'k', callId: 'rtc_1', tools, log: silentLogger, timeZone: 'UTC', socketFactory: FakeSocket.factory, listeners: [caller], ...options });
  return { sideband, socket: FakeSocket.instances[0]!, control: caller.control() };
}

test('core tools run through the control and return their output; Live gets nothing, function calls from Live are ignored', async () => {
  const { socket, control } = attach();
  socket.emit('open', {});
  socket.message({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'echo', arguments: '{"text":"no"}' } } });
  assert.equal(await control.runTool('echo', { text: 'hi' }), '{"echoed":"hi"}');
  assert.equal(await control.runTool('echo', '{"text":"raw"}'), '{"echoed":"raw"}');
  await tick();
  assert.deepEqual(socket.sent, []);
  socket.close();
});

test('nothing is sent on open: the greeting is requested by the phone after session.started', () => {
  FakeSocket.reset();
  attachSideband({ apiKey: 'k', callId: 'live_1', tools: new ToolRegistry([echo]), log: silentLogger, timeZone: 'UTC', socketFactory: FakeSocket.factory });
  const socket = FakeSocket.instances[0]!;
  assert.equal(socket.url, 'wss://api.openai.com/v1/live/sessions/live_1/attach');
  socket.emit('open', {});
  assert.deepEqual(socket.sent, []);
  socket.close();
});

test('unknown tools and bad arguments are reported as output, not thrown', async () => {
  const { socket, control } = attach();
  const outputs = await Promise.all([control.runTool('missing', {}), control.runTool('echo', { text: 5 }), control.runTool('echo', 'not json')]);
  assert.deepEqual(outputs.map(output => JSON.parse(output).error), ['unknown_tool', 'invalid_arguments', 'invalid_arguments']);
  socket.close();
});

test('malformed and unrelated events are ignored; close resolves the promise', async () => {
  const { sideband, socket } = attach();
  socket.emit('message', { data: '{not json' });
  socket.message({ type: 'error', error: { type: 'invalid_request_error', code: 'x' } });
  socket.message({ type: 'session.input_transcript.delta', delta: 'привет' });
  socket.message({ type: 'session.closed', reason: 'remote_hangup' });
  assert.deepEqual(socket.sent, []);
  socket.close();
  await sideband.closed;
});

test('a tool still running when the call ends sees its signal aborted', async () => {
  let seen: AbortSignal | undefined;
  const slow = defineTool({ name: 'slow', effect: 'read', description: 'Slow.', parameters: z.object({}), execute: (_args, context) => { seen = context.signal; return new Promise(() => {}); } });
  const { socket, control } = attach(new ToolRegistry([slow]));
  void control.runTool('slow', {});
  await tick();
  assert.equal(seen?.aborted, false);
  socket.close();
  assert.equal(seen?.aborted, true);
  assert.deepEqual(socket.sent, []);
});

test('end_call: the session closes after Volna\'s farewell goes quiet, and no later than the maximum', async () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const tools = new ToolRegistry([echo, endCall]);
  const { socket, control } = attach(tools, { farewellQuietMs: 30, farewellMaxMs: 200 });
  assert.equal(JSON.parse(await control.runTool('end_call', { reason: 'user_goodbye' })).ending, true);
  assert.equal(socket.sent.length, 0, 'no close yet');
  socket.message({ type: 'session.output_transcript.delta', delta: 'Пока', start_ms: 0, end_ms: 300 });
  await wait(20);
  socket.message({ type: 'session.output_transcript.delta', delta: ', до связи.', start_ms: 300, end_ms: 700 });
  await wait(20);
  assert.equal(socket.sent.length, 0, 'speech keeps the session open');
  await wait(25);
  assert.deepEqual(socket.sent, [{ type: 'session.close' }]);
  socket.close();

  const { socket: silent, control: silentControl } = attach(tools, { farewellQuietMs: 1000, farewellMaxMs: 40 });
  await silentControl.runTool('end_call', {});
  await wait(60);
  assert.deepEqual(silent.sent.at(-1), { type: 'session.close' });
  silent.close();
});

test('end_call without a sideband reports itself unavailable instead of pretending', async () => {
  const registry = new ToolRegistry([endCall]);
  const output = JSON.parse(await registry.call('end_call', '{}', { callId: 'x', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => new Date() }));
  assert.equal(output.error, 'end_call_unavailable');
});

test('a socket error after session.closed is the end of the call, not a failure; before it, it is a warning', async () => {
  for (const [closedFirst, level] of [[true, 'info'], [false, 'warn']] as const) {
    FakeSocket.reset();
    const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const log = { info: (message: string, fields?: any) => lines.push({ level: 'info', message, fields }), warn: (message: string, fields?: any) => lines.push({ level: 'warn', message, fields }) };
    const sideband = attachSideband({ apiKey: 'k', callId: 'rtc_1', tools: new ToolRegistry([echo]), log, timeZone: 'UTC', socketFactory: FakeSocket.factory });
    const socket = FakeSocket.instances[0]!;
    if (closedFirst) socket.message({ type: 'session.closed', reason: 'remote_hangup' });
    socket.emit('error', { message: 'Received network error or non-101 status code.' });
    socket.emit('close', { code: 1006 });
    await sideband.closed;
    const error = lines.find(l => l.message.startsWith('sideband error') || l.message.startsWith('sideband dropped'))!;
    assert.equal(error.level, level);
    if (!closedFirst) assert.equal(error.fields?.error, 'Received network error or non-101 status code.');
    assert.equal(lines.find(l => l.message === 'sideband closed')!.fields?.code, 1006);
  }
});
