import type { Context } from 'hono';
import { scopedListener, usageScope, voiceUsage, type UsageMeter } from '../usage/ledger.ts';
import type { Health } from '../telemetry/health.ts';
import type { Logger } from '../log.ts';
import type { ToolRegistry } from '../assistant/tools/registry.ts';
import { buildInstructions, buildBackendInstructions } from '../assistant/persona.ts';
import { buildSession, isLiveVoice, DEFAULT_VOICE } from '../realtime/session.ts';
import { createCall, UpstreamError } from '../realtime/openai-calls.ts';
import { attachSideband, type SocketFactory } from '../realtime/sideband.ts';
import type { MemoryService } from '../memory/service.ts';
import type { PersonaStore } from '../persona/store.ts';
import type { SkillStore } from '../skills/store.ts';
import { routeCards } from '../skills/routing.ts';
import { MEMORY_TOOL_NAMES } from '../memory/tools.ts';
import { HISTORY_TOOL_NAMES } from '../memory/history.ts';
import { CallTrace, type TraceStore } from '../telemetry/trace.ts';
import { GoodbyeWatcher, type GoodbyeMode } from '../jev/goodbye.ts';
import { GreetingProbe } from '../telemetry/greeting-probe.ts';
import { ClientDelegate } from '../delegation/client.ts';
import { taskContext } from '../tasks/context.ts';
import type { TaskStore } from '../tasks/store.ts';
import type { WorkSync } from '../work-sync/sync.ts';
import { similarWork } from '../work-sync/similar.ts';
import { callbackContext } from '../callbacks/context.ts';
import type { CallbackStore } from '../callbacks/store.ts';
import { TIERS, type Tier } from '../jev/questions.ts';
import type { ChatModel } from '../delegation/llm.ts';
import { webSearchTool } from '../delegation/web-search.ts';
import type { DeviceBroker } from '../delegation/device-broker.ts';
import type { DecisionModel } from '../jev/client.ts';
import type { LiveCalls } from '../realtime/live-calls.ts';
import type { GreetingComposer } from '../greeting/composer.ts';
import type { ConsoleHub } from '../console/hub.ts';

export const MAX_SDP_BYTES = 64 * 1024;
/** Заголовок, которым приложение перечисляет инструменты телефона с выданным доступом: имена через запятую. */
export const DEVICE_TOOLS_HEADER = 'x-device-tools';
/** Звонок начала Волна (VoIP-пуш) по готовому заданию или по перезвону в назначенное время: телефон передаёт id. */
export const CALLBACK_TASK_HEADER = 'x-callback-task';
/** `on`: в настройках iPhone включена музыка ожидания; модель узнаёт, что музыка не пользователь. */
export const WAIT_MUSIC_HEADER = 'x-wait-music';

export function parseDeviceTools(header: string | undefined): string[] {
  return (header ?? '').split(',').map(name => name.trim()).filter(name => /^[a-z][a-z0-9_]*$/.test(name)).slice(0, 32);
}
export const UPSTREAM_TIMEOUT_MS = 20_000;

export interface SessionRouteDeps {
  apiKey: string;
  model: string;
  /** Поиск в интернете моделью поиска делегирования (`web_search`). */
  webSearch: boolean;
  timeZone: string;
  tools: ToolRegistry;
  log: Logger;
  fetchImpl: typeof fetch;
  socketFactory?: SocketFactory;
  /** Подключать ли sideband после ответа: приветствие, инструменты ядра, транскрипт. В тестах можно выключить. */
  sideband: boolean;
  /** Память: секция инструкций и извлечение после звонка. Без неё звонок как раньше. */
  memory?: MemoryService;
  /** Личный слой характера; на уровне «Холодная» не применяется, как и память. */
  persona?: PersonaStore;
  /** Техкарты (skills/store.ts): их список уходит в инструкции бэкенда; на уровне «Холодная» инструментов техкарт нет. */
  skills?: SkillStore;
  metrics?: TraceStore;
  prefetch?: PrefetchSettings;
  /** Клиентское делегирование (delegation/client.ts); без него звонок не создаётся: отвечать на делегирование некому. */
  clientDelegation?: ClientDelegationSettings;
  /** Очередь инструментов телефона; без неё инструменты телефона выключены. */
  deviceBroker?: DeviceBroker;
  /** Идущие звонки для заметок вне хода разговора (итог подтверждения с телефона). */
  liveCalls?: LiveCalls;
  /** Фоновые задания: итоги в начале звонка и перезвон Волны. */
  tasks?: TaskStore;
  /** Один список работы (work-sync/): похожая идущая работа перед предложением новой. */
  work?: WorkSync;
  /** Перезвоны по времени (callbacks/): напоминание в начале перезвона и напоминания, до которых не дозвонились. */
  callbacks?: CallbackStore;
  /** Приветствие из набора фраз (greeting/composer.ts); без него запасное правило в инструкциях. */
  greeting?: GreetingComposer;
  /** Консоль ядра на 127.0.0.1: видит звонок и может отвечать на делегирования (console/). */
  console?: ConsoleHub;
  /** Учёт расходов (usage/): секунды звонка по цене минуты, все вызовы моделей в звонке с его id. */
  usage?: { meter: UsageMeter; pricePerMinute: number };
  /** Состояние служб для «Сводки» консоли: удался ли последний старт звонка. */
  health?: Health;
}

/** Jev для звонков: раннее завершение (jev/goodbye.ts) и быстрый путь клиентского делегирования; режим и пороги. */
export interface PrefetchSettings {
  jev: DecisionModel;
  mode: GoodbyeMode;
  toolThreshold: number;
  goodbyeThreshold: number;
  /** Доверие выбору набора и класса в маршруте клиентского делегирования. */
  routeThreshold: number;
}

/** Своё делегирование: модель на каждый класс задачи и модель поиска (OpenAI-совместимый chat, по умолчанию OpenRouter). */
export interface ClientDelegationSettings {
  models: Readonly<Record<Tier, ChatModel>>;
  search?: ChatModel;
}

const UPSTREAM_HINTS: Record<number, string> = {
  401: 'OpenAI отклонил API-ключ.',
  403: 'У проекта нет доступа к GPT-Live.',
  429: 'OpenAI: проверьте баланс и лимиты API.'
};

/** POST /session: SDP-offer с голосом в заголовке → SDP-answer от GPT-Live. Единственная платная операция. */
export function sessionRoute(deps: SessionRouteDeps) {
  return async (c: Context) => {
    if (!deps.apiKey) return c.json({ error: 'Добавьте OPENAI_API_KEY в core/.env на Mac.' }, 503);
    const client = deps.clientDelegation;
    if (!client) return c.json({ error: 'Добавьте OPEN_ROUTER_API_KEY в core/.env на Mac.' }, 503);
    if (!c.req.header('content-type')?.startsWith('application/sdp')) return c.json({ error: 'Expected application/sdp.' }, 415);
    const voice = c.req.header('x-realtime-voice') ?? DEFAULT_VOICE;
    if (!isLiveVoice(voice)) return c.json({ error: 'Этот голос не поддерживается. Выберите другой голос в настройках.' }, 400);

    const sdp = await c.req.text();
    if (Buffer.byteLength(sdp) > MAX_SDP_BYTES) return c.json({ error: 'SDP too large.' }, 413);
    if (!sdp.startsWith('v=0') || !sdp.includes('m=audio')) return c.json({ error: 'Invalid audio SDP.' }, 400);

    const header = c.req.header(CALLBACK_TASK_HEADER)?.trim() || null;
    const callbackId = header && /^[0-9a-f]{16}$/.test(header) ? header : null;
    // Один заголовок на оба перезвона: id перезвона по времени ищется среди перезвонов, иначе это задание.
    const timed = deps.callbacks ? callbackContext(deps.callbacks, callbackId, deps.timeZone) : { opening: '', section: '', heard: [] };
    const tasksOnly = deps.tasks ? taskContext(deps.tasks, timed.opening ? null : callbackId) : { section: '', heard: [], opening: '', results: false };
    const taskNotes = { ...tasksOnly, opening: timed.opening || tasksOnly.opening, section: [timed.section, tasksOnly.section].filter(Boolean).join('\n') };
    // Перезвон по заданиям здоровается рассказом об итогах (tasks/context.ts): придуманное приветствие и вопрос о нити не нужны.
    // Перезвон без итогов (задания нет, оно не готово, id не прошёл проверку) идёт как обычный звонок: фраза, нить, commit.
    // Готовые итоги работы важнее нити: о ней спросим в следующем звонке. Нить отмечается поднятой только после принятого звонка.
    // Фраза ждёт память: с нитью для приветствия она выбирается без вопроса (greeting/phrases.ts).
    const callback = Boolean(taskNotes.opening);
    const memoryReady = deps.memory ? deps.memory.context({ thread: !callback && !taskNotes.results }) : Promise.resolve(null);
    const [memory, greeting, persona, techCards, allSkills] = await Promise.all([
      memoryReady,
      deps.greeting && !callback ? memoryReady.then(context => deps.greeting!.forCall({ thread: Boolean(context?.thread) })) : null,
      deps.persona ? deps.persona.load() : null,
      deps.skills ? deps.skills.index() : '',
      deps.skills ? deps.skills.list() : []
    ]);
    const traits = memory?.section && persona ? persona.traits : '';
    const forCall = deps.tools.forDevice(parseDeviceTools(c.req.header(DEVICE_TOOLS_HEADER)));
    // Инструменты телефона идут через очередь ядра (deviceBroker); без неё их нет. Поиск даёт ядро.
    const base = deps.deviceBroker ? forCall : deps.tools.forDevice([]);
    const withSearch = client.search && deps.webSearch ? base.with([webSearchTool(client.search)]) : base;
    // «Холодная»: ни памяти, ни истории прошлых звонков.
    const tools = memory?.section ? withSearch : withSearch.without([...MEMORY_TOOL_NAMES, ...HISTORY_TOOL_NAMES]);
    // Техкарты маршрута: Jev выбирает среди тех, чьи инструменты есть в этом звонке (skills/routing.ts).
    const cards = routeCards(allSkills, tools);
    const session = buildSession({
      model: deps.model, voice,
      instructions: buildInstructions(tools.names(), [memory?.section, taskNotes.section].filter(Boolean).join('\n'), { goodbyeWatch: deps.prefetch?.mode === 'on', greeting: greeting?.greeting, traits, opening: taskNotes.opening, thread: Boolean(memory?.thread), results: taskNotes.results, waitMusic: c.req.header(WAIT_MUSIC_HEADER) === 'on' })
    });
    const signals = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)];
    if (c.req.raw.signal) signals.push(c.req.raw.signal);
    try {
      const { answer, callId } = await createCall({ apiKey: deps.apiKey, sdp, session, signal: AbortSignal.any(signals), fetchImpl: deps.fetchImpl });
      deps.health?.liveStarted(null);
      // Итоги ушли в инструкции звонка: больше не поднимать их и не слать запасное уведомление.
      const unsaved = (what: string) => (error: unknown) => deps.log.warn(`${what} not saved`, { error: error instanceof Error ? error.name : 'unknown' });
      for (const id of taskNotes.heard) deps.tasks!.patch(id, { delivery: 'heard' }).catch(unsaved('task delivery'));
      for (const id of timed.heard) deps.callbacks!.patch(id, { status: 'answered' }).catch(unsaved('callback'));
      // Звонок принят: только теперь его время станет давностью следующего, а фраза попадёт в недавние. Перезвон без фразы
      // тоже звонок.
      if (greeting) greeting.commit().catch(unsaved('greeting'));
      else if (callback && deps.greeting) deps.greeting.markCall().catch(unsaved('greeting'));
      memory?.commitThread().catch(unsaved('memory thread'));
      if (deps.sideband && callId) {
        const recorder = deps.memory?.startCall(callId) ?? null;
        const consoleCall = deps.console?.startCall(callId, { model: deps.model, voice }) ?? null;
        // Отметки ядра нужны и консоли, даже если замеры выключены; на диск замеры пишутся только с METRICS=on.
        const trace = deps.metrics || consoleCall ? new CallTrace({ callId, onMark: consoleCall ? event => consoleCall.mark(event) : undefined, config: {
          voiceModel: deps.model, delegation: 'client', backendModel: TIERS.map(tier => client.models[tier].model).join('|'),
          webSearch: deps.webSearch, jev: deps.prefetch?.mode ?? 'off',
          tools: tools.names().length, memory: Boolean(memory?.section), callback, taskNotes: taskNotes.heard.length,
          greeting: greeting?.source ?? 'off'
        } }) : undefined;
        const prefetch = deps.prefetch;
        const prefetchers = [
          ...(prefetch ? [new GoodbyeWatcher({
            jev: prefetch.jev, mode: prefetch.mode, threshold: prefetch.goodbyeThreshold, log: deps.log, callId, trace,
            // Прощание с перезвоном Jev узнаёт, только пока идёт работа и в звонке есть перезвон.
            workRunning: deps.tasks && tools.names().includes('tasks_call_back') ? () => deps.tasks!.active.length > 0 : undefined
          })] : []),
          new ClientDelegate({
            models: client.models, tools, cards,
            // Правила только об инструментах прохода, память без недавних разговоров (docs/core.md, 4h).
            instructions: names => [buildBackendInstructions(names, { techCards }), memory?.backend ?? ''].filter(Boolean).join('\n'),
            timeZone: deps.timeZone, log: deps.log, callId, trace, device: deps.deviceBroker,
            gate: consoleCall ? deps.console!.gate(consoleCall) : undefined,
            similarWork: deps.work ? (tool, args) => {
              if (tool !== 'work_start') return null;
              const found = similarWork(deps.work!.items(), String(args.title ?? ''), typeof args.project === 'string' ? args.project : null);
              // work_add берёт только идущее задание; законченное, продолженное владельцем, — как его тред.
              const task = found?.origin === 'volna' && deps.tasks?.get(found.task ?? '')?.status === 'running' ? found.task : null;
              return found ? { task, thread: found.thread, title: found.title, project: found.project?.title ?? null } : null;
            } : undefined,
            jev: prefetch?.mode === 'on' ? { model: prefetch.jev, threshold: prefetch.toolThreshold, routeThreshold: prefetch.routeThreshold } : undefined
          })
        ];
        // Консоль первой: делегирование в её записи идёт раньше, чем решения по нему.
        // Прозвучало ли приветствие и какой звук был на входе в момент команды (telemetry/greeting-probe.ts).
        const probe = trace ? [new GreetingProbe({ trace })] : [];
        const voiceMeter = deps.usage ? [voiceUsage(deps.usage.meter, { callId, model: deps.model, pricePerMinute: deps.usage.pricePerMinute })] : [];
        // Всё, что участники начнут в звонке (делегирование, Jev, поиск), попадает в учёт с id звонка (usage/ledger.ts).
        const listeners = [...(consoleCall ? [consoleCall.listener()] : []), ...prefetchers, ...probe, ...(deps.liveCalls ? [deps.liveCalls.listener()] : []), ...voiceMeter]
          .map(listener => scopedListener(listener, callId));
        attachSideband({
          apiKey: deps.apiKey, callId, tools, log: deps.log, timeZone: deps.timeZone, socketFactory: deps.socketFactory,
          trace, listeners, onSend: consoleCall ? event => consoleCall.sent(event) : undefined,
          observer: recorder ? message => recorder.observe(message) : undefined,
          onClose: () => {
            // Разбор звонка, «сон» и пересмотр характера после него тоже числятся за этим звонком.
            if (recorder) void usageScope({ callId }, () => deps.memory!.endCall(recorder));
            if (trace && deps.metrics) deps.metrics.save(trace).catch(error => deps.log.warn('metrics not saved', { error: error instanceof Error ? error.name : 'unknown' }));
          }
        });
      } else if (deps.sideband) {
        deps.log.warn('no session id in OpenAI response; delegation, core tools and transcript are unavailable for this call');
      }
      return c.body(answer, 200, { 'Content-Type': 'application/sdp' });
    } catch (error) {
      // Ни тело ответа OpenAI, ни текст сетевой ошибки не уходят клиенту и не пишутся в лог.
      deps.health?.liveStarted(error instanceof UpstreamError ? `http_${error.status}` : error instanceof Error ? error.name : 'unknown');
      if (error instanceof UpstreamError) {
        return c.json({ error: UPSTREAM_HINTS[error.status] ?? `OpenAI: ошибка подключения (${error.status}).` }, 502);
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return c.json({ error: 'Не удалось подключиться к OpenAI. Проверьте сеть.' }, timedOut ? 504 : 502);
    }
  };
}
