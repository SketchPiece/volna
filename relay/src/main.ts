import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exists, git, handle, type Call, type Deps, type Result } from './ops.ts';
import { HelmRpc } from '../../core/src/helm/rpc.ts';

/**
 * «Узел» (docs/relay.md): держит исходящую связь с ядром в облаке и исполняет его просьбы на этом Mac — запросы и команды
 * «Штурвала» (HTTP и его WebSocket-RPC), проверку папки и git-репозитория. Одно постоянное WebSocket-соединение `/relay/ws`: после открытия `hello` с версией и
 * состоянием T3, дальше ядро шлёт `call` и `ping`, «Узел» — `answer` и `pong`. Содержимое просьб и ответов не логируется.
 */
const VERSION = '0.4.2';
const env = (name: string) => process.env[name]?.trim() ?? '';
const core = env('CORE_URL').replace(/\/+$/, '');
const token = env('RELAY_TOKEN');
// С 0.3.0 исполнитель — «Штурвал» (форк T3 Code), с 0.4.0 на его протоколе 2 (docs/relay.md, 2.1); T3_TOKEN читается для старых .env.
const t3Token = env('HELM_TOKEN') || env('T3_TOKEN');
/** Папка данных «Штурвала»: здесь `userdata/server-runtime.json` с его адресом. */
const home = env('HELM_HOME').replace(/^~(?=\/|$)/, homedir()) || join(homedir(), '.helm');
for (const [name, value] of [['CORE_URL', core], ['RELAY_TOKEN', token], ['HELM_TOKEN', t3Token]] as const) {
  if (!value) { console.error(`Set ${name} in relay/.env (see .env.example).`); process.exit(1); }
}
if (!core.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(core)) {
  console.error('CORE_URL must be https (or http on localhost): the token travels in every request.');
  process.exit(1);
}

/** Адрес «Штурвала»: HELM_URL (или старый T3_URL) или `origin` из server-runtime.json, который он переписывает при каждом старте. */
async function t3Url(): Promise<string> {
  const fixed = env('HELM_URL') || env('T3_URL');
  if (fixed) return fixed.replace(/\/+$/, '');
  try {
    const runtime = JSON.parse(await readFile(join(home, 'userdata', 'server-runtime.json'), 'utf8')) as { origin?: unknown; port?: unknown };
    if (typeof runtime.origin === 'string') return runtime.origin.replace(/\/+$/, '');
    if (typeof runtime.port === 'number') return `http://127.0.0.1:${runtime.port}`;
  } catch { /* «Штурвал» ещё не запускался */ }
  return 'http://127.0.0.1:3783';
}

/** RPC-соединение с «Штурвалом» по его нынешнему адресу: после перезапуска на другом порту — новое. */
let helm: { url: string; rpc: HelmRpc } | null = null;
const rpc: Deps['rpc'] = async (method, payload, signal) => {
  const url = await t3Url();
  if (helm?.url !== url) { helm?.rpc.close(); helm = { url, rpc: new HelmRpc({ url, token: t3Token }) }; }
  return helm.rpc.call(method, payload, signal);
};

const deps: Deps = { t3Url, t3Token, fetch, rpc, git, exists };
const auth = { Authorization: `Bearer ${token}` };
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function t3State(): Promise<{ ok: boolean; version: string | null; reason: string | null }> {
  const result = await handle({ id: 'hello', op: 't3.request', method: 'GET', path: '/.well-known/t3/environment' }, deps);
  if (!result.ok) return { ok: false, version: null, reason: result.error };
  const { status, body } = result.data as { status: number; body: { serverVersion?: unknown } | null };
  if (status === 401 || status === 403) return { ok: false, version: null, reason: 't3_unauthorized' };
  const version = typeof body?.serverVersion === 'string' ? body.serverVersion : null;
  return { ok: status === 200 && Boolean(version), version, reason: status === 200 ? null : `t3_status_${status}` };
}

async function hello(): Promise<Record<string, unknown>> {
  return { type: 'hello', version: VERSION, t3: await t3State() };
}

/** Ядро ждёт ответ T3 15 с: всё, что дольше SLOW_MS, пишется в лог (без содержимого). */
const SLOW_MS = 3000;
/** Крупные ответы (снимок всех тредов, ~300 КБ JSON) идут двоичным кадром gzip. */
const GZIP_FROM = 16 * 1024;
/** Ядро пингует каждые 15 с; тишина дольше — соединение мёртвое, хотя сокет об этом не знает. */
const SILENCE_MS = 40_000;
/** Ответ, не отправленный из-за обрыва, ждёт нового соединения не дольше этого: потом ядро его уже не ждёт. */
const OUTBOX_MS = 60_000;

type Socket = WebSocket;
const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => Socket;

let socket: Socket | null = null;
const outbox: { at: number; data: string | Uint8Array }[] = [];

function send(data: string | Uint8Array): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(data);
  else outbox.push({ at: Date.now(), data });
}

async function answer(call: Call): Promise<void> {
  const started = Date.now();
  const result: Result = await handle(call, deps).catch(() => ({ ok: false, error: 'relay_error' }));
  if (!result.ok) log(`${call.op}: ${result.error}`);
  const json = JSON.stringify({ type: 'answer', id: call.id, result });
  send(json.length > GZIP_FROM ? gzipSync(json) : json);
  if (Date.now() - started > SLOW_MS) log(`slow ${call.op}: ${Date.now() - started} ms`);
}

/** Одно соединение: открывается, живёт, пока ядро на связи, и завершается при обрыве или тишине. */
async function connect(): Promise<boolean> {
  const url = `${core.replace(/^http/, 'ws')}/relay/ws`;
  const ws = new Socket(url, { headers: auth });
  ws.binaryType = 'arraybuffer';
  let opened = false;
  let heard = Date.now();
  await new Promise<void>(resolve => {
    const watchdog = setInterval(() => { if (Date.now() - heard > SILENCE_MS) ws.close(); }, 5000);
    ws.addEventListener('open', async () => {
      opened = true;
      heard = Date.now();
      socket = ws;
      const greeting = await hello();
      ws.send(JSON.stringify(greeting));
      for (const item of outbox.splice(0)) if (Date.now() - item.at < OUTBOX_MS) ws.send(item.data);
      const t3 = greeting.t3 as { ok: boolean; version: string | null; reason: string | null };
      log(`connected to ${core}; T3 ${t3.ok ? t3.version : t3.reason}`);
    });
    ws.addEventListener('message', event => {
      heard = Date.now();
      let message: { type?: unknown; call?: Call };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'ping') ws.send('{"type":"pong"}');
      // Просьбы исполняются параллельно: долгий git worktree не держит остальные.
      else if (message.type === 'call' && message.call) void answer(message.call);
    });
    ws.addEventListener('close', () => { clearInterval(watchdog); if (socket === ws) socket = null; resolve(); });
    ws.addEventListener('error', () => ws.close());
  });
  return opened;
}

let backoff = 1000;
let offlineLogged = false;
for (;;) {
  const opened = await connect();
  if (opened) { backoff = 1000; offlineLogged = false; }
  // Ядро перезапускается или нет сети. Не дольше 5 с: пока «Узла» нет, ядро держит просьбы до 20 с (RELAY_GRACE_MS).
  if (!offlineLogged) { log(`core ${opened ? 'connection lost' : 'unreachable'}; retrying`); offlineLogged = true; }
  await sleep(backoff);
  backoff = Math.min(backoff * 2, 5_000);
}
