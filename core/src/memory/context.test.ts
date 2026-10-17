import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryContext, pickThread, MAX_PROMPT_CHARS } from './context.ts';
import { emptyState, type Fact } from './model.ts';
import { applyOperations } from './store.ts';

const now = new Date('2026-09-22T10:00:00Z');
const seeded = () => {
  const state = emptyState(now);
  state.profile = 'Инженер, живёт в Берлине.';
  applyOperations(state, [
    { op: 'add', text: 'Предпочитает короткие ответы', kind: 'preference', sensitive: false, when: null },
    { op: 'add', text: 'Встреча с врачом', kind: 'thread', sensitive: false, when: '2026-09-21' },
    { op: 'add', text: 'Отпуск в Лиссабоне', kind: 'thread', sensitive: false, when: '2026-10-05' },
    { op: 'add', text: 'Обсуждали переезд', kind: 'episode', sensitive: false, when: null }
  ], { origin: 'inferred', now });
  return state;
};

test('cold level yields no memory section and no thread', () => {
  const state = seeded(); state.level = 'cold';
  assert.deepEqual(buildMemoryContext(state, now), { section: '', backend: '', thread: null });
});

test('explicit and attentive levels include profile and notes but never a greeting thread', () => {
  for (const level of ['explicit', 'attentive'] as const) {
    const state = seeded(); state.level = level;
    const context = buildMemoryContext(state, now);
    assert.equal(context.thread, null);
    assert.match(context.section, /Инженер, живёт в Берлине/);
    assert.match(context.section, /Предпочтения:\n- Предпочитает короткие ответы/);
    assert.match(context.section, /Незакрытое из прошлых разговоров \(.*tasks_list\):\n- Встреча с врачом \(2026-09-21\)/);
    assert.doesNotMatch(context.section, /Нить для приветствия/);
  }
  assert.match(buildMemoryContext(Object.assign(seeded(), { level: 'explicit' as const }), now).section, /только по явной просьбе/);
});

test('involved level picks the first past, unasked, non-sensitive thread for the greeting', () => {
  const state = seeded(); state.level = 'involved';
  const context = buildMemoryContext(state, now);
  assert.equal(context.thread?.text, 'Встреча с врачом');
  // Дневной текст (эксперимент 363cc0e): «нить», а не «открытая тема»; оговорки «вопрос о теме и есть этот раз» нет.
  assert.match(context.section, /Нить для приветствия: Встреча с врачом.*Спроси о ней одним коротким вопросом после приветствия/);
  const quiet = buildMemoryContext(state, now, { thread: false });
  assert.equal(quiet.thread, null, 'a callback or ready work leaves the thread for the next call');
  assert.doesNotMatch(quiet.section, /Нить для приветствия/);
  assert.doesNotMatch(quiet.section, /и есть этот раз/, 'no thread, no mention of a question about it');
  assert.match(quiet.section, /Раз за разговор можешь уместно уточнить что-то из памяти; /);
  state.facts.find(f => f.text === 'Встреча с врачом')!.askedAt = now.toISOString();
  assert.equal(pickThread(state.facts, now), null, 'future thread is not raised early');
  const undated: Fact = { ...state.facts[1]!, id: 'u', text: 'Собеседование', when: null, askedAt: null, learnedAt: '2026-09-20T00:00:00Z' };
  assert.equal(pickThread([undated], now)?.text, 'Собеседование', 'undated threads wait a day');
  assert.equal(pickThread([{ ...undated, sensitive: true }], now), null);
});

test('the delegation model gets memory without recent conversations and a pointer to history_read', () => {
  const state = seeded(); state.level = 'attentive';
  const context = buildMemoryContext(state, now);
  assert.match(context.section, /Недавние разговоры:/);
  assert.doesNotMatch(context.backend, /Недавние разговоры/);
  assert.match(context.backend, /Незакрытое из прошлых разговоров \(.*\):\n- Встреча с врачом/);
  assert.match(context.backend, /history_read/);
});

test('old episodes are dropped from the prompt and the section respects the character budget', () => {
  const state = seeded(); state.level = 'attentive';
  state.facts.find(f => f.kind === 'episode')!.learnedAt = '2026-08-01T00:00:00Z';
  for (let i = 0; i < 200; i++) state.facts.push({ id: `f${i}`, text: `Факт номер ${i} `.repeat(4), kind: 'fact', origin: 'inferred', sensitive: false, learnedAt: now.toISOString(), when: null, closedAt: null, askedAt: null, callId: null, cards: [] });
  const context = buildMemoryContext(state, now);
  assert.doesNotMatch(context.section, /Обсуждали переезд/);
  assert.ok(context.section.length < MAX_PROMPT_CHARS + 1000, `section is ${context.section.length} chars`);
});

test('cards: sections about the owner go first, other cards by category with their facts, or name and summary if the budget is short', () => {
  const state = emptyState(now); state.level = 'attentive';
  applyOperations(state, [
    { op: 'card', id: null, kind: 'person', title: 'Мама', aliases: ['Оля'], summary: 'живёт в Берлине' },
    { op: 'add', text: 'Мама любит розы', kind: 'preference', sensitive: false, when: null, cards: ['Мама'] },
    { op: 'add', text: 'Отвечать короче', kind: 'preference', sensitive: false, when: null, cards: ['style'] },
    { op: 'add', text: 'Ещё не разложено', kind: 'fact', sensitive: false, when: null }
  ], { origin: 'inferred', now });
  const { section, backend } = buildMemoryContext(state, now);
  assert.match(section, /Как со мной говорить:\n- Отвечать короче/);
  assert.match(section, /Люди:\n- Мама \(Оля\): живёт в Берлине\n  · Мама любит розы/);
  assert.match(section, /Факты:\n- Ещё не разложено/);
  assert.ok(section.indexOf('Как со мной говорить') < section.indexOf('Люди:'));
  assert.match(backend, /Мама \(Оля\)/);

  for (let i = 0; i < 40; i++) state.facts.push({ id: `m${i}`, text: `Про маму подробность ${i} `.repeat(6), kind: 'fact', origin: 'inferred', sensitive: false, learnedAt: now.toISOString(), when: null, closedAt: null, askedAt: null, callId: null, cards: [state.cards.find(c => c.kind === 'person')!.id] });
  const short = buildMemoryContext(state, now).section;
  assert.match(short, /- Мама \(Оля\): живёт в Берлине\n/);
  assert.doesNotMatch(short, /подробность/);
});
