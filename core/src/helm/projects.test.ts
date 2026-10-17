import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeHelm } from './test-support.ts';
import { folderName, pickProject } from './projects.ts';

const signal = new AbortController().signal;
const existing = [
  { id: 'p1', title: 'CallAssistant', workspaceRoot: '/Users/me/Hacking/CallAssistant', defaultModelSelection: null, scripts: [], createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z' },
  { id: 'p2', title: 'Canvas', workspaceRoot: '/Users/me/Hacking/draft-wall', defaultModelSelection: null, scripts: [], createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z' }
];

test('no project named: the default work project; a named one by title or folder', async () => {
  const newDir = await mkdtemp(join(tmpdir(), 'wave-proj-'));
  const helm = fakeHelm({ projects: existing });
  const dirs = { defaultDir: '/Users/me/Volna Work', defaultTitle: 'Волна: Работа', newDir };
  const byDefault = await pickProject(helm.client, null, false, dirs, signal);
  assert.ok('project' in byDefault && byDefault.project.workspaceRoot === '/Users/me/Volna Work');
  const byTitle = await pickProject(helm.client, 'колл ассистент', false, dirs, signal);
  assert.ok('project' in byTitle && byTitle.project.id === 'p1');
  const byFolder = await pickProject(helm.client, 'draft wall', false, dirs, signal);
  assert.ok('project' in byFolder && byFolder.project.id === 'p2');
  const bySound = await pickProject(helm.client, 'драфт вол', false, dirs, signal);
  assert.ok('project' in bySound && bySound.project.id === 'p2', 'Cyrillic speech finds a Latin folder');
});

test('an unknown project is asked about; a new one is only a new empty folder', async () => {
  const newDir = await mkdtemp(join(tmpdir(), 'wave-proj-'));
  await mkdir(join(newDir, 'Старые фото'));
  const helm = fakeHelm({ projects: existing });
  const dirs = { defaultDir: '/Users/me/Volna Work', defaultTitle: 'Волна: Работа', newDir };
  const unknown = await pickProject(helm.client, 'Сайт для мамы', false, dirs, signal);
  assert.equal('error' in unknown && unknown.error, 'unknown_project');
  const created = await pickProject(helm.client, 'Сайт для мамы', true, dirs, signal);
  assert.ok('project' in created && created.created && created.project.workspaceRoot === join(newDir, 'Сайт для мамы'));
  const taken = await pickProject(helm.client, 'Старые фото', true, dirs, signal);
  assert.equal('error' in taken && taken.error, 'folder_exists', 'an existing folder never becomes a project by voice');
  assert.equal(folderName('../../etc/passwd'), 'etc passwd');
});

test('a new project is created on the default model; an existing one keeps its own', async () => {
  const newDir = await mkdtemp(join(tmpdir(), 'wave-proj-'));
  const helm = fakeHelm({ projects: [{ ...existing[0], defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' } }] });
  const model = { instanceId: 'claudeAgent', model: 'claude-opus-5-5' };
  const dirs = { defaultDir: '/Users/me/Volna Work', defaultTitle: 'Волна: Работа', newDir, model };
  const created = await pickProject(helm.client, 'Сайт для мамы', true, dirs, signal);
  assert.ok('project' in created && created.created);
  assert.deepEqual(helm.commands.find(c => c.type === 'project.create')?.defaultModelSelection, model);
  const kept = await pickProject(helm.client, 'CallAssistant', false, dirs, signal);
  assert.ok('project' in kept && kept.project.defaultModelSelection?.model === 'claude-fable-5-1', 'the project\'s own choice stays');
  assert.equal(helm.commands.filter(c => c.type === 'project.create').length, 1, 'nothing is changed in an existing project');
});
