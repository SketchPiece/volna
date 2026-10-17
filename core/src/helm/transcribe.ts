import type { UsageMeter } from '../usage/ledger.ts';

/** Цена gpt-transcribe у OpenAI (октябрь 2026), долларов за минуту. */
export const TRANSCRIBE_PRICE_PER_MINUTE = 0.0045;
/** Предел OpenAI для файла распознавания. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
const MAX_HINTS = 100;
const MAX_HINT_CHARS = 80;
const MAX_PROMPT_CHARS = 2000;
/** Языки владельца, если запрос их не назвал. */
const DEFAULT_LANGUAGES = ['ru', 'en'];
/**
 * Слова, которые русскоязычный разработчик говорит по-английски: так они остаются латиницей. Идут после подсказок
 * запроса (проект, ветка), чтобы при пределе в MAX_HINTS отсеялись они, а не имена треда.
 */
const CODING_KEYWORDS = [
  'commit', 'push', 'pull request', 'PR', 'merge', 'rebase', 'branch', 'main', 'worktree', 'diff', 'review', 'deploy',
  'build', 'release', 'bug', 'fix', 'feature', 'refactor', 'test', 'lint', 'typecheck', 'API', 'endpoint', 'backend',
  'frontend', 'server', 'client', 'mobile', 'desktop', 'web', 'UI', 'UX', 'README', 'TypeScript', 'React',
  'React Native', 'Effect', 'useEffect', 'useState', 'props', 'state', 'hook', 'component', 'GitHub', 'Railway',
  'Codex', 'Claude', 'Helm'
];

export interface TranscribeRequest {
  audio: Blob;
  fileName: string;
  /** Коды языков речи, например ['ru', 'en']: модель не гадает язык каждой фразы. */
  languages: string[];
  /** Термины, которые надо узнать дословно: проект, ветка, файлы треда. */
  keywords: string[];
  prompt: string | null;
  /** Длина записи по часам клиента; для учёта, если OpenAI не прислал свою. */
  seconds: number | null;
}

/** `seconds`: длина записи по OpenAI (или по клиенту), для лимита телефона. */
export type Transcriber = (request: TranscribeRequest, signal?: AbortSignal) => Promise<{ text: string; seconds: number | null }>;

export class TranscribeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Распознавание голоса «Штурвала» (docs/helm-push.md): ядро держит ключ OpenAI, сервер «Штурвала» шлёт запись.
 * Подсказки чистятся здесь: перевод строки или угловая скобка в keyword OpenAI отклоняет всем запросом.
 */
export function openAiTranscriber(options: { apiKey: string; model: string; fetchImpl?: typeof fetch; meter?: UsageMeter }): Transcriber {
  const { apiKey, model, fetchImpl = fetch, meter } = options;
  return async (request, signal) => {
    const form = new FormData();
    form.set('model', model);
    form.set('response_format', 'json');
    form.set('file', request.audio, request.fileName);
    const languages = request.languages.length > 0 ? request.languages : DEFAULT_LANGUAGES;
    for (const language of cleanHints(languages, 8)) form.append('languages[]', language);
    for (const keyword of cleanHints([...request.keywords, ...CODING_KEYWORDS], MAX_HINTS)) form.append('keywords[]', keyword);
    const prompt = request.prompt?.trim().slice(0, MAX_PROMPT_CHARS);
    if (prompt) form.set('prompt', prompt);

    const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal
    });
    const body = await response.json().catch(() => null) as { text?: unknown; usage?: { seconds?: unknown } } | null;
    if (!response.ok || typeof body?.text !== 'string') {
      throw new TranscribeError(response.status === 400 || response.status === 413 ? response.status : 502, `OpenAI ответил ${response.status}.`);
    }
    const seconds = typeof body.usage?.seconds === 'number' ? body.usage.seconds : request.seconds;
    meter?.record({
      purpose: 'helm_transcribe', model, seconds,
      costUsd: seconds === null ? null : Math.round(seconds * TRANSCRIBE_PRICE_PER_MINUTE / 60 * 1e6) / 1e6
    });
    return { text: body.text.trim(), seconds };
  };
}

function cleanHints(values: string[], max: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const hint = value.replace(/[\r\n<>]+/g, ' ').trim().slice(0, MAX_HINT_CHARS);
    if (hint) seen.add(hint);
    if (seen.size >= max) break;
  }
  return [...seen];
}
