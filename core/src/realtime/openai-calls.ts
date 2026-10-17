export const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';

export class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number) { super(`OpenAI responded ${status}`); this.name = 'UpstreamError'; this.status = status; }
}

export interface CreateCallInput {
  apiKey: string;
  sdp: string;
  session: unknown;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface CreatedCall {
  answer: string;
  /** Идентификатор Live-сессии; нужен для sideband-подключения (`/v1/live/sessions/{id}/attach`). */
  callId: string | null;
}

/**
 * Создаёт GPT-Live-сессию с транспортом WebRTC: SDP-offer в теле, SDP-answer и id сессии в ответе.
 * Тело ответа OpenAI никогда не возвращается наверх при ошибке.
 */
export async function createCall({ apiKey, sdp, session, signal, fetchImpl = fetch }: CreateCallInput): Promise<CreatedCall> {
  const upstream = await fetchImpl(LIVE_SESSIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
    signal
  });
  if (!upstream.ok) throw new UpstreamError(upstream.status);
  let payload: any;
  try { payload = await upstream.json(); } catch { throw new UpstreamError(502); }
  const answer = payload?.transport?.sdp;
  if (typeof answer !== 'string' || !answer.startsWith('v=0')) throw new UpstreamError(502);
  const callId = typeof payload?.session?.id === 'string' && payload.session.id ? payload.session.id : null;
  return { answer, callId };
}
