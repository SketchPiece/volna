import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../log.ts';
import { TaskStore } from '../tasks/store.ts';
import { activity, fakeHelm, thread, turn } from '../helm/test-support.ts';
import { WorkSync } from './sync.ts';

/** Реестр работы (docs/task-sync.md, этап 2) на поддельном «Штурвале»: статусы, устаревшие снимки, сбои, заметки, лог. */

const shellThread = (id: string, title: string, patch: object = {}) => ({
  id, projectId: 'p1', title, latestTurn: null, session: null, updatedAt: '2026-09-26T10:00:00Z', archivedAt: null,
  hasPendingApprovals: false, hasPendingUserInput: false, ...patch
});
const PROJECT = { id: 'p1', title: 'CallAssistant', workspaceRoot: '/Users/me/CallAssistant', defaultModelSelection: null };

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const write = (message: string, fields?: object) => { lines.push(`${message} ${JSON.stringify(fields ?? {})}`); };
  return { lines, info: write, warn: write };
}

async function setup(options: { inCall?: boolean } = {}) {
  const helm = fakeHelm({ projects: [PROJECT] });
  const tasks = new TaskStore(await mkdtemp(join(tmpdir(), 'sync-')));
  await tasks.load();
  const log = recordingLog();
  const notes: string[] = [];
  const sync = new WorkSync({ client: helm.client, tasks, log, announce: note => notes.push(note), inCall: () => options.inCall ?? false });
  return { helm, tasks, log, notes, sync, poll: () => sync.poll(AbortSignal.timeout(2000)) };
}

test('owner threads get their state from Helm by the table; archived ones are not listed', async () => {
  const { helm, sync, poll } = await setup();
  helm.shell.threads.push(
    shellThread('a', 'Спрашивает', { hasPendingUserInput: true, latestTurn: turn('running') }),
    shellThread('b', 'Ждёт разрешения', { hasPendingApprovals: true }),
    shellThread('c', 'Работает', { latestTurn: turn('running') }),
    shellThread('d', 'Запускается', { session: { status: 'starting', lastError: null } }),
    shellThread('e', 'Сбой', { latestTurn: turn('error') }),
    shellThread('f', 'Закончил', { latestTurn: turn('completed') }),
    shellThread('g', 'Остановлен', { latestTurn: turn('interrupted') }),
    shellThread('h', 'В архиве', { archivedAt: '2026-09-26T09:00:00Z' })
  );
  await poll();
  const byThread = Object.fromEntries(sync.items().map(i => [i.thread, i]));
  assert.deepEqual(Object.fromEntries(Object.entries(byThread).map(([k, v]) => [k, (v as { status: string }).status])), {
    a: 'needs_you', b: 'needs_you', c: 'working', d: 'working', e: 'failed', f: 'idle', g: 'idle'
  });
  assert.deepEqual(byThread.a!.waiting, { kind: 'question', text: null }, 'owner threads show only the kind of waiting');
  assert.deepEqual(byThread.b!.waiting, { kind: 'approval', text: null });
  assert.deepEqual([byThread.c!.origin, byThread.c!.id, byThread.c!.project], ['owner', 'helm:c', { id: 'p1', title: 'CallAssistant' }]);
  assert.equal(sync.access, 'ok');
});

test('a Volna task is linked to its thread only by helmThread; a finished task continued by the owner shows the new turn', async () => {
  const { helm, tasks, sync, poll } = await setup();
  const running = await tasks.create({ title: 'Отчёт', prompt: 'x' });
  await tasks.patch(running.id, { status: 'running', helmThread: 'r', progress: 'читает файлы', waiting: { kind: 'question', text: 'Какой формат?' } });
  const done = await tasks.create({ title: 'Старое', prompt: 'y' });
  await tasks.patch(done.id, { status: 'done', helmThread: 'd', result: 'Готово.', finishedAt: '2026-09-26T09:00:00Z' });
  const queued = await tasks.create({ title: 'В очереди', prompt: 'z' });
  helm.shell.threads.push(
    shellThread('r', 'Отчёт', { latestTurn: turn('running'), hasPendingUserInput: true }),
    shellThread('d', 'Старое', { latestTurn: turn('running', { turnId: 't2' }) }),
    shellThread('x', 'Отчёт', { latestTurn: turn('running') })
  );
  await poll();
  const items = sync.items();
  const of = (task: string) => items.find(i => i.task === task)!;
  assert.deepEqual([of(running.id).id, of(running.id).origin, of(running.id).status], ['helm:r', 'volna', 'needs_you']);
  assert.deepEqual(of(running.id).waiting, { kind: 'question', text: 'Какой формат?' }, 'a Volna task keeps its question text');
  assert.equal(of(running.id).progress, 'читает файлы');
  assert.deepEqual([of(done.id).status, of(done.id).result], ['working', 'Готово.']);
  assert.equal(tasks.get(done.id)?.status, 'done', 'the task itself stays done');
  assert.deepEqual([of(queued.id).id, of(queued.id).status], [`task:${queued.id}`, 'queued']);
  assert.equal(items.find(i => i.thread === 'x')?.origin, 'owner', 'the same title does not link a thread to a task');
});

test('a thread gone from Helm makes a running task "gone"; a pending thread is not called gone', async () => {
  const { tasks, sync, poll } = await setup();
  const lost = await tasks.create({ title: 'Пропал', prompt: 'x' });
  await tasks.patch(lost.id, { status: 'running', helmThread: 'lost' });
  const pending = await tasks.create({ title: 'Создаётся', prompt: 'y' });
  await tasks.patch(pending.id, { status: 'running', helmThread: 'new', helmPending: true });
  await poll();
  const items = sync.items();
  assert.equal(items.find(i => i.task === lost.id)?.status, 'gone');
  assert.equal(items.find(i => i.task === pending.id)?.status, 'working');
});

test('Helm offline keeps the last known list marked stale; unauthorized stops polling; one log line per change', async () => {
  const { helm, sync, log, poll } = await setup();
  helm.shell.threads.push(shellThread('c', 'Работает', { latestTurn: turn('running') }));
  await poll();
  helm.setOffline(true);
  await poll();
  await poll();
  assert.equal(sync.access, 'offline');
  assert.deepEqual(sync.items().map(i => [i.thread, i.status, i.stale]), [['c', 'working', true]]);
  assert.equal(log.lines.filter(l => l.startsWith('sync.helm.offline')).length, 1);
  helm.setOffline(false);
  await poll();
  assert.equal(sync.items()[0]?.stale, false);

  const denied = fakeHelm();
  const blocked = new WorkSync({ client: new (denied.client.constructor as any)({ url: 'http://helm.test', token: 't', fetchImpl: async () => new Response('{}', { status: 401 }) }), log });
  blocked.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(blocked.access, 'unauthorized');
  blocked.stop();
});

test('an older snapshot of a thread does not overwrite a newer one', async () => {
  const { helm, sync, poll } = await setup();
  helm.shell.threads.push(shellThread('c', 'Тред', { latestTurn: turn('completed'), updatedAt: '2026-09-26T10:05:00Z' }));
  await poll();
  helm.shell.threads[0] = shellThread('c', 'Тред', { latestTurn: turn('running'), updatedAt: '2026-09-26T10:01:00Z' });
  await poll();
  assert.equal(sync.items()[0]?.status, 'idle');
});

test('sync only reads: it never dispatches a command to Helm', async () => {
  const { helm, tasks, poll } = await setup({ inCall: true });
  const task = await tasks.create({ title: 'Задание', prompt: 'x' });
  await tasks.patch(task.id, { status: 'running', helmThread: 'r' });
  helm.shell.threads.push(shellThread('r', 'Задание', { latestTurn: turn('running') }), shellThread('q', 'Вопрос', { hasPendingUserInput: true }));
  helm.threads.set('q', thread('q', 'Вопрос', { activities: [activity('a1', 'user-input.requested', { requestId: 'rq', questions: [{ id: 'x', question: 'Что дальше?', options: [] }] })] }));
  await poll();
  await poll();
  assert.deepEqual(helm.commands, []);
});

test('a question in an owner thread is announced once during a call, with the thread id for work_answer; not outside a call', async () => {
  const quiet = await setup({ inCall: false });
  quiet.helm.shell.threads.push(shellThread('q', 'Лендинг', { hasPendingUserInput: true }));
  quiet.helm.threads.set('q', thread('q', 'Лендинг', { activities: [activity('a1', 'user-input.requested', { requestId: 'rq', questions: [{ id: 'x', question: 'Какой цвет кнопки?', options: [{ label: 'Синий' }, { label: 'Красный' }] }] })] }));
  await quiet.poll();
  assert.deepEqual(quiet.notes, []);

  const { helm, notes, poll, log } = await setup({ inCall: true });
  helm.shell.threads.push(shellThread('q', 'Лендинг', { hasPendingUserInput: true }), shellThread('p', 'Деплой', { hasPendingApprovals: true }));
  helm.threads.set('q', thread('q', 'Лендинг', { activities: [activity('a1', 'user-input.requested', { requestId: 'rq', questions: [{ id: 'x', question: 'Какой цвет кнопки?', options: [{ label: 'Синий' }, { label: 'Красный' }] }] })] }));
  helm.threads.set('p', thread('p', 'Деплой', { activities: [activity('a2', 'approval.requested', { requestId: 'ra', requestKind: 'command', detail: 'rm -rf dist' })] }));
  await poll();
  await poll();
  assert.equal(notes.length, 2, 'once per request');
  const question = notes.find(n => n.includes('Лендинг'))!;
  assert.match(question, /спрашивает: Какой цвет кнопки\? Варианты: Синий; Красный\./);
  assert.match(question, /work_answer \(id треда q\)/);
  assert.match(question, /проект CallAssistant/);
  const approval = notes.find(n => n.includes('Деплой'))!;
  assert.match(approval, /ждёт разрешения\. Голосом его дать нельзя/);
  assert.doesNotMatch(approval, /rm -rf/);
  assert.ok(log.lines.every(l => !/Лендинг|Деплой|цвет/.test(l)));
});

test('the sync log has ids, states and codes only: no titles, progress or results', async () => {
  const { helm, tasks, log, poll } = await setup({ inCall: true });
  const task = await tasks.create({ title: 'Секретный проект мамы', prompt: 'x' });
  await tasks.patch(task.id, { status: 'done', helmThread: 'r', progress: 'читает дневник', result: 'Итог про маму' });
  helm.shell.threads.push(shellThread('r', 'Секретный проект мамы'), shellThread('o', 'Личное письмо', { hasPendingUserInput: true }));
  helm.threads.set('o', thread('o', 'Личное письмо', { activities: [activity('a1', 'user-input.requested', { requestId: 'rq', questions: [{ id: 'x', question: 'Кому?', options: [] }] })] }));
  await poll();
  helm.setOffline(true);
  await poll();
  helm.setOffline(false);
  await poll();
  assert.ok(log.lines.length >= 3);
  for (const line of log.lines) assert.doesNotMatch(line, /Секрет|мамы|дневник|Итог|Личное|Кому/);
});
