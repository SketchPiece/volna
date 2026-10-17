import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './registry.ts';
import { aboutWave } from './about-wave.ts';
import { silentLogger } from '../../log.ts';

const context = { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => new Date() };

test('about_wave returns the whole legend by default and one topic on request', async () => {
  const registry = new ToolRegistry([aboutWave]);
  const all = JSON.parse(await registry.call('about_wave', '{}', context));
  assert.match(all.name, /Вычислительный Оркестр Логических Нейронных Агентов/);
  assert.match(all.origin, /Андрей/);
  const one = JSON.parse(await registry.call('about_wave', '{"topic":"creator"}', context));
  assert.deepEqual(Object.keys(one), ['creator', 'rules']);
  assert.doesNotMatch(JSON.stringify(all), /товарищ|лаборатори/i);
});
