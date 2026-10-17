import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswers, latestAssistantText, pendingRequests, HelmClient, HelmError } from './client.ts';
import { HelmRpcError } from './rpc.ts';
import { activity, fakeHelm, message, thread, turn } from './test-support.ts';

const signal = () => AbortSignal.timeout(2000);

test('the version check accepts the tested line (protocol 2) and refuses another major or protocol', async () => {
  assert.deepEqual(await fakeHelm().client.check(), { ok: true, version: '0.0.45' });
  assert.deepEqual(await fakeHelm({ version: '0.1.3' }).client.check(), { ok: true, version: '0.1.3' });
  assert.deepEqual(await fakeHelm({ version: '1.0.0' }).client.check(), { ok: false, version: '1.0.0', reason: 'helm_incompatible' });
  assert.deepEqual(await fakeHelm({ protocol: 1, version: '0.0.42' }).client.check(), { ok: false, version: '0.0.42', reason: 'helm_incompatible' }, 'T3 Code before the new orchestrator');
  const off = fakeHelm();
  off.setOffline(true);
  assert.deepEqual(await off.client.check(), { ok: false, version: null, reason: 'helm_offline' });
});

test('an incompatible server gets no commands; interrupt of a running turn still goes through', async () => {
  const helm = fakeHelm({ version: '1.2.0' });
  helm.threads.set('th', thread('th', 'Работа', { latestTurn: turn('running', { turnId: 'run-1' }) }));
  await assert.rejects(helm.client.sendMessage('th', 'привет', signal()), (error: HelmError) => error.name === 'helm_incompatible');
  assert.equal(helm.commands.length, 0);
  await helm.client.interrupt('th', signal());
  assert.deepEqual(helm.commands.map(c => [c.type, c.threadId, c.runId]), [['run.interrupt', 'th', 'run-1']]);
});

test('interrupt without a running turn sends nothing', async () => {
  const helm = fakeHelm();
  helm.threads.set('th', thread('th', 'Работа', { latestTurn: turn('completed') }));
  assert.equal(await helm.client.interrupt('th', signal()), 0);
  assert.deepEqual(helm.commands, []);
});

test('startThread finds the project by folder and launches the thread with its first message in one RPC', async () => {
  const helm = fakeHelm({ projects: [{ id: 'p1', title: 'Work', workspaceRoot: '/Users/me/Work', defaultModelSelection: null, scripts: [] }] });
  const project = await helm.client.ensureProject('/Users/me/Work/', 'Волна: Работа', signal());
  assert.equal(project.id, 'p1');
  const { threadId } = await helm.client.startThread({
    projectId: project.id, title: 'Погода', text: 'Узнай погоду', modelSelection: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' }, runtimeMode: 'auto'
  }, signal());
  const [launch] = helm.commands;
  assert.equal(helm.commands.length, 1);
  assert.deepEqual(launch, {
    type: 'thread.launch', commandId: launch.commandId, creationSource: 'mobile', threadId, projectId: 'p1', title: 'Погода',
    modelSelection: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' }, runtimeMode: 'auto', interactionMode: 'default',
    workspaceStrategy: { type: 'root' }, initialMessage: { messageId: launch.initialMessage.messageId, text: 'Узнай погоду', attachments: [] }
  });
  assert.equal(new Set([launch.commandId, threadId, launch.initialMessage.messageId]).size, 3);
  assert.ok(helm.auth.every(header => header === 'Bearer secret-token'));
  assert.ok(helm.headers.every(h => h['x-t3-orchestration-protocol'] === '2'), 'every HTTP read names protocol 2');
});

test('a worktree launch asks Helm for its own branch from HEAD', async () => {
  const helm = fakeHelm();
  await helm.client.startThread({ projectId: 'p1', title: 'Т', text: 'Почини', modelSelection: { instanceId: 'claudeAgent', model: 'm' }, runtimeMode: 'auto', branch: 'wave/0123456789abcdef' }, signal());
  assert.deepEqual(helm.commands[0].workspaceStrategy, { type: 'worktree', baseRef: 'HEAD', branch: 'wave/0123456789abcdef' });
});

test('messages go as message.dispatch from the owner and let Helm steer them into a running turn', async () => {
  const helm = fakeHelm();
  await helm.client.sendMessage('th', 'И ещё PDF', signal());
  const [sent] = helm.commands;
  assert.deepEqual(sent, {
    type: 'message.dispatch', createdBy: 'user', creationSource: 'mobile', threadId: 'th', messageId: sent.messageId, text: 'И ещё PDF',
    attachments: [], deliveryIntent: 'steer', dispatchMode: { type: 'start_immediately' }, commandId: sent.commandId
  });
  await helm.client.answerUserInput('th', 'rq', { color: 'Синий' }, signal());
  assert.deepEqual(helm.commands[1], { type: 'runtime-request.respond', threadId: 'th', requestId: 'rq', answers: { color: 'Синий' }, commandId: helm.commands[1].commandId });
});

test('the shell is read in protocol 2 and folded into turns, errors and waiting flags', async () => {
  const helm = fakeHelm();
  helm.shell.threads.push(
    thread('a', 'Идёт', { latestTurn: turn('running', { turnId: 'r1' }) }),
    thread('b', 'Спрашивает', { latestTurn: turn('running', { turnId: 'r2' }), hasPendingUserInput: true }),
    thread('c', 'Упал', { latestTurn: turn('error', { turnId: 'r3' }) }),
    thread('d', 'Новый')
  );
  const { threads } = await helm.client.shell(signal());
  assert.deepEqual(threads.map(t => [t.id, t.latestTurn?.turnId ?? null, t.latestTurn?.state ?? null, t.hasPendingUserInput, t.hasPendingApprovals]), [
    ['a', 'r1', 'running', false, false], ['b', 'r2', 'running', true, false], ['c', 'r3', 'error', false, false], ['d', null, null, false, false]
  ]);
});

test('RPC failures become coded errors: offline, rejected, and the same codes through the Relay', async () => {
  const fail = (error: Error) => new HelmClient({ url: 'http://helm.test', token: 'x', fetchImpl: (async () => new Response(JSON.stringify({ serverVersion: '0.0.45', orchestrationProtocolVersion: 2 }), { status: 200 })) as typeof fetch, rpc: async () => { throw error; } });
  const code = async (error: Error) => ((await fail(error).sendMessage('th', 'x', signal()).catch((e: HelmError) => e)) as HelmError).name;
  assert.equal(await code(new HelmRpcError('offline')), 'helm_offline');
  assert.equal(await code(new HelmRpcError('fail', 'OrchestrationCommandRejectedError')), 'helm_rejected');
  assert.equal(await code(new HelmRpcError('die')), 'helm_error');
  assert.equal(await code(new Error('relay: helm_offline')), 'helm_offline');
  assert.equal(await code(new Error('relay: relay_offline')), 'helm_offline');
  assert.equal(await code(new Error('relay: helm_fail:SomethingRejected')), 'helm_rejected');
  assert.equal(await code(new Error('relay: not_allowed')), 'helm_error');
});

test('ensureProject creates a missing project for the folder', async () => {
  const helm = fakeHelm();
  const project = await helm.client.ensureProject('/Users/me/Volna Work', 'Волна: Работа', signal());
  assert.deepEqual(helm.commands.map(c => [c.type, c.workspaceRoot, c.createWorkspaceRootIfMissing]), [['project.create', '/Users/me/Volna Work', true]]);
  assert.equal((await helm.client.ensureProject('/Users/me/Volna Work', 'x', signal())).id, project.id);
  assert.equal(helm.commands.length, 1);
});

test('HTTP failures become coded errors without details', async () => {
  const client = new HelmClient({ url: 'http://helm.test', token: 'x', fetchImpl: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(client.shell(signal()), (error: HelmError) => error.name === 'helm_unauthorized');
  await assert.rejects(fakeHelm().client.thread('missing', signal()), (error: HelmError) => error.name === 'helm_not_found');
});

test('pending requests follow Helm: resolved and expired requests close; text comes from the turn items', async () => {
  const helm = fakeHelm();
  const question = { requestId: 'q1', questions: [{ id: 'color', header: 'Цвет', question: 'Какой цвет?', options: [{ label: 'Синий', description: '' }], multiSelect: false }] };
  helm.threads.set('th', thread('th', 'Работа', { latestTurn: turn('running'), activities: [
    activity('a1', 'user-input.requested', question),
    activity('a2', 'approval.requested', { requestId: 'r1', requestKind: 'command', detail: 'rm -rf build' }),
    activity('a4', 'approval.requested', { requestId: 'r3', requestKind: 'file-change' }),
    activity('a5', 'provider.approval.respond.failed', { requestId: 'r3', detail: 'Stale pending approval request' }),
    activity('a6', 'tool.started')
  ] }));
  const view = await helm.client.thread('th', signal());
  const { userInputs, approvals } = pendingRequests(view);
  assert.deepEqual(userInputs.map(i => [i.requestId, i.questions[0]?.question]), [['q1', 'Какой цвет?']]);
  assert.deepEqual(approvals.map(a => [a.requestId, a.kind, a.detail]), [['r1', 'command', 'rm -rf build']]);
  assert.deepEqual(view.activities.map(a => a.summary), ['tool.started'], 'questions and approvals are not journal lines');
  assert.equal(view.requests.lastInputClosed, false);
  helm.threads.set('th', thread('th', 'Работа', { activities: [activity('a1', 'user-input.requested', question), activity('a2', 'user-input.resolved', { requestId: 'q1' })] }));
  const answered = await helm.client.thread('th', signal());
  assert.equal(answered.requests.userInputs.length, 0);
  assert.equal(answered.requests.lastInputClosed, true);
});

test('the latest assistant text prefers the turn\'s final message', () => {
  const messages = [message('m1', 'Смотрю.'), message('m2', 'Итог: 18 градусов.'), message('m3', 'пишу…', { streaming: true })];
  assert.equal(latestAssistantText(thread('t', 'x', { latestTurn: turn('completed', { assistantMessageId: 'm1' }), messages }) as any), 'Смотрю.');
  assert.equal(latestAssistantText(thread('t', 'x', { latestTurn: turn('completed'), messages }) as any), 'Итог: 18 градусов.');
  assert.equal(latestAssistantText(thread('t', 'x', { messages: [] }) as any), null);
});

test('answers match option labels or values, fall back to own words, and refuse them when the question forbids', () => {
  const questions = [
    { id: 'a', header: '', question: 'Формат?', options: [{ label: 'Таблица', description: '', value: 'table' }, { label: 'Текст', description: '' }], multiSelect: false },
    { id: 'b', header: '', question: 'Источники?', options: [{ label: 'Вики', description: '' }, { label: 'Новости', description: '' }], multiSelect: true, allowCustomAnswer: false }
  ];
  assert.deepEqual(buildAnswers(questions, ['таблица', 'Вики и новости']), { answers: { a: 'table', b: ['Вики', 'Новости'] } });
  assert.deepEqual(buildAnswers(questions, ['как удобнее', 'Новости']), { answers: { a: 'как удобнее', b: ['Новости'] } });
  assert.deepEqual(buildAnswers(questions, ['Текст', 'блоги']), { error: 'not_an_option', question: 'Источники?' });
  assert.deepEqual(buildAnswers(questions, ['Текст']), { error: 'missing_answer', question: 'Источники?' });
});
