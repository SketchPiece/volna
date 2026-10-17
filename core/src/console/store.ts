import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallInfo, ConsoleEvent } from './hub.ts';

/** Запись звонка для истории консоли: все события с временем от начала звонка. Содержит текст разговора. */
export interface ConsoleRecord {
  version: 1;
  callId: string;
  startedAt: string;
  durationMs: number;
  info: CallInfo;
  events: ConsoleEvent[];
}

export interface RecordSummary {
  id: string;
  callId: string;
  startedAt: string;
  durationMs: number;
  delegations: number;
  errors: number;
  /** Начало первой фразы владельца: по нему звонок узнаётся в списке. Только на странице консоли, не в логе. */
  title: string;
}

const TITLE_CHARS = 60;

function titleOf(record: ConsoleRecord): string {
  let text = '';
  for (const event of record.events) {
    if (event.k !== 'in') continue;
    const data = event.data as { type?: string; delta?: unknown };
    if (data?.type === 'session.input_transcript.delta' && typeof data.delta === 'string') text += data.delta;
    else if (data?.type === 'session.output_transcript.delta' && text.trim()) break;
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text;
}

/** Решение владельца 25.09.2026: хранить последние 30 звонков. */
export const KEEP_RECORDS = 30;
const ID = /^[0-9TZ-]+-[A-Za-z0-9_-]+$/;

/** Файлы истории: `<каталог>/<время>-<звонок>.json`. Старше последних `keep` удаляются при каждой записи. */
export class ConsoleStore {
  readonly dir: string;
  readonly #keep: number;
  /** Записи не меняются после сохранения: сводка читается с диска один раз. */
  readonly #summaries = new Map<string, RecordSummary>();

  constructor(dir: string, keep = KEEP_RECORDS) {
    this.dir = dir;
    this.#keep = keep;
  }

  async save(record: ConsoleRecord): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const id = `${record.startedAt.replace(/[:.]/g, '-')}-${record.callId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(record));
    await this.#prune();
    return id;
  }

  /** Новые сверху. */
  async list(): Promise<RecordSummary[]> {
    const summaries: RecordSummary[] = [];
    for (const id of await this.#ids()) {
      const cached = this.#summaries.get(id);
      if (cached) { summaries.push(cached); continue; }
      const record = await this.read(id);
      if (!record) continue;
      const summary: RecordSummary = {
        id, callId: record.callId, startedAt: record.startedAt, durationMs: record.durationMs,
        delegations: record.events.filter(e => e.type === 'session.delegation.created').length,
        errors: record.events.filter(e => e.type === 'error' || e.type === 'client.error').length,
        title: titleOf(record)
      };
      this.#summaries.set(id, summary);
      summaries.push(summary);
    }
    return summaries;
  }

  async read(id: string): Promise<ConsoleRecord | null> {
    if (!ID.test(id)) return null;
    try { return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as ConsoleRecord; }
    catch { return null; }
  }

  async delete(id: string): Promise<boolean> {
    if (!ID.test(id)) return false;
    this.#summaries.delete(id);
    try { await unlink(join(this.dir, `${id}.json`)); return true; }
    catch { return false; }
  }

  /** Имена по убыванию: время в начале имени, поэтому это порядок от новых к старым. */
  async #ids(): Promise<string[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(id => ID.test(id)).sort().reverse();
  }

  async #prune(): Promise<void> {
    for (const id of (await this.#ids()).slice(this.#keep)) await this.delete(id);
  }
}
