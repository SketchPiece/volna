import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolRegistry } from '../assistant/tools/registry.ts';
import { silentLogger } from '../log.ts';
import { SkillStore } from '../skills/store.ts';
import { fingerprint, mcpEffect, mcpToolName, parseServers, substitute, toolPrefix } from './format.ts';
import { McpClient } from './mcp-client.ts';
import { mcpResult, startPlugins } from './runtime.ts';
import { findPlugins, PluginStore } from './store.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-mcp.mjs');
const temp = (name: string) => mkdtemp(join(tmpdir(), `volna-plugins-${name}-`));
const context = (signal = new AbortController().signal) => ({ callId: 'rtc_1', signal, log: silentLogger, timeZone: 'UTC', now: () => new Date() });

/** Плагин в формате Claude Code: plugin.json, техкарта, .mcp.json с поддельным сервером. */
async function writePlugin(root: string, name: string, { mcp, skill = true }: { mcp?: unknown; skill?: boolean } = {}): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, description: `${name} for tests`, version: '0.1.0' }));
  if (skill) {
    await mkdir(join(dir, 'skills', `${name}-mail`), { recursive: true });
    await writeFile(join(dir, 'skills', `${name}-mail`, 'SKILL.md'), `---\nname: ${name}-mail\ndescription: when the owner asks about mail\nallowed-tools: ${toolPrefix(name)}_*\n---\n\n# Mail\n`);
  }
  if (mcp !== undefined) await writeFile(join(dir, '.mcp.json'), JSON.stringify(mcp));
  return dir;
}

const fakeServer = (env: Record<string, string> = {}) => ({ mcpServers: { fake: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/../../fake.mjs'], env } } });

async function installed(name: string, mcp: unknown = fakeServer()): Promise<{ store: PluginStore; data: string }> {
  const source = await temp('src');
  const data = await temp('data');
  await writeFile(join(data, 'fake.mjs'), await readFile(FAKE, 'utf8'));
  const store = new PluginStore(join(data, 'plugins'));
  await store.install(await writePlugin(source, name, { mcp }));
  return { store, data };
}

test('tool names are sanitized, prefixed with the plugin and fit 64 characters', () => {
  assert.equal(mcpToolName('gmail', 'send_email'), 'gmail_send_email');
  assert.equal(mcpToolName('google-workspace', 'Gmail.Send Message!'), 'google_workspace_gmail_send_message');
  assert.equal(mcpToolName('1password', 'item-get'), 'p_1password_item_get');
  const long = mcpToolName('some-plugin', 'x'.repeat(80));
  const other = mcpToolName('some-plugin', `${'x'.repeat(79)}y`);
  assert.ok(long.length <= 64 && /^[a-z][a-z0-9_]*$/.test(long));
  assert.notEqual(long, other);
  assert.ok(mcpToolName('gmail', 'search').startsWith(`${toolPrefix('gmail')}_`));
});

test('effect follows MCP annotations; without destructiveHint: false a tool acts', () => {
  assert.equal(mcpEffect({ readOnlyHint: true }), 'read');
  assert.equal(mcpEffect({ readOnlyHint: false, destructiveHint: false }), 'write');
  assert.equal(mcpEffect({ destructiveHint: true }), 'act');
  assert.equal(mcpEffect(undefined), 'act');
});

test('variables: plugin root, defaults, missing names, core secrets never substituted', () => {
  const env = { TOKEN: 'abc', OPENAI_API_KEY: 'sk-secret' };
  assert.deepEqual(substitute('${CLAUDE_PLUGIN_ROOT}/x', env, '/p'), { value: '/p/x', missing: [] });
  assert.deepEqual(substitute('Bearer ${TOKEN}', env, '/p'), { value: 'Bearer abc', missing: [] });
  assert.deepEqual(substitute('${NOPE:-}', env, '/p'), { value: '', missing: [] });
  assert.deepEqual(substitute('${NOPE}', env, '/p'), { value: '', missing: ['NOPE'] });
  assert.deepEqual(substitute('${OPENAI_API_KEY}', env, '/p'), { value: '', missing: ['OPENAI_API_KEY'] });
});

test('.mcp.json in both forms; unsupported transports are skipped with a reason', () => {
  const wrapped = parseServers([{ mcpServers: { a: { command: 'bun', args: ['run'] }, b: { type: 'sse', url: 'https://x' } } }]);
  assert.deepEqual(wrapped.servers, [{ name: 'a', transport: 'stdio', command: 'bun', args: ['run'], env: {} }]);
  assert.deepEqual(wrapped.skipped, [{ name: 'b', reason: 'unsupported type sse' }]);
  const flat = parseServers([{ github: { type: 'http', url: 'https://api.example/mcp/', headers: { Authorization: 'Bearer ${T}' } } }]);
  assert.equal(flat.servers[0]!.transport, 'http');
  assert.equal(fingerprint([]), '');
});

test('store: a plugin with MCP servers installs disabled; enable approves the current config; a changed config needs enable again', async () => {
  const { store } = await installed('gmail');
  let plugin = (await store.get('gmail'))!;
  assert.equal(plugin.status, 'disabled');
  assert.deepEqual(plugin.skills, ['gmail-mail']);
  assert.deepEqual(await store.skillDirs(), []);

  plugin = (await store.enable('gmail'))!;
  assert.equal(plugin.status, 'enabled');
  assert.deepEqual(await store.skillDirs(), [plugin.skillsDir]);

  await writeFile(join(plugin.dir, '.mcp.json'), JSON.stringify({ fake: { command: 'sh', args: ['-c', 'curl evil'] } }));
  assert.equal((await store.get('gmail'))!.status, 'changed');
  assert.deepEqual(await store.skillDirs(), []);

  await store.enable('gmail');
  assert.equal((await store.disable('gmail'))!.status, 'disabled');
  await assert.rejects(store.install(plugin.dir), /already installed/);
  assert.equal(await store.remove('gmail'), true);
  assert.deepEqual(await store.list(), []);
});

test('store: a plugin without servers is enabled at once; a plugin without skills gets a generated tech card', async () => {
  const source = await temp('src');
  const store = new PluginStore(join(await temp('data'), 'plugins'));
  assert.equal((await store.install(await writePlugin(source, 'notes'))).status, 'enabled');
  const bare = await store.install(await writePlugin(source, 'context7', { skill: false, mcp: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } }));
  assert.deepEqual(bare.skills, ['context7']);
  assert.match(await readFile(join(bare.skillsDir, 'context7', 'SKILL.md'), 'utf8'), /allowed-tools: context7_\*/);
  assert.equal(bare.status, 'disabled');
  assert.deepEqual((await findPlugins(source)).map(dir => dir.split('/').at(-1)).sort(), ['context7', 'notes']);
});

test('skills of enabled plugins join the tech cards as source plugin and vanish when disabled', async () => {
  const { store, data } = await installed('gmail');
  const skills = new SkillStore({ ownerDir: join(data, 'skills'), pluginDirs: () => store.skillDirs() });
  assert.deepEqual(await skills.list(), []);
  await store.enable('gmail');
  const [card] = await skills.list();
  assert.equal(card!.source, 'plugin');
  assert.deepEqual(card!.tools, ['gmail_*']);
  await store.disable('gmail');
  assert.deepEqual(await skills.list(), []);
});

test('registry: allowed-tools wildcard picks a plugin\'s tools; a JSON Schema from MCP passes through', () => {
  const plain = (name: string) => defineTool({ name, description: name, effect: 'read', parameters: z.object({}), execute: () => ({}) });
  const mcp = { ...plain('gmail_search'), jsonSchema: { type: 'object', properties: { q: { type: 'string' } } } };
  const registry = new ToolRegistry([plain('current_time'), mcp, plain('gmail_send'), plain('gmailer_x')]);
  assert.deepEqual(registry.only(['gmail_*']).names(), ['gmail_search', 'gmail_send']);
  assert.deepEqual(registry.only(['*']).names(), []);
  assert.deepEqual(registry.only(['gmail_search']).definitions()[0]!.parameters, mcp.jsonSchema);
});

test('mcp result: text parts joined, structured content as JSON, server errors structured', () => {
  assert.deepEqual(mcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), { text: 'a\n[image]\nb' });
  assert.deepEqual(mcpResult({ content: [], structuredContent: { n: 1 } }), { text: '{"n":1}' });
  assert.deepEqual(mcpResult({ content: [{ type: 'text', text: 'boom' }], isError: true }), { error: 'tool_error', detail: 'boom' });
});

test('stdio MCP server of an enabled plugin: list, call, errors, cancel, isolated env, disable at runtime', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-must-not-leak';
  const { store } = await installed('gmail', fakeServer({ FAKE_TOKEN: '${GMAIL_TOKEN}', FAKE_ROOT: '${CLAUDE_PLUGIN_ROOT}' }));
  await store.enable('gmail');
  const runtime = await startPlugins({ store, log: silentLogger, env: { GMAIL_TOKEN: 'tok' }, taken: ['gmail_crash'] });
  try {
    const registry = new ToolRegistry(runtime.tools);
    assert.deepEqual(registry.names(), ['gmail_echo', 'gmail_fail', 'gmail_slow', 'gmail_env', 'gmail_cancelled']);
    assert.equal(registry.effectOf('gmail_echo'), 'read');
    assert.equal(registry.effectOf('gmail_fail'), 'write');
    assert.equal(registry.effectOf('gmail_slow'), 'act');
    const echo = registry.definitions().find(d => d.name === 'gmail_echo')!;
    assert.deepEqual(echo.parameters, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });

    assert.deepEqual(JSON.parse(await registry.call('gmail_echo', '{"text":"hi"}', context())), { text: 'echo: hi\nsecond part' });
    assert.deepEqual(JSON.parse(await registry.call('gmail_fail', '{}', context())), { error: 'tool_error', detail: 'mailbox not found' });
    const env = JSON.parse(JSON.parse(await registry.call('gmail_env', '{}', context())).text);
    assert.equal(env.openai, null);
    assert.equal(env.token, 'tok');
    assert.equal(env.root, (await store.get('gmail'))!.dir);

    const abort = new AbortController();
    const slow = registry.call('gmail_slow', '{}', context(abort.signal));
    setTimeout(() => abort.abort(), 50);
    assert.deepEqual(JSON.parse(await slow), { error: 'cancelled', plugin: 'gmail' });
    assert.equal(JSON.parse(JSON.parse(await registry.call('gmail_cancelled', '{}', context())).text).length, 1);

    await store.disable('gmail');
    assert.deepEqual(JSON.parse(await registry.call('gmail_echo', '{"text":"hi"}', context())), { error: 'plugin_disabled', plugin: 'gmail' });
  } finally {
    await runtime.stop();
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
});

test('a crashed server answers plugin_offline and restarts on the next call; disabled plugins and missing variables start nothing', async () => {
  const { store } = await installed('gmail');
  assert.equal((await startPlugins({ store, log: silentLogger })).connections.length, 0);
  await store.enable('gmail');
  const runtime = await startPlugins({ store, log: silentLogger });
  try {
    const registry = new ToolRegistry(runtime.tools);
    assert.deepEqual(JSON.parse(await registry.call('gmail_crash', '{}', context())), { error: 'plugin_offline', plugin: 'gmail' });
    // Следующий вызов поднимает сервер заново.
    assert.deepEqual(JSON.parse(await registry.call('gmail_echo', '{"text":"x"}', context())), { text: 'echo: x\nsecond part' });
  } finally {
    await runtime.stop();
  }
  const needsToken = await installed('mail', fakeServer({ T: '${MAIL_TOKEN}' }));
  await needsToken.store.enable('mail');
  const warned: string[] = [];
  const log = { info() {}, warn: (message: string, fields?: Record<string, unknown>) => { warned.push(`${message} ${JSON.stringify(fields)}`); } };
  assert.equal((await startPlugins({ store: needsToken.store, log, env: {} })).connections.length, 0);
  assert.match(warned.join('\n'), /plugin\.mcp_skipped.*MAIL_TOKEN/);
});

test('streamable HTTP: session id, SSE response, static headers', async () => {
  const seen: { auth?: string; session?: string; version?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined, version: req.headers['mcp-protocol-version'] as string | undefined });
    if (req.method === 'DELETE') return void res.writeHead(200).end();
    const message = JSON.parse(body);
    if (message.id === undefined) return void res.writeHead(202).end();
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' });
      return void res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const result = message.method === 'tools/list'
      ? { tools: [{ name: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
      : { content: [{ type: 'text', text: `found ${message.params.arguments.q}` }] };
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const client = await McpClient.connect({ transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer t' } });
    assert.deepEqual((await client.listTools()).map(tool => tool.name), ['search']);
    assert.deepEqual(await client.callTool('search', { q: 'mail' }), { content: [{ type: 'text', text: 'found mail' }] });
    await client.close();
    assert.ok(seen.every(request => request.auth === 'Bearer t'));
    assert.equal(seen[0]!.session, undefined);
    assert.ok(seen.slice(1).every(request => request.session === 's-1'));
    assert.equal(seen.at(-1)!.version, '2025-06-18');
  } finally {
    server.close();
  }
});
