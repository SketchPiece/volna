import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { TaskStore, type Task } from '../tasks/store.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { helmWorker } from './worker.ts';
import { activity, fakeHelm, message, thread, turn } from './test-support.ts';

/** Надёжность заданий Волны в «Штурвале» (docs/task-sync.md, этап 1): перезапуск ядра, сбой при создании треда, долгая работа. */

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!ready() && Date.now() - started < timeoutMs) await wait(10);
}
const resumable = (task: Task) => Boolean(task.helmThread);

function server(helm: ReturnType<typeof fakeHelm>, store: TaskStore, options: { stallMs?: number; timeoutMs?: number } = {}) {
  const finished: Task[] = [];
  const runner = new TaskRunner({
    store, log: silentLogger, onFinished: task => { finished.push(task); }, timeoutMs: options.timeoutMs,
    worker: helmWorker({ client: helm.client, store, projectDir: '/Users/me/Volna Work', instance: 'claudeAgent', model: null, runtimeMode: 'auto', pollMs: 5, maxMisses: 3, stallMs: options.stallMs })
  });
  return { runner, finished };
}

test('a core restart in the middle of work keeps watching the same thread, and the result still arrives', async () => {
  const helm = fakeHelm();
  helm.threads.set('th-1', thread('th-1', 'Отчёт'));
  let done = false;
  helm.script = t => Object.assign(t, done
    ? { latestTurn: turn('completed', { assistantMessageId: 'm1' }), messages: [message('m1', 'Отчёт готов.')] }
    : { latestTurn: turn('running') });
  // До перезапуска: задание шло в треде th-1, ядро остановилось посреди работы.
  const dir = await mkdtemp(join(tmpdir(), 'helm-resume-'));
  const before = new TaskStore(dir, { resumable });
  await before.load();
  const task = await before.create({ title: 'Отчёт', prompt: 'Собери отчёт' });
  await before.patch(task.id, { status: 'running', startedAt: new Date().toISOString(), helmThread: 'th-1' });

  const after = new TaskStore(dir, { resumable });
  await after.load();
  assert.equal(after.get(task.id)?.status, 'running', 'not failed/interrupted: the thread goes on in Helm');
  const { runner, finished } = server(helm, after);
  assert.equal(runner.resume(), 1);
  await wait(30);
  done = true;
  await until(() => finished.length > 0);
  assert.deepEqual([finished[0]?.status, finished[0]?.result], ['done', 'Отчёт готов.']);
  assert.deepEqual(helm.commands, [], 'nothing is started again');
  assert.equal(after.get(task.id)?.helmThread, 'th-1');
});

test('without Helm the store still fails running tasks on load, as before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-resume-'));
  const before = new TaskStore(dir);
  await before.load();
  const task = await before.create({ title: 'Старое', prompt: 'x' });
  await before.patch(task.id, { status: 'running', helmThread: 'th-1' });
  const after = new TaskStore(dir);
  await after.load();
  assert.deepEqual([after.get(task.id)?.status, after.get(task.id)?.error], ['failed', 'interrupted']);
});

test('the thread id is written into the task before the launch: a failure in between leaves no orphan thread', async () => {
  const helm = fakeHelm();
  helm.failing.add('thread.launch');
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'helm-resume-')), { resumable });
  await store.load();
  const { runner, finished } = server(helm, store);
  const task = await runner.start({ title: 'Сбой', prompt: 'Сделай' });
  await until(() => finished.length > 0);
  const saved = store.get(task.id)!;
  assert.equal(saved.status, 'failed');
  assert.ok(saved.helmThread, 'the id was recorded first');
  assert.equal(saved.helmPending, true, 'and it is marked as not confirmed');
  assert.equal(helm.threads.size, 0, 'Helm has no thread without a task');
});

test('after a restart a task whose launch never reached Helm fails as interrupted', async () => {
  const helm = fakeHelm();
  const dir = await mkdtemp(join(tmpdir(), 'helm-resume-'));
  const before = new TaskStore(dir, { resumable });
  await before.load();
  const task = await before.create({ title: 'Не дошло', prompt: 'x' });
  await before.patch(task.id, { status: 'running', startedAt: new Date().toISOString(), helmThread: 'never-created', helmPending: true });
  const after = new TaskStore(dir, { resumable });
  await after.load();
  const { runner, finished } = server(helm, after);
  runner.resume();
  await until(() => finished.length > 0);
  assert.deepEqual([finished[0]?.status, finished[0]?.error], ['failed', 'interrupted']);
});

test('a restart right after the launch confirms the pending thread once Helm shows it', async () => {
  const helm = fakeHelm();
  helm.threads.set('th-1', thread('th-1', 'Дошло'));
  helm.script = t => Object.assign(t, { latestTurn: turn('completed', { assistantMessageId: 'm1' }), messages: [message('m1', 'Сделано.')] });
  const dir = await mkdtemp(join(tmpdir(), 'helm-resume-'));
  const before = new TaskStore(dir, { resumable });
  await before.load();
  const task = await before.create({ title: 'Дошло', prompt: 'x' });
  await before.patch(task.id, { status: 'running', startedAt: new Date().toISOString(), helmThread: 'th-1', helmPending: true });
  const after = new TaskStore(dir, { resumable });
  await after.load();
  const { runner, finished } = server(helm, after);
  runner.resume();
  await until(() => finished.length > 0);
  assert.equal(finished[0]?.result, 'Сделано.');
  assert.equal(after.get(task.id)?.helmPending, undefined);
});

test('long work keeps going while the thread shows activity; a thread without changes fails as helm_stalled', async () => {
  const helm = fakeHelm();
  // Живой тред: каждый опрос новая активность, итог после 40 опросов (дольше, чем stallMs).
  helm.script = (t, n) => Object.assign(t, n < 40
    ? { latestTurn: turn('running'), activities: [activity(`a${n}`, 'tool.started', {}, { summary: `шаг ${n}` })] }
    : { latestTurn: turn('completed', { assistantMessageId: 'm1' }), messages: [message('m1', 'Долго, но готово.')] });
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'helm-resume-')), { resumable });
  await store.load();
  const { runner, finished } = server(helm, store, { stallMs: 60 });
  await runner.start({ title: 'Долго', prompt: 'Долгая работа' });
  await until(() => finished.length > 0);
  assert.deepEqual([finished[0]?.status, finished[0]?.result], ['done', 'Долго, но готово.']);

  const quiet = fakeHelm();
  quiet.script = t => Object.assign(t, { latestTurn: turn('running') });
  const store2 = new TaskStore(await mkdtemp(join(tmpdir(), 'helm-resume-')), { resumable });
  await store2.load();
  const stalled = server(quiet, store2, { stallMs: 60 });
  await stalled.runner.start({ title: 'Тишина', prompt: 'Ничего' });
  await until(() => stalled.finished.length > 0);
  assert.deepEqual([stalled.finished[0]?.status, stalled.finished[0]?.error], ['failed', 'helm_stalled']);
  assert.ok(quiet.commands.some(c => c.type === 'run.interrupt'), 'the stalled turn is stopped');
});

test('waiting for the owner is not a stall', async () => {
  const helm = fakeHelm();
  const question = { requestId: 'q1', questions: [{ id: 'x', header: '', question: 'Какой бюджет?', options: [], multiSelect: false }] };
  helm.script = t => Object.assign(t, { latestTurn: turn('running'), activities: [activity('a1', 'user-input.requested', question)] });
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'helm-resume-')), { resumable });
  await store.load();
  const { runner, finished } = server(helm, store, { stallMs: 30 });
  const task = await runner.start({ title: 'Вопрос', prompt: 'Спроси бюджет' });
  await wait(150);
  assert.equal(finished.length, 0);
  assert.equal(store.get(task.id)?.status, 'running');
  await runner.cancel(task.id);
});
