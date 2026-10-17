import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { listen } from '../app.ts';
import { silentLogger } from '../log.ts';
import { RelayLink, type RelayCall } from '../relay/link.ts';
import { attachRelaySocket } from './relay-socket.ts';

type Message = { type: string; call?: RelayCall };
const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/** Ядро с сокетом «Узла» на случайном порту. */
async function core(link: RelayLink, exercise: (url: string, hellos: () => number) => Promise<void>, pingMs?: number) {
  const server = await listen(new Hono(), 0, '127.0.0.1');
  let hellos = 0;
  const socket = attachRelaySocket(server as any, { link, token: 'mac', log: silentLogger, onHello: () => hellos++, pingMs });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try { await exercise(`ws://127.0.0.1:${port}/relay/ws`, () => hellos); }
  finally {
    socket.close();
    if ('closeAllConnections' in server) (server as any).closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** Поддельный «Узел» по WebSocket: копит сообщения ядра, отдаёт их по одному. */
async function relay(url: string, token = 'mac') {
  const ws = new Socket(url, { headers: { Authorization: `Bearer ${token}` } });
  ws.binaryType = 'arraybuffer';
  const inbox: Message[] = [];
  const wakers: (() => void)[] = [];
  ws.addEventListener('message', event => { inbox.push(JSON.parse(String(event.data))); wakers.splice(0).forEach(w => w()); });
  const opened = await new Promise<boolean>(resolve => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
  });
  const next = async (type: string): Promise<Message> => {
    for (;;) {
      const index = inbox.findIndex(m => m.type === type);
      if (index >= 0) return inbox.splice(index, 1)[0]!;
      await new Promise<void>(resolve => wakers.push(resolve));
    }
  };
  const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve()));
  return { ws, opened, next, closed, send: (payload: unknown) => ws.send(JSON.stringify(payload)) };
}

const hello = { type: 'hello', version: '1', t3: { ok: true, version: '0.0.42', reason: null } };

test('relay socket: a wrong token is refused; after hello calls are pushed at once and answers resolve them, gzip too', async () => {
  const link = new RelayLink({ graceMs: 2000 });
  await core(link, async (url, hellos) => {
    assert.equal((await relay(url, 'phone')).opened, false);
    const mac = await relay(url);
    assert.equal(mac.opened, true);
    const early = link.call({ op: 'folder.exists', path: '/early' });
    mac.send(hello);
    const first = (await mac.next('call')).call!;
    assert.equal(first.op === 'folder.exists' && first.path, '/early', 'a call made before the socket waits and goes out after hello');
    assert.equal(hellos(), 1);
    mac.send({ type: 'answer', id: first.id, result: { ok: true, data: true } });
    assert.deepEqual(await early, { ok: true, data: true });
    const big = link.call({ op: 't3.request', method: 'GET', path: '/api/orchestration/shell' });
    const second = (await mac.next('call')).call!;
    const snapshot = { status: 200, body: { threads: Array.from({ length: 500 }, (_, i) => ({ id: `t${i}` })) } };
    mac.ws.send(gzipSync(JSON.stringify({ type: 'answer', id: second.id, result: { ok: true, data: snapshot } })));
    assert.deepEqual(await big, { ok: true, data: snapshot });
    mac.ws.close();
    await mac.closed;
  });
});

test('relay socket: pings keep it online; a closed socket makes calls wait for the next one; a new socket replaces the old', async () => {
  const link = new RelayLink({ graceMs: 2000 });
  await core(link, async url => {
    const a = await relay(url);
    a.send(hello);
    assert.equal((await a.next('ping')).type, 'ping');
    assert.equal(link.connected, true);
    a.ws.close();
    await a.closed;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(link.connected, false);
    const waiting = link.call({ op: 'folder.exists', path: '/later' });
    const b = await relay(url);
    b.send(hello);
    const call = (await b.next('call')).call!;
    b.send({ type: 'answer', id: call.id, result: { ok: true, data: false } });
    assert.deepEqual(await waiting, { ok: true, data: false });
    const c = await relay(url);
    c.send(hello);
    await b.closed;
    const next = link.call({ op: 'folder.exists', path: '/c' });
    const toC = (await c.next('call')).call!;
    c.send({ type: 'answer', id: toC.id, result: { ok: true, data: true } });
    assert.deepEqual(await next, { ok: true, data: true });
    c.ws.close();
    await c.closed;
  }, 30);
});
