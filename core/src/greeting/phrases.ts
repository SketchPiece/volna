/**
 * Фразы приветствия. Так отвечает на звонок близкий человек: коротко, по времени суток, иногда по имени. Повторы между
 * звонками нормальны, разнообразие даёт ситуация, а не новые слова. До 25.09.2026 фразу сочиняла дешёвая модель, и в живых
 * звонках выходило «Андрей, седьмой выход в эфир, лампа накалилась!» и «Снова я на линии, слушаю».
 *
 * Изредка вместо обычной фразы звучала отсылка к легенде (с 26.09.2026 выключено, см. LORE_SHARE) (assistant/tools/about-wave.ts): эфир, оркестр агентов, первый
 * серийный образец. Без описаний мира, радиостилизации и ламп: лампы есть в дизайне, а не в мире Волны.
 * Фразы без рода, чтобы годились при любом GENDER. `{name}` — имя из памяти.
 */

export type DayPart = 'night' | 'morning' | 'day' | 'evening';
export type Gap = 'none' | 'minutes' | 'hours' | 'day' | 'days' | 'long';

export interface Situation {
  part: DayPart;
  gap: Gap;
  /** Имя из памяти; `null`, если неизвестно или память холодная. */
  name: string | null;
  /** На связи конструктор (легенда): можно пошутить про «первый серийный». */
  creator: boolean;
  /**
   * В памяти есть нить для приветствия (memory/context.ts): после фразы Волна задаст о ней вопрос, поэтому фраза-вопрос
   * («Да?», «Не спится?») не годится: два вопроса подряд, а править фразу модель не должна. «Слушаю» тоже: сама Волна
   * тут же спрашивает (исключается, если в наборе остаётся другая фраза).
   */
  thread?: boolean;
}

type Bank = { plain: string[]; named: string[] };

const BY_PART: Record<DayPart, Bank> = {
  morning: { plain: ['Доброе утро', 'Доброе утро, слушаю', 'Да, слушаю'], named: ['Доброе утро, {name}', 'Да, {name}'] },
  day: { plain: ['Да, слушаю', 'Слушаю', 'Добрый день', 'Добрый день, слушаю'], named: ['Да, {name}', '{name}, слушаю', 'Добрый день, {name}'] },
  evening: { plain: ['Добрый вечер', 'Добрый вечер, слушаю', 'Да, слушаю'], named: ['Добрый вечер, {name}', 'Да, {name}'] },
  night: { plain: ['Доброй ночи', 'Да?', 'Слушаю', 'Не спится?'], named: ['Доброй ночи, {name}', 'Да, {name}?', '{name}, слушаю'] }
};

/** Давность прошлого звонка важнее времени суток, когда она заметна. */
const BY_GAP: Partial<Record<Gap, Bank>> = {
  none: { plain: ['Здравствуйте, это Волна', 'Здравствуйте, это Волна. Слушаю'], named: ['Здравствуйте, {name}, это Волна'] },
  minutes: { plain: ['Да?', 'Снова здравствуйте', 'Что-то забыли?'], named: ['Да, {name}?', 'Снова здравствуйте, {name}'] },
  long: { plain: ['О, давно не слышались', 'Давно Вас не было. Слушаю'], named: ['{name}, давно не слышались', 'О, {name}, давно не слышались'] }
};

/** Отсылки к легенде; `when` сужает, где фраза уместна. */
const LORE: { text: string; when?: (s: Situation) => boolean }[] = [
  { text: 'Волна в эфире, слушаю', when: s => s.gap !== 'minutes' },
  { text: 'Волна на приёме', when: s => s.gap !== 'minutes' },
  { text: 'Оркестр в сборе, слушаю', when: s => s.gap !== 'minutes' },
  { text: 'Ночной эфир. Слушаю', when: s => s.part === 'night' },
  { text: 'Доброе утро, эфир свободен', when: s => s.part === 'morning' && s.gap !== 'minutes' },
  { text: 'Все агенты ещё тут, слушаю', when: s => s.gap === 'minutes' },
  { text: 'Давно Вас не было в эфире', when: s => s.gap === 'long' },
  { text: 'Первый серийный на приёме', when: s => s.creator && s.gap !== 'minutes' },
  { text: '{name}, весь оркестр слушает', when: s => s.creator }
];

const LORE_TEXTS = new Set(LORE.map(line => line.text));
const NAME_SHARE = 0.35;
/**
 * Отсылки к легенде выключены 26.09.2026 по решению владельца: GPT-Live не произносил их по просьбе поздороваться
 * (0 из 6 звонков: «…весь оркестр слушает», «Все агенты ещё тут…» — молчание или своя фраза). Список выше оставлен,
 * чтобы возвращать по одной фразе и смотреть в логах; было 0.2.
 */
const LORE_SHARE = 0;
/** Сколько последних фраз не повторять дословно. */
const NO_REPEAT = 2;

const fill = (text: string, name: string | null) => (name ? text.replaceAll('{name}', name) : text);
const pick = <T>(items: readonly T[], random: () => number): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;

/**
 * Приветствие на звонок: примерно каждый пятый раз отсылка к легенде (не два раза подряд), иначе обычная фраза по давности
 * прошлого звонка или времени суток; по имени примерно в трети звонков. Последние две фразы дословно не повторяются.
 * С нитью для приветствия только фразы без вопроса и, где есть замена, без «слушаю»: в каждом наборе такие есть
 * (greeting/composer.test.ts).
 */
export function pickGreeting(s: Situation, recent: readonly string[] = [], random: () => number = Math.random): { text: string; lore: boolean } {
  const lastWasLore = recent.length > 0 && LORE.some(line => fill(line.text, s.name) === recent.at(-1));
  const fresh = (texts: string[]) => {
    const usable = texts.filter(text => (s.name || !text.includes('{name}')) && !(s.thread && text.includes('?')));
    const quiet = s.thread ? usable.filter(text => !/слушаю/i.test(text)) : usable;
    const all = (quiet.length ? quiet : usable).map(text => fill(text, s.name));
    const unused = all.filter(text => !recent.slice(-NO_REPEAT).includes(text));
    const notLast = all.filter(text => text !== recent.at(-1));
    return unused.length ? unused : notLast.length ? notLast : all;
  };
  const loreRoll = random();
  const lore = fresh(LORE.filter(line => !line.when || line.when(s)).map(line => line.text));
  if (!lastWasLore && loreRoll < LORE_SHARE && lore.length) return { text: pick(lore, random), lore: true };
  const bank = BY_GAP[s.gap] ?? BY_PART[s.part];
  const named = s.name && random() < NAME_SHARE ? fresh(bank.named) : [];
  return { text: pick(named.length ? named : fresh(bank.plain), random), lore: false };
}

/** Все фразы для просмотра (`npm run greetings`). */
export function allPhrases(): { group: string; texts: string[] }[] {
  return [
    ...Object.entries(BY_PART).map(([part, bank]) => ({ group: `время: ${part}`, texts: [...bank.plain, ...bank.named] })),
    ...Object.entries(BY_GAP).map(([gap, bank]) => ({ group: `давность: ${gap}`, texts: [...bank!.plain, ...bank!.named] })),
    { group: 'легенда', texts: [...LORE_TEXTS] }
  ];
}

export function dayPart(hour: number): DayPart {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'day';
  return hour < 23 ? 'evening' : 'night';
}

export function gapBucket(last: Date | null, now: Date): Gap {
  if (!last) return 'none';
  const hours = (now.getTime() - last.getTime()) / 3600_000;
  // «Что-то забыли?» звучит естественно только сразу после разговора.
  if (hours < 0.25) return 'minutes';
  if (hours < 12) return 'hours';
  if (hours < 36) return 'day';
  return hours < 24 * 7 ? 'days' : 'long';
}
