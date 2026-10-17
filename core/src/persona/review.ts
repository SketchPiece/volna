import { z } from 'zod';
import { CORE, GENDER_TITLES, GENDER } from '../assistant/persona.ts';
import { askStructured, dateLine, type ExtractorOptions } from '../memory/extractor.ts';
import type { MemoryState, Transcript } from '../memory/model.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { Logger } from '../log.ts';
import { MAX_TRAITS_CHARS, type PersonaStore } from './store.ts';

/**
 * Пересмотр личного слоя характера: как «сон» памяти, но реже и осторожнее. Решение владельца 23.09.2026: характер —
 * глубинная черта, от одной просьбы он не меняется; меняется медленно, когда в нескольких разговорах видно что-то важное.
 */
export const MIN_CALLS_FOR_REVIEW = 5;
export const REVIEW_INTERVAL_MS = 3 * 24 * 3600 * 1000;
const MAX_TRANSCRIPTS = 10;
const MAX_TRANSCRIPT_CHARS = 1500;

export const reviewSchema = z.object({
  change: z.boolean(),
  /** Весь новый слой целиком; при change: false повторить текущий. */
  traits: z.string(),
  why: z.string()
});
export type PersonaReview = z.output<typeof reviewSchema>;

const RULES = `Ты следишь, как складывается личность голосового ассистента «Волна» в разговорах с одним человеком, владельцем. Волна о себе говорит в ${GENDER_TITLES[GENDER]} роде.
Заводской характер задал создатель, он ниже и не меняется. Поверх него есть личный слой: несколько фраз о том, какой Волна именно с этим владельцем (юмор, теплота, прямота, любопытство, инициатива, свои мнения и вкусы, общие шутки и отсылки). Пиши слой словами Волны о себе: первое лицо, настоящее время, без рода, о владельце в третьем лице, например «С ним я прямее, шучу суше». Этот текст владелец видит в приложении.
Личный слой меняется редко и медленно, как характер человека. Меняй, только когда в нескольких разговорах видно устойчивое и важное для отношений: как владелец реагирует на шутки, где ему не хватает прямоты или тепла, что между вами сложилось. Одна просьба в разговоре («будь смешнее», «говори короче») — не повод: это предпочтение, оно в памяти и исполняется сразу. Повод — если это повторяется или видно по реакции владельца в разных разговорах.
Не трогай имя, пол, язык, форму (коротко, живая речь), честность, безопасность, подтверждения и работу с инструментами: это не характер. Не пиши в слой факты о владельце: они в памяти.
Изменение — маленький шаг: перепиши или добавь одну-две фразы, остальное сохрани дословно. Слой не длиннее ${MAX_TRAITS_CHARS} символов. Если сильных оснований нет, change: false и traits повтори без изменений. why: одна фраза, на что в разговорах ты опираешься.
Заводской характер:
${CORE}`;

export interface PersonaReviewerOptions {
  persona: PersonaStore;
  memory: MemoryStore;
  extractor: ExtractorOptions;
  log: Logger;
  now?: () => Date;
}

export class PersonaReviewer {
  readonly #o: PersonaReviewerOptions;
  readonly #now: () => Date;

  constructor(options: PersonaReviewerOptions) { this.#o = options; this.#now = options.now ?? (() => new Date()); }

  /** После звонка: пересмотр, только если прошло достаточно времени и разговоров. Возвращает, было ли изменение. */
  async maybeReview(): Promise<boolean> {
    const state = await this.#o.persona.load(this.#now());
    const last = state.lastReviewAt ? Date.parse(state.lastReviewAt) : 0;
    if (this.#now().getTime() - last < REVIEW_INTERVAL_MS) return false;
    const transcripts = await this.#recent(state.lastReviewAt);
    if (transcripts.length < MIN_CALLS_FOR_REVIEW) return false;
    return this.review(transcripts);
  }

  /** Пересмотр без условий (`npm run persona -- review`). */
  async review(transcripts?: Transcript[]): Promise<boolean> {
    const now = this.#now();
    const calls = transcripts ?? await this.#recent(null);
    const persona = await this.#o.persona.load(now);
    const system = `${RULES}\n${dateLine(now, this.#o.extractor.timeZone)}`;
    const user = [
      `Личный слой сейчас: ${persona.traits.trim() || '(пусто, только заводской характер)'}`,
      ...persona.changes.slice(-3).map(c => `Прошлое изменение (${c.at.slice(0, 10)}): ${c.why}`),
      memoryLines(this.#o.memory.state),
      'Разговоры с прошлого пересмотра:',
      ...calls.map(dialogue)
    ].join('\n');
    const result = await askStructured(this.#o.extractor, 'persona_review', reviewSchema, system, user, undefined, this.#o.extractor.deepModel);
    await this.#o.persona.update(s => { s.lastReviewAt = now.toISOString(); }, now);
    const changed = result.change ? await this.#o.persona.change(result.traits, result.why, now, calls.length) : null;
    // Только факт изменения и размеры: текст характера и разговоров в лог не идёт.
    this.#o.log.info('persona review', { calls: calls.length, changed: Boolean(changed), chars: changed?.after.length ?? persona.traits.length });
    return Boolean(changed);
  }

  async #recent(since: string | null): Promise<Transcript[]> {
    const names = (await this.#o.memory.listTranscripts()).slice(-MAX_TRANSCRIPTS);
    const all = await Promise.all(names.map(name => this.#o.memory.readTranscript(name)));
    return all.filter(t => !since || t.startedAt > since);
  }
}

function memoryLines(state: MemoryState): string {
  const preferences = state.facts.filter(f => !f.closedAt && !f.sensitive && f.kind === 'preference').map(f => `- ${f.text}`);
  return [`Профиль владельца: ${state.profile.trim() || '(пусто)'}`, preferences.length ? `Его предпочтения:\n${preferences.join('\n')}` : ''].filter(Boolean).join('\n');
}

function dialogue(transcript: Transcript): string {
  const text = transcript.turns.map(t => `${t.role === 'user' ? 'Владелец' : 'Волна'}: ${t.text}`).join('\n');
  return `— ${transcript.startedAt.slice(0, 16)}\n${text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}…` : text}`;
}
