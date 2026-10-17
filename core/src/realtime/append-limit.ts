/**
 * Лимит дописок в идущий звонок: `session.commentary.append`, `session.instructions.append` и `session.thinking.append`
 * принимают не больше 500 токенов (звонок 25.09.2026: итог задания длиннее — ошибка `invalid_value` и обрыв звонка).
 * Токенизатор Live снаружи недоступен, поэтому оценка с запасом: кириллица ~2 знака на токен, латиница ~4.
 */
export const APPEND_TOKENS = 450;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) tokens += ch.charCodeAt(0) < 128 ? 0.25 : 0.5;
  return Math.ceil(tokens);
}

/** Текст, который гарантированно влезает: обрезка по концу предложения, если он не слишком близко к началу. */
export function fitAppend(text: string, maxTokens = APPEND_TOKENS): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let budget = maxTokens - 1;
  let end = 0;
  for (const ch of text) {
    budget -= ch.charCodeAt(0) < 128 ? 0.25 : 0.5;
    if (budget < 0) break;
    end += ch.length;
  }
  const cut = text.slice(0, end);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  return `${sentence > end / 2 ? cut.slice(0, sentence + 1) : cut.trimEnd()}…`;
}
