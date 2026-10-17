import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CARD_FACT_KINDS, CARD_KIND_TITLES, SINGLE_CARD_KINDS, emptyState, memoryStateSchema, type Card, type CardKind, type Fact, type FactKind, type MemoryState, type Operation, type Transcript } from './model.ts';

/**
 * Файловое хранилище памяти одного пользователя: `memory.json` и `transcripts/<дата>-<звонок>.json`.
 * Запись атомарная (временный файл + rename). Никаких зависимостей, для одного человека этого достаточно.
 */
export interface ApplyOptions {
  origin: Fact['origin'];
  callId?: string | null;
  now: Date;
  /** Явная просьба пользователя сохраняет и чувствительное; извлечение уважает allowSensitive. */
  allowSensitive?: boolean;
}

export interface ApplyResult {
  added: Fact[];
  updated: Fact[];
  closed: Fact[];
  /** Записи, в которые слился почти-дубль из add (nearDuplicate) вместо новой записи. */
  merged: Fact[];
  /** Чувствительные записи, отброшенные по настройке. */
  skipped: number;
  /** Заведённые, изменённые, слитые и закрытые карточки. */
  cards: Card[];
}

export class MemoryStore {
  readonly #dir: string;
  #state: MemoryState | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) { this.#dir = dir; }

  get dir(): string { return this.#dir; }

  async load(now: Date = new Date()): Promise<MemoryState> {
    if (this.#state) return this.#state;
    await mkdir(join(this.#dir, 'transcripts'), { recursive: true });
    try {
      const raw = await readFile(join(this.#dir, 'memory.json'), 'utf8');
      this.#state = memoryStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#state = emptyState(now);
    }
    return this.#state;
  }

  /** Текущее состояние; до load() пустое. */
  get state(): MemoryState { return this.#state ?? emptyState(new Date()); }

  /** Последовательное изменение с сохранением. Изменения внутри одной функции атомарны относительно других вызовов. */
  update<T>(mutate: (state: MemoryState) => T, now: Date = new Date()): Promise<T> {
    const run = async () => {
      const state = await this.load(now);
      const result = mutate(state);
      state.updatedAt = now.toISOString();
      await this.#persist(state);
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  apply(operations: Operation[], options: ApplyOptions): Promise<ApplyResult> {
    return this.update(state => applyOperations(state, operations, options), options.now);
  }

  async saveTranscript(transcript: Transcript): Promise<string> {
    await this.load();
    const name = `${transcript.startedAt.slice(0, 19).replace(/[:T]/g, '-')}-${transcript.callId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
    await writeFile(join(this.#dir, 'transcripts', name), JSON.stringify(transcript, null, 2));
    return name;
  }

  async listTranscripts(): Promise<string[]> {
    await this.load();
    return (await readdir(join(this.#dir, 'transcripts'))).filter(n => n.endsWith('.json')).sort();
  }

  async readTranscript(name: string): Promise<Transcript> {
    return JSON.parse(await readFile(join(this.#dir, 'transcripts', name), 'utf8')) as Transcript;
  }

  /** «Забыть всё»: профиль, факты и транскрипты. Настройки остаются. */
  async wipe(now: Date = new Date()): Promise<void> {
    await this.update(state => { state.profile = ''; state.facts = []; state.cards = []; state.techCards = []; state.lastDreamAt = null; }, now);
    await rm(join(this.#dir, 'transcripts'), { recursive: true, force: true });
    await mkdir(join(this.#dir, 'transcripts'), { recursive: true });
  }

  async #persist(state: MemoryState): Promise<void> {
    const target = join(this.#dir, 'memory.json');
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2));
    await rename(temp, target);
  }
}

export function newFactId(): string { return randomBytes(6).toString('hex'); }

/**
 * Чистая функция: применяет операции к состоянию. Вынесена для тестов и для инструментов. Сначала карточки (их заводят и
 * сливают в том же ответе, где на них ссылаются записи), потом записи в исходном порядке.
 */
export function applyOperations(state: MemoryState, operations: Operation[], options: ApplyOptions): ApplyResult {
  const now = options.now.toISOString();
  const result: ApplyResult = { added: [], updated: [], closed: [], merged: [], skipped: 0, cards: [] };
  const touch = (card: Card) => { card.updatedAt = now; if (!result.cards.includes(card)) result.cards.push(card); };
  const allowSensitive = options.allowSensitive ?? state.allowSensitive;
  /** Слитые в этом вызове карточки: ссылка на прежний id ведёт в новую. */
  const redirect = new Map<string, string>();
  const refs = (list: readonly string[] | null | undefined): string[] => [...new Set((list ?? []).flatMap(ref => {
    const card = findCard(state, redirect.get(ref) ?? ref, options.now);
    return card ? [card.id] : [];
  }))];

  for (const operation of operations) {
    if (operation.op === 'card') {
      const card = upsertCard(state, operation, now);
      if (card) touch(card);
    } else if (operation.op === 'merge_card') {
      const from = openCard(state, operation.id);
      const into = findCard(state, operation.into, options.now);
      if (!from || !into || from === into || SINGLE_CARD_KINDS.includes(from.kind)) continue;
      into.aliases = uniqueNames([...into.aliases, from.title, ...from.aliases], into.title);
      if (!into.summary) into.summary = from.summary;
      for (const fact of state.facts) if (fact.cards.includes(from.id)) fact.cards = [...new Set(fact.cards.map(id => id === from.id ? into.id : id))];
      from.closedAt = now;
      redirect.set(from.id, into.id);
      touch(from); touch(into);
    }
  }

  for (const operation of operations) {
    if (operation.op === 'add') {
      const text = operation.text.trim();
      if (!text) continue;
      if (operation.sensitive && !allowSensitive) { result.skipped++; continue; }
      const cards = refs(operation.cards);
      const same = nearDuplicate(state, text, operation.kind, operation.when ?? null, cards[0] ?? null);
      if (same) {
        mergeInto(same, text, operation, options.origin, now);
        same.cards = [...new Set([...same.cards, ...cards])];
        if (!result.merged.includes(same)) result.merged.push(same);
        continue;
      }
      const fact: Fact = {
        id: newFactId(), text, kind: operation.kind, origin: options.origin, sensitive: operation.sensitive,
        learnedAt: now, when: operation.when ?? null, closedAt: null, askedAt: null, callId: options.callId ?? null, cards
      };
      state.facts.push(fact);
      result.added.push(fact);
      for (const id of cards) touch(openCard(state, id)!);
    } else if (operation.op === 'update') {
      const fact = state.facts.find(f => f.id === operation.id && !f.closedAt);
      if (!fact) continue;
      fact.text = operation.text.trim() || fact.text;
      fact.when = operation.when ?? fact.when;
      if (operation.cards) fact.cards = refs(operation.cards);
      // Эпизод, продолженный в новом звонке, свежий: дата в дампе и срок в промпте (context.ts) считаются от последнего разговора.
      if (fact.kind === 'episode' && options.callId) fact.learnedAt = now;
      result.updated.push(fact);
    } else if (operation.op === 'close') {
      const fact = state.facts.find(f => f.id === operation.id && !f.closedAt);
      if (fact) { fact.closedAt = now; result.closed.push(fact); continue; }
      const card = openCard(state, operation.id);
      if (card) result.closed.push(...closeCard(state, card, now)), touch(card);
    }
  }
  return result;
}

/** Своя запись карточки: факт, предпочтение или наблюдение, у которого эта карточка первая. */
function ownedBy(fact: Fact, card: Card): boolean {
  return CARD_FACT_KINDS.has(fact.kind) && fact.cards[0] === card.id;
}

/**
 * Закрывает карточку и её собственные записи; эпизоды и нити, которые на неё ссылаются, остаются: в них бывает и другое.
 * Возвращает закрытые записи.
 */
export function closeCard(state: MemoryState, card: Card, now: string): Fact[] {
  card.closedAt = now;
  const closed = state.facts.filter(f => !f.closedAt && ownedBy(f, card));
  for (const fact of closed) fact.closedAt = now;
  return closed;
}

function openCard(state: MemoryState, id: string): Card | undefined {
  return state.cards.find(c => c.id === id && !c.closedAt);
}

/**
 * Карточка по id, названию или другому имени (без регистра и ё). Карточки-разделы (self, style, routine) находятся и по
 * id категории, и по её названию, и заводятся при первой ссылке (кроме `create: false`: поиск не меняет память).
 */
export function findCard(state: MemoryState, ref: string, now: Date, create = true): Card | null {
  const byId = openCard(state, ref);
  if (byId) return byId;
  const name = normalName(ref);
  if (!name) return null;
  const single = SINGLE_CARD_KINDS.find(kind => kind === ref || normalName(CARD_KIND_TITLES[kind]) === name);
  if (single) return create ? singleCard(state, single, now.toISOString()) : openCard(state, single) ?? null;
  return state.cards.find(c => !c.closedAt && [c.title, ...c.aliases].some(n => normalName(n) === name)) ?? null;
}

function singleCard(state: MemoryState, kind: CardKind, now: string): Card {
  const existing = openCard(state, kind);
  if (existing) return existing;
  const card: Card = { id: kind, kind, title: CARD_KIND_TITLES[kind], aliases: [], summary: '', createdAt: now, updatedAt: now, closedAt: null };
  state.cards = state.cards.filter(c => c.id !== kind);
  state.cards.push(card);
  return card;
}

/**
 * Заводит карточку или правит существующую. Новая с уже известным названием или другим именем правит ту же: так
 * извлечение не плодит вторую «Маму». Пустые summary и title не стирают прежние.
 */
function upsertCard(state: MemoryState, operation: Extract<Operation, { op: 'card' }>, now: string): Card | null {
  const title = operation.title.trim();
  let card = SINGLE_CARD_KINDS.includes(operation.kind) ? singleCard(state, operation.kind, now)
    : (operation.id ? openCard(state, operation.id) : undefined)
      ?? [title, ...operation.aliases].map(n => findCard(state, n, new Date(now))).find(c => c && !SINGLE_CARD_KINDS.includes(c.kind)) ?? undefined;
  if (!card) {
    if (!title) return null;
    card = { id: newFactId(), kind: operation.kind, title, aliases: [], summary: '', createdAt: now, updatedAt: now, closedAt: null };
    state.cards.push(card);
  } else if (title && !SINGLE_CARD_KINDS.includes(card.kind) && normalName(title) !== normalName(card.title)) {
    card.aliases = [...card.aliases, card.title];
    card.title = title;
  }
  if (!SINGLE_CARD_KINDS.includes(card.kind) && !SINGLE_CARD_KINDS.includes(operation.kind)) card.kind = operation.kind;
  card.aliases = uniqueNames([...card.aliases, ...operation.aliases], card.title);
  if (operation.summary.trim()) card.summary = operation.summary.trim();
  return card;
}

function uniqueNames(names: string[], title: string): string[] {
  const seen = new Set([normalName(title)]);
  return names.map(n => n.trim()).filter(n => {
    const key = normalName(n);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalName(name: string): string {
  return name.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Открытые карточки, недавно тронутые сверху. */
export function openCards(state: MemoryState): Card[] {
  return state.cards.filter(c => !c.closedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Открытые записи карточки: свои (ownedBy) и эпизоды, нити, чужие факты, которые на неё ссылаются. */
export function cardFacts(state: MemoryState, card: Card): { own: Fact[]; mentions: Fact[] } {
  const facts = openFacts(state).filter(f => f.cards.includes(card.id));
  return { own: facts.filter(f => ownedBy(f, card)), mentions: facts.filter(f => !ownedBy(f, card)) };
}

/**
 * Доля слов короткой записи, найденных в длинной, с которой add считается той же записью. Модель извлечения просят делать
 * update (extractor.ts), это страховка от её промахов: слова сравниваются грубо, поэтому порог строгий. Нити (напоминания,
 * встречи) различаются одним словом («купить печенье» и «купить шоколадку»), им нужно полное вхождение. 5/6 для фактов:
 * одно другое слово на шесть («Андрей не пьёт кофе после шести вечера» и «Любит кофе, но не пьёт его после шести вечера»),
 * но не на пять («Сын ходит в садик … по вторникам» и «Дочь …»). Эпизоды длинные, 0.8.
 */
export const NEAR_DUPLICATE: Record<FactKind, number> = { thread: 1, fact: 0.83, preference: 0.83, episode: 0.8, insight: 0.8 };

/** Слова без смысла для сравнения записей (ё уже заменена на е); в поиске (searchFacts) не используются. */
const FILLER = new Set(['очень', 'снова', 'опять', 'его', 'ее', 'это', 'для', 'что', 'как', 'уже', 'еще', 'или', 'при', 'все', 'тоже', 'также']);

/**
 * Открытая запись того же вида, которую текст повторяет другими словами: точное совпадение или вхождение слов короткой
 * записи в длинную не ниже NEAR_DUPLICATE; нити с разными датами разные. Меньше трёх слов только при полном совпадении
 * наборов («Зовут Андрей» не сливается с «Маму Андрея зовут Оля»); записи разных карточек не сливаются. Из нескольких берётся самая похожая, при равенстве новая.
 */
export function nearDuplicate(state: MemoryState, text: string, kind: FactKind, when: string | null = null, card: string | null = null): Fact | null {
  const lower = text.toLowerCase();
  const words = contentTokens(text);
  let best: { fact: Fact; similarity: number } | null = null;
  for (const fact of openFacts(state)) {
    if (fact.kind !== kind && fact.text.toLowerCase() !== lower) continue;
    if (kind === 'thread' && when && fact.when && when !== fact.when) continue;
    // «Живёт в Берлине» у мамы и у самого владельца — разные записи.
    if (card && fact.cards[0] && fact.cards[0] !== card) continue;
    const similarity = fact.text.toLowerCase() === lower ? 2 : overlap(words, contentTokens(fact.text));
    if (similarity >= NEAR_DUPLICATE[kind] && (!best || similarity > best.similarity)) best = { fact, similarity };
  }
  return best?.fact ?? null;
}

/** Доля слов короткого набора, найденных в длинном; 0, если наборы слишком малы для уверенного сравнения. */
export function overlap(a: string[], b: string[]): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2) return 0;
  const similarity = covered(long, short);
  if (short.length === 2 && (similarity < 1 || covered(short, long) < 1)) return 0;
  return similarity;
}

/** Как score, но числа только целиком: «1» не входит в «10». */
function covered(haystack: string[], needles: string[]): number {
  const same = (a: string, b: string) => /^\d/.test(a) || /^\d/.test(b) ? a === b : a.startsWith(b) || b.startsWith(a);
  return needles.filter(needle => haystack.some(word => same(word, needle))).length / needles.length;
}

/** Слова для сравнения записей: как tokens, но без слов-связок и с числами любой длины (время «05:00» и «10:00» различает напоминания). */
export function contentTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u)
    .filter(t => /^\d+$/.test(t) || (t.length > 2 && !FILLER.has(t)))
    .map(t => /^\d+$/.test(t) ? t : stem(t)))];
}

/**
 * Почти-дубль обновляет найденную запись. Текст берётся новый (поправка «Любит кофе, но не пьёт после шести» важнее
 * прежней), кроме двух случаев: новый целиком входит в старый и короче (ничего не добавил) или вывод модели ложится на
 * то, что владелец сказал сам (explicit не переписывается и не понижается до inferred). Запись считается услышанной заново.
 */
function mergeInto(fact: Fact, text: string, operation: Extract<Operation, { op: 'add' }>, origin: Fact['origin'], now: string): void {
  const keepOld = (fact.origin === 'explicit' && origin === 'inferred')
    || (text.length <= fact.text.length && covered(contentTokens(fact.text), contentTokens(text)) === 1);
  if (!keepOld) fact.text = text;
  if (origin === 'explicit') fact.origin = 'explicit';
  fact.sensitive ||= operation.sensitive;
  fact.when = operation.when ?? fact.when;
  fact.learnedAt = now;
}

/** Сколько дней живёт нить: без даты — от последнего упоминания, с датой — после даты события. */
export const THREAD_TTL_DAYS = 7;

/**
 * Нити, о которых давно не говорили. Закрыть нить мог только следующий разговор, поэтому «записать ребёнка в садик» из
 * звонка 26.09.2026 висела в каждом звонке до 07.10 и Волна выдавала её за текущую задачу.
 */
export function staleThreads(state: MemoryState, now: Date): Fact[] {
  const before = new Date(now.getTime() - THREAD_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  return state.facts.filter(f => f.kind === 'thread' && !f.closedAt && f.learnedAt < before && (!f.when || f.when < before.slice(0, 10)));
}

/** Открытые факты, новые сверху. */
export function openFacts(state: MemoryState): Fact[] {
  return state.facts.filter(f => !f.closedAt).sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));
}

/** Простой поиск без эмбеддингов: совпадение слов запроса с текстом; закрытые факты тоже находятся. */
export function searchFacts(state: MemoryState, query: string, limit = 8): Fact[] {
  const terms = tokens(query);
  if (!terms.length) return openFacts(state).slice(0, limit);
  return state.facts
    .map(fact => ({ fact, score: score(tokens(fact.text), terms) + (fact.closedAt ? 0 : 0.5) }))
    .filter(({ score }) => score > 0.5)
    .sort((a, b) => b.score - a.score || b.fact.learnedAt.localeCompare(a.fact.learnedAt))
    .slice(0, limit)
    .map(({ fact }) => fact);
}

export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 2).map(stem);
}
/** Грубая нормализация окончаний, достаточная для русского и английского в поиске по памяти. */
function stem(word: string): string { return word.length > 5 ? word.slice(0, -2) : word.length > 3 ? word.slice(0, -1) : word; }
export function score(haystack: string[], needles: string[]): number {
  let hits = 0;
  for (const needle of needles) if (haystack.some(word => word.startsWith(needle) || needle.startsWith(word))) hits++;
  return hits / needles.length;
}
