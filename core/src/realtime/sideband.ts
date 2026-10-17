import type { Logger } from '../log.ts';
import { Conversation } from './conversation.ts';
import type { ToolRegistry } from '../assistant/tools/registry.ts';
import type { CallTrace } from '../telemetry/trace.ts';

/**
 * Sideband: WebSocket-подключение ядра к уже идущей GPT-Live-сессии (`/v1/live/sessions/{id}/attach`).
 * Звук по-прежнему идёт iPhone ↔ OpenAI напрямую; здесь транскрипты, делегирование и завершение звонка.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export const LIVE_SIDEBAND_URL = 'wss://api.openai.com/v1/live/sessions';

export interface SidebandOptions {
  apiKey: string;
  callId: string;
  tools: ToolRegistry;
  log: Logger;
  timeZone: string;
  socketFactory?: SocketFactory;
  /** Страховка на случай, если OpenAI не закроет соединение после звонка. */
  maxLifetimeMs?: number;
  now?: () => Date;
  /** Прощание: после `end_call` сессия закрывается через столько мс тишины в транскрипте Волны после её последней фразы… */
  farewellQuietMs?: number;
  /** …и не позже чем через столько мс после запроса, даже если Волна молчит или говорит без остановки. */
  farewellMaxMs?: number;
  /** Наблюдатель всех событий сессии (например, запись транскрипта). Исключения наблюдателя глотаются. */
  observer?: (message: unknown) => void;
  /** Вызывается один раз после закрытия соединения. */
  onClose?: () => void;
  /** Замеры звонка: время событий и отметки ядра. */
  trace?: CallTrace;
  /** Участники звонка, которым нужно не только слушать, но и действовать (предвыборка Jev). */
  listeners?: SidebandListener[];
  /** Всё, что ядро отправило в сессию (консоль ядра). Исключения глотаются. */
  onSend?: (event: unknown) => void;
}

/** Кто попросил положить трубку: модель делегирования инструментом `end_call` или предвыборка по прощанию пользователя. */
export type EndCallOrigin = 'tool' | 'prefetch';
/** Кто исполняет инструмент: Jev (быстрый путь) или модель клиентского делегирования. */
export type ToolOrigin = 'jev' | 'client';

/** Что sideband даёт участникам звонка. */
export interface SidebandControl {
  send(event: unknown): void;
  /** Исполнить инструмент ядра. Возвращает JSON-строку. */
  runTool(name: string, args: Record<string, unknown> | string, origin?: ToolOrigin): Promise<string>;
  endCall(origin: EndCallOrigin): void;
  /** Отменяет завершение, только если его запросил этот же источник и `end_call` его не подтвердил. */
  cancelEndCall(origin: EndCallOrigin): boolean;
}

export interface SidebandListener {
  attach?(control: SidebandControl): void;
  observe?(message: any): void;
  close?(): void;
}

export interface Sideband {
  close(): void;
  /** Разрешается, когда соединение закрыто (по любой причине). */
  closed: Promise<void>;
}

const defaultSocketFactory: SocketFactory = (url, headers) =>
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike)(url, { headers });

export function attachSideband(options: SidebandOptions): Sideband {
  const { apiKey, callId, tools, log, timeZone, socketFactory = defaultSocketFactory, maxLifetimeMs = 2 * 60 * 60 * 1000, now = () => new Date(), farewellQuietMs = 2000, farewellMaxMs = 8000, observer, onClose, trace, listeners = [], onSend } = options;
  const controller = new AbortController();
  const socket = socketFactory(`${LIVE_SIDEBAND_URL}/${encodeURIComponent(callId)}/attach`, { Authorization: `Bearer ${apiKey}` });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const lifetime = setTimeout(() => { log.warn('sideband lifetime exceeded', { callId }); socket.close(); }, maxLifetimeMs);

  const send = (event: unknown) => {
    try { socket.send(JSON.stringify(event)); } catch { return; /* сокет уже закрыт */ }
    try { onSend?.(event); } catch { /* консоль не должна ломать звонок */ }
  };

  // Завершение по инструменту end_call: даём Волне попрощаться, затем шлём session.close.
  // Телефон получит session.closed (close_requested) и завершит звонок штатно, как при обычном окончании.
  let farewell: { quiet: NodeJS.Timeout | null; max: NodeJS.Timeout; origin: EndCallOrigin } | null = null;
  const closeSession = () => {
    if (!farewell) return;
    if (farewell.quiet) clearTimeout(farewell.quiet);
    clearTimeout(farewell.max);
    farewell = null;
    log.info('session close requested', { callId });
    trace?.mark('session.close.sent');
    send({ type: 'session.close' });
  };
  const endCall = (origin: EndCallOrigin) => {
    if (controller.signal.aborted) return;
    if (farewell) {
      // `end_call` подтвердил прощание, которое раньше угадала предвыборка: отменять его больше нельзя.
      if (origin === 'tool' && farewell.origin === 'prefetch') { farewell.origin = 'tool'; trace?.mark('endcall.confirmed'); }
      return;
    }
    trace?.mark('endcall.armed', { origin });
    // Прощание, угаданное Jev, часто уже прозвучало к моменту взвода («До свидания» раньше ответа Jev): тишину считаем
    // сразу, иначе звонок висел до farewellMaxMs (звонок 22.09.2026, 8,7 с). После end_call прощание ещё впереди.
    const quiet = origin === 'prefetch' ? setTimeout(closeSession, farewellQuietMs) : null;
    farewell = { quiet, max: setTimeout(closeSession, farewellMaxMs), origin };
  };
  const cancelEndCall = (origin: EndCallOrigin) => {
    if (!farewell || farewell.origin !== origin) return false;
    if (farewell.quiet) clearTimeout(farewell.quiet);
    clearTimeout(farewell.max);
    farewell = null;
    trace?.mark('endcall.cancelled', { origin });
    return true;
  };
  const noteFarewellSpeech = () => {
    if (!farewell) return;
    if (farewell.quiet) clearTimeout(farewell.quiet);
    farewell.quiet = setTimeout(closeSession, farewellQuietMs);
  };

  // Инструменту иногда нужна стенограмма: перезвон проверяет, спрашивала ли Волна уже о его теме (callbacks/tools.ts).
  const conversation = new Conversation();
  const runTool = async (name: string, rawArguments: string, origin: ToolOrigin) => {
    trace?.mark('tool.start', { tool: name, origin });
    const output = await tools.call(name, rawArguments, { callId, signal: controller.signal, log, timeZone, now, endCall: () => endCall('tool'), turns: () => conversation.untilLastUser(6) });
    trace?.mark('tool.end', { tool: name, origin, ok: !output.startsWith('{"error"') });
    return output;
  };

  socket.addEventListener('open', () => {
    // Приветствие отсюда не просим: Live исполняет его только при идущем входном звуке, поэтому его шлёт телефон
    // после `session.started` по data channel (см. RealtimeClient.swift).
    log.info('sideband open', { callId });
  });
  const control: SidebandControl = {
    send,
    runTool: (name, args, origin = 'client') => runTool(name, typeof args === 'string' ? args : JSON.stringify(args), origin),
    endCall,
    cancelEndCall
  };
  for (const listener of listeners) {
    try { listener.attach?.(control); } catch { /* участник не должен ломать звонок */ }
  }

  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    try { trace?.observe(message); } catch { /* замеры не должны ломать звонок */ }
    try { observer?.(message); } catch { /* наблюдатель не должен ломать звонок */ }
    conversation.observe(message);
    for (const listener of listeners) {
      try { listener.observe?.(message); } catch { /* см. observer */ }
    }
    if (message?.type === 'error') {
      log.warn('live error', { callId, code: message.error?.code ?? null, kind: message.error?.type ?? null });
      return;
    }
    if (message?.type === 'session.closed') { sessionClosed = true; log.info('session closed', { callId, reason: message.reason ?? null }); return; }
    if (message?.type === 'session.output_transcript.delta') noteFarewellSpeech();
  });
  // 26.09.2026 каждый звонок, и удачный тоже, кончался так: `session.closed`, потом ошибка сокета, потом закрытие.
  // Ошибка после `session.closed` — обрыв уже закончившейся сессии, не сбой; код закрытия пишется, чтобы это проверить.
  let sessionClosed = false;
  const errorText = (event: any) => {
    const text = event?.message ?? event?.error?.message;
    return typeof text === 'string' ? text.slice(0, 120) : null;
  };
  socket.addEventListener('error', event => {
    if (sessionClosed) log.info('sideband dropped after session closed', { callId });
    else log.warn('sideband error', { callId, error: errorText(event) });
  });
  socket.addEventListener('close', (event: any) => {
    clearTimeout(lifetime);
    if (farewell) { if (farewell.quiet) clearTimeout(farewell.quiet); clearTimeout(farewell.max); farewell = null; }
    controller.abort();
    for (const listener of listeners) {
      try { listener.close?.(); } catch { /* см. observer */ }
    }
    log.info('sideband closed', { callId, code: typeof event?.code === 'number' ? event.code : null });
    try { onClose?.(); } catch { /* см. observer */ }
    resolveClosed();
  });

  return { close: () => socket.close(), closed };
}
