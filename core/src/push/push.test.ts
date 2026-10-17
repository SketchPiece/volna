import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { silentLogger } from '../log.ts';
import { ApnsSender, type ApnsRequest } from './apns.ts';
import { DeviceTokens } from './devices.ts';
import { run } from '../test-support.ts';

const VOIP = 'a'.repeat(64);
const ALERT = 'b'.repeat(64);

async function setup(status = 200, reason: string | null = null) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const devices = new DeviceTokens(await mkdtemp(join(tmpdir(), 'push-')));
  await devices.register({ voip: VOIP, alert: ALERT, environment: 'development' });
  const requests: ApnsRequest[] = [];
  const sender = new ApnsSender({
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), keyId: 'KEY123', teamId: 'TEAM45', topic: 'dev.prototype.callassistant',
    devices, log: silentLogger, now: () => new Date('2026-09-22T10:00:00Z'),
    transport: async request => { requests.push(request); return { status, reason }; }
  });
  return { sender, devices, requests, publicKey };
}

test('VoIP push goes to the sandbox with the .voip topic, no expiry, and a valid ES256 provider token', async () => {
  const { sender, requests, publicKey } = await setup();
  assert.equal(await sender.call({ task: 't1', title: 'Перелёты' }), true);
  const request = requests[0]!;
  assert.equal(request.host, 'api.sandbox.push.apple.com');
  assert.equal(request.path, `/3/device/${VOIP}`);
  assert.deepEqual([request.headers['apns-topic'], request.headers['apns-push-type'], request.headers['apns-expiration']], ['dev.prototype.callassistant.voip', 'voip', '0']);
  assert.deepEqual(JSON.parse(request.body), { task: 't1', title: 'Перелёты' });
  const [header, claims, signature] = request.headers.authorization!.replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { alg: 'ES256', kid: 'KEY123' });
  assert.deepEqual(JSON.parse(Buffer.from(claims!, 'base64url').toString()), { iss: 'TEAM45', iat: 1790071200 });
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')));
});

test('alert push is time-sensitive with the plain topic; the provider token is reused', async () => {
  const { sender, requests } = await setup();
  await sender.notify({ title: 'Волна', body: 'Готово' }, { task: 't1' });
  await sender.notify({ title: 'Волна', body: 'Ещё' });
  const body = JSON.parse(requests[0]!.body);
  assert.deepEqual(body, { aps: { alert: { title: 'Волна', body: 'Готово' }, sound: 'default', 'interruption-level': 'time-sensitive' }, task: 't1' });
  assert.equal(requests[0]!.headers['apns-topic'], 'dev.prototype.callassistant');
  assert.equal(requests[0]!.path, `/3/device/${ALERT}`);
  assert.equal(requests[0]!.headers.authorization, requests[1]!.headers.authorization);
});

test('a dead token (410) is forgotten; without a token nothing is sent', async () => {
  const { sender, devices, requests } = await setup(410, 'Unregistered');
  assert.equal(await sender.call({ task: 't' }), false);
  assert.equal(devices.current!.voip, null);
  assert.equal(sender.canCall(), false);
  assert.equal(await sender.call({ task: 't' }), false);
  assert.equal(requests.length, 1);
  assert.equal(sender.canNotify(), true);
});

test('POST /push/register stores tokens behind the core token and reports what the core can do', async () => {
  const devices = new DeviceTokens(await mkdtemp(join(tmpdir(), 'push-')));
  await run({ token: 'core', push: { devices, apns: true } }, async url => {
    const register = (body: unknown, token = 'core') => fetch(`${url}/push/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal((await register({ voip: VOIP, environment: 'production' }, 'wrong')).status, 401);
    assert.equal((await register({ voip: 'nothex', environment: 'production' })).status, 400);
    assert.deepEqual(await (await register({ voip: VOIP, environment: 'production' })).json(), { ok: true, apns: true, call: true, notify: false });
    assert.deepEqual(await (await register({ alert: ALERT, environment: 'production' })).json(), { ok: true, apns: true, call: true, notify: true }, 'a missing kind keeps the old token');
  });
  assert.deepEqual([devices.current!.voip, devices.current!.alert, devices.current!.environment], [VOIP, ALERT, 'production']);
});
