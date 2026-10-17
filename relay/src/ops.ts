import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { normalize } from 'node:path';
import { promisify } from 'node:util';
import { HelmRpcError, type RpcTransport } from '../../core/src/helm/rpc.ts';

/**
 * Что «Узел» делает по просьбе ядра (docs/relay.md). Ядру доверяем, но не слепо: запросы и команды «Штурвала» проходят
 * белый список (только то, что шлёт core/src/helm/client.ts), токен добавляется здесь и в ядро не уходит, пути только полные.
 * Ответов на разрешения агента в списке нет и не будет: разрешения даются только в «Штурвале» (на Mac или в телефоне).
 */
export type Call = { id: string; op: string } & Record<string, unknown>;
export type Result = { ok: true; data: unknown } | { ok: false; error: string };

export type Git = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;

export interface Deps {
  /** Адрес «Штурвала» сейчас (порт меняется после перезапуска). */
  t3Url: () => Promise<string>;
  t3Token: string;
  fetch: typeof fetch;
  /** WebSocket-RPC «Штурвала» (core/src/helm/rpc.ts) для команд. */
  rpc: RpcTransport;
  git: Git;
  exists: (path: string) => Promise<boolean>;
  timeoutMs?: number;
}

/** Команды оркестрации (`orchestration.dispatchCommand`), которые шлёт ядро. Всё остальное — отказ `not_allowed`. */
export const HELM_COMMANDS: ReadonlySet<string> = new Set([
  'message.dispatch', 'run.interrupt', 'runtime-request.respond',
  // Разобрать тред и отложить его (Helm MCP): только видимость в списке «Штурвала», работу не трогают.
  'thread.settle', 'thread.unsettle', 'thread.snooze', 'thread.unsnooze'
]);
/** Протокол оркестрации, на котором говорит ядро: «Узел» шлёт его заголовком в каждом запросе. */
const PROTOCOL_HEADER = { 'x-t3-orchestration-protocol': '2' };

// Id треда закодирован encodeURIComponent: у тредов из MCP, импорта и делегирования в нём есть «:» и «%» (`mcp:…`,
// `thread:delegated-task:command%3A…`), отсюда %3A и %25. Точек и слешей нет: путь не выйдет за пределы треда.
const THREAD_PATH = /^\/api\/orchestration\/threads\/(?:[A-Za-z0-9_-]|%3A|%25){1,600}\/bounded$/;
/** Ветка задания Волны: `wave/<id задания, 16 hex>` (core/src/helm/worker.ts). */
const BRANCH = /^wave\/[0-9a-f]{16}$/;
/** Режимы разрешений, которые ядро ставит новым тредам; `full-access` не пропускается никогда. */
const RUNTIME_MODES = new Set(['approval-required', 'auto-accept-edits', 'auto']);

/** Полный путь без `..` и лишнего: так ядро не попросит проверить или создать что-то в обход. */
export function fullPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 1024) return null;
  const clean = normalize(value);
  return clean === value.replace(/\/+$/, '') || clean === value ? clean : null;
}

/** HTTP: три чтения и создание проекта. null — можно; иначе причина отказа. */
export function checkT3(method: unknown, path: unknown, body: unknown): string | null {
  if (typeof path !== 'string') return 'bad_path';
  if (method === 'GET') {
    return path === '/.well-known/t3/environment' || path === '/api/orchestration/shell' || THREAD_PATH.test(path) ? null : 'not_allowed';
  }
  if (method !== 'POST' || path !== '/api/projects/mutate') return 'not_allowed';
  const mutation = record(body);
  if (mutation?.type !== 'project.create') return 'not_allowed';
  return fullPath(mutation.workspaceRoot) ? null : 'bad_path';
}

/**
 * RPC: запуск треда (в папке проекта или в своём worktree с веткой `wave/…` от HEAD) и команды из HELM_COMMANDS. Ответ на заявку
 * только с `answers`: решение по разрешению (`decision`) через ядро не проходит.
 */
export function checkRpc(method: unknown, payload: unknown): string | null {
  const input = record(payload);
  if (!input) return 'not_allowed';
  if (method === 'orchestration.launchThread') {
    if (input.reuseExistingThread || !RUNTIME_MODES.has(input.runtimeMode as string)) return 'not_allowed';
    const strategy = record(input.workspaceStrategy);
    if (strategy?.type === 'root' && strategy.branch === undefined) return null;
    if (strategy?.type === 'worktree' && strategy.baseRef === 'HEAD' && BRANCH.test(String(strategy.branch)) && !strategy.startFromOrigin) return null;
    return 'not_allowed';
  }
  if (method !== 'orchestration.dispatchCommand' || !HELM_COMMANDS.has(input.type as string)) return 'not_allowed';
  if (input.type === 'runtime-request.respond' && (input.decision !== undefined || input.attachmentsByQuestionId !== undefined || !record(input.answers))) return 'not_allowed';
  if (input.type === 'thread.snooze' && (typeof input.snoozedUntil !== 'string' || Number.isNaN(Date.parse(input.snoozedUntil)))) return 'not_allowed';
  if ((input.type === 'thread.unsettle' || input.type === 'thread.unsnooze') && input.reason !== 'user') return 'not_allowed';
  return null;
}

const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export async function handle(call: Call, deps: Deps): Promise<Result> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? 50_000);
  switch (call.op) {
    case 't3.request': {
      const refused = checkT3(call.method, call.path, call.body);
      if (refused) return { ok: false, error: refused };
      let response: Response;
      try {
        response = await deps.fetch(`${await deps.t3Url()}${call.path as string}`, {
          method: call.method as string, signal,
          headers: { Authorization: `Bearer ${deps.t3Token}`, ...PROTOCOL_HEADER, ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: call.body === undefined ? undefined : JSON.stringify(call.body)
        });
      } catch { return { ok: false, error: 't3_offline' }; }
      let data: unknown = null;
      try { data = await response.json(); } catch { /* пустое тело */ }
      return { ok: true, data: { status: response.status, body: data } };
    }
    case 'folder.exists': {
      const path = fullPath(call.path);
      return path ? { ok: true, data: await deps.exists(path) } : { ok: false, error: 'bad_path' };
    }
    case 'git.repository': {
      // Можно ли дать проекту отдельную ветку: work_start спрашивает до того, как завести задание.
      const path = fullPath(call.path);
      if (!path) return { ok: false, error: 'bad_path' };
      try { return { ok: true, data: (await deps.git(path, ['rev-parse', '--is-inside-work-tree'], signal)) === 'true' }; }
      catch { return { ok: true, data: false }; }
    }
    case 'helm.rpc': {
      const refused = checkRpc(call.method, call.payload);
      if (refused) return { ok: false, error: refused };
      try { return { ok: true, data: await deps.rpc(call.method as string, call.payload, signal) }; }
      catch (error) {
        if (!(error instanceof HelmRpcError)) return { ok: false, error: 'helm_offline' };
        return { ok: false, error: error.kind === 'fail' ? `helm_fail:${error.tag ?? ''}` : `helm_${error.kind}` };
      }
    }
    default:
      return { ok: false, error: 'unknown_op' };
  }
}

const run = promisify(execFile);

export const git: Git = async (cwd, args, signal) => (await run('git', ['-C', cwd, ...args], { signal, timeout: 120_000 })).stdout.trim();
export const exists = (path: string) => stat(path).then(() => true, () => false);
