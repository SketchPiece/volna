import { z } from 'zod';
import type { Logger } from '../log.ts';
import { CARD_KIND_TITLES, CARD_KINDS, memoryUpdateSchema, type MemoryState, type MemoryUpdate, type Transcript } from './model.ts';
import { openCards, openFacts } from './store.ts';
import { OPENROUTER_CHAT_URL } from '../delegation/llm.ts';
import { openRouterUsage, scopedPurpose, usageScope, type UsageMeter } from '../usage/ledger.ts';

export interface ExtractorOptions {
  apiKey: string;
  /** Извлечение после звонка. */
  model: string;
  /** «Сон» и пересмотр характера: редкие, нужны выводы через несколько разговоров; по умолчанию `model`. */
  deepModel?: string;
  timeZone: string;
  log: Logger;
  url?: string;
  fetchImpl?: typeof fetch;
  /** Учёт расходов: разбор звонка, «сон» и пересмотр характера — самые дорогие вызовы ядра. */
  meter?: UsageMeter;
}

const RULES = `Ты часть голосового ассистента «Волна». Твоя работа: обновлять долговременную память об одном пользователе (хозяине).
Отвечай только JSON по схеме. Язык записей: русский, кратко, от третьего лица о пользователе («Пользователь…» не пиши, начинай с сути: «Живёт в Берлине», «Предпочитает короткие ответы»).
Виды записей: preference (как общаться, что нравится), fact (устойчивые факты: люди, места, работа, привычки), episode (что обсуждали в этом разговоре, одна строка), thread (открытая нить: предстоящее событие или незаконченное дело самого пользователя, которое уместно спросить позже; поле when = дата события в формате YYYY-MM-DD, если известна; работа, которую делает агент на компьютере, задания и треды — не нить: у них свой живой список, а нить о них устаревает и путает; напоминание или событие, которое ассистент уже создал, тоже не нить), insight (обобщение по нескольким разговорам; только для консолидации).
Операции: add для нового; update с id, когда существующая запись уточняется или меняется; close с id, когда запись устарела, опровергнута или нить закрыта: если в разговоре видно, что дело сделано, отменено или уже не важно, close его нить. Не дублируй существующее: то же самое другими словами (предпочтение, факт, нить) это update той записи с объединённым текстом, не add. Не добавляй мелочи, которые не пригодятся через неделю. Не записывай то, что ассистент сказал сам.
Чувствительное (sensitive: true): здоровье, диагнозы, политика, религия, национальность, сексуальность, гендерная идентичность, финансы в цифрах. Никогда не записывай номера документов, карт, пароли, адреса целиком, уголовные и миграционные детали: такие сведения пропускай.
Карточки: всё, что известно, раскладывается по карточкам. Категории: ${CARD_KINDS.map(k => `${k} (${CARD_KIND_TITLES[k]})`).join(', ')}. self, style и routine — по одной карточке, ссылайся на них по id категории (self, style, routine). person, work, interest, place — отдельная карточка на каждого человека, проект, интерес, место: заводи её операцией card (id null, title — как владелец его называет: «Мама», «Скалолазание», «Потсдам»; aliases — другие имена: «Оля»; summary — одна строка сути) и ссылайся на неё в поле cards записи по id или по title. Прежде чем заводить карточку, проверь, нет ли её уже под другим именем: тогда card с её id (дописать aliases, обновить summary). Две карточки об одном — merge_card (id в into). summary карточки обновляй операцией card, когда узнал о ней важное.
В cards записи первой идёт своя карточка: preference и fact почти всегда относятся к одной (о человеке — к его карточке; как говорить — style; привычки, режим, команды — routine; имя, где живёт, чем занимается — self). episode и thread ссылаются на все карточки, о ком и о чём они, или пустой список. Текст записи понятен и без карточки: «Мама живёт в Берлине», а не «Живёт в Берлине».
profile: два-шесть предложений о пользователе в целом (кто, чем живёт, как с ним говорить). Верни null, если профиль менять не нужно.`;

/**
 * JSON-схема для Structured Outputs. zod 4 превращает discriminatedUnion в `oneOf`, а строгий режим OpenAI принимает только
 * `anyOf` (400 invalid_json_schema, из-за этого память не обновлялась после звонков до 22.09.2026). Ветки различаются полем
 * `op`, поэтому `anyOf` здесь равносилен `oneOf`. `default` (поле `cards`, 26.09.2026) строгий режим тоже не знает: поле
 * и так обязательно, значение по умолчанию нужно только коду.
 */
export function schema(of: z.ZodType = memoryUpdateSchema): Record<string, unknown> {
  return toAnyOf(z.toJSONSchema(of, { target: 'draft-7' })) as Record<string, unknown>;
}

function toAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toAnyOf);
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'default').map(([key, value]) => [key === 'oneOf' ? 'anyOf' : key, toAnyOf(value)]));
}

function memoryDump(state: MemoryState): string {
  const facts = openFacts(state);
  const cards = openCards(state);
  const titles = new Map(cards.map(c => [c.id, c.title]));
  return [
    `Профиль сейчас: ${state.profile.trim() || '(пусто)'}`,
    'Карточки сейчас (id · категория · название · другие имена · суть):',
    ...(cards.length ? cards.map(c => `${c.id} · ${c.kind} · ${c.title} · ${c.aliases.join(', ') || '-'} · ${c.summary || '-'}`) : ['(нет)']),
    'Записи сейчас (id · вид · записано · карточки · текст · дата события):',
    ...facts.map(f => `${f.id} · ${f.kind} · ${f.learnedAt.slice(0, 10)} · ${f.cards.map(id => titles.get(id) ?? id).join(', ') || '-'} · ${f.text}${f.when ? ` · ${f.when}` : ''}`)
  ].join('\n');
}

export function dateLine(now: Date, timeZone: string): string {
  return `Сегодня ${new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now)} (${now.toISOString().slice(0, 10)}).`;
}

/**
 * Вызов текстовой модели со строгой JSON-схемой: OpenAI-совместимый `chat/completions` (по умолчанию OpenRouter, как у
 * делегирования). Тело ответа при ошибке не логируется. Claude иногда оборачивает JSON в ```json — обёртка снимается.
 * Первый «сон» после перехода на карточки (26.09.2026) заводит их все разом и не влезал в 4000 токенов ответа.
 */
export async function askStructured<S extends z.ZodType>(options: ExtractorOptions, name: string, of: S, system: string, user: string, signal?: AbortSignal, model = options.model): Promise<z.output<S>> {
  const { fetchImpl = fetch, url = OPENROUTER_CHAT_URL } = options;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model, max_tokens: 16000, usage: { include: true },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: schema(of) } }
    })
  });
  if (!response.ok) throw new Error(`memory model ${response.status}`);
  const body: any = await response.json();
  options.meter?.record({ purpose: scopedPurpose(name === 'persona_review' ? 'persona_review' : 'memory_extract'), model, ...openRouterUsage(body.usage) });
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('memory model: no output text');
  return of.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
}

const ask = (options: ExtractorOptions, system: string, user: string, signal?: AbortSignal, model = options.model): Promise<MemoryUpdate> =>
  askStructured(options, 'memory_update', memoryUpdateSchema, system, user, signal, model);

/**
 * Правило эпизода. До 26.09.2026 было «добавь одну запись episode», и каждый звонок на ту же тему добавлял новую
 * (шесть «проверить пять файлов в Загрузках» за три дня). Страховка от промахов модели: nearDuplicate в store.ts.
 */
export const EPISODE_RULE = 'Если разговор продолжает или повторяет открытый эпизод или нить о той же задаче или теме, сделай update этого id объединённым текстом («Несколько раз просил … (23–26.09); итог: …») вместо add. Новый episode с сутью разговора добавляй, только если такого нет и разговор был содержательным.';

/** Извлечение после звонка: транскрипт + текущая память → операции. */
export function extractFromTranscript(options: ExtractorOptions, state: MemoryState, transcript: Transcript, now: Date, signal?: AbortSignal): Promise<MemoryUpdate> {
  const dialogue = transcript.turns.map(t => `${t.role === 'user' ? 'Пользователь' : 'Волна'}: ${t.text}`).join('\n');
  const system = `${RULES}\n${dateLine(now, options.timeZone)}\nЗадача: прочитай разговор и обнови память. ${EPISODE_RULE}\n${memoryDump(state)}`;
  return ask(options, system, `Разговор:\n${dialogue}`, signal);
}

/** «Сон»: консолидация без нового разговора. Сливает дубли, переводит прошедшее в прошедшее время, складывает эпизоды в наблюдения. */
export function dream(options: ExtractorOptions, state: MemoryState, now: Date, signal?: AbortSignal): Promise<MemoryUpdate> {
  const system = `${RULES}\n${dateLine(now, options.timeZone)}\nЗадача: консолидация памяти между разговорами. Слей дубли (update одного, close остальных): записи об одном и том же другими словами и эпизоды об одной задаче или теме, какой бы давности они ни были; эпизоды сливай в самый новый с диапазоном дат, остальные close. Переформулируй устаревшее в прошедшем времени или закрой, закрой нити, чья дата прошла больше двух недель назад, эпизоды старше двух недель сверни в записи их карточек или в одну-две записи insight и закрой. Разложи по карточкам записи без карточек (update с cards, при нужде заведи карточку операцией card); сведения из профиля, которых нет в записях, добавь записями в свои карточки. Слей карточки об одном и том же (merge_card), обнови summary карточек по их записям, закрой пустые карточки, о которых ничего не осталось. Обнови профиль, если он расходится с записями. Не добавляй ничего, чего нет в записях или профиле.\n${memoryDump(state)}`;
  return usageScope({ purpose: 'memory_dream' }, () => ask(options, system, 'Проведи консолидацию.', signal, options.deepModel));
}
