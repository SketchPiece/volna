import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { consoleLogger } from './log.ts';
import { MemoryStore } from './memory/store.ts';
import { PersonaStore } from './persona/store.ts';
import { PersonaReviewer } from './persona/review.ts';

/**
 * `npm run persona`: личный слой характера и история изменений; `-- review` пересмотреть сейчас; `-- reset` вернуть
 * заводской характер (история сохраняется). Ядро читает слой при каждом звонке, перезапуск не нужен.
 */
const config = loadConfig();
const persona = new PersonaStore(resolve(config.memoryDir));
const state = await persona.load();
const command = process.argv[2] ?? 'show';

if (command === 'reset') {
  const change = await persona.reset(new Date());
  console.log(change ? 'Character reset to factory; previous layer kept in history.' : 'Already factory.');
} else if (command === 'review') {
  const memory = new MemoryStore(resolve(config.memoryDir));
  await memory.load();
  const reviewer = new PersonaReviewer({ persona, memory, log: consoleLogger, extractor: { ...config.memory, timeZone: config.timeZone, log: consoleLogger } });
  console.log((await reviewer.review()) ? `Changed:\n${persona.state.traits}\nWhy: ${persona.state.changes.at(-1)?.why}` : 'No change.');
} else {
  console.log(state.traits ? `Personal layer:\n${state.traits}` : 'Factory character, no personal layer yet.');
  console.log(`Last review: ${state.lastReviewAt ?? 'never'}`);
  for (const change of state.changes) console.log(`\n${change.at.slice(0, 16)} ${change.why}\n  → ${change.after || '(factory)'}`);
}
