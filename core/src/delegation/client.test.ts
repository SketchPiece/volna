import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { attachSideband } from '../realtime/sideband.ts';
import { defineTool, ToolRegistry, type Tool } from '../assistant/tools/registry.ts';
import { currentTime } from '../assistant/tools/current-time.ts';
import { endCall } from '../assistant/tools/end-call.ts';
import { silentLogger } from '../log.ts';
import { FakeSocket } from '../test-support.ts';
import { CallTrace } from '../telemetry/trace.ts';
import { askCommentary, ClientDelegate, FAILURE_COMMENTARY, farewellCommentary, MODEL_HIDDEN, offerCommentary, similarCommentary, type ClientDelegateOptions } from './client.ts';
import type { RouteCard } from '../skills/routing.ts';
import { HONESTY_FALLBACK, HONESTY_RETRY, honestyFallback } from './honesty.ts';
import { chatModel, type ChatMessage, type ChatModel, type ChatResult, type ChatTool } from './llm.ts';
import type { DecisionModel, JevResponse } from '../jev/client.ts';
import { MISSING, type Tier } from '../jev/questions.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleStore } from '../schedules/store.ts';
import { ScheduleScheduler } from '../schedules/scheduler.ts';
import { scheduleTools } from '../schedules/tools.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const reply = (content: string): ChatResult => ({ content, toolCalls: [], usage: { inTokens: 1, outTokens: 1 } });
const call = (id: string, name: string, args: string): ChatResult => ({ content: null, toolCalls: [{ id, type: 'function', function: { name, arguments: args } }], usage: { inTokens: 1, outTokens: 1 } });

const note = defineTool({ name: 'note', effect: 'write', description: 'Saves a note.', parameters: z.object({ text: z.string() }), execute: ({ text }) => ({ saved: text }) });

type Step = (messages: ChatMessage[], tools: ChatTool[], signal: AbortSignal) => Promise<ChatResult> | ChatResult;

/** Три модели классов с общей очередью шагов: видно, какой класс отвечал и с какими инструментами. */
function fakeModels(llmSteps: Step[], seen: { model: string; messages: ChatMessage[]; tools: ChatTool[] }[]): Record<Tier, ChatModel> {
  let step = 0;
  const fake = (model: string): ChatModel => ({ model, complete: async (messages, tools, signal) => {
    seen.push({ model, messages: [...messages], tools });
    const next = llmSteps[step++];
    if (!next) throw new Error('unexpected model call');
    return next(messages, tools, signal);
  } });
  return { simple: fake('fake/simple'), standard: fake('fake/standard') };
}

const toolNames = (tools: ChatTool[]) => tools.map(t => t.function.name).sort();

/** Ответ Jev: быстрый инструмент, техкарта, класс, недостающее и согласие с вероятностями. */
function jevAnswers(route: { tool?: [string, number]; card?: [string, number]; tier?: [string, number]; missing?: [string, number]; agree?: number }, delayMs = 0): DecisionModel & { requests: any[] } {
  const requests: any[] = [];
  const choice = ([value, p]: [string, number]) => ({ type: 'choice' as const, choice: value, probabilities: { [value]: p }, confidence: p });
  return {
    requests,
    decide: async (request, signal) => {
      requests.push(request);
      if (delayMs) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delayMs); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('timeout', 'TimeoutError')); }); });
      const answers: Record<string, any> = {};
      if (route.tool) answers.tool = choice(route.tool);
      if (route.card) answers.techcard = choice(route.card);
      if (route.tier) answers.tier = choice(route.tier);
      if (route.missing && request.questions.missing) answers.missing = choice(route.missing);
      if (route.agree !== undefined && request.questions.agree) answers.agree = { type: 'noul', noul: route.agree };
      return { model: 'jev', answers } as JevResponse;
    }
  };
}

const card = (name: string, tools: string[], tier: RouteCard['tier'] = null, guide = ''): RouteCard => ({ name, title: name, when: `when ${name}`, tools, tier, guide });
const CARDS: RouteCard[] = [card('time', ['current_time'], 'simple'), card('memory', ['note'], null, 'Записывай коротко.')];

function setup(llmSteps: Step[], jev?: DecisionModel, options: { routeTimeoutMs?: number; firstRouteTimeoutMs?: number; extra?: Tool[]; cards?: RouteCard[]; instructions?: string | ((names: readonly string[]) => string); similarWork?: ClientDelegateOptions['similarWork']; hidden?: readonly string[] } = {}) {
  FakeSocket.reset();
  const seen: { model: string; messages: ChatMessage[]; tools: ChatTool[] }[] = [];
  const models = fakeModels(llmSteps, seen);
  const tools = new ToolRegistry([currentTime, endCall, note, ...(options.extra ?? [])]);
  const trace = new CallTrace({ callId: 'live_1', config: {} });
  const delegate = new ClientDelegate({
    models, tools, cards: options.cards ?? CARDS, instructions: options.instructions ?? 'Ты бэкенд.', routeTimeoutMs: options.routeTimeoutMs, firstRouteTimeoutMs: options.firstRouteTimeoutMs, timeZone: 'UTC', now: () => new Date('2026-09-22T10:00:00Z'), log: silentLogger, callId: 'live_1', trace,
    jev: jev ? { model: jev, threshold: 0.8, routeThreshold: 0.6 } : undefined, settleMs: 5, maxSettleMs: 20, similarWork: options.similarWork,
    // current_time здесь обычный читающий инструмент; скрытие проверяет отдельный тест.
    hidden: options.hidden ?? []
  });
  attachSideband({ apiKey: 'k', callId: 'live_1', tools, log: silentLogger, timeZone: 'UTC', socketFactory: FakeSocket.factory, trace, listeners: [delegate] });
  const socket = FakeSocket.instances[0]!;
  const commentary = () => socket.sent.filter((e: any) => e.type === 'session.commentary.append') as any[];
  const delegate_ = (id = 'item_c1') => socket.message({ type: 'session.delegation.created', delegation: { id, type: 'delegation', target: 'client' } });
  return { socket, seen, commentary, delegate: delegate_, trace };
}

test('the core answers a client delegation with the model reply, built from the transcript up to the user\'s last words', async () => {
  const { socket, seen, commentary, delegate } = setup([() => reply('Семь на восемь будет пятьдесят шесть.')]);
  socket.message({ type: 'session.output_transcript.delta', delta: 'Слушаю' });
  socket.message({ type: 'session.input_transcript.delta', delta: 'сколько будет семь на восемь' });
  delegate();
  socket.message({ type: 'session.output_transcript.delta', delta: 'Сейчас посчитаю' });
  await wait(60);
  assert.deepEqual(commentary(), [{ type: 'session.commentary.append', delegation_id: 'item_c1', content: 'Семь на восемь будет пятьдесят шесть.' }]);
  const messages = seen[0]!.messages;
  assert.equal(messages[0]!.role, 'system');
  assert.match((messages[0] as any).content, /Сейчас: .*2026/);
  assert.match((messages[0] as any).content, /Напоминаний, календаря и контактов сейчас нет/);
  assert.match((messages[0] as any).content, /Никогда не сообщай, что что-то сделал/);
  assert.deepEqual(messages.slice(1), [{ role: 'assistant', content: 'Слушаю' }, { role: 'user', content: 'сколько будет семь на восемь' }], 'the filler after the question is not context');
  assert.equal(seen[0]!.model, 'fake/standard', 'without Jev: the standard tier');
  assert.deepEqual(toolNames(seen[0]!.tools), ['current_time', 'end_call', 'note'], 'all tools; standard is the top tier, nothing to escalate to');
  socket.close();
});

test('tool calls run in the core and their results go back to the model until it answers', async () => {
  const { socket, seen, commentary, delegate, trace } = setup([
    () => call('t1', 'note', '{"text":"купить хлеб"}'),
    () => reply('Записал: купить хлеб.')
  ]);
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши купить хлеб' });
  delegate();
  await wait(60);
  assert.equal(commentary()[0].content, 'Записал: купить хлеб.');
  const second = seen[1]!.messages;
  assert.deepEqual(second.at(-1), { role: 'tool', tool_call_id: 't1', content: '{"saved":"купить хлеб"}' });
  assert.ok(trace.events.some(e => e.type === 'tool.start' && e.origin === 'client' && e.tool === 'note'));
  assert.ok(trace.events.some(e => e.type === 'client.commentary.sent' && e.path === 'llm'));
  socket.close();
});

test('a confident Jev answers simple tools without the model', async () => {
  const { socket, seen, commentary, delegate, trace } = setup([], jevAnswers({ tool: ['current_time', 0.97], card: ['time', 0.9], tier: ['simple', 0.9] }));
  socket.message({ type: 'session.input_transcript.delta', delta: 'который час' });
  delegate();
  await wait(60);
  assert.equal(commentary().length, 1);
  assert.match(commentary()[0].content, /current_time.*"iso":"2026/s);
  assert.equal(seen.length, 0, 'no model call');
  assert.ok(trace.events.some(e => e.type === 'client.commentary.sent' && e.path === 'jev'));
  socket.close();
});

test('one Jev request asks for the fast tool, the techcard and the tier', async () => {
  const jev = jevAnswers({ tool: ['none', 0.9], card: ['none', 0.9], tier: ['simple', 0.9] });
  const { socket, delegate } = setup([() => reply('Пятьдесят шесть.')], jev);
  socket.message({ type: 'session.input_transcript.delta', delta: 'семь на восемь' });
  delegate();
  await wait(60);
  const questions = jev.requests[0].questions;
  assert.deepEqual(Object.keys(questions).sort(), ['techcard', 'tier', 'tool'], 'no missing question without a simple card that changes data; no agree without an offer');
  assert.deepEqual(Object.keys(questions.tool.criteria).sort(), ['current_time', 'none']);
  assert.deepEqual(Object.keys(questions.techcard.criteria).sort(), ['memory', 'mixed', 'none', 'time']);
  assert.equal(questions.techcard.criteria.memory, 'when memory');
  assert.deepEqual(Object.keys(questions.tier.criteria), ['simple', 'standard']);
  socket.close();
});

function macTool(started: unknown[]) {
  return defineTool({
    name: 'mac_do', effect: 'act', description: 'x',
    jev: { when: 'simple Mac task', verbatim: { arg: 'task', title: 'title' }, threshold: 0.9 },
    parameters: z.object({ title: z.string(), task: z.string() }),
    execute: args => { started.push(args); return { started: true, say: 'Сделаю на маке.' }; }
  });
}

test('a simple Mac task starts from the user\'s own words without a model; a complex one goes to the model', async () => {
  const started: any[] = [];
  const simple = setup([], jevAnswers({ tool: ['mac_do', 0.97], card: ['none', 0.98], tier: ['simple', 0.9] }), { extra: [macTool(started)] });
  simple.socket.message({ type: 'session.input_transcript.delta', delta: 'Привет' });
  simple.socket.message({ type: 'session.output_transcript.delta', delta: 'Слушаю.' });
  simple.socket.message({ type: 'session.input_transcript.delta', delta: 'Открой на маке калькулятор и посчитай 5 умножить на 24' });
  simple.delegate();
  await wait(60);
  assert.equal(simple.seen.length, 0, 'no model call');
  assert.equal(started[0].title, 'Открой на маке калькулятор и');
  assert.match(started[0].task, /дословно.*«Открой на маке калькулятор и посчитай 5 умножить на 24»/s);
  assert.match(started[0].task, /Перед этим в разговоре:\nПользователь: Привет\nВолна: Слушаю\./);
  assert.match(simple.commentary()[0].content, /Ядро само запустило.*Сделаю на маке/s);
  simple.socket.close();

  const complex = setup([() => reply('Давайте уточним: какие файлы и куда сложить?')],
    jevAnswers({ tool: ['mac_do', 0.97], card: ['none', 0.98], tier: ['standard', 0.8] }), { extra: [macTool(started)] });
  complex.socket.message({ type: 'session.input_transcript.delta', delta: 'разбери загрузки на маке по папкам и удали дубликаты' });
  complex.delegate();
  await wait(60);
  assert.equal(started.length, 1, 'a complex task is not started from raw words');
  assert.equal(complex.seen[0]!.model, 'fake/standard');
  complex.socket.close();

  const unsure = setup([() => reply('Уточните, пожалуйста.')],
    jevAnswers({ tool: ['mac_do', 0.85], card: ['none', 0.9], tier: ['simple', 0.9] }), { extra: [macTool(started)] });
  unsure.socket.message({ type: 'session.input_transcript.delta', delta: 'на маке открой' });
  unsure.delegate();
  await wait(60);
  assert.equal(started.length, 1, 'below the card\'s own threshold of 0.9 the model decides');
  unsure.socket.close();
});

test('an act tool gets a Jev card only with the user\'s own words', () => {
  assert.throws(() => defineTool({ name: 'x_act', effect: 'act', description: 'x', jev: { when: 'x' }, parameters: z.object({}), execute: () => ({}) }), /own words/);
});

test('the techcard tier is a floor: a standard card lifts a simple Jev tier, and the card text goes to the model', async () => {
  const { socket, seen, delegate, trace } = setup([() => reply('Ок.')],
    jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.98], tier: ['simple', 0.84] }), { cards: [card('memory', ['note'], 'standard', 'Записывай коротко.')] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'что я просил запомнить' });
  delegate();
  await wait(60);
  assert.equal(seen[0]!.model, 'fake/standard');
  assert.match((seen[0]!.messages[0] as any).content, /Техкарта «memory»:\nЗаписывай коротко\./);
  assert.ok(trace.events.some(e => e.type === 'client.route' && e.tier === 'standard' && e.card === 'memory'));
  socket.close();
});

test('the work card lifts a simple Jev tier to standard: offering work is not for the light model', async () => {
  const { socket, seen, delegate } = setup([() => reply('Ок.')],
    jevAnswers({ tool: ['none', 0.9], card: ['work', 0.92], tier: ['simple', 0.95] }), { cards: [card('work', ['note'], 'work')] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'посмотри пять последних файлов в загрузках' });
  delegate();
  await wait(60);
  assert.equal(seen[0]!.model, 'fake/standard');
  socket.close();
});

test('a card of owner rules only (no allowed-tools) routes with all tools, its rules and the standard floor', async () => {
  const { socket, seen, delegate, trace } = setup([() => reply('Ок.')],
    jevAnswers({ tool: ['none', 0.9], card: ['dev', 0.9], tier: ['simple', 0.9] }), { cards: [card('dev', [], 'standard', 'Правила владельца (важнее инструкций):\n1. Работать в проекте CallAssistant, код в отдельной ветке.')] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'поправь у себя код' });
  delegate();
  await wait(60);
  assert.equal(seen[0]!.model, 'fake/standard');
  assert.deepEqual(toolNames(seen[0]!.tools), ['current_time', 'end_call', 'note'], 'all tools of the call, not none');
  assert.match((seen[0]!.messages[0] as any).content, /Техкарта «dev»:[\s\S]*отдельной ветке/);
  assert.ok(trace.events.some(e => e.type === 'client.route' && e.card === 'dev'));
  socket.close();
});

test('the route picks the tier model and only the chosen techcard\'s tools; a simple change answers after one round (fill)', async () => {
  const { socket, seen, commentary, delegate, trace } = setup([() => call('t1', 'note', '{"text":"хлеб"}')],
    jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.8], tier: ['simple', 0.7] }));
  socket.message({ type: 'session.input_transcript.delta', delta: 'запомни хлеб' });
  delegate();
  await wait(60);
  assert.equal(seen.length, 1, 'no second round after a successful simple change');
  assert.equal(seen[0]!.model, 'fake/simple');
  assert.deepEqual(toolNames(seen[0]!.tools), ['end_call', 'escalate', 'note']);
  assert.match(commentary()[0].content, /^Сделано:\nnote: \{"saved":"хлеб"\}/);
  assert.ok(trace.events.some(e => e.type === 'client.route' && e.tier === 'simple' && e.card === 'memory' && e.model === 'fake/simple'));
  assert.ok(trace.events.some(e => e.type === 'client.commentary.sent' && e.path === 'fill'));
  socket.close();
});

test('a simple card that changes data asks Live for the missing detail without a model', async () => {
  const cards = [card('notes', ['note'], 'simple')];
  const jev = jevAnswers({ tool: ['none', 0.9], card: ['notes', 0.95], tier: ['simple', 0.9], missing: ['what', 0.93] });
  const { socket, seen, commentary, delegate } = setup([], jev, { cards });
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши' });
  delegate();
  await wait(60);
  assert.ok(jev.requests[0].questions.missing, 'the missing question is asked when a simple changing card exists');
  assert.deepEqual(commentary().map(c => c.content), [askCommentary(MISSING.what!.ask)]);
  assert.equal(seen.length, 0);
  socket.close();

  const unsure = setup([() => call('t1', 'note', '{"text":"хлеб"}')], jevAnswers({ tool: ['none', 0.9], card: ['notes', 0.95], tier: ['simple', 0.9], missing: ['what', 0.55] }), { cards });
  unsure.socket.message({ type: 'session.input_transcript.delta', delta: 'запиши хлеб' });
  unsure.delegate();
  await wait(60);
  assert.equal(unsure.seen.length, 1, 'an unsure answer does not stop the work');
  unsure.socket.close();
});

test('backend instructions are built for the tools the model sees on this pass', async () => {
  const asked: string[][] = [];
  const instructions = (names: readonly string[]) => { asked.push([...names]); return 'Ты бэкенд.'; };
  const { socket, seen, delegate } = setup([() => reply('Ок.')],
    jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.9], tier: ['simple', 0.9] }), { instructions });
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши хлеб' });
  delegate();
  await wait(60);
  assert.deepEqual(asked[0]!.filter(name => name !== 'escalate' && name !== 'offer_work').sort(), toolNames(seen[0]!.tools).filter(name => name !== 'escalate' && name !== 'offer_work').sort());
  assert.ok(!asked[0]!.includes('current_time'), 'rules for tools outside the techcard stay out of the prompt');
  socket.close();
});

test('escalate reopens all tools one tier up', async () => {
  const { socket, seen, commentary, delegate, trace } = setup([() => call('e1', 'escalate', '{}'), () => reply('Сейчас двенадцать.')],
    jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.9], tier: ['simple', 0.9] }));
  socket.message({ type: 'session.input_transcript.delta', delta: 'что-то сложное' });
  delegate();
  await wait(60);
  assert.deepEqual(seen.map(s => s.model), ['fake/simple', 'fake/standard']);
  assert.deepEqual(toolNames(seen[1]!.tools), ['current_time', 'end_call', 'note']);
  assert.deepEqual(commentary().map(c => c.content), ['Сейчас двенадцать.']);
  assert.ok(trace.events.some(e => e.type === 'client.escalate' && e.from === 'simple' && e.to === 'standard' && e.reason === 'escalate'));
  socket.close();
});

test('an unsure Jev routes to the standard tier, a late or failing one to the simple tier; both with all tools', async () => {
  for (const [jev, model] of [
    [jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.4], tier: ['standard', 0.5] }), 'fake/standard'],
    [jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.9], tier: ['simple', 0.9] }, 200), 'fake/simple'],
    [{ decide: async () => { throw Object.assign(new Error('x'), { status: 500 }); } } as DecisionModel, 'fake/simple']
  ] as const) {
    const { socket, seen, delegate } = setup([() => reply('Ок.')], jev, { routeTimeoutMs: 40, firstRouteTimeoutMs: 40 });
    socket.message({ type: 'session.input_transcript.delta', delta: 'вопрос' });
    delegate();
    await wait(120);
    assert.equal(seen[0]!.model, model);
    assert.deepEqual(toolNames(seen[0]!.tools).filter(name => name !== 'escalate'), ['current_time', 'end_call', 'note']);
    socket.close();
  }
});

test('until Jev answers once in a call, the route waits longer', async () => {
  const jev = jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.9], tier: ['simple', 0.9] }, 80);
  const { socket, seen, delegate, trace } = setup([() => reply('Ок.'), () => reply('Ок.')], jev, { routeTimeoutMs: 40, firstRouteTimeoutMs: 200 });
  socket.message({ type: 'session.input_transcript.delta', delta: 'вопрос' });
  delegate();
  await wait(160);
  assert.ok(trace.events.some(e => e.type === 'jev.result'), 'the first route waits for a slow Jev');
  socket.message({ type: 'session.input_transcript.delta', delta: 'ещё вопрос' });
  delegate('item_c2');
  await wait(160);
  assert.equal(trace.events.filter(e => e.type === 'jev.error').length, 1, 'after that the short timeout applies');
  assert.equal(seen.length, 2);
  socket.close();
});

test('an unsure Jev leaves the answer to the model', async () => {
  const jev: DecisionModel = { decide: async () => ({ model: 'jev', answers: { tool: { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 } } }) as JevResponse };
  const { socket, commentary, delegate } = setup([async () => { await wait(20); return reply('Не знаю.'); }], jev);
  socket.message({ type: 'session.input_transcript.delta', delta: 'расскажи анекдот' });
  delegate();
  await wait(80);
  assert.deepEqual(commentary().map(c => c.content), ['Не знаю.']);
  socket.close();
});

test('a failing model at the top tier gives Live a short failure note instead of silence', async () => {
  const fail = () => { throw Object.assign(new Error('x'), { status: 503 }); };
  const { socket, seen, commentary, delegate, trace } = setup([fail]);
  socket.message({ type: 'session.input_transcript.delta', delta: 'что там' });
  delegate();
  await wait(60);
  assert.deepEqual(commentary().map(c => c.content), [FAILURE_COMMENTARY]);
  // С 23.09.2026 standard — верхний класс: со всеми инструментами подниматься некуда.
  assert.deepEqual(seen.map(s => s.model), ['fake/standard']);
  assert.deepEqual(toolNames(seen[0]!.tools), ['current_time', 'end_call', 'note'], 'the top tier cannot escalate');
  assert.ok(trace.events.some(e => e.type === 'client.error' && e.status === 503));
  socket.close();
});

test('a new delegation replaces an unfinished one; delegations for Responses are ignored', async () => {
  const { socket, commentary, delegate } = setup([
    (_m, _t, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    () => reply('Второй ответ.')
  ]);
  socket.message({ type: 'session.delegation.created', delegation: { id: 'item_r', target: 'responses' } });
  socket.message({ type: 'session.input_transcript.delta', delta: 'первое' });
  delegate('item_1');
  await wait(40);
  socket.message({ type: 'session.input_transcript.delta', delta: ' нет, второе' });
  delegate('item_2');
  await wait(60);
  assert.deepEqual(commentary().map(c => [c.delegation_id, c.content]), [['item_2', 'Второй ответ.']]);
  socket.close();
});

test('phone tools go to the phone through the device queue and come back to the model', async () => {
  FakeSocket.reset();
  const { DeviceBroker } = await import('./device-broker.ts');
  const { deviceTools } = await import('../assistant/tools/device.ts');
  const broker = new DeviceBroker();
  const calls: { messages: ChatMessage[] }[] = [];
  const models = fakeModels([() => call('d1', 'create_reminder', '{"title":"молоко"}'), () => reply('Поставил.')], calls as any);
  const tools = new ToolRegistry([currentTime, ...deviceTools]);
  const trace = new CallTrace({ callId: 'live_1', config: {} });
  const delegate = new ClientDelegate({ models, tools, instructions: 'b', timeZone: 'UTC', log: silentLogger, callId: 'live_1', trace, device: broker, settleMs: 5, maxSettleMs: 20 });
  attachSideband({ apiKey: 'k', callId: 'live_1', tools, log: silentLogger, timeZone: 'UTC', socketFactory: FakeSocket.factory, trace, listeners: [delegate] });
  const socket = FakeSocket.instances[0]!;
  socket.message({ type: 'session.input_transcript.delta', delta: 'напомни купить молоко' });
  socket.message({ type: 'session.delegation.created', delegation: { id: 'item_c1', target: 'client' } });
  const [relayed] = await broker.next(1000);
  assert.equal(relayed!.name, 'create_reminder');
  broker.answer(relayed!.id, '{"id":"r1","title":"молоко"}');
  await wait(30);
  assert.deepEqual(calls[1]!.messages.at(-1), { role: 'tool', tool_call_id: 'd1', content: '{"id":"r1","title":"молоко"}' });
  assert.equal((socket.sent.find((e: any) => e.type === 'session.commentary.append') as any).content, 'Поставил.');
  assert.ok(trace.events.some(e => e.type === 'tool.start' && e.origin === 'device'));
  socket.close();
});

test('a claimed action without a tool is sent back once; a repeated claim becomes an honest failure', async () => {
  const fixed = setup([() => reply('Поставил напоминание на завтра.'), () => reply('Не могу поставить напоминание: такого инструмента нет.')]);
  fixed.socket.message({ type: 'session.input_transcript.delta', delta: 'напомни завтра купить молоко' });
  fixed.delegate();
  await wait(60);
  assert.deepEqual(fixed.commentary().map(c => c.content), ['Не могу поставить напоминание: такого инструмента нет.']);
  assert.deepEqual(fixed.seen[1]!.messages.slice(-2), [{ role: 'assistant', content: 'Поставил напоминание на завтра.' }, { role: 'user', content: HONESTY_RETRY }]);
  assert.ok(fixed.trace.events.some(e => e.type === 'client.honesty'));
  fixed.socket.close();

  const stubborn = setup([() => reply('Записал.'), () => reply('Записал, всё готово.')]);
  stubborn.socket.message({ type: 'session.input_transcript.delta', delta: 'запиши' });
  stubborn.delegate();
  await wait(60);
  assert.deepEqual(stubborn.commentary().map(c => c.content), [HONESTY_FALLBACK]);
  stubborn.socket.close();
});

test('after any tool call the answer is not checked for claims: «меня сделал» after about_wave is not an action', async () => {
  const { socket, commentary, delegate, trace } = setup([() => call('t1', 'current_time', '{}'), () => reply('Меня сделал Андрей.')]);
  socket.message({ type: 'session.input_transcript.delta', delta: 'кто тебя сделал' });
  delegate();
  await wait(60);
  assert.deepEqual(commentary().map(c => c.content), ['Меня сделал Андрей.']);
  assert.ok(!trace.events.some(e => e.type === 'client.honesty'));
  socket.close();
});

/** Jev, который на маршрут не отвечает (маршрут по умолчанию), а на честность отвечает по очереди из `honesty`. */
function honestyJev(...honesty: (number | Error)[]): DecisionModel & { checks: any[] } {
  const checks: any[] = [];
  return {
    checks,
    decide: async request => {
      if (!request.questions.honesty) return { model: 'jev', answers: {} } as JevResponse;
      checks.push(request);
      const next = honesty.shift();
      if (next instanceof Error) throw next;
      return { model: 'jev', answers: { honesty: { type: 'noul', noul: next ?? 0 } } } as JevResponse;
    }
  };
}

test('with Jev a claim after only a reading tool is sent back: Jev sees the reply and every call', async () => {
  const jev = honestyJev(0.92, 0.05);
  const { socket, seen, commentary, delegate, trace } = setup([() => call('t1', 'current_time', '{}'), () => reply('Поставил напоминание на девять.'), () => reply('Не получилось поставить напоминание.')], jev);
  socket.message({ type: 'session.input_transcript.delta', delta: 'напомни завтра в девять позвонить маме' });
  delegate();
  await wait(80);
  assert.deepEqual(commentary().map(c => c.content), ['Не получилось поставить напоминание.']);
  assert.deepEqual(seen[2]!.messages.at(-1), { role: 'user', content: HONESTY_RETRY });
  assert.equal(jev.checks[0].state.reply, 'Поставил напоминание на девять.');
  assert.deepEqual(jev.checks[0].state.toolCalls, [{ tool: 'current_time', effect: 'read', ok: true }]);
  assert.ok(trace.events.some(e => e.type === 'client.honesty.check' && e.by === 'jev' && e.p === 0.92));
  assert.ok(trace.events.some(e => e.type === 'client.honesty'));
  socket.close();
});

test('with Jev an opinion or a plain answer does not wait for Jev, and a claim backed by a changing tool is not asked about', async () => {
  for (const text of ['Я считаю, лучше взять второй.', 'Сейчас десять часов утра.']) {
    const jev = honestyJev(0.9);
    const plain = setup([() => reply(text)], jev);
    plain.socket.message({ type: 'session.input_transcript.delta', delta: 'какой взять' });
    plain.delegate();
    await wait(60);
    assert.deepEqual(plain.commentary().map(c => c.content), [text]);
    assert.equal(jev.checks.length, 0, `no action words, no Jev: ${text}`);
    assert.ok(!plain.trace.events.some(e => e.type === 'client.honesty.check'));
    plain.socket.close();
  }

  const backed = honestyJev();
  const done = setup([() => call('t1', 'note', '{"text":"хлеб"}'), () => reply('Записал: хлеб.')], backed);
  done.socket.message({ type: 'session.input_transcript.delta', delta: 'запиши хлеб' });
  done.delegate();
  await wait(60);
  assert.equal(done.commentary().length, 1);
  assert.equal(backed.checks.length, 0, 'a successful changing call needs no check');
  done.socket.close();
});

test('with Jev a partial success is checked: one changing call worked, another failed', async () => {
  const send = defineTool({ name: 'send', effect: 'act', description: 'Sends.', parameters: z.object({}), execute: () => ({ error: 'offline' }) });
  const jev = honestyJev(0.9, 0.1);
  const { socket, commentary, delegate } = setup([
    () => ({ content: null, toolCalls: [{ id: 't1', type: 'function', function: { name: 'note', arguments: '{"text":"хлеб"}' } }, { id: 't2', type: 'function', function: { name: 'send', arguments: '{}' } }], usage: { inTokens: 1, outTokens: 1 } }),
    () => reply('Записал и отправил.'), () => reply('Записал, а отправить не получилось.')
  ], jev, { extra: [send] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши хлеб и отправь' });
  delegate();
  await wait(80);
  assert.equal(jev.checks.length, 2, 'the honest answer still has «Записал», so Jev sees it too and lets it pass');
  assert.deepEqual(jev.checks[0].state.toolCalls, [{ tool: 'note', effect: 'write', ok: true }, { tool: 'send', effect: 'act', ok: false }]);
  assert.deepEqual(commentary().map(c => c.content), ['Записал, а отправить не получилось.']);
  socket.close();
});

test('a repeated claim after a partial success names what worked instead of «nothing worked»', async () => {
  const send = defineTool({ name: 'send', effect: 'act', description: 'Sends.', parameters: z.object({}), execute: () => ({ error: 'offline' }) });
  const jev = honestyJev(0.9, 0.9);
  const { socket, commentary, delegate } = setup([
    () => ({ content: null, toolCalls: [{ id: 't1', type: 'function', function: { name: 'note', arguments: '{"text":"хлеб"}' } }, { id: 't2', type: 'function', function: { name: 'send', arguments: '{}' } }], usage: { inTokens: 1, outTokens: 1 } }),
    () => reply('Записал и отправил.'), () => reply('Записал и отправил, всё.')
  ], jev, { extra: [send] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши хлеб и отправь' });
  delegate();
  await wait(80);
  const [answer] = commentary().map(c => c.content);
  assert.notEqual(answer, HONESTY_FALLBACK);
  assert.equal(answer, honestyFallback([{ tool: 'note', effect: 'write', ok: true }, { tool: 'send', effect: 'act', ok: false }]));
  assert.match(answer, /^Бэкенд сделал только часть; остальное не получилось/);
  assert.doesNotMatch(answer, /\bnote\b/, 'tool names are not for the voice model');
  assert.doesNotMatch(answer, /хлеб/, 'tool arguments stay out');
  socket.close();
});

test('a failed changing call that then worked on retry is not a partial success: the claim is not checked', async () => {
  let attempts = 0;
  const flaky = defineTool({ name: 'send', effect: 'act', description: 'Sends.', parameters: z.object({}), execute: () => (++attempts === 1 ? { error: 'offline' } : { sent: true }) });
  const jev = honestyJev(0.9);
  const { socket, commentary, delegate } = setup([() => call('t1', 'send', '{}'), () => call('t2', 'send', '{}'), () => reply('Отправил.')], jev, { extra: [flaky] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'отправь' });
  delegate();
  await wait(80);
  assert.deepEqual(commentary().map(c => c.content), ['Отправил.']);
  assert.equal(jev.checks.length, 0);
  socket.close();
});

test('a new delegation during the honesty check aborts it quietly: no fallback for the old one', async () => {
  const jev: DecisionModel & { checks: number } = { checks: 0, decide: async (request, signal) => {
    if (!request.questions.honesty) return { model: 'jev', answers: {} } as JevResponse;
    jev.checks++;
    return new Promise<JevResponse>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  } };
  const { socket, commentary, delegate } = setup([() => reply('Записал.'), () => reply('Сейчас десять часов.')], jev, { routeTimeoutMs: 5000, firstRouteTimeoutMs: 5000 });
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши' });
  delegate('item_c1');
  await wait(60);
  assert.equal(jev.checks, 1, 'the first answer waits for Jev');
  socket.message({ type: 'session.input_transcript.delta', delta: 'а который час' });
  delegate('item_c2');
  await wait(80);
  assert.deepEqual(commentary().map(c => [c.delegation_id, c.content]), [['item_c2', 'Сейчас десять часов.']]);
  socket.close();
});

test('with no calls at all a doubtful Jev answer is enough to send the claim back', async () => {
  const jev = honestyJev(0.5, 0);
  const { socket, commentary, delegate } = setup([() => reply('Записал.'), () => reply('Записать не получилось.')], jev);
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши' });
  delegate();
  await wait(80);
  assert.deepEqual(commentary().map(c => c.content), ['Записать не получилось.']);
  socket.close();
});

test('a slow Jev does not hold the answer: after routeTimeoutMs the word rule decides', async () => {
  const slow: DecisionModel & { checks: any[] } = { checks: [], decide: async (request, signal) => {
    if (!request.questions.honesty) return { model: 'jev', answers: {} } as JevResponse;
    slow.checks.push(request);
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))));
    throw new Error('unreachable');
  } };
  const { socket, commentary, delegate, trace } = setup([() => reply('Записал.'), () => reply('Записать не получилось.')], slow, { routeTimeoutMs: 20, firstRouteTimeoutMs: 20 });
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши' });
  delegate();
  await wait(150);
  assert.deepEqual(commentary().map(c => c.content), ['Записать не получилось.']);
  assert.ok(trace.events.some(e => e.type === 'client.honesty.check' && e.by === 'words' && (e.ms as number) < 100));
  socket.close();
});

// Аудит 26.09.2026: проверка честности ждала Jev 800 мс даже в начале звонка, когда он отвечает дольше; маршрут ждёт до 2 с.
test('the honesty check waits for Jev as long as the route does: longer until Jev has answered once in this call', async () => {
  const late: DecisionModel & { checks: number } = { checks: 0, decide: async (request, signal) => {
    if (!request.questions.honesty) throw new Error('route down');
    late.checks++;
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 80); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('timeout', 'TimeoutError')); }); });
    return { model: 'jev', answers: { honesty: { type: 'noul', noul: 0.05 } } } as JevResponse;
  } };
  const { socket, commentary, delegate, trace } = setup([() => call('t1', 'current_time', '{}'), () => reply('Поставил напоминание.')], late, { routeTimeoutMs: 20, firstRouteTimeoutMs: 1000 });
  socket.message({ type: 'session.input_transcript.delta', delta: 'поставь напоминание' });
  delegate();
  await wait(250);
  assert.deepEqual(commentary().map(c => c.content), ['Поставил напоминание.'], 'Jev answered in 80 ms and let it pass');
  assert.ok(trace.events.some(e => e.type === 'client.honesty.check' && e.by === 'jev'));
  socket.close();
});

test('without Jev a claim after a failed changing call is sent back; after a reading call it is not', async () => {
  const send = defineTool({ name: 'send', effect: 'act', description: 'Sends.', parameters: z.object({}), execute: () => ({ error: 'offline' }) });
  const { socket, seen, commentary, delegate } = setup([() => call('t1', 'send', '{}'), () => reply('Отправил.'), () => reply('Отправить не получилось.')], undefined, { extra: [send] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'отправь' });
  delegate();
  await wait(80);
  assert.deepEqual(commentary().map(c => c.content), ['Отправить не получилось.']);
  assert.deepEqual(seen[2]!.messages.at(-1), { role: 'user', content: HONESTY_RETRY });
  socket.close();
});

test('when Jev fails the honesty check falls back to the word list', async () => {
  const jev = honestyJev(new Error('down'), new Error('down'));
  const { socket, commentary, delegate, trace } = setup([() => reply('Записал.'), () => reply('Записал, всё готово.')], jev);
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши' });
  delegate();
  await wait(80);
  assert.deepEqual(commentary().map(c => c.content), [HONESTY_FALLBACK]);
  assert.ok(trace.events.some(e => e.type === 'client.honesty.check' && e.by === 'words'));
  socket.close();
});

test('after end_call the core gives the farewell itself: one model round for «перезвони и пока»', async () => {
  const back = defineTool({ name: 'tasks_call_back', effect: 'write', description: 'x', parameters: z.object({}), execute: () => ({ callBack: true, running: 1 }) });
  const both = (): ChatResult => ({ content: null, toolCalls: [
    { id: 'c1', type: 'function', function: { name: 'tasks_call_back', arguments: '{}' } },
    { id: 'c2', type: 'function', function: { name: 'end_call', arguments: '{}' } }
  ], usage: { inTokens: 1, outTokens: 1 } });
  const { socket, seen, commentary, delegate } = setup([both], undefined, { extra: [back] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'пока, перезвони, как всё будет готово' });
  delegate();
  await wait(60);
  assert.equal(seen.length, 1, 'no extra model round for the farewell');
  assert.deepEqual(commentary().map(c => c.content), [farewellCommentary(true)]);
  socket.close();

  const plain = setup([() => call('e1', 'end_call', '{}')]);
  plain.socket.message({ type: 'session.input_transcript.delta', delta: 'всё, спасибо, пока' });
  plain.delegate();
  await wait(60);
  assert.deepEqual(plain.commentary().map(c => c.content), [farewellCommentary(false)]);
  plain.socket.close();
});

test('a claim backed by a successful changing tool passes', async () => {
  const { socket, commentary, delegate } = setup([() => call('t1', 'note', '{"text":"хлеб"}'), () => reply('Записал: хлеб.')]);
  socket.message({ type: 'session.input_transcript.delta', delta: 'запиши хлеб' });
  delegate();
  await wait(60);
  assert.deepEqual(commentary().map(c => c.content), ['Записал: хлеб.']);
  socket.close();
});

test('the chat model speaks the OpenAI-compatible protocol', async () => {
  let body: any;
  const model = chatModel({ apiKey: 'or', model: 'google/x', fetchImpl: async (_url, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'note', arguments: '{"text":"a"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } }, id: 'gen-1', provider: 'Azure' }));
  } });
  const result = await model.complete([{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'note', description: 'd', parameters: {} } }], new AbortController().signal);
  assert.equal(body.model, 'google/x');
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(result.toolCalls[0]!.function, { name: 'note', arguments: '{"text":"a"}' });
  assert.equal(result.usage.inTokens, 10);
  assert.equal(result.usage.reasoningTokens, 2);
  assert.equal(result.provider, 'Azure', 'the OpenRouter provider goes to the call trace: it shows which provider was slow');
  assert.equal(result.id, 'gen-1');
});

function workStart(started: unknown[]) {
  return defineTool({
    name: 'work_start', effect: 'act', startsWork: true, description: 'Background work.',
    parameters: z.object({ title: z.string().min(2), task: z.string().min(5) }),
    execute: args => { started.push(args); return { started: true, say: 'Принято, работаю.' }; }
  });
}
const OFFER_ARGS = JSON.stringify({ tool: 'work_start', arguments: { title: 'Тарифы', task: 'Сравни тарифы трёх операторов' }, summary: 'сравню тарифы трёх операторов' });

test('current_time is hidden from the model by default: the time is already in the instructions', async () => {
  const { socket, seen, delegate } = setup([() => reply('Сейчас двенадцать.')], undefined, { hidden: MODEL_HIDDEN });
  socket.message({ type: 'session.input_transcript.delta', delta: 'сколько будет семь на восемь' });
  delegate();
  await wait(60);
  assert.deepEqual(toolNames(seen[0]!.tools), ['end_call', 'note']);
  assert.match((seen[0]!.messages[0] as any).content, /Сейчас: .*2026/);
  socket.close();
});

test('a narrow card with work tools tells the model to offer work rather than escalate', async () => {
  const { socket, seen, delegate } = setup([() => call('o1', 'offer_work', OFFER_ARGS)], jevAnswers({ tool: ['none', 0.9], card: ['memory', 0.8], tier: ['simple', 0.7] }), { extra: [workStart([])] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'какие новости в тех индустрии' });
  delegate();
  await wait(60);
  assert.ok(toolNames(seen[0]!.tools).includes('escalate'));
  assert.match((seen[0]!.messages[0] as any).content, /интернет, файлы или компьютер, это работа: сразу вызывай offer_work, а не escalate/);
  socket.close();
});

test('big work is offered, not started; «да» starts exactly the offer without a model', async () => {
  const started: any[] = [];
  const jevFirst = jevAnswers({ tool: ['none', 0.9], card: ['mixed', 0.9], tier: ['standard', 0.9] });
  const jevAgree = jevAnswers({ tool: ['none', 0.9], card: ['none', 0.9], tier: ['simple', 0.9], agree: 0.95 });
  const jev: DecisionModel = { decide: (request, signal) => (request.questions.agree ? jevAgree : jevFirst).decide(request, signal) };
  const { socket, seen, commentary, delegate, trace } = setup([() => call('o1', 'offer_work', OFFER_ARGS)], jev, { extra: [workStart(started)] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'сравни тарифы операторов' });
  delegate('item_1');
  await wait(60);
  assert.ok(!toolNames(seen[0]!.tools).includes('work_start'), 'the model cannot start work itself');
  assert.ok(toolNames(seen[0]!.tools).includes('offer_work'));
  assert.deepEqual(commentary().map(c => c.content), [offerCommentary('сравню тарифы трёх операторов')]);
  assert.match(commentary()[0].content, /^План работы: сравню тарифы трёх операторов\. .*Не говори, что это большая/);
  assert.equal(started.length, 0);

  socket.message({ type: 'session.output_transcript.delta', delta: 'Сравню тарифы трёх операторов. Сделать?' });
  socket.message({ type: 'session.input_transcript.delta', delta: 'да' });
  delegate('item_2');
  await wait(60);
  assert.equal(seen.length, 1, 'no model call for the agreement');
  assert.deepEqual(started, [{ title: 'Тарифы', task: 'Сравни тарифы трёх операторов' }]);
  assert.match(commentary()[1].content, /согласился, ядро запустило.*Принято, работаю/s);
  assert.ok(trace.events.some(e => e.type === 'client.offer' && e.tool === 'work_start'));
  assert.ok(trace.events.some(e => e.type === 'client.offer.start'));
  socket.close();
});

// docs/task-sync.md, 7: смысловой дубль — ядро предлагает дописать в идущую работу, само ничего не сливает.
test('an offer like work already running asks whether to add it there instead of «Сделать?»', async () => {
  const started: any[] = [];
  const asked: unknown[] = [];
  const { socket, commentary, delegate, trace } = setup([() => call('o1', 'offer_work', OFFER_ARGS)], undefined, {
    extra: [workStart(started)],
    similarWork: (tool, args) => { asked.push([tool, args.title]); return { task: 'abc', thread: 'th', title: 'Сравнение тарифов', project: 'Волна: Работа' }; }
  });
  socket.message({ type: 'session.input_transcript.delta', delta: 'сравни тарифы операторов' });
  delegate('item_1');
  await wait(60);
  assert.deepEqual(asked, [['work_start', 'Тарифы']]);
  assert.equal(commentary()[0].content, offerCommentary('сравню тарифы трёх операторов') + similarCommentary({ task: 'abc', thread: 'th', title: 'Сравнение тарифов', project: 'Волна: Работа' }));
  assert.match(commentary()[0].content, /Похожая работа уже идёт: «Сравнение тарифов» в проекте Волна: Работа\..*work_add \(id задания abc\)/s);
  assert.equal(started.length, 0);
  assert.ok(trace.events.some(e => e.type === 'client.offer'));
  socket.close();
});

test('work that only looks starts at once, with a ban on changes; readOnly on other starters is still an offer', async () => {
  const started: any[] = [];
  const args = JSON.stringify({ tool: 'work_start', arguments: { title: 'Загрузки', task: 'Назови пять последних файлов в Загрузках' }, summary: 'назову пять последних файлов в загрузках', readOnly: true });
  const { socket, commentary, delegate, trace } = setup([() => call('o1', 'offer_work', args)], undefined, { extra: [workStart(started)] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'посмотри пять последних файлов в загрузках' });
  delegate();
  await wait(60);
  assert.equal(started.length, 1);
  assert.match(started[0].task, /^Назови пять последних файлов в Загрузках\n\nТолько посмотреть: ничего не создавай, не меняй/);
  assert.match(commentary()[0].content, /сразу запустило работу.*скажи коротко, что делаешь: назову пять последних файлов в загрузках; без вопроса/s);
  assert.ok(trace.events.some(e => e.type === 'client.offer.start' && e.readOnly === true));
  socket.close();

  const other: any[] = [];
  const thread = defineTool({ name: 'helm_thread_start', effect: 'act', startsWork: true, description: 'New agent thread.', parameters: z.object({ task: z.string() }), execute: a => { other.push(a); return { started: true }; } });
  const code = setup([() => call('o1', 'offer_work', JSON.stringify({ tool: 'helm_thread_start', arguments: { task: 'Посмотри код' }, summary: 'посмотрю код', readOnly: true }))], undefined, { extra: [thread] });
  code.socket.message({ type: 'session.input_transcript.delta', delta: 'посмотри код' });
  code.delegate();
  await wait(60);
  assert.equal(other.length, 0);
  assert.deepEqual(code.commentary().map(c => c.content), [offerCommentary('посмотрю код')]);
  code.socket.close();
});

test('work started in the call is shown to the model; a question followed by «Принято» is not Volna\'s question', async () => {
  const started: any[] = [];
  const again = JSON.stringify({ tool: 'work_start', arguments: { title: 'Загрузки', task: 'Назови пять последних файлов' }, summary: 'назову файлы', readOnly: true, agreed: true });
  const { socket, seen, commentary, delegate } = setup([() => call('o1', 'offer_work', again), () => reply('Хорошо, договорились.')], undefined, { extra: [workStart(started)] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'посмотри пять последних файлов в загрузках' });
  delegate('item_1');
  await wait(60);
  socket.message({ type: 'session.output_transcript.delta', delta: 'Проверю загрузки, сделать? Принято, работаю.' });
  socket.message({ type: 'session.input_transcript.delta', delta: 'перезвони, когда закончишь' });
  delegate('item_2');
  await wait(60);
  assert.equal(started.length, 1);
  assert.match((seen[1]!.messages[0] as any).content, /В этом звонке уже запущена работа: «Загрузки»\. Повторно её не запускай/);
  assert.equal(commentary()[1].content, 'Хорошо, договорились.');
  socket.close();
});

test('an offer with bad arguments goes back to the model; without Jev the model starts the offer after «да»', async () => {
  const started: any[] = [];
  const { socket, seen, commentary, delegate } = setup([
    () => call('o1', 'offer_work', JSON.stringify({ tool: 'work_start', arguments: { title: 'x' }, summary: 'что-то' })),
    () => call('o2', 'offer_work', OFFER_ARGS),
    () => call('s1', 'start_offered_work', '{}')
  ], undefined, { extra: [workStart(started)] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'сравни тарифы' });
  delegate('item_1');
  await wait(60);
  assert.match((seen[1]!.messages.at(-1) as any).content, /invalid_offer/);
  assert.match(commentary()[0].content, /спроси, делать ли/);
  socket.message({ type: 'session.input_transcript.delta', delta: 'да, давай' });
  delegate('item_2');
  await wait(60);
  assert.ok(toolNames(seen[2]!.tools).includes('start_offered_work'));
  assert.match((seen[2]!.messages[0] as any).content, /Волна предложила работу: «сравню тарифы трёх операторов»/);
  assert.equal(started.length, 1);
  socket.close();
});

test('offer_work shows the start tools\' schemas; «да» to Volna\'s own question starts the work at once, without a second question', async () => {
  const started: any[] = [];
  const agreed = JSON.stringify({ tool: 'work_start', arguments: { title: 'Тарифы', task: 'Сравни тарифы трёх операторов' }, summary: 'сравню тарифы', agreed: true });
  const { socket, seen, commentary, delegate, trace } = setup([
    () => call('o1', 'offer_work', JSON.stringify({ tool: 'work_start', arguments: { title: 'Тарифы' }, summary: 'сравню тарифы' })),
    () => call('o2', 'offer_work', agreed)
  ], undefined, { extra: [workStart(started)] });
  socket.message({ type: 'session.output_transcript.delta', delta: 'Сравнить тарифы трёх операторов в фоне?' });
  socket.message({ type: 'session.input_transcript.delta', delta: 'да, я разрешаю' });
  delegate('item_1');
  await wait(60);
  const offer = seen[0]!.tools.find(t => t.function.name === 'offer_work')!.function;
  assert.deepEqual((offer.parameters as any).properties.arguments.anyOf.map((a: any) => [a.title, Object.keys(a.properties).sort()]), [['work_start', ['task', 'title']]]);
  assert.match(offer.description, /work_start: Background work\./);
  assert.ok(trace.events.some(e => e.type === 'client.offer.invalid' && /task/.test(String(e.issues))), 'the rejected offer is traced with its schema issues');
  assert.deepEqual(started, [{ title: 'Тарифы', task: 'Сравни тарифы трёх операторов' }]);
  assert.match(commentary()[0].content, /согласился, ядро запустило/);
  socket.close();
});

test('agreed without Volna\'s question is only an offer', async () => {
  const started: any[] = [];
  const agreed = JSON.stringify({ tool: 'work_start', arguments: { title: 'Тарифы', task: 'Сравни тарифы трёх операторов' }, summary: 'сравню тарифы', agreed: true });
  const { socket, commentary, delegate } = setup([() => call('o1', 'offer_work', agreed)], undefined, { extra: [workStart(started)] });
  socket.message({ type: 'session.output_transcript.delta', delta: 'Слушаю.' });
  socket.message({ type: 'session.input_transcript.delta', delta: 'сравни тарифы' });
  delegate('item_1');
  await wait(60);
  assert.equal(started.length, 0);
  assert.match(commentary()[0].content, /спроси, делать ли/);
  socket.close();
});

test('a declined offer is forgotten: no agree question afterwards', async () => {
  const started: any[] = [];
  const requests: any[] = [];
  const jev = { decide: async (request: any) => {
    requests.push(request);
    const answers: Record<string, any> = { tier: { type: 'choice', choice: 'standard', probabilities: { standard: 0.9 } }, techcard: { type: 'choice', choice: 'mixed', probabilities: { mixed: 0.9 } } };
    if (request.questions.agree) answers.agree = { type: 'noul', noul: 0.05 };
    return { model: 'jev', answers };
  } } as DecisionModel;
  const { socket, delegate } = setup([() => call('o1', 'offer_work', OFFER_ARGS), () => reply('Хорошо, не буду.'), () => reply('Сейчас десять.')], jev, { extra: [workStart(started)] });
  socket.message({ type: 'session.input_transcript.delta', delta: 'сравни тарифы' });
  delegate('item_1');
  await wait(60);
  socket.message({ type: 'session.input_transcript.delta', delta: 'нет, не надо' });
  delegate('item_2');
  await wait(60);
  socket.message({ type: 'session.input_transcript.delta', delta: 'который час' });
  delegate('item_3');
  await wait(60);
  assert.deepEqual(requests.filter(r => !r.questions.honesty).map(r => Boolean(r.questions.agree)), [false, true, false]);
  assert.equal(started.length, 0);
  socket.close();
});

test('a repeating task is offered with «Сделать?» and recorded only after «да»; readOnly does not skip the question', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedules-'));
  const schedules = new ScheduleStore(dir);
  await schedules.load();
  const runs = new ScheduleScheduler({ store: schedules, timeZone: 'UTC', log: silentLogger, startWork: async () => ({ id: 't' }), isRunning: () => false });
  const args = { kind: 'work', title: 'Сводка по ИИ', task: 'Собери пять главных новостей по ИИ за сутки', time: '08:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  const { socket, seen, commentary, delegate } = setup([
    () => call('o1', 'offer_work', JSON.stringify({ tool: 'schedule_create', arguments: args, summary: 'каждый будний день в восемь утра соберу сводку новостей по ИИ', readOnly: true })),
    () => call('s1', 'start_offered_work', '{}')
  ], undefined, { extra: scheduleTools(schedules, runs, { canCall: false }) });
  socket.message({ type: 'session.input_transcript.delta', delta: 'каждое утро по будням присылай сводку новостей по ИИ' });
  // Запись расписания идёт на диск: под нагрузкой всего прогона 60 мс не хватало, ждём сам ответ.
  const answered = async (count: number) => { for (let i = 0; i < 100 && commentary().length < count; i++) await wait(20); };
  delegate('item_1');
  await answered(1);
  assert.ok(!toolNames(seen[0]!.tools).includes('schedule_create'), 'the model cannot create a schedule directly');
  assert.match(commentary()[0].content, /каждый будний день в восемь утра соберу сводку новостей по ИИ/);
  assert.equal(schedules.all.length, 0, 'nothing is recorded before «да», even with readOnly');
  socket.message({ type: 'session.input_transcript.delta', delta: 'да' });
  delegate('item_2');
  await answered(2);
  assert.equal(schedules.all.length, 1);
  assert.match(schedules.all[0]!.nextAt, /T08:00:00\.000Z$/);
  assert.match(commentary()[1].content, /Договорились: по будням в 08:00\. Первый раз /);
  runs.close();
  socket.close();
});
