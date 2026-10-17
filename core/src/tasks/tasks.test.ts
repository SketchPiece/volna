import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { silentLogger } from '../log.ts';
import { defineTool, ToolRegistry } from '../assistant/tools/registry.ts';
import { currentTime } from '../assistant/tools/current-time.ts';
import { deviceTools } from '../assistant/tools/device.ts';
import { LiveCalls } from '../realtime/live-calls.ts';
import type { ChatModel, ChatResult } from '../delegation/llm.ts';
import type { PushSender } from '../push/apns.ts';
import { TaskStore, type Task } from './store.ts';
import { TaskRunner, type TaskWorker } from './runner.ts';
import { TaskDelivery, notificationBody } from './delivery.ts';
import { taskContext } from './context.ts';
import { buildInstructions } from '../assistant/persona.ts';
import { workTools } from './tools.ts';
import { TaskProgress } from './progress.ts';
import { live, offer, post, run } from '../test-support.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const reply = (content: string): ChatResult => ({ content, toolCalls: [], usage: { inTokens: 1, outTokens: 1 } });
const store = async () => new TaskStore(await mkdtemp(join(tmpdir(), 'tasks-')));
const context = { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => new Date('2026-09-22T10:00:00Z') };

function fakePush(options: { call?: boolean; notify?: boolean } = {}): PushSender & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    canCall: () => options.call ?? true,
    canNotify: () => options.notify ?? true,
    call: async payload => { sent.push(`call:${payload.task}`); return true; },
    notify: async alert => { sent.push(`notify:${alert.body}`); return true; }
  };
}

function liveCall(calls: LiveCalls) {
  const sent: any[] = [];
  calls.listener().attach!({ send: (event: any) => sent.push(event), runTool: async () => '' } as any);
  return sent;
}

test('the runner hands a task to the worker, stores the result and hands it to delivery', async () => {
  const tasks = await store();
  await tasks.load();
  const prompts: string[] = [];
  const worker: TaskWorker = async task => { prompts.push(task.prompt); return 'Главное: всё сходится.'; };
  const finished: Task[] = [];
  const runner = new TaskRunner({ store: tasks, worker, log: silentLogger, onFinished: task => { finished.push(task); } });
  const task = await runner.start({ title: 'Сверка', prompt: 'Проверь всё', callback: 'call' });
  assert.equal(task.status, 'queued');
  assert.equal(task.kind, 'computer', 'all work goes to Codex');
  await wait(30);
  assert.deepEqual(prompts, ['Проверь всё']);
  assert.equal(finished[0]!.status, 'done');
  assert.equal(finished[0]!.result, 'Главное: всё сходится.');
  assert.equal(tasks.get(task.id)!.status, 'done');
});

test('failures and cancellation are recorded; tasks interrupted by a restart become failed', async () => {
  const tasks = await store();
  await tasks.load();
  const finished: Task[] = [];
  const hanging: TaskWorker = (_task, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const runner = new TaskRunner({ store: tasks, worker: hanging, log: silentLogger, onFinished: t => { finished.push(t); } });
  const task = await runner.start({ title: 'Долго', prompt: 'p', callback: 'notify' });
  await wait(10);
  assert.equal(await runner.cancel(task.id), true);
  await wait(10);
  assert.equal(tasks.get(task.id)!.status, 'cancelled');
  assert.equal(finished.length, 0, 'a cancelled task is not delivered');

  const broken: TaskWorker = async () => { throw Object.assign(new Error('x'), { name: 'ChatError' }); };
  const failing = new TaskRunner({ store: tasks, worker: broken, log: silentLogger, onFinished: t => { finished.push(t); } });
  await failing.start({ title: 'Сбой', prompt: 'p', callback: 'notify' });
  await wait(20);
  assert.deepEqual([finished[0]!.status, finished[0]!.error], ['failed', 'ChatError']);

  const dir = await mkdtemp(join(tmpdir(), 'tasks-'));
  await writeFile(join(dir, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'aaaaaaaaaaaaaaaa', title: 't', prompt: 'p', callback: 'call', status: 'running', delivery: 'pending', createdAt: '2026-09-22T10:00:00Z', startedAt: null, finishedAt: null, result: null, error: null }] }));
  const reloaded = new TaskStore(dir);
  await reloaded.load();
  assert.deepEqual([reloaded.tasks[0]!.status, reloaded.tasks[0]!.error], ['failed', 'interrupted']);
  assert.match(await readFile(join(dir, 'tasks.json'), 'utf8'), /interrupted/);
});

test('the runner keeps at most two tasks running', async () => {
  const tasks = await store();
  await tasks.load();
  const releases: (() => void)[] = [];
  const worker: TaskWorker = () => new Promise(resolve => releases.push(() => resolve('ок')));
  const runner = new TaskRunner({ store: tasks, worker, log: silentLogger, onFinished: () => {} });
  for (const title of ['a', 'b', 'c']) await runner.start({ title, prompt: 'p', callback: 'notify' });
  await wait(10);
  assert.equal(releases.length, 2);
  releases[0]!();
  await wait(20);
  assert.equal(releases.length, 3, 'the queued task starts when a slot frees');
});

async function finishedTask(tasks: TaskStore, callback: Task['callback'], result = 'Нашёл три варианта. Лучший второй.'): Promise<Task> {
  const task = await tasks.create({ title: 'Перелёты', prompt: 'p', callback });
  return (await tasks.patch(task.id, { status: 'done', result, finishedAt: new Date().toISOString() }))!;
}

test('delivery: a live call hears it at once; otherwise one batch when nothing else runs, a call only if asked', async () => {
  const tasks = await store();
  await tasks.load();
  const calls = new LiveCalls();
  const push = fakePush();
  const delivery = new TaskDelivery({ store: tasks, calls, push, log: silentLogger, fallbackMs: 30 });

  const sent = liveCall(calls);
  const during = await finishedTask(tasks, 'call');
  assert.equal(await delivery.deliver(during), 'announced');
  assert.equal(sent[0].type, 'session.instructions.append');
  assert.match(sent[0].content, /Ядро: фоновое задание «Перелёты» готово\. Итог: Нашёл три варианта/);
  assert.equal(tasks.get(during.id)!.delivery, 'heard');
  assert.equal(push.sent.length, 0, 'no push during a call');

  const quiet = new LiveCalls();
  const batch = new TaskDelivery({ store: tasks, calls: quiet, push, log: silentLogger, fallbackMs: 30 });
  const still = await tasks.create({ title: 'Отели', prompt: 'p' });
  await tasks.patch(still.id, { status: 'running' });
  const first = await finishedTask(tasks, 'notify');
  assert.equal(await batch.deliver(first), 'waiting', 'another task still runs: no push yet');
  assert.equal(push.sent.length, 0);
  await tasks.patch(still.id, { status: 'done', result: 'Нашёл два отеля.', finishedAt: new Date().toISOString() });
  assert.equal(await batch.deliver(tasks.get(still.id)!), 'notified');
  assert.deepEqual(push.sent, ['notify:Готово: «Отели», «Перелёты». Позвоните, расскажу.'], 'one notification for both');
  assert.equal(tasks.get(first.id)!.delivery, 'notified');

  const ring = await finishedTask(tasks, 'call');
  const plain = await finishedTask(tasks, 'notify', 'Счёт пришёл.');
  assert.equal(await batch.flush(), 'ringing', 'one task asked for a call: the whole batch rings');
  assert.deepEqual([tasks.get(ring.id)!.delivery, tasks.get(plain.id)!.delivery], ['ringing', 'ringing']);
  assert.equal(push.sent[1], `call:${ring.id}`);
  await wait(60);
  assert.equal(push.sent[2], 'notify:Готово: «Перелёты», «Перелёты». Позвоните, расскажу.', 'unanswered call falls back to one notification');
  assert.equal(tasks.get(plain.id)!.delivery, 'notified');

  const answered = await finishedTask(tasks, 'call');
  await batch.deliver(answered);
  await tasks.patch(answered.id, { delivery: 'heard' });
  await wait(60);
  assert.equal(push.sent.length, 4, 'answered call: no fallback');
  batch.close();
});

test('delivery without APNs or without tokens leaves the result for the next call', async () => {
  const tasks = await store();
  await tasks.load();
  const task = await finishedTask(tasks, 'call');
  assert.equal(await new TaskDelivery({ store: tasks, calls: new LiveCalls(), log: silentLogger }).deliver(task), 'pending');
  const noTokens = fakePush({ call: false, notify: false });
  assert.equal(await new TaskDelivery({ store: tasks, calls: new LiveCalls(), push: noTokens, log: silentLogger }).deliver(task), 'pending');
  assert.equal(tasks.get(task.id)!.delivery, 'pending');
});

test('delivery: a callback rings only after the result is summarized for voice', async () => {
  const tasks = await store();
  await tasks.load();
  const push = fakePush();
  const summarized: string[] = [];
  const delivery = new TaskDelivery({ store: tasks, calls: new LiveCalls(), push, log: silentLogger, fallbackMs: 30,
    summarize: async task => { summarized.push(`${push.sent.length}:${task.title}`); return 'Лучший второй.'; } });
  const task = await finishedTask(tasks, 'call');
  assert.equal(await delivery.flush(), 'ringing');
  assert.deepEqual(summarized, ['0:Перелёты'], 'summary is ready before the push');
  assert.equal(tasks.get(task.id)!.summary, 'Лучший второй.');
  delivery.close();
});

test('call context: a callback call opens with the result; unheard results come up in the next call', async () => {
  const tasks = await store();
  await tasks.load();
  const callback = await finishedTask(tasks, 'call');
  await tasks.patch(callback.id, { delivery: 'ringing' });
  const missed = await finishedTask(tasks, 'notify', 'Счёт пришёл.');
  const heard = await finishedTask(tasks, 'notify', 'Уже слышал.');
  await tasks.patch(heard.id, { delivery: 'heard' });

  const answered = taskContext(tasks, callback.id);
  assert.match(answered.opening, /перезваниваешь пользователю, потому что фоновое задание «Перелёты» готово/);
  assert.match(answered.opening, /не здоровайся обычной фразой.*что сделано и какой результат/);
  const running = await tasks.create({ title: 'Отели', prompt: 'p' });
  assert.match(taskContext(tasks, null).section, /Сейчас в работе фоновых заданий: 1 \(«Отели»\)/);
  await tasks.patch(running.id, { status: 'cancelled' });
  assert.match(answered.opening, /Итог: Нашёл три варианта/);
  assert.match(answered.section, /Счёт пришёл/);
  assert.doesNotMatch(answered.section, /Уже слышал/);
  assert.deepEqual(answered.heard.sort(), [callback.id, missed.id].sort());

  assert.deepEqual(taskContext(tasks, null).heard.sort(), [callback.id, missed.id].sort(), 'without the header only the unheard list');
  assert.equal(taskContext(tasks, null).opening, '', 'an ordinary call keeps the usual greeting');
  assert.deepEqual(taskContext(tasks, 'ffffffffffffffff'), taskContext(tasks, null));
  await tasks.patch(callback.id, { summary: 'Второй вариант лучший.' });
  assert.match(taskContext(tasks, callback.id).opening, /Итог: Второй вариант лучший\./, 'the short summary is told, not the raw report');
});

// Аудит 26.09.2026: правило «Работа» велело об итогах спрашивать бэкенд, а секция уже клала итог в промпт.
test('call context: a result already in the prompt is told by Volna herself; only the rest goes to the backend', async () => {
  const tasks = await store();
  await tasks.load();
  await finishedTask(tasks, 'notify', 'Счёт пришёл.');
  await tasks.create({ title: 'Отели', prompt: 'p' });
  const { section } = taskContext(tasks, null);
  assert.match(section, /Итог уже здесь: когда пользователь захочет, рассказывай сам, бэкенд не спрашивай/);
  assert.match(section, /как идут, узнаешь у бэкенда/);
  assert.doesNotMatch(section, /tasks_list/, 'the voice model does not call tools by name');
});

// Аудит 26.09.2026: голосовое правило «об итогах спрашивай бэкенд, сам не отвечай» спорило с итогом, уже лежащим в
// инструкциях; дневной текст (363cc0e) вернул противоречие, в тот же день правило снова говорит только о том, чего там нет.
test('call context: the voice rule on work does not contradict a result already in the prompt', async () => {
  const tasks = await store();
  await tasks.load();
  await finishedTask(tasks, 'notify', 'Счёт пришёл.');
  const voice = buildInstructions(['work_start'], taskContext(tasks, null).section);
  assert.match(voice, /О ходе работы и об итогах, которых нет в инструкциях выше .*спрашивай бэкенд/);
  assert.doesNotMatch(voice, /сам не отвечай/);
  assert.match(voice, /готовый итог из инструкций рассказывай сам/);
});

test('tools: start does not ask how to report, list shows progress of running tasks, call back waits for all, cancel stops', async () => {
  const tasks = await store();
  await tasks.load();
  const runner = new TaskRunner({ store: tasks, worker: () => new Promise(() => {}), log: silentLogger, onFinished: () => {} });
  const registry = new ToolRegistry(workTools(runner, tasks));
  assert.ok(!(registry.definitions()[0]!.parameters.required as string[]).includes('callback'));
  assert.deepEqual(JSON.parse(await registry.call('tasks_call_back', '{}', context)).callBack, false, 'nothing runs: nothing to call back about');
  const started = JSON.parse(await registry.call('work_start', JSON.stringify({ title: 'План поездки', task: 'Составь план поездки в Лиссабон на 3 дня' }), context));
  assert.deepEqual([started.callback, started.say], ['notify', 'Принято, работаю.']);
  await wait(10);
  await tasks.patch(started.id, { progress: 'Сравниваются районы Лиссабона.', progressAt: '2026-09-22T10:00:30Z' });
  const done = await finishedTask(tasks, 'notify');
  const listed = JSON.parse(await registry.call('tasks_list', '{}', context));
  assert.deepEqual(listed.tasks.map((t: any) => [t.title, t.progress]), [['Перелёты', null], ['План поездки', 'Сравниваются районы Лиссабона.']]);
  assert.equal(tasks.get(done.id)!.delivery, 'heard');
  const callBack = JSON.parse(await registry.call('tasks_call_back', '{}', context));
  assert.deepEqual([callBack.callBack, callBack.running], [true, 1]);
  assert.equal(tasks.get(started.id)!.callback, 'call');
  assert.deepEqual(JSON.parse(await registry.call('task_cancel', JSON.stringify({ id: started.id }), context)), { cancelled: true, id: started.id });
  assert.equal(JSON.parse(await registry.call('task_cancel', JSON.stringify({ id: started.id }), context)).cancelled, false);
});

test('notification text: one task gives the title and the first sentence; a batch lists titles; failures say so', () => {
  const base = { id: 'a', title: 'Отели', prompt: '', kind: 'think', callback: 'notify', delivery: 'pending', createdAt: '', startedAt: null, finishedAt: null, error: null, progress: null, progressAt: null } as const;
  assert.equal(notificationBody([{ ...base, status: 'done', result: 'Лучший — «Альфама». Ещё два хуже.' }]), '«Отели» готово. Лучший — «Альфама».');
  assert.match(notificationBody([{ ...base, status: 'failed', result: null }]), /не получилось/);
  assert.equal(notificationBody([{ ...base, status: 'done', result: 'x' }, { ...base, title: 'Билеты', status: 'failed', result: null }]), 'Готово: «Отели». Не получилось: «Билеты». Позвоните, расскажу.');
});

test('progress: the runner logs what the worker does; a cheap model turns fresh lines into one phrase for running tasks', async () => {
  const tasks = await store();
  await tasks.load();
  let release!: () => void;
  const worker: TaskWorker = async (_task, _signal, note) => {
    note('думает: Сначала узнаю время.');
    note('действие: current_time');
    await new Promise<void>(resolve => { release = resolve; });
    return 'Готово.';
  };
  const prompts: string[] = [];
  const cheap: ChatModel = { model: 'c', complete: async messages => { prompts.push(messages[1]!.content as string); return reply(' Узнаётся текущее время. '); } };
  const progress = new TaskProgress({ store: tasks, model: cheap, log: silentLogger });
  const runner = new TaskRunner({ store: tasks, worker, log: silentLogger, progress, onFinished: () => {} });
  const task = await runner.start({ title: 'Время', prompt: 'p' });
  await wait(20);
  await progress.tick();
  assert.match(prompts[0]!, /Задание: «Время»/);
  assert.match(prompts[0]!, /думает: Сначала узнаю время\.\n- действие: current_time/);
  assert.equal(tasks.get(task.id)!.progress, 'Узнаётся текущее время.');
  await progress.tick();
  assert.equal(prompts.length, 1, 'no fresh lines: no request');
  release();
  await wait(20);
  progress.note(task.id, 'поздняя запись');
  await progress.tick();
  assert.equal(prompts.length, 1, 'finished tasks are not summarized');
});

test('POST /session with X-Callback-Task puts the result into the instructions and marks it heard', async () => {
  const tasks = await store();
  await tasks.load();
  const task = await finishedTask(tasks, 'call');
  await tasks.patch(task.id, { delivery: 'ringing' });
  let session: any;
  await run({ apiKey: 'secret', tasks, fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, null); } },
    async url => { assert.equal((await post(url, offer, { 'X-Callback-Task': task.id })).status, 200); });
  assert.match(session.instructions, /перезваниваешь пользователю/);
  await wait(10);
  assert.equal(tasks.get(task.id)!.delivery, 'heard');
});

test('tasks saved before 07.10.2026 with t3Thread, t3Pending and t3Project are read under the new names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-legacy-'));
  const base = { title: 'Старое', prompt: 'x', kind: 'computer', callback: 'notify', delivery: 'pending', createdAt: '2026-10-05T10:00:00.000Z', startedAt: '2026-10-05T10:00:00.000Z', finishedAt: null, result: null, error: null };
  await writeFile(join(dir, 'tasks.json'), JSON.stringify({ tasks: [
    { ...base, id: 'a', status: 'running', t3Thread: 'thread-1', t3Pending: false, t3Project: 'p1' },
    { ...base, id: 'b', status: 'done', finishedAt: '2026-10-05T11:00:00.000Z', helmThread: 'new', t3Thread: 'old' }
  ] }));
  const store = new TaskStore(dir, { resumable: task => Boolean(task.helmThread) });
  await store.load();
  assert.deepEqual([store.get('a')!.helmThread, store.get('a')!.helmPending, store.get('a')!.helmProject, store.get('a')!.status], ['thread-1', false, 'p1', 'running'], 'still resumable after the rename');
  assert.equal(store.get('b')!.helmThread, 'new', 'the new name wins');
  await store.patch('a', { progress: 'идёт' });
  const saved = await readFile(join(dir, 'tasks.json'), 'utf8');
  assert.doesNotMatch(saved, /t3Thread|t3Project|t3Pending/);
});
