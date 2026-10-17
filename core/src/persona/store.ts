import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Личный слой характера Волны: несколько фраз о том, каким Волна стал с этим владельцем. Заводской характер живёт в коде
 * (`assistant/persona.ts`, CORE) и не меняется; слой лежит поверх него, сброс к заводскому делает слой пустым.
 * Меняется только осторожным пересмотром после звонков (review.ts), не по просьбе в разговоре. docs/memory-design.md, 8.
 */
export const MAX_TRAITS_CHARS = 700;
export const MAX_CHANGES = 30;

/** calls: на скольких разговорах основан пересмотр; 0 у сброса. */
const changeSchema = z.object({ at: z.string(), before: z.string(), after: z.string(), why: z.string(), calls: z.number().int().default(0) });
export type PersonaChange = z.output<typeof changeSchema>;

export const personaStateSchema = z.object({
  version: z.literal(1),
  traits: z.string().default(''),
  /** История изменений, новые в конце: из неё видно, как менялся характер, и можно вернуть прежний слой. */
  changes: z.array(changeSchema).default([]),
  lastReviewAt: z.string().nullable().default(null),
  updatedAt: z.string()
});
export type PersonaState = z.output<typeof personaStateSchema>;

export const emptyPersona = (now: Date): PersonaState => ({ version: 1, traits: '', changes: [], lastReviewAt: null, updatedAt: now.toISOString() });

export class PersonaStore {
  readonly #file: string;
  #state: PersonaState | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) { this.#file = join(dir, 'persona.json'); }

  async load(now: Date = new Date()): Promise<PersonaState> {
    if (this.#state) return this.#state;
    try {
      this.#state = personaStateSchema.parse(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#state = emptyPersona(now);
    }
    return this.#state;
  }

  get state(): PersonaState { return this.#state ?? emptyPersona(new Date()); }

  update<T>(mutate: (state: PersonaState) => T, now: Date = new Date()): Promise<T> {
    const run = async () => {
      const state = await this.load(now);
      const result = mutate(state);
      state.updatedAt = now.toISOString();
      await mkdir(join(this.#file, '..'), { recursive: true });
      const temp = `${this.#file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2));
      await rename(temp, this.#file);
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** Новый слой с причиной; прежний остаётся в истории. */
  change(after: string, why: string, now: Date, calls = 0): Promise<PersonaChange | null> {
    return this.update(state => {
      const text = after.trim().slice(0, MAX_TRAITS_CHARS);
      if (text === state.traits) return null;
      const change = { at: now.toISOString(), before: state.traits, after: text, why: why.trim(), calls };
      state.traits = text;
      state.changes = [...state.changes, change].slice(-MAX_CHANGES);
      return change;
    }, now);
  }

  /** Сброс к заводскому характеру: слой пуст, история сохраняется. */
  reset(now: Date): Promise<PersonaChange | null> {
    return this.change('', 'Сброс к заводскому характеру по просьбе владельца.', now);
  }
}
