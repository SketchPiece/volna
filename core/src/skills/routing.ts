import type { ToolRegistry } from '../assistant/tools/registry.ts';
import { authorText } from './format.ts';
import type { SkillTier } from './format.ts';
import type { Skill } from './store.ts';

/**
 * Техкарта в маршруте звонка (docs/tools-routing.md): Jev выбирает её по описанию, модель класса видит только её
 * инструменты (`allowed-tools`) и её текст. Уровень (`metadata.tier`) решается при создании: `simple` и `standard` —
 * нижняя планка модели, `work` — большая работа, которую Волна предлагает сделать (планка `standard`).
 */
export interface RouteCard {
  name: string;
  title: string;
  when: string;
  /** Инструменты, которые увидит модель; пусто у техкарты из одних правил — тогда все инструменты звонка. */
  tools: string[];
  tier: SkillTier | null;
  /** Текст техкарты для модели: инструкции автора и правила владельца. */
  guide: string;
}

const GUIDE_CHARS = 3000;

/**
 * Техкарты, которые участвуют в маршруте этого звонка: хотя бы один их инструмент есть в реестре (маска `gmail_*`
 * тоже), и они не выключены из маршрута (`metadata.route: "off"`).
 *
 * Техкарта, заведённая голосом без `allowed-tools` (одни правила владельца), тоже идёт в маршрут: модель видит все
 * инструменты (`tools: []`), планка класса `standard`, Jev узнаёт её по названию и описанию. 26.09.2026 «Добавление и
 * изменение возможностей» в маршрут не попадала: «поправь у себя код» уходило в «Работу», «можешь изменять себя?» —
 * в «О Волне», и правило владельца (проект, отдельная ветка) модель не видела.
 * Маршрут техкарт уровня `work` получает `techcard_read`: задачу исполнителю составляют по правилам владельца.
 */
export function routeCards(skills: readonly Skill[], tools: ToolRegistry): RouteCard[] {
  const present = (skill: Skill) => tools.only(skill.tools).names().filter(name => skill.tools.some(pattern => matches(pattern, name)));
  const read = tools.only(['techcard_read']).names();
  return skills.filter(skill => skill.routed && (present(skill).length || textOnly(skill))).map(skill => {
    const names = present(skill);
    const author = authorText(skill.body).trim();
    const rules = skill.rules.length ? `Правила владельца (важнее инструкций):\n${skill.rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}` : '';
    return {
      name: skill.name, title: skill.title, when: routeWhen(skill),
      tools: skill.tier === 'work' ? [...new Set([...names, ...read])] : names,
      tier: skill.tier ?? (textOnly(skill) ? 'standard' : null),
      guide: [author, rules].filter(Boolean).join('\n\n').slice(0, GUIDE_CHARS)
    };
  });
}

/** Техкарта из одних правил владельца, заведённая голосом: в маршруте со всеми инструментами. */
export function textOnly(skill: Skill): boolean {
  return skill.byWave && !skill.tools.length;
}

/** Описание техкарты для Jev; у техкарты из одних правил с названием: её описание короткое, «когда владелец просит…». */
export function routeWhen(skill: Skill): string {
  return textOnly(skill) ? `${skill.title}: ${skill.description}` : skill.description;
}

/** Имя инструмента из `allowed-tools`: точное или маска `префикс*` (инструменты плагина, plugins/format.ts). */
function matches(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? pattern.length > 1 && name.startsWith(pattern.slice(0, -1)) : pattern === name;
}
