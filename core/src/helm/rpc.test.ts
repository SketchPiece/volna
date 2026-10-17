import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { HelmRpc, HelmRpcError } from './rpc.ts';

/** Сервер в форме `/ws` «Штурвала»: Effect RPC в JSON, один кадр — одно сообщение. */
async function helm(handler: (request: any) => object | null) {
  const wss = new WebSocketServer({ port: 0 });
  const seen: { url: string; auth: string | undefined; requests: any[] } = { url: '', auth: undefined, requests: [] };
  wss.on('connection', (socket, request) => {
    seen.url = request.url ?? '';
    seen.auth = request.headers.authorization;
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message._tag !== 'Request') return;
      seen.requests.push(message);
      const reply = handler(message);
      if (reply) socket.send(JSON.stringify(reply));
    });
  });
  await new Promise(resolve => wss.once('listening', resolve));
  const { port } = wss.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise(resolve => { for (const c of wss.clients) c.terminate(); wss.close(resolve); }) };
}

test('a request goes as Effect RPC JSON with the protocol in the URL and the token in the header; Exit answers it', async () => {
  const server = await helm(request => ({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: { sequence: 3 } } }));
  const rpc = new HelmRpc({ url: server.url, token: 'secret' });
  try {
    assert.deepEqual(await rpc.call('orchestration.dispatchCommand', { type: 'run.interrupt' }, AbortSignal.timeout(2000)), { sequence: 3 });
    assert.equal(server.seen.url, '/ws?orchestrationProtocol=2');
    assert.equal(server.seen.auth, 'Bearer secret');
    assert.deepEqual(server.seen.requests[0], { _tag: 'Request', id: '1', tag: 'orchestration.dispatchCommand', payload: { type: 'run.interrupt' }, headers: [] });
    // Второй запрос идёт по тому же соединению со своим id.
    await rpc.call('orchestration.launchThread', {}, AbortSignal.timeout(2000));
    assert.deepEqual(server.seen.requests.map(r => r.id), ['1', '2']);
  } finally { rpc.close(); await server.close(); }
});

test('a domain failure keeps its tag, a defect is a die, a closed server is offline', async () => {
  const server = await helm(request => request.tag === 'fail'
    ? { _tag: 'Exit', requestId: request.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'OrchestrationCommandRejectedError', message: 'no' } }] } }
    : { _tag: 'Exit', requestId: request.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Die', defect: 'boom' }] } });
  const rpc = new HelmRpc({ url: server.url, token: 't' });
  try {
    await assert.rejects(rpc.call('fail', {}, AbortSignal.timeout(2000)), (e: HelmRpcError) => e.kind === 'fail' && e.tag === 'OrchestrationCommandRejectedError');
    await assert.rejects(rpc.call('die', {}, AbortSignal.timeout(2000)), (e: HelmRpcError) => e.kind === 'die');
  } finally { rpc.close(); await server.close(); }
  await assert.rejects(new HelmRpc({ url: server.url, token: 't' }).call('x', {}, AbortSignal.timeout(2000)), (e: HelmRpcError) => e.kind === 'offline');
});

test('a dropped connection fails the waiting requests as offline, and the next call reconnects', async () => {
  let drop = true;
  const server = await helm(request => {
    if (drop) { drop = false; return null; }
    return { _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: 'ok' } };
  });
  const rpc = new HelmRpc({ url: server.url, token: 't' });
  try {
    const waiting = rpc.call('slow', {}, AbortSignal.timeout(2000));
    await new Promise(resolve => setTimeout(resolve, 50));
    rpc.close();
    await assert.rejects(waiting, (e: HelmRpcError) => e.kind === 'offline');
    assert.equal(await rpc.call('again', {}, AbortSignal.timeout(2000)), 'ok');
  } finally { rpc.close(); await server.close(); }
});
