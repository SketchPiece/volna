import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { chatModel } from '../delegation/llm.ts';
import { jevClient } from '../jev/client.ts';
import { askStructured, dream } from '../memory/extractor.ts';
import { emptyState } from '../memory/model.ts';
import { openRouterUsage, scopedListener, UsageLedger, usageScope, voiceUsage, type UsageEntry, type UsageInput } from './ledger.ts';
import { callCost, costReport, dayKey, modelReport, rangeOf, zonedMidnight } from './report.ts';
import { Cached, openAiBill, openRouterBill } from './billing.ts';
import { z } from 'zod';

const recorder = () => { const rows: UsageInput[] = []; return { rows, record: (row: UsageInput) => { rows.push(row); } }; };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const OR_USAGE = { prompt_tokens: 1200, completion_tokens: 80, cost: 0.0042, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens_details: { reasoning_tokens: 30 } };

test('openRouterUsage reads tokens, cache, reasoning and cost', () => {
  assert.deepEqual(openRouterUsage(OR_USAGE), { inTokens: 1200, cachedTokens: 900, outTokens: 80, reasoningTokens: 30, costUsd: 0.0042 });
  assert.deepEqual(openRouterUsage({ input_tokens: 5, output_tokens: 2 }), { inTokens: 5, cachedTokens: null, outTokens: 2, reasoningTokens: null, costUsd: null });
  assert.deepEqual(openRouterUsage(undefined), { inTokens: null, cachedTokens: null, outTokens: null, reasoningTokens: null, costUsd: null });
});

test('ledger appends one line per call to the month file and reloads it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  const ledger = new UsageLedger({ dir, log: silentLogger, now: () => new Date('2026-09-27T10:00:00Z') });
  usageScope({ callId: 'live_1' }, () => ledger.record({ purpose: 'delegation', model: 'openai/gpt-5.6-luna', inTokens: 10, costUsd: 0.01 }));
  ledger.record({ purpose: 'title', model: 'openai/gpt-5.6-luna', costUsd: 0.001 });
  await ledger.flush();
  const lines = (await readFile(join(dir, '2026-09.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].callId, 'live_1');
  assert.equal(lines[0].service, 'delegation');
  assert.equal(lines[1].callId, null);
  assert.equal(lines[1].service, 'service');
  const again = new UsageLedger({ dir, log: silentLogger });
  await again.load();
  assert.equal(again.entries().length, 2);
});

test('scoped listener carries the call id into timers and promises started while observing', async () => {
  const meter = recorder();
  const listener = scopedListener({
    observe: () => {
      setTimeout(() => meter.record({ purpose: 'jev_goodbye', model: 'jev' }), 1);
      void Promise.resolve().then(() => usageScope({ purpose: 'jev_route' }, () => meter.record({ purpose: 'jev', model: 'jev' })));
    }
  }, 'live_7');
  const ledger = new UsageLedger({ dir: join(tmpdir(), 'never-written'), log: silentLogger });
  const captured: (string | null)[] = [];
  const probe = scopedListener({ observe: () => { setTimeout(() => { ledger.record({ purpose: 'search', model: 'm' }); captured.push(ledger.entries().at(-1)!.callId); }, 1); } }, 'live_9');
  listener.observe!({});
  probe.observe!({});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(captured, ['live_9']);
  assert.equal(meter.rows.length, 2);
});

test('voice usage records the final seconds once at the price per minute', () => {
  const meter = recorder();
  const listener = voiceUsage(meter, { callId: 'live_1', model: 'gpt-live-1', pricePerMinute: 0.05 });
  listener.observe!({ type: 'session.usage.updated', usage: { seconds: 15 } });
  listener.observe!({ type: 'session.usage.updated', usage: { seconds: 240 } });
  listener.observe!({ type: 'session.closed', usage: { seconds: 251 } });
  listener.close!();
  assert.equal(meter.rows.length, 1);
  assert.deepEqual(meter.rows[0], { purpose: 'voice', model: 'gpt-live-1', callId: 'live_1', seconds: 251, costUsd: 0.209167 });
});

test('voice usage falls back to the last update when the socket drops without session.closed', () => {
  const meter = recorder();
  const listener = voiceUsage(meter, { callId: 'live_2', model: 'gpt-live-1', pricePerMinute: 0.05 });
  listener.observe!({ type: 'session.usage.updated', usage: { seconds: 60 } });
  listener.close!();
  assert.equal(meter.rows[0]!.costUsd, 0.05);
  const silent = recorder();
  voiceUsage(silent, { callId: 'live_3', model: 'gpt-live-1', pricePerMinute: 0.05 }).close!();
  assert.equal(silent.rows.length, 0);
});

test('chat model asks OpenRouter for the cost and meters every answer', async () => {
  const meter = recorder();
  let body: any;
  const model = chatModel({
    apiKey: 'k', model: 'google/gemini-3.5-flash-lite', meter: { ledger: meter, purpose: 'search' },
    fetchImpl: async (_url, init) => { body = JSON.parse(String(init!.body)); return json({ choices: [{ message: { content: 'ok' } }], usage: OR_USAGE }); }
  });
  const result = await model.complete([{ role: 'user', content: 'hi' }], [], new AbortController().signal);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(result.usage.costUsd, 0.0042);
  assert.equal(result.usage.cachedTokens, 900);
  assert.deepEqual(meter.rows, [{ purpose: 'search', model: 'google/gemini-3.5-flash-lite', inTokens: 1200, cachedTokens: 900, outTokens: 80, reasoningTokens: 30, costUsd: 0.0042 }]);
});

test('Jev meters with the purpose of the calling scope', async () => {
  const meter = recorder();
  const jev = jevClient({ apiKey: 'k', model: 'typesafe/jev-1.13', meter, fetchImpl: async () => json({ answers: {}, usage: { input_tokens: 300, output_tokens: 4, cost: 0.0001 } }) });
  await usageScope({ purpose: 'jev_route' }, () => jev.decide({ state: '', questions: {} }, new AbortController().signal));
  await jev.decide({ state: '', questions: {} }, new AbortController().signal);
  assert.deepEqual(meter.rows.map(r => [r.purpose, r.inTokens, r.costUsd]), [['jev_route', 300, 0.0001], ['jev', 300, 0.0001]]);
});

test('memory calls are metered as extraction, dream and persona review', async () => {
  const meter = recorder();
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init!.body)).usage, { include: true });
    return json({ choices: [{ message: { content: '{"operations":[],"profile":null}' } }], usage: OR_USAGE });
  };
  const options = { apiKey: 'k', model: 'anthropic/claude-sonnet-5', deepModel: 'anthropic/claude-opus-5.5', timeZone: 'UTC', log: silentLogger, fetchImpl: fetchImpl as typeof fetch, meter };
  await dream(options, emptyState(new Date("2026-09-27T10:00:00Z")), new Date('2026-09-27T10:00:00Z')).catch(() => null);
  await askStructured(options, 'persona_review', z.unknown(), 's', 'u').catch(() => null);
  await askStructured(options, 'memory_update', z.unknown(), 's', 'u').catch(() => null);
  assert.deepEqual(meter.rows.map(r => [r.purpose, r.model]), [
    ['memory_dream', 'anthropic/claude-opus-5.5'], ['persona_review', 'anthropic/claude-sonnet-5'], ['memory_extract', 'anthropic/claude-sonnet-5']
  ]);
});

const entry = (at: string, patch: Partial<UsageEntry>): UsageEntry => ({
  at, service: 'delegation', purpose: 'delegation', model: 'openai/gpt-5.6-luna', callId: null,
  inTokens: null, cachedTokens: null, outTokens: null, reasoningTokens: null, seconds: null, costUsd: null, ...patch
});

test('days and midnights follow the owner time zone', () => {
  assert.equal(dayKey('2026-09-26T22:30:00Z', 'Europe/Berlin'), '2026-09-27');
  assert.equal(zonedMidnight('2026-09-27', 'Europe/Berlin').toISOString(), '2026-09-26T22:00:00.000Z');
  const month = rangeOf('month', new Date('2026-09-27T10:00:00Z'), 'Europe/Berlin');
  assert.equal(month.days.length, 27);
  assert.equal(month.from.toISOString(), '2026-08-31T22:00:00.000Z');
  assert.equal(month.previous.from.toISOString(), '2026-07-31T22:00:00.000Z');
  assert.equal(rangeOf('7d', new Date('2026-09-27T10:00:00Z'), 'UTC').days[0], '2026-09-21');
});

test('cost report sums services, models, days, calls and the forecast', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const all = [
    entry('2026-08-05T10:00:00Z', { costUsd: 1 }),
    entry('2026-09-02T10:00:00Z', { service: 'voice', purpose: 'voice', model: 'gpt-live-1', callId: 'a', seconds: 120, costUsd: 0.1 }),
    entry('2026-09-02T10:01:00Z', { callId: 'a', inTokens: 1000, cachedTokens: 400, outTokens: 50, costUsd: 0.02 }),
    entry('2026-09-02T10:05:00Z', { service: 'memory', purpose: 'memory_extract', model: 'anthropic/claude-sonnet-5', callId: 'a', costUsd: 0.05 }),
    entry('2026-09-09T09:00:00Z', { service: 'voice', purpose: 'voice', model: 'gpt-live-1', callId: 'b', seconds: 60, costUsd: 0.05 }),
    entry('2026-09-09T09:02:00Z', { service: 'jev', purpose: 'jev_route', model: 'typesafe/jev-1.13', callId: 'b', costUsd: null }),
    entry('2026-09-09T20:00:00Z', { service: 'service', purpose: 'title', costUsd: 0.01 })
  ];
  const report = costReport(all, rangeOf('month', now, 'UTC'), 'UTC');
  assert.equal(report.total, 0.23);
  assert.equal(report.previous, 1);
  assert.equal(report.calls, 2);
  assert.equal(report.voiceSeconds, 180);
  assert.equal(report.perCall, 0.11);
  assert.equal(report.unpriced, 1);
  assert.equal(report.days.length, 10);
  assert.equal(report.days[1]!.total, 0.17);
  assert.equal(report.days[1]!.services.memory, 0.05);
  assert.deepEqual(report.services.map(s => s.service), ['voice', 'delegation', 'memory', 'jev', 'service']);
  assert.deepEqual(report.models.map(m => m.model), ['gpt-live-1', 'anthropic/claude-sonnet-5', 'openai/gpt-5.6-luna', 'typesafe/jev-1.13']);
  const luna = report.models.find(m => m.model === 'openai/gpt-5.6-luna')!;
  assert.deepEqual([luna.count, luna.calls, luna.cachedTokens, luna.cost, luna.services], [2, 1, 400, 0.03, ['delegation', 'service']]);
  assert.equal(report.models.find(m => m.model === 'typesafe/jev-1.13')!.unpriced, 1);
  assert.ok(Math.abs(report.forecast! - 0.23 / (9.5) * 30) < 1e-6);

  const detail = modelReport(all, 'openai/gpt-5.6-luna', rangeOf('month', now, 'UTC'), 'UTC');
  assert.deepEqual(detail.purposes.map(p => [p.purpose, p.count]), [['delegation', 1], ['title', 1]]);
  assert.equal(detail.entries[0]!.purpose, 'title');
  assert.equal(detail.share, 0.130435);

  const call = callCost(all, 'a');
  assert.equal(call.total, 0.17);
  assert.equal(call.seconds, 120);
  assert.deepEqual(call.services.map(s => s.service), ['voice', 'delegation', 'memory']);
});

test('OpenRouter bill reads the balance and the key usage', async () => {
  const bill = await openRouterBill('k', (async (url: string) => url.endsWith('/credits')
    ? json({ data: { total_credits: 10, total_usage: 6.97 } })
    : json({ data: { usage_daily: 0.19, usage_monthly: 6.97, label: 'x' } })) as typeof fetch);
  assert.deepEqual(bill, { balance: 3.03, day: 0.19, month: 6.97 });
});

test('OpenAI bill sums daily buckets across pages and filters by project', async () => {
  const urls: string[] = [];
  const bill = await openAiBill('admin', new Date('2026-09-01T00:00:00Z'), {
    project: 'proj_1',
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return url.includes('page=') ? json({ data: [{ start_time: 1790208000, results: [{ amount: { value: 0.5 } }] }], has_more: false })
        : json({ data: [{ start_time: 1788220800, results: [{ amount: { value: 1.25 } }, { amount: { value: '0.25' } }] }], has_more: true, next_page: 'p2' });
    }) as typeof fetch
  });
  assert.match(urls[0]!, /bucket_width=1d/);
  assert.match(urls[0]!, /project_ids=proj_1/);
  assert.equal(urls.length, 2);
  assert.deepEqual(bill, { days: [{ date: '2026-09-01', usd: 1.5 }, { date: '2026-09-24', usd: 0.5 }], total: 2 });
});

test('cached bill keeps the answer for the ttl and reports errors without the key', async () => {
  let now = 0, calls = 0;
  const cached = new Cached(async () => { calls++; if (calls === 2) throw new Error('boom'); return calls; }, 1000, () => now);
  assert.deepEqual((await cached.get()).ok, true);
  await cached.get();
  assert.equal(calls, 1);
  now = 2000;
  const failed = await cached.get();
  assert.equal(failed.ok, false);
  now = 3000;
  assert.equal((await cached.get()).ok, true);
});
