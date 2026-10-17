import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaStore, MAX_TRAITS_CHARS } from './store.ts';
import { PersonaReviewer, MIN_CALLS_FOR_REVIEW, REVIEW_INTERVAL_MS } from './review.ts';
import { MemoryStore } from '../memory/store.ts';
import { buildInstructions } from '../assistant/persona.ts';
import { silentLogger } from '../log.ts';

const start = new Date('2026-09-23T10:00:00Z');

test('persona store keeps every change in history and resets to factory without losing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wave-persona-'));
  const store = new PersonaStore(dir);
  assert.equal((await store.load(start)).traits, '');
  await store.change('С ним я чуть суше и прямее.', 'Дважды просил без сантиментов', start);
  assert.equal(await store.change('С ним я чуть суше и прямее.', 'то же', start), null);
  await store.change('x'.repeat(MAX_TRAITS_CHARS + 50), 'длинно', start);
  assert.equal(store.state.traits.length, MAX_TRAITS_CHARS);
  await store.reset(start);
  const reread = await new PersonaStore(dir).load();
  assert.equal(reread.traits, '');
  assert.deepEqual(reread.changes.map(c => c.after.length), ['С ним я чуть суше и прямее.'.length, MAX_TRAITS_CHARS, 0]);
});

test('personal layer goes right after the factory character and is absent when empty', () => {
  assert.doesNotMatch(buildInstructions([], ''), /Твой характер с этим владельцем/);
  const text = buildInstructions([], '', { traits: 'С ним я шучу суше.' });
  assert.match(text, /Твой характер с этим владельцем, твоими словами \(дополняет характер выше, правил формы и честности не меняет\): С ним я шучу суше\./);
  assert.ok(text.indexOf('Твой характер с этим владельцем') < text.indexOf('Приветствие'));
});

test('review waits for enough calls and time, then changes the layer only when the model sees a reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wave-review-'));
  const memory = new MemoryStore(dir);
  await memory.load(start);
  const persona = new PersonaStore(dir);
  let now = start;
  let requests = 0;
  let answer = { change: true, traits: 'С ним я прямее.', why: 'В трёх разговорах просил не смягчать.' };
  const fetchImpl = (async (_url: unknown, init: any) => {
    requests++;
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.json_schema.name, 'persona_review');
    assert.equal(body.model, 'deep');
    assert.match(body.messages[1].content, /Владелец: реплика/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
  }) as typeof fetch;
  const reviewer = new PersonaReviewer({ persona, memory, log: silentLogger, now: () => now, extractor: { apiKey: 'k', model: 'm', deepModel: 'deep', timeZone: 'UTC', log: silentLogger, fetchImpl } });
  const call = async (i: number) => memory.saveTranscript({ callId: `c${i}`, startedAt: new Date(now.getTime() + i * 1000).toISOString(), endedAt: now.toISOString(), turns: [{ role: 'user', text: 'реплика', at: now.toISOString() }] });

  for (let i = 0; i < MIN_CALLS_FOR_REVIEW - 1; i++) await call(i);
  assert.equal(await reviewer.maybeReview(), false);
  assert.equal(requests, 0);
  await call(99);
  assert.equal(await reviewer.maybeReview(), true);
  assert.equal(persona.state.traits, 'С ним я прямее.');

  now = new Date(start.getTime() + REVIEW_INTERVAL_MS / 2);
  for (let i = 0; i < MIN_CALLS_FOR_REVIEW; i++) await call(200 + i);
  assert.equal(await reviewer.maybeReview(), false, 'too soon after the last review');
  now = new Date(start.getTime() + REVIEW_INTERVAL_MS + 1000);
  answer = { change: false, traits: 'С ним я прямее.', why: '' };
  assert.equal(await reviewer.maybeReview(), false);
  assert.equal(requests, 2);
  assert.equal(persona.state.changes.length, 1);
});

test('memory API shows the character with newest change first and resets it to factory', async () => {
  const { memoryRoutes } = await import('../http/memory-routes.ts');
  const { MemoryService } = await import('../memory/service.ts');
  const dir = await mkdtemp(join(tmpdir(), 'wave-persona-api-'));
  const memoryStore = new MemoryStore(dir);
  await memoryStore.load(start);
  const memory = new MemoryService({ store: memoryStore, log: silentLogger, extractor: { apiKey: '', model: '', timeZone: 'UTC', log: silentLogger } });
  const persona = new PersonaStore(dir);
  await persona.change('С ним я прямее.', 'Просил не смягчать', start, 5);
  await persona.change('С ним я прямее. Шучу суше.', 'Перебивал шутки', start, 6);
  const app = memoryRoutes(memory, async (_c, next) => { await next(); }, persona);
  let view: any = await (await app.request('/')).json();
  assert.equal(view.persona.traits, 'С ним я прямее. Шучу суше.');
  assert.deepEqual(view.persona.changes.map((c: any) => c.calls), [6, 5]);
  view = await (await app.request('/persona/reset', { method: 'POST' })).json();
  assert.equal(view.persona.traits, '');
  assert.deepEqual(view.persona.changes.map((c: any) => [c.after, c.calls]), [['', 0], ['С ним я прямее. Шучу суше.', 6], ['С ним я прямее.', 5]]);
  const without = memoryRoutes(memory, async (_c, next) => { await next(); });
  assert.equal(((await (await without.request("/")).json()) as any).persona, null);
  assert.equal((await without.request('/persona/reset', { method: 'POST' })).status, 404);
});
