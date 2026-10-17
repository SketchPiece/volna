import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { silentLogger } from '../log.ts';
import type { ApnsRequest, ApnsResponse } from '../push/apns.ts';
import { run } from '../test-support.ts';
import { makeAggregate, type AgentState } from './aggregate.ts';
import { HelmPush, type DeviceRegistration } from './helm-push.ts';

const NOW = new Date('2026-10-03T12:00:00Z');
const PUSH = 'a'.repeat(64);
const ACTIVITY = 'c'.repeat(64);
const PREFS = { liveActivitiesEnabled: true, notificationsEnabled: true, notifyOnApproval: true, notifyOnInput: true, notifyOnCompletion: true, notifyOnFailure: true };

function state(threadId: string, phase: AgentState['phase'], minutesAgo = 0): AgentState {
  return {
    environmentId: 'env', threadId, projectTitle: 'Volna', threadTitle: `Thread ${threadId}`, phase, headline: 'h',
    modelTitle: 'gpt-6', updatedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), deepLink: `/threads/env/${threadId}`
  };
}

const device = (overrides: Partial<DeviceRegistration> = {}): DeviceRegistration => ({
  deviceId: 'phone', label: 'iPhone', platform: 'ios', iosMajorVersion: 26, bundleId: 'com.sketchpiece.helm',
  apsEnvironment: 'production', pushToken: PUSH, preferences: PREFS, ...overrides
});

async function setup(respond: (request: ApnsRequest) => ApnsResponse = () => ({ status: 200, reason: null })) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const requests: ApnsRequest[] = [];
  let now = NOW;
  const push = new HelmPush({
    dir: await mkdtemp(join(tmpdir(), 'helm-')), log: silentLogger, now: () => now,
    apns: { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), keyId: 'KEY', teamId: 'TEAM' },
    transport: async request => { requests.push(request); return respond(request); }
  });
  return { push, requests, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const aps = (request: ApnsRequest) => JSON.parse(request.body).aps;

test('the card leads with whoever waits on the owner and keeps recent finishes after active work', () => {
  const card = makeAggregate([state('run', 'running'), state('ask', 'waiting_for_approval'), state('done', 'completed', 3), state('old', 'completed', 30)], null, NOW.getTime());
  assert.deepEqual(card?.activities.map(row => [row.threadId, row.status]), [['ask', 'Approval'], ['run', 'Working'], ['done', 'Done']]);
  assert.equal(card?.activeCount, 2);
  assert.equal(makeAggregate([state('old', 'completed', 30)], null, NOW.getTime()), null, 'nothing recent: the card closes');
  assert.equal(makeAggregate([state('lost', 'running', 180)], null, NOW.getTime()), null, 'a silent running thread expires');
});

test('without a Live Activity the phone gets one alert per transition, localized by the app', async () => {
  const { push, requests } = await setup();
  await push.registerDevice(device());
  await push.publish({ environmentId: 'env', threadId: 't1' }, state('t1', 'running'));
  assert.equal(requests.length, 0, 'working is not news');
  await push.publish({ environmentId: 'env', threadId: 't1' }, state('t1', 'waiting_for_approval'));
  await push.publish({ environmentId: 'env', threadId: 't1' }, { ...state('t1', 'waiting_for_approval'), threadTitle: 'Renamed' });
  assert.equal(requests.length, 1, 'the same wait does not alert twice');
  const [alert] = requests;
  assert.equal(alert!.headers['apns-topic'], 'com.sketchpiece.helm');
  assert.equal(alert!.host, 'api.push.apple.com');
  assert.deepEqual(aps(alert!).alert, { title: 'Thread t1', body: 'Approval needed: Volna', 'loc-key': 'HELM_ALERT_APPROVAL', 'loc-args': ['Volna'] });
  assert.equal(JSON.parse(alert!.body).deepLink, '/threads/env/t1');
  await push.publish({ environmentId: 'env', threadId: 't1' }, state('t1', 'completed'));
  assert.equal(aps(requests[1]!).alert['loc-key'], 'HELM_ALERT_DONE');
});

test('a Live Activity is replayed silently, updated with an alert on a wait, throttled, and ended when work is gone', async () => {
  const { push, requests, advance } = await setup();
  await push.publish({ environmentId: 'env', threadId: 't1' }, state('t1', 'running'));
  await push.registerDevice(device());
  await push.registerLiveActivity({ deviceId: 'phone', activityPushToken: ACTIVITY });
  const replay = requests.at(-1)!;
  assert.equal(replay.headers['apns-topic'], 'com.sketchpiece.helm.push-type.liveactivity');
  assert.equal(replay.headers['apns-priority'], '5');
  assert.equal(aps(replay).alert, undefined);
  assert.equal(JSON.parse(aps(replay)['content-state'].props).activities[0].threadId, 't1');

  advance(1_000);
  await push.publish({ environmentId: 'env', threadId: 't1' }, { ...state('t1', 'running'), threadTitle: 'Renamed' });
  assert.equal(requests.length, 1, 'a quiet change inside 15 s waits');
  await push.publish({ environmentId: 'env', threadId: 't1' }, state('t1', 'waiting_for_input'));
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.headers['apns-priority'], '10');
  assert.equal(aps(requests[1]!).alert['loc-key'], 'HELM_ALERT_INPUT');

  await push.publish({ environmentId: 'env', threadId: 't1' }, null);
  assert.equal(requests.length, 2, 'a freshly armed card is not closed right away');
  advance(3 * 60_000);
  await push.publish({ environmentId: 'env', threadId: 't2' }, null);
  assert.equal(aps(requests.at(-1)!).event, 'end');
});

test('a sandbox token sent to production is retried in the sandbox, which then sticks', async () => {
  const { push, requests } = await setup(request => (request.host === 'api.push.apple.com' ? { status: 400, reason: 'BadDeviceToken' } : { status: 200, reason: null }));
  await push.registerDevice(device());
  await push.publish({ environmentId: 'env', threadId: 't1' }, state('t1', 'failed'));
  await push.publish({ environmentId: 'env', threadId: 't2' }, state('t2', 'failed'));
  assert.deepEqual(requests.map(request => request.host), ['api.push.apple.com', 'api.sandbox.push.apple.com', 'api.sandbox.push.apple.com']);
});

test('/helm speaks the relay API: the server token only publishes, the phone token only registers and reads', async () => {
  const { push } = await setup();
  await run({ token: 'core', helm: { push, serverToken: 'server', deviceToken: 'device' } }, async url => {
    const call = (path: string, token: string, init: RequestInit = {}) => fetch(`${url}/helm${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    const publish = (body: unknown, token = 'server') => call('/v1/environments/env/threads/t1/agent-activity', token, { method: 'POST', body: JSON.stringify(body) });
    const register = (token: string) => call('/v1/mobile/devices', token, { method: 'POST', body: JSON.stringify(device()) });
    assert.equal((await publish({ state: null }, 'core')).status, 401, 'the core token opens nothing here');
    assert.equal((await publish({ state: null }, 'device')).status, 401, 'a phone cannot publish');
    assert.equal((await register('server')).status, 401, 'the Mac cannot register phones');
    assert.equal((await call('/v1/mobile/agent-activity', 'server')).status, 401);
    assert.deepEqual(await (await publish({ state: state('t1', 'running'), proof: 'ignored' })).json(), { ok: true, deliveries: [] });
    assert.equal((await publish({ state: state('other', 'running') })).status, 400);
    assert.equal((await call('/v1/mobile/live-activities', 'device', { method: 'POST', body: JSON.stringify({ deviceId: 'nobody', activityPushToken: ACTIVITY }) })).status, 404);
    assert.equal((await register('device')).status, 200);
    const snapshot = await (await call('/v1/mobile/agent-activity', 'device')).json() as { aggregate: { activeCount: number } };
    assert.equal(snapshot.aggregate.activeCount, 1);
  });
});

test('a Mac waiting for Face ID wakes every phone with a short-lived, app-localized alert', async () => {
  const { push, requests } = await setup();
  await push.registerDevice(device({ preferences: { ...PREFS, notificationsEnabled: false } }));
  await push.notifyAuthRequest({ environmentId: 'env', id: 'sudo-1', kind: 'sudo', app: 'sudo', title: 'brew services restart nginx' });
  await push.notifyAuthRequest({ environmentId: 'env', id: 'prompt-1-2', kind: 'prompt', app: '1Password', title: '1Password is trying to unlock.' });
  assert.equal(requests.length, 2, 'thread notification settings do not hold these back');
  assert.deepEqual(aps(requests[0]!).alert['loc-args'], ['brew services restart nginx']);
  assert.equal(aps(requests[0]!).alert['loc-key'], 'HELM_ALERT_MAC_SUDO');
  assert.equal(aps(requests[1]!).alert['loc-key'], 'HELM_ALERT_MAC_UNLOCK');
  assert.deepEqual(aps(requests[1]!).alert['loc-args'], ['1Password']);
  assert.equal(JSON.parse(requests[1]!.body).authRequestId, 'prompt-1-2');
  assert.equal(requests[1]!.headers['apns-expiration'], String(Math.floor(NOW.getTime() / 1000) + 120));
});
