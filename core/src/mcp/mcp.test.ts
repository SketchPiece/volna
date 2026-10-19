import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { run } from '../test-support.ts';
import { fakeHelm, thread, turn, activity, message } from '../helm/test-support.ts';
import { loadConfig } from '../config.ts';
import { Signer } from './tokens.ts';
import type { HelmMcpOptions } from './server.ts';
import { PasskeyStore } from './passkey.ts';
import { fakeAuthenticator, pageData } from './test-support.ts';

const PASSWORD = 'correct horse battery';
const SECRET = 'x'.repeat(40);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(50);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function helm() {
  const t3 = fakeHelm({ projects: [
    { id: 'p1', title: 'Волна', workspaceRoot: '/Users/me/Volna', defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } },
    { id: 'p2', title: 'Сайт', workspaceRoot: '/Users/me/Site', defaultModelSelection: null }
  ] });
  const add = (t: any) => { t3.threads.set(t.id, t); t3.shell.threads.push(t); return t; };
  add(thread('th-run', 'Починить звонок', { latestTurn: turn('running'), updatedAt: '2026-10-14T10:00:00Z', messages: [message('m1', 'Смотрю логи')] }));
  add(thread('th-done', 'Старое', { latestTurn: turn('completed'), updatedAt: '2026-10-13T10:00:00Z' }));
  add(thread('th-ask', 'Выбрать шрифт', {
    projectId: 'p2', latestTurn: turn('running'), updatedAt: '2026-10-14T09:00:00Z', hasPendingUserInput: true,
    activities: [activity('a1', 'user-input.requested', { requestId: 'rq1', questions: [{ id: 'q1', header: 'Шрифт', question: 'Какой шрифт?', options: [{ label: 'Inter' }, { label: 'Lora' }] }] })]
  }));
  return t3;
}

function options(t3: ReturnType<typeof fakeHelm>, patch: Partial<HelmMcpOptions> = {}): Omit<HelmMcpOptions, 'log'> {
  return { client: t3.client, signer: new Signer(SECRET), password: PASSWORD, passkeys: new PasskeyStore(), runtimeMode: 'auto', instance: 'claudeAgent', model: null, ...patch };
}

const j = async (response: Promise<Response>): Promise<any> => (await response).json();
const form = (body: Record<string, string>) => new URLSearchParams(body).toString();

const authenticators = new Map<string, ReturnType<typeof fakeAuthenticator>>();
const json = (url: string, path: string, body: object, origin = url) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });

/** Весь вход, как его проходит Claude: регистрация, пароль и создание пасскея в первый раз, дальше пасскей; код, токен. */
async function signIn(url: string): Promise<{ access: string; refresh: string; clientId: string }> {
  const registered = await j(fetch(`${url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }) }));
  const params = { client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 's1', response_type: 'code' };
  if (!authenticators.has(url)) authenticators.set(url, fakeAuthenticator());
  const key = authenticators.get(url)!;
  const login = pageData(await (await fetch(`${url}/authorize?${form(params)}`)).text());
  let answer: any;
  if (login) {
    answer = await j(json(url, login.endpoint, { ticket: login.ticket, ...key.get(login.options, url) }));
  } else {
    const approved = await fetch(`${url}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: url }, body: form({ ...params, password: PASSWORD }) });
    const create = pageData(await approved.text())!;
    assert.equal(create.mode, 'create');
    answer = await j(json(url, create.endpoint, { ticket: create.ticket, ...key.create(create.options, url) }));
  }
  const back = new URL(answer.redirect);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 's1');
  const tokens = await j(fetch(`${url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: registered.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }) }));
  return { access: tokens.access_token, refresh: tokens.refresh_token, clientId: registered.client_id };
}

let rpcId = 0;
async function rpc(url: string, token: string, method: string, params: object = {}) {
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  assert.equal(response.status, 200);
  return ((await response.json()) as any).result;
}
const call = async (url: string, token: string, name: string, args: object = {}) => {
  const result = await rpc(url, token, 'tools/call', { name, arguments: args });
  return { text: result.content[0].text as string, isError: Boolean(result.isError) };
};
const codeOf = (preview: string) => preview.match(/confirmation="([^"]+)"/)![1]!;

test('Claude signs in (password once, then passkey): metadata, registration, PKCE code, tokens, refresh', () => run({ mcp: options(helm()) }, async url => {
  const unauthorized = await fetch(`${url}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate')!, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const resource = await j(fetch(`${url}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(resource.resource, `${url}/mcp`);
  const server = await j(fetch(`${url}/.well-known/oauth-authorization-server`));
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.equal(server.registration_endpoint, `${url}/register`);

  const { access, refresh, clientId } = await signIn(url);
  assert.equal((await rpc(url, access, 'ping')).constructor, Object);
  // Клиент с Origin до /mcp доходит; платный /session браузерам по-прежнему закрыт.
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${access}`, Origin: 'https://claude.ai', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status, 200);
  assert.equal((await fetch(`${url}/session`, { method: 'POST', headers: { Origin: 'https://claude.ai' } })).status, 403);
  const renewed = await j(fetch(`${url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }) }));
  assert.ok(renewed.access_token);
  // Токен обновления не пускает в /mcp: виды токенов подписаны раздельно.
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${refresh}` }, body: '{}' })).status, 401);
}));

test('sign-in refuses a wrong password, a foreign form, a wrong PKCE verifier and a reused code', () => run({ mcp: options(helm()) }, async url => {
  const { client_id } = await j(fetch(`${url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
  const params = { client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', response_type: 'code' };
  const page = await fetch(`${url}/authorize?${form(params)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Owner password/);
  const post = (body: Record<string, string>, origin = url) => fetch(`${url}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: form(body) });
  assert.equal((await post({ ...params, password: 'wrong password!' })).status, 401);
  assert.equal((await post({ ...params, password: PASSWORD }, 'https://evil.test')).status, 403);
  assert.equal((await post({ ...params, redirect_uri: 'https://evil.test/cb', password: PASSWORD })).status, 400);
  const create = pageData(await (await post({ ...params, password: PASSWORD })).text())!;
  const key = fakeAuthenticator();
  const answer = await j(json(url, create.endpoint, { ticket: create.ticket, ...key.create(create.options, url) }));
  const code = new URL(answer.redirect).searchParams.get('code')!;
  const exchange = (verifier: string) => fetch(`${url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
  assert.equal((await exchange('w'.repeat(50))).status, 400);
  assert.equal((await exchange(VERIFIER)).status, 200);
  assert.equal((await exchange(VERIFIER)).status, 400);
  assert.equal((await fetch(`${url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.test/cb'] }) })).status, 400);
}));

test('the password works once: it creates the passkey, then only the passkey signs in', () => run({ mcp: options(helm()) }, async url => {
  const setup = await fetch(`${url}/passkey`);
  assert.match(await setup.text(), /Set up your passkey/);
  const passwordPost = (path: string, body: Record<string, string> = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: url }, body: form({ ...body, password: PASSWORD }) });
  const create = pageData(await (await passwordPost('/passkey')).text())!;
  assert.equal(create.options.rp.id, '127.0.0.1');
  assert.equal(create.options.authenticatorSelection.userVerification, 'required');
  const key = fakeAuthenticator();
  // Без проверки владельца (флаг UV), с чужого сайта или для другого домена пасскей не сохраняется.
  assert.equal((await json(url, create.endpoint, { ticket: create.ticket, ...key.create(create.options, url, { flags: 0x01 }) })).status, 400);
  const fresh = () => passwordPost('/passkey').then(r => r.text()).then(html => pageData(html)!);
  let next = await fresh();
  assert.equal((await json(url, next.endpoint, { ticket: next.ticket, ...key.create(next.options, url) }, 'https://evil.test')).status, 400);
  next = await fresh();
  assert.equal((await json(url, next.endpoint, { ticket: next.ticket, ...key.create(next.options, url, { rpId: 'evil.test' }) })).status, 400);
  next = await fresh();
  const saved = await j(json(url, next.endpoint, { ticket: next.ticket, ...key.create(next.options, url) }));
  assert.equal(saved.redirect, '/passkey');
  assert.match(await (await fetch(`${url}/passkey`)).text(), /You're set/);
  // Второй пасскей той же страницей и пароль больше не проходят.
  assert.equal((await json(url, create.endpoint, { ticket: create.ticket, ...fakeAuthenticator().create(create.options, url) })).status, 400);
  assert.equal((await passwordPost('/passkey')).status, 403);

  const { client_id } = await j(fetch(`${url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Codex', redirect_uris: [REDIRECT] }) }));
  const params = { client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 's2', response_type: 'code' };
  assert.equal((await passwordPost('/authorize', params)).status, 403);
  const html = await (await fetch(`${url}/authorize?${form(params)}`)).text();
  assert.doesNotMatch(html, /Owner password/);
  const login = pageData(html)!;
  assert.equal(login.mode, 'get');
  assert.deepEqual(login.options.allowCredentials, [{ type: 'public-key', id: key.id }]);
  // Чужой ключ, подпись не к тому вызову и повтор билета не пускают.
  const other = fakeAuthenticator();
  assert.equal((await json(url, login.endpoint, { ticket: login.ticket, ...other.get(login.options, url), id: key.id })).status, 401);
  const again = async () => pageData(await (await fetch(`${url}/authorize?${form(params)}`)).text())!;
  let attempt = await again();
  assert.equal((await json(url, attempt.endpoint, { ticket: attempt.ticket, ...key.get(attempt.options, url, { challenge: login.options.challenge }) })).status, 401);
  attempt = await again();
  const ok = await j(json(url, attempt.endpoint, { ticket: attempt.ticket, ...key.get(attempt.options, url) }));
  assert.equal(new URL(ok.redirect).searchParams.get('state'), 's2');
  assert.equal((await json(url, attempt.endpoint, { ticket: attempt.ticket, ...key.get(attempt.options, url) })).status, 400);
}));

test('a hardware key counter may not go back', () => run({ mcp: options(helm()) }, async url => {
  const key = fakeAuthenticator();
  authenticators.set(url, key);
  key.tick();
  await signIn(url);
  key.tick();
  await signIn(url);
  const { client_id } = await j(fetch(`${url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
  const params = { client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', response_type: 'code' };
  const login = pageData(await (await fetch(`${url}/authorize?${form(params)}`)).text())!;
  assert.equal((await json(url, login.endpoint, { ticket: login.ticket, ...key.get(login.options, url) })).status, 401);
}));

test('without Helm MCP configured there is no sign-in page and browsers are still refused', () => run({}, async url => {
  assert.equal((await fetch(`${url}/authorize`, { headers: { Origin: 'https://x.test' } })).status, 403);
  assert.equal((await fetch(`${url}/.well-known/oauth-authorization-server`)).status, 404);
}));

test('tools/list marks reads and writes, and the instructions demand verbatim words and an explicit yes', () => run({ mcp: options(helm()) }, async url => {
  const { access } = await signIn(url);
  const init = await rpc(url, access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.match(init.instructions, /verbatim/);
  assert.match(init.instructions, /explicitly agrees/);
  assert.match(init.instructions, /Unsettled threads are the default/);
  // Иконка «Штурвала» для коннектора: в serverInfo и как favicon, без входа и с Origin браузера.
  assert.equal(init.serverInfo.icons[0].src, `${url}/icon.png`);
  for (const path of ['/icon.png', '/favicon.ico']) {
    const icon = await fetch(`${url}${path}`, { headers: { Origin: 'https://claude.ai' } });
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(1, 4)], [0x50, 0x4e, 0x47]);
  }
  const { tools } = await rpc(url, access, 'tools/list');
  const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['helm_answer_question', 'helm_interrupt_thread', 'helm_list_projects', 'helm_list_questions', 'helm_list_threads', 'helm_list_unsettled_threads', 'helm_overview', 'helm_read_thread', 'helm_search_threads', 'helm_send_message', 'helm_settle_thread', 'helm_snooze_thread', 'helm_start_thread']);
  assert.equal(byName.helm_overview.annotations.readOnlyHint, true);
  assert.equal(byName.helm_send_message.annotations.readOnlyHint, false);
  assert.equal(byName.helm_interrupt_thread.annotations.destructiveHint, true);
  assert.deepEqual(byName.helm_send_message.inputSchema.required, ['threadId', 'message']);
  // Уведомление без id ответа не ждёт.
  const note = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
}));

test('overview, lists, search and reading show what is going on', () => run({ mcp: options(helm()) }, async url => {
  const { access } = await signIn(url);
  const overview = JSON.parse((await call(url, access, 'helm_overview')).text);
  assert.equal(overview.computer, 'online');
  assert.deepEqual(overview.projects.map((p: any) => [p.project, p.activeThreads.map((t: any) => t.threadId)]), [['Волна', ['th-run']], ['Сайт', ['th-ask']]]);
  assert.equal(overview.projects[1].activeThreads[0].waitingFor, 'answer');
  const all = JSON.parse((await call(url, access, 'helm_list_threads', { projectId: 'p1' })).text);
  assert.deepEqual(all.threads.map((t: any) => t.threadId), ['th-run', 'th-done']);
  assert.deepEqual(JSON.parse((await call(url, access, 'helm_search_threads', { query: 'звонок' })).text).map((t: any) => t.threadId), ['th-run']);
  const read = JSON.parse((await call(url, access, 'helm_read_thread', { threadId: 'th-run' })).text);
  assert.equal(read.thread.status, 'running');
  assert.equal(read.messages[0].text, 'Смотрю логи');
  const questions = JSON.parse((await call(url, access, 'helm_list_questions', { threadId: 'th-ask' })).text);
  assert.deepEqual(questions.questions[0].questions[0].options, ['Inter', 'Lora']);
  assert.equal((await call(url, access, 'helm_read_thread', { threadId: 'nope' })).isError, true);
}));

test('a message goes to the agent only after the confirmed second call, verbatim, once', () => {
  const t3 = helm();
  return run({ mcp: options(t3) }, async url => {
    const { access } = await signIn(url);
    const words = 'посмотри ещё раз логи, только без правок';
    const preview = await call(url, access, 'helm_send_message', { threadId: 'th-run', message: words });
    assert.match(preview.text, /NOT DONE YET/);
    assert.match(preview.text, /"Починить звонок" \(running\)/);
    assert.match(preview.text, /> посмотри ещё раз логи, только без правок/);
    assert.equal(t3.commands.length, 0);
    const code = codeOf(preview.text);
    // Другие аргументы с тем же кодом не проходят.
    assert.equal((await call(url, access, 'helm_send_message', { threadId: 'th-run', message: `${words}!`, confirmation: code })).isError, true);
    assert.equal((await call(url, access, 'helm_send_message', { threadId: 'th-run', message: words, confirmation: 'forged.code' })).isError, true);
    assert.equal(t3.commands.length, 0);
    assert.equal((await call(url, access, 'helm_send_message', { threadId: 'th-run', message: words, confirmation: code })).text, 'Sent.');
    assert.equal(t3.commands.length, 1);
    assert.equal(t3.commands[0].type, 'message.dispatch');
    assert.equal(t3.commands[0].text, words);
    assert.equal(t3.commands[0].threadId, 'th-run');
    assert.match((await call(url, access, 'helm_send_message', { threadId: 'th-run', message: words, confirmation: code })).text, /already used/);
    assert.equal(t3.commands.length, 1);
  });
});

test('starting a thread uses the project model and folder, stopping interrupts the running turn, answers map to options', () => {
  const t3 = helm();
  return run({ mcp: options(t3) }, async url => {
    const { access } = await signIn(url);
    const start = { projectId: 'p1', title: 'Логи', message: 'разберись с логами', planMode: true };
    const preview = await call(url, access, 'helm_start_thread', start);
    assert.match(preview.text, /in project "Волна" in plan mode/);
    const started = JSON.parse((await call(url, access, 'helm_start_thread', { ...start, confirmation: codeOf(preview.text) })).text);
    const launch = t3.commands.find(c => c.type === 'thread.launch');
    assert.equal(launch.threadId, started.threadId);
    assert.deepEqual(launch.modelSelection, { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    assert.deepEqual(launch.workspaceStrategy, { type: 'root' });
    assert.equal(launch.interactionMode, 'plan');
    assert.equal(launch.runtimeMode, 'auto');
    assert.equal(launch.initialMessage.text, 'разберись с логами');

    t3.threads.get('th-run').latestTurn = turn('running');
    const stop = await call(url, access, 'helm_interrupt_thread', { threadId: 'th-run' });
    assert.equal((await call(url, access, 'helm_interrupt_thread', { threadId: 'th-run', confirmation: codeOf(stop.text) })).text, 'Stopped.');
    assert.deepEqual(t3.commands.at(-1), { type: 'run.interrupt', threadId: 'th-run', runId: 't1', commandId: t3.commands.at(-1).commandId });

    const answer = { threadId: 'th-ask', requestId: 'rq1', answers: ['lora'] };
    const asked = await call(url, access, 'helm_answer_question', answer);
    assert.match(asked.text, /Какой шрифт\?\n> Lora/);
    assert.equal((await call(url, access, 'helm_answer_question', { ...answer, confirmation: codeOf(asked.text) })).text, 'Answered.');
    assert.deepEqual(t3.commands.at(-1).answers, { q1: 'Lora' });
    assert.equal((await call(url, access, 'helm_answer_question', { ...answer, requestId: 'gone' })).isError, true);
  });
});

test('settle and snooze move a thread in the list only after a yes, and the list shows it', () => {
  const t3 = helm();
  return run({ mcp: options(t3) }, async url => {
    const { access } = await signIn(url);
    const settle = await call(url, access, 'helm_settle_thread', { threadId: 'th-done' });
    assert.match(settle.text, /Settle thread "Старое"/);
    assert.equal(t3.commands.length, 0);
    assert.equal((await call(url, access, 'helm_settle_thread', { threadId: 'th-done', confirmation: codeOf(settle.text) })).text, 'Settled.');
    assert.deepEqual(t3.commands.at(-1), { type: 'thread.settle', threadId: 'th-done', commandId: t3.commands.at(-1).commandId });
    const back = await call(url, access, 'helm_settle_thread', { threadId: 'th-done', settled: false });
    await call(url, access, 'helm_settle_thread', { threadId: 'th-done', settled: false, confirmation: codeOf(back.text) });
    assert.equal(t3.commands.at(-1).type, 'thread.unsettle');
    assert.equal(t3.commands.at(-1).reason, 'user');

    const until = new Date(Date.now() + 86_400_000).toISOString().replace('Z', '+00:00');
    const snooze = await call(url, access, 'helm_snooze_thread', { threadId: 'th-done', until });
    assert.match(snooze.text, /Snooze thread "Старое" \(completed\) until/);
    assert.match((await call(url, access, 'helm_snooze_thread', { threadId: 'th-done', until, confirmation: codeOf(snooze.text) })).text, /Snoozed until/);
    assert.equal(t3.commands.at(-1).type, 'thread.snooze');
    assert.equal(Date.parse(t3.commands.at(-1).snoozedUntil), Date.parse(until));
    const wake = await call(url, access, 'helm_snooze_thread', { threadId: 'th-done' });
    assert.equal((await call(url, access, 'helm_snooze_thread', { threadId: 'th-done', confirmation: codeOf(wake.text) })).text, 'Woken.');
    assert.equal(t3.commands.at(-1).type, 'thread.unsnooze');
    assert.equal((await call(url, access, 'helm_snooze_thread', { threadId: 'th-done', until: '2020-01-01T00:00:00Z' })).isError, true);

    Object.assign(t3.threads.get('th-done'), { settledAt: '2026-10-14T11:00:00Z', snoozedUntil: until });
    const listed = JSON.parse((await call(url, access, 'helm_list_threads', { statuses: ['completed'] })).text).threads[0];
    assert.equal(listed.settled, true);
    assert.equal(listed.snoozedUntil, until);
  });
});

test('unsettled threads are listed apart from all threads; archived never', () => {
  const t3 = helm();
  Object.assign(t3.threads.get('th-done')!, { settledAt: '2026-10-14T11:00:00Z' });
  const archived = thread('th-old', 'В архиве', { latestTurn: turn('completed'), updatedAt: '2026-10-01T10:00:00Z', archivedAt: '2026-10-02T10:00:00Z' });
  t3.threads.set(archived.id, archived); t3.shell.threads.push(archived);
  return run({ mcp: options(t3) }, async url => {
    const { access } = await signIn(url);
    const ids = async (name: string, args: object = {}) => JSON.parse((await call(url, access, name, args)).text).threads.map((t: any) => t.threadId);
    assert.deepEqual(await ids('helm_list_unsettled_threads'), ['th-run', 'th-ask']);
    assert.deepEqual(await ids('helm_list_unsettled_threads', { projectId: 'p1' }), ['th-run']);
    assert.deepEqual(await ids('helm_list_threads'), ['th-run', 'th-ask', 'th-done']);
    // Вернули вручную в активные — снова среди неразобранных.
    Object.assign(t3.threads.get('th-done')!, { settledOverride: 'active' });
    assert.deepEqual(await ids('helm_list_unsettled_threads', { statuses: ['completed'] }), ['th-done']);
  });
});

test('unsettled threads are top-level and awake by default, as in the Helm app', () => {
  const t3 = helm();
  const add = (t: any) => { t3.threads.set(t.id, t); t3.shell.threads.push(t); };
  const lineage = (relationshipToParent: string) => ({ rootThreadId: 'th-run', parentThreadId: 'th-run', relationshipToParent });
  add(thread('th-sub', 'Субагент', { latestTurn: turn('completed'), updatedAt: '2026-10-14T08:00:00Z', lineage: lineage('subagent') }));
  add(thread('th-fork', 'Ответвление', { latestTurn: turn('completed'), updatedAt: '2026-10-14T07:00:00Z', lineage: lineage('fork') }));
  add(thread('th-nap', 'Отложен', { latestTurn: turn('completed'), updatedAt: '2026-10-14T06:00:00Z', snoozedUntil: new Date(Date.now() + 3600_000).toISOString() }));
  // Без lineage (старый «Штурвал») дочерний узнаётся по id.
  const legacy = thread('thread:delegated-task:x', 'Задача', { latestTurn: turn('completed'), updatedAt: '2026-10-14T05:00:00Z' });
  add(legacy);
  return run({ mcp: options(t3) }, async url => {
    const { access } = await signIn(url);
    const list = async (name: string, args: object = {}) => JSON.parse((await call(url, access, name, args)).text).threads;
    const ids = async (name: string, args: object = {}) => (await list(name, args)).map((t: any) => t.threadId);
    assert.deepEqual(await ids('helm_list_unsettled_threads'), ['th-run', 'th-ask', 'th-fork', 'th-done']);
    assert.deepEqual(await ids('helm_list_unsettled_threads', { includeSnoozed: true }), ['th-run', 'th-ask', 'th-fork', 'th-nap', 'th-done']);
    assert.deepEqual(await ids('helm_list_unsettled_threads', { includeChildren: true }), ['th-run', 'th-ask', 'th-sub', 'th-fork', 'thread:delegated-task:x', 'th-done']);
    assert.deepEqual(await ids('helm_list_threads'), ['th-run', 'th-ask', 'th-fork', 'th-nap', 'th-done']);
    const sub = (await list('helm_list_threads', { includeChildren: true })).find((t: any) => t.threadId === 'th-sub');
    assert.equal(sub.parentThreadId, 'th-run');
    assert.equal((await list('helm_list_unsettled_threads'))[0].parentThreadId, undefined);
  });
});

test('an offline computer is reported plainly and nothing is sent', () => {
  const t3 = helm();
  return run({ mcp: options(t3, { macOnline: () => false }) }, async url => {
    const { access } = await signIn(url);
    assert.equal(JSON.parse((await call(url, access, 'helm_overview')).text).computer, 'offline');
    t3.setOffline(true);
    const sent = await call(url, access, 'helm_send_message', { threadId: 'th-run', message: 'привет' });
    assert.equal(sent.isError, true);
    assert.match(sent.text, /not connected/);
  });
});

test('with client-side confirmation the write runs at once', () => {
  const t3 = helm();
  return run({ mcp: options(t3, { confirmWrites: false }) }, async url => {
    const { access } = await signIn(url);
    assert.equal((await call(url, access, 'helm_send_message', { threadId: 'th-run', message: 'да' })).text, 'Sent.');
    assert.equal(t3.commands.length, 1);
  });
});

test('Helm MCP config needs both a long password and a long secret', () => {
  const base = { BRIDGE_TOKEN: 't', HOST: '127.0.0.1' };
  assert.equal(loadConfig(base).mcp, null);
  assert.throws(() => loadConfig({ ...base, MCP_OWNER_PASSWORD: 'short', MCP_SIGNING_SECRET: SECRET }), /MCP_OWNER_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, MCP_OWNER_PASSWORD: PASSWORD }), /MCP_SIGNING_SECRET/);
  const config = loadConfig({ ...base, MCP_OWNER_PASSWORD: PASSWORD, MCP_SIGNING_SECRET: SECRET, RAILWAY_PUBLIC_DOMAIN: 'your-core.example.com' });
  assert.deepEqual(config.mcp, { password: PASSWORD, signingSecret: SECRET, publicUrl: 'https://your-core.example.com', confirmWrites: true });
});
