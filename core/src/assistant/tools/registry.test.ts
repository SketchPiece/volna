import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool, ToolRegistry } from './registry.ts';
import { currentTime } from './current-time.ts';
import { silentLogger } from '../../log.ts';

const context = { callId: 'rtc', signal: new AbortController().signal, log: silentLogger, timeZone: 'Europe/Moscow', now: () => new Date('2026-09-22T09:05:00Z') };

test('definitions are OpenAI function tools with JSON Schema parameters', () => {
  const [definition] = new ToolRegistry([currentTime]).definitions();
  assert.equal(definition!.type, 'function');
  assert.equal(definition!.name, 'current_time');
  assert.equal(definition!.parameters.type, 'object');
  assert.ok('timeZone' in (definition!.parameters.properties as object));
});

test('tool names are validated and unique', () => {
  assert.throws(() => defineTool({ name: 'Bad Name', effect: 'read', description: 'x', parameters: z.object({}), execute: () => null }));
  assert.throws(() => new ToolRegistry([currentTime, currentTime]), /Duplicate/);
});

test('current_time answers in the user time zone and accepts an override', async () => {
  const registry = new ToolRegistry([currentTime]);
  const moscow = JSON.parse(await registry.call('current_time', '', context));
  assert.equal(moscow.timeZone, 'Europe/Moscow');
  assert.match(moscow.local, /12:05/);
  const tokyo = JSON.parse(await registry.call('current_time', '{"timeZone":"Asia/Tokyo"}', context));
  assert.match(tokyo.local, /18:05/);
  const bad = JSON.parse(await registry.call('current_time', '{"timeZone":"Mars/Olympus"}', context));
  assert.equal(bad.error, 'unknown_time_zone');
});

test('a throwing tool becomes a structured error without leaking the message', async () => {
  const boom = defineTool({ name: 'boom', effect: 'read', description: 'x', parameters: z.object({}), execute: () => { throw new Error('secret detail'); } });
  const output = await new ToolRegistry([boom]).call('boom', '{}', context);
  assert.deepEqual(JSON.parse(output), { error: 'tool_failed', name: 'boom' });
  assert.doesNotMatch(output, /secret/);
});

test('the tool passport is checked: Jev cards only on read tools and only for real arguments, routing names reserved', () => {
  const base = { description: 'x', parameters: z.object({ scope: z.enum(['a', 'b']) }), execute: () => null };
  assert.throws(() => defineTool({ ...base, name: 'x', effect: 'write', jev: { when: 'w' } }), /read tools/);
  assert.throws(() => defineTool({ ...base, name: 'x', effect: 'read', jev: { when: 'w', args: { other: { instructions: 'i', options: { a: 'a' } } } } }), /unknown argument other/);
  for (const name of ['escalate', 'offer_work', 'start_offered_work']) assert.throws(() => defineTool({ ...base, name, effect: 'read' }), /reserved/);
  assert.ok(defineTool({ ...base, name: 'x', effect: 'read', jev: { when: 'w', args: { scope: { instructions: 'i', options: { a: 'a', b: 'b' } } } } }));
});

test('a techcard narrows the registry to its tools plus always-on ones; Jev candidates come from the cards', async () => {
  const { endCall } = await import('./end-call.ts');
  const { aboutWave } = await import('./about-wave.ts');
  const { deviceTools } = await import('./device.ts');
  const registry = new ToolRegistry([currentTime, aboutWave, endCall, ...deviceTools]);
  assert.deepEqual(registry.only(['find_contact', 'missing_tool']).names(), ['end_call', 'find_contact']);
  assert.deepEqual(registry.only([]).names(), ['end_call']);
  assert.deepEqual(registry.jevCandidates().map(c => c.name), ['current_time', 'about_wave']);
  assert.equal(registry.effectOf('create_reminder'), 'write');
  assert.deepEqual(registry.issues('find_contact', { name: 'Дима' }), []);
  assert.ok(registry.issues('find_contact', {}).length);
});

test('work starters are known to the registry: the model offers them instead of calling', () => {
  const start = defineTool({ name: 'work_start', effect: 'act', startsWork: true, description: 'x', parameters: z.object({}), execute: () => ({}) });
  assert.deepEqual(new ToolRegistry([currentTime, start]).startNames(), ['work_start']);
});
