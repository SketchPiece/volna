import type { Logger } from '../log.ts';

type Fields = Record<string, string | number | boolean | null>;
export interface Warning { at: string; message: string; fields: Fields }
export interface WarningGroup { message: string; count: number; last: string; fields: Fields }

/** Сколько предупреждений лога держать в памяти для «Сводки»: хватает на сутки с запасом. */
export const MAX_WARNINGS = 500;

/**
 * Состояние ядра для «Сводки» консоли (docs/core.md, 4k): время запуска, последний старт звонка и предупреждения лога.
 * Предупреждения берутся из того же логгера, поэтому в них только имена событий, коды и id, без текста разговора.
 */
export class Health {
  readonly startedAt: Date;
  #live: { at: string; error: string | null } | null = null;
  readonly #warnings: Warning[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
    this.startedAt = now();
  }

  get live(): { at: string; error: string | null } | null { return this.#live; }

  /** Итог `POST /session`: null — звонок создан, иначе код ошибки. */
  liveStarted(error: string | null): void {
    this.#live = { at: this.#now().toISOString(), error };
  }

  /** Логгер, который пишет как `base` и запоминает предупреждения. */
  logger(base: Logger): Logger {
    return {
      info: (message, fields) => base.info(message, fields),
      warn: (message, fields) => {
        this.#warnings.push({ at: this.#now().toISOString(), message, fields: fields ?? {} });
        if (this.#warnings.length > MAX_WARNINGS) this.#warnings.splice(0, this.#warnings.length - MAX_WARNINGS);
        base.warn(message, fields);
      }
    };
  }

  /** Предупреждения с `since`, по одному на событие: сколько раз и последние поля. Новые сверху. */
  warnings(since: Date): WarningGroup[] {
    const groups = new Map<string, WarningGroup>();
    const lo = since.toISOString();
    for (const warning of this.#warnings) {
      if (warning.at < lo) continue;
      const group = groups.get(warning.message);
      if (group) { group.count++; group.last = warning.at; group.fields = warning.fields; }
      else groups.set(warning.message, { message: warning.message, count: 1, last: warning.at, fields: warning.fields });
    }
    return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last));
  }
}
