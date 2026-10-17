import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceBroker } from './device-broker.ts';
import { deviceToolRoutes } from '../http/device-tool-routes.ts';
import { bearerAuth } from '../http/guards.ts';

test('a device call waits for the phone: long poll hands it out once, the answer resolves it', async () => {
  const broker = new DeviceBroker();
  const polling = broker.next(1000);
  const result = broker.request('create_reminder', '{"title":"молоко"}');
  const [call] = await polling;
  assert.equal(call!.name, 'create_reminder');
  assert.equal(call!.arguments, '{"title":"молоко"}');
  assert.deepEqual(await broker.next(0), [], 'not handed out twice');
  assert.equal(broker.answer(call!.id, '{"id":"r1"}'), true);
  assert.equal(await result, '{"id":"r1"}');
  assert.equal(broker.answer(call!.id, '{}'), false, 'closed calls are not answered twice');
});

test('no phone polling gives device_unavailable; a taken but silent call gives device_timeout', async () => {
  const broker = new DeviceBroker(20);
  assert.equal(await broker.request('list_events', '{}'), '{"error":"device_unavailable"}');
  const pending = broker.request('list_events', '{}');
  await broker.next(0);
  assert.equal(await pending, '{"error":"device_timeout"}');
  assert.equal(broker.size, 0);
});

test('routes: the phone polls and answers with its core token', async () => {
  const broker = new DeviceBroker();
  const app = deviceToolRoutes({ broker, auth: bearerAuth('t') });
  const auth = { Authorization: 'Bearer t' };
  assert.equal((await app.request('/?wait=0')).status, 401);
  const result = broker.request('find_contact', '{"name":"Мама"}');
  const { calls } = await (await app.request('/?wait=500', { headers: auth })).json() as any;
  assert.equal(calls[0].name, 'find_contact');
  const post = (id: string, body: unknown) => app.request(`/${id}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(calls[0].id, { nope: 1 })).status, 400);
  assert.equal((await post('x'.repeat(32), { output: '{}' })).status, 404);
  assert.equal((await post(calls[0].id, { output: '{"contacts":[]}' })).status, 200);
  assert.equal(await result, '{"contacts":[]}');
});

test('wait music: the poll carries the running work and wakes when it changes', async () => {
  const broker = new DeviceBroker();
  let working: string[] = [];
  const app = deviceToolRoutes({ broker, auth: bearerAuth('t'), working: () => working });
  const auth = { Authorization: 'Bearer t' };
  assert.deepEqual(await (await app.request('/?wait=0', { headers: auth })).json(), { calls: [], working: [] });
  const started = Date.now();
  const polling = app.request('/?wait=5000', { headers: auth });
  setTimeout(() => { working = ['abc']; broker.notify(); }, 20);
  assert.deepEqual(await (await polling).json(), { calls: [], working: ['abc'] });
  assert.ok(Date.now() - started < 2000, 'notify ends the long poll at once');
});
