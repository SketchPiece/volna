import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * Источник для `npm run skills -- add` и `npm run plugins -- add`: папка как есть или временная копия git-репозитория
 * (github.com/<o>/<r>/tree/<ветка>/<путь> тоже). `cleanup` удаляет временную копию.
 */
export async function fetchSource(source: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tree = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)\/?(.*)$/.exec(source);
  if (!tree && !/^(https:\/\/|git@)/.test(source)) return { dir: resolve(source), cleanup: async () => {} };
  const url = tree ? `https://github.com/${tree[1]}/${tree[2]}.git` : source;
  const temp = await mkdtemp(join(tmpdir(), 'wave-source-'));
  await promisify(execFile)('git', ['clone', '--depth', '1', ...(tree ? ['--branch', tree[3]!] : []), '--', url, temp]);
  return { dir: join(temp, tree?.[4] ?? ''), cleanup: () => rm(temp, { recursive: true, force: true }) };
}
