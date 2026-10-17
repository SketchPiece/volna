import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, openFacts } from './store.ts';
import { memoryTools, MEMORY_TOOL_NAMES } from './tools.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { silentLogger } from '../log.ts';

const now = new Date('2026-09-22T10:00:00Z');
const context = { callId: 'rtc_1', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => now };

test('remember stores explicit notes even when sensitive; forget closes matches; recall searches history', async () => {
  const store = new MemoryStore(await mkdtemp(join(tmpdir(), 'wave-tools-')));
  const registry = new ToolRegistry(memoryTools(store));
  assert.deepEqual(registry.names(), MEMORY_TOOL_NAMES.filter(name => !name.startsWith('techcard_')));
  const saved = JSON.parse(await registry.call('remember', JSON.stringify({ text: 'Аллергия на орехи', kind: 'fact' }), context));
  assert.deepEqual(saved, { saved: ['Аллергия на орехи'], duplicate: false });
  assert.equal(store.state.facts[0]!.origin, 'explicit');
  assert.equal(store.state.facts[0]!.callId, 'rtc_1');
  const again = JSON.parse(await registry.call('remember', JSON.stringify({ text: 'Аллергия на орехи' }), context));
  assert.equal(again.duplicate, true);
  await registry.call('remember', JSON.stringify({ text: 'Свадьба сестры', kind: 'thread', when: '2026-10-03' }), context);
  const recalled = JSON.parse(await registry.call('recall', JSON.stringify({ query: 'свадьба' }), context));
  assert.deepEqual(recalled.notes, ['Свадьба сестры (2026-10-03)']);
  const forgotten = JSON.parse(await registry.call('forget', JSON.stringify({ query: 'орехи' }), context));
  assert.deepEqual(forgotten.forgotten, ['Аллергия на орехи']);
  const history = JSON.parse(await registry.call('recall', JSON.stringify({ query: 'орехи' }), context));
  assert.deepEqual(history.notes, ['Аллергия на орехи (устарело)']);
  assert.deepEqual(JSON.parse(await registry.call('forget', JSON.stringify({ query: 'нет такого' }), context)), { forgotten: [] });
});

test('remember merges a reworded preference into the earlier one instead of saving it twice', async () => {
  const store = new MemoryStore(await mkdtemp(join(tmpdir(), 'wave-tools-')));
  const registry = new ToolRegistry(memoryTools(store));
  await registry.call('remember', JSON.stringify({ text: 'Андрей не пьет кофе после шести вечера', kind: 'preference' }), context);
  const reworded = JSON.parse(await registry.call('remember', JSON.stringify({ text: 'Любит кофе, но не пьёт его после шести вечера', kind: 'preference' }), context));
  assert.deepEqual(reworded, { saved: ['Любит кофе, но не пьёт его после шести вечера'], duplicate: true });
  assert.deepEqual(store.state.facts.map(f => [f.text, f.origin]), [['Любит кофе, но не пьёт его после шести вечера', 'explicit']]);
});

test('remember files a note on a card, recall returns the whole card, forget whole closes a card or a category', async () => {
  const store = new MemoryStore(await mkdtemp(join(tmpdir(), 'wave-tools-')));
  const registry = new ToolRegistry(memoryTools(store));
  await registry.call('remember', JSON.stringify({ text: 'Мама живёт в Берлине', about: 'Мама', category: 'person' }), context);
  await registry.call('remember', JSON.stringify({ text: 'Маме нравятся розы', kind: 'preference', about: 'мама' }), context);
  await registry.call('remember', JSON.stringify({ text: 'Проект Волна на TypeScript', about: 'Волна', category: 'work' }), context);
  await registry.call('remember', JSON.stringify({ text: 'Отвечать короче', kind: 'preference', category: 'style' }), context);
  assert.deepEqual(store.state.cards.map(c => [c.kind, c.title]), [['person', 'Мама'], ['work', 'Волна'], ['style', 'Как со мной говорить']]);

  const recalled = JSON.parse(await registry.call('recall', JSON.stringify({ query: 'мама' }), context));
  assert.equal(recalled.card.about, 'Мама');
  assert.deepEqual(recalled.card.known.sort(), ['Мама живёт в Берлине', 'Маме нравятся розы']);
  assert.deepEqual(recalled.notes, [], 'card notes are not repeated');

  const work = JSON.parse(await registry.call('forget', JSON.stringify({ query: 'работа', whole: true }), context));
  assert.deepEqual(work.forgotten, ['Волна', 'Проект Волна на TypeScript']);
  const mom = JSON.parse(await registry.call('forget', JSON.stringify({ query: 'Мама', whole: true }), context));
  assert.equal(mom.forgotten[0], 'Мама');
  assert.deepEqual(openFacts(store.state).map(f => f.text), ['Отвечать короче']);
});
