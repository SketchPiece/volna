import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import { authorText } from './format.ts';
import { PLUGIN_WORDS } from '../plugins/format.ts';
import { MAX_READ_CHARS, MAX_SKILL_RULES, type Skill, type SkillStore } from './store.ts';

export const TECHCARD_TOOL_NAMES: readonly string[] = ['techcard_read', 'techcard_write', 'techcard_delete'];

const SOURCE_TITLES: Record<Skill['source'], string> = { owner: 'владельца', builtin: 'встроенная', external: 'внешняя', plugin: PLUGIN_WORDS.from };

const cardView = (skill: Skill) => {
  const instructions = authorText(skill.body);
  return {
    title: skill.title,
    when: skill.description,
    source: SOURCE_TITLES[skill.source],
    rules: skill.rules.map((rule, i) => `${i + 1}. ${rule}`),
    ...(instructions ? { instructions: instructions.slice(0, MAX_READ_CHARS), truncated: instructions.length > MAX_READ_CHARS || undefined } : {}),
    ...(skill.files.length ? { files: skill.files } : {})
  };
};

/**
 * Техкарты: скиллы в формате Agent Skills (skills/store.ts, docs/skills.md). Голос пишет только правила владельца,
 * целиком (прочитал → поправил список → записал), прежняя версия остаётся в истории. Текст скилла из интернета
 * голосом не правится. Скрипты из скиллов ядро не запускает.
 */
export function techCardTools(skills: SkillStore): Tool[] {
  const read = defineTool({
    name: 'techcard_read',
    always: true,
    effect: 'read',
    description: 'Read a tech card (техкарта): how a kind of work is done — the author\'s instructions and the owner\'s rules. Call before any work a card from the list may cover, and before changing a card. Empty topic lists all cards. Pass file to read a file the card lists.',
    parameters: z.object({
      topic: z.string().describe('Card title or what the work is about; empty string lists all cards.'),
      file: z.string().default('').describe('Optional: a path from the card\'s files, e.g. references/style.md.')
    }),
    async execute({ topic, file }) {
      const all = await skills.list();
      const list = all.map(skill => ({ title: skill.title, when: skill.description }));
      if (!topic.trim()) return { cards: list };
      const skill = await skills.find(topic);
      if (!skill) return { found: false, cards: list };
      if (!file.trim()) return { card: cardView(skill) };
      const content = await skills.readFile(skill, file.trim());
      return content ? { card: skill.title, file: file.trim(), ...content } : { card: skill.title, file: file.trim(), found: false, files: skill.files };
    }
  });

  const write = defineTool({
    name: 'techcard_write',
    always: true,
    effect: 'write',
    description: `Create or rewrite the owner's rules in a tech card. Only rules the owner stated or answered in this conversation. Pass the full rule list: rules left out are removed (read the card first). Up to ${MAX_SKILL_RULES} short rules in Russian. The card's own instructions are not changed.`,
    parameters: z.object({
      title: z.string().min(2).max(80).describe('Card title in Russian, two to five words, e.g. «Разработка Волны». Same title updates the card.'),
      when: z.string().min(2).max(200).describe('When the card applies, one Russian phrase, e.g. «когда владелец просит поправить или доработать Волну».'),
      rules: z.array(z.string().min(2).max(300)).max(MAX_SKILL_RULES).describe('All owner rules of the card, one statement each.')
    }),
    async execute({ title, when, rules }) {
      const { skill, created } = await skills.writeRules({ title, when, rules });
      return { saved: skill.title, created, rules: skill.rules.length };
    }
  });

  const remove = defineTool({
    name: 'techcard_delete',
    always: true,
    effect: 'write',
    description: 'Delete a whole tech card, only when the owner explicitly asks to delete it. For a built-in card only the owner\'s rules are removed.',
    parameters: z.object({ title: z.string().min(2).describe('Card title as the owner named it.') }),
    async execute({ title }) {
      const skill = await skills.find(title);
      if (!skill) return { deleted: false, cards: (await skills.list()).map(s => s.title) };
      const result = await skills.remove(skill.name);
      return result === 'removed' ? { deleted: true, title: skill.title } : { deleted: false, title: skill.title, reason: 'built-in card: cannot be deleted by voice' };
    }
  });

  return [read, write, remove];
}
