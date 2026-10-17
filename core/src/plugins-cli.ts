import { join, relative, resolve } from 'node:path';
import { fetchSource } from './cli/fetch-source.ts';
import { loadConfig } from './config.ts';
import { silentLogger } from './log.ts';
import { PLUGIN_WORDS, variablesOf, type ServerConfig } from './plugins/format.ts';
import { McpConnection, mcpTool, MCP_CONNECT_TIMEOUT_MS, resolveServer } from './plugins/runtime.ts';
import { findPlugins, PluginStore, type Plugin } from './plugins/store.ts';

/**
 * `npm run plugins`: плагины ядра (формат плагинов Claude Code: техкарты и MCP-серверы, docs/skills.md).
 * `-- add <папка | git URL | github.com/…/tree/<ветка>/<путь>> [путь внутри] [--force]` ставит в data/plugins;
 * `-- enable <имя>` включает и одобряет MCP-серверы (только здесь, на Mac: голосом доступ не выдаётся);
 * `-- disable <имя>`, `-- remove <имя>`; `-- check <имя>` запускает серверы и показывает, какие инструменты получит ядро.
 * Техкарты включённого плагина видны со следующего звонка; MCP-серверы плагинов ядро Волны поднимает при старте, после enable нужен перезапуск.
 */
const config = loadConfig();
const store = new PluginStore(resolve(config.memoryDir, 'plugins'));
const args = process.argv.slice(2);
const force = args.includes('--force');
const [command = 'list', target, inside] = args.filter(arg => arg !== '--force');

if (command === 'add' && target) {
  const { dir, cleanup } = await fetchSource(target);
  try {
    const found = await findPlugins(inside ? join(dir, inside) : dir);
    if (found.length !== 1) {
      console.log(found.length ? `Found ${found.length} ${PLUGIN_WORDS.many}, pick one:\n${found.map(path => `  npm run plugins -- add ${target} ${relative(dir, path) || '.'}`).join('\n')}` : `No .claude-plugin/plugin.json in ${target}`);
      process.exitCode = 1;
    } else {
      const plugin = await store.install(found[0]!, { force });
      console.log(`Installed ${PLUGIN_WORDS.one} «${plugin.name}»${plugin.version ? ` ${plugin.version}` : ''}: ${plugin.description}`);
      print(plugin);
      if (plugin.status !== 'enabled') console.log(`It brings MCP servers (code that runs on this Mac or a remote service). Read them above, then:\n  npm run plugins -- enable ${plugin.name}`);
    }
  } finally {
    await cleanup();
  }
} else if (command === 'enable' && target) {
  const plugin = await store.enable(target);
  if (!plugin) missing(target);
  else {
    console.log(`Enabled «${plugin.name}».`);
    print(plugin);
    if (plugin.servers.length) console.log('Restart the core to start its MCP servers.');
  }
} else if (command === 'disable' && target) {
  const plugin = await store.disable(target);
  if (!plugin) missing(target);
  else console.log(`Disabled «${plugin.name}»: its tech cards are gone and its tools refuse from now on; servers stop on the next core restart.`);
} else if (command === 'remove' && target) {
  console.log(await store.remove(target) ? `Removed «${target}».` : `No ${PLUGIN_WORDS.one} «${target}».`);
} else if (command === 'check' && target) {
  const plugin = await store.get(target);
  if (!plugin) missing(target);
  else await check(plugin);
} else {
  const all = await store.list();
  if (!all.length) console.log(`No ${PLUGIN_WORDS.many} yet.`);
  for (const plugin of all) {
    console.log(`${plugin.name}${plugin.version ? ` ${plugin.version}` : ''} [${plugin.status}] — ${plugin.description}`);
    print(plugin, '  ');
  }
}

/** Что даёт плагин: техкарты, серверы (команда или адрес, имена переменных без значений), чего не хватает в core/.env. */
function print(plugin: Plugin, indent = '  '): void {
  if (plugin.skills.length) console.log(`${indent}tech cards: ${plugin.skills.join(', ')}`);
  for (const server of plugin.servers) {
    const vars = variablesOf(server);
    const unset = vars.filter(name => !process.env[name]);
    console.log(`${indent}MCP ${server.name}: ${describe(server)}${vars.length ? `; variables ${vars.join(', ')}` : ''}${unset.length ? ` (not set in core/.env: ${unset.join(', ')})` : ''}`);
  }
  for (const skipped of plugin.skipped) console.log(`${indent}MCP ${skipped.name}: skipped, ${skipped.reason}`);
  if (plugin.status === 'changed') console.log(`${indent}MCP config changed since it was enabled: npm run plugins -- enable ${plugin.name}`);
}

function describe(server: ServerConfig): string {
  if (server.transport === 'stdio') return `runs ${[server.command, ...server.args].join(' ')}`;
  return `connects to ${server.url.replace(/[?#].*$/, '')}`;
}

async function check(plugin: Plugin): Promise<void> {
  if (!plugin.servers.length) return void console.log(`«${plugin.name}» has no MCP servers.`);
  for (const server of plugin.servers) {
    const resolved = resolveServer(plugin, server, process.env);
    if ('missing' in resolved) { console.log(`MCP ${server.name}: set ${resolved.missing.join(', ')} in core/.env`); continue; }
    const connection = new McpConnection({ plugin: plugin.name, server: server.name, spec: resolved.spec, log: silentLogger });
    try {
      const tools = await (await connection.client(MCP_CONNECT_TIMEOUT_MS)).listTools();
      console.log(`MCP ${server.name}: ${tools.length} tools`);
      for (const tool of tools) {
        const server = mcpTool(connection, tool, store);
        console.log(`  ${server.name} [${server.effect}] — ${server.description.split('\n')[0]!.slice(0, 120)}`);
      }
    } catch (error) {
      console.log(`MCP ${server.name}: failed (${error instanceof Error ? error.message : 'unknown'})`);
      process.exitCode = 1;
    } finally {
      await connection.close();
    }
  }
}

function missing(name: string): void {
  console.log(`No ${PLUGIN_WORDS.one} «${name}». See npm run plugins`);
  process.exitCode = 1;
}
