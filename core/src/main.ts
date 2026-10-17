import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { createBridge, listen } from './app.ts';
import { defaultTools } from './assistant/tools/index.ts';
import { consoleLogger } from './log.ts';
import { MemoryStore } from './memory/store.ts';
import { MemoryService } from './memory/service.ts';
import { memoryTools } from './memory/tools.ts';
import { historyTools } from './memory/history.ts';
import { TraceStore } from './telemetry/trace.ts';
import { jevClient, JEV_PROVIDERS } from './jev/client.ts';
import { backendModel, chatModel } from './delegation/llm.ts';
import { readFile } from 'node:fs/promises';
import { LiveCalls } from './realtime/live-calls.ts';
import { TaskStore } from './tasks/store.ts';
import { TaskRunner } from './tasks/runner.ts';
import { TaskDelivery } from './tasks/delivery.ts';
import { resultSummarizer } from './tasks/summary.ts';
import { TaskProgress } from './tasks/progress.ts';
import { workTools } from './tasks/tools.ts';
import { CallbackStore } from './callbacks/store.ts';
import { CallbackScheduler } from './callbacks/scheduler.ts';
import { callbackTools } from './callbacks/tools.ts';
import { ScheduleStore } from './schedules/store.ts';
import { ScheduleScheduler } from './schedules/scheduler.ts';
import { scheduleTools } from './schedules/tools.ts';
import { DeviceTokens } from './push/devices.ts';
import { ApnsSender } from './push/apns.ts';
import { HelmPush } from './helm/helm-push.ts';
import { openAiTranscriber } from './helm/transcribe.ts';
import { GreetingComposer } from './greeting/composer.ts';
import { PersonaStore } from './persona/store.ts';
import { PersonaReviewer } from './persona/review.ts';
import { SkillStore } from './skills/store.ts';
import { techCardTools } from './skills/tools.ts';
import { techcardCreateTool } from './skills/create.ts';
import { PluginStore } from './plugins/store.ts';
import { startPlugins } from './plugins/runtime.ts';
import { ConsoleHub } from './console/hub.ts';
import { ConsoleStore } from './console/store.ts';
import { consoleApp, CONSOLE_HOST } from './console/routes.ts';
import { Dashboard } from './console/dashboard.ts';
import { Cached, openAiBill, openRouterBill } from './usage/billing.ts';
import { HelmClient } from './helm/client.ts';
import { newProjectModel, helmWorker } from './helm/worker.ts';
import { pickProject } from './helm/projects.ts';
import { helmTools } from './helm/tools.ts';
import { RelayLink, relayFetch, relayMac, relayRpc } from './relay/link.ts';
import { attachRelaySocket } from './http/relay-socket.ts';
import { Signer } from './mcp/tokens.ts';
import { WorkSync } from './work-sync/sync.ts';
import { UsageLedger } from './usage/ledger.ts';
import { Health } from './telemetry/health.ts';

const config = loadConfig();
// «Сводка» консоли: время запуска, последний старт звонка и предупреждения лога (telemetry/health.ts).
const health = new Health();
const log = health.logger(consoleLogger);
// Учёт расходов (usage/): каждый платный вызов — строка в MEMORY_DIR/usage/YYYY-MM.jsonl.
const ledger = new UsageLedger({ dir: resolve(config.memoryDir, 'usage'), log });
await ledger.load();
const store = new MemoryStore(resolve(config.memoryDir));
await store.load();
const extractor = { ...config.memory, timeZone: config.timeZone, log, meter: ledger };
// Личный слой характера: пересмотр после звонков, редко и осторожно (persona/review.ts).
const persona = new PersonaStore(resolve(config.memoryDir));
await persona.load();
const reviewer = config.personaReview ? new PersonaReviewer({ persona, memory: store, extractor, log: log }) : null;
const memory = new MemoryService({
  store, log: log, extractor,
  afterCall: reviewer ? () => reviewer.maybeReview() : undefined
});
// Техкарты — скиллы (docs/skills.md): встроенные в core/skills, свои и установленные в data/skills, из включённых плагинов.
const pluginStore = new PluginStore(resolve(config.memoryDir, 'plugins'));
const skills = new SkillStore({
  ownerDir: resolve(config.memoryDir, 'skills'), builtinDir: resolve(import.meta.dirname, '..', 'skills'),
  externalDirs: config.skillsExtraDirs, pluginDirs: () => pluginStore.skillDirs(), log: log
});
if (store.state.techCards.length) {
  const moved = await skills.migrate(store.state.techCards);
  await store.update(state => { state.techCards = []; });
  log.info('techcards.migrated', { moved });
}
// «Штурвал» (helm/, форк T3 Code): с HELM_TOKEN вся «Работа», и код тоже, идёт в него на этой машине. Ядро в облаке (RELAY_TOKEN)
// ходит в него через «Узел» на Mac (docs/relay.md): снимки, команды RPC и проверка папки исполняются там, токен не покидает Mac.
const relay = config.relay ? new RelayLink() : null;
const mac = relay ? relayMac(relay) : null;
const helm = config.helm ? new HelmClient({
  url: config.helm.url, token: config.helm.token,
  // Через «Узел» ответ идёт Mac → облако: 8 с мало при потерях в сети, опрос тредов всё равно ограничен 15 с.
  ...(relay ? { fetchImpl: relayFetch(relay), rpc: relayRpc(relay), timeoutMs: 15_000 } : {})
}) : null;
// Проекты «Штурвала» по словам пользователя: по умолчанию «Волна: Работа», новые — только новые пустые папки (helm/projects.ts).
const helmDirs = config.helm ? { defaultDir: config.helm.projectDir, defaultTitle: 'Волна: Работа', newDir: config.helm.newProjectsDir, model: newProjectModel(config.helm.instance, config.helm.model) } : null;
const baseTools = defaultTools([
  ...memoryTools(store),
  // «История»: прошлые звонки и задания; хранилище заданий появляется ниже, только со «Штурвалом».
  ...historyTools(store, () => taskStore),
  ...techCardTools(skills)
]);

// «Работа»: с 26.09.2026 задания делает только агент на Mac, с 05.10.2026 в «Штурвале» (docs/task-sync.md), итог звонком Волны или уведомлением.
// Без HELM_TOKEN и RELAY_TOKEN «Работы» нет (Пульт и его исполнитель удалены из ядра 27.09.2026).
const liveCalls = new LiveCalls();
const tc = helm ? config.tasks : null;
// Задание с тредом «Штурвала» переживает перезапуск ядра: работа в «Штурвале» идёт дальше, раннер снова за ней следит.
const taskStore = tc ? new TaskStore(resolve(config.memoryDir), { resumable: task => Boolean(task.helmThread) }) : undefined;
const devices = tc ? new DeviceTokens(resolve(config.memoryDir)) : undefined;
// Один список работы: задания Волны и собственные треды владельца в «Штурвале»; только читает «Штурвал» (docs/task-sync.md).
const work = helm ? new WorkSync({ client: helm, tasks: taskStore, log: log, announce: note => liveCalls.announce(note), inCall: () => liveCalls.count > 0 }) : undefined;
let tools = baseTools;
let apnsReady = false;
// work_stop в треде идущего задания отменяет само задание (helm/tools.ts).
let cancelTask: ((id: string) => Promise<boolean>) | undefined;
let callbackStore: CallbackStore | undefined;
if (tc && taskStore && devices && helm && config.helm) {
  await taskStore.load();
  await devices.load();
  const push = tc.apns ? new ApnsSender({ keyPem: await readFile(resolve(tc.apns.keyPath), 'utf8'), keyId: tc.apns.keyId, teamId: tc.apns.teamId, topic: tc.apns.topic, devices, log: log }) : undefined;
  apnsReady = Boolean(push);
  // Итог в звонок — одна-три фразы от дешёвой модели: длинный итог Live не принимает (tasks/summary.ts).
  const summarize = tc.apiKey ? resultSummarizer(chatModel({ apiKey: tc.apiKey, model: tc.progress?.model ?? config.clientDelegation?.models.simple ?? 'google/gemini-3.5-flash-lite', maxTokens: 160, meter: { ledger, purpose: 'task_summary' } })) : undefined;
  const delivery = new TaskDelivery({ store: taskStore, calls: liveCalls, push, log: log, summarize });
  // Сводки хода работы: дешёвая модель раз в TASK_PROGRESS_SECONDS, их читает tasks_list.
  const progress = tc.progress ? new TaskProgress({ store: taskStore, model: chatModel({ apiKey: tc.apiKey, model: tc.progress.model, maxTokens: 80, meter: { ledger, purpose: 'task_progress' } }), log: log, intervalMs: tc.progress.intervalMs }) : undefined;
  progress?.start();
  const runner = new TaskRunner({
    store: taskStore, log: log, progress, timeoutMs: config.helm.taskMaxMs,
    // Итоги приходят одной пачкой, когда закончатся все задания (tasks/delivery.ts).
    onFinished: task => delivery.deliver(task).then(() => {}), onCancelled: () => delivery.flush().then(() => {}),
    // Агент в треде «Штурвала»; вопросы агента и ожидание разрешений приходят заметкой в звонок (helm/worker.ts).
    worker: helmWorker({ client: helm, store: taskStore, projectDir: config.helm.projectDir, instance: config.helm.instance, model: config.helm.model, runtimeMode: config.helm.runtimeMode, stallMs: config.helm.stallMs, announce: note => liveCalls.announce(note) })
  });
  // Перезвон в назначенное время (callbacks/): только с ключом APNs, иначе звонок не придёт.
  let callbackScheduler: CallbackScheduler | undefined;
  if (push) {
    callbackStore = new CallbackStore(resolve(config.memoryDir));
    await callbackStore.load();
    callbackScheduler = new CallbackScheduler({ store: callbackStore, calls: liveCalls, push, log: log });
    callbackScheduler.arm();
    tools = tools.with(callbackTools(callbackStore, callbackScheduler));
  }
  // Повторяющиеся задания (schedules/): «Работа» по расписанию тем же раннером; напоминание звонком — разовым перезвоном.
  const scheduleStore = new ScheduleStore(resolve(config.memoryDir));
  await scheduleStore.load();
  const reminders = callbackStore && callbackScheduler ? { store: callbackStore, scheduler: callbackScheduler } : undefined;
  const schedules = new ScheduleScheduler({
    store: scheduleStore, timeZone: config.timeZone, log: log,
    startWork: input => runner.start(input),
    isRunning: id => taskStore.active.some(t => t.id === id),
    remind: reminders ? async ({ title, reason }) => {
      const item = await reminders.store.create({ at: new Date().toISOString(), title, reason });
      reminders.scheduler.arm();
      return item;
    } : undefined
  });
  schedules.arm();
  tools = tools.with(scheduleTools(scheduleStore, schedules, {
    canCall: Boolean(reminders), macOnline: relay ? () => relay.connected : undefined,
    pickProject: helmDirs ? (asked, signal) => pickProject(helm, asked, false, helmDirs, signal, mac?.exists) : undefined
  }));
  cancelTask = id => runner.cancel(id);
  const resumed = runner.resume();
  if (resumed) log.info('tasks.resumed', { count: resumed });
  tools = tools.with([
    ...workTools(runner, taskStore, { work, macOnline: relay ? () => relay.connected : undefined, isRepository: mac?.isRepository, pickProject: helmDirs ? (asked, create, signal) => pickProject(helm, asked, create, helmDirs, signal, mac?.exists) : undefined }),
    // Новая техкарта голосом: пишет агент со skill-creator, allowed-tools — из инструментов этого ядра (skills/create.ts).
    techcardCreateTool({ runner, ownerDir: skills.ownerDir, serverDir: resolve(import.meta.dirname, '..'), toolNames: () => tools.names() })
  ]);
}
// Треды «Штурвала» для «Кода» и ответы агентам (work_answer): есть и без «Работы».
if (helm && config.helm) tools = tools.with(helmTools({ client: helm, store: taskStore, runtimeMode: config.helm.runtimeMode, cancelTask, macOnline: relay ? () => relay.connected : undefined }));
// Плагины (docs/skills.md): MCP-серверы включённых плагинов поднимаются при старте, каждый не дольше 20 с; упавший
// сервер только в логе. Включает плагин владелец командой `npm run plugins -- enable` на Mac, не голосом.
const plugins = await startPlugins({ store: pluginStore, log: log, taken: tools.names() });
tools = tools.with(plugins.tools);
if (plugins.connections.length) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void plugins.stop().finally(() => process.exit(0)); });
}
const metrics = config.metricsDir ? new TraceStore(resolve(config.metricsDir)) : undefined;
const { jev } = config;
const prefetch = jev.mode === 'off' ? undefined : {
  // Предел клиента нужен прощанию: маршрут и честность ждут меньше своим сигналом. 26.09.2026 Jev отвечал 0,9–1,4 с,
  // и при прежних 1,5 с «Ничего, пока» осталось без ответа: позднее прощание лучше, чем никакого.
  jev: jevClient({ apiKey: jev.apiKey, model: jev.model, url: JEV_PROVIDERS[jev.provider].url, timeoutMs: 3000, meter: ledger }), mode: jev.mode, toolThreshold: jev.toolThreshold, goodbyeThreshold: jev.goodbyeThreshold, routeThreshold: jev.routeThreshold
};
const cd = config.clientDelegation;
const clientDelegation = cd ? {
  models: {
    simple: backendModel({ openRouterKey: cd.apiKey, openAiKey: cd.openAiKey, model: cd.models.simple, meter: { ledger, purpose: 'delegation' } }),
    standard: backendModel({ openRouterKey: cd.apiKey, openAiKey: cd.openAiKey, model: cd.models.standard, meter: { ledger, purpose: 'delegation' } })
  },
  search: chatModel({ apiKey: cd.apiKey, model: cd.searchModel, extra: { plugins: [{ id: 'web', max_results: 3 }] }, meter: { ledger, purpose: 'search' } })
} : undefined;
// Заголовки разговоров на главном экране телефона: модель стандартного класса (Luna), размышления входят в предел.
const titleModel = cd ? backendModel({ openRouterKey: cd.apiKey, openAiKey: cd.openAiKey, model: cd.models.standard, maxTokens: 800, meter: { ledger, purpose: 'title' } }) : undefined;
// Приветствие: фраза из набора по времени суток, давности звонка и имени из памяти.
const greeting = config.greeting ? new GreetingComposer({ dir: resolve(config.memoryDir), timeZone: config.timeZone, log: log, memory: () => store.state }) : undefined;
await greeting?.load();
// Консоль ядра: только 127.0.0.1, отдельный порт (ngrok смотрит на порт ядра), история последних звонков.
const consoleStore = config.consolePort ? new ConsoleStore(resolve(config.memoryDir, 'console')) : undefined;
const consoleHub = consoleStore ? new ConsoleHub({ store: consoleStore, log }) : undefined;
// «Сводка» и «Расходы» консоли: учёт ядра и счета провайдеров, только чтение (console/dashboard.ts, usage/billing.ts).
const openRouterKey = config.memory.apiKey;
const { openAiAdminKey, openAiProject } = config.billing;
const dashboard = consoleHub ? new Dashboard({
  ledger, timeZone: config.timeZone, health, store: consoleStore, work, memory: () => store.state, metrics,
  openRouter: openRouterKey ? new Cached(() => openRouterBill(openRouterKey), 5 * 60_000) : undefined,
  // Счёт OpenAI обновляется раз в сутки: спрашиваем раз в час, с начала прошлого месяца.
  openAi: openAiAdminKey ? new Cached(() => {
    const now = new Date();
    return openAiBill(openAiAdminKey, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), { project: openAiProject });
  }, 60 * 60_000) : undefined,
  helm: helm ? () => helm.check() : undefined,
  push: devices ? { apns: apnsReady, devices: () => devices.current ? 1 : 0 } : undefined,
  plugins: { servers: plugins.connections.length }
}) : undefined;
// «Штурвал» (docs/helm-push.md): уведомления и Live Activity его агентов тем же ключом APNs; свои токены сервера и телефона.
const helmApns = config.tasks?.apns;
const helmPush = config.helmPush ? new HelmPush({
  dir: resolve(config.memoryDir), log,
  apns: helmApns ? { keyPem: await readFile(resolve(helmApns.keyPath), 'utf8'), keyId: helmApns.keyId, teamId: helmApns.teamId } : null
}) : undefined;
await helmPush?.load();
const app = createBridge({
  // Коммит сборки Railway задаёт сам при деплое из GitHub; локально его нет.
  ...config, commit: process.env.RAILWAY_GIT_COMMIT_SHA || undefined, tools, memory, metrics, prefetch, clientDelegation, liveCalls,
  tasks: taskStore, work, callbacks: callbackStore, push: devices ? { devices, apns: apnsReady } : undefined, greeting, persona, skills, console: consoleHub, titleModel,
  log, usage: { meter: ledger, pricePerMinute: config.billing.livePricePerMinute }, health,
  // «Узел» подключился: проверяем «Штурвал» всем путём (ядро → «Узел» → «Штурвал»), в логе helm.ready или helm.unavailable.
  relay: relay && config.relay ? { link: relay, token: config.relay.token, onHello: checkHelm } : undefined,
  // Helm MCP (docs/helm-mcp.md): тот же клиент «Штурвала», что у «Работы», в облаке через «Узел».
  mcp: helm && config.helm && config.mcp ? {
    client: helm, signer: new Signer(config.mcp.signingSecret), password: config.mcp.password, publicUrl: config.mcp.publicUrl ?? undefined,
    confirmWrites: config.mcp.confirmWrites, macOnline: relay ? () => relay.connected : undefined,
    runtimeMode: config.helm.runtimeMode, instance: config.helm.instance, model: config.helm.model
  } : undefined,
  helm: helmPush && config.helmPush ? {
    push: helmPush, ...config.helmPush,
    transcribe: config.apiKey ? openAiTranscriber({ apiKey: config.apiKey, model: config.helmPush.transcribeModel, meter: ledger }) : undefined
  } : undefined
});
const server = await listen(app, config.port, config.host);
// «Узел» держит WebSocket (http/relay-socket.ts); HTTP-опрос /relay остаётся для старых версий «Узла».
if (relay && config.relay) attachRelaySocket(server, { link: relay, token: config.relay.token, log, onHello: checkHelm });
work?.start();
if (consoleHub && config.consolePort) await listen(consoleApp({ hub: consoleHub, dashboard, port: config.consolePort }), config.consolePort, CONSOLE_HOST);
console.log(`Volna core: http://${config.host}:${config.port}`);
console.log(config.apiKey ? 'OpenAI key configured.' : 'Setup needed: add OPENAI_API_KEY to core/.env');
console.log(`Voice ${config.model}, web search ${config.webSearch ? 'on' : 'off'}`);
console.log(`Persona: ${persona.state.traits ? `personal layer ${persona.state.traits.length} chars, ${persona.state.changes.length} changes` : 'factory'}; review ${config.personaReview ? 'on' : 'off'}`);
console.log(`Delegation: ${cd ? `${cd.openAiKey ? 'openai/* via OpenAI Responses, rest via ' : ''}OpenRouter, simple ${cd.models.simple}, standard ${cd.models.standard} (search ${cd.searchModel}); phone tools via /device-tools` : 'setup needed: add OPEN_ROUTER_API_KEY to core/.env, calls are refused until then'}`);
console.log(`Metrics: ${metrics ? metrics.dir : 'off'}; Jev (goodbye, routing): ${jev.mode}${jev.apiKey ? ` via ${jev.provider}, ${jev.model}` : ' (no TYPESAFE_API_KEY or OPEN_ROUTER_API_KEY)'}`);
console.log(`Plugins: ${plugins.connections.length ? `${plugins.connections.length} MCP servers, ${plugins.tools.length} tools` : 'no MCP servers'} (npm run plugins)`);
console.log(`Tools: ${tools.names().join(', ') || 'none'}; on the phone: ${tools.deviceNames().join(', ') || 'none'}; time zone ${config.timeZone}`);
console.log(`Work: ${tc ? `Helm (up to ${config.helm!.taskMaxMs / 60_000} min, stalled after ${config.helm!.stallMs / 60_000} min), progress ${tc.progress ? `${tc.progress.model} every ${tc.progress.intervalMs / 1000}s` : 'off'}; ${apnsReady ? `APNs ${tc.apns!.topic} (one notification or call when all tasks finish)` : 'no APNs key: results wait for the next call'}` : 'off (TASKS=off, no HELM_TOKEN or RELAY_TOKEN, or no OPEN_ROUTER_API_KEY)'}`);
console.log(`Helm: ${helm && config.helm ? `${config.helm.via === 'relay' ? 'via Relay on the Mac (/relay)' : helm.url}, ${config.helm.instance}${config.helm.model ? `/${config.helm.model}` : ''}, ${config.helm.runtimeMode}, work in ${config.helm.projectDir}` : 'off (no HELM_TOKEN or RELAY_TOKEN)'}`);
// Версия «Штурвала» проверяется в фоне: он может быть ещё не запущен. Несовместимый сервер не получит ни одной команды (helm/client.ts).
// Через «Узел» проверка ждёт его подключения (checkHelm в onHello).
if (helm && !relay) checkHelm();
console.log(`Helm MCP: ${helm && config.mcp ? `${config.mcp.publicUrl ?? 'this host'}/mcp, writes confirmed by ${config.mcp.confirmWrites ? 'a code from the server' : 'the client'}` : config.mcp ? 'off (no work: HELM_TOKEN or RELAY_TOKEN)' : 'off (no MCP_OWNER_PASSWORD and MCP_SIGNING_SECRET)'}`);
console.log(`Greeting: ${greeting ? 'phrase from the set (greeting/phrases.ts)' : 'fallback rule (GREETING=off)'}`);
console.log(`Console: ${consoleHub ? `http://${CONSOLE_HOST}:${config.consolePort}` : 'off (CONSOLE=off)'}`);
console.log(`Usage: ${ledger.dir}, GPT-Live $${config.billing.livePricePerMinute}/min; OpenAI bill ${openAiAdminKey ? `on${openAiProject ? ` (project ${openAiProject})` : ''}` : 'off (no OPENAI_ADMIN_KEY)'}`);
console.log(`Memory: ${store.state.level}, ${store.state.facts.filter(f => !f.closedAt).length} notes in ${store.dir}`);

/** Версия и доступность «Штурвала»: при старте ядра на Mac или при каждом подключении «Узла». */
function checkHelm(): void {
  if (!helm) return;
  void helm.check().then(checked => checked.ok
    ? log.info('helm.ready', { version: checked.version })
    : log.warn('helm.unavailable', { reason: checked.reason, version: checked.version }));
}
