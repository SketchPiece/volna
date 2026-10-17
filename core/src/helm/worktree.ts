import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Можно ли дать проекту отдельную ветку (`work_start` с `worktree: true`): папка должна быть git-репозиторием.
 * Сам worktree с 05.10.2026 создаёт «Штурвал» (`orchestration.launchThread`, `workspaceStrategy: worktree`, helm/client.ts);
 * в облаке эту проверку делает «Узел» (`git.repository`).
 */
export type Git = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;

const run = promisify(execFile);

export const git: Git = async (cwd, args, signal) => (await run('git', ['-C', cwd, ...args], { signal, timeout: 120_000 })).stdout.trim();

export async function isRepository(dir: string, signal: AbortSignal, runGit: Git = git): Promise<boolean> {
  try { return (await runGit(dir, ['rev-parse', '--is-inside-work-tree'], signal)) === 'true'; } catch { return false; }
}
