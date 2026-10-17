import test from 'node:test';
import assert from 'node:assert/strict';
import { silentLogger } from '../log.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { helmTools } from './tools.ts';
import { fakeHelm, turn } from './test-support.ts';


const context = { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => new Date('2026-09-25T10:00:00Z') };
const shellThread = (id: string, title: string, patch: object = {}) => ({
  id, projectId: 'p1', title, latestTurn: null, session: null, updatedAt: `2026-09-25T10:00:0${id.length}Z`, archivedAt: null,
  hasPendingApprovals: false, hasPendingUserInput: false, ...patch
});

function setup() {
  const helm = fakeHelm({ projects: [
    { id: 'p1', title: 'CallAssistant', workspaceRoot: '/Users/me/CallAssistant', defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5' }, scripts: [] },
    { id: 'p2', title: 'Canvas', workspaceRoot: '/Users/me/canvas', defaultModelSelection: null, scripts: [] }
  ] });
  helm.shell.threads.push(
    shellThread('t1', 'Экран памяти', { hasPendingUserInput: true }),
    shellThread('t22', 'Сборка Пульта', { latestTurn: turn('running') }),
    shellThread('t333', 'Старый', { archivedAt: '2026-09-20T10:00:00Z' })
  );
  return { helm, tools: new ToolRegistry(helmTools({ client: helm.client, runtimeMode: 'auto' })) };
}

test('work_threads shows live threads with voice states, archived ones hidden', async () => {
  const { tools } = setup();
  const all = JSON.parse(await tools.call('work_threads', '{}', context));
  assert.deepEqual(all.threads.map((t: any) => [t.title, t.state, t.project, t.waitingFor]), [
    ['Сборка Пульта', 'working', 'CallAssistant', null], ['Экран памяти', 'needs_you', 'CallAssistant', 'question']
  ]);
  assert.ok(all.projects.includes('CallAssistant'), 'projects are listed apart from threads: a project is not searched among thread titles');
  const waiting = JSON.parse(await tools.call('work_threads', JSON.stringify({ state: 'needs_you' }), context));
  assert.deepEqual(waiting.threads.map((t: any) => t.id), ['t1']);
});

test('work_send finds the thread by title and steers a working one without stopping it', async () => {
  const { helm, tools } = setup();
  const sent = JSON.parse(await tools.call('work_send', JSON.stringify({ id: 'экран памяти', text: 'Добавь тест' }), context));
  assert.deepEqual([sent.sent, sent.id], [true, 't1']);
  assert.deepEqual(helm.commands.map(c => [c.type, c.threadId, c.text]), [['message.dispatch', 't1', 'Добавь тест']]);
  const steered = JSON.parse(await tools.call('work_send', JSON.stringify({ id: 't22', text: 'И проверь сборку' }), context));
  assert.deepEqual([steered.sent, steered.steered], [true, true]);
  assert.deepEqual(helm.commands.at(-1)?.type, 'message.dispatch');
  helm.shell.threads.push(shellThread('t4444', 'Ждёт разрешения', { latestTurn: turn('running'), hasPendingApprovals: true }));
  const before = helm.commands.length;
  const waiting = JSON.parse(await tools.call('work_send', JSON.stringify({ id: 't4444', text: 'Стоп' }), context));
  assert.equal(waiting.error, 'waiting_permission');
  assert.equal(helm.commands.length, before, 'nothing is sent while the agent waits for a permission');
  const unknown = JSON.parse(await tools.call('work_send', JSON.stringify({ id: 'нет такого', text: 'x' }), context));
  assert.equal(unknown.error, 'unknown_thread');
  assert.equal(unknown.threads.length, 3, "live threads only: the archived one is not offered");
});

test('a new thread starts only as work (work_start): the executor adds no tool of its own to start one', () => {
  const { tools } = setup();
  assert.deepEqual(tools.names(), ['work_answer', 'work_add', 'work_threads', 'work_send', 'work_stop', 'computer_status']);
  assert.deepEqual(tools.startNames(), []);
});

test('work_answer without a task store answers the only waiting thread; Helm offline is reported, not thrown', async () => {
  const { helm, tools } = setup();
  const none = JSON.parse(await tools.call('work_answer', JSON.stringify({ answer: 'да' }), context));
  assert.equal(none.error, 'helm_not_found', 'the fake has no body for t1: the error reaches the model as a code');
  helm.setOffline(true);
  const offline = JSON.parse(await tools.call('work_threads', '{}', context));
  assert.equal(offline.error, 'helm_offline');
});
