import type { WorkItem } from './sync.ts';

/**
 * Смысловой дубль (docs/task-sync.md, 7): перед предложением новой работы ядро ищет идущий тред того же проекта с похожим
 * заголовком и советует дописать туда. Сам ничего не сливает: решает пользователь.
 *
 * Похожесть — по основам слов (первые пять букв слов от трёх букв): «Починить тесты ядра» и «Почини тесты» совпадают.
 */
export function similarWork(items: readonly WorkItem[], title: string, project: string | null): WorkItem | null {
  const asked = stems(title);
  if (!asked.size) return null;
  const projectKey = project ? key(project) : null;
  let best: { item: WorkItem; score: number } | null = null;
  for (const item of items) {
    if (item.status !== 'working' && item.status !== 'needs_you' && item.status !== 'queued') continue;
    if (projectKey && item.project && key(item.project.title) !== projectKey) continue;
    const other = stems(item.title);
    if (!other.size) continue;
    const common = [...asked].filter(s => other.has(s)).length;
    // Все слова короткого заголовка есть в длинном, или больше половины слов общие.
    const score = common / Math.min(asked.size, other.size) === 1 ? 1 : common / new Set([...asked, ...other]).size;
    if (score >= 0.5 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

const key = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
function stems(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3).map(w => w.slice(0, 5)));
}
