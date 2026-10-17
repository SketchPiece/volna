import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { Health } from '../telemetry/health.ts';
import { Cached } from '../usage/billing.ts';
import { UsageLedger } from '../usage/ledger.ts';
import { Dashboard } from './dashboard.ts';
import { ConsoleHub } from './hub.ts';
import { consoleApp } from './routes.ts';
import { ConsoleStore, type ConsoleRecord } from './store.ts';

const record = (callId: string, startedAt: string, said: string[]): ConsoleRecord => ({
  version: 1, callId, startedAt, durationMs: 60_000, info: { model: 'gpt-live-1', voice: 'v' },
  events: [
    ...said.map((delta, i) => ({ t: i, k: 'in' as const, type: 'session.input_transcript.delta', data: { type: 'session.input_transcript.delta', delta } })),
    { t: 50, k: 'in', type: 'session.output_transcript.delta', data: { type: 'session.output_transcript.delta', delta: 'Слушаю.' } },
    { t: 60, k: 'in', type: 'session.input_transcript.delta', data: { type: 'session.input_transcript.delta', delta: 'Вторая просьба' } }
  ]
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-'));
  let now = new Date('2026-09-27T08:00:00Z');
  const ledger = new UsageLedger({ dir: join(dir, 'usage'), log: silentLogger, now: () => now });
  const store = new ConsoleStore(join(dir, 'console'));
  await store.save(record('live_a', '2026-09-27T07:00:00.000Z', ['Сравни тарифы ', 'трёх операторов,   мне нужен безлимит на весь месяц и роуминг по Европе']));
  ledger.record({ purpose: 'voice', model: 'gpt-live-1', callId: 'live_a', seconds: 60, costUsd: 0.05 });
  ledger.record({ purpose: 'delegation', model: 'openai/gpt-5.6-luna', callId: 'live_a', inTokens: 1000, cachedTokens: 0, outTokens: 50, costUsd: 0.01 });
  ledger.record({ purpose: 'memory_dream', model: 'anthropic/claude-opus-5.5', callId: null, costUsd: 0.5 });
  await ledger.flush();
  now = new Date('2026-09-27T09:00:00Z');
  const health = new Health(() => now);
  const log = health.logger(silentLogger);
  log.warn('plugin.mcp_failed', { plugin: 'calendar', reason: 'timeout' });
  log.warn('plugin.mcp_failed', { plugin: 'calendar', reason: 'timeout' });
  health.liveStarted('http_429');
  const dashboard = new Dashboard({
    ledger, timeZone: 'Europe/Berlin', health, store, now: () => now,
    openRouter: new Cached(async () => ({ balance: 3.03, day: 0.19, month: 6.97 }), 60_000),
    openAi: new Cached(async () => ({ days: [{ date: '2026-09-27', usd: 0.06 }], total: 0.06 }), 60_000),
    work: { access: 'ok', items: () => [{ id: 'helm:1', origin: 'owner', task: null, thread: '1', project: null, title: 'Мой тред', status: 'needs_you', waiting: { kind: 'question', text: 'секрет' }, progress: 'ход', result: 'итог', error: null, updatedAt: now.toISOString(), finishedAt: null, stale: false }] },
    push: { apns: true, devices: () => 1 }, plugins: { servers: 0 }
  });
  const app = consoleApp({ hub: new ConsoleHub({ log: silentLogger, store }), dashboard, port: 25452 });
  const get = async (path: string) => {
    const res = await app.request(`http://127.0.0.1:25452${path}`, { headers: { host: '127.0.0.1:25452' } });
    return { status: res.status, body: await res.json() as any };
  };
  return { dir, get, app };
}

test('the history list names each call by the start of the owner\'s first request', async () => {
  const { dir, get } = await setup();
  try {
    const { body } = await get('/api/history');
    assert.equal(body[0].title, 'Сравни тарифы трёх операторов, мне нужен безлимит на весь м…');
    assert.equal(body[0].title.length, 60);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the summary shows services, today, calls with their cost, work without its text and log warnings', async () => {
  const { dir, get } = await setup();
  try {
    const { status, body } = await get('/api/summary');
    assert.equal(status, 200);
    assert.deepEqual(body.live.error, 'http_429');
    assert.equal(body.openRouter.data.balance, 3.03);
    assert.deepEqual(body.plugins, { servers: 0, failed: 2 });
    assert.deepEqual(body.push, { apns: true, devices: 1 });
    assert.equal(body.today.cost, 0.56);
    assert.equal(body.today.calls, 1);
    assert.equal(body.calls[0].cost, 0.06);
    assert.equal(body.calls[0].title.startsWith('Сравни тарифы'), true);
    assert.deepEqual(body.work.items[0], { id: 'helm:1', origin: 'owner', title: 'Мой тред', status: 'needs_you', project: null, updatedAt: '2026-09-27T09:00:00.000Z', error: null, waiting: 'question' });
    assert.doesNotMatch(JSON.stringify(body.work), /секрет|итог/);
    assert.deepEqual(body.warnings.map((w: any) => [w.message, w.count]), [['plugin.mcp_failed', 2]]);
    assert.equal(body.spark.length, 14);
    assert.equal(body.spark.at(-1).total, 0.56);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('costs, one model and one call come from the ledger; OpenAI is reconciled with the voice seconds', async () => {
  const { dir, get } = await setup();
  try {
    const costs = await get('/api/costs?period=today');
    assert.equal(costs.body.total, 0.56);
    assert.deepEqual(costs.body.models.map((m: any) => m.model), ['anthropic/claude-opus-5.5', 'gpt-live-1', 'openai/gpt-5.6-luna']);
    assert.deepEqual([costs.body.openAi.data.total, costs.body.openAi.ours], [0.06, 0.05]);
    assert.equal((await get('/api/costs?period=year')).status, 400);
    const model = await get('/api/costs/models/anthropic/claude-opus-5.5?period=month');
    assert.equal(model.body.row.cost, 0.5);
    assert.deepEqual(model.body.purposes.map((p: any) => p.purpose), ['memory_dream']);
    const call = await get('/api/calls/live_a/cost');
    assert.deepEqual([call.body.total, call.body.seconds, call.body.services.map((s: any) => s.service)], [0.06, 60, ['voice', 'delegation']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('with the dashboard the console opens on the summary; the new pages are served', async () => {
  const { dir, app } = await setup();
  try {
    const req = (path: string) => app.request(`http://127.0.0.1:25452${path}`, { headers: { host: '127.0.0.1:25452' } });
    assert.equal((await req('/')).headers.get('location'), '/summary');
    for (const path of ['/summary', '/costs', '/costs/anthropic/claude-opus-5.5']) assert.equal((await req(path)).status, 200);
    const plain = consoleApp({ hub: new ConsoleHub({ log: silentLogger }), port: 25452 });
    assert.equal((await plain.request('http://127.0.0.1:25452/', { headers: { host: '127.0.0.1:25452' } })).headers.get('location'), '/live');
    assert.equal((await plain.request('http://127.0.0.1:25452/api/summary', { headers: { host: '127.0.0.1:25452' } })).status, 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
