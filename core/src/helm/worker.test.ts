import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { TaskStore, type Task } from '../tasks/store.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { workTools } from '../tasks/tools.ts';
import { helmWorker } from './worker.ts';
import { helmTools } from './tools.ts';
import { HelmClient, HelmError } from './client.ts';
import { activity, fakeHelm, message, turn } from './test-support.ts';

const DIRS = { defaultDir: '/Users/me/Volna Work', defaultTitle: 'Волна: Работа', newDir: '/nonexistent-volna-test' };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Ждёт условия, а не фиксированное время: под нагрузкой полного прогона 80 мс не хватало. */
async function until(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!ready() && Date.now() - started < timeoutMs) await wait(10);
}
const context = { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => new Date('2026-09-25T10:00:00Z') };
const question = { requestId: 'q1', questions: [{ id: 'format', header: 'Формат', question: 'Таблицей или текстом?', options: [{ label: 'Таблица', description: '', value: 'table' }, { label: 'Текст', description: '' }], multiSelect: false }] };

async function setup(helm: ReturnType<typeof fakeHelm>, { steerGraceMs = 60 } = {}) {
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'helm-')));
  await store.load();
  const finished: Task[] = [];
  const notes: string[] = [];
  const announced: string[] = [];
  const runner = new TaskRunner({
    store, log: silentLogger, onFinished: task => { finished.push(task); },
    progress: { note: (_id, line) => notes.push(line), forget: () => {} },
    worker: helmWorker({ client: helm.client, store, projectDir: '/Users/me/Volna Work', instance: 'claudeAgent', model: null, runtimeMode: 'auto', announce: note => announced.push(note), pollMs: 5, steerGraceMs })
  });
  const tools = new ToolRegistry([...workTools(runner, store, {}), ...helmTools({ client: helm.client, store, runtimeMode: 'auto' })]);
  return { store, runner, finished, notes, announced, tools };
}

test('a work task becomes a Helm thread; the agent\'s last message is the result', async () => {
  const helm = fakeHelm();
  helm.script = (thread, n) => {
    if (n === 1) Object.assign(thread, { latestTurn: turn('running'), activities: [activity('a1', 'tool.started', {}, { tone: 'tool', summary: 'Поиск в сети' })] });
    if (n >= 2) Object.assign(thread, { latestTurn: turn('completed', { assistantMessageId: 'm2' }), messages: [message('m1', 'Ищу.'), message('m2', 'Node.js 26.1, вышла вчера.')] });
  };
  const { runner, finished, notes, store } = await setup(helm);
  const task = await runner.start({ title: 'Версия Node', prompt: 'Узнай последнюю версию Node.js' });
  await until(() => finished.length > 0);
  assert.equal(finished[0]?.status, 'done');
  assert.equal(finished[0]?.result, 'Node.js 26.1, вышла вчера.');
  assert.deepEqual(helm.commands.map(c => c.type), ['project.create', 'thread.launch']);
  const [project, launch] = helm.commands;
  assert.equal(project.workspaceRoot, '/Users/me/Volna Work');
  assert.deepEqual(project.defaultModelSelection, { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, 'a new project opens on Opus 5.5 in the Helm window too');
  assert.deepEqual(launch.modelSelection, { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
  assert.equal(launch.runtimeMode, 'auto');
  assert.deepEqual(launch.workspaceStrategy, { type: 'root' });
  assert.equal(launch.initialMessage.text, 'Узнай последнюю версию Node.js', 'the task goes to the agent as is, without a preamble');
  assert.equal(store.get(task.id)?.helmThread, launch.threadId);
  assert.deepEqual(notes, ['задание ушло агенту', 'Поиск в сети', 'Ищу.', 'Node.js 26.1, вышла вчера.']);
});

test('a failed or interrupted turn fails the task with a code', async () => {
  const helm = fakeHelm();
  helm.script = thread => Object.assign(thread, { latestTurn: turn('error') });
  const { runner, finished } = await setup(helm);
  await runner.start({ title: 'Сбой', prompt: 'Сделай что-нибудь' });
  await until(() => finished.length > 0);
  assert.equal(finished[0]?.status, 'failed');
  assert.equal(finished[0]?.error, 'helm_turn_error');
});

test('cancelling the task interrupts the running turn', async () => {
  const helm = fakeHelm();
  helm.script = thread => Object.assign(thread, { latestTurn: turn('running') });
  const { runner, store } = await setup(helm);
  const task = await runner.start({ title: 'Долго', prompt: 'Долгая работа' });
  await wait(40);
  assert.equal(await runner.cancel(task.id), true);
  await wait(20);
  const interrupt = helm.commands.find(c => c.type === 'run.interrupt');
  assert.deepEqual([interrupt?.threadId, interrupt?.runId], [store.get(task.id)?.helmThread, 't1']);
  assert.equal(store.get(task.id)?.status, 'cancelled');
});

test('Helm gone for several polls fails the task', async () => {
  const helm = fakeHelm();
  helm.script = (_thread, n) => { if (n === 1) helm.setOffline(true); };
  const { runner, finished } = await setup(helm);
  await runner.start({ title: 'Пропал', prompt: 'Работа без «Штурвала»' });
  await wait(100);
  assert.equal(finished[0]?.error, 'helm_lost');
});

test('the agent\'s question is announced once, shown in tasks_list and answered by voice with work_answer', async () => {
  const helm = fakeHelm();
  let answered = false;
  helm.script = thread => {
    if (!answered) return Object.assign(thread, { latestTurn: turn('running'), activities: [activity('a1', 'user-input.requested', question)] });
    Object.assign(thread, {
      latestTurn: turn('completed'), messages: [message('m1', 'Сделал таблицу.')],
      activities: [activity('a1', 'user-input.requested', question), activity('a2', 'user-input.resolved', { requestId: 'q1', answers: { format: 'table' } })]
    });
  };
  const { runner, finished, announced, tools, store } = await setup(helm);
  const task = await runner.start({ title: 'Сравнение', prompt: 'Сравни тарифы' });
  await wait(50);
  assert.equal(announced.length, 1, 'one note per question');
  assert.match(announced[0]!, /«Сравнение» спрашивает: Таблицей или текстом\? Варианты: Таблица; Текст\./);
  assert.match(announced[0]!, new RegExp(`work_answer \\(id задания ${task.id}\\)`));
  assert.deepEqual(store.get(task.id)?.waiting, { kind: 'question', text: 'Таблицей или текстом? Варианты: Таблица; Текст.' });
  const listed = JSON.parse(await tools.call('tasks_list', '{}', context));
  assert.equal(listed.tasks[0].waiting.kind, 'question');

  const accepted = JSON.parse(await tools.call('work_answer', JSON.stringify({ answer: 'Таблица' }), context));
  assert.equal(accepted.answered, true);
  assert.equal(accepted.task, task.id);
  const respond = helm.commands.find(c => c.type === 'runtime-request.respond');
  assert.deepEqual([respond.threadId, respond.requestId, respond.answers], [store.get(task.id)?.helmThread, 'q1', { format: 'table' }]);
  answered = true;
  await wait(50);
  assert.equal(finished[0]?.result, 'Сделал таблицу.');
  assert.equal(store.get(task.id)?.waiting ?? null, null);
});

test('an approval is announced as waiting in Helm; no tool grants it', async () => {
  const helm = fakeHelm();
  helm.script = thread => Object.assign(thread, { latestTurn: turn('running'), activities: [activity('a1', 'approval.requested', { requestId: 'r1', requestKind: 'command', detail: 'npm install' })] });
  const { runner, announced, tools, store } = await setup(helm);
  const task = await runner.start({ title: 'Установка', prompt: 'Поставь пакет' });
  await wait(40);
  assert.equal(announced.length, 1);
  assert.match(announced[0]!, /ждёт разрешения: выполнить команду\. Голосом его дать нельзя, только на компьютере или в приложении «Штурвал» на телефоне/);
  assert.doesNotMatch(announced[0]!, /npm install/, 'the command itself is not read out');
  assert.deepEqual(store.get(task.id)?.waiting, { kind: 'approval', text: 'выполнить команду' });
  assert.ok(tools.names().every(name => !/approv|permit|allow/.test(name)));
  const out = JSON.parse(await tools.call('work_answer', JSON.stringify({ id: task.id, answer: 'да' }), context));
  assert.equal(out.error, 'no_question');
  assert.ok(!helm.commands.some(c => c.type === 'runtime-request.respond' || 'decision' in c));
  await runner.cancel(task.id);
});

// 26.09.2026 владелец: работа в проекте может идти в отдельной ветке. С 05.10.2026 worktree создаёт сам «Штурвал».
test('work with worktree asks Helm for a wave/ branch from HEAD; a folder without git is refused before starting', async () => {
  const helm = fakeHelm({ projects: [{ id: 'p1', title: 'CallAssistant', workspaceRoot: '/Users/me/CallAssistant', defaultModelSelection: null, scripts: [] }] });
  helm.script = thread => Object.assign(thread, { latestTurn: turn('completed', { assistantMessageId: 'm1' }), messages: [message('m1', 'Готово.')] });
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'helm-')));
  await store.load();
  const finished: Task[] = [];
  const runner = new TaskRunner({
    store, log: silentLogger, onFinished: task => { finished.push(task); },
    worker: helmWorker({ client: helm.client, store, projectDir: '/Users/me/Volna Work', instance: 'claudeAgent', model: null, runtimeMode: 'auto', pollMs: 5 })
  });
  const repos = new Set(['/Users/me/CallAssistant']);
  const tools = new ToolRegistry(workTools(runner, store, {
    pickProject: async () => ({ project: helm.shell.projects[0]!, created: false }), isRepository: async dir => repos.has(dir)
  }));
  const out = JSON.parse(await tools.call('work_start', JSON.stringify({ title: 'Тесты', task: 'Почини тесты', project: 'callassistant', worktree: true }), context));
  assert.equal(out.started, true);
  await until(() => finished.length > 0);
  assert.equal(finished[0]?.status, 'done');
  const branch = `wave/${out.id}`;
  const launch = helm.commands.find(c => c.type === 'thread.launch');
  assert.deepEqual([launch.projectId, launch.workspaceStrategy], ['p1', { type: 'worktree', baseRef: 'HEAD', branch }]);

  repos.clear();
  const refused = JSON.parse(await tools.call('work_start', JSON.stringify({ title: 'Ещё', task: 'Почини сборку', project: 'callassistant', worktree: true }), context));
  assert.equal(refused.error, 'not_a_repository');
  assert.equal(store.tasks.length, 1, 'nothing is queued without a repository');
});

test('work_start without the Mac or without Helm says what to check and queues nothing', async () => {
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'helm-')));
  await store.load();
  const runner = new TaskRunner({ store, log: silentLogger, onFinished: () => {}, worker: async () => ({ status: 'done', result: '' }) as any });
  let online = false;
  const tools = new ToolRegistry(workTools(runner, store, {
    macOnline: () => online, pickProject: async () => { throw new HelmError('helm_offline'); }
  }));
  const start = JSON.stringify({ title: 'Отчёт', task: 'Собери отчёт' });
  const noMac = JSON.parse(await tools.call('work_start', start, context));
  assert.equal(noMac.error, 'mac_offline');
  assert.match(noMac.say, /нет связи с твоим компьютером.*включён/);
  online = true;
  const noHelm = JSON.parse(await tools.call('work_start', start, context));
  assert.equal(noHelm.error, 'helm_offline');
  assert.match(noHelm.say, /программа для работы на нём закрыта/);
  online = false;
  const branchTools = new ToolRegistry(workTools(runner, store, {
    macOnline: () => online, pickProject: async () => ({ project: { id: 'p1', title: 'App', workspaceRoot: '/Users/me/app' } as any, created: false }),
    isRepository: async () => { throw new Error('relay: relay_offline'); }
  }));
  const lost = JSON.parse(await branchTools.call('work_start', JSON.stringify({ title: 'Ветка', task: 'Почини', project: 'app', worktree: true }), context));
  assert.equal(lost.error, 'mac_offline', 'a lost Mac during the git check is the same plain phrase, not tool_failed');
  online = true;
  for (const said of [noMac.say, noHelm.say]) assert.doesNotMatch(said, /T3|Mac|Узел/, 'only the computer, no program names');
  assert.equal(store.tasks.length, 0);
});

test('computer_status: ready, closed program, no connection — in plain words about the computer', async () => {
  const helm = fakeHelm();
  let online = true;
  const closed = new HelmClient({ url: 'http://helm.test', token: 't', fetchImpl: (async () => { throw new TypeError('offline'); }) as typeof fetch });
  const ask = async (client: HelmClient) => JSON.parse(await new ToolRegistry(helmTools({ client, runtimeMode: 'auto', macOnline: () => online })).call('computer_status', '{}', context));
  assert.deepEqual(await ask(helm.client), { connected: true, ready: true, say: 'Компьютер на связи, работу взять могу.' });
  const noProgram = await ask(closed);
  assert.deepEqual([noProgram.connected, noProgram.ready], [true, false]);
  assert.match(noProgram.say, /программа для работы на нём закрыта/);
  online = false;
  const noMac = await ask(helm.client);
  assert.deepEqual([noMac.connected, noMac.ready], [false, false]);
  assert.match(noMac.say, /Нет связи с твоим компьютером/);
  for (const said of [noProgram.say, noMac.say]) assert.doesNotMatch(said, /T3|Mac|Узел/);
});

/** Работа с добавкой: тред в снимке shell (по нему work_add проверяет, ждёт ли агент), ход и итоги ведёт тест. */
async function steeredWork(codex: boolean) {
  const helm = fakeHelm();
  // null — добавки ещё не было; 0 — добавка до первого опроса (на медленной машине так бывает).
  let steeredAtPoll: number | null = null;
  let lastPoll = 0;
  helm.script = (thread, n) => {
    lastPoll = n;
    if (steeredAtPoll === null) return Object.assign(thread, { latestTurn: turn('running') });
    const after = n - steeredAtPoll;
    if (!codex) return Object.assign(thread, { latestTurn: turn('completed', { assistantMessageId: 'm1' }), messages: [message('m1', 'Пять файлов, среди них два PDF.')] });
    // Codex: ход с добавкой начинается не сразу, первый ход успевает закончиться без неё.
    if (after <= 2) return Object.assign(thread, { latestTurn: turn('completed', { assistantMessageId: 'm1' }), messages: [message('m1', 'Пять файлов.')] });
    if (after <= 4) return Object.assign(thread, { latestTurn: turn('running', { turnId: 't2' }) });
    Object.assign(thread, { latestTurn: turn('completed', { turnId: 't2', assistantMessageId: 'm2' }), messages: [message('m1', 'Пять файлов.'), message('m2', 'Пять файлов, среди них два PDF.')] });
  };
  const env = await setup(helm, { steerGraceMs: 150 });
  const task = await env.runner.start({ title: 'Загрузки', prompt: 'Проверь пять последних файлов в Загрузках' });
  await until(() => Boolean(env.store.get(task.id)?.helmThread));
  const threadId = env.store.get(task.id)!.helmThread!;
  helm.shell.threads.push({ id: threadId, projectId: 'p1', title: 'Загрузки', latestTurn: turn('running'), session: null, updatedAt: '2026-09-25T10:00:00Z', archivedAt: null, hasPendingApprovals: false, hasPendingUserInput: false });
  // Добавка в идущий ход: ждём первого опроса, иначе на медленной машине (CI) номер хода ещё не известен.
  await until(() => lastPoll > 0);
  const added = JSON.parse(await env.tools.call('work_add', JSON.stringify({ text: 'Отдельно отметь PDF' }), context));
  return { helm, task, threadId, added, env, markSteered() { steeredAtPoll = lastPoll; } };
}

test('work_add steers the running work: the message goes into the thread at once, without stopping it', async () => {
  const { helm, task, threadId, added, env } = await steeredWork(false);
  try {
    assert.deepEqual([added.added, added.task], [true, task.id]);
    const sent = helm.commands.filter(c => c.type === 'message.dispatch');
    assert.deepEqual(sent.map(c => [c.threadId, c.text, c.deliveryIntent]), [[threadId, 'Отдельно отметь PDF', 'steer']]);
    assert.equal(helm.commands.some(c => c.type === 'run.interrupt'), false, 'the turn is not interrupted');
    assert.deepEqual(env.store.get(task.id)?.steer, { at: '2026-09-25T10:00:00.000Z', turnId: 't1' });
  } finally {
    await env.runner.cancel(task.id);
  }
});

test('after a steer the worker waits for a follow-up turn (Codex) instead of taking the first result', async () => {
  for (const codex of [true, false]) {
    const work = await steeredWork(codex);
    try {
      work.markSteered();
      const started = Date.now();
      await until(() => work.env.finished.length > 0);
      assert.equal(work.env.finished[0]?.result, 'Пять файлов, среди них два PDF.', codex ? 'the follow-up turn gives the result' : 'the same turn took the steer');
      if (!codex) assert.ok(Date.now() - started >= 140, 'the grace passes before the result of the steered turn');
    } finally {
      // Упавшая проверка не должна оставлять опрос «Штурвала» работать: иначе процесс тестов не завершается.
      if (!work.env.finished.length) await work.env.runner.cancel(work.task.id);
    }
  }
});

test('work_add refuses while the agent waits for an answer, and when nothing runs', async () => {
  const helm = fakeHelm();
  helm.script = thread => Object.assign(thread, { latestTurn: turn('running') });
  const { runner, store, tools } = await setup(helm);
  const none = JSON.parse(await tools.call('work_add', JSON.stringify({ text: 'x' }), context));
  assert.equal(none.error, 'not_running');
  const task = await runner.start({ title: 'Вопрос', prompt: 'Спроси меня' });
  await until(() => Boolean(store.get(task.id)?.helmThread));
  helm.shell.threads.push({ id: store.get(task.id)!.helmThread!, projectId: 'p1', title: 'Вопрос', latestTurn: turn('running'), session: null, updatedAt: '2026-09-25T10:00:00Z', archivedAt: null, hasPendingApprovals: false, hasPendingUserInput: true });
  const asks = JSON.parse(await tools.call('work_add', JSON.stringify({ text: 'Ещё вот что' }), context));
  assert.equal(asks.error, 'agent_asks');
  assert.equal(helm.commands.filter(c => c.type === 'message.dispatch').length, 0);
  await runner.cancel(task.id);
});
