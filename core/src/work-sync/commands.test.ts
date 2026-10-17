import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { TaskStore } from '../tasks/store.ts';
import { helmTools } from '../helm/tools.ts';
import { HelmError } from '../helm/client.ts';
import { activity, fakeHelm, thread, turn } from '../helm/test-support.ts';
import { similarWork } from './similar.ts';
import type { WorkItem } from './sync.ts';

/** Команды по списку работы (docs/task-sync.md, этап 4): остановка в любом треде, двойной ответ, смысловые дубли. */

const context = { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => new Date('2026-09-26T10:00:00Z') };
const shellThread = (id: string, title: string, patch: object = {}) => ({
  id, projectId: 'p1', title, latestTurn: null, session: null, updatedAt: '2026-09-26T10:00:00Z', archivedAt: null,
  hasPendingApprovals: false, hasPendingUserInput: false, ...patch
});

async function setup() {
  const helm = fakeHelm();
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'cmd-')));
  await store.load();
  const cancelled: string[] = [];
  const tools = new ToolRegistry(helmTools({ client: helm.client, store, runtimeMode: 'auto', cancelTask: async id => { cancelled.push(id); return true; } }));
  const call = async (name: string, args: object) => JSON.parse(await tools.call(name, JSON.stringify(args), context));
  return { helm, store, cancelled, call };
}

test('work_stop interrupts the turn in an owner thread found by title; the command does not pretend the state changed', async () => {
  const { helm, call } = await setup();
  helm.shell.threads.push(shellThread('own', 'Рефакторинг ядра', { latestTurn: turn('running') }));
  helm.threads.set('own', thread('own', 'Рефакторинг ядра', { latestTurn: turn('running', { turnId: 'run-7' }) }));
  const out = await call('work_stop', { id: 'рефакторинг' });
  assert.deepEqual([out.stopping, out.id], [true, 'own']);
  assert.deepEqual(helm.commands.map(c => [c.type, c.threadId, c.runId]), [['run.interrupt', 'own', 'run-7']]);
});

test('work_stop on the thread of running Volna work cancels the work itself', async () => {
  const { helm, store, cancelled, call } = await setup();
  const task = await store.create({ title: 'Отчёт', prompt: 'x' });
  await store.patch(task.id, { status: 'running', helmThread: 'r' });
  helm.shell.threads.push(shellThread('r', 'Отчёт', { latestTurn: turn('running') }));
  const out = await call('work_stop', { id: task.id });
  assert.deepEqual([out.stopping, out.task], [true, task.id]);
  assert.deepEqual(cancelled, [task.id]);
});

test('work_stop refuses an idle thread and an unknown one', async () => {
  const { helm, call } = await setup();
  helm.shell.threads.push(shellThread('idle', 'Готовый тред', { latestTurn: turn('completed') }));
  assert.equal((await call('work_stop', { id: 'idle' })).error, 'not_working');
  assert.equal((await call('work_stop', { id: 'нет такого' })).error, 'unknown_thread');
  assert.deepEqual(helm.commands, []);
});

test('an answer already given on the computer or in the Helm app: work_answer says so instead of answering twice', async () => {
  const { helm, call } = await setup();
  const asked = activity('a1', 'user-input.requested', { requestId: 'q1', questions: [{ id: 'x', question: 'Какой цвет?', options: [{ label: 'Синий' }] }] });
  helm.threads.set('own', thread('own', 'Лендинг', { activities: [asked, activity('a2', 'user-input.resolved', { requestId: 'q1' })] }));
  const out = await call('work_answer', { id: 'own', answer: 'Синий' });
  assert.deepEqual([out.error, out.say], ['already_answered', 'На этот вопрос уже ответили.']);
  assert.deepEqual(helm.commands, []);

  // Гонка: вопрос ещё виден, но окно ответило раньше, и сервер отклонил второй ответ.
  const race = fakeHelm();
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'cmd-')));
  await store.load();
  let answered = false;
  race.threads.set('own', thread('own', 'Лендинг'));
  race.script = t => Object.assign(t, { activities: answered ? [asked, activity('a2', 'user-input.resolved', { requestId: 'q1' })] : [asked] });
  const client = race.client;
  client.answerUserInput = async () => { answered = true; throw new HelmError('helm_rejected', 422); };
  const tools = new ToolRegistry(helmTools({ client, store, runtimeMode: 'auto' }));
  const raced = JSON.parse(await tools.call('work_answer', JSON.stringify({ id: 'own', answer: 'Синий' }), context));
  assert.equal(raced.error, 'already_answered');
});

const item = (title: string, patch: Partial<WorkItem> = {}): WorkItem => ({
  id: `helm:${title}`, origin: 'owner', task: null, thread: title, project: { id: 'p1', title: 'CallAssistant' }, title, status: 'working',
  waiting: null, progress: null, result: null, error: null, updatedAt: '2026-09-26T10:00:00Z', finishedAt: null, stale: false, ...patch
});

test('similar work: same project and close title; finished work and other projects do not count', () => {
  const items = [item('Починить тесты ядра'), item('Лендинг для мамы', { project: { id: 'p2', title: 'Сайт' } }), item('Обновить README', { status: 'idle' })];
  assert.equal(similarWork(items, 'Почини тесты', 'CallAssistant')?.title, 'Починить тесты ядра');
  assert.equal(similarWork(items, 'Почини тесты', 'Сайт'), null, 'another project');
  assert.equal(similarWork(items, 'Обновить README', null), null, 'idle work is not a duplicate');
  assert.equal(similarWork(items, 'Сравнить тарифы связи', null), null);
});
