/** Голоса GPT-Live (developers.openai.com, «Managing sessions», сентябрь 2026). Первый — по умолчанию: мужской, естественный. */
export const LIVE_VOICES = Object.freeze([
  'meridian', 'stone', 'vesper', 'ripple', 'beacon', 'cinder', 'gleam', 'willow', 'quartz', 'delta', 'bossa', 'tempo'
] as const);
export type LiveVoice = typeof LIVE_VOICES[number];
export const DEFAULT_VOICE: LiveVoice = 'meridian';

export function isLiveVoice(value: unknown): value is LiveVoice {
  return typeof value === 'string' && (LIVE_VOICES as readonly string[]).includes(value);
}

export interface SessionInput {
  /** Полнодуплексная голосовая модель (gpt-live-1). */
  model: string;
  voice: LiveVoice;
  /** Инструкции голосовой модели: характер, формат, приветствие, память. */
  instructions: string;
}

/**
 * Конфигурация GPT-Live-сессии. Детектора речи нет: модель слушает и говорит одновременно.
 * Делегирование только клиентское: работу исполняет ядро (delegation/client.ts), голосовая модель инструментов не зовёт.
 * Причины: docs/architecture.md, 3.1.1.
 */
export function buildSession({ model, voice, instructions }: SessionInput) {
  return { model, instructions, audio: { output: { voice } }, delegation: { type: 'client' } };
}
