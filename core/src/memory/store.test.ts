import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, applyOperations, contentTokens, openFacts, overlap, searchFacts } from './store.ts';
import { emptyState } from './model.ts';

const now = new Date('2026-09-22T10:00:00Z');
const tempStore = async () => new MemoryStore(await mkdtemp(join(tmpdir(), 'wave-memory-')));

test('operations add, update, close; duplicates and empty text are ignored', () => {
  const state = emptyState(now);
  const first = applyOperations(state, [
    { op: 'add', text: 'Живёт в Берлине', kind: 'fact', sensitive: false, when: null },
    { op: 'add', text: 'живёт в берлине', kind: 'fact', sensitive: false, when: null },
    { op: 'add', text: '   ', kind: 'fact', sensitive: false, when: null }
  ], { origin: 'inferred', now });
  assert.equal(first.added.length, 1);
  assert.equal(state.facts.length, 1);
  const id = state.facts[0]!.id;
  const second = applyOperations(state, [
    { op: 'update', id, text: 'Переехал в Мюнхен', when: '2026-09-01' },
    { op: 'close', id: 'missing' }
  ], { origin: 'inferred', now });
  assert.equal(second.updated[0]!.text, 'Переехал в Мюнхен');
  assert.equal(second.closed.length, 0);
  applyOperations(state, [{ op: 'close', id }], { origin: 'explicit', now });
  assert.equal(openFacts(state).length, 0);
  assert.equal(state.facts.length, 1, 'closed facts stay in history');
});

test('sensitive notes are skipped unless allowed by setting or explicit request', () => {
  const state = emptyState(now);
  const op = { op: 'add' as const, text: 'Лечится от мигрени', kind: 'fact' as const, sensitive: true, when: null };
  assert.equal(applyOperations(state, [op], { origin: 'inferred', now }).skipped, 1);
  assert.equal(applyOperations(state, [op], { origin: 'explicit', now, allowSensitive: true }).added.length, 1);
  state.allowSensitive = true;
  assert.equal(applyOperations(state, [{ ...op, text: 'Другое' }], { origin: 'inferred', now }).added.length, 1);
});

test('search matches word stems in Russian and finds closed notes too', () => {
  const state = emptyState(now);
  applyOperations(state, [
    { op: 'add', text: 'Собаку зовут Рекс', kind: 'fact', sensitive: false, when: null },
    { op: 'add', text: 'Предпочитает короткие ответы', kind: 'preference', sensitive: false, when: null },
    { op: 'add', text: 'Встреча с врачом', kind: 'thread', sensitive: false, when: '2026-09-25' }
  ], { origin: 'inferred', now });
  assert.deepEqual(searchFacts(state, 'как зовут собаку').map(f => f.text), ['Собаку зовут Рекс']);
  assert.deepEqual(searchFacts(state, 'ответы').map(f => f.kind), ['preference']);
  applyOperations(state, [{ op: 'close', id: state.facts[2]!.id }], { origin: 'explicit', now });
  assert.equal(searchFacts(state, 'врач')[0]?.closedAt !== null, true);
  assert.equal(searchFacts(state, '').length, 2, 'empty query lists open notes');
});

test('store persists atomically and reloads with defaults for missing fields', async () => {
  const store = await tempStore();
  await store.apply([{ op: 'add', text: 'Пьёт кофе без сахара', kind: 'preference', sensitive: false, when: null }], { origin: 'explicit', now });
  await store.update(s => { s.level = 'involved'; }, now);
  const raw = JSON.parse(await readFile(join(store.dir, 'memory.json'), 'utf8'));
  assert.equal(raw.level, 'involved');
  assert.equal(raw.updatedAt, now.toISOString());
  const reloaded = new MemoryStore(store.dir);
  const state = await reloaded.load();
  assert.equal(state.facts[0]!.text, 'Пьёт кофе без сахара');
  assert.equal(state.facts[0]!.origin, 'explicit');
});

test('transcripts are saved by date and call id; wipe removes them and notes but keeps settings', async () => {
  const store = await tempStore();
  await store.update(s => { s.level = 'explicit'; }, now);
  const name = await store.saveTranscript({ callId: 'rtc_1/../x', startedAt: now.toISOString(), endedAt: now.toISOString(), turns: [{ role: 'user', text: 'привет', at: now.toISOString() }] });
  assert.equal(name, '2026-09-22-10-00-00-rtc_1x.json');
  assert.deepEqual(await store.listTranscripts(), [name]);
  assert.equal((await store.readTranscript(name)).turns[0]!.text, 'привет');
  await store.apply([{ op: 'add', text: 'x1', kind: 'fact', sensitive: false, when: null }], { origin: 'explicit', now });
  await store.wipe(now);
  assert.deepEqual(await store.listTranscripts(), []);
  assert.equal(store.state.facts.length, 0);
  assert.equal(store.state.level, 'explicit');
});

test('concurrent updates are serialized', async () => {
  const store = await tempStore();
  await Promise.all(Array.from({ length: 5 }, (_, i) => store.apply([{ op: 'add', text: `note ${i}`, kind: 'fact', sensitive: false, when: null }], { origin: 'explicit', now })));
  assert.equal((await new MemoryStore(store.dir).load()).facts.length, 5);
});

test('an add that repeats an open record in other words updates it instead of adding', () => {
  const state = emptyState(now);
  const later = new Date('2026-09-25T10:00:00Z');
  applyOperations(state, [{ op: 'add', text: 'Попросил проверить пять файлов в Загрузках', kind: 'episode', sensitive: false, when: null }], { origin: 'inferred', callId: 'c1', now });
  const again = applyOperations(state, [{ op: 'add', text: 'Снова попросил проверить пять файлов в папке «Загрузки»; работа запущена', kind: 'episode', sensitive: false, when: null }], { origin: 'inferred', callId: 'c2', now: later });
  assert.equal(again.added.length, 0);
  assert.equal(again.merged.length, 1);
  assert.equal(state.facts.length, 1);
  assert.equal(state.facts[0]!.text, 'Снова попросил проверить пять файлов в папке «Загрузки»; работа запущена', 'the newer, fuller text wins');
  assert.equal(state.facts[0]!.learnedAt, later.toISOString(), 'a merged record counts as heard again');
  const shorter = applyOperations(state, [{ op: 'add', text: 'Проверить пять файлов в Загрузках', kind: 'episode', sensitive: false, when: null }], { origin: 'inferred', now });
  assert.equal(shorter.merged.length, 1);
  assert.match(state.facts[0]!.text, /работа запущена/, 'a shorter text that adds nothing keeps the old one');
  assert.equal(overlap(contentTokens('Андрей не пьет кофе после шести вечера'), contentTokens('Любит кофе, но не пьёт его после шести вечера')), 5 / 6);
});

test('different reminders, threads with other dates and facts differing in a key word are not merged', () => {
  const add = (text: string, kind: 'thread' | 'fact' = 'thread', when: string | null = null) => ({ op: 'add' as const, text, kind, sensitive: false, when });
  for (const pair of [
    [add('Напоминание: купить печенье.'), add('Напоминание: купить шоколадку.')],
    [add('Напоминание: купить печенье для мамы в субботу'), add('Напоминание: купить шоколадку для мамы в субботу')],
    [add('Напоминание: купить молоко в 10:00'), add('Напоминание: купить молоко в 1:00')],
    [add('Встреча с Олегом', 'thread', '2026-09-26'), add('Встреча с Олегом', 'thread', '2026-10-03')],
    [add('Зовут Андрей', 'fact'), add('Маму Андрея зовут Оля', 'fact')],
    [add('Сын ходит в садик Sonnenschein по вторникам', 'fact'), add('Дочь ходит в садик Sonnenschein по вторникам', 'fact')]
  ]) {
    const result = applyOperations(emptyState(now), pair, { origin: 'inferred', now });
    assert.equal(result.added.length, 2, pair.map(op => op.text).join(' / '));
  }
  const state = emptyState(now);
  applyOperations(state, [add('Напоминание: купить печенье.')], { origin: 'inferred', now });
  const same = applyOperations(state, [add('Напоминание: купить печенье в 06:00')], { origin: 'inferred', now });
  assert.equal(same.merged[0]?.text, 'Напоминание: купить печенье в 06:00', 'the same reminder with a time is one record');
});

test('an inferred near-duplicate never rewrites or downgrades what the owner said himself', () => {
  const state = emptyState(now);
  applyOperations(state, [{ op: 'add', text: 'Андрей не пьёт кофе после шести вечера', kind: 'preference', sensitive: false, when: null }], { origin: 'explicit', now });
  const inferred = applyOperations(state, [{ op: 'add', text: 'Любит кофе, но не пьёт его после шести вечера', kind: 'preference', sensitive: false, when: null }], { origin: 'inferred', now });
  assert.equal(inferred.merged.length, 1);
  assert.deepEqual(state.facts.map(f => [f.text, f.origin]), [['Андрей не пьёт кофе после шести вечера', 'explicit']]);
});

test('cards: a new card with a known title or alias edits the same card; facts reference cards by id or title', () => {
  const state = emptyState(now);
  const first = applyOperations(state, [
    { op: 'card', id: null, kind: 'person', title: 'Мама', aliases: ['Оля'], summary: 'Живёт в Берлине' },
    { op: 'add', text: 'Мама живёт в Берлине', kind: 'fact', sensitive: false, when: null, cards: ['Мама'] },
    { op: 'add', text: 'Зовут Андрей', kind: 'fact', sensitive: false, when: null, cards: ['self'] },
    { op: 'add', text: 'Звонил маме в воскресенье', kind: 'episode', sensitive: false, when: null, cards: ['оля', 'нет такой'] }
  ], { origin: 'inferred', now });
  const mom = state.cards.find(c => c.kind === 'person')!;
  assert.deepEqual(state.facts.map(f => f.cards), [[mom.id], ['self'], [mom.id]], 'unknown references are dropped');
  assert.equal(state.cards.find(c => c.id === 'self')?.title, 'Обо мне', 'singleton cards appear on first reference');
  assert.equal(first.cards.length, 2);

  applyOperations(state, [{ op: 'card', id: null, kind: 'person', title: 'Оля', aliases: ['Ольга'], summary: '' }], { origin: 'inferred', now });
  assert.equal(state.cards.filter(c => c.kind === 'person').length, 1, 'an alias finds the existing card');
  assert.equal(mom.title, 'Оля');
  assert.deepEqual(mom.aliases, ['Мама', 'Ольга']);
  assert.equal(mom.summary, 'Живёт в Берлине', 'an empty summary keeps the old one');
});

test('cards: merge moves facts and names, close closes the card with its own facts but keeps mentions', () => {
  const state = emptyState(now);
  applyOperations(state, [
    { op: 'card', id: null, kind: 'person', title: 'Мама', aliases: [], summary: '' },
    { op: 'card', id: null, kind: 'person', title: 'Оля', aliases: [], summary: 'Мама Андрея' },
    { op: 'add', text: 'Мама живёт в Берлине', kind: 'fact', sensitive: false, when: null, cards: ['Мама'] },
    { op: 'add', text: 'Оля любит розы', kind: 'preference', sensitive: false, when: null, cards: ['Оля'] },
    { op: 'add', text: 'Звонил маме и сестре', kind: 'episode', sensitive: false, when: null, cards: ['self', 'Мама'] },
    { op: 'add', text: 'Поздравить маму и купить батарейки', kind: 'thread', sensitive: false, when: null, cards: ['Мама'] }
  ], { origin: 'inferred', now });
  const [mom, olya] = state.cards.filter(c => c.kind === 'person');
  applyOperations(state, [{ op: 'merge_card', id: olya!.id, into: mom!.id }, { op: 'merge_card', id: 'self', into: mom!.id }], { origin: 'inferred', now });
  assert.ok(olya!.closedAt);
  assert.deepEqual(mom!.aliases, ['Оля']);
  assert.equal(mom!.summary, 'Мама Андрея');
  assert.ok(state.facts.every(f => f.cards.includes(mom!.id)));
  assert.ok(!state.cards.find(c => c.id === 'self')!.closedAt, 'singletons are never merged away');

  const closed = applyOperations(state, [{ op: 'close', id: mom!.id }], { origin: 'explicit', now });
  assert.deepEqual(closed.closed.map(f => f.text).sort(), ['Мама живёт в Берлине', 'Оля любит розы']);
  assert.deepEqual(openFacts(state).map(f => f.text).sort(), ['Звонил маме и сестре', 'Поздравить маму и купить батарейки'], 'the timeline stays even when the card comes first');
});

test('near duplicates on different cards stay separate records', () => {
  const state = emptyState(now);
  applyOperations(state, [
    { op: 'card', id: null, kind: 'person', title: 'Мама', aliases: [], summary: '' },
    { op: 'add', text: 'Живёт в Берлине', kind: 'fact', sensitive: false, when: null, cards: ['self'] },
    { op: 'add', text: 'Живёт в Берлине', kind: 'fact', sensitive: false, when: null, cards: ['Мама'] },
    { op: 'add', text: 'Живёт в Берлине', kind: 'fact', sensitive: false, when: null, cards: ['Мама'] }
  ], { origin: 'inferred', now });
  assert.equal(state.facts.length, 2);
});
