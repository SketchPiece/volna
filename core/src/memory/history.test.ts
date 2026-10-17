import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemoryStore } from './store.ts';
import { excerpt, historyTools, HISTORY_TOOL_NAMES } from './history.ts';
import type { Transcript, Turn } from './model.ts';
import { TaskStore } from '../tasks/store.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { allowedTools, metadataField, parseSkillFile, skillTier } from '../skills/format.ts';
import { silentLogger } from '../log.ts';

// Сейчас 25.09 11:00 по Москве; «вчера» — 24.09.
const now = new Date('2026-09-25T08:00:00Z');
const context = { callId: 'rtc_now', signal: new AbortController().signal, log: silentLogger, timeZone: 'Europe/Moscow', now: () => now };

function call(callId: string, startedAt: string, texts: string[]): Transcript {
  const turns: Turn[] = texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text, at: startedAt }));
  return { callId, startedAt, endedAt: new Date(Date.parse(startedAt) + 5 * 60_000).toISOString(), turns };
}

async function setup(level: 'explicit' | 'attentive' = 'attentive') {
  const dir = await mkdtemp(join(tmpdir(), 'wave-history-'));
  const store = new MemoryStore(dir);
  await store.load(now);
  await store.update(s => { s.level = level; }, now);
  // 23.09 22:30 UTC — это уже 24.09 01:30 по Москве: день определяется по поясу пользователя, а не по имени файла.
  await store.saveTranscript(call('rtc_late', '2026-09-23T22:30:00Z', ['Не спится, давай про переезд', 'Давай. Что именно?', 'Сколько стоят грузчики', 'Около десяти тысяч']));
  await store.saveTranscript(call('rtc_day', '2026-09-24T12:00:00Z', ['Поставь напоминание купить молоко', 'Готово', 'И найди рецепт борща', 'Нашла рецепт на три литра']));
  await store.saveTranscript(call('rtc_old', '2026-09-20T09:00:00Z', ['Привет, про переезд в Казань', 'Слушаю']));
  const tasks = new TaskStore(dir);
  await tasks.load(now);
  const done = await tasks.create({ title: 'Сравнить тарифы на переезд', prompt: 'сравни' }, new Date('2026-09-24T10:00:00Z'));
  await tasks.patch(done.id, { status: 'done', finishedAt: '2026-09-24T10:20:00Z', result: 'Дешевле всего «Грузовичкоф», 9 800 ₽.' });
  await tasks.create({ title: 'Письмо бухгалтеру', prompt: 'напиши' }, new Date('2026-09-22T10:00:00Z'));
  return { store, registry: new ToolRegistry(historyTools(store, () => tasks)) };
}

const read = async (registry: ToolRegistry, args: object) => JSON.parse(await registry.call('history_read', JSON.stringify(args), context));

test('history_read returns calls and tasks of a day in the user time zone', async () => {
  const { registry } = await setup();
  assert.deepEqual(registry.names(), HISTORY_TOOL_NAMES);
  assert.equal(registry.effectOf('history_read'), 'read');
  const day = await read(registry, { day: '2026-09-24' });
  assert.equal(day.day, '2026-09-24');
  assert.deepEqual(day.calls.map((c: { at: string }) => c.at), ['2026-09-24 01:30', '2026-09-24 15:00']);
  assert.equal(day.calls[1].minutes, 5);
  assert.match(day.calls[1].excerpt, /^Пользователь: Поставь напоминание купить молоко\nВолна: Готово/);
  assert.deepEqual(day.tasks, [{ title: 'Сравнить тарифы на переезд', status: 'done', created: '2026-09-24 13:00', finished: '2026-09-24 13:20', result: 'Дешевле всего «Грузовичкоф», 9 800 ₽.' }]);
  assert.equal(day.note, undefined);

  const empty = await read(registry, { day: '2026-09-21' });
  assert.deepEqual([empty.calls, empty.tasks], [[], []]);
  assert.match(empty.note, /Ничего не найдено/);
});

test('history_read without a day: the last call, or the latest calls and tasks about the query', async () => {
  const { registry } = await setup();
  const last = await read(registry, {});
  assert.deepEqual(last.calls.map((c: { at: string }) => c.at), ['2026-09-24 15:00']);
  assert.equal(last.day, '2026-09-24');
  assert.equal(last.tasks.length, 1);

  const moving = await read(registry, { query: 'переезд' });
  assert.deepEqual(moving.calls.map((c: { at: string }) => c.at), ['2026-09-20 12:00', '2026-09-24 01:30']);
  assert.deepEqual(moving.tasks.map((t: { title: string }) => t.title), ['Сравнить тарифы на переезд']);
  assert.equal(moving.day, null);
  assert.equal(JSON.stringify(moving).includes('молоко'), false);
});

test('history_read says honestly that calls are not recorded below «Замечает сама»', async () => {
  const { registry } = await setup('explicit');
  const result = await read(registry, { day: '2026-09-24' });
  assert.match(result.note, /не сохраняются/);
  assert.deepEqual(JSON.parse(await registry.call('history_read', JSON.stringify({ day: 'вчера' }), context)).error, 'invalid_arguments');
});

test('history works without the task store (no Helm)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wave-history-'));
  const store = new MemoryStore(dir);
  const registry = new ToolRegistry(historyTools(store));
  const result = await read(registry, {});
  assert.deepEqual([result.calls, result.tasks], [[], []]);
});

test('excerpt picks matching turns with neighbours and fits the budget', () => {
  const turns: Turn[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: i === 20 ? 'Что с переездом в Казань?' : `Реплика номер ${i} про разное`, at: '' }));
  const focused = excerpt(turns, ['переезд'], 1000);
  assert.deepEqual(focused.split('\n'), ['…', 'Волна: Реплика номер 19 про разное', 'Пользователь: Что с переездом в Казань?', 'Волна: Реплика номер 21 про разное', '…']);
  const whole = excerpt(turns, [], 600);
  assert.ok(whole.length <= 600 + 4);
  assert.match(whole, /^Пользователь: Реплика номер 0/);
  assert.match(whole, /Волна: Реплика номер 39 про разное$/);
  assert.ok(whole.includes('\n…\n'));
  const long = excerpt([{ role: 'user', text: 'а'.repeat(2000), at: '' }], [], 4000);
  assert.ok(long.length < 450);
});

test('builtin techcard «История» names the tool and is standard tier', async () => {
  const file = parseSkillFile(await readFile(resolve(import.meta.dirname, '..', '..', 'skills', 'history', 'SKILL.md'), 'utf8'));
  assert.equal(file.frontmatter.name, 'history');
  assert.deepEqual(allowedTools(file.frontmatter), [...HISTORY_TOOL_NAMES]);
  assert.equal(metadataField(file.frontmatter, 'title'), 'История');
  assert.equal(metadataField(file.frontmatter, 'system'), 'true');
  assert.equal(skillTier(file.frontmatter), 'standard');
});
