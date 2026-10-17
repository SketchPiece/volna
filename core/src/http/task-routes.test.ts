import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, json } from '../test-support.ts';
import { TaskStore, type Task } from '../tasks/store.ts';
import { phoneTasks } from './task-routes.ts';

const base: Task = {
  id: 't', title: 'Задание', prompt: 'Секретный текст задания', kind: 'computer', callback: 'notify', status: 'done', delivery: 'heard',
  createdAt: '2026-09-26T08:00:00.000Z', startedAt: '2026-09-26T08:00:01.000Z', finishedAt: '2026-09-26T08:10:00.000Z',
  result: 'Длинный итог', summary: null, error: null, progress: null, progressAt: null, waiting: null
};
const at = (patch: Partial<Task>): Task => ({ ...base, ...patch });

test('the phone sees running, waiting and recently finished work, newest first, without prompts or results', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const list = phoneTasks([
    at({ id: 'old', createdAt: '2026-09-24T08:00:00.000Z', finishedAt: '2026-09-24T09:00:00.000Z' }),
    at({ id: 'done', createdAt: '2026-09-26T08:00:00.000Z' }),
    at({ id: 'run', status: 'running', finishedAt: null, createdAt: '2026-09-26T11:00:00.000Z', progress: 'Сравниваю тарифы' }),
    at({ id: 'ask', status: 'running', finishedAt: null, createdAt: '2026-09-26T10:00:00.000Z', waiting: { kind: 'question', text: 'Какой бюджет?' } })
  ], now);
  assert.deepEqual(list.map(t => t.id), ['run', 'ask', 'done']);
  assert.equal(list[1].waiting?.text, 'Какой бюджет?');
  assert.equal(list[0].progress, 'Сравниваю тарифы');
  for (const task of list) {
    assert.equal('prompt' in task, false);
    assert.equal('result' in task, false);
  }
});

test('GET /tasks needs the core token and exists only with a task store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-route-'));
  try {
    const tasks = new TaskStore(dir);
    await tasks.create({ title: 'Ищу билеты', prompt: 'p' });
    await run({ apiKey: 'secret', token: 't', tasks }, async url => {
      assert.equal((await fetch(`${url}/tasks`)).status, 401);
      const body = await json(await fetch(`${url}/tasks`, { headers: { Authorization: 'Bearer t' } }));
      assert.deepEqual(body.tasks.map((t: { title: string }) => t.title), ['Ищу билеты']);
    });
    await run({ apiKey: 'secret' }, async url => {
      assert.equal((await fetch(`${url}/tasks`)).status, 404);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
