import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmCloudRelay, RelayError, RELAY_HELM_URL, relayFetch, relayMac, relayRpc, type RelayOp, type RelayResult } from './link.ts';
import { HelmClient } from '../helm/client.ts';
import { pickProject } from '../helm/projects.ts';
import { loadConfig } from '../config.ts';

const helmReply = (call: RelayOp): RelayResult => {
  if (call.op === 'helm.rpc') return { ok: true, data: { sequence: 7 } };
  if (call.op !== 't3.request') return { ok: false, error: 'unexpected' };
  if (call.path === '/.well-known/t3/environment') return { ok: true, data: { status: 200, body: { serverVersion: '0.0.45', orchestrationProtocolVersion: 2 } } };
  if (call.path === '/api/orchestration/shell') return { ok: true, data: { status: 200, body: { projects: [{ id: 'p1', title: 'Волна: Работа', workspaceRoot: '/Users/me/Volna Work' }], threads: [] } } };
  if (call.path === '/api/orchestration/threads/thread-1/bounded') {
    return { ok: true, data: { status: 200, body: { projection: { thread: { id: 'thread-1', title: 'Т' }, runs: [{ id: 'run-1', ordinal: 1, status: 'running' }], runtimeRequests: [], messages: [], turnItems: [] } } } };
  }
  return { ok: true, data: { status: 404, body: null } };
};

/** Поддельный helm-cloud: отвечает за «Узел» или говорит, что его нет; помнит операции и токены. */
function fakeCloud(reply: (op: RelayOp) => RelayResult | 'offline' | 'timeout', state = { connected: true }) {
  const seen: RelayOp[] = [];
  const tokens: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    tokens.push(new Headers(init?.headers).get('authorization') ?? '');
    if (url.pathname === '/internal/relay/status') return Response.json({ connected: state.connected, hello: null });
    const op = JSON.parse(String(init?.body)) as RelayOp;
    seen.push(op);
    const result = reply(op);
    if (result === 'offline' || result === 'timeout') return Response.json({ error: `relay_${result}` }, { status: 503 });
    return Response.json(result);
  }) as typeof fetch;
  return { seen, tokens, state, fetchImpl };
}

test('HelmClient through helm-cloud: checks the version, reads the shell and sends commands as Helm RPC with the payload intact', async () => {
  const cloud = fakeCloud(helmReply);
  const relay = new HelmCloudRelay({ url: 'http://helm.internal/', token: 'volna', fetchImpl: cloud.fetchImpl });
  const client = new HelmClient({ url: RELAY_HELM_URL, token: '', fetchImpl: relayFetch(relay), rpc: relayRpc(relay) });
  assert.deepEqual(await client.check(), { ok: true, version: '0.0.45' });
  assert.equal((await client.ensureProject('/Users/me/Volna Work', 'Волна: Работа', AbortSignal.timeout(2000))).id, 'p1');
  await client.interrupt('thread-1', AbortSignal.timeout(2000));
  const dispatched = cloud.seen.find(c => c.op === 'helm.rpc');
  assert.equal(dispatched?.op === 'helm.rpc' && dispatched.method, 'orchestration.dispatchCommand');
  assert.deepEqual(dispatched?.op === 'helm.rpc' && { ...(dispatched.payload as object), commandId: 'x' }, { type: 'run.interrupt', threadId: 'thread-1', runId: 'run-1', commandId: 'x' });
  assert.ok(cloud.tokens.every(t => t === 'Bearer volna'), 'Volna speaks to helm-cloud with its own token only');
  assert.equal(relay.connected, true);
});

test('a Relay that is not there reports helm_offline, like a closed Helm; a silent one is a relay_timeout', async () => {
  const relay = new HelmCloudRelay({ url: 'http://helm.internal', token: 'volna', fetchImpl: fakeCloud(() => 'offline').fetchImpl });
  const checked = await new HelmClient({ url: RELAY_HELM_URL, token: '', fetchImpl: relayFetch(relay) }).check();
  assert.equal(!checked.ok && checked.reason, 'helm_offline');
  assert.equal(relay.connected, false);
  const silent = new HelmCloudRelay({ url: 'http://helm.internal', token: 'volna', fetchImpl: fakeCloud(() => 'timeout').fetchImpl });
  await assert.rejects(silent.call({ op: 'folder.exists', path: '/x' }), (error: unknown) => error instanceof RelayError && error.name === 'relay_timeout');
  const down = new HelmCloudRelay({ url: 'http://helm.internal', token: 'volna', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(down.call({ op: 'folder.exists', path: '/x' }), (error: unknown) => error instanceof RelayError && error.name === 'relay_offline');
});

test('the status poll follows the Relay and calls onOnline once per return', async () => {
  const cloud = fakeCloud(helmReply, { connected: false });
  let online = 0;
  const relay = new HelmCloudRelay({ url: 'http://helm.internal', token: 'volna', fetchImpl: cloud.fetchImpl, onOnline: () => online++ });
  assert.equal(await relay.refresh(), false);
  cloud.state.connected = true;
  assert.equal(await relay.refresh(), true);
  assert.equal(await relay.refresh(), true);
  assert.equal(online, 1);
  cloud.state.connected = false;
  await relay.refresh();
  cloud.state.connected = true;
  await relay.refresh();
  assert.equal(online, 2);
});

test('folder and git checks run on the Mac; pickProject asks the Relay whether a new folder is taken', async () => {
  const cloud = fakeCloud(call => call.op === 'folder.exists' ? { ok: true, data: call.path.endsWith('/Taken') }
    : call.op === 'git.repository' ? { ok: true, data: call.path === '/Users/me/app' }
    : helmReply(call));
  const relay = new HelmCloudRelay({ url: 'http://helm.internal', token: 'volna', fetchImpl: cloud.fetchImpl });
  const mac = relayMac(relay);
  assert.equal(await mac.isRepository('/Users/me/app'), true, 'the git check runs on the Mac, not in the cloud');
  assert.equal(await mac.isRepository('/Users/me/Volna Work'), false);
  const client = new HelmClient({ url: RELAY_HELM_URL, token: '', fetchImpl: relayFetch(relay), rpc: relayRpc(relay) });
  const dirs = { defaultDir: '/Users/me/Volna Work', defaultTitle: 'Волна: Работа', newDir: '/Users/me/Documents' };
  const taken = await pickProject(client, 'Taken', true, dirs, AbortSignal.timeout(2000), mac.exists);
  assert.equal('error' in taken && taken.error, 'folder_exists');
  assert.ok(cloud.seen.some(c => c.op === 'folder.exists' && c.path === '/Users/me/Documents/Taken'));
});

test('config: HELM_CLOUD_URL with its token turns on Helm through helm-cloud with full Mac paths; HELM_TOKEN wins; ~ paths are refused', () => {
  const base = { OPEN_ROUTER_API_KEY: 'k' };
  const cloud = { HELM_CLOUD_URL: 'http://helm.railway.internal:8788', HELM_INTERNAL_TOKEN: 'i' };
  const viaCloud = loadConfig({ ...base, ...cloud, HELM_PROJECT_DIR: '/Users/me/Volna Work', HELM_NEW_PROJECTS_DIR: '/Users/me/Documents' });
  assert.equal(viaCloud.helm?.via, 'relay');
  assert.equal(viaCloud.helm?.url, RELAY_HELM_URL);
  assert.equal(viaCloud.helm?.token, '');
  assert.deepEqual(viaCloud.helmCloud, { url: 'http://helm.railway.internal:8788', token: 'i' });
  assert.throws(() => loadConfig({ ...base, ...cloud }), /HELM_PROJECT_DIR/);
  assert.equal(loadConfig({ ...base, HELM_CLOUD_URL: cloud.HELM_CLOUD_URL }).helm, null, 'no token, no Helm');
  const direct = loadConfig({ ...base, ...cloud, HELM_TOKEN: 't' });
  assert.equal(direct.helm?.via, 'direct');
  assert.equal(direct.helmCloud, null);
  assert.equal(loadConfig(base).helm, null);
});
