import { z } from 'zod';
import { defineTool, type Tool } from '../assistant/tools/registry.ts';
import type { TaskRunner } from '../tasks/runner.ts';
import { PASS_SHARE, ROUTING_PROBES } from './check.ts';

export interface TechcardCreateOptions {
  runner: TaskRunner;
  /** Папка техкарт владельца (`data/skills`): сюда агент пишет новую техкарту. */
  ownerDir: string;
  /** Папка ядра: там агент запускает проверку `npm run skills -- check`. */
  serverDir: string;
  /** Инструменты, которые техкарта может назвать в `allowed-tools`. */
  toolNames: () => readonly string[];
}

/**
 * Новая техкарта голосом (docs/skills.md, решение владельца 25.09.2026): пишет её не Волна, а агент на Mac со скиллом
 * skill-creator от Anthropic. Волна только передаёт просьбу владельца и вопросы агента. Запуск — большая работа
 * (`startsWork`): Волна сначала спрашивает с планом «<что сделаю>. Сделать?». Правила для Волны идут
 * в задании поверх skill-creator, без его форка.
 */
export function techcardCreateTool({ runner, ownerDir, serverDir, toolNames }: TechcardCreateOptions): Tool {
  return defineTool({
    name: 'techcard_create',
    effect: 'act',
    startsWork: true,
    description: 'Have an agent on the Mac write a new tech card (техкарта) with the skill-creator skill, or rework an existing one substantially: when the owner asks to teach Volna a new kind of work or to create a tech card. The agent asks its questions through Volna. For a quick change of the owner\'s rules use techcard_write instead.',
    parameters: z.object({
      title: z.string().min(2).max(80).describe('Two to five words naming the card, in Russian.'),
      request: z.string().min(5).max(4000).describe('What the owner wants the card to do, in their words from the conversation, self-contained: when it applies, what to do, what to use.')
    }),
    async execute({ title, request }) {
      const task = await runner.start({ title: `Техкарта: ${title}`.slice(0, 80), prompt: creationPrompt({ title, request, ownerDir, serverDir, tools: toolNames() }), callback: 'notify' });
      return { started: true, id: task.id, title, say: 'Принято, займусь техкартой. Если будут вопросы, спрошу.' };
    }
  });
}

/** Задание агенту: skill-creator плюс правила Волны. Вопросы агента Волна зачитывает голосом, поэтому они короткие. */
export function creationPrompt({ title, request, ownerDir, serverDir, tools }: { title: string; request: string; ownerDir: string; serverDir: string; tools: readonly string[] }): string {
  return `Создай техкарту для голосовой ассистентки Волны с помощью скилла skill-creator (если его нет, следуй правилам ниже сам).

Просьба владельца (из голосового разговора): «${request}»
Рабочее название: «${title}».

Правила Волны поверх skill-creator:
1. Папка: ${ownerDir}/<name>/SKILL.md, name — строчная латиница и дефисы. Если техкарта с таким смыслом уже есть в ${ownerDir}, доработай её, не дублируй.
2. Frontmatter: name; description — одна нейтральная фраза по-русски «когда …»: по ней маршрутизатор Jev выбирает техкарту среди ~100 других, поэтому точно и без «напористых» расширений; allowed-tools — через пробел, только из этого списка: ${tools.join(' ') || '(инструментов нет)'}; metadata: title (по-русски), tier, origin: "volna".
3. tier: simple — одно действие с понятными данными; standard — несколько шагов, сводка, текст с аккуратными формулировками; work — долгая работа в фоне. Реши сам; спрашивай, только если действительно не ясно.
4. Вопросы владельцу задавай через свой инструмент вопросов пользователю: Волна зачитает их голосом. По одному, коротко. Формулируй как своё мнение с просьбой подтвердить («Мне кажется, это нужно раз в неделю. Так?»), а не как выбор из вариантов.
5. Тело — инструкции для модели, которая будет делать эту работу; раздел «## Правила владельца» оставь для правил, которые владелец сказал сам.
6. Проверка маршрута: запиши ${ROUTING_PROBES} с полями should (8 просьб по-русски, для которых техкарта нужна) и shouldNot (8 похожих, для которых нет). Запусти в ${serverDir}: npm run skills -- check <name>. Нужно не меньше ${Math.round(PASS_SHARE * 100)}% в обеих группах. Если не проходит, уточни description и повтори, не больше трёх раз; если так и не прошла, поставь metadata.route: "off" (техкарта останется текстом) и скажи об этом в итоге.
7. Просмотрщик результатов skill-creator не запускай: владелец слушает итог голосом. Итог — две-три фразы: что умеет техкарта, её уровень и прошла ли проверка.
Скрипты техкарт ядро не запускает: не полагайся на них.`;
}
