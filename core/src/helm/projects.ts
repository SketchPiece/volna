import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { HelmClient, HelmModelSelection, HelmProject } from './client.ts';

/**
 * Проект «Штурвала» по словам пользователя (docs/core.md, 4l). Без названия — проект «Работы» по умолчанию (`HELM_PROJECT_DIR`).
 * Существующий проект ищется по названию или имени папки. Новый создаётся только как новая пустая папка в
 * `HELM_NEW_PROJECTS_DIR`: уже существующую папку проектом делает владелец в окне «Штурвала», иначе голос давал бы агенту
 * доступ к чужим файлам (как доверие папке, docs/design/volna-confirm.html).
 */
/** `model`: модель, с которой создаются новые проекты (helm/client.ts, ensureProject). */
export interface ProjectDirs { defaultDir: string; defaultTitle: string; newDir: string; model?: HelmModelSelection | null }
export type ProjectPick = { project: HelmProject; created: boolean } | { error: string; asked?: string; hint: string; projects?: { name: string; folder: string }[] };

/** Есть ли папка: на этой машине или на Mac через «Узел» (relay/link.ts), когда ядро в облаке. */
export type FolderExists = (path: string, signal: AbortSignal) => Promise<boolean>;

export async function pickProject(client: HelmClient, asked: string | null | undefined, create: boolean, dirs: ProjectDirs, signal: AbortSignal, exists: FolderExists = localExists): Promise<ProjectPick> {
  const name = asked?.trim() ?? '';
  if (!name) return { project: await client.ensureProject(dirs.defaultDir, dirs.defaultTitle, signal, dirs.model), created: false };
  const shell = await client.shell(signal);
  const key = normalize(name);
  const exact = shell.projects.filter(p => projectKeys(p).includes(key));
  const partial = exact.length ? exact : shell.projects.filter(p => projectKeys(p).some(k => k.includes(key)));
  // Голос пишет латинские названия кириллицей («колл ассистент»): сравниваем согласные после транслитерации.
  const found = partial.length ? partial : shell.projects.filter(p => projectKeys(p).some(k => skeleton(k) === skeleton(key)));
  const list = shell.projects.slice(0, 20).map(p => ({ name: p.title, folder: basename(p.workspaceRoot) }));
  if (found.length === 1) return { project: found[0]!, created: false };
  if (found.length > 1) return { error: 'ambiguous_project', asked: name, hint: 'Ask the user which project.', projects: list };
  if (!create) return { error: 'unknown_project', asked: name, hint: 'Ask the user which project; if they want a new one, call again with newProject: true.', projects: list };
  const folder = folderName(name);
  if (!folder) return { error: 'bad_project_name', asked: name, hint: 'Ask the user for a short project name.' };
  const root = join(dirs.newDir, folder);
  if (await exists(root, signal)) {
    return { error: 'folder_exists', asked: name, hint: 'A folder with this name already exists but is not a Helm project. Only the owner can add an existing folder, in the Helm window on the computer; say so, or ask for another name.' };
  }
  return { project: await client.ensureProject(root, name, signal, dirs.model), created: true };
}

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
export const projectKeys = (project: { title: string; workspaceRoot: string }) => [normalize(project.title), normalize(basename(project.workspaceRoot))];

const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

/** Согласные названия после транслитерации, без удвоений: «коллассистент» и «callassistant» дают одно и то же. */
export function skeleton(key: string): string {
  const latin = [...key].map(ch => LATIN[ch] ?? ch).join('');
  return latin.replace(/c(?![h])/g, 'k').replace(/ph/g, 'f').replace(/w/g, 'v').replace(/q/g, 'k').replace(/x/g, 'ks')
    .replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}

/** Имя папки нового проекта: буквы, цифры, пробелы и дефисы, без путей. */
export function folderName(name: string): string {
  return name.replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
}

async function localExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}
