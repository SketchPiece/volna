import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { LiveCalls } from '../realtime/live-calls.ts';
import type { PushSender } from '../push/apns.ts';
import { buildBackendInstructions } from '../assistant/persona.ts';
import { live, offer, post, run } from '../test-support.ts';
import { CallbackStore } from './store.ts';
import { CallbackScheduler } from './scheduler.ts';
import { callbackContext } from './context.ts';
import { askedInCall, callbackTools, isPlain } from './tools.ts';
import { parseWhen, spokenTime } from './time.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const NOW = new Date('2026-09-26T12:00:00Z'); // 15:00 в Москве
const MSK = 'Europe/Moscow';
const context = { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: MSK, now: () => NOW };

async function store() {
  const callbacks = new CallbackStore(await mkdtemp(join(tmpdir(), 'callbacks-')));
  await callbacks.load();
  return callbacks;
}

function fakePush(options: { call?: boolean; notify?: boolean } = {}): PushSender & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    canCall: () => options.call ?? true,
    canNotify: () => options.notify ?? true,
    call: async payload => { sent.push(`call:${payload.task}:${payload.title}`); return true; },
    notify: async alert => { sent.push(`notify:${alert.body}`); return true; }
  };
}

function liveCall(calls: LiveCalls) {
  const sent: any[] = [];
  calls.listener().attach!({ send: (event: any) => sent.push(event), runTool: async () => '' } as any);
  return sent;
}

test('local times are read in the user\'s zone, explicit offsets as given', () => {
  assert.equal(parseWhen('2026-09-26T18:00', MSK)!.toISOString(), '2026-09-26T15:00:00.000Z');
  assert.equal(parseWhen('2026-09-26 18:00:30', MSK)!.toISOString(), '2026-09-26T15:00:30.000Z');
  assert.equal(parseWhen('2026-09-26T18:00+03:00', 'UTC')!.toISOString(), '2026-09-26T15:00:00.000Z');
  assert.equal(parseWhen('2026-09-26T18:00:00Z', MSK)!.toISOString(), '2026-09-26T18:00:00.000Z');
  // Берлин переходит на зимнее время 25.10.2026: +02:00 до, +01:00 после.
  assert.equal(parseWhen('2026-10-24T09:00', 'Europe/Berlin')!.toISOString(), '2026-10-24T07:00:00.000Z');
  assert.equal(parseWhen('2026-10-26T09:00', 'Europe/Berlin')!.toISOString(), '2026-10-26T08:00:00.000Z');
  assert.equal(parseWhen('завтра в шесть', MSK), null);
  assert.equal(parseWhen('2026-13-40T99:00', MSK), null);
});

test('spoken times say today, tomorrow or the date', () => {
  assert.equal(spokenTime(new Date('2026-09-26T15:00:00Z'), NOW, MSK), 'в 18:00');
  assert.equal(spokenTime(new Date('2026-09-27T06:30:00Z'), NOW, MSK), 'завтра в 09:30');
  assert.equal(spokenTime(new Date('2026-10-03T15:00:00Z'), NOW, MSK), '3 октября в 18:00');
});

test('callback_schedule stores the call-back, arms the timer and says the local time', async () => {
  const callbacks = await store();
  const scheduler = new CallbackScheduler({ store: callbacks, calls: new LiveCalls(), push: fakePush(), log: silentLogger, now: () => NOW });
  const registry = new ToolRegistry(callbackTools(callbacks, scheduler));
  const made = JSON.parse(await registry.call('callback_schedule', JSON.stringify({ at: '2026-09-26T18:00', reason: 'отправить отчёт Ане', title: 'Отчёт' }), context));
  assert.equal(made.scheduled, true);
  assert.equal(made.say, 'Договорились, перезвоню в 18:00.');
  assert.equal(callbacks.get(made.id)!.at, '2026-09-26T15:00:00.000Z');
  assert.match(made.id, /^[0-9a-f]{16}$/, 'the phone accepts only a task-shaped id');
  const soon = JSON.parse(await registry.call('callback_schedule', JSON.stringify({ inMinutes: 30, reason: 'выключить плиту', title: 'Плита' }), context));
  assert.equal(soon.when, 'в 15:30');
  const listed = JSON.parse(await registry.call('callbacks_list', '{}', context));
  assert.deepEqual(listed.callbacks.map((c: any) => c.title), ['Плита', 'Отчёт'], 'nearest first');
  scheduler.close();
});

test('callback_schedule refuses past, far and unreadable times', async () => {
  const callbacks = await store();
  const scheduler = new CallbackScheduler({ store: callbacks, calls: new LiveCalls(), push: fakePush(), log: silentLogger, now: () => NOW });
  const registry = new ToolRegistry(callbackTools(callbacks, scheduler));
  const call = async (args: object) => JSON.parse(await registry.call('callback_schedule', JSON.stringify({ reason: 'что-то', title: 'Что-то', ...args }), context));
  assert.equal((await call({ at: '2026-09-26T14:00' })).error, 'time_in_past');
  assert.equal((await call({ at: '2026-12-01T10:00' })).error, 'too_far');
  assert.equal((await call({ at: 'в шесть' })).error, 'bad_time');
  assert.equal((await call({})).error, 'bad_time');
  assert.equal(callbacks.all.length, 0);
});

test('a call-back without a subject asks once per call; after the question any answer schedules it', async () => {
  const callbacks = await store();
  const scheduler = new CallbackScheduler({ store: callbacks, calls: new LiveCalls(), push: fakePush(), log: silentLogger, now: () => NOW });
  const registry = new ToolRegistry(callbackTools(callbacks, scheduler));
  const schedule = async (args: object, callId = 'c') => JSON.parse(await registry.call('callback_schedule', JSON.stringify({ inMinutes: 2, title: 'Перезвон', ...args }), { ...context, callId }));
  const asked = await schedule({ reason: 'просто перезвонить' });
  assert.equal(asked.error, 'no_reason', 'an error, so the core does not report it as done');
  assert.equal(asked.say, 'О чём напомнить, когда позвоню?');
  assert.equal(callbacks.all.length, 0);
  const plain = await schedule({ reason: 'просто перезвонить' });
  assert.equal(plain.scheduled, true, 'asked already: «ни о чём» is an answer');
  assert.equal((await schedule({})).error, 'no_reason', 'the next plain call-back asks again');
  assert.equal((await schedule({ reason: 'выключить плиту' }, 'other')).scheduled, true, 'a real subject never asks');
  scheduler.close();
});

test('plain subjects are told from real ones', () => {
  for (const text of ['', 'просто перезвонить', 'Перезвонить.', 'звонок', 'позвонить мне', 'перезвон', 'напоминание']) assert.equal(isPlain(text), true, text);
  for (const text of ['выключить плиту', 'про плиту', 'позвонить врачу', 'отправить отчёт Ане', 'ни о чём, просто так']) assert.equal(isPlain(text), false, text);
});

test('an answer right after Volna asked what to remind about is taken, «ни о чём» too', async () => {
  const callbacks = await store();
  const scheduler = new CallbackScheduler({ store: callbacks, calls: new LiveCalls(), push: fakePush(), log: silentLogger, now: () => NOW });
  const registry = new ToolRegistry(callbackTools(callbacks, scheduler));
  const turns = [{ role: 'user' as const, text: 'Позвони мне через пять минут' }, { role: 'assistant' as const, text: 'О чём напомнить, когда позвоню?' }, { role: 'user' as const, text: 'Да ни о чём' }];
  const made = JSON.parse(await registry.call('callback_schedule', JSON.stringify({ inMinutes: 5, title: 'Звонок' }), { ...context, turns: () => turns }));
  assert.equal(made.scheduled, true);
  assert.equal(askedInCall(turns.slice(0, 1)), false);
  assert.equal(askedInCall([{ role: 'assistant', text: 'А о чём сказать, когда позвоню?' }, { role: 'user', text: 'Про плиту' }]), true, 'in its own words');
  assert.equal(askedInCall([{ role: 'assistant', text: 'Напомню в шесть.' }, { role: 'user', text: 'Позвони через пять минут' }]), false, 'not a question');
  scheduler.close();
});

test('callback_cancel cancels only planned call-backs', async () => {
  const callbacks = await store();
  const scheduler = new CallbackScheduler({ store: callbacks, calls: new LiveCalls(), push: fakePush(), log: silentLogger, now: () => NOW });
  const registry = new ToolRegistry(callbackTools(callbacks, scheduler));
  const item = await callbacks.create({ at: '2026-09-26T15:00:00Z', title: 'Отчёт', reason: 'отчёт' }, NOW);
  assert.equal(JSON.parse(await registry.call('callback_cancel', JSON.stringify({ id: item.id }), context)).cancelled, true);
  assert.equal(callbacks.get(item.id)!.status, 'cancelled');
  assert.equal(JSON.parse(await registry.call('callback_cancel', JSON.stringify({ id: item.id }), context)).reason, 'not_scheduled');
  scheduler.close();
});

test('when the time comes the phone rings with the call-back id; unanswered, a notification follows', async () => {
  const callbacks = await store();
  const push = fakePush();
  const scheduler = new CallbackScheduler({ store: callbacks, calls: new LiveCalls(), push, log: silentLogger, fallbackMs: 20, now: () => new Date() });
  const item = await callbacks.create({ at: new Date(Date.now() + 10).toISOString(), title: 'Отчёт', reason: 'отправить отчёт Ане' });
  scheduler.arm();
  await wait(40);
  assert.equal(push.sent[0], `call:${item.id}:Отчёт`);
  await wait(40);
  assert.deepEqual(push.sent.slice(1), ['notify:Пропущенный звонок. Напоминаю: отправить отчёт Ане']);
  assert.equal(callbacks.get(item.id)!.status, 'notified');
  scheduler.close();
});

test('an answered call-back sends no notification', async () => {
  const callbacks = await store();
  const push = fakePush();
  const scheduler = new CallbackScheduler({ store: callbacks, calls: new LiveCalls(), push, log: silentLogger, fallbackMs: 20 });
  const item = await callbacks.create({ at: new Date().toISOString(), title: 'Отчёт', reason: 'отчёт' });
  assert.equal(await scheduler.fire(item), 'ringing');
  await callbacks.patch(item.id, { status: 'answered' });
  await wait(40);
  assert.equal(push.sent.length, 1);
  scheduler.close();
});

test('during a call the reminder goes into it; late or without VoIP it becomes a notification; with nothing it waits', async () => {
  const calls = new LiveCalls({ nudgeMs: 5 });
  const sent = liveCall(calls);
  const callbacks = await store();
  const push = fakePush();
  const at = NOW.toISOString();
  const scheduler = new CallbackScheduler({ store: callbacks, calls, push, log: silentLogger, now: () => NOW });
  const during = await callbacks.create({ at, title: 'Отчёт', reason: 'отчёт Ане' });
  assert.equal(await scheduler.fire(during), 'announced');
  assert.match(JSON.stringify(sent), /отчёт Ане/);
  assert.equal(callbacks.get(during.id)!.status, 'answered');
  assert.equal(push.sent.length, 0);
  scheduler.close();

  const idle = new LiveCalls();
  const late = await callbacks.create({ at: '2026-09-26T08:00:00Z', title: 'Плита', reason: 'плита' });
  assert.equal(await new CallbackScheduler({ store: callbacks, calls: idle, push, log: silentLogger, now: () => NOW }).fire(late), 'notified', 'the core slept through it');
  const noVoip = await callbacks.create({ at, title: 'Кот', reason: 'покормить кота' });
  assert.equal(await new CallbackScheduler({ store: callbacks, calls: idle, push: fakePush({ call: false }), log: silentLogger, now: () => NOW }).fire(noVoip), 'notified');
  const nothing = await callbacks.create({ at, title: 'Цветы', reason: 'полить цветы' });
  assert.equal(await new CallbackScheduler({ store: callbacks, calls: idle, push: fakePush({ call: false, notify: false }), log: silentLogger, now: () => NOW }).fire(nothing), 'missed');
  assert.deepEqual(push.sent, ['notify:Напоминаю: плита']);
});

test('a core restart turns a ringing call-back into a missed one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'callbacks-'));
  const first = new CallbackStore(dir);
  await first.load();
  const item = await first.create({ at: NOW.toISOString(), title: 'Отчёт', reason: 'отчёт' });
  await first.patch(item.id, { status: 'ringing' });
  const second = new CallbackStore(dir);
  await second.load();
  assert.equal(second.get(item.id)!.status, 'missed');
});

test('the call-back call opens with the reminder; missed ones and planned ones go to the section', async () => {
  const callbacks = await store();
  const ringing = await callbacks.create({ at: '2026-09-26T15:00:00Z', title: 'Отчёт', reason: 'отправить отчёт Ане' });
  await callbacks.patch(ringing.id, { status: 'ringing' });
  const missed = await callbacks.create({ at: '2026-09-26T09:00:00Z', title: 'Плита', reason: 'выключить плиту' });
  await callbacks.patch(missed.id, { status: 'missed' });
  await callbacks.create({ at: '2026-09-27T06:00:00Z', title: 'Врач', reason: 'позвонить врачу' });
  const later = new Date('2026-09-26T15:00:10Z');

  const opened = callbackContext(callbacks, ringing.id, MSK, later);
  assert.match(opened.opening, /перезвонить в 18:00 и напомнить: «отправить отчёт Ане»/);
  assert.match(opened.opening, /Перезваниваю, как договаривались/);
  assert.match(opened.section, /в 12:00: «выключить плиту»/);
  assert.match(opened.section, /завтра в 09:00 \(«Врач»\)/);
  assert.deepEqual(opened.heard, [ringing.id, missed.id]);

  const ordinary = callbackContext(callbacks, null, MSK, later);
  assert.equal(ordinary.opening, '');
  assert.deepEqual(ordinary.heard, [missed.id]);
  assert.equal(callbackContext(callbacks, 'ffffffffffffffff', MSK, later).opening, '', 'a task id is not a call-back');
});

test('POST /session with a call-back id in X-Callback-Task opens with the reminder and marks it answered', async () => {
  const callbacks = await store();
  const item = await callbacks.create({ at: new Date().toISOString(), title: 'Отчёт', reason: 'отправить отчёт Ане' });
  await callbacks.patch(item.id, { status: 'ringing' });
  let session: any;
  await run({ apiKey: 'secret', callbacks, fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, null); } },
    async url => { assert.equal((await post(url, offer, { 'X-Callback-Task': item.id })).status, 200); });
  assert.match(session.instructions, /Перезваниваю, как договаривались/);
  assert.match(session.instructions, /отправить отчёт Ане/);
  await wait(10);
  assert.equal(callbacks.get(item.id)!.status, 'answered');
});

test('the backend learns the call-back rule only when the tool is in the call', () => {
  assert.match(buildBackendInstructions(['callback_schedule', 'current_time']), /Перезвон \(callback_schedule/);
  assert.doesNotMatch(buildBackendInstructions(['current_time']), /callback_schedule/);
});
