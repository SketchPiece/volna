import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallTrace, TraceStore } from './trace.ts';
import { summarize, turnsOf, turnsCsv, jevAgrees } from './summary.ts';

function clocked() {
  let now = 0;
  const trace = new CallTrace({ callId: 'live_1', config: { backendModel: 'luna', reasoning: 'low', serviceTier: 'auto', jev: 'shadow' }, clock: () => now, now: () => new Date('2026-09-22T10:00:00Z') });
  return { trace, at: (ms: number) => { now = ms; } };
}

test('trace keeps timings and safe fields, never the words of the conversation', () => {
  const { trace, at } = clocked();
  at(10); trace.observe({ type: 'session.input_transcript.delta', delta: 'секретная фраза', start_ms: 100, end_ms: 900 });
  at(20); trace.observe({ type: 'session.delegation.created', offset_ms: 1200, delegation: { id: 'item_1', target: 'responses' } });
  at(30); trace.observe({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_text.delta', item_id: 'm1', delta: 'секрет' } });
  at(31); trace.observe({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_text.delta', item_id: 'm1', delta: 'ещё' } });
  at(40); trace.observe({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done', item: { type: 'function_call', name: 'recall', arguments: '{"query":"секрет"}' } } });
  at(50); trace.observe({ type: 'response.event', event: { type: 'response.done', response: { status: 'completed', usage: { input_tokens: 900, output_tokens: 40, output_tokens_details: { reasoning_tokens: 12 } } } } });
  const json = JSON.stringify(trace.toJSON());
  assert.doesNotMatch(json, /секрет/);
  assert.deepEqual(trace.events.map(e => e.type), ['in', 'session.delegation.created', 'r.response.output_text.delta', 'r.response.output_item.done', 'r.response.done']);
  assert.deepEqual(trace.events[0], { s: 100, e: 900, n: 15, t: 10, type: 'in' });
  assert.equal(trace.events[1]!.offset, 1200);
  assert.equal(trace.events[3]!.tool, 'recall');
  assert.equal(trace.events[4]!.reasoningTokens, 12);
});

test('store saves one file per call and loads them back, skipping broken files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
  const store = new TraceStore(dir);
  const { trace } = clocked();
  trace.mark('tool.start', { tool: 'x', origin: 'backend' });
  const name = await store.save(trace);
  assert.equal(name, '2026-09-22-10-00-00-live_1.json');
  await writeFile(join(dir, '2026-09-23-broken.json'), '{nope');
  const files = await store.load();
  assert.equal(files.length, 1);
  assert.equal(files[0]!.events[0]!.type, 'tool.start');
  assert.equal((await store.load('2026-09-23')).length, 0);
  assert.deepEqual(await new TraceStore(join(dir, 'missing')).load(), []);
});

test('turns measure speech, delegation, tool selection, execution and the second backend pass', () => {
  const { trace, at } = clocked();
  // Ход 1: прямой ответ без делегирования.
  at(100); trace.observe({ type: 'session.input_transcript.delta', delta: 'привет', start_ms: 0, end_ms: 500 });
  at(900); trace.observe({ type: 'session.output_transcript.delta', delta: 'Слушаю' });
  // Ход 2: время через бэкенд, Jev угадал.
  at(2000); trace.observe({ type: 'session.input_transcript.delta', delta: 'который', start_ms: 1500, end_ms: 1800 });
  at(2100); trace.observe({ type: 'session.input_transcript.delta', delta: ' час', start_ms: 1800, end_ms: 2000 });
  at(2400); trace.mark('jev.result', { tool: 'current_time', ms: 180, action: 'shadow_tool', goodbye: 0.01 });
  at(2600); trace.observe({ type: 'session.delegation.created', offset_ms: 2500, delegation: { id: 'd2', target: 'responses' } });
  at(3400); trace.observe({ type: 'response.event', delegation_id: 'd2', event: { type: 'response.output_item.done', item: { type: 'function_call', name: 'current_time' } } });
  at(3401); trace.mark('tool.start', { tool: 'current_time', origin: 'backend' });
  at(3403); trace.mark('tool.end', { tool: 'current_time', origin: 'backend', ok: true });
  at(3404); trace.mark('tool.output.sent', { tool: 'current_time' });
  at(3900); trace.observe({ type: 'response.event', delegation_id: 'd2', event: { type: 'response.output_text.delta', item_id: 'm2' } });
  at(4000); trace.observe({ type: 'response.event', delegation_id: 'd2', event: { type: 'response.done', response: { usage: { output_tokens_details: { reasoning_tokens: 30 } } } } });
  at(4300); trace.observe({ type: 'session.output_transcript.delta', delta: 'Десять' });

  const turns = turnsOf(trace.toJSON());
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.speak, 800);
  assert.equal(turns[0]!.decide, null);
  const t = turns[1]!;
  assert.deepEqual({ speak: t.speak, decide: t.decide, decideAudio: t.decideAudio, select: t.select, tool: t.tool, resume: t.resume, backend: t.backend },
    { speak: 2200, decide: 500, decideAudio: 500, select: 800, tool: 2, resume: 496, backend: 1400 });
  assert.deepEqual(t.tools, ['current_time']);
  assert.equal(t.reasoningTokens, 30);
  assert.equal(t.jevTool, 'current_time');
  assert.equal(jevAgrees(t, ['current_time']), true);

  const summary = summarize([trace.toJSON()], ['current_time']);
  assert.equal(summary.groups.length, 1);
  assert.match(summary.groups[0]!.config, /reasoning=low/);
  assert.equal(summary.groups[0]!.answerDirect.p50, 800);
  assert.equal(summary.groups[0]!.answerWithTools.p50, 2200);
  assert.equal(t.answer, 2200);
  assert.deepEqual(summary.groups[0]!.jev, { evaluated: 1, agree: 1, actions: { shadow_tool: 1 } });

  const csv = turnsCsv([trace.toJSON()]).trim().split('\n');
  assert.equal(csv.length, 3);
  assert.match(csv[2]!, /current_time/);
});

test('Jev saying none agrees when the backend used a tool outside the prefetch candidates', () => {
  const base = { callId: 'c', config: '', index: 0, userEnd: 0, speak: null, answer: null, decide: null, decideAudio: null, select: null, tool: null, resume: null, backend: null, reasoningTokens: null, jevMs: 1, jevAction: 'below', jevGoodbye: 0, prefetched: null, route: null, escalations: 0 };
  assert.equal(jevAgrees({ ...base, tools: ['web_search'], jevTool: 'none' }, ['current_time']), true);
  assert.equal(jevAgrees({ ...base, tools: [], jevTool: 'current_time' }, ['current_time']), false);
  assert.equal(jevAgrees({ ...base, tools: [], jevTool: null }, ['current_time']), null);
});

test('client delegation turns carry their route and escalations; the summary groups them', () => {
  const { trace, at } = clocked();
  at(100); trace.observe({ type: 'session.input_transcript.delta', delta: 'напомни', start_ms: 0, end_ms: 500 });
  at(200); trace.observe({ type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } });
  at(600); trace.mark('jev.result', { d: 'd1', tool: 'none', action: 'route', pack: 'planner', tier: 'simple' });
  at(601); trace.mark('client.route', { d: 'd1', attempt: 1, tier: 'simple', pack: 'planner' });
  at(900); trace.mark('client.escalate', { d: 'd1', from: 'simple', to: 'standard', reason: 'escalate' });
  at(901); trace.mark('client.route', { d: 'd1', attempt: 2, tier: 'standard', pack: 'all' });
  at(1500); trace.mark('client.commentary.sent', { d: 'd1', path: 'llm' });
  at(1800); trace.observe({ type: 'session.output_transcript.delta', delta: 'Готово' });
  at(3000); trace.observe({ type: 'session.input_transcript.delta', delta: 'который час', start_ms: 2500, end_ms: 2900 });
  at(3100); trace.observe({ type: 'session.delegation.created', delegation: { id: 'd2', target: 'client' } });
  at(3500); trace.mark('jev.result', { d: 'd2', tool: 'current_time', action: 'answer' });
  at(3510); trace.mark('client.commentary.sent', { d: 'd2', path: 'jev' });
  at(3700); trace.observe({ type: 'session.output_transcript.delta', delta: 'Десять' });
  const turns = turnsOf(trace.toJSON());
  assert.deepEqual(turns.map(t => [t.route, t.escalations]), [['standard/all', 1], ['jev', 0]]);
  const { perRoute } = summarize([trace.toJSON()], ['current_time']).groups[0]!;
  assert.deepEqual(Object.keys(perRoute).sort(), ['jev', 'standard/all']);
  assert.equal(perRoute['standard/all']!.escalated, 1);
  assert.equal(perRoute.jev!.answer.p50, 700);
});
