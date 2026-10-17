import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { CARD_KIND_TITLES, CARD_KINDS, CLOSENESS_LEVELS, CLOSENESS_TITLES } from '../memory/model.ts';
import type { MemoryService } from '../memory/service.ts';
import type { PersonaStore } from '../persona/store.ts';
import { closeCard, openCards, openFacts } from '../memory/store.ts';
import type { SkillStore } from '../skills/store.ts';

const settingsSchema = z.object({
  level: z.enum(CLOSENESS_LEVELS).optional(),
  allowSensitive: z.boolean().optional()
});
const factSchema = z.object({ text: z.string().trim().min(2).max(300) });

/** REST для экрана «Память» в приложении: посмотреть, изменить уровень, добавить и удалить запись или карточку, удалить техкарту, вернуть заводской характер, забыть всё. */
export function memoryRoutes(memory: MemoryService, auth: MiddlewareHandler, persona?: PersonaStore, skills?: SkillStore): Hono {
  const app = new Hono();
  app.use(auth);

  // Техкарты — скиллы (skills/store.ts); id — имя скилла. fresh: номера правил (с нуля), которых не было в прошлой версии;
  // экран красит их номер. source и instructions экран пока не показывает (docs/skills.md, 5).
  const techCards = async () => {
    if (!skills) return [];
    return Promise.all((await skills.list()).filter(skill => !skill.system).map(async skill => {
      const history = await skills.history(skill.name);
      const previous = history.at(-1)?.rules;
      const fresh = previous ? skill.rules.flatMap((rule, i) => previous.includes(rule) ? [] : [i]) : [];
      return { id: skill.name, title: skill.title, when: skill.description, rules: skill.rules, fresh, updatedAt: skill.updatedAt, versions: history.length + 1, source: skill.source };
    }));
  };

  const view = async () => {
    const state = await memory.store.load();
    const transcripts = (await memory.store.listTranscripts()).length;
    const character = persona ? await persona.load() : null;
    return {
      transcripts,
      level: state.level,
      levelTitle: CLOSENESS_TITLES[state.level],
      levels: CLOSENESS_LEVELS.map(level => ({ id: level, title: CLOSENESS_TITLES[level] })),
      allowSensitive: state.allowSensitive,
      profile: state.profile,
      facts: openFacts(state).map(f => ({ id: f.id, text: f.text, kind: f.kind, origin: f.origin, when: f.when, learnedAt: f.learnedAt, cards: f.cards })),
      // Карточки по категориям (docs/memory-design.md, 9): свои записи — те, у которых эта карточка первая.
      categories: CARD_KINDS.map(kind => ({ id: kind, title: CARD_KIND_TITLES[kind] })),
      cards: openCards(state).map(c => ({ id: c.id, kind: c.kind, title: c.title, aliases: c.aliases, summary: c.summary, updatedAt: c.updatedAt })),
      techCards: await techCards(),
      // Личный слой характера и история, новые изменения первыми; null, если ядро собрано без персоны.
      persona: character ? {
        traits: character.traits,
        changes: [...character.changes].reverse().map(c => ({ at: c.at, why: c.why, after: c.after, calls: c.calls })),
        lastReviewAt: character.lastReviewAt
      } : null,
      updatedAt: state.updatedAt,
      lastDreamAt: state.lastDreamAt
    };
  };

  app.get('/', async c => c.json(await view()));

  app.put('/settings', async c => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Неверные настройки памяти.' }, 400);
    await memory.store.update(state => {
      if (parsed.data.level) state.level = parsed.data.level;
      if (parsed.data.allowSensitive !== undefined) state.allowSensitive = parsed.data.allowSensitive;
    });
    return c.json(await view());
  });

  app.post('/facts', async c => {
    const parsed = factSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Запись должна быть от 2 до 300 символов.' }, 400);
    await memory.store.apply([{ op: 'add', text: parsed.data.text, kind: 'fact', sensitive: false, when: null }], { origin: 'explicit', now: new Date(), allowSensitive: true });
    return c.json(await view());
  });

  app.delete('/facts/:id', async c => {
    const result = await memory.store.apply([{ op: 'close', id: c.req.param('id') }], { origin: 'explicit', now: new Date() });
    if (!result.closed.length) return c.json({ error: 'Запись не найдена.' }, 404);
    return c.json(await view());
  });

  app.delete('/cards/:id', async c => {
    const found = await memory.store.update(state => {
      const card = state.cards.find(x => x.id === c.req.param('id') && !x.closedAt);
      if (card) closeCard(state, card, new Date().toISOString());
      return Boolean(card);
    });
    if (!found) return c.json({ error: 'Карточка не найдена.' }, 404);
    return c.json(await view());
  });

  app.delete('/techcards/:id', async c => {
    const result = skills ? await skills.remove(c.req.param('id')) : 'missing';
    if (result === 'missing') return c.json({ error: 'Техкарта не найдена.' }, 404);
    if (result === 'readonly') return c.json({ error: 'Эта техкарта встроена в Волну или лежит вне её, удалить её отсюда нельзя.' }, 409);
    return c.json(await view());
  });

  app.post('/persona/reset', async c => {
    if (!persona) return c.json({ error: 'Характер в этом ядре не ведётся.' }, 404);
    await persona.reset(new Date());
    return c.json(await view());
  });

  app.post('/dream', async c => {
    await memory.runDream();
    return c.json(await view());
  });

  app.delete('/', async c => {
    await memory.store.wipe();
    await skills?.wipeOwn();
    return c.json(await view());
  });

  return app;
}
