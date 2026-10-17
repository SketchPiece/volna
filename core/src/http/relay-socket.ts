import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { RelayLink } from '../relay/link.ts';
import { answerSchema, helloSchema, MAX_BODY } from './relay-routes.ts';

/** Пинг ядра «Узлу»: и отметка «на связи» (RELAY_ONLINE_MS 45 с), и повод прокси Railway не закрывать тихое соединение. */
export const RELAY_PING_MS = 15_000;
export const RELAY_SOCKET_PATH = '/relay/ws';

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: helloSchema.shape.version, t3: helloSchema.shape.t3 }),
  z.object({ type: z.literal('answer'), id: z.string().regex(/^[0-9a-f]{32}$/), result: answerSchema }),
  z.object({ type: z.literal('pong') })
]);

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

/**
 * WebSocket «Узла» (docs/relay.md): одно постоянное соединение вместо долгого опроса `/relay`, чтобы каждый ответ не
 * открывал новое TLS-соединение (на домашней сети владельца это 1–10 с). Ядро шлёт `{type:'call', call}` и `{type:'ping'}`,
 * «Узел» — `hello`, `answer` и `pong`; крупные ответы — двоичным кадром gzip. Токен `RELAY_TOKEN` в заголовке Authorization.
 * Новое соединение вытесняет старое. Содержимое вызовов и ответов не логируется.
 */
export function attachRelaySocket(server: UpgradeServer, options: { link: RelayLink; token: string; log: Logger; onHello?: () => void; pingMs?: number }) {
  const { link, token, log, onHello, pingMs = RELAY_PING_MS } = options;
  const expected = Buffer.from(`Bearer ${token}`);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  let current: WebSocket | null = null;

  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://core').pathname !== RELAY_SOCKET_PATH) return;
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => accept(ws));
  });

  function accept(ws: WebSocket) {
    if (current) current.close(4000, 'replaced');
    current = ws;
    const send = (payload: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); };
    let detach: (() => void) | null = null;
    const ping = setInterval(() => send({ type: 'ping' }), pingMs);

    ws.on('message', (data: RawData, binary: boolean) => {
      const message = messageSchema.safeParse(parse(data, binary));
      if (!message.success) return;
      link.touch();
      switch (message.data.type) {
        case 'hello': {
          const first = !detach;
          link.greet({ version: message.data.version, t3: message.data.t3 });
          // Вызовы уходят только после hello: до него «Узел» не готов их принять.
          if (!detach) detach = link.attach(call => send({ type: 'call', call }));
          if (first) log.info('relay.connected', { version: message.data.version, t3: message.data.t3.ok ? message.data.t3.version : message.data.t3.reason, via: 'ws' });
          onHello?.();
          break;
        }
        case 'answer': link.answer(message.data.id, message.data.result); break;
        case 'pong': break;
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      detach?.();
      if (current === ws) current = null;
    });
    ws.on('error', () => ws.terminate());
  }

  return { close: () => { current?.terminate(); wss.close(); } };
}

function parse(data: RawData, binary: boolean): unknown {
  try {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    const text = binary ? gunzipSync(buffer, { maxOutputLength: MAX_BODY }).toString('utf8') : buffer.toString('utf8');
    return JSON.parse(text);
  } catch { return null; }
}
