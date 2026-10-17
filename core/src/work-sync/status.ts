import type { HelmThreadShell } from '../helm/client.ts';

/**
 * Общее правило состояния треда «Штурвала» (docs/task-sync.md, 5): им пользуются голос (work_threads) и список работы
 * (work-sync/sync.ts), чтобы они не расходились.
 */
export type ThreadState = 'needs_you' | 'working' | 'failed' | 'idle';

export function threadState(thread: Pick<HelmThreadShell, 'hasPendingUserInput' | 'hasPendingApprovals' | 'latestTurn' | 'session'>): ThreadState {
  if (thread.hasPendingUserInput || thread.hasPendingApprovals) return 'needs_you';
  if (thread.latestTurn?.state === 'running' || thread.session?.status === 'running' || thread.session?.status === 'starting') return 'working';
  if (thread.latestTurn?.state === 'error' || thread.session?.status === 'error') return 'failed';
  return 'idle';
}

/** Чего ждёт тред: вопрос агента (ответ голосом) или разрешение (только в окне «Штурвала»). */
export function threadWaiting(thread: Pick<HelmThreadShell, 'hasPendingUserInput' | 'hasPendingApprovals'>): 'question' | 'approval' | null {
  return thread.hasPendingUserInput ? 'question' : thread.hasPendingApprovals ? 'approval' : null;
}
