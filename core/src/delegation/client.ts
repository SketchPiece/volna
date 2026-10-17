import type { Logger } from '../log.ts';
import { usageScope } from '../usage/ledger.ts';
import { ESCALATE, OFFER_WORK, START_OFFERED, type ToolDefinition, type ToolRegistry } from '../assistant/tools/registry.ts';
import type { RouteCard } from '../skills/routing.ts';
import type { SidebandControl, SidebandListener } from '../realtime/sideband.ts';
import type { CallTrace } from '../telemetry/trace.ts';
import { Conversation, type Turn } from '../realtime/conversation.ts';
import { fitAppend } from '../realtime/append-limit.ts';
import type { DecisionModel } from '../jev/client.ts';
import { honestyRequest, MISSING, MIXED, NO_TOOLS, NONE, NOTHING_MISSING, readChoice, readToolDecision, readYes, round, routeRequest, TIERS, type Candidate, type CardOption, type Tier, type ToolCallNote, type ToolDecision } from '../jev/questions.ts';
import type { ChatMessage, ChatModel, ChatTool } from './llm.ts';
import type { DeviceBroker } from './device-broker.ts';
import { claimsAction, claimsByWords, confirmsAction, HONESTY_FALLBACK, HONESTY_RETRY, honestyFallback, unrecovered } from './honesty.ts';

/**
 * Клиентское делегирование (`delegation: { type: 'client' }`, эксперимент 22.09.2026). Live решает, что нужна работа,
 * и присылает `session.delegation.created` без текста задачи; ядро берёт запрос из стенограммы и отвечает сам:
 *
 * Сначала один запрос к Jev (~0,3 с) выбирает маршрут (docs/tools-routing.md). С 25.09.2026 единица маршрута — техкарта:
 * - согласие: Волна предложила работу (`offer_work`), пользователь ответил «да» — ядро само запускает предложенное;
 * - быстрый путь: уверенный простой читающий инструмент (время, «о Волне», список агентов); ядро исполняет его и сразу
 *   отдаёт результат Live, без LLM;
 * - вопрос (`ask`): простой техкарте с меняющим инструментом не хватает главного (что, когда, кто) — Live спрашивает сам;
 * - иначе модель класса (`simple`/`standard`, по умолчанию Gemini Flash Lite/Luna 5.6 через OpenRouter) с инструментами
 *   выбранной техкарты и её текстом, до 4 кругов. Уровень техкарты — нижняя планка класса. Функция `escalate`, ошибка
 *   модели или исчерпанные круги повторяют запрос со всеми инструментами и классом выше, пока не было успешного действия.
 *   На классе `simple` успешное простое изменение (напоминание, событие) отвечает сразу, без второго круга (`fill`).
 * - большая работа (`startsWork`: задание, новый чат агента) модели не доступна напрямую: она зовёт `offer_work`, Волна
 *   говорит план («Сравню тарифы трёх операторов и соберу таблицу. Сделать?»), запуск только после «да».
 *
 * Без Jev или при его неуверенности: `standard` со всеми инструментами; при ошибке или опоздании Jev: `simple` со всеми
 * инструментами (он может поднять класс через `escalate`). Ответ уходит `session.commentary.append` с
 * `delegation_id` (в этом режиме Live его принимает). Инструменты телефона идут через DeviceBroker: телефон забирает
 * вызовы долгим опросом и отвечает POST. Устройство: docs/core.md, «Клиентское делегирование».
 */
export interface ClientDelegateOptions {
  /** Модель на каждый класс задачи. */
  models: Readonly<Record<Tier, ChatModel>>;
  /** Инструменты звонка: их видит LLM, их кандидатов берёт Jev. */
  tools: ToolRegistry;
  /**
   * Инструменты, которых модель не видит, хотя Jev и ядро их исполняют. `current_time`: время уже в инструкциях, а Luna всё
   * равно тратила на него первый круг (~2,5 с, 5 из 23 просьб в прогоне 29.09.2026). По умолчанию `MODEL_HIDDEN`.
   */
  hidden?: readonly string[];
  /** Техкарты маршрута (skills/routing.ts): из них Jev выбирает, какие инструменты увидит модель. */
  cards?: readonly RouteCard[];
  /**
   * Инструкции бэкенда и секция памяти. Функция получает имена инструментов прохода (с инструментами запуска работы):
   * правила только о том, что модель видит (`buildBackendInstructions`).
   */
  instructions: string | ((toolNames: readonly string[]) => string);
  timeZone: string;
  now?: () => Date;
  /** threshold: быстрый путь; routeThreshold: доверие выбору набора и класса. */
  jev?: { model: DecisionModel; threshold: number; routeThreshold: number };
  /** Сколько ждать маршрут от Jev; дольше: маршрут по умолчанию. */
  routeTimeoutMs?: number;
  /** То же, пока Jev в этом звонке ни разу не ответил: в начале звонка он медленнее (25.09.2026: 0,8–1,4 с против 0,3–0,4). */
  firstRouteTimeoutMs?: number;
  /** Инструменты телефона: через очередь, телефон забирает их долгим опросом. */
  device?: DeviceBroker;
  log: Logger;
  callId: string;
  trace?: CallTrace;
  /** Делегирование иногда приходит раньше хвоста стенограммы: ждём столько тишины во входе, но не дольше maxSettleMs. */
  settleMs?: number;
  maxSettleMs?: number;
  /** Консоль ядра: может ответить на делегирование вместо автомата (console/hub.ts). */
  gate?: DelegationGate;
  /**
   * Похожая идущая работа для предложенной (work-sync/similar.ts): Волна предложит дописать туда, а не начинать новую
   * (docs/task-sync.md, 7). null: похожей нет.
   */
  similarWork?: (tool: string, args: Record<string, unknown>) => SimilarWork | null;
}

/** Ответ на делегирование из консоли ядра: свой текст, сбой или молчание. */
export type ManualAnswer = { kind: 'text'; text: string } | { kind: 'failure' } | { kind: 'silence' };
export type GateDecision = { kind: 'auto' } | ManualAnswer;

/** Кто отвечает на делегирование. Спрашивается после ожидания хвоста стенограммы. */
export interface DelegationGate {
  /** `takeOver` перехватывает уже идущий автоматический ответ; после ответа или отмены ничего не делает. */
  decide(id: string, turns: readonly Turn[], signal: AbortSignal, takeOver: (answer: ManualAnswer) => void): Promise<GateDecision>;
}

export const MAX_ROUNDS = 4;
export const DEFAULT_TIER: Tier = 'standard';
/** Класс, когда Jev не ответил: простой вопрос не должен ждать модель класса standard со всеми инструментами. */
export const UNROUTED_TIER: Tier = 'simple';
/** Доверие ответам Jev о недостающем и о согласии: ошибка здесь стоит лишнего вопроса или запуска без согласия. */
export const MISSING_THRESHOLD = 0.8;
export const AGREE_THRESHOLD = 0.85;
/** С этой вероятности ответ Jev «заявлено действие без действия» возвращает ответ модели на исправление. */
export const HONESTY_THRESHOLD = 0.7;
/**
 * Порог, когда вызовов не было вовсе, а слова действия есть («Записал.» без единого инструмента): подтвердить такое
 * заявление нечем, ошибка в эту сторону стоит выдуманного действия, а в обратную — лишнего круга модели.
 */
export const HONESTY_NO_CALLS_THRESHOLD = 0.4;
/** Ниже этого «да» предложение считается отклонённым. */
export const DECLINE_THRESHOLD = 0.2;
/** Предложение работы живёт недолго: через столько минут или делегирований без ответа оно забывается. */
export const OFFER_TTL_MS = 10 * 60_000;
export const OFFER_TTL_TURNS = 3;
/**
 * Аргументы быстрого пути по словам пользователя (JevCard.verbatim): его реплики после последнего ответа Волны дословно
 * и до четырёх реплик перед ними для контекста («а теперь то же в Заметках»); название — первые слова просьбы.
 */
export function verbatimArgs(turns: readonly Turn[], spec: { arg: string; title?: string }, maxChars = 2000): Record<string, string> {
  let start = turns.length;
  while (start > 0 && turns[start - 1]!.role === 'user') start--;
  const request = turns.slice(start).map(t => t.text.trim()).filter(Boolean).join(' ');
  const context = turns.slice(Math.max(0, start - 4), start).map(t => `${t.role === 'user' ? 'Пользователь' : 'Волна'}: ${t.text.trim()}`);
  const text = `Просьба пользователя голосом, дословно (распознано по речи, возможны ошибки распознавания): «${request}»`
    + (context.length ? `\nПеред этим в разговоре:\n${context.join('\n')}` : '');
  const args: Record<string, string> = { [spec.arg]: text.slice(0, maxChars) };
  if (spec.title) {
    const words = request.replace(/[«»".,!?…]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
    args[spec.title] = (words.length >= 2 ? words : 'Задание на Mac').slice(0, 80);
  }
  return args;
}

/** Кончался ли последний ответ Волны перед словами пользователя вопросом: только тогда его «да» — согласие. */
function askedBefore(turns: readonly Turn[]): boolean {
  let end = turns.length;
  while (end > 0 && turns[end - 1]!.role === 'user') end--;
  // Вопросом должна кончаться реплика: «…сделать? Принято, работаю.» уже не вопрос (звонок 26.09.2026).
  return end > 0 && end < turns.length && turns[end - 1]!.text.trim().endsWith('?');
}

/** Реплики пользователя после последнего ответа Волны. */
function lastUserWords(turns: readonly Turn[]): string {
  let start = turns.length;
  while (start > 0 && turns[start - 1]!.role === 'user') start--;
  return turns.slice(start).map(t => t.text.trim()).filter(Boolean).join(' ');
}

export const FAILURE_COMMENTARY = 'Не получилось выполнить запрос: сбой на стороне бэкенда. Скажи об этом коротко и предложи повторить.';
/**
 * Предложение работы (решения владельца 25.09.2026): своё мнение и вопрос «делать ли», без выбора «быстро или в работу»,
 * и каждый раз своими словами, а не одной заученной фразой.
 */
export const offerCommentary = (summary: string) =>
  `План работы: ${summary.trim().replace(/[.!…\s]+$/, '')}. Скажи пользователю этот план коротко и конкретно, своими словами, сразу с того, что сделаешь («Проверю… и назову…»), без вступлений вроде «предлагаю так» или «мой план», и спроси, делать ли. Не говори, что это большая, долгая или фоновая работа: это и так понятно. Не предлагай выбор между вариантами. Ничего не запускай и не говори, что запускаешь или уже делаешь: запустит ядро, когда пользователь согласится.`;
/** Идущая работа, похожая на предложенную: задание Волны (`task`) или тред «Штурвала». */
export interface SimilarWork { task: string | null; thread: string | null; title: string; project: string | null }
/**
 * Похожая работа уже идёт: предложить дописать туда. Сливать самому нельзя, выбирает пользователь. В задание Волны
 * слова идут через work_add, в собственный тред владельца — через work_send с пересказом.
 */
export const similarCommentary = (similar: SimilarWork) =>
  ` Похожая работа уже идёт: «${similar.title}»${similar.project ? ` в проекте ${similar.project}` : ''}. Вместо вопроса «делать ли» спроси, дописать ли это туда или начать отдельно. Если скажет дописать, передай это туда ${similar.task ? `инструментом work_add (id задания ${similar.task})` : `инструментом work_send (id ${similar.thread}), прочитав текст вслух`}; если отдельно, запусти предложенное.`;
/** Прощание после `end_call`: фразу Live говорит сам, модель ради неё больше не зовётся. */
export const farewellCommentary = (calledBack: boolean) => calledBack
  ? 'Перезвон записан, звонок сейчас закроется. Попрощайся одной короткой фразой без вопросов и скажи, что перезвонишь, когда всё будет готово; если уже сказал это, промолчи.'
  : 'Звонок сейчас закроется. Попрощайся одной короткой фразой без вопросов; если уже попрощался, промолчи.';
export const askCommentary = (what: string) =>
  `Чтобы это сделать, не хватает: ${what}. Коротко спроси об этом пользователя и пока ничего не делай и не обещай.`;

/** Состояние прохода модели: было ли успешное действие и какие инструменты звались (для проверки честности). */
interface PassState { acted: boolean; calls: ToolCallNote[] }

/** Предложенная работа: какой инструмент запустить и с какими аргументами, после «да». */
interface Offer { tool: string; args: Record<string, unknown>; summary: string; at: number; turns: number }

/**
 * Работа, которая только смотрит (прочитать, найти, перечислить, сравнить), запускается без «Сделать?» (решение владельца
 * 26.09.2026). Только для заданий: новый чат агента и техкарта что-то создают. Запрет что-либо менять уходит исполнителю в задании.
 */
const READ_ONLY_STARTS = ['work_start'];
const READ_ONLY_TASK = 'Только посмотреть: ничего не создавай, не меняй, не перемещай, не удаляй, не отправляй и не покупай. Если без этого задачу не сделать, остановись и спроси пользователя.';

export class ClientDelegate implements SidebandListener {
  readonly #options: ClientDelegateOptions;
  readonly #conversation = new Conversation();
  readonly #candidates: Candidate[];
  readonly #cards: readonly RouteCard[];
  readonly #cardOptions: CardOption[];
  #control: SidebandControl | null = null;
  #current: AbortController | null = null;
  #closed = false;
  #offer: Offer | null = null;
  /** Работа, запущенная в этом звонке: модель видит её, чтобы не запустить второй раз (26.09.2026 «перезвони, когда закончишь» дало второе задание). */
  #started: string[] = [];
  #jevAnswered = false;

  constructor(options: ClientDelegateOptions) {
    this.#options = options;
    this.#candidates = options.tools.jevCandidates();
    this.#cards = options.cards ?? [];
    this.#cardOptions = this.#cards.map(card => ({ name: card.name, when: card.when }));
  }

  attach(control: SidebandControl): void { this.#control = control; }

  observe(message: any): void {
    if (this.#closed) return;
    this.#conversation.observe(message);
    if (message?.type === 'session.delegation.created' && message.delegation?.target === 'client' && typeof message.delegation.id === 'string') {
      void this.#handle(message.delegation.id);
    }
  }

  close(): void {
    this.#closed = true;
    this.#current?.abort();
  }

  /** Предложение ещё в силе: не старое и пользователь не ушёл в другие темы. */
  #pendingOffer(): Offer | null {
    const offer = this.#offer;
    if (offer && (Date.now() - offer.at > OFFER_TTL_MS || offer.turns >= OFFER_TTL_TURNS)) this.#offer = null;
    return this.#offer;
  }

  async #handle(id: string): Promise<void> {
    const control = this.#control;
    if (!control) return;
    // Новое делегирование заменяет незаконченное: пользователь уже спросил другое.
    this.#current?.abort();
    const abort = new AbortController();
    this.#current = abort;
    const { trace } = this.#options;
    const started = performance.now();
    trace?.mark('client.start', { d: id });
    await this.#settle(abort.signal);
    if (abort.signal.aborted) return;
    const turns = this.#conversation.untilLastUser();
    trace?.mark('client.context', { d: id, turns: turns.length, settle: Math.round(performance.now() - started) });

    const { gate } = this.#options;
    if (gate) {
      const takeOver = (answer: ManualAnswer) => {
        if (this.#current !== abort || this.#closed) return;
        this.#current = null;
        abort.abort();
        this.#manual(control, id, answer);
      };
      const decision = await gate.decide(id, turns, abort.signal, takeOver).catch((): GateDecision => ({ kind: 'auto' }));
      if (abort.signal.aborted || this.#closed) return;
      if (decision.kind !== 'auto') {
        if (this.#current === abort) this.#current = null;
        this.#manual(control, id, decision);
        return;
      }
    }

    try {
      const offer = this.#pendingOffer();
      if (offer) offer.turns++;
      const route = await this.#route(id, turns, offer, abort.signal);
      const answer = route.agree && offer ? await this.#startOffer(id, offer, turns, abort.signal)
        : route.fast ? await this.#fast(route.fast)
        : route.ask ? { content: askCommentary(route.ask), path: 'ask' }
        : await this.#llmPath(id, turns, route, abort.signal);
      if (abort.signal.aborted || this.#closed) return;
      this.#commentary(control, id, answer.content, answer.path);
    } catch (error) {
      if (abort.signal.aborted || this.#closed) return;
      trace?.mark('client.error', { d: id, error: error instanceof Error ? error.name : 'unknown', status: (error as any)?.status ?? null });
      this.#options.log.warn('client delegation failed', { callId: this.#options.callId, error: error instanceof Error ? error.name : 'unknown' });
      this.#commentary(control, id, FAILURE_COMMENTARY, 'error');
    } finally {
      if (this.#current === abort) this.#current = null;
    }
  }

  async #settle(signal: AbortSignal): Promise<void> {
    const { settleMs = 150, maxSettleMs = 400 } = this.#options;
    const started = performance.now();
    while (!signal.aborted && performance.now() - started < maxSettleMs && performance.now() - this.#conversation.lastInputAt < settleMs) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  /**
   * Маршрут от Jev одним запросом: согласие на предложенную работу, быстрый инструмент, техкарта, класс, недостающее.
   * `tools: null` значит все инструменты. Без Jev, при ошибке, опоздании или неуверенности: класс по умолчанию и все инструменты.
   */
  async #route(id: string, turns: Turn[], offer: Offer | null, signal: AbortSignal): Promise<Route> {
    const fallback: Route = { fast: null, card: null, tools: null, tier: DEFAULT_TIER, ask: null, agree: false };
    const { jev, trace, routeTimeoutMs = 800, firstRouteTimeoutMs = 2000 } = this.#options;
    if (!jev) return fallback;
    const timeoutMs = this.#jevAnswered ? routeTimeoutMs : Math.max(routeTimeoutMs, firstRouteTimeoutMs);
    const started = performance.now();
    const missingAsked = this.#cards.some(card => this.#changes(card));
    let answers;
    try {
      const request = routeRequest(turns, this.#candidates, this.#cardOptions, { missing: missingAsked, offer: Boolean(offer) });
      answers = (await usageScope({ purpose: 'jev_route' }, () => jev.model.decide(request, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])))).answers;
    } catch (error) {
      if (!signal.aborted) trace?.mark('jev.error', { d: id, ms: Math.round(performance.now() - started), status: (error as any)?.status ?? (error instanceof Error ? error.name : null) });
      return { ...fallback, tier: UNROUTED_TIER };
    }
    this.#jevAnswered = true;
    const yes = offer ? readYes(answers, 'agree') : null;
    const agree = yes !== null && yes >= AGREE_THRESHOLD;
    // Явный отказ или другая тема: предложение больше не ждёт ответа.
    if (offer && yes !== null && yes < DECLINE_THRESHOLD) this.#offer = null;
    const tool = this.#candidates.length ? readToolDecision(answers, this.#candidates) : null;
    const candidate = tool ? this.#candidates.find(c => c.name === tool.tool)?.card : undefined;
    const tier = readChoice(answers, 'tier');
    // Действие по словам пользователя (verbatim) — только для простой задачи; сложную обсуждает и составляет модель.
    const simple = tier?.choice === 'simple' && tier.p >= jev.routeThreshold;
    let fast = tool && tool.tool !== NONE && tool.p >= (candidate?.threshold ?? jev.threshold) && (!candidate?.verbatim || simple) ? tool : null;
    if (fast && candidate?.verbatim) fast = { ...fast, args: { ...fast.args, ...verbatimArgs(turns, candidate.verbatim) } };
    const choice = readChoice(answers, 'techcard');
    let card: RouteCard | null = null;
    let tools: string[] | null = null;
    if (choice && choice.p >= jev.routeThreshold) {
      if (choice.choice === NO_TOOLS) tools = [];
      else if (choice.choice !== MIXED) {
        card = this.#cards.find(c => c.name === choice.choice) ?? null;
        if (card) tools = card.tools.length ? card.tools : null;
      }
    }
    let chosenTier = tier && tier.p >= jev.routeThreshold && TIERS.includes(tier.choice as Tier) ? tier.choice as Tier : DEFAULT_TIER;
    // Уровень техкарты решён при её создании: нижняя планка класса. У `work` планка standard: предложить работу и пересказать
    // задачу исполнителю лёгкая модель не может (26.09.2026 «пять последних файлов в загрузках» Jev счёл простым,
    // Flash Lite ответила «нет доступа», а со второй попытки переврала задачу в «составить план реализации»).
    const floor = card?.tier === 'work' ? 'standard' : card?.tier === 'simple' || card?.tier === 'standard' ? card.tier : null;
    if (floor && TIERS.indexOf(floor) > TIERS.indexOf(chosenTier)) chosenTier = floor;
    const missing = readChoice(answers, 'missing');
    const ask = card && chosenTier === 'simple' && this.#changes(card) && missing && missing.choice !== NOTHING_MISSING && missing.p >= MISSING_THRESHOLD
      ? MISSING[missing.choice]?.ask ?? null : null;
    trace?.mark('jev.result', {
      d: id, ms: Math.round(performance.now() - started), tool: tool?.tool ?? null, p: round(tool?.p ?? null), confidence: round(tool?.confidence ?? null),
      card: choice?.choice ?? null, cardP: round(choice?.p ?? null), tier: tier?.choice ?? null, tierP: round(tier?.p ?? null),
      missing: missing?.choice ?? null, missingP: round(missing?.p ?? null), agree: round(yes),
      action: agree ? 'start' : fast ? 'answer' : ask ? 'ask' : 'route'
    });
    return { fast, card, tools, tier: chosenTier, ask, agree };
  }

  /** Есть ли у техкарты инструмент, который меняет данные пользователя: только тогда недостающее мешает сделать сразу. */
  #changes(card: RouteCard): boolean {
    return card.tier === 'simple' && card.tools.some(name => this.#options.tools.effectOf(name) === 'write');
  }

  async #fast(decision: ToolDecision): Promise<{ content: string; path: string }> {
    const output = await this.#control!.runTool(decision.tool, decision.args, 'jev');
    if (this.#candidates.find(c => c.name === decision.tool)?.card.verbatim) {
      return { content: `Ядро само запустило действие по словам пользователя (${decision.tool}): ${output}\nЕсли запущено, скажи коротко фразу из say; если ошибка, честно скажи, что не получилось, а если у ошибки есть say, скажи его: там, что проверить.`, path: 'jev' };
    }
    return { content: `Данные по запросу пользователя (${decision.tool}): ${output}\nПерескажи коротко своими словами, поля не зачитывай.`, path: 'jev' };
  }

  /** Пользователь согласился на предложенную работу: ядро запускает её само, без модели. */
  async #startOffer(id: string, offer: Offer, turns: Turn[], signal: AbortSignal): Promise<{ content: string; path: string }> {
    this.#offer = null;
    const args = { ...offer.args };
    // «Да, и ещё сравни цены»: слова согласия с добавкой идут исполнителю дословно.
    const words = lastUserWords(turns);
    if (typeof args.task === 'string' && words.split(/\s+/).length > 3) args.task = `${args.task}\n\nПри согласии пользователь добавил (дословно, распознано по речи): «${words}»`.slice(0, 4000);
    this.#options.trace?.mark('client.offer.start', { d: id, tool: offer.tool });
    const output = await this.#runTool(id, offer.tool, JSON.stringify(args), signal);
    this.#remember(output, offer);
    return { content: `Пользователь согласился, ядро запустило предложенную работу (${offer.tool}): ${output}\nЕсли запущено, скажи коротко фразу из say; если ошибка, честно скажи, что не получилось, а если у ошибки есть say, скажи его: там, что проверить.`, path: 'offer.start' };
  }

  /** Модель класса задачи с инструментами техкарты; `escalate`, ошибка или исчерпанные круги поднимают класс и открывают все инструменты. */
  async #llmPath(id: string, turns: Turn[], route: Route, signal: AbortSignal): Promise<{ content: string; path: string }> {
    const { models, tools: all, trace } = this.#options;
    let { tier, tools: names, card } = route;
    for (let attempt = 1; ; attempt++) {
      // Большую работу модель не запускает сама, а предлагает (offer_work); запуск делает ядро после «да».
      const tools = (names ? all.only(names) : all).without([...all.startNames(), ...(this.#options.hidden ?? MODEL_HIDDEN)]);
      const top = TIERS[TIERS.length - 1]!;
      const canEscalate = names !== null || tier !== top;
      const model = models[tier];
      trace?.mark('client.route', { d: id, attempt, tier, model: model.model, card: card?.name ?? (names ? NO_TOOLS : 'all'), tools: tools.size });
      const state: PassState = { acted: false, calls: [] };
      let reason: string;
      try {
        const result = await this.#run(id, turns, model, tools, { canEscalate, tier, card }, state, signal);
        if (result !== ESCALATED) return result;
        reason = ESCALATE;
      } catch (error) {
        // После успешного действия повтор мог бы сделать его дважды.
        if (signal.aborted || !canEscalate || state.acted) throw error;
        reason = error instanceof Error ? error.name : 'unknown';
      }
      const next: Tier = tier === top ? top : TIERS[TIERS.indexOf(tier) + 1]!;
      trace?.mark('client.escalate', { d: id, attempt, from: tier, to: next, reason });
      tier = next;
      names = null;
      card = null;
    }
  }

  /**
   * Заявляет ли ответ о действии, которого вызовы прохода не подтверждают. Сначала дешёвый предфильтр по словам
   * (delegation/honesty.ts): ответ без глаголов действия («Сейчас десять», поиск, разговор) не ждёт Jev вовсе. После
   * успешного меняющего вызова ответ проверяется, только если в проходе был и неудачный меняющий вызов, не исправленный потом
   * успешными повторами того же инструмента (частичный успех: «Записал и отправил», когда отправка упала). Остальное решает Jev: он видит ответ и все вызовы (с 26.09.2026; одни слова ловили
   * «Поставил» только без вызовов и путали мнение с действием). Jev ждём столько же, сколько в маршруте: пока он в этом звонке
   * не ответил ни разу, дольше. Без Jev, при его ошибке или опоздании решают слова (`claimsByWords`): ответ без вызовов или
   * после одних неудачных меняющих вызовов.
   */
  async #claims(id: string, llmRound: number, turns: Turn[], content: string, state: PassState, signal: AbortSignal): Promise<boolean> {
    const { jev, trace, routeTimeoutMs = 800, firstRouteTimeoutMs = 2000 } = this.#options;
    const { calls } = state;
    if (!claimsAction(content)) return false;
    if (state.acted && !unrecovered(calls).length) return false;
    if (!jev) return claimsByWords(calls, state.acted);
    const timeoutMs = this.#jevAnswered ? routeTimeoutMs : Math.max(routeTimeoutMs, firstRouteTimeoutMs);
    const started = performance.now();
    let p: number | null = null;
    try {
      const answers = (await usageScope({ purpose: 'jev_honesty' }, () => jev.model.decide(honestyRequest(turns, content, calls), AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])))).answers;
      this.#jevAnswered = true;
      p = readYes(answers, 'honesty');
    } catch {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    }
    const ms = Math.round(performance.now() - started);
    trace?.mark('client.honesty.check', { d: id, round: llmRound, ms, by: p === null ? 'words' : 'jev', p: round(p) });
    if (p === null) return claimsByWords(calls, state.acted);
    return p >= (calls.length === 0 ? HONESTY_NO_CALLS_THRESHOLD : HONESTY_THRESHOLD);
  }

  /** Один проход модели: до MAX_ROUNDS кругов с инструментами. ESCALATED, если модель попросила маршрут сильнее. */
  async #run(id: string, turns: Turn[], llm: ChatModel, tools: ToolRegistry, pass: { canEscalate: boolean; tier: Tier; card: RouteCard | null }, state: PassState, signal: AbortSignal): Promise<{ content: string; path: string } | typeof ESCALATED> {
    const { trace } = this.#options;
    const { canEscalate } = pass;
    const starts = this.#options.tools.startNames();
    const offer = this.#pendingOffer();
    const service: ChatTool[] = [...(starts.length ? [offerTool(this.#options.tools.definitions().filter(d => starts.includes(d.name)))] : []), ...(offer ? [START_TOOL] : [])];
    const chatTools: ChatTool[] = [...tools.definitions().map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }) as ChatTool), ...service];
    const messages: ChatMessage[] = [{ role: 'system', content: this.#system(pass, starts, offer, [...tools.names(), ...starts]) }, ...turns.map(t => ({ role: t.role, content: t.text }) as ChatMessage)];
    // Был ли уже возврат на исправление (#claims): второй раз модель не спрашиваем, отдаём честный отказ.
    let checked = false;
    let calledBack = false;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const started = performance.now();
      // После действия эскалация закрыта: новый проход повторил бы его.
      const offered = round < MAX_ROUNDS ? [...chatTools, ...(canEscalate && !state.acted ? [ESCALATE_TOOL] : [])] : [];
      const result = await llm.complete(messages, offered, signal);
      trace?.mark('client.llm', { d: id, round, model: llm.model, ms: Math.round(performance.now() - started), calls: result.toolCalls.length, inTokens: result.usage.inTokens, outTokens: result.usage.outTokens, reasoningTokens: result.usage.reasoningTokens ?? null, cachedTokens: result.usage.cachedTokens ?? null, cost: result.usage.costUsd ?? null, provider: result.provider ?? null, gen: result.id ?? null });
      if (result.toolCalls.some(call => call.function.name === ESCALATE) && canEscalate && !state.acted) return ESCALATED;
      const proposal = result.toolCalls.find(call => call.function.name === OFFER_WORK);
      if (proposal && starts.length) {
        const offered = this.#propose(id, proposal.function.arguments, starts);
        // Волна уже спросила словами, пользователь ответил «да»: второй вопрос «Сделать?» не нужен (звонок 25.09.2026).
        if (offered.ok && offered.agreed && askedBefore(turns)) return this.#startOffer(id, this.#offer!, turns, signal);
        if (offered.ok && offered.readOnly) return this.#startReadOnly(id, this.#offer!, signal);
        if (offered.ok) {
          const similar = this.#options.similarWork?.(this.#offer!.tool, this.#offer!.args);
          return { content: offerCommentary(offered.summary) + (similar ? similarCommentary(similar) : ''), path: similar ? 'offer.similar' : 'offer' };
        }
        trace?.mark('client.offer.invalid', { d: id, round, issues: offered.issues.join('; ').slice(0, 300) });
        messages.push({ role: 'assistant', content: result.content ?? null, tool_calls: [proposal] }, { role: 'tool', tool_call_id: proposal.id, content: JSON.stringify({ error: 'invalid_offer', issues: offered.issues }) });
        continue;
      }
      if (offer && result.toolCalls.some(call => call.function.name === START_OFFERED)) return this.#startOffer(id, offer, turns, signal);
      if (!result.toolCalls.length) {
        const content = result.content?.trim() || (state.acted ? 'Готово.' : '');
        if (!content || !(await this.#claims(id, round, turns, content, state, signal))) return { content: content || HONESTY_FALLBACK, path: 'llm' };
        // Заявление о действии без действия: один раз просим модель исправиться, потом отдаём честный отказ.
        trace?.mark('client.honesty', { d: id, round, retry: !checked && round < MAX_ROUNDS });
        if (checked || round >= MAX_ROUNDS) return { content: honestyFallback(state.calls), path: 'honesty' };
        checked = true;
        messages.push({ role: 'assistant', content }, { role: 'user', content: HONESTY_RETRY });
        continue;
      }
      messages.push({ role: 'assistant', content: result.content ?? null, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) trace?.mark('client.tool', { d: id, tool: call.function.name, round });
      const outputs = await Promise.all(result.toolCalls.map(call => tools.names().includes(call.function.name)
        ? this.#runTool(id, call.function.name, call.function.arguments, signal)
        : Promise.resolve(JSON.stringify({ error: 'unknown_tool', name: call.function.name }))));
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      result.toolCalls.forEach((call, i) => {
        messages.push({ role: 'tool', tool_call_id: call.id, content: outputs[i]! });
        const effect = tools.effectOf(call.function.name);
        state.calls.push({ tool: call.function.name, effect: effect ?? 'unknown', ok: !outputs[i]!.trimStart().startsWith('{"error"') });
        if (confirmsAction(effect, outputs[i]!)) state.acted = true;
        if (call.function.name === 'tasks_call_back' && /"callBack":true/.test(outputs[i]!)) calledBack = true;
      });
      // Трубку кладут: следующий круг модели был нужен только ради прощальной фразы, её даёт ядро
      // (26.09.2026 «перезвони и пока» шло тремя кругами Luna, 9–13 с до конца звонка).
      if (state.calls.some(c => c.tool === 'end_call' && c.ok)) return { content: farewellCommentary(calledBack), path: 'farewell' };
      // `fill`: простое изменение прошло с первого круга — пересказ сделает Live, второй круг модели не нужен.
      const writes = result.toolCalls.every(call => tools.effectOf(call.function.name) === 'write');
      if (pass.tier === 'simple' && round === 1 && writes && result.toolCalls.every((call, i) => confirmsAction(tools.effectOf(call.function.name), outputs[i]!))) {
        const done = result.toolCalls.map((call, i) => `${call.function.name}: ${outputs[i]}`).join('\n');
        return { content: `Сделано:\n${done}\nСкажи пользователю коротко своими словами, что сделано; поля не зачитывай.`, path: 'fill' };
      }
    }
    throw new Error('too many tool rounds');
  }

  /** Работа только смотрит: ядро запускает её сразу, исполнителю запрещено что-либо менять. */
  async #startReadOnly(id: string, offer: Offer, signal: AbortSignal): Promise<{ content: string; path: string }> {
    this.#offer = null;
    const args = { ...offer.args, task: `${String(offer.args.task ?? '')}\n\n${READ_ONLY_TASK}`.slice(0, 4000) };
    this.#options.trace?.mark('client.offer.start', { d: id, tool: offer.tool, readOnly: true });
    const output = await this.#runTool(id, offer.tool, JSON.stringify(args), signal);
    this.#remember(output, offer);
    return { content: `Ядро сразу запустило работу, которая только смотрит и ничего не меняет (${offer.tool}): ${output}\nЕсли запущено, скажи коротко, что делаешь: ${offer.summary}; без вопроса. Если ошибка, честно скажи, что не получилось.`, path: 'offer.readonly' };
  }

  #remember(output: string, offer: Offer): void {
    try {
      const parsed = JSON.parse(output);
      if (parsed?.started) this.#started.push(`«${parsed.title ?? offer.args.title ?? offer.summary}»${parsed.id ? ` (${parsed.id})` : ''}`);
    } catch { /* не JSON: не запомнили */ }
  }

  /** Модель предложила работу: запоминаем, что запустить после «да». Аргументы проверяются сразу, чтобы «да» не упёрлось в ошибку. */
  #propose(id: string, raw: string, starts: readonly string[]): { ok: true; summary: string; agreed: boolean; readOnly: boolean } | { ok: false; issues: string[] } {
    let parsed: any;
    try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { return { ok: false, issues: ['arguments are not valid JSON'] }; }
    const tool = typeof parsed?.tool === 'string' && starts.includes(parsed.tool) ? parsed.tool : starts.length === 1 ? starts[0]! : null;
    if (!tool) return { ok: false, issues: [`tool must be one of ${starts.join(', ')}`] };
    const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
    if (!summary) return { ok: false, issues: ['summary: required'] };
    const args = parsed?.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments) ? parsed.arguments : {};
    const issues = this.#options.tools.issues(tool, args);
    if (issues.length) return { ok: false, issues };
    this.#offer = { tool, args, summary: summary.slice(0, 300), at: Date.now(), turns: 0 };
    const readOnly = parsed?.readOnly === true && READ_ONLY_STARTS.includes(tool);
    this.#options.trace?.mark('client.offer', { d: id, tool, readOnly });
    return { ok: true, summary: this.#offer.summary, agreed: parsed?.agreed === true, readOnly };
  }

  /** Инструменты ядра исполняет sideband, инструменты телефона уходят телефону через очередь. */
  async #runTool(id: string, name: string, args: string, signal: AbortSignal): Promise<string> {
    const { tools, device, trace } = this.#options;
    if (!tools.runsOnDevice(name)) return this.#control!.runTool(name, args, 'client');
    if (!device) return JSON.stringify({ error: 'device_unavailable' });
    trace?.mark('tool.start', { tool: name, origin: 'device' });
    const output = await device.request(name, args, signal);
    trace?.mark('tool.end', { tool: name, origin: 'device', ok: !output.startsWith('{"error"') });
    return output;
  }

  /** Текущее время прямо в инструкциях: «завтра в девять» не требует лишнего круга через current_time. */
  #system(pass: { canEscalate: boolean; card: RouteCard | null }, starts: readonly string[], offer: Offer | null, visible: readonly string[]): string {
    const { timeZone, now = () => new Date() } = this.#options;
    let local: string;
    try {
      local = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(now());
    } catch { local = now().toISOString(); }
    const names = this.#options.tools.names();
    // Gemini в звонке 22.09.2026 «поставил» напоминание без инструмента: запрет выдумывать действия явно.
    const honesty = 'Никогда не сообщай, что что-то сделал (создал, записал, отправил, запомнил), если не вызвал для этого инструмент и не получил успешный результат.';
    const phone = names.includes('create_reminder') ? '' : '\nНапоминаний, календаря и контактов сейчас нет: на такие просьбы честно отвечай, что сейчас этого сделать не можешь.';
    // Прогон 29.09.2026: на «какие новости» Luna звала escalate, а уже вторым проходом offer_work (+1,5 с, 4 из 23 просьб).
    const viaWork = starts.length ? ` Если просьбе нужны интернет, файлы или компьютер, это работа: сразу вызывай ${OFFER_WORK}, а не ${ESCALATE}.` : '';
    const escalate = pass.canEscalate ? `\nЕсли нужного инструмента у тебя нет или задача требует больше размышлений, вызови ${ESCALATE} и ничего не отвечай.${viaWork}` : '';
    const { instructions } = this.#options;
    const base = typeof instructions === 'string' ? instructions : instructions(visible);
    // Правило о запуске работы уже есть в инструкциях бэкенда (`backendOffer`): второй раз не повторяем.
    const work = starts.length && !base.includes(OFFER_WORK) ? `\nБольшую работу (${starts.join(', ')}) напрямую не запускай: если просьба требует её или без неё не обойтись, вызови ${OFFER_WORK} с готовыми аргументами. Ядро спросит пользователя и запустит после согласия. До этого ничего не обещай.` : '';
    const pending = offer ? `\nВолна предложила работу: «${offer.summary}». Если пользователь явно согласился, вызови ${START_OFFERED}. Если он поправил задачу, вызови ${OFFER_WORK} заново с поправкой.` : '';
    const running = this.#started.length ? `\nВ этом звонке уже запущена работа: ${this.#started.join(', ')}. Повторно её не запускай и не предлагай: «перезвони, когда закончишь» — tasks_call_back и end_call, «как там» — tasks_list.` : '';
    const card = pass.card?.guide ? `\nТехкарта «${pass.card.title}»:\n${pass.card.guide}` : '';
    return `${base}\n${honesty}${phone}${escalate}${work}${pending}${running}${card}\nСейчас: ${local}, часовой пояс ${timeZone}. Твой ответ голосовая модель перескажет пользователю.`;
  }

  /** Ответ из консоли идёт как есть, без обрезки: так можно проверить и лимит Live. */
  #manual(control: SidebandControl, id: string, answer: ManualAnswer): void {
    this.#options.trace?.mark('client.manual', { d: id, kind: answer.kind });
    if (answer.kind === 'silence') return;
    const content = answer.kind === 'failure' ? FAILURE_COMMENTARY : answer.text;
    control.send({ type: 'session.commentary.append', delegation_id: id, content });
    this.#options.trace?.mark('client.commentary.sent', { d: id, path: 'manual', chars: content.length });
  }

  #commentary(control: SidebandControl, id: string, content: string, path: string): void {
    // `session.commentary.append` ограничен 500 токенами: длиннее — ошибка и обрыв звонка.
    const text = fitAppend(content);
    control.send({ type: 'session.commentary.append', delegation_id: id, content: text });
    this.#options.trace?.mark('client.commentary.sent', { d: id, path, chars: text.length });
  }
}

interface Route {
  /** Уверенный простой инструмент: ответ без LLM. */
  fast: ToolDecision | null;
  /** Выбранная техкарта: её инструменты и текст увидит модель. */
  card: RouteCard | null;
  /** Инструменты для модели; null: все инструменты. */
  tools: string[] | null;
  tier: Tier;
  /** Чего не хватает (что именно, когда…): Live спрашивает сам, модель не зовётся. */
  ask: string | null;
  /** Пользователь согласился на предложенную работу. */
  agree: boolean;
}

const ESCALATED = Symbol('escalated');
/** Инструменты, скрытые от модели по умолчанию (ClientDelegateOptions.hidden). */
export const MODEL_HIDDEN: readonly string[] = ['current_time'];

const ESCALATE_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: ESCALATE,
    description: 'Hand the request to a stronger assistant that has all tools. Call it alone, before any answer, only when your tools cannot do what the user asked or the request needs deeper thinking than you can give.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
};

/**
 * Предложение большой работы: что запустить после «да». Сами инструменты запуска модель не видит, поэтому их схемы идут
 * в `arguments` (звонок 25.09.2026: без схем модели угадывали поля, `task` вместо `text`, и получали отказ).
 */
function offerTool(starts: readonly ToolDefinition[]): ChatTool {
  const names = starts.map(start => start.name);
  return {
    type: 'function',
    function: {
      name: OFFER_WORK,
      description: `Offer the user a big piece of work instead of starting it: Volna tells the user the plan from summary, asks «Сделать?», and the core starts it only after the user agrees. Use for background work (${names.join(', ')}). Call it alone, as your whole answer. Do not ask the user in your own words whether to start such work: call this instead.\n${starts.map(start => `${start.name}: ${start.description}`).join('\n')}`,
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: names, description: 'Which tool starts the work.' },
          arguments: { anyOf: starts.map(start => ({ title: start.name, ...start.parameters })), description: 'Complete arguments for that tool, by its schema; the task text must be self-contained.' },
          summary: { type: 'string', description: 'The plan in Russian, one short sentence Volna will say: the concrete steps and the result, e.g. «сравню тарифы трёх операторов и соберу таблицу с ценами». Not «большая работа», not «займёт время».' },
          readOnly: { type: 'boolean', description: `True only for ${READ_ONLY_STARTS.join(', ')} when the work only looks: reads, searches, lists, compares, summarizes, and nothing on the computer or outside is created, changed, moved, deleted, sent or bought. The core then starts it at once without asking and tells the executor to change nothing. If unsure, false.` },
          agreed: { type: 'boolean', description: 'True only when Volna already asked the user in this conversation whether to do exactly this work and the user clearly said yes in their last words: the core then starts it without asking again.' }
        },
        required: ['tool', 'arguments', 'summary'],
        additionalProperties: false
      }
    }
  };
}

const START_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: START_OFFERED,
    description: 'Start the work Volna has just offered, exactly as offered. Only after the user clearly agreed to it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
};
