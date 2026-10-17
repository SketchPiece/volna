import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { consoleLogger } from './log.ts';
import { MemoryStore } from './memory/store.ts';
import { MemoryService } from './memory/service.ts';

/** `npm run dream`: консолидация памяти вручную, без запуска ядра. */
const config = loadConfig();
const store = new MemoryStore(resolve(config.memoryDir));
await store.load();
const memory = new MemoryService({ store, log: consoleLogger, extractor: { ...config.memory, timeZone: config.timeZone, log: consoleLogger } });
await memory.runDream();
console.log(`Memory after dream: ${store.state.facts.filter(f => !f.closedAt).length} open notes, ${store.state.facts.length} total.`);
