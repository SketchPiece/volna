import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { MemoryState } from '../memory/model.ts';
import { openFacts } from '../memory/store.ts';
import { CREATOR } from '../assistant/tools/about-wave.ts';
import { pickGreeting, dayPart, gapBucket } from './phrases.ts';

export type GreetingSource = 'phrase';

export interface GreetingComposerOptions {
  /** Каталог данных ядра: `greeting.json` с временем звонков и последними приветствиями. */
  dir: string;
  timeZone: string;
  log: Logger;
  /** Память о пользователе: из неё берётся только имя; на уровне cold ничего. */
  memory?: () => MemoryState;
  now?: () => Date;
  /** Источник случайности; в тестах подменяется. */
  random?: () => number;
}

const RECENT_GREETINGS = 8;
const KEEP_CALLS = 30;

const fileSchema = z.object({
  version: z.literal(1),
  calls: z.array(z.string()).default([]),
  recent: z.array(z.string()).default([])
});
type GreetingFile = z.output<typeof fileSchema>;

/**
 * Приветствие звонка выбирает код из набора фраз (greeting/phrases.ts) по времени суток, давности прошлого звонка и имени
 * из памяти. Без модели: звонок не ждёт её ответа, а фразы звучат как у человека, а не как сочинение. Тексты в лог не пишутся.
 */
export class GreetingComposer {
  readonly #options: GreetingComposerOptions;
  #file: GreetingFile = { version: 1, calls: [], recent: [] };
  #loaded = false;

  constructor(options: GreetingComposerOptions) { this.#options = options; }

  get #now(): Date { return (this.#options.now ?? (() => new Date()))(); }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try { this.#file = fileSchema.parse(JSON.parse(await readFile(join(this.#options.dir, 'greeting.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error; }
  }

  /**
   * Приветствие для начинающегося звонка. Звонок и фразу запоминает только `commit()`: его зовут, когда OpenAI принял звонок.
   * Иначе неудачная попытка считалась звонком, и повтор через минуту слышал «Что-то забыли?». `thread`: в памяти есть нить
   * для приветствия, после фразы будет вопрос о ней, поэтому фраза выбирается без вопроса.
   */
  async forCall({ thread = false }: { thread?: boolean } = {}): Promise<{ greeting: { text: string }; source: GreetingSource; commit: () => Promise<void> }> {
    await this.load();
    const now = this.#now;
    const last = this.#file.calls.at(-1);
    const name = nameFrom(this.#options.memory?.());
    const { text, lore } = pickGreeting({
      part: dayPart(localHour(now, this.#options.timeZone)),
      gap: gapBucket(last ? new Date(last) : null, now),
      name,
      creator: name === CREATOR,
      thread
    }, this.#file.recent, this.#options.random);
    this.#options.log.info('greeting picked', { lore, named: Boolean(name && text.includes(name)) });
    const commit = () => this.#remember(now, text);
    return { greeting: { text }, source: 'phrase', commit };
  }

  /**
   * Принятый звонок без фразы (перезвон Волны по заданиям начинается с итогов): его время всё равно давность следующего,
   * иначе звонок сразу после перезвона слышал бы «давно не слышались».
   */
  async markCall(): Promise<void> {
    await this.load();
    await this.#remember(this.#now, null);
  }

  async #remember(at: Date, text: string | null): Promise<void> {
    this.#file.calls = [...this.#file.calls, at.toISOString()].slice(-KEEP_CALLS);
    if (text) this.#file.recent = [...this.#file.recent, text].slice(-RECENT_GREETINGS);
    await this.#persist().catch(error => this.#options.log.warn('greeting state not saved', { error: error instanceof Error ? error.name : 'unknown' }));
  }

  async #persist(): Promise<void> {
    await mkdir(this.#options.dir, { recursive: true });
    const target = join(this.#options.dir, 'greeting.json');
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.#file, null, 2));
    await rename(temp, target);
  }
}

/**
 * Имя из профиля или факта, где предложение начинается с «Зовут Андрей» («Маму зовут Оля» не подходит); на уровне cold
 * и без такой записи — нет. Открыто для тестов.
 */
export function nameFrom(state: MemoryState | undefined): string | null {
  if (!state || state.level === 'cold') return null;
  const texts = [state.profile, ...openFacts(state).filter(fact => !fact.sensitive).map(fact => fact.text)];
  for (const text of texts) {
    const match = /(?:^|[.;!]\s*)(?:Меня зовут|Зовут|Имя:?)\s+([А-ЯЁ][а-яё]+)/.exec(text);
    if (match) return match[1]!;
  }
  return null;
}

function localHour(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}
