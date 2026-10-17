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
import { relayRoutes } from './http/relay-routes.ts';
import type { RelayLink } from './relay/link.ts';
import { pushRoutes } from './http/push-routes.ts';
import { helmRoutes } from './http/helm-routes.ts';
import type { HelmPush } from './helm/helm-push.ts';
import type { Transcriber } from './helm/transcribe.ts';
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
import { helmMcpRoutes, isHelmMcpPath, type HelmMcpOptions } from './mcp/server.ts';

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
  /** «Узел» на Mac (relay/link.ts): через него ядро в облаке ходит в «Штурвал». Свой токен; без него маршрута /relay нет. */
  relay?: { link: RelayLink; token: string; onHello?: () => void };
  /** Коммит, из которого собрано ядро (Railway задаёт `RAILWAY_GIT_COMMIT_SHA`); по нему CI проверяет, что выкатилась нужная версия. */
  commit?: string;
  /** Пуши «Штурвала» (docs/helm-push.md): токен сервера «Штурвала» и токен телефона; без них маршрута /helm нет. */
  helm?: { push: HelmPush; serverToken: string; deviceToken: string; transcribe?: Transcriber };
  /** Helm MCP для Claude владельца (docs/helm-mcp.md): OAuth и `/mcp`; без него этих маршрутов нет. */
  mcp?: Omit<HelmMcpOptions, 'log'>;
}

/** Собирает ядро: маршруты, защиту и зависимости. Один вызов на процесс; в тестах на каждый сценарий. */
export function createBridge(options: BridgeOptions = {}) {
  const {
    apiKey = '', token = '', model = 'gpt-live-1', webSearch = false,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    tools = defaultTools(), limits = DEFAULT_LIMITS, log = consoleLogger, fetchImpl = fetch, socketFactory, memory,
    metrics, prefetch, clientDelegation, tasks, work, callbacks, push, greeting, persona, skills, console: consoleHub, titleModel, usage, health, relay, commit, helm, mcp
  } = options;
  const liveCalls = options.liveCalls ?? new LiveCalls();
  // Инструменты телефона: ядро кладёт вызовы в очередь, телефон забирает их долгим опросом.
  const deviceBroker = clientDelegation ? new DeviceBroker() : undefined;
  // Музыка ожидания: опрос телефона узнаёт о начале и конце работы сразу, а не через 25 с.
  if (deviceBroker && tasks) tasks.subscribe(() => deviceBroker.notify());

  const app = new Hono();
  // Helm MCP: страница входа открывается в браузере владельца и шлёт форму с Origin (её Origin проверяет mcp/oauth.ts), а клиент
  // Claude может слать Origin на /mcp и /token. У этих путей своя авторизация, платного в них нет.
  app.use(noStore, async (c, next) => mcp && isHelmMcpPath(c.req.path) ? next() : rejectBrowsers(c, next));
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
  // Пустой токен в bearerAuth пускал бы всех: без RELAY_TOKEN маршрута нет (config.ts).
  if (relay?.token) app.route('/relay', relayRoutes({ link: relay.link, auth: bearerAuth(relay.token), log, onHello: relay.onHello }));
  if (helm?.serverToken && helm.deviceToken) app.route('/helm', helmRoutes({ push: helm.push, serverAuth: bearerAuth(helm.serverToken), deviceAuth: bearerAuth(helm.deviceToken), transcribe: helm.transcribe }));
  if (work) app.route('/work', workRoutes({ work, auth: bearerAuth(token) }));
  if (push) app.route('/push', pushRoutes({ devices: push.devices, auth: bearerAuth(token), configured: push.apns }));
  if (mcp) app.route('/', helmMcpRoutes({ ...mcp, log }));
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
