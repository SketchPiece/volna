import { z } from 'zod';

/** Регулятор близости: сколько Волна запоминает и насколько вовлекается. Хранится в ядре, меняется из приложения. */
export const CLOSENESS_LEVELS = ['cold', 'explicit', 'attentive', 'involved'] as const;
export type Closeness = typeof CLOSENESS_LEVELS[number];

export const CLOSENESS_TITLES: Record<Closeness, string> = {
  cold: 'Холодная',
  explicit: 'По просьбе',
  attentive: 'Замечает сама',
  involved: 'Вовлечённая'
};

export function isCloseness(value: unknown): value is Closeness {
  return typeof value === 'string' && (CLOSENESS_LEVELS as readonly string[]).includes(value);
}

/** Уровни, на которых транскрипт хранится и после звонка запускается извлечение. */
export function extractsAfterCall(level: Closeness): boolean {
  return level === 'attentive' || level === 'involved';
}

export const FACT_KINDS = ['preference', 'fact', 'episode', 'thread', 'insight'] as const;
export type FactKind = typeof FACT_KINDS[number];

/** Виды, которые живут в карточках; эпизоды и нити — лента, они только ссылаются на карточки. */
export const CARD_FACT_KINDS: ReadonlySet<FactKind> = new Set(['preference', 'fact', 'insight']);

export const factSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(FACT_KINDS),
  /** explicit: пользователь попросил запомнить; inferred: выделено из разговора или «сном». */
  origin: z.enum(['explicit', 'inferred']),
  sensitive: z.boolean().default(false),
  learnedAt: z.string(),
  /** Дата, к которой относится факт или нить (ISO date). */
  when: z.string().nullable().default(null),
  /** Закрытый факт больше не попадает в промпт, но остаётся в истории для recall. */
  closedAt: z.string().nullable().default(null),
  /** Нить уже поднималась в приветствии. */
  askedAt: z.string().nullable().default(null),
  callId: z.string().nullable().default(null),
  /**
   * Карточки, к которым относится запись (id). У факта и предпочтения первая — «своя» карточка; эпизод и нить ссылаются
   * на все, о ком и о чём они. Пусто: запись ещё не разложена, её разложит «сон».
   */
  cards: z.array(z.string()).default([])
});
export type Fact = z.output<typeof factSchema>;

/**
 * Категории карточек (docs/memory-design.md, 9). self, style и routine — по одной карточке с постоянным id, остальные
 * заводятся по одной на человека, интерес, проект, место.
 */
export const CARD_KINDS = ['self', 'style', 'routine', 'person', 'work', 'interest', 'place'] as const;
export type CardKind = typeof CARD_KINDS[number];

export const CARD_KIND_TITLES: Record<CardKind, string> = {
  self: 'Обо мне',
  style: 'Как со мной говорить',
  routine: 'Быт и привычки',
  person: 'Люди',
  work: 'Работа и проекты',
  interest: 'Интересы',
  place: 'Места'
};

/** Категории, у которых одна карточка на всё; её id совпадает с категорией. */
export const SINGLE_CARD_KINDS: readonly CardKind[] = ['self', 'style', 'routine'];

/** Карточка: одна вещь, о которой Волна знает (человек, интерес, проект, место) или раздел о самом владельце. */
export const cardSchema = z.object({
  id: z.string(),
  kind: z.enum(CARD_KINDS),
  title: z.string(),
  /** Другие имена, по которым карточку находят «recall» и извлечение («мама», «Оля»). */
  aliases: z.array(z.string()).default([]),
  /** Одна строка: суть, которую Волна держит в голове всегда. */
  summary: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable().default(null)
});
export type Card = z.output<typeof cardSchema>;

/**
 * Техкарты до 23.09.2026 жили здесь; теперь это скиллы в data/skills (skills/store.ts, docs/skills.md). Схема
 * осталась только для переноса: при старте ядра main.ts переносит их и очищает список.
 */
const techCardVersionSchema = z.object({ at: z.string(), title: z.string(), when: z.string(), rules: z.array(z.string()) });
export const techCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  when: z.string(),
  rules: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(techCardVersionSchema).default([])
});
export type TechCard = z.output<typeof techCardSchema>;

export const memoryStateSchema = z.object({
  version: z.literal(1),
  level: z.enum(CLOSENESS_LEVELS).default('attentive'),
  /** Разрешено ли хранить чувствительные темы (здоровье, политика, религия, идентичность). */
  allowSensitive: z.boolean().default(false),
  profile: z.string().default(''),
  facts: z.array(factSchema).default([]),
  cards: z.array(cardSchema).default([]),
  techCards: z.array(techCardSchema).default([]),
  lastDreamAt: z.string().nullable().default(null),
  updatedAt: z.string()
});
export type MemoryState = z.output<typeof memoryStateSchema>;

export function emptyState(now: Date): MemoryState {
  return { version: 1, level: 'attentive', allowSensitive: false, profile: '', facts: [], cards: [], techCards: [], lastDreamAt: null, updatedAt: now.toISOString() };
}

/** Реплика разговора для транскрипта. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface Transcript {
  callId: string;
  startedAt: string;
  endedAt: string;
  turns: Turn[];
}

/**
 * Операции над памятью: их выдаёт извлечение, «сон» и инструменты. В `cards` записи — id или название карточки; `card`
 * заводит или правит карточку (id null — новая, или та, чьё название уже есть), `merge_card` сливает карточку `id` в
 * `into`. `close` закрывает запись или карточку (вместе с её записями).
 */
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), text: z.string(), kind: z.enum(FACT_KINDS), sensitive: z.boolean(), when: z.string().nullable(), cards: z.array(z.string()).default([]) }),
  z.object({ op: z.literal('update'), id: z.string(), text: z.string(), when: z.string().nullable(), cards: z.array(z.string()).nullable().default(null) }),
  z.object({ op: z.literal('close'), id: z.string() }),
  z.object({ op: z.literal('card'), id: z.string().nullable(), kind: z.enum(CARD_KINDS), title: z.string(), aliases: z.array(z.string()), summary: z.string() }),
  z.object({ op: z.literal('merge_card'), id: z.string(), into: z.string() })
]);
/** Входной вид: `cards` можно не указывать (инструменты, тесты). */
export type Operation = z.input<typeof operationSchema>;

export const memoryUpdateSchema = z.object({
  profile: z.string().nullable(),
  operations: z.array(operationSchema)
});
/** Входной вид, как у Operation. */
export type MemoryUpdate = z.input<typeof memoryUpdateSchema>;
