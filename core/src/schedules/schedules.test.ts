import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { buildBackendInstructions } from '../assistant/persona.ts';
import { HelmError } from '../helm/client.ts';
import { TaskStore } from '../tasks/store.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { TaskDelivery } from '../tasks/delivery.ts';
import { LiveCalls } from '../realtime/live-calls.ts';
import type { PushSender } from '../push/apns.ts';
import { ScheduleStore } from './store.ts';
import { ScheduleScheduler, type ScheduleSchedulerOptions } from './scheduler.ts';
import { scheduleTools } from './tools.ts';
import { nextRun, spokenRule, validTime } from './recurrence.ts';

const MSK = 'Europe/Moscow';
const NOW = new Date('2026-10-06T12:00:00Z'); // вторник, 15:00 в Москве
const context = { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: MSK, now: () => NOW };

async function store(dir?: string) {
  const schedules = new ScheduleStore(dir ?? await mkdtemp(join(tmpdir(), 'schedules-')));
  await schedules.load();
  return schedules;
}

function scheduler(schedules: ScheduleStore, overrides: Partial<ScheduleSchedulerOptions> = {}) {
  const work: any[] = [];
  const reminders: any[] = [];
  const running = new Set<string>();
  const instance = new ScheduleScheduler({
    store: schedules, timeZone: MSK, log: silentLogger, now: () => NOW,
    startWork: async input => { work.push(input); const id = `t${work.length}`; running.add(id); return { id }; },
    isRunning: id => running.has(id),
    remind: async input => { reminders.push(input); return { id: `cb${reminders.length}` }; },
    ...overrides
  });
  return { instance, work, reminders, running };
}

test('the next run is the first matching day and time after now, in the user\'s zone', () => {
  // Вторник 15:00 по Москве: сегодняшние 18:00 ещё впереди, 09:00 уже прошло.
  assert.equal(nextRun({ time: '18:00', days: [] }, NOW, MSK).toISOString(), '2026-10-06T15:00:00.000Z');
  assert.equal(nextRun({ time: '09:00', days: [] }, NOW, MSK).toISOString(), '2026-10-07T06:00:00.000Z');
  assert.equal(nextRun({ time: '15:00', days: [] }, NOW, MSK).toISOString(), '2026-10-07T12:00:00.000Z', 'exactly now is not next');
  assert.equal(nextRun({ time: '10:00', days: ['mon'] }, NOW, MSK).toISOString(), '2026-10-12T07:00:00.000Z');
  assert.equal(nextRun({ time: '10:00', days: ['tue'] }, NOW, MSK).toISOString(), '2026-10-13T07:00:00.000Z', 'today\'s time has passed: next week');
  assert.equal(nextRun({ time: '20:00', days: ['tue'] }, NOW, MSK).toISOString(), '2026-10-06T17:00:00.000Z');
  assert.equal(nextRun({ time: '08:00', days: ['sat', 'sun'] }, NOW, MSK).toISOString(), '2026-10-10T05:00:00.000Z');
  // Поздно вечером по Москве в UTC ещё «вчера»: день берётся местный.
  assert.equal(nextRun({ time: '08:00', days: ['wed'] }, new Date('2026-10-06T22:30:00Z'), MSK).toISOString(), '2026-10-07T05:00:00.000Z');
});

test('the local time holds across a daylight saving change', () => {
  // Берлин переходит на зимнее время 25.10.2026: 09:00 — это 07:00 UTC до и 08:00 UTC после.
  const before = nextRun({ time: '09:00', days: [] }, new Date('2026-10-24T08:00:00Z'), 'Europe/Berlin');
  assert.equal(before.toISOString(), '2026-10-25T08:00:00.000Z');
  assert.equal(nextRun({ time: '09:00', days: [] }, new Date('2026-10-23T12:00:00Z'), 'Europe/Berlin').toISOString(), '2026-10-24T07:00:00.000Z');
});

test('rules are spoken in Russian; times are validated', () => {
  assert.equal(spokenRule({ time: '08:00', days: [] }), 'каждый день в 08:00');
  assert.equal(spokenRule({ time: '08:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }), 'каждый день в 08:00');
  assert.equal(spokenRule({ time: '09:30', days: ['fri', 'mon', 'wed', 'tue', 'thu'] }), 'по будням в 09:30');
  assert.equal(spokenRule({ time: '11:00', days: ['sun', 'sat'] }), 'по выходным в 11:00');
  assert.equal(spokenRule({ time: '10:00', days: ['mon'] }), 'по понедельникам в 10:00');
  assert.equal(spokenRule({ time: '18:00', days: ['fri', 'mon', 'wed'] }), 'по понедельникам, средам и пятницам в 18:00');
  assert.ok(validTime('23:59'));
  assert.ok(!validTime('24:00'));
  assert.ok(!validTime('9:00'));
});

test('schedule_create stores the rule, the first run and says it back; the list shows it; delete removes it', async () => {
  const schedules = await store();
  const { instance } = scheduler(schedules);
  const registry = new ToolRegistry(scheduleTools(schedules, instance, { canCall: true }));
  assert.deepEqual(registry.startNames(), ['schedule_create'], 'creating starts work: only through offer_work');
  const made = JSON.parse(await registry.call('schedule_create', JSON.stringify({ kind: 'work', title: 'Сводка по ИИ', task: 'Собери пять главных новостей по ИИ за сутки', time: '08:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }), context));
  assert.equal(made.scheduled, true);
  assert.equal(made.say, 'Договорились: по будням в 08:00. Первый раз завтра в 08:00.');
  const saved = schedules.get(made.id)!;
  assert.equal(saved.nextAt, '2026-10-07T05:00:00.000Z');
  assert.equal(saved.callback, 'notify');
  assert.equal(saved.prompt, 'Собери пять главных новостей по ИИ за сутки');

  const listed = JSON.parse(await registry.call('schedules_list', '{}', context));
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.schedules[0], { id: made.id, kind: 'work', title: 'Сводка по ИИ', task: 'Собери пять главных новостей по ИИ за сутки', when: 'по будням в 08:00', next: 'завтра в 08:00', callback: 'notify', lastRun: null, lastOutcome: null });

  const tonight = JSON.parse(await registry.call('schedule_create', JSON.stringify({ kind: 'call', title: 'Таблетки', task: 'выпить таблетки', time: '21:00' }), context));
  assert.equal(tonight.say, 'Договорились: каждый день в 21:00. Первый раз сегодня в 21:00.');
  await registry.call('schedule_delete', JSON.stringify({ id: tonight.id }), context);

  const agreed = JSON.parse(await registry.call('schedule_create', JSON.stringify({ kind: 'call', title: 'Вода', task: 'выпить воды\n\nПри согласии пользователь добавил (дословно, распознано по речи): «да, давай, только не забудь»', time: '10:00' }), context));
  assert.equal(schedules.get(agreed.id)!.prompt, 'выпить воды', 'the words of consent are not part of a reminder');
  await registry.call('schedule_delete', JSON.stringify({ id: agreed.id }), context);

  const deleted = JSON.parse(await registry.call('schedule_delete', JSON.stringify({ id: made.id }), context));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.say, 'Готово, «Сводка по ИИ» больше не повторяется.');
  assert.equal(schedules.all.length, 0);
  assert.equal(JSON.parse(await registry.call('schedule_delete', JSON.stringify({ id: made.id }), context)).reason, 'not_found');
  instance.close();
});

test('schedules survive a restart of the core', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedules-'));
  const schedules = await store(dir);
  await schedules.create({ kind: 'call', title: 'Таблетки', prompt: 'выпить таблетки', time: '21:00', days: [], nextAt: '2026-10-06T18:00:00.000Z' }, NOW);
  assert.match(await readFile(join(dir, 'schedules.json'), 'utf8'), /Таблетки/);
  const again = await store(dir);
  assert.equal(again.all[0]!.title, 'Таблетки');
  assert.equal(again.all[0]!.kind, 'call');
});

test('without push there are no reminder calls: the tool offers only work', async () => {
  const schedules = await store();
  const { instance } = scheduler(schedules, { remind: undefined });
  const registry = new ToolRegistry(scheduleTools(schedules, instance, { canCall: false }));
  const issues = registry.issues('schedule_create', { kind: 'call', title: 'Таблетки', task: 'выпить таблетки', time: '21:00' });
  assert.ok(issues.length > 0);
  assert.doesNotMatch(registry.definitions()[0]!.description, /kind call/);
});

test('bad times and too many schedules are refused', async () => {
  const schedules = await store();
  const { instance } = scheduler(schedules);
  const registry = new ToolRegistry(scheduleTools(schedules, instance, { canCall: true }));
  assert.ok(registry.issues('schedule_create', { kind: 'work', title: 'Сводка', task: 'Собери новости', time: '8 утра' }).length > 0);
  assert.ok(registry.issues('schedule_create', { kind: 'work', title: 'Сводка', task: 'Собери новости', time: '25:00' }).length > 0);
  for (let i = 0; i < 20; i++) await schedules.create({ kind: 'call', title: `Н${i}`, prompt: 'x', time: '09:00', days: [], nextAt: '2026-10-07T06:00:00.000Z' }, NOW);
  const refused = JSON.parse(await registry.call('schedule_create', JSON.stringify({ kind: 'call', title: 'Ещё', task: 'выпить воды', time: '10:00' }), context));
  assert.equal(refused.error, 'too_many');
});

test('a named project is looked up once at creation; an unknown project comes back to the model, a lost Mac is said plainly', async () => {
  const schedules = await store();
  const { instance, work } = scheduler(schedules);
  const asked: string[] = [];
  const registry = new ToolRegistry(scheduleTools(schedules, instance, {
    canCall: true, macOnline: () => false,
    pickProject: async name => {
      asked.push(name);
      if (name === 'Волна') return { project: { id: 'p1', title: 'Волна', workspaceRoot: '/p/volna' } as any, created: false };
      if (name === 'офлайн') throw new HelmError('helm_offline');
      return { error: 'unknown_project', asked: name, hint: 'Ask the user which project.' };
    }
  }));
  const made = JSON.parse(await registry.call('schedule_create', JSON.stringify({ kind: 'work', title: 'Проверка Волны', task: 'Прогони тесты ядра и скажи, что упало', time: '07:30', project: 'Волна', worktree: true }), context));
  assert.equal(made.project, 'Волна');
  assert.equal(schedules.get(made.id)!.helmProject, 'p1');
  assert.equal(schedules.get(made.id)!.worktree, true);
  assert.equal(JSON.parse(await registry.call('schedule_create', JSON.stringify({ kind: 'work', title: 'Задача', task: 'Сделай что-то', time: '07:30', project: 'Нету' }), context)).error, 'unknown_project');
  const offline = JSON.parse(await registry.call('schedule_create', JSON.stringify({ kind: 'work', title: 'Задача', task: 'Сделай что-то', time: '07:30', project: 'офлайн' }), context));
  assert.ok(offline.error && offline.say, 'Mac offline: an error with a phrase to say');
  // Без проекта Mac не нужен: работа пойдёт в общую папку.
  await registry.call('schedule_create', JSON.stringify({ kind: 'work', title: 'Общая', task: 'Сделай что-то', time: '07:30' }), context);
  assert.deepEqual(asked, ['Волна', 'Нету', 'офлайн']);

  // Срок пришёл: работа идёт в проект и ветку расписания, с датой запуска.
  await instance.fire(schedules.get(made.id)!, new Date('2026-10-07T04:30:00Z'));
  assert.equal(work[0].helmProject, 'p1');
  assert.equal(work[0].worktree, true);
  assert.match(work[0].prompt, /^Прогони тесты ядра и скажи, что упало\n\nЭто регулярное задание «Проверка Волны» \(каждый день в 07:30\), сегодняшний запуск: среда, 7 октября 2026/);
  instance.close();
});

test('a due work schedule starts a task like work_start and moves to the next run', async () => {
  const schedules = await store();
  const { instance, work } = scheduler(schedules);
  const item = await schedules.create({ kind: 'work', title: 'Сводка', prompt: 'Собери новости', time: '08:00', days: [], callback: 'call', nextAt: '2026-10-07T05:00:00.000Z' }, NOW);
  const at = new Date('2026-10-07T05:00:03Z');
  assert.equal(await instance.fire(schedules.get(item.id)!, at), 'started');
  assert.equal(work.length, 1);
  assert.equal(work[0].title, 'Сводка');
  assert.equal(work[0].callback, 'call', 'the user asked to be phoned with the result each time');
  const after = schedules.get(item.id)!;
  assert.equal(after.nextAt, '2026-10-08T05:00:00.000Z');
  assert.equal(after.lastRunId, 't1');
  assert.equal(after.lastOutcome, 'started');
  assert.equal(after.lastRunAt, at.toISOString());
  instance.close();
});

test('the next run is skipped while the last one still works, and when the core was off too long', async () => {
  const schedules = await store();
  const { instance, work, running } = scheduler(schedules);
  const item = await schedules.create({ kind: 'work', title: 'Сводка', prompt: 'Собери новости', time: '08:00', days: [], nextAt: '2026-10-07T05:00:00.000Z' }, NOW);
  await instance.fire(schedules.get(item.id)!, new Date('2026-10-07T05:00:00Z'));
  assert.equal(await instance.fire(schedules.get(item.id)!, new Date('2026-10-08T05:00:00Z')), 'skipped_busy');
  assert.equal(work.length, 1, 'yesterday\'s work still runs: no second copy');
  assert.equal(schedules.get(item.id)!.lastRunId, 't1');
  assert.equal(schedules.get(item.id)!.nextAt, '2026-10-09T05:00:00.000Z');
  running.clear();
  // Ядро было выключено: срок 09.10 08:00 пришёл только в 11:00.
  assert.equal(await instance.fire(schedules.get(item.id)!, new Date('2026-10-09T08:00:00Z')), 'skipped_late');
  assert.equal(work.length, 1);
  assert.equal(schedules.get(item.id)!.nextAt, '2026-10-10T05:00:00.000Z');
  // Опоздание меньше двух часов: запуск всё равно нужен.
  assert.equal(await instance.fire(schedules.get(item.id)!, new Date('2026-10-10T06:30:00Z')), 'started');
  instance.close();
});

test('a due reminder schedule makes a call-back now; a failed start is noted and the schedule moves on', async () => {
  const schedules = await store();
  const { instance, reminders } = scheduler(schedules);
  const call = await schedules.create({ kind: 'call', title: 'Таблетки', prompt: 'выпить таблетки', time: '21:00', days: ['mon', 'wed'], nextAt: '2026-10-07T18:00:00.000Z' }, NOW);
  assert.equal(await instance.fire(schedules.get(call.id)!, new Date('2026-10-07T18:00:00Z')), 'started');
  assert.deepEqual(reminders, [{ title: 'Таблетки', reason: 'выпить таблетки' }]);
  assert.equal(schedules.get(call.id)!.nextAt, '2026-10-12T18:00:00.000Z', 'next Monday');

  const s2 = await store();
  const failing = scheduler(s2, { startWork: async () => { throw new TypeError('boom'); } });
  const w = await s2.create({ kind: 'work', title: 'Сводка', prompt: 'Собери новости', time: '08:00', days: [], nextAt: '2026-10-07T05:00:00.000Z' }, NOW);
  assert.equal(await failing.instance.fire(s2.get(w.id)!, new Date('2026-10-07T05:00:00Z')), 'failed');
  assert.equal(s2.get(w.id)!.nextAt, '2026-10-08T05:00:00.000Z');
  assert.equal(s2.get(w.id)!.lastRunAt, null);
  instance.close();
});

test('a schedule that fails to save does not leave the others without a timer', async () => {
  const schedules = await store();
  const { instance, work } = scheduler(schedules);
  await schedules.create({ kind: 'work', title: 'Первое', prompt: 'Собери новости', time: '14:30', days: [], nextAt: '2026-10-06T11:30:00.000Z' }, NOW);
  await schedules.create({ kind: 'work', title: 'Второе', prompt: 'Собери погоду', time: '14:45', days: [], nextAt: '2026-10-06T11:45:00.000Z' }, NOW);
  const patch = schedules.patch.bind(schedules);
  let failed = false;
  schedules.patch = async (id, changes) => { if (!failed) { failed = true; throw new Error('disk full'); } return patch(id, changes); };
  await instance.due();
  assert.equal(work.length, 2, 'the second schedule still ran');
  instance.close();
});

test('the timer fires due schedules by itself and re-arms for the next one', async () => {
  const schedules = await store();
  let now = new Date('2026-10-07T04:59:59.950Z');
  const { instance, work } = scheduler(schedules, { now: () => now });
  await schedules.create({ kind: 'work', title: 'Сводка', prompt: 'Собери новости', time: '08:00', days: [], nextAt: '2026-10-07T05:00:00.000Z' }, NOW);
  instance.arm();
  now = new Date('2026-10-07T05:00:00.010Z');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(work.length, 1);
  assert.equal(schedules.all[0]!.nextAt, '2026-10-08T05:00:00.000Z');
  instance.close();
});

test('the backend learns the schedule rules only with the schedule tools, and creating goes through offer_work', () => {
  const without = buildBackendInstructions(['work_start', 'tasks_list']);
  assert.doesNotMatch(without, /Повторяющиеся задания/);
  const withTools = buildBackendInstructions(['schedule_create', 'schedules_list', 'schedule_delete', 'work_start']);
  assert.match(withTools, /Повторяющиеся задания \(schedule_create, schedules_list, schedule_delete\)/);
  assert.match(withTools, /Запуск большой работы \(work_start, schedule_create\)/);
});

test('end to end: a due schedule runs the real task queue and the result comes as the usual notification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedules-'));
  const schedules = await store(dir);
  const tasks = new TaskStore(dir);
  await tasks.load();
  const sent: string[] = [];
  const push: PushSender = { canCall: () => true, canNotify: () => true, call: async () => { sent.push('call'); return true; }, notify: async alert => { sent.push(alert.body); return true; } };
  const delivery = new TaskDelivery({ store: tasks, calls: new LiveCalls(), push, log: silentLogger });
  const prompts: string[] = [];
  const runner = new TaskRunner({
    store: tasks, log: silentLogger, onFinished: task => delivery.deliver(task).then(() => {}),
    worker: async task => { prompts.push(task.prompt); return 'Главное за сутки: вышла новая модель. Подробности в отчёте.'; }
  });
  const runs = new ScheduleScheduler({
    store: schedules, timeZone: MSK, log: silentLogger, now: () => new Date('2026-10-07T05:00:00Z'),
    startWork: input => runner.start(input), isRunning: id => tasks.active.some(t => t.id === id)
  });
  await schedules.create({ kind: 'work', title: 'Сводка по ИИ', prompt: 'Собери главные новости по ИИ', time: '08:00', days: [], nextAt: '2026-10-07T05:00:00.000Z' }, NOW);
  await runs.due();
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(prompts[0]!, /^Собери главные новости по ИИ\n\nЭто регулярное задание «Сводка по ИИ»/);
  assert.deepEqual(sent, ['«Сводка по ИИ» готово. Главное за сутки: вышла новая модель.']);
  assert.equal(tasks.tasks[0]!.title, 'Сводка по ИИ');
  assert.equal(tasks.tasks[0]!.delivery, 'notified');
  assert.equal(schedules.all[0]!.lastRunId, tasks.tasks[0]!.id);
  assert.equal(schedules.all[0]!.nextAt, '2026-10-08T05:00:00.000Z');
  runs.close();
  delivery.close();
});
