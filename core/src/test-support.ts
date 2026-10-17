import { createBridge, listen, type BridgeOptions } from './app.ts';
import { silentLogger } from './log.ts';
import { ToolRegistry } from './assistant/tools/registry.ts';
import type { SocketFactory, SocketLike, SidebandControl, SidebandListener } from './realtime/sideband.ts';
import type { ChatModel, ChatResult } from './delegation/llm.ts';
import type { ClientDelegationSettings } from './http/session-route.ts';

export const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

/** Модель делегирования с заранее заданными ответами; после последнего повторяет его. */
export function scriptedModel(...results: ChatResult[]): ChatModel {
  let step = 0;
  return { model: 'fake/model', complete: async () => results[Math.min(step++, results.length - 1)] ?? { content: 'ok', toolCalls: [], usage: { inTokens: null, outTokens: null } } };
}

/** Делегирование, которое на всё отвечает «ok»: без него ядро не создаёт звонок. */
export const fakeDelegation = (model: ChatModel = scriptedModel()): ClientDelegationSettings => ({ models: { simple: model, standard: model }, search: model });

/** Поднимает ядро на случайном порту, чтобы проверять лимиты по реальному адресу сокета. */
export async function run(options: BridgeOptions, exercise: (url: string) => Promise<void>) {
  const app = createBridge({ log: silentLogger, tools: new ToolRegistry(), clientDelegation: fakeDelegation(), ...options });
  const server = await listen(app, 0, '127.0.0.1');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try { await exercise(`http://127.0.0.1:${port}`); }
  finally {
    if ('closeAllConnections' in server) (server as any).closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export const post = (url: string, body: string = offer, headers: Record<string, string> = {}) => fetch(`${url}/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/sdp', ...headers }, body
});

/** Поддельный WebSocket: помнит отправленное и позволяет тесту подать событие. */
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, ((event: any) => void)[]>();
  closedByUs = false;
  readonly url: string;
  readonly headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string>) { this.url = url; this.headers = headers; FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closedByUs = true; this.emit('close', {}); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  message(payload: unknown) { this.emit('message', { data: JSON.stringify(payload) }); }
  static factory: SocketFactory = (url, headers) => new FakeSocket(url, headers);
  static reset() { FakeSocket.instances = []; }
}

export const json = async (response: Response): Promise<any> => response.json();

/** Успешный ответ POST /v1/live/sessions: SDP-answer и id сессии. */
export const live = (sdp: string = offer, id: string | null = 'live_1') =>
  new Response(JSON.stringify({ session: id ? { id } : {}, transport: { type: 'webrtc', sdp } }), { status: 201, headers: { 'Content-Type': 'application/json' } });

/** Участник звонка, через которого тест зовёт инструменты ядра, как делегирование. */
export function toolCaller(): SidebandListener & { control: () => SidebandControl } {
  let control: SidebandControl | null = null;
  return { attach: c => { control = c; }, control: () => control! };
}

export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
