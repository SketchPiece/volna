import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_VOICES } from './realtime/session.ts';
import { defaultTools } from './assistant/tools/index.ts';
import { run, post, offer, json, live, FakeSocket, tick, fakeDelegation } from './test-support.ts';

test('missing API key is actionable; health does not pretend the API is validated', () => run({ apiKey: '' }, async url => {
  const health = await json(await fetch(`${url}/health`));
  assert.equal(health.ready, false);
  assert.equal((await post(url)).status, 503);
  assert.equal(health.commit, null);
}));

test('health reports the deployed commit so CI can confirm the rollout', () => run({ apiKey: 'secret', commit: 'abc1234' }, async url => {
  assert.equal((await json(await fetch(`${url}/health`))).commit, 'abc1234');
}));

test('unknown routes answer JSON 404 without cache', () => run({ apiKey: 'secret' }, async url => {
  const response = await fetch(`${url}/nope`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}));

test('browser requests and invalid authentication never reach OpenAI', () => run({ apiKey: 'secret', token: 'device-token', fetchImpl: () => assert.fail('upstream called') }, async url => {
  assert.equal((await post(url, offer, { Origin: 'https://untrusted.test' })).status, 403);
  assert.equal((await post(url)).status, 401);
  assert.equal((await post(url, offer, { Authorization: 'Bearer wrong' })).status, 401);
}));

test('valid SDP creates a Live session with the core-owned model, WebRTC transport and client delegation; no key is returned', () => run({ apiKey: 'secret', token: 'device-token', fetchImpl: async (url, options: any) => {
  assert.equal(url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(options.headers.Authorization, 'Bearer secret');
  assert.equal(options.headers['Content-Type'], 'application/json');
  const { session, transport } = JSON.parse(options.body);
  assert.deepEqual(transport, { type: 'webrtc', sdp: offer });
  assert.equal(session.model, 'gpt-live-1');
  assert.equal(session.audio.output.voice, 'meridian');
  assert.equal('turn_detection' in (session.audio.input ?? {}), false);
  assert.match(session.instructions, /Волна/);
  assert.doesNotMatch(session.instructions, /товарищ|лаборатори/i);
  assert.deepEqual(session.delegation, { type: 'client' });
  return live(offer, 'live_1');
} }, async url => {
  const response = await post(url, offer, { Authorization: 'Bearer device-token' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), offer);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') ?? '', /application\/sdp/);
}));

test('without an OpenRouter key there is nobody to answer delegations: the call is refused before billing', () => run({
  apiKey: 'secret', clientDelegation: undefined, fetchImpl: () => assert.fail('upstream called')
}, async url => {
  const response = await post(url);
  assert.equal(response.status, 503);
  assert.match((await json(response)).error, /OPEN_ROUTER_API_KEY/);
  assert.equal((await json(await fetch(`${url}/health`))).ready, false);
}));

test('invalid and excessive SDP are rejected before billing', () => run({ apiKey: 'secret', fetchImpl: () => assert.fail('upstream called') }, async url => {
  assert.equal((await post(url, 'invalid')).status, 400);
  assert.equal((await post(url, 'v=0' + 'x'.repeat(66000))).status, 413);
  assert.equal((await post(url, offer, { 'Content-Type': 'application/json' })).status, 415);
}));

test('malformed upstream JSON or SDP is a 502 without leaking the body', () => run({ apiKey: 'secret', fetchImpl: async () => new Response('{"session":{"id":"x"},"transport":{"sdp":"garbage"}}', { status: 201 }) }, async url => {
  const response = await post(url);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /garbage/);
}));

test('upstream quota errors are translated without leaking provider body', () => run({ apiKey: 'secret', fetchImpl: async () => new Response('sensitive payload', { status: 429 }) }, async url => {
  const response = await post(url);
  assert.equal(response.status, 502);
  assert.match((await json(response)).error, /баланс/);
  assert.doesNotMatch(JSON.stringify(await (await post(url)).json()), /sensitive/);
}));

test('network errors are handled', () => run({ apiKey: 'secret', fetchImpl: async () => { throw new TypeError('secret transport info'); } }, async url => {
  const response = await post(url);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret/);
}));

test('burst attempts are limited', () => run({ apiKey: 'secret', fetchImpl: async () => live(offer) }, async url => {
  for (let n = 0; n < 10; n++) assert.equal((await post(url)).status, 200);
  assert.equal((await post(url)).status, 429);
}));

test('every built-in voice reaches the OpenAI session configuration', async () => {
  const received: string[] = [];
  await run({ apiKey: 'secret', limits: { perMinute: 100, concurrent: 2 }, fetchImpl: async (_url, options: any) => {
    received.push(JSON.parse(options.body).session.audio.output.voice);
    return live(offer);
  } }, async url => {
    for (const voice of LIVE_VOICES) {
      assert.equal((await post(url, offer, { 'X-Realtime-Voice': voice })).status, 200);
    }
  });
  assert.deepEqual(received, [...LIVE_VOICES]);
});

test('unknown voices are rejected before an OpenAI request', () => run({
  apiKey: 'secret', fetchImpl: () => assert.fail('upstream called')
}, async url => {
  assert.equal((await post(url, offer, { 'X-Realtime-Voice': 'not-a-voice' })).status, 400);
}));

test('with tools: Live gets no tool definitions, only their names in the instructions; sideband attaches and stays quiet', async () => {
  FakeSocket.reset();
  let session: any;
  await run({ apiKey: 'secret', webSearch: true, tools: defaultTools(), socketFactory: FakeSocket.factory, fetchImpl: async (_url, options: any) => {
    session = JSON.parse(options.body).session;
    return live(offer, 'live_test123');
  } }, async url => {
    assert.equal((await post(url)).status, 200);
    const health = await json(await fetch(`${url}/health`));
    assert.equal(health.ready, true);
    assert.ok(health.tools.includes('current_time'));
    assert.equal(health.webSearch, true);
  });
  assert.equal('tools' in session, false);
  // Эксперимент 363cc0e: определений инструментов у Live нет, но имена снова перечислены в инструкциях.
  assert.match(session.instructions, /Инструменты бэкенда: .*current_time.*web_search/);
  assert.match(session.instructions, /выполняет бэкенд/);
  await tick();
  assert.equal(FakeSocket.instances.length, 1);
  const [socket] = FakeSocket.instances;
  assert.equal(socket.url, 'wss://api.openai.com/v1/live/sessions/live_test123/attach');
  assert.equal(socket.headers.Authorization, 'Bearer secret');
  socket.emit('open', {});
  // Приветствие просит телефон после session.started, ядро при открытии молчит.
  assert.deepEqual(socket.sent, []);
  socket.close();
});

test('without a session id the call still succeeds and no sideband is opened', async () => {
  FakeSocket.reset();
  await run({ apiKey: 'secret', tools: defaultTools(), socketFactory: FakeSocket.factory, fetchImpl: async () => new Response(JSON.stringify({ transport: { type: 'webrtc', sdp: offer } }), { status: 201 }) }, async url => {
    assert.equal((await post(url)).status, 200);
  });
  assert.equal(FakeSocket.instances.length, 0);
});

test('device tools enter the session only when the app announces them in X-Device-Tools; the delegation sees their rules', async () => {
  const sessions: any[] = [];
  const fetchImpl = async (_url: string | URL | Request, options: any) => {
    sessions.push(JSON.parse(options.body).session);
    return live(offer);
  };
  const prompts: string[] = [];
  const offered: string[][] = [];
  const model = { model: 'fake/model', complete: async (messages: any[], tools: any[]) => { prompts.push(messages[0].content); offered.push(tools.map(t => t.function.name)); return { content: 'ok', toolCalls: [], usage: { inTokens: null, outTokens: null } }; } };
  FakeSocket.reset();
  await run({ apiKey: 'secret', tools: defaultTools(), socketFactory: FakeSocket.factory, clientDelegation: fakeDelegation(model), fetchImpl }, async url => {
    assert.equal((await post(url)).status, 200);
    assert.equal((await post(url, offer, { 'X-Device-Tools': 'create_reminder, list_events,unknown_tool,DROP TABLE' })).status, 200);
    const health = await json(await fetch(`${url}/health`));
    assert.ok(health.tools.includes('create_reminder'));
  });
  assert.equal(sessions.length, 2);
  await tick();
  // Инструменты звонка видит модель делегирования, а не голосовая: в её инструкциях имён нет.
  for (const [i, socket] of FakeSocket.instances.entries()) {
    socket.message({ type: 'session.input_transcript.delta', delta: 'напомни про хлеб' });
    socket.message({ type: 'session.delegation.created', delegation: { id: `item_c${i}`, type: 'delegation', target: 'client' } });
    for (let t = 0; t < 200 && prompts.length <= i; t++) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(!offered[0]!.includes('create_reminder'));
  assert.ok(offered[1]!.includes('create_reminder') && offered[1]!.includes('list_events'));
  assert.ok(!offered[1]!.includes('unknown_tool'));
  assert.match(prompts[1]!, /ISO 8601/);
  for (const s of FakeSocket.instances) s.close();
});

test('a finished call leaves a metrics file with the delegation models; prefetch adds its rule for Live', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { TraceStore } = await import('./telemetry/trace.ts');
  const metrics = new TraceStore(await mkdtemp(join(tmpdir(), 'core-metrics-')));
  const jev = { decide: async () => ({ model: 'jev', answers: {} }) };
  FakeSocket.reset();
  let session: any;
  await run({
    apiKey: 'secret', tools: defaultTools(), socketFactory: FakeSocket.factory, metrics,
    prefetch: { jev, mode: 'on', toolThreshold: 0.8, goodbyeThreshold: 0.9, routeThreshold: 0.6 },
    fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, 'live_m1'); }
  }, async url => { assert.equal((await post(url)).status, 200); });
  assert.match(session.instructions, /Ядро: пользователь прощается/);
  await tick();
  const socket = FakeSocket.instances[0]!;
  socket.message({ type: 'session.input_transcript.delta', delta: 'привет', start_ms: 0, end_ms: 400 });
  socket.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  const [file] = await metrics.load();
  assert.equal(file!.callId, 'live_m1');
  assert.equal(file!.config.backendModel, 'fake/model|fake/model');
  assert.equal(file!.config.jev, 'on');
  assert.equal(file!.config.delegation, 'client');
  assert.equal(file!.events[0]!.type, 'in');
});

test('without Jev Live gets no prefetch rule', async () => {
  let session: any;
  await run({ apiKey: 'secret', tools: defaultTools(), fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, null); } },
    async url => { assert.equal((await post(url)).status, 200); });
  assert.doesNotMatch(session.instructions, /Ядро: пользователь прощается/);
});

test('announced phone tools stay (through the device queue) and the core adds its web search only with WEB_SEARCH on', async () => {
  /** Инструменты, которые модель делегирования получила на первое делегирование звонка. */
  const delegatedTools = async (webSearch: boolean, headers: Record<string, string>) => {
    FakeSocket.reset();
    let session: any;
    let offered: string[] | null = null;
    const model = { model: 'fake/model', complete: async (_messages: any[], tools: any[]) => { offered ??= tools.map(t => t.function.name); return { content: 'ok', toolCalls: [], usage: { inTokens: null, outTokens: null } }; } };
    await run({ apiKey: 'secret', webSearch, tools: defaultTools(), socketFactory: FakeSocket.factory, clientDelegation: fakeDelegation(model),
      fetchImpl: async (_url, options: any) => { session = JSON.parse(options.body).session; return live(offer, 'live_d1'); }
    }, async url => { assert.equal((await post(url, offer, headers)).status, 200); });
    await tick();
    const socket = FakeSocket.instances[0]!;
    socket.message({ type: 'session.input_transcript.delta', delta: 'найди' });
    socket.message({ type: 'session.delegation.created', delegation: { id: 'item_c1', type: 'delegation', target: 'client' } });
    for (let i = 0; i < 200 && !offered; i++) await new Promise(resolve => setTimeout(resolve, 5));
    socket.close();
    return { session, offered: offered! as string[] };
  };
  const on = await delegatedTools(true, { 'X-Device-Tools': 'create_reminder' });
  assert.deepEqual(on.session.delegation, { type: 'client' });
  assert.ok(on.offered.includes('create_reminder'));
  assert.ok(!on.offered.includes('list_events'), 'only announced phone tools');
  assert.ok(on.offered.includes('web_search'));
  const off = await delegatedTools(false, {});
  assert.ok(!off.offered.includes('web_search'));
});
