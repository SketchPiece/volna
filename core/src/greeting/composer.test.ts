import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GreetingComposer, nameFrom } from './composer.ts';
import { pickGreeting, allPhrases, dayPart, gapBucket, type Situation } from './phrases.ts';
import { emptyState, type MemoryState } from '../memory/model.ts';
import { silentLogger } from '../log.ts';
import { buildInstructions, greetingRule } from '../assistant/persona.ts';
import { run, post, offer, live } from '../test-support.ts';
import { TaskStore } from '../tasks/store.ts';

const dir = () => mkdtemp(join(tmpdir(), 'greeting-'));
const evening = new Date('2026-09-23T17:30:00Z'); // 19:30 в Берлине
const plainEvening: Situation = { part: 'evening', gap: 'hours', name: null, creator: false };

/** Случайность по списку: первое число решает про легенду, дальше выбор фразы (у отсылки) или имя и фраза. */
const rolls = (...values: number[]) => { let i = 0; return () => values[i++ % values.length]!; };

function memoryWith(level: MemoryState['level'], profile: string): MemoryState {
  return { ...emptyState(evening), level, profile, facts: [
    { id: 'f1', text: 'Маму зовут Оля', kind: 'fact', origin: 'inferred', sensitive: false, learnedAt: evening.toISOString(), when: null, closedAt: null, askedAt: null, callId: null, cards: [] }
  ] };
}

test('day parts and gaps between calls', () => {
  assert.equal(dayPart(3), 'night');
  assert.equal(dayPart(8), 'morning');
  assert.equal(dayPart(14), 'day');
  assert.equal(dayPart(20), 'evening');
  assert.equal(dayPart(23), 'night');
  assert.equal(gapBucket(null, evening), 'none');
  assert.equal(gapBucket(new Date(evening.getTime() - 5 * 60_000), evening), 'minutes');
  assert.equal(gapBucket(new Date(evening.getTime() - 40 * 60_000), evening), 'hours');
  assert.equal(gapBucket(new Date(evening.getTime() - 3 * 86400_000), evening), 'days');
  assert.equal(gapBucket(new Date(evening.getTime() - 10 * 86400_000), evening), 'long');
});

test('a plain call gets a short phrase for the time of day; the name only when known', () => {
  assert.equal(pickGreeting(plainEvening, [], rolls(0.9, 0)).text, 'Добрый вечер');
  assert.equal(pickGreeting({ ...plainEvening, name: 'Андрей' }, [], rolls(0.9, 0.1, 0)).text, 'Добрый вечер, Андрей');
  assert.equal(pickGreeting({ ...plainEvening, part: 'night' }, [], rolls(0.9, 0.99)).text, 'Не спится?');
  assert.equal(pickGreeting({ ...plainEvening, gap: 'minutes' }, [], rolls(0.9, 0.99)).text, 'Что-то забыли?');
});

test('lore lines are off: GPT-Live did not say them, only plain phrases are picked', () => {
  const lore = new Set(allPhrases().find(group => group.group === 'легенда')!.texts);
  for (let i = 0; i < 50; i++) {
    const picked = pickGreeting({ ...plainEvening, name: 'Андрей', creator: true }, [], rolls(0, i / 50, i / 50));
    assert.equal(picked.lore, false);
    assert.ok(![...lore].some(line => line.replace('{name}', 'Андрей') === picked.text), picked.text);
  }
});

test('with a memory thread to ask about, the phrase itself is never a question', () => {
  for (const gap of ['none', 'minutes', 'hours', 'day', 'days', 'long'] as const) {
    for (const part of ['night', 'morning', 'day', 'evening'] as const) {
      for (const name of [null, 'Андрей']) {
        for (let i = 0; i < 10; i++) {
          const { text } = pickGreeting({ part, gap, name, creator: false, thread: true }, [], rolls(0.9, i / 10, i / 10));
          assert.doesNotMatch(text, /\?/, `${part}/${gap}: ${text}`);
          // «Слушаю» и сразу вопрос о теме звучит странно: в каждом наборе есть фраза без него.
          assert.doesNotMatch(text, /слушаю/i, `${part}/${gap}: ${text}`);
        }
      }
    }
  }
  assert.equal(pickGreeting({ ...plainEvening, part: 'night', thread: true }, [], rolls(0.9, 0.99)).text, 'Доброй ночи');
  assert.equal(pickGreeting({ ...plainEvening, gap: 'none', thread: true }, [], rolls(0.9, 0.99)).text, 'Здравствуйте, это Волна');
});

test('the last phrases are not repeated word for word; no phrase has a lamp, a count or assistant talk', () => {
  const first = pickGreeting(plainEvening, [], rolls(0.9, 0)).text;
  assert.notEqual(pickGreeting(plainEvening, [first], rolls(0.9, 0)).text, first);
  for (const text of allPhrases().flatMap(group => group.texts)) {
    assert.doesNotMatch(text, /ламп|я на связи|на линии|готов|\d|!/i, text);
    assert.ok(text.split(' ').length <= 6, text);
  }
});

test('the name comes only from a sentence about the user, and never on the cold level', () => {
  assert.equal(nameFrom(memoryWith('attentive', 'Зовут Андрей. Мама — Оля.')), 'Андрей');
  assert.equal(nameFrom(memoryWith('attentive', 'Живёт в Берлине.')), null, '«Маму зовут Оля» is not the user');
  assert.equal(nameFrom(memoryWith('cold', 'Зовут Андрей.')), null);
  assert.equal(nameFrom(undefined), null);
});

test('each call picks a phrase, remembers the call and the phrase, and the state survives a restart', async () => {
  const folder = await dir();
  const composer = new GreetingComposer({ dir: folder, timeZone: 'Europe/Berlin', log: silentLogger, now: () => evening, random: () => 0.9 });
  const first = await composer.forCall();
  assert.deepEqual({ greeting: first.greeting, source: first.source }, { greeting: { text: 'Здравствуйте, это Волна. Слушаю' }, source: 'phrase' });
  await first.commit();
  const second = await composer.forCall();
  assert.equal(second.greeting.text, 'Что-то забыли?');
  await second.commit();
  const saved = JSON.parse(await readFile(join(folder, 'greeting.json'), 'utf8'));
  assert.equal(saved.calls.length, 2);
  assert.deepEqual(saved.recent, ['Здравствуйте, это Волна. Слушаю', second.greeting.text]);

  const later = new Date(evening.getTime() + 3 * 3600_000); // 22:30
  const restarted = new GreetingComposer({ dir: folder, timeZone: 'Europe/Berlin', log: silentLogger, now: () => later, random: rolls(0.9, 0.1, 0),
    memory: () => memoryWith('attentive', 'Зовут Андрей.') });
  assert.equal((await restarted.forCall()).greeting.text, 'Добрый вечер, Андрей');
});

test('instructions carry the phrase to say as is; the fallback names nobody and answers a user who spoke first', () => {
  const rule = greetingRule({ text: 'Добрый вечер' });
  // Дневной текст приветствия (эксперимент 363cc0e): фраза как есть, о нити спросить вместо вопроса из фразы.
  assert.match(buildInstructions([], '', { greeting: { text: 'Добрый вечер' } }), /скажи ровно «Добрый вечер», ничего не добавляя\./);
  assert.match(greetingRule({ text: 'Слушаю' }, { thread: true }), /Если в памяти есть нить для приветствия, вопрос из фразы опусти и спроси коротко о нити\./);
  assert.match(greetingRule({ text: 'Слушаю' }), /коротко ответь ему, например «Да, слушаю»\./);
  assert.match(rule, /заговорил раньше/);
  assert.match(buildInstructions([]), /Приветствие:/);
  assert.doesNotMatch(greetingRule(null), /Андрей|Эфир/, 'the name must come from memory, not from an example');
  assert.match(greetingRule(null), /заговорил раньше/);
  const callback = buildInstructions([], '', { opening: 'Начало звонка: перезваниваешь по заданию.' });
  assert.match(callback, /Начало звонка: перезваниваешь по заданию\./);
  assert.doesNotMatch(callback, /Приветствие:|Да, слушаю/, 'a callback opens with the results, not a greeting');
});

// Правило приветствия после аудита 26.09.2026; эксперимент 363cc0e его убрал (`thread`/`results` не влияют). Вернуть
// проверку в обычный тест, если аудитный текст приветствия вернётся (docs/pending.md, «Приветствие молчит»).
test('after the phrase: ready work first, then the memory thread; the rule names no service words', { todo: 'эксперимент 363cc0e: дневной текст приветствия' }, () => {
  assert.match(greetingRule({ text: 'Слушаю' }, { results: true }), /«Слушаю», затем одной фразой скажи, что работа готова; больше ничего\./);
  assert.doesNotMatch(greetingRule({ text: 'Слушаю' }, { results: true, thread: true }), /открытой теме/);
  assert.match(greetingRule({ text: 'Слушаю' }, { results: true }), /коротко ответь ему, например «Да, слушаю» и одной фразой скажи, что работа готова\./);
  assert.doesNotMatch(greetingRule({ text: 'Слушаю' }, { results: true, thread: true }) + greetingRule({ text: 'Слушаю' }, { thread: true }), /нит|фонов|итоги/);
  assert.doesNotMatch(greetingRule({ text: 'Слушаю' }, { thread: true }), /опусти|вопрос из самой фразы/, 'the model never edits the phrase');
});

test('POST /session picks the greeting and puts it into the instructions', async () => {
  const greeting = new GreetingComposer({ dir: await dir(), timeZone: 'Europe/Berlin', log: silentLogger, random: rolls(0.9, 0.9, 0) });
  let session: any;
  await run({ apiKey: 'secret', greeting, fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, null); } },
    async url => { assert.equal((await post(url)).status, 200); });
  assert.match(session.instructions, /скажи ровно «Здравствуйте, это Волна\. Слушаю»/);
});

test('a greeting that was picked but not committed does not count as a call', async () => {
  const folder = await dir();
  const composer = new GreetingComposer({ dir: folder, timeZone: 'Europe/Berlin', log: silentLogger, now: () => evening, random: () => 0.9 });
  await composer.forCall();
  assert.equal((await composer.forCall()).greeting.text, 'Здравствуйте, это Волна. Слушаю', 'the first attempt failed: the retry is still the first call');
  await assert.rejects(readFile(join(folder, 'greeting.json'), 'utf8'), 'nothing is saved before a call is accepted');
});

test('POST /session remembers the greeting only when OpenAI accepted the call', async () => {
  const folder = await dir();
  const greeting = new GreetingComposer({ dir: folder, timeZone: 'Europe/Berlin', log: silentLogger, now: () => evening, random: () => 0.9 });
  const sessions: any[] = [];
  let fail = true;
  await run({ apiKey: 'secret', greeting, fetchImpl: async (_url, options: any) => {
    sessions.push(JSON.parse(options.body).session);
    return fail ? new Response('{}', { status: 500 }) : live(offer, null);
  } }, async url => {
    assert.equal((await post(url)).status, 502);
    fail = false;
    assert.equal((await post(url)).status, 200);
    assert.equal((await post(url)).status, 200);
  });
  assert.match(sessions[1].instructions, /«Здравствуйте, это Волна\. Слушаю»/, 'after a failed attempt the call is still the first one');
  assert.match(sessions[2].instructions, /«Что-то забыли\?»/);
});

/** Хранилище заданий с одним готовым заданием, по которому Волна перезванивает. */
async function ringingTask(): Promise<{ tasks: TaskStore; id: string }> {
  const tasks = new TaskStore(await dir());
  await tasks.load();
  const task = await tasks.create({ title: 'Перелёты', prompt: 'p', callback: 'call' });
  await tasks.patch(task.id, { status: 'done', result: 'Лучший второй.', finishedAt: evening.toISOString(), delivery: 'ringing' });
  return { tasks, id: task.id };
}

test('a callback has no phrase but still counts as a call for the next greeting', async () => {
  const folder = await dir();
  const greeting = new GreetingComposer({ dir: folder, timeZone: 'Europe/Berlin', log: silentLogger, now: () => evening, random: () => 0.9 });
  const sessions: any[] = [];
  const { tasks, id } = await ringingTask();
  await run({ apiKey: 'secret', greeting, tasks, fetchImpl: async (_url, options: any) => { sessions.push(JSON.parse(options.body).session); return live(offer, null); } }, async url => {
    assert.equal((await post(url, offer, { 'X-Callback-Task': id })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await post(url)).status, 200);
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const saved = JSON.parse(await readFile(join(folder, 'greeting.json'), 'utf8'));
  assert.equal(saved.calls.length, 2);
  assert.deepEqual(saved.recent, ['Что-то забыли?'], 'the callback adds no phrase');
  assert.match(sessions[1].instructions, /«Что-то забыли\?»/, 'right after the callback the gap is minutes');
});

// Аудит 26.09.2026: перезвон без итогов (задания нет или id неверный) оставался без фразы и без правила приветствия.
test('a callback without results is an ordinary call: it gets a phrase and the phrase is remembered', async () => {
  for (const header of ['0123456789abcdef', 'not-an-id']) {
    const folder = await dir();
    const greeting = new GreetingComposer({ dir: folder, timeZone: 'Europe/Berlin', log: silentLogger, now: () => evening, random: () => 0.9 });
    const { tasks } = await ringingTask();
    let session: any;
    await run({ apiKey: 'secret', greeting, tasks, fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, null); } }, async url => {
      assert.equal((await post(url, offer, { 'X-Callback-Task': header })).status, 200);
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(session.instructions, /Приветствие: когда тебя попросят поздороваться, скажи ровно «Здравствуйте, это Волна\. Слушаю»/, header);
    assert.doesNotMatch(session.instructions, /Перезваниваю по заданию/);
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'greeting.json'), 'utf8')).recent, ['Здравствуйте, это Волна. Слушаю']);
  }
});

test('POST /session picks a phrase without a question when memory has a thread, and the rule asks about it after the phrase', async () => {
  const greeting = new GreetingComposer({ dir: await dir(), timeZone: 'Europe/Berlin', log: silentLogger, now: () => evening, random: () => 0.9 });
  await (await greeting.forCall()).commit();
  const thread = { id: 't', text: 'Встреча с врачом', kind: 'thread' };
  const memory = { context: async () => ({ section: 'Память.\nНить для приветствия: Встреча с врачом.', backend: '', thread, commitThread: async () => {} }), startCall: () => null };
  let session: any;
  await run({ apiKey: 'secret', greeting, memory: memory as any, fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, null); } },
    async url => { assert.equal((await post(url)).status, 200); });
  assert.match(session.instructions, /скажи ровно «Снова здравствуйте», ничего не добавляя.*спроси коротко о нити/s, 'not «Что-то забыли?» followed by a second question');
});
