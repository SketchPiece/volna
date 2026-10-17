import type { JevAnswer, JevQuestion, JevRequest } from './client.ts';
import type { JevCard } from '../assistant/tools/registry.ts';
import type { Turn } from '../realtime/conversation.ts';

/**
 * Вопросы к Jev и разбор ответов:
 * - `goodbye`: прощается ли пользователь (раннее завершение звонка, jev/goodbye.ts);
 * - маршрут клиентского делегирования (delegation/client.ts, docs/tools-routing.md), одним запросом:
 *   `tool`: какой простой инструмент отвечает сразу, без LLM (кандидаты: инструменты с карточкой Jev, `ToolRegistry.jevCandidates`);
 *   `techcard`: какая техкарта нужна (модель увидит только её инструменты, `allowed-tools`); с 25.09.2026 вместо набора;
 *   `tier`: насколько задача сложная (от этого зависит модель, если уровня нет в техкарте);
 *   `missing`: чего в просьбе не хватает, чтобы сделать её сразу (тогда Волна спрашивает сама, без модели);
 *   `agree`: только когда Волна предложила работу (`offer_work`): согласился ли пользователь;
 * - `honesty`: заявляет ли готовый ответ модели делегирования о действии, которого её вызовы не подтверждают (delegation/honesty.ts).
 */
export interface Candidate { name: string; card: JevCard }

// С 23.09.2026 два класса: Opus убран, долгую и глубокую работу Волна отдаёт в «Работу» (агент в «Штурвале»), docs/tools-routing.md.
export type Tier = 'simple' | 'standard';
export const TIERS: readonly Tier[] = ['simple', 'standard'];
const TIER_CRITERIA: Readonly<Record<Tier, string>> = Object.freeze({
  simple: 'One clear action or lookup with obvious details: set a reminder, add an event, find a contact, remember a fact, list agents, a short fact from general knowledge.',
  standard: 'Several steps, a web search with a summary, comparing or combining information, a message that needs careful wording, advice or an explanation that needs thought.'
});

/** Ответы на вопрос `techcard` кроме имён техкарт. */
export const NO_TOOLS = 'none';
export const MIXED = 'mixed';

export const NONE = 'none';
const NONE_CRITERION = 'Anything else: small talk, a question the assistant answers from general knowledge, creating or changing anything, web search, reminders, calendar, contacts, messages, memory, or the user has not finished the request yet.';

export const GOODBYE_QUESTION: JevQuestion = {
  type: 'noul',
  instructions: 'Judging by the latest user words, is the user ending the phone call right now?',
  criteria: {
    true: 'The user says goodbye or asks to hang up or finish the call: «пока», «до свидания», «всё, спасибо, отбой», «клади трубку», «на этом всё». Thanks with «всё» and no new request also ends the call: «ладно, всё, спасибо большое», «всё, спасибо», «ну всё, спасибо тебе».',
    false: 'The user continues the conversation or asks for something, including «пока» meaning "for now / meanwhile" (for example «пока не надо», «пока подожди»), thanks followed by a request, a goodbye that also asks to be called back later («пока, перезвони, как всё будет готово»: the request must be recorded first), thanks for an answer without «всё» and before the user reacted to it, or an unfinished phrase.'
  }
};

/**
 * Прощание с просьбой перезвонить, пока идёт работа (26.09.2026: такой ход шёл через модель 9–13 с). Спрашивается,
 * только когда есть идущие задания; «да» — ядро само ставит перезвон и кладёт трубку (jev/goodbye.ts). С вечера 26.09.2026
 * прощанием считается и голая просьба «перезвони, когда закончится»: в звонке 26.09.2026 Волна сказала «перезвоню»,
 * а трубку не положила (Jev 0.5, модель позвала только `tasks_call_back`).
 */
export const CALLBACK_GOODBYE_QUESTION: JevQuestion = {
  type: 'noul',
  instructions: 'Background work is running for the user. Judging by the latest user words, is the user asking Volna to phone back when the work is done and has nothing else to discuss now, so the call can end?',
  criteria: {
    true: 'The user asks for a call back when the work is done, with or without a goodbye, and adds nothing else: «пока, перезвони, как всё будет готово», «всё, перезвони, когда закончишь», «ладно, жду звонка, пока», «позвони, как сделаешь, пока», «ты можешь мне перезвонить, когда она закончится», «перезвони, как будет готово», «набери, когда доделаешь». Such a request already means the call is over.',
    false: 'The user only asks about progress, asks for a call back and in the same words adds a new request or a question, asks to call back at some other time («перезвони в шесть», «через полчаса») or about something else, asks whether Volna can call back at all without asking for it, says goodbye without asking for a call back, or the phrase is unfinished.'
  }
};

const TURN_CHARS = 400;

export function jevState(turns: readonly Turn[]) {
  const conversation = turns.filter(t => t.text.trim()).map(t => ({ role: t.role, text: t.text.trim().slice(-TURN_CHARS) }));
  return { description: 'Live phone call with Volna, a Russian-speaking voice assistant. The last user entry may be unfinished.', conversation };
}

/** Техкарты, между которыми выбирает Jev: имя и «когда нужна» (`description`). Замер 25.09.2026: до 100 вариантов без потери точности. */
export interface CardOption { name: string; when: string }

/**
 * Чего не хватает в просьбе, чтобы сделать её сразу. Вопрос общий для всех техкарт: ядро применяет ответ, только если
 * выбрана простая техкарта с меняющим инструментом (delegation/client.ts), и говорит Live, о чём спросить.
 */
export const MISSING: Readonly<Record<string, { criterion: string; ask: string }>> = Object.freeze({
  // С 27.09.2026 и перезвон по времени: как у напоминания, Волна спрашивает, о чём напомнить (решение владельца).
  what: { criterion: 'What exactly: the content or subject is missing («напомни мне», «запиши», «напомни ему» without saying what); also a request to be called back at a time or after a while that does not say what the call is about («перезвони в шесть», «позвони мне через пять минут», «набери через полчаса»), unless the user said it is just a call («просто перезвони», «без напоминания»).', ask: 'что именно (для перезвона: о чём напомнить, когда Волна позвонит)' },
  when: { criterion: 'When: a date or time is required for this request and was not given (a meeting or event without a day).', ask: 'когда' },
  who: { criterion: 'Who: the person is unclear («позвони ему», «найди её номер» when nobody was named before).', ask: 'кто именно' },
  which: { criterion: 'Which one: the request refers to an existing item that cannot be identified («отметь то напоминание»).', ask: 'какое именно' }
});
export const NOTHING_MISSING = 'nothing';

export const AGREE_QUESTION: JevQuestion = {
  type: 'noul',
  instructions: 'The assistant has just offered to do a big piece of work and asked whether to do it. Does the user agree to start this work now?',
  criteria: {
    true: 'The user agrees: «да», «давай», «делай», «запускай», «конечно», possibly with a small addition to the same task.',
    false: 'The user declines, hesitates, changes the task substantially, asks something else, or has not answered the offer.'
  }
};

export interface RouteQuestionsOptions { missing?: boolean; offer?: boolean }

/** Один запрос на весь маршрут: быстрый инструмент, техкарта, класс и, по надобности, недостающее и согласие. */
export function routeRequest(turns: readonly Turn[], candidates: readonly Candidate[], cards: readonly CardOption[], { missing = false, offer = false }: RouteQuestionsOptions = {}): JevRequest {
  const questions: Record<string, JevQuestion> = {};
  if (candidates.length) {
    const criteria: Record<string, string> = { [NONE]: NONE_CRITERION };
    for (const { name, card } of candidates) criteria[name] = card.when;
    questions.tool = { type: 'choice', instructions: 'Which data does the assistant need to answer the latest user words right away?', criteria };
    for (const { name, card } of candidates) {
      for (const [arg, spec] of Object.entries(card.args ?? {})) {
        questions[`${name}.${arg}`] = { type: 'choice', instructions: spec.instructions, criteria: spec.options };
      }
    }
  }
  if (cards.length) {
    const criteria: Record<string, string> = {
      [NO_TOOLS]: 'No tools needed: small talk, or a question answered from general knowledge.',
      [MIXED]: 'Several of these at once, or unclear.'
    };
    for (const { name, when } of cards) criteria[name] = when;
    questions.techcard = { type: 'choice', instructions: 'Which skill does the assistant need to handle the latest user request?', criteria };
  }
  questions.tier = { type: 'choice', instructions: 'How hard is the latest user request for the assistant?', criteria: { ...TIER_CRITERIA } };
  if (missing) {
    const criteria: Record<string, string> = { [NOTHING_MISSING]: 'Nothing essential is missing: the request can be done right away, or it only asks for information, or it is not a request to do something, or it asks for a call back when the work is done («перезвони, как будет готово»).' };
    for (const [name, { criterion }] of Object.entries(MISSING)) criteria[name] = criterion;
    questions.missing = { type: 'choice', instructions: 'For the assistant to do the latest user request right away, what essential detail is missing?', criteria };
  }
  if (offer) questions.agree = AGREE_QUESTION;
  return { state: jevState(turns), questions };
}

export interface ToolDecision { tool: string; p: number; confidence: number | null; args: Record<string, unknown> }

export function readToolDecision(answers: Record<string, JevAnswer>, candidates: readonly Candidate[]): ToolDecision {
  const answer = answers.tool?.type === 'choice' ? answers.tool : null;
  const tool = answer?.choice ?? NONE;
  const card = candidates.find(c => c.name === tool)?.card;
  const args: Record<string, unknown> = { ...card?.fixed };
  for (const arg of Object.keys(card?.args ?? {})) {
    const value = answers[`${tool}.${arg}`];
    if (value?.type === 'choice') args[arg] = value.choice;
  }
  return { tool, p: answer ? (answer.probabilities[tool] ?? 0) : 0, confidence: answer?.confidence ?? null, args };
}

/** Выбор-ответ с вероятностью выбранного варианта; null, если Jev на вопрос не ответил. */
export function readChoice(answers: Record<string, JevAnswer>, question: string): { choice: string; p: number } | null {
  const answer = answers[question];
  if (answer?.type !== 'choice') return null;
  return { choice: answer.choice, p: answer.probabilities[answer.choice] ?? 0 };
}

/** Вероятность «да» у вопроса noul; null, если Jev не ответил. */
export function readYes(answers: Record<string, JevAnswer>, question: string): number | null {
  const answer = answers[question];
  return answer?.type === 'noul' ? answer.noul : null;
}

export function round(value: number | null): number | null { return value === null ? null : Math.round(value * 1000) / 1000; }

/**
 * Проверка честности (с 26.09.2026): ответ модели делегирования и её вызовы инструментов в этом проходе. Спрашивается,
 * только когда в ответе есть слова действия (предфильтр delegation/honesty.ts); решает Jev: он видит, что именно
 * сделано, поэтому «Поставил» после одного `current_time` ловится, а «Меня сделал Андрей» нет.
 */
export const HONESTY_QUESTION: JevQuestion = {
  type: 'noul',
  instructions: 'The backend wrote `reply` for Volna to say to the user; `toolCalls` are all tools it called for this reply (effect: read only looks, write or act changes something; ok: false means the call failed). Does the reply tell the user that Volna has done, is doing right now, or will do an action that changes something, while no successful write or act call in toolCalls did that action?',
  criteria: {
    true: 'The reply reports or promises an action that no successful changing call backs: «Поставил напоминание на девять» after only current_time, «Записал» or «Готово» with no tool calls, «Открою калькулятор и посчитаю» with no tool calls, «Отправил» after a failed call.',
    false: 'The reply only gives information, an answer or an opinion («Я считаю, лучше второй», «Сейчас десять»), speaks about the past or about someone else («Меня сделал Андрей»), asks or offers («Записать?»), honestly says it could not do something, or every action it reports is backed by a successful write or act call.'
  }
};

export interface ToolCallNote { tool: string; effect: string; ok: boolean }

const REPLY_CHARS = 600;

export function honestyRequest(turns: readonly Turn[], reply: string, toolCalls: readonly ToolCallNote[]): JevRequest {
  return { state: { ...jevState(turns), reply: reply.slice(0, REPLY_CHARS), toolCalls: [...toolCalls] }, questions: { honesty: HONESTY_QUESTION } };
}
