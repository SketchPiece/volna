import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRpc, checkT3, fullPath, handle, type Deps, type Git } from './ops.ts';
import { HelmRpcError } from '../../core/src/helm/rpc.ts';

function deps(overrides: Partial<Deps> = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const calls: { method: string; payload: unknown }[] = [];
  const gitCalls: string[][] = [];
  const fakeGit: Git = async (cwd, args) => { gitCalls.push([cwd, ...args]); return args[0] === 'rev-parse' ? (cwd.includes('not-git') ? 'false' : 'true') : ''; };
  const d: Deps = {
    t3Url: async () => 'http://127.0.0.1:3783', t3Token: 'secret', exists: async path => path.endsWith('/Taken'),
    fetch: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify({ serverVersion: '0.0.45' }), { status: 200 }); }) as typeof fetch,
    rpc: async (method, payload) => { calls.push({ method, payload }); return { sequence: 7 }; },
    git: fakeGit, ...overrides
  };
  return { d, seen, calls, gitCalls };
}

const launch = (patch: object = {}) => ({ commandId: 'c', projectId: 'p', title: 'T', modelSelection: { instanceId: 'claudeAgent', model: 'm' }, runtimeMode: 'auto', interactionMode: 'default', workspaceStrategy: { type: 'root' }, ...patch });

test('HTTP allow-list: three reads and project.create with a full path; the old dispatch and everything else are refused', () => {
  assert.equal(checkT3('GET', '/.well-known/t3/environment', undefined), null);
  assert.equal(checkT3('GET', '/api/orchestration/shell', undefined), null);
  assert.equal(checkT3('GET', '/api/orchestration/threads/abc-123/bounded', undefined), null);
  assert.equal(checkT3('GET', '/api/orchestration/threads/abc-123', undefined), 'not_allowed', 'only the bounded window');
  assert.equal(checkT3('GET', '/api/orchestration/threads/../../secrets/bounded', undefined), 'not_allowed');
  // Треды из MCP, импорта и делегирования: «:» и «%» в id, закодированные клиентом ядра.
  assert.equal(checkT3('GET', `/api/orchestration/threads/${encodeURIComponent('mcp:eef0e5d2-939c-43f8-bc24-3d029293336a')}/bounded`, undefined), null);
  assert.equal(checkT3('GET', `/api/orchestration/threads/${encodeURIComponent('thread:delegated-task:command%3Amcp%3Adfbc4a81')}/bounded`, undefined), null);
  assert.equal(checkT3('GET', '/api/orchestration/threads/a%2F..%2Fsecrets/bounded', undefined), 'not_allowed');
  assert.equal(checkT3('GET', '/api/orchestration/threads/a%2e%2e/bounded', undefined), 'not_allowed');
  assert.equal(checkT3('GET', '/api/auth/sessions', undefined), 'not_allowed');
  assert.equal(checkT3('POST', '/api/projects/mutate', { type: 'project.create', workspaceRoot: '/Users/me/Documents/New' }), null);
  assert.equal(checkT3('POST', '/api/projects/mutate', { type: 'project.create', workspaceRoot: '~/New' }), 'bad_path');
  assert.equal(checkT3('POST', '/api/projects/mutate', { type: 'project.delete', projectId: 'p' }), 'not_allowed');
  assert.equal(checkT3('POST', '/api/orchestration/dispatch', { type: 'thread.turn.start' }), 'not_allowed');
  assert.equal(checkT3('DELETE', '/api/orchestration/shell', undefined), 'not_allowed');
});

test('RPC allow-list: launch in the project folder or a wave/ worktree from HEAD, listed commands, never a permission decision', () => {
  assert.equal(checkRpc('orchestration.launchThread', launch()), null);
  assert.equal(checkRpc('orchestration.launchThread', launch({ workspaceStrategy: { type: 'worktree', baseRef: 'HEAD', branch: 'wave/0123456789abcdef' } })), null);
  assert.equal(checkRpc('orchestration.launchThread', launch({ workspaceStrategy: { type: 'worktree', baseRef: 'HEAD', branch: 'main' } })), 'not_allowed');
  assert.equal(checkRpc('orchestration.launchThread', launch({ workspaceStrategy: { type: 'existing_worktree', worktreePath: '/Users/me/x' } })), 'not_allowed');
  assert.equal(checkRpc('orchestration.launchThread', launch({ runtimeMode: 'full-access' })), 'not_allowed', 'the core never enables full access');
  assert.equal(checkRpc('orchestration.launchThread', launch({ reuseExistingThread: true })), 'not_allowed');
  for (const type of ['message.dispatch', 'run.interrupt']) assert.equal(checkRpc('orchestration.dispatchCommand', { type }), null, type);
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'runtime-request.respond', answers: { q: 'Да' } }), null);
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'runtime-request.respond', decision: 'accept' }), 'not_allowed', 'permissions are never granted through the core');
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'runtime-request.respond', answers: { q: 'Да' }, decision: 'accept' }), 'not_allowed');
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.settle', threadId: 't' }), null);
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.unsettle', threadId: 't', reason: 'user' }), null);
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.snooze', threadId: 't', snoozedUntil: '2026-10-16T16:00:00.000Z' }), null);
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.snooze', threadId: 't' }), 'not_allowed');
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.unsnooze', threadId: 't', reason: 'user' }), null);
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.unsnooze', threadId: 't' }), 'not_allowed');
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.archive' }), 'not_allowed');
  assert.equal(checkRpc('orchestration.dispatchCommand', { type: 'thread.create' }), 'not_allowed');
  assert.equal(checkRpc('orchestration.subscribeShell', {}), 'not_allowed');
  assert.equal(checkRpc('orchestration.dispatchCommand', null), 'not_allowed');
});

test('RPC calls go to the Helm socket and answer with its value; refused ones never reach it; errors come back as codes', async () => {
  const { d, calls } = deps();
  assert.deepEqual(await handle({ id: '1', op: 'helm.rpc', method: 'orchestration.dispatchCommand', payload: { type: 'run.interrupt', threadId: 't', runId: 'r' } }, d), { ok: true, data: { sequence: 7 } });
  assert.deepEqual(await handle({ id: '2', op: 'helm.rpc', method: 'orchestration.dispatchCommand', payload: { type: 'runtime-request.respond', decision: 'accept' } }, d), { ok: false, error: 'not_allowed' });
  assert.equal(calls.length, 1);
  const failing = (error: Error) => deps({ rpc: async () => { throw error; } }).d;
  const call = { id: '3', op: 'helm.rpc', method: 'orchestration.dispatchCommand', payload: { type: 'run.interrupt' } };
  assert.deepEqual(await handle(call, failing(new HelmRpcError('fail', 'OrchestrationCommandRejected'))), { ok: false, error: 'helm_fail:OrchestrationCommandRejected' });
  assert.deepEqual(await handle(call, failing(new HelmRpcError('offline'))), { ok: false, error: 'helm_offline' });
  assert.deepEqual(await handle(call, failing(new HelmRpcError('die'))), { ok: false, error: 'helm_die' });
});

test('paths must be full and clean', () => {
  assert.equal(fullPath('/Users/me/Volna Work'), '/Users/me/Volna Work');
  assert.equal(fullPath('/Users/me/../root'), null);
  assert.equal(fullPath('relative/path'), null);
  assert.equal(fullPath(42), null);
});

test('a Helm request gets the token and the protocol header here and returns status and body; the token never comes from the core', async () => {
  const { d, seen } = deps();
  const result = await handle({ id: '1', op: 't3.request', method: 'GET', path: '/.well-known/t3/environment' }, d);
  assert.deepEqual(result, { ok: true, data: { status: 200, body: { serverVersion: '0.0.45' } } });
  assert.equal(seen[0]!.url, 'http://127.0.0.1:3783/.well-known/t3/environment');
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.equal(headers['x-t3-orchestration-protocol'], '2');
  assert.deepEqual(await handle({ id: '2', op: 't3.request', method: 'GET', path: '/api/auth/sessions' }, d), { ok: false, error: 'not_allowed' });
  assert.equal(seen.length, 1, 'refused requests never reach Helm');
});

test('a closed Helm gives t3_offline', async () => {
  const { d } = deps({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  assert.deepEqual(await handle({ id: '1', op: 't3.request', method: 'GET', path: '/api/orchestration/shell' }, d), { ok: false, error: 't3_offline' });
});

test('folder checks and git repositories: full paths only; worktrees are Helm\'s job now', async () => {
  const { d } = deps();
  assert.deepEqual(await handle({ id: '1', op: 'folder.exists', path: '/Users/me/Documents/Taken' }, d), { ok: true, data: true });
  assert.deepEqual(await handle({ id: '2', op: 'folder.exists', path: '../etc' }, d), { ok: false, error: 'bad_path' });
  assert.deepEqual(await handle({ id: '3', op: 'worktree.create', root: '/Users/me/app', branch: 'wave/0123456789abcdef' }, d), { ok: false, error: 'unknown_op' });
  assert.deepEqual(await handle({ id: '6', op: 'shell.exec' }, d), { ok: false, error: 'unknown_op' });
  assert.deepEqual(await handle({ id: '7', op: 'git.repository', path: '/Users/me/app' }, d), { ok: true, data: true });
  assert.deepEqual(await handle({ id: '8', op: 'git.repository', path: '/Users/me/not-git' }, d), { ok: true, data: false });
  assert.deepEqual(await handle({ id: '9', op: 'git.repository', path: 'app' }, d), { ok: false, error: 'bad_path' });
});
