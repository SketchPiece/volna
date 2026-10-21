import { homedir } from 'node:os';
import { z } from 'zod';
import { JEV_PROVIDERS, type JevProvider } from './jev/client.ts';
import { HELM_RUNTIME_MODES, type HelmRuntimeMode } from './helm/client.ts';
import { RELAY_HELM_URL } from './relay/link.ts';
import type { Tier } from './jev/questions.ts';

export const LOCAL_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];

const schema = z.object({
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_LIVE_MODEL: z.string().default('gpt-live-1'),
  BRIDGE_TOKEN: z.string().default(''),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8787),
  ASSISTANT_TIMEZONE: z.string().default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  // Память через OpenRouter (замер 25.09.2026 на трёх звонках): извлечение — Sonnet 5, аккуратнее GPT-5 Mini и Haiku 4.5;
  // «сон» и пересмотр характера редки и требуют выводов через несколько разговоров — Opus 5.5.
  MEMORY_MODEL: z.string().default('anthropic/claude-sonnet-5'),
  MEMORY_DEEP_MODEL: z.string().default('anthropic/claude-opus-5.5'),
  WEB_SEARCH: z.enum(['on', 'off']).default('on'),
  MEMORY_DIR: z.string().default('data'),
  METRICS: z.enum(['on', 'off']).default('on'),
  METRICS_DIR: z.string().default('data/metrics'),
  TYPESAFE_API_KEY: z.string().default(''),
  OPEN_ROUTER_API_KEY: z.string().default(''),
  OPENROUTER_API_KEY: z.string().default(''),
  // Jev точен достаточно, чтобы работать сразу (решение владельца 22.09.2026); shadow только пишет решения в замеры.
  JEV_MODE: z.enum(['off', 'shadow', 'on']).default('on'),
  JEV_MODEL: z.string().optional(),
  // Модель на класс задачи (docs/tools-routing.md), имена OpenRouter. simple: Gemini, по бенчмарку 22.09.2026 ход 0,6 с против 2,2 с у Haiku 4.5.
  CLIENT_MODEL_SIMPLE: z.string().default('google/gemini-3.5-flash-lite'),
  // С 25.09.2026 Luna 5.6 вместо Sonnet 5: на просьбах звонка 25.09 не хуже, круг ровнее, в 10 раз дешевле (docs/tools-routing.md).
  CLIENT_MODEL_STANDARD: z.string().default('openai/gpt-5.6-luna'),
  CLIENT_SEARCH_MODEL: z.string().default('google/gemini-3.5-flash-lite'),
  // С 29.09.2026 модели `openai/*` идут напрямую в Responses API ключом OPENAI_API_KEY (delegation/llm.ts); off: через OpenRouter.
  CLIENT_OPENAI_DIRECT: z.enum(['on', 'off']).default('on'),
  JEV_TOOL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  JEV_GOODBYE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  JEV_ROUTE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  // «Работа» (tasks/): делает агент в «Штурвале»; ключ OpenRouter для сводок хода; итог звонком Волны или уведомлением через APNs.
  TASKS: z.enum(['on', 'off']).default('on'),
  // Сводка хода задания одной фразой (tasks/progress.ts): дешёвая модель раз в N секунд, 0 выключает.
  TASK_PROGRESS_MODEL: z.string().default('google/gemini-3.5-flash-lite'),
  TASK_PROGRESS_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  // Приветствие звонка: фраза из набора по времени и давности звонка (greeting/phrases.ts); off: запасное правило.
  GREETING: z.enum(['on', 'off']).default('on'),
  // Личный слой характера пересматривается после звонков (persona/review.ts); off: только заводской характер и уже сложившийся слой.
  PERSONA_REVIEW: z.enum(['on', 'off']).default('on'),
  // Техкарты — скиллы (docs/skills.md): свои и установленные в MEMORY_DIR/skills; дополнительные папки только для чтения,
  // через запятую, «~» раскрывается (например, ~/.claude/skills).
  SKILLS_EXTRA_DIRS: z.string().default(''),
  APNS_KEY_PATH: z.string().default(''),
  APNS_KEY_ID: z.string().default(''),
  APNS_TEAM_ID: z.string().default(''),
  APNS_TOPIC: z.string().default('dev.prototype.callassistant'),
  // «Штурвал», форк T3 Code (helm/, протокол 2, helm-cloud/docs/relay.md, 2.1): с токеном вся «Работа», и код тоже, идёт в его треды.
  // До 07.10.2026 переменные назывались T3_*: старые имена читаются, если новых нет (legacyNames).
  // Токен выдаёт владелец: node apps/server/dist/bin.mjs auth session issue --base-dir ~/.helm --label volna --ttl 30d --token-only.
  HELM_TOKEN: z.string().default(''),
  // helm-cloud (helm-cloud/docs/relay.md): облако «Штурвала» держит «Узел» на Mac, Волна просит его /internal/relay своим токеном.
  // Без HELM_TOKEN включает «Работу» через helm-cloud; папки HELM_PROJECT_DIR и HELM_NEW_PROJECTS_DIR тогда полными путями Mac.
  HELM_CLOUD_URL: z.string().default(''),
  HELM_INTERNAL_TOKEN: z.string().default(''),
  HELM_URL: z.string().default('http://127.0.0.1:3783'),
  HELM_PROJECT_DIR: z.string().default('~/Documents/Volna Work'),
  HELM_NEW_PROJECTS_DIR: z.string().default('~/Documents'),
  HELM_INSTANCE: z.string().default('claudeAgent'),
  HELM_MODEL: z.string().optional(),
  HELM_RUNTIME_MODE: z.enum(HELM_RUNTIME_MODES).default('auto'),
  // Долгая работа в «Штурвале» (docs/task-sync.md, 7): предел задания и сколько терпеть тред без активностей.
  HELM_TASK_MAX_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(120),
  HELM_STALL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(20),
  // Консоль ядра (console/): страница на 127.0.0.1, история звонков в MEMORY_DIR/console.
  CONSOLE: z.enum(['on', 'off']).default('on'),
  CONSOLE_PORT: z.coerce.number().int().positive().default(25452),
  // Учёт расходов (usage/): gpt-live-1 стоит $0,05 за минуту, посекундно (цена OpenAI, сентябрь 2026).
  LIVE_PRICE_PER_MINUTE: z.coerce.number().min(0).default(0.05),
  // Сверка со счётом OpenAI (Costs API): ключ администратора организации, только чтение; проект по желанию.
  OPENAI_ADMIN_KEY: z.string().optional(),
  OPENAI_COSTS_PROJECT: z.string().optional()
});

export interface Config {
  apiKey: string;
  model: string;
  token: string;
  host: string;
  port: number;
  timeZone: string;
  /** Учёт расходов: цена минуты GPT-Live и ключ администратора OpenAI для сверки (null — без сверки). */
  billing: { livePricePerMinute: number; openAiAdminKey: string | null; openAiProject: string | null };
  /** Память через OpenRouter: извлечение после звонка и модель для «сна» и характера. */
  memory: { apiKey: string; model: string; deepModel: string };
  personaReview: boolean;
  webSearch: boolean;
  memoryDir: string;
  /** Папки скиллов только для чтения (docs/skills.md). */
  skillsExtraDirs: string[];
  /** Каталог замеров; null выключает запись. */
  metricsDir: string | null;
  jev: JevConfig;
  /** null: нет ключа OpenRouter, звонки не создаются. */
  clientDelegation: ClientDelegationConfig | null;
  /** null: фоновых заданий нет (выключены или нет ключа OpenRouter). */
  tasks: TasksConfig | null;
  /** null: приветствие по запасному правилу (выключено или нет ключа OpenRouter). */
  greeting: boolean;
  /** Порт консоли ядра на 127.0.0.1; null выключает. */
  consolePort: number | null;
  /** null: нет ни HELM_TOKEN, ни helm-cloud — «Работы» нет. */
  helm: HelmConfig | null;
  /** «Узел» на Mac через helm-cloud; null без HELM_CLOUD_URL и HELM_INTERNAL_TOKEN или при прямом HELM_TOKEN. */
  helmCloud: { url: string; token: string } | null;
}

/** «Штурвал» (helm/client.ts): сервер, токен и то, где и чем идёт «Работа». */
export interface HelmConfig {
  /** `direct`: «Штурвал» на этой же машине (HELM_TOKEN); `relay`: через helm-cloud и «Узел» на Mac, токен «Штурвала» там. */
  via: 'direct' | 'relay';
  url: string;
  token: string;
  /** Папка проекта «Штурвала» для заданий «Работы», «~» раскрыт. */
  projectDir: string;
  /** Где голос создаёт новые проекты (только новые пустые папки, helm/projects.ts), «~» раскрыт. */
  newProjectsDir: string;
  /** Инстанс провайдера в «Штурвале»: `claudeAgent`, `codex` или свой. */
  instance: string;
  /** null: модель проекта для того же инстанса или встроенная по умолчанию (helm/client.ts, HELM_DEFAULT_MODELS). */
  model: string | null;
  runtimeMode: HelmRuntimeMode;
  /** Предел одного задания в «Штурвале» (вместо 10 минут раннера). */
  taskMaxMs: number;
  /** Задание без новых активностей в «Штурвале» дольше этого считается зависшим (`helm_stalled`); ожидание владельца не считается. */
  stallMs: number;
}

/** Фоновые задания; `apns` null: итог только заметкой в звонке или в начале следующего. */
export interface TasksConfig {
  /** OpenRouter для сводок хода работы. */
  apiKey: string;
  /** Сводки хода работы; null — выключены. */
  progress: { model: string; intervalMs: number } | null;
  apns: { keyPath: string; keyId: string; teamId: string; topic: string } | null;
}

/** Клиентское делегирование: модели OpenRouter отвечают на работу, которую передаёт Live. */
export interface ClientDelegationConfig {
  apiKey: string;
  /** Ключ OpenAI для моделей `openai/*` напрямую (Responses API); null: они тоже через OpenRouter. */
  openAiKey: string | null;
  /** Модель на каждый класс задачи. */
  models: Record<Tier, string>;
  searchModel: string;
}

/** Предвыборка Jev. `mode` off, если нет ключа. Ключ TypeSafe важнее ключа OpenRouter. */
export interface JevConfig {
  provider: JevProvider;
  apiKey: string;
  mode: 'off' | 'shadow' | 'on';
  model: string;
  toolThreshold: number;
  goodbyeThreshold: number;
  /** Доверие выбору набора и класса в маршруте делегирования. */
  routeThreshold: number;
}

/** Читает и проверяет окружение. Бросает, если ядро слушает не localhost без токена. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.parse(legacyNames(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''))));
  if (!LOCAL_HOSTS.includes(parsed.HOST) && !parsed.BRIDGE_TOKEN) {
    throw new Error('Set BRIDGE_TOKEN before listening beyond localhost. Use HTTPS for remote access.');
  }
  return {
    apiKey: parsed.OPENAI_API_KEY,
    model: parsed.OPENAI_LIVE_MODEL,
    token: parsed.BRIDGE_TOKEN,
    host: parsed.HOST,
    port: parsed.PORT,
    timeZone: parsed.ASSISTANT_TIMEZONE,
    billing: { livePricePerMinute: parsed.LIVE_PRICE_PER_MINUTE, openAiAdminKey: parsed.OPENAI_ADMIN_KEY ?? null, openAiProject: parsed.OPENAI_COSTS_PROJECT ?? null },
    memory: { apiKey: parsed.OPEN_ROUTER_API_KEY || parsed.OPENROUTER_API_KEY, model: parsed.MEMORY_MODEL, deepModel: parsed.MEMORY_DEEP_MODEL },
    personaReview: parsed.PERSONA_REVIEW === 'on',
    webSearch: parsed.WEB_SEARCH === 'on',
    memoryDir: parsed.MEMORY_DIR,
    skillsExtraDirs: parsed.SKILLS_EXTRA_DIRS.split(',').map(dir => dir.trim()).filter(Boolean).map(dir => dir.replace(/^~(?=$|\/)/, homedir())),
    metricsDir: parsed.METRICS === 'on' ? parsed.METRICS_DIR : null,
    jev: jevConfig(parsed),
    clientDelegation: clientDelegationConfig(parsed),
    tasks: tasksConfig(parsed),
    greeting: parsed.GREETING === 'on',
    consolePort: parsed.CONSOLE === 'on' ? parsed.CONSOLE_PORT : null,
    helm: helmConfig(parsed),
    helmCloud: !parsed.HELM_TOKEN && viaCloud(parsed) ? { url: parsed.HELM_CLOUD_URL, token: parsed.HELM_INTERNAL_TOKEN } : null
  };
}

const viaCloud = (parsed: z.output<typeof schema>) => Boolean(parsed.HELM_CLOUD_URL && parsed.HELM_INTERNAL_TOKEN);

/** До 07.10.2026 переменные «Штурвала» назывались T3_*; новое имя важнее старого. */
export function legacyNames(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('T3_')) continue;
    const next = `HELM_${name.slice(3)}`;
    if (out[next] === undefined) out[next] = value;
    delete out[name];
  }
  return out;
}

/** «Штурвал» напрямую (HELM_TOKEN, «~» раскрывается здесь) или через helm-cloud и «Узел» (пути Mac полные: «~» здесь не тот). */
function helmConfig(parsed: z.output<typeof schema>): HelmConfig | null {
  const via = parsed.HELM_TOKEN ? 'direct' : viaCloud(parsed) ? 'relay' : null;
  if (!via) return null;
  const dir = (value: string, name: string) => {
    if (via === 'direct') return value.replace(/^~(?=$|\/)/, homedir());
    if (!value.startsWith('/')) throw new Error(`With HELM_CLOUD_URL set ${name} to a full path on the Mac, e.g. /Users/<you>/Documents/Volna Work.`);
    return value;
  };
  return {
    via, url: via === 'direct' ? parsed.HELM_URL : RELAY_HELM_URL, token: via === 'direct' ? parsed.HELM_TOKEN : '',
    projectDir: dir(parsed.HELM_PROJECT_DIR, 'HELM_PROJECT_DIR'), newProjectsDir: dir(parsed.HELM_NEW_PROJECTS_DIR, 'HELM_NEW_PROJECTS_DIR'),
    instance: parsed.HELM_INSTANCE, model: parsed.HELM_MODEL ?? null, runtimeMode: parsed.HELM_RUNTIME_MODE,
    taskMaxMs: parsed.HELM_TASK_MAX_MINUTES * 60_000, stallMs: parsed.HELM_STALL_MINUTES * 60_000
  };
}

/** Клиентское делегирование через OpenRouter; без ключа null. */
function clientDelegationConfig(parsed: z.output<typeof schema>): ClientDelegationConfig | null {
  const apiKey = parsed.OPEN_ROUTER_API_KEY || parsed.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    openAiKey: parsed.CLIENT_OPENAI_DIRECT === 'on' && parsed.OPENAI_API_KEY ? parsed.OPENAI_API_KEY : null,
    models: { simple: parsed.CLIENT_MODEL_SIMPLE, standard: parsed.CLIENT_MODEL_STANDARD },
    searchModel: parsed.CLIENT_SEARCH_MODEL
  };
}

function tasksConfig(parsed: z.output<typeof schema>): TasksConfig | null {
  const apiKey = parsed.OPEN_ROUTER_API_KEY || parsed.OPENROUTER_API_KEY;
  if (parsed.TASKS !== 'on' || !apiKey) return null;
  const apns = parsed.APNS_KEY_PATH && parsed.APNS_KEY_ID && parsed.APNS_TEAM_ID
    ? { keyPath: parsed.APNS_KEY_PATH, keyId: parsed.APNS_KEY_ID, teamId: parsed.APNS_TEAM_ID, topic: parsed.APNS_TOPIC }
    : null;
  const progress = parsed.TASK_PROGRESS_SECONDS > 0 ? { model: parsed.TASK_PROGRESS_MODEL, intervalMs: parsed.TASK_PROGRESS_SECONDS * 1000 } : null;
  return { apiKey, progress, apns };
}

function jevConfig(parsed: z.output<typeof schema>): JevConfig {
  const openRouterKey = parsed.OPEN_ROUTER_API_KEY || parsed.OPENROUTER_API_KEY;
  const provider: JevProvider = parsed.TYPESAFE_API_KEY || !openRouterKey ? 'typesafe' : 'openrouter';
  const apiKey = provider === 'typesafe' ? parsed.TYPESAFE_API_KEY : openRouterKey;
  return {
      provider,
      apiKey,
      mode: apiKey ? parsed.JEV_MODE : 'off',
      model: parsed.JEV_MODEL ?? JEV_PROVIDERS[provider].model,
      toolThreshold: parsed.JEV_TOOL_THRESHOLD,
      goodbyeThreshold: parsed.JEV_GOODBYE_THRESHOLD,
      routeThreshold: parsed.JEV_ROUTE_THRESHOLD
  };
}
