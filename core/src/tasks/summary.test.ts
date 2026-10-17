import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../log.ts';
import { LiveCalls } from '../realtime/live-calls.ts';
import { estimateTokens } from '../realtime/append-limit.ts';
import { TaskDelivery } from './delivery.ts';
import { TaskStore } from './store.ts';
import { resultSummarizer } from './summary.ts';

test('a long task result reaches the live call as a short summary; the full result stays in the task', async () => {
  const store = new TaskStore(await mkdtemp(join(tmpdir(), 'wave-sum-')));
  await store.load();
  const task = await store.create({ title: 'Тарифы', prompt: 'Сравни тарифы' });
  const long = '| Оператор | Цена | ГБ |\n'.repeat(300);
  await store.patch(task.id, { status: 'done', result: long });
  const seen: any[] = [];
  const summarize = resultSummarizer({ model: 'fake', complete: async messages => { seen.push(messages); return { content: 'Дешевле всех Тариф А: 400 рублей за 30 гигабайт.', toolCalls: [], usage: { inTokens: 1, outTokens: 1 } }; } });
  const sent: any[] = [];
  const calls = new LiveCalls();
  calls.listener().attach!({ send: (event: any) => sent.push(event) } as any);
  const delivery = new TaskDelivery({ store, calls, log: silentLogger, summarize });
  assert.equal(await delivery.deliver(store.get(task.id)!), 'announced');
  assert.match(sent[0].content, /готово\. Итог: Дешевле всех Тариф А: 400 рублей за 30 гигабайт\./);
  assert.ok(estimateTokens(sent[0].content) <= 450);
  assert.equal(store.get(task.id)!.summary, 'Дешевле всех Тариф А: 400 рублей за 30 гигабайт.');
  assert.equal(store.get(task.id)!.result, long);

  const failing = resultSummarizer({ model: 'fake', complete: async () => { throw new Error('down'); } });
  const other = await store.create({ title: 'Ещё', prompt: 'x' });
  await store.patch(other.id, { status: 'done', result: long });
  await new TaskDelivery({ store, calls, log: silentLogger, summarize: failing }).deliver(store.get(other.id)!);
  assert.ok(estimateTokens(sent[1].content) <= 450, 'without the model the result is cut, the call survives');
});
