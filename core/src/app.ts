import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve, type ServerType } from '@hono/node-server';
import { consoleLogger, type Logger } from './log.ts';
import { ToolRegistry } from './assistant/tools/registry.ts';
import { defaultTools } from './assistant/tools/index.ts';
import { bearerAuth, noStore, rateLimit, rejectBrowsers, DEFAULT_LIMITS, type RateLimits } from './http/guards.ts';
import { sessionRoute, MAX_SDP_BYTES } from './http/session-route.ts';
import type { SocketFactory } from './realtime/sideband.ts';
import type { PersonaStore } from './persona/store.ts';
import type { MemoryService } from './memory/service.ts';
import { memoryRoutes } from './http/memory-routes.ts';
import type { SkillStore } from './skills/store.ts';
import type { TraceStore } from './telemetry/trace.ts';
import type { PrefetchSettings, ClientDelegationSettings } from './http/session-route.ts';
import { LiveCalls } from './realtime/live-calls.ts';
import { DeviceBroker } from './delegation/device-broker.ts';
import { deviceToolRoutes } from './http/device-tool-routes.ts';
import { pushRoutes } from './http/push-routes.ts';
import { taskRoutes } from './http/task-routes.ts';
import { workRoutes } from './http/work-routes.ts';
import type { WorkSync } from './work-sync/sync.ts';
import { callTitleRoutes } from './http/call-title-routes.ts';
import type { ChatModel } from './delegation/llm.ts';
import type { TaskStore } from './tasks/store.ts';
import type { CallbackStore } from './callbacks/store.ts';
import type { DeviceTokens } from './push/devices.ts';
import type { GreetingComposer } from './greeting/composer.ts';
import type { ConsoleHub } from './console/hub.ts';
import type { UsageMeter } from './usage/ledger.ts';
import type { Health } from './telemetry/health.ts';

export interface BridgeOptions {
  apiKey?: string;
  token?: string;
  model?: string;
  webSearch?: boolean;
  timeZone?: string;
  tools?: ToolRegistry;
  limits?: RateLimits;
  log?: Logger;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  memory?: MemoryService;
  /** Куда писать замеры звонков; без него замеры выключены. */
  metrics?: TraceStore;
  /** Предвыборка Jev; без неё звонок как раньше. */
  prefetch?: PrefetchSettings;
  /** Клиентское делегирование; без него `/session` отвечает 503. */
  clientDelegation?: ClientDelegationSettings;
  /** Общие с main: доставка итогов заданий пишет в идущие звонки. */
  liveCalls?: LiveCalls;
  /** Фоновые задания: итоги в начале звонка, перезвон Волны. */
  tasks?: TaskStore;
  /** Один список работы: задания Волны и треды «Штурвала» (work-sync/). Без него маршрута /work нет. */
  work?: WorkSync;
  /** Перезвоны по времени (callbacks/): напоминание в начале перезвона. */
  callbacks?: CallbackStore;
  /** Токены телефона для пушей; `apns`: есть ли ключ APNs. Без него маршрута /push нет. */
  push?: { devices: DeviceTokens; apns: boolean };
  /** Приветствие из набора фраз (greeting/composer.ts); без него запасное правило. */
  greeting?: GreetingComposer;
  /** Личный слой характера (persona/store.ts); без него только заводской характер. */
  persona?: PersonaStore;
  /** Техкарты в формате скиллов (skills/store.ts): список в инструкции бэкенда и экран «Память». */
  skills?: SkillStore;
  /** Консоль ядра (console/): отдельный HTTP-сервер на 127.0.0.1, здесь только участник звонков. */
  console?: ConsoleHub;
  /** Модель, что называет разговор для главного экрана (`/calls/title`); без неё маршрута нет, телефон берёт первую просьбу. */
  titleModel?: ChatModel;
  /** Учёт расходов (usage/): секунды звонка по цене минуты. */
  usage?: { meter: UsageMeter; pricePerMinute: number };
  /** Состояние служб для «Сводки» консоли. */
  health?: Health;
  /** Коммит, из которого собрано ядро (Railway задаёт `RAILWAY_GIT_COMMIT_SHA`); по нему CI проверяет, что выкатилась нужная версия. */
  commit?: string;
}

/** Собирает ядро: маршруты, защиту и зависимости. Один вызов на процесс; в тестах на каждый сценарий. */
export function createBridge(options: BridgeOptions = {}) {
  const {
    apiKey = '', token = '', model = 'gpt-live-1', webSearch = false,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    tools = defaultTools(), limits = DEFAULT_LIMITS, log = consoleLogger, fetchImpl = fetch, socketFactory, memory,
    metrics, prefetch, clientDelegation, tasks, work, callbacks, push, greeting, persona, skills, console: consoleHub, titleModel, usage, health, commit
  } = options;
  const liveCalls = options.liveCalls ?? new LiveCalls();
  // Инструменты телефона: ядро кладёт вызовы в очередь, телефон забирает их долгим опросом.
  const deviceBroker = clientDelegation ? new DeviceBroker() : undefined;
  // Музыка ожидания: опрос телефона узнаёт о начале и конце работы сразу, а не через 25 с.
  if (deviceBroker && tasks) tasks.subscribe(() => deviceBroker.notify());

  const app = new Hono();
  app.use(noStore, rejectBrowsers);
  app.notFound(c => c.json({ error: 'Not found.' }, 404));
  app.onError((error, c) => { log.warn('unhandled error', { error: error.name }); return c.json({ error: 'Internal error.' }, 500); });

  app.get('/health', c => c.json({ ready: Boolean(apiKey && clientDelegation), model, webSearch, tools: tools.names(), memory: memory ? memory.state.level : null, commit: commit ?? null }));

  app.post('/session',
    bearerAuth(token),
    rateLimit(limits),
    bodyLimit({ maxSize: MAX_SDP_BYTES, onError: c => c.json({ error: 'SDP too large.' }, 413) }),
    sessionRoute({ apiKey, model, webSearch, timeZone, tools, log, fetchImpl, socketFactory, sideband: true, memory, metrics, prefetch, clientDelegation, deviceBroker, liveCalls, tasks, work, callbacks, greeting, persona, skills, console: consoleHub, usage, health })
  );

  if (memory) app.route('/memory', memoryRoutes(memory, bearerAuth(token), persona, skills));
  if (deviceBroker) app.route('/device-tools', deviceToolRoutes({ broker: deviceBroker, auth: bearerAuth(token), working: () => tasks?.active.map(t => t.id) ?? [] }));
  if (tasks) app.route('/tasks', taskRoutes({ tasks, auth: bearerAuth(token) }));
  if (work) app.route('/work', workRoutes({ work, auth: bearerAuth(token) }));
  if (push) app.route('/push', pushRoutes({ devices: push.devices, auth: bearerAuth(token), configured: push.apns }));
  if (titleModel) {
    app.use('/calls/*', bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: 'Стенограмма слишком длинная.' }, 413) }));
    app.route('/calls', callTitleRoutes({ model: titleModel, auth: bearerAuth(token), log }));
  }

  return app;
}

export function listen(app: { fetch: Hono['fetch'] }, port: number, hostname: string): Promise<ServerType> {
  return new Promise(resolve => {
    const server = serve({ fetch: app.fetch, port, hostname }, () => resolve(server));
  });
}
