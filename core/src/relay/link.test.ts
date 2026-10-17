import test from 'node:test';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { RelayLink, RelayError, RELAY_HELM_URL, relayFetch, relayMac, relayRpc, type RelayCall, type RelayResult } from './link.ts';
import { HelmClient } from '../helm/client.ts';
import { pickProject } from '../helm/projects.ts';
import { loadConfig } from '../config.ts';
import { run } from '../test-support.ts';

/** Поддельный «Узел»: опрашивает очередь и отвечает, пока тест не остановит. */
function fakeRelay(link: RelayLink, reply: (call: RelayCall) => RelayResult) {
  const seen: RelayCall[] = [];
  const stop = new AbortController();
  void (async () => {
    while (!stop.signal.aborted) {
      for (const call of await link.next(50, stop.signal)) { seen.push(call); link.answer(call.id, reply(call)); }
    }
  })();
  return { seen, stop: () => stop.abort() };
}

const helmReply = (call: RelayCall): RelayResult => {
  if (call.op === 'helm.rpc') return { ok: true, data: { sequence: 7 } };
  if (call.op !== 't3.request') return { ok: false, error: 'unexpected' };
  if (call.path === '/.well-known/t3/environment') return { ok: true, data: { status: 200, body: { serverVersion: '0.0.45', orchestrationProtocolVersion: 2 } } };
  if (call.path === '/api/orchestration/shell') return { ok: true, data: { status: 200, body: { projects: [{ id: 'p1', title: 'Волна: Работа', workspaceRoot: '/Users/me/Volna Work' }], threads: [] } } };
  if (call.path === '/api/orchestration/threads/thread-1/bounded') {
    return { ok: true, data: { status: 200, body: { projection: { thread: { id: 'thread-1', title: 'Т' }, runs: [{ id: 'run-1', ordinal: 1, status: 'running' }], runtimeRequests: [], messages: [], turnItems: [] } } } };
  }
  return { ok: true, data: { status: 404, body: null } };
};

test('without a recent poll and no grace a call fails at once with relay_offline; after a poll it goes through the queue once', async () => {
  const link = new RelayLink({ graceMs: 0 });
  await assert.rejects(link.call({ op: 'folder.exists', path: '/tmp' }), (error: Error) => error instanceof RelayError && error.name === 'relay_offline');
  await link.next(0);
  assert.equal(link.connected, true);
  const pending = link.call({ op: 'folder.exists', path: '/tmp' });
  const [call] = await link.next(0);
  assert.equal(call!.op, 'folder.exists');
  assert.deepEqual(await link.next(0), [], 'handed out once');
  assert.equal(link.answer(call!.id, { ok: true, data: true }), true);
  assert.deepEqual(await pending, { ok: true, data: true });
  assert.equal(link.answer(call!.id, { ok: true, data: false }), false, 'closed calls are not answered twice');
});

test('a taken but silent call gives relay_timeout; cancelling rejects with the reason; the link forgets both', async () => {
  const link = new RelayLink();
  await link.next(0);
  const silent = link.call({ op: 'folder.exists', path: '/a' }, undefined, 20);
  await link.next(0);
  await assert.rejects(silent, (error: Error) => error.name === 'relay_timeout');
  const abort = new AbortController();
  const cancelled = link.call({ op: 'folder.exists', path: '/b' }, abort.signal);
  abort.abort(new Error('stop'));
  await assert.rejects(cancelled, /stop/);
  assert.equal(link.size, 0);
});

test('a call made while the Relay is reconnecting waits for it and goes through; a cancel stops the wait', async () => {
  const link = new RelayLink({ graceMs: 2000 });
  const pending = link.call({ op: 'folder.exists', path: '/w' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await link.greet({ version: '1', t3: { ok: true, version: '0.0.42', reason: null } });
  const calls = await link.next(1000);
  assert.equal(calls.length, 1);
  link.answer(calls[0]!.id, { ok: true, data: true });
  assert.deepEqual(await pending, { ok: true, data: true });
  const offline = new RelayLink({ graceMs: 2000 });
  const abort = new AbortController();
  const waiting = offline.call({ op: 'folder.exists', path: '/w' }, abort.signal);
  abort.abort(new Error('stop'));
  await assert.rejects(waiting, /stop/);
  assert.equal(offline.size, 0);
});

test('the link goes offline when the Relay stops polling', async () => {
  let now = 1_000_000;
  const link = new RelayLink({ now: () => now, graceMs: 20 });
  await link.next(0);
  assert.equal(link.connected, true);
  now += 60_000;
  assert.equal(link.connected, false);
  await assert.rejects(link.call({ op: 'folder.exists', path: '/x' }), /relay_offline/);
});

test('HelmClient through the Relay: checks the version, reads the shell and sends commands as Helm RPC with the payload intact', async () => {
  const link = new RelayLink();
  await link.next(0);
  const relay = fakeRelay(link, helmReply);
  try {
    const client = new HelmClient({ url: RELAY_HELM_URL, token: '', fetchImpl: relayFetch(link), rpc: relayRpc(link) });
    assert.deepEqual(await client.check(), { ok: true, version: '0.0.45' });
    const project = await client.ensureProject('/Users/me/Volna Work', 'Волна: Работа', AbortSignal.timeout(2000));
    assert.equal(project.id, 'p1');
    await client.interrupt('thread-1', AbortSignal.timeout(2000));
    const dispatched = relay.seen.find(c => c.op === 'helm.rpc');
    assert.equal(dispatched?.op === 'helm.rpc' && dispatched.method, 'orchestration.dispatchCommand');
    assert.deepEqual(dispatched?.op === 'helm.rpc' && { ...(dispatched.payload as object), commandId: 'x' }, { type: 'run.interrupt', threadId: 'thread-1', runId: 'run-1', commandId: 'x' });
    assert.ok(relay.seen.every(c => !JSON.stringify(c).includes('Bearer')), 'no Helm token travels from the core');
  } finally { relay.stop(); }
});

test('HelmClient through a silent Relay reports helm_offline, like a closed Helm', async () => {
  const client = new HelmClient({ url: RELAY_HELM_URL, token: '', fetchImpl: relayFetch(new RelayLink({ graceMs: 20 })) });
  const checked = await client.check();
  assert.equal(checked.ok, false);
  assert.equal(!checked.ok && checked.reason, 'helm_offline');
});

test('folder and git checks run on the Mac; pickProject asks the Relay whether a new folder is taken', async () => {
  const link = new RelayLink();
  await link.next(0);
  const relay = fakeRelay(link, call => call.op === 'folder.exists' ? { ok: true, data: call.path.endsWith('/Taken') }
    : call.op === 'git.repository' ? { ok: true, data: call.path === '/Users/me/app' }
    : helmReply(call));
  try {
    const mac = relayMac(link);
    assert.equal(await mac.isRepository('/Users/me/app'), true, 'the git check runs on the Mac, not in the cloud');
    assert.equal(await mac.isRepository('/Users/me/Volna Work'), false);
    const client = new HelmClient({ url: RELAY_HELM_URL, token: '', fetchImpl: relayFetch(link), rpc: relayRpc(link) });
    const dirs = { defaultDir: '/Users/me/Volna Work', defaultTitle: 'Волна: Работа', newDir: '/Users/me/Documents' };
    const taken = await pickProject(client, 'Taken', true, dirs, AbortSignal.timeout(2000), mac.exists);
    assert.equal('error' in taken && taken.error, 'folder_exists');
    assert.ok(relay.seen.some(c => c.op === 'folder.exists' && c.path === '/Users/me/Documents/Taken'));
  } finally { relay.stop(); }
});

test('routes: only the Relay token polls and answers; the phone token does not; hello marks the Relay online', async () => {
  const link = new RelayLink();
  let hellos = 0;
  await run({ token: 'phone', relay: { link, token: 'mac', onHello: () => hellos++ } }, async url => {
    const as = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    assert.equal((await fetch(`${url}/relay?wait=0`, { headers: as('phone') })).status, 401);
    const hello = await fetch(`${url}/relay/hello`, { method: 'POST', headers: as('mac'), body: JSON.stringify({ version: '1', t3: { ok: true, version: '0.0.42', reason: null } }) });
    assert.equal(hello.status, 200);
    assert.equal(hellos, 1);
    assert.equal(link.hello?.t3.version, '0.0.42');
    const pending = link.call({ op: 'folder.exists', path: '/p' });
    const { calls } = await (await fetch(`${url}/relay?wait=0`, { headers: as('mac') })).json() as { calls: RelayCall[] };
    assert.equal(calls.length, 1);
    assert.equal((await fetch(`${url}/relay/${calls[0]!.id}`, { method: 'POST', headers: as('mac'), body: '{"ok":true,"data":true}' })).status, 200);
    assert.deepEqual(await pending, { ok: true, data: true });
    assert.equal((await fetch(`${url}/relay/${calls[0]!.id}`, { method: 'POST', headers: as('mac'), body: '{"ok":true,"data":true}' })).status, 404);
  });
});

test('routes: a gzip answer (big thread snapshot) arrives whole; a broken gzip is a 400', async () => {
  const link = new RelayLink();
  await run({ token: 'phone', relay: { link, token: 'mac', onHello: () => {} } }, async url => {
    const auth = { Authorization: 'Bearer mac', 'Content-Type': 'application/json' };
    await link.next(0);
    const pending = link.call({ op: 't3.request', method: 'GET', path: '/api/orchestration/shell' });
    const { calls } = await (await fetch(`${url}/relay?wait=0`, { headers: auth })).json() as { calls: RelayCall[] };
    const snapshot = { status: 200, body: { threads: Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, title: 'Волна: Работа' })) } };
    assert.equal((await fetch(`${url}/relay/${calls[0]!.id}`, { method: 'POST', headers: { ...auth, 'Content-Encoding': 'gzip' }, body: gzipSync(JSON.stringify({ ok: true, data: snapshot })) })).status, 200);
    assert.deepEqual(await pending, { ok: true, data: snapshot });
    const next = link.call({ op: 'folder.exists', path: '/p' }).catch(() => null);
    const again = await (await fetch(`${url}/relay?wait=0`, { headers: auth })).json() as { calls: RelayCall[] };
    assert.equal((await fetch(`${url}/relay/${again.calls[0]!.id}`, { method: 'POST', headers: { ...auth, 'Content-Encoding': 'gzip' }, body: 'not gzip' })).status, 400);
    link.answer(again.calls[0]!.id, { ok: true, data: false });
    await next;
  });
});

test('config: RELAY_TOKEN turns on Helm through the Relay with full Mac paths; HELM_TOKEN wins; ~ paths are refused', () => {
  const base = { OPEN_ROUTER_API_KEY: 'k' };
  const viaRelay = loadConfig({ ...base, RELAY_TOKEN: 'u', HELM_PROJECT_DIR: '/Users/me/Volna Work', HELM_NEW_PROJECTS_DIR: '/Users/me/Documents' });
  assert.equal(viaRelay.helm?.via, 'relay');
  assert.equal(viaRelay.helm?.url, RELAY_HELM_URL);
  assert.equal(viaRelay.helm?.token, '');
  assert.deepEqual(viaRelay.relay, { token: 'u' });
  assert.throws(() => loadConfig({ ...base, RELAY_TOKEN: 'u' }), /HELM_PROJECT_DIR/);
  const direct = loadConfig({ ...base, RELAY_TOKEN: 'u', HELM_TOKEN: 't' });
  assert.equal(direct.helm?.via, 'direct');
  assert.equal(direct.relay, null);
  assert.equal(loadConfig(base).helm, null);
});
