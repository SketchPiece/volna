import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import { CARD_KINDS, FACT_KINDS, SINGLE_CARD_KINDS, type Card, type MemoryState, type Operation } from './model.ts';
import { cardLine, describe } from './context.ts';
import { cardFacts, findCard, openCards, openFacts, searchFacts, tokens, score, type MemoryStore } from './store.ts';
import { TECHCARD_TOOL_NAMES } from '../skills/tools.ts';

/** Инструменты памяти и техкарт (skills/tools.ts): на уровне «Холодная» их нет в звонке. */
export const MEMORY_TOOL_NAMES: readonly string[] = ['remember', 'forget', 'recall', ...TECHCARD_TOOL_NAMES];

/** Инструменты памяти для Realtime. Явная просьба пользователя: origin explicit, чувствительное разрешено. */
export function memoryTools(store: MemoryStore): Tool[] {
  const remember = defineTool({
    name: 'remember',
    effect: 'write',
    description: 'Save something the user explicitly asked you to remember, or a correction of a remembered fact. One short statement per call, in Russian, understandable on its own («Мама живёт в Берлине»).',
    parameters: z.object({
      text: z.string().min(2).describe('What to remember, one sentence.'),
      kind: z.enum(FACT_KINDS).default('fact').describe('preference: how to talk; fact: durable fact; thread: upcoming event to ask about later'),
      when: z.string().nullable().default(null).describe('Date the fact or event refers to, YYYY-MM-DD, or null.'),
      about: z.string().nullable().default(null).describe('Who or what it is about, as the user calls it: «Мама», «Скалолазание»; null if about the user himself or how to talk.'),
      category: z.enum(CARD_KINDS).nullable().default(null).describe('Category of `about` when it is new: person, work, interest, place; for the user himself self, how to talk style, habits routine.')
    }),
    async execute({ text, kind, when, about, category }, context) {
      const operations: Operation[] = [];
      let card: string | null = category && SINGLE_CARD_KINDS.includes(category) ? category : null;
      if (about?.trim()) {
        card = about.trim();
        if (category && !SINGLE_CARD_KINDS.includes(category)) operations.push({ op: 'card', id: null, kind: category, title: card, aliases: [], summary: '' });
      }
      operations.push({ op: 'add', text, kind, sensitive: false, when, cards: card ? [card] : [] });
      const result = await store.apply(operations, { origin: 'explicit', callId: context.callId, now: context.now(), allowSensitive: true });
      // Почти-дубль сливается с прежней записью (store.ts, nearDuplicate): saved показывает, что теперь записано.
      return { saved: [...result.added, ...result.merged].map(f => f.text), duplicate: result.added.length === 0 };
    }
  });

  const forget = defineTool({
    name: 'forget',
    effect: 'write',
    description: 'Forget remembered facts matching a query when the user asks you to forget something. With whole=true forgets everything about a person, project, interest or place («забудь всё про работу»). Returns what was forgotten.',
    parameters: z.object({
      query: z.string().min(2).describe('Words describing what to forget; with whole=true the name of the person, project, interest, place or a category.'),
      whole: z.boolean().default(false).describe('Forget the whole card (or every card of a category) instead of single notes.')
    }),
    async execute({ query, whole }, context) {
      const cards = whole ? cardsFor(store.state, query, context.now()) : [];
      const matches = whole ? [] : searchFacts(store.state, query, 3).filter(f => !f.closedAt);
      if (!matches.length && !cards.length) return { forgotten: [] };
      const result = await store.apply([...cards, ...matches].map(f => ({ op: 'close' as const, id: f.id })), { origin: 'explicit', now: context.now() });
      return { forgotten: [...cards.map(c => c.title), ...result.closed.map(f => f.text)] };
    }
  });

  const recall = defineTool({
    name: 'recall',
    effect: 'read',
    description: 'Search long-term memory about the user when the answer may depend on something remembered that is not in your instructions, e.g. «что ты знаешь о маме». Returns the matching card with everything known about it, and matching notes, newest first.',
    parameters: z.object({ query: z.string().describe('What or whom to look for; empty string lists the latest notes.') }),
    execute({ query }, context) {
      const state = store.state;
      const card = query.trim() ? cardsFor(state, query, context.now(), false)[0] : undefined;
      const shown = card ? cardFacts(state, card) : null;
      const skip = new Set([...(shown?.own ?? []), ...(shown?.mentions ?? [])].map(f => f.id));
      const found = (query.trim() ? searchFacts(state, query) : openFacts(state).slice(0, 8)).filter(f => !skip.has(f.id));
      const notes = found.map(f => `${describe(f)}${f.closedAt ? ' (устарело)' : ''}`);
      if (!card || !shown) return { notes };
      return { card: { about: cardLine(card), known: shown.own.map(describe), related: shown.mentions.slice(0, 6).map(describe) }, notes };
    }
  });

  return [remember, forget, recall];
}

/**
 * Карточки по запросу: точное название или другое имя, иначе лучшее совпадение слов с названием, именами и сутью. С
 * `categories` запрос из одних слов категории («работа», «люди») даёт все её карточки (кроме разделов о самом владельце).
 */
function cardsFor(state: MemoryState, query: string, now: Date, categories = true): Card[] {
  const exact = findCard(state, query, now, false);
  if (exact) return [exact];
  const cards = openCards(state);
  const terms = tokens(query);
  if (categories) {
    const kind = CARD_KINDS.find(k => CATEGORY_WORDS[k] && score(tokens(CATEGORY_WORDS[k]), terms) === 1);
    if (kind) return cards.filter(c => c.kind === kind);
  }
  const best = cards.map(card => ({ card, score: score(tokens([card.title, ...card.aliases].join(' ')), terms) }))
    .filter(x => x.score >= 0.5).sort((a, b) => b.score - a.score)[0];
  return best ? [best.card] : [];
}

/** Слова, по которым находится категория целиком. */
const CATEGORY_WORDS: Record<Card['kind'], string> = {
  self: '', style: '', routine: '',
  person: 'люди', work: 'работа проекты', interest: 'интересы хобби', place: 'места'
};
