import { CARD_FACT_KINDS, CARD_KIND_TITLES, CLOSENESS_TITLES, SINGLE_CARD_KINDS, type Card, type CardKind, type Closeness, type Fact, type MemoryState } from './model.ts';
import { openCards, openFacts } from './store.ts';

/** Сколько памяти уходит в инструкции сессии. Дальше работает инструмент recall. */
export const MAX_PROMPT_FACTS = 60;
export const MAX_PROMPT_CHARS = 4000;

/** Заголовки записей вне карточек: нити, эпизоды и ещё не разложенные «сном» факты. */
const KIND_TITLES: Record<Fact['kind'], string> = {
  preference: 'Предпочтения',
  fact: 'Факты',
  episode: 'Недавние разговоры',
  thread: 'Незакрытое из прошлых разговоров (может быть устаревшим; это не список текущей работы: что сейчас в работе и в тредах на компьютере, показывает только tasks_list)',
  insight: 'Наблюдения'
};


/** Блок промпта и его краткая форма, если целиком не влезает в бюджет. */
interface Block { full: string; short?: string; backend: boolean }

export interface MemoryContext {
  /** Секция инструкций сессии. Пустая строка на уровне cold. */
  section: string;
  /**
   * Та же секция для модели делегирования, без недавних разговоров: они идут в каждый запрос и почти всегда не нужны
   * (25.09.2026 это четверть промпта Sonnet даже на «который час»); прошлые звонки она читает через history_read.
   */
  backend: string;
  /** Нить, которую Волна поднимет в приветствии; выбирается только на уровне involved. */
  thread: Fact | null;
}

/**
 * Собирает секцию «Память» для инструкций сессии: правила уровня, профиль, факты по группам, нить для приветствия.
 * Промпт ограничен по размеру: свежее важнее старого, нити и предпочтения важнее эпизодов.
 */
export function buildMemoryContext(state: MemoryState, now: Date, { thread: withThread = true }: { thread?: boolean } = {}): MemoryContext {
  if (state.level === 'cold') return { section: '', backend: '', thread: null };
  const facts = openFacts(state);
  // `thread: false`: перезвон или готовые итоги работы, о нити в этом звонке не спрашивать (session-route.ts).
  const thread = withThread && state.level === 'involved' ? pickThread(facts, now) : null;
  const lines: string[] = [`Память. Уровень близости: «${CLOSENESS_TITLES[state.level]}».`, policy(state.level, Boolean(thread))];
  if (state.profile.trim()) lines.push(`Профиль пользователя: ${state.profile.trim()}`);

  const backend = [...lines];
  let budget = MAX_PROMPT_CHARS;
  for (const block of promptBlocks(state, facts, now)) {
    const text = block.full.length <= budget ? block.full : block.short && block.short.length <= budget ? block.short : null;
    if (!text) continue;
    budget -= text.length;
    lines.push(text);
    if (block.backend) backend.push(text);
  }
  // Когда о ней спросить, говорит правило приветствия (assistant/persona.ts, greetingRule).
  if (thread) lines.push(`Нить для приветствия: ${describe(thread)}. Спроси о ней одним коротким вопросом после приветствия.`);
  const usage = 'Память используй естественно: не перечисляй вслух, не выдумывай. Исправленный факт сохрани через remember.';
  lines.push(usage);
  backend.push('Прошлые разговоры не в промпте: если вопрос о них, читай history_read.', usage);
  return { section: lines.join('\n'), backend: backend.join('\n'), thread };
}

function policy(level: Closeness, thread: boolean): string {
  switch (level) {
    case 'explicit':
      return 'remember только по явной просьбе («запомни»), forget по просьбе забыть. Сам выводов о пользователе не делай.';
    case 'attentive':
      return 'remember и forget по явной просьбе; остальное выделится после звонка само. Темы из памяти поднимай только по делу.';
    case 'involved':
      return `remember и forget по явной просьбе; остальное выделится после звонка само. Раз за разговор можешь уместно уточнить что-то из памяти; если пользователь отвечает односложно или просит не лезть, больше не надо. Длину и тон подстраивай под его предпочтения.`;
    default:
      return '';
  }
}

/**
 * Порядок по важности: разделы о самом владельце, открытые нити, карточки (недавно тронутые первыми; не влезает целиком —
 * только название и суть, подробности через recall), неразложенные факты, свежие эпизоды, наблюдения. Старые эпизоды в
 * промпт не идут, их складывает «сон». Не больше MAX_PROMPT_FACTS записей.
 */
function promptBlocks(state: MemoryState, facts: Fact[], now: Date): Block[] {
  const recent = now.getTime() - 14 * 24 * 3600 * 1000;
  let count = 0;
  const take = (list: Fact[]) => {
    const taken = list.slice(0, Math.max(0, MAX_PROMPT_FACTS - count));
    count += taken.length;
    return taken;
  };
  const cards = openCards(state);
  const onCard = (card: Card) => facts.filter(f => CARD_FACT_KINDS.has(f.kind) && f.cards[0] === card.id);
  const list = (title: string, items: Fact[]) => [`${title}:`, ...items.map(fact => `- ${describe(fact)}`)].join('\n');
  const blocks: Block[] = [];

  for (const kind of SINGLE_CARD_KINDS) {
    const card = cards.find(c => c.kind === kind);
    const items = card ? take(onCard(card)) : [];
    if (items.length) blocks.push({ full: list(CARD_KIND_TITLES[kind], items), backend: true });
  }
  const threads = take(facts.filter(f => f.kind === 'thread'));
  if (threads.length) blocks.push({ full: list(KIND_TITLES.thread, threads), backend: true });

  for (const kind of ['person', 'work', 'interest', 'place'] as CardKind[]) {
    const ofKind = cards.filter(c => c.kind === kind);
    if (!ofKind.length) continue;
    blocks.push({ full: `${CARD_KIND_TITLES[kind]}:`, backend: true });
    for (const card of ofKind) {
      const head = `- ${cardLine(card)}`;
      const items = take(onCard(card));
      blocks.push({ full: [head, ...items.map(f => `  · ${describe(f)}`)].join('\n'), short: head, backend: true });
    }
  }

  const known = new Set(cards.map(c => c.id));
  const loose = facts.filter(f => CARD_FACT_KINDS.has(f.kind) && !known.has(f.cards[0] ?? ''));
  for (const kind of ['preference', 'fact'] as const) {
    const items = take(loose.filter(f => f.kind === kind));
    if (items.length) blocks.push({ full: list(KIND_TITLES[kind], items), backend: true });
  }
  const episodes = take(facts.filter(f => f.kind === 'episode' && Date.parse(f.learnedAt) >= recent));
  if (episodes.length) blocks.push({ full: list(KIND_TITLES.episode, episodes), backend: false });
  const insights = take(loose.filter(f => f.kind === 'insight'));
  if (insights.length) blocks.push({ full: list(KIND_TITLES.insight, insights), backend: true });
  return blocks;
}

/** «Мама (Оля): живёт в Берлине» — название, другие имена и суть. */
export function cardLine(card: Card): string {
  const names = card.aliases.length ? `${card.title} (${card.aliases.join(', ')})` : card.title;
  return card.summary ? `${names}: ${card.summary}` : names;
}

/** Нить, чья дата уже прошла (или без даты, но старше суток) и которую ещё не поднимали. Не чаще одной за звонок. */
export function pickThread(facts: Fact[], now: Date): Fact | null {
  const today = now.toISOString().slice(0, 10);
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  return facts.find(fact => fact.kind === 'thread' && !fact.askedAt && !fact.sensitive
    && (fact.when ? fact.when <= today : fact.learnedAt <= dayAgo)) ?? null;
}

export function describe(fact: Fact): string {
  const date = fact.when ?? (fact.kind === 'episode' ? fact.learnedAt.slice(0, 10) : null);
  return date ? `${fact.text} (${date})` : fact.text;
}
