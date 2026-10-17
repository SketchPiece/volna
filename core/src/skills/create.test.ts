import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionModel } from '../jev/client.ts';
import { checkRouting, readProbes, ROUTING_PROBES } from './check.ts';
import { creationPrompt, techcardCreateTool } from './create.ts';
import { routeCards } from './routing.ts';
import { SkillStore } from './store.ts';
import { ToolRegistry, defineTool } from '../assistant/tools/registry.ts';
import { z } from 'zod';
import { silentLogger } from '../log.ts';

test('a new tech card is written by an agent with skill-creator; Volna rules ride in the task, the start waits for «да»', async () => {
  const started: any[] = [];
  const runner = { start: async (input: any) => { started.push(input); return { id: 't1', ...input }; } } as any;
  const tool = techcardCreateTool({ runner, ownerDir: '/data/skills', serverDir: '/srv', toolNames: () => ['create_reminder', 'web_search'] });
  assert.equal(tool.startsWork, true, 'offered first, never called by the model');
  const output = await tool.execute({ title: 'Отчёт за неделю', request: 'по пятницам собирать задачи из Пульта и присылать сводку' }, { callId: 'c', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => new Date() });
  assert.deepEqual(output, { started: true, id: 't1', title: 'Отчёт за неделю', say: 'Принято, займусь техкартой. Если будут вопросы, спрошу.' });
  const prompt = started[0].prompt as string;
  assert.match(prompt, /skill-creator/);
  assert.match(prompt, /\/data\/skills\/<name>\/SKILL\.md/);
  assert.match(prompt, /только из этого списка: create_reminder web_search/);
  assert.match(prompt, /Мне кажется, это нужно раз в неделю\. Так\?/);
  assert.match(prompt, /npm run skills -- check <name>/);
  assert.match(prompt, new RegExp(ROUTING_PROBES.replace('.', '\\.')));
  assert.match(creationPrompt({ title: 'x', request: 'y', ownerDir: 'd', serverDir: 's', tools: [] }), /только из этого списка: \(инструментов нет\)/);
});

test('the routing check asks Jev for every probe among all cards and needs 85% in both groups', async () => {
  const jev: DecisionModel = { decide: async request => {
    const text = (request.state as any).conversation.at(-1).text as string;
    const choice = text.includes('отчёт') ? 'weekly' : 'none';
    return { model: 'jev', answers: { techcard: { type: 'choice', choice, probabilities: { [choice]: 0.9 } } } };
  } };
  const cards = [{ name: 'weekly', when: 'отчёт за неделю' }, { name: 'time', when: 'время' }];
  const good = await checkRouting('weekly', cards, { should: ['сделай отчёт', 'отчёт за неделю'], shouldNot: ['который час', 'привет'] }, jev);
  assert.equal(good.passed, true);
  const bad = await checkRouting('weekly', cards, { should: ['сделай сводку', 'отчёт'], shouldNot: ['какой отчёт вчера'] }, jev);
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.should.map(r => r.ok), [false, true]);
  assert.deepEqual(bad.shouldNot.map(r => r.ok), [false]);
});

test('a card joins the route only with its tools present; its text and owner rules become the guide', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'route-'));
  await mkdir(join(dir, 'weekly', 'evals'), { recursive: true });
  await writeFile(join(dir, 'weekly', 'SKILL.md'), '---\nname: weekly\ndescription: "Отчёт за неделю"\nallowed-tools: tasks_list missing_tool\nmetadata:\n  tier: "standard"\n---\n\n# Отчёт\n\nСобери задачи.\n\n## Правила владельца\n\n1. По пятницам\n');
  await writeFile(join(dir, 'weekly', ROUTING_PROBES), JSON.stringify({ should: ['отчёт'], shouldNot: ['время'] }));
  await mkdir(join(dir, 'text-only'));
  await writeFile(join(dir, 'text-only', 'SKILL.md'), '---\nname: text-only\ndescription: "Только текст"\n---\n\nТекст.\n');
  const store = new SkillStore({ ownerDir: dir });
  const skills = await store.list();
  const tools = new ToolRegistry([defineTool({ name: 'tasks_list', effect: 'read', description: 'x', parameters: z.object({}), execute: () => ({}) })]);
  const cards = routeCards(skills, tools);
  assert.deepEqual(cards.map(c => [c.name, c.tools, c.tier]), [['weekly', ['tasks_list'], 'standard']]);
  assert.match(cards[0]!.guide, /Собери задачи\.[\s\S]*Правила владельца \(важнее инструкций\):\n1\. По пятницам/);
  assert.deepEqual(await readProbes(skills.find(s => s.name === 'weekly')!), { should: ['отчёт'], shouldNot: ['время'] });
});

test('a voice-made card of owner rules joins the route with all tools; work cards can read owner rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'route-'));
  await mkdir(join(dir, 'dev'));
  await writeFile(join(dir, 'dev', 'SKILL.md'), '---\nname: dev\ndescription: "когда владелец просит добавить или изменить возможность Волны"\nmetadata:\n  title: "Добавление и изменение возможностей"\n  origin: "volna"\n---\n\n# Добавление и изменение возможностей\n\n## Правила владельца\n\n1. Работать в проекте CallAssistant, код в отдельной ветке.\n');
  await mkdir(join(dir, 'work'));
  await writeFile(join(dir, 'work', 'SKILL.md'), '---\nname: work\ndescription: "Работа на компьютере"\nallowed-tools: work_start\nmetadata:\n  tier: "work"\n---\n\n# Работа\n');
  const skills = await new SkillStore({ ownerDir: dir }).list();
  const tool = (name: string) => defineTool({ name, effect: 'read', description: 'x', parameters: z.object({}), execute: () => ({}) });
  const cards = routeCards(skills, new ToolRegistry([tool('work_start'), tool('techcard_read')]));
  assert.deepEqual(cards.map(c => [c.name, c.tools, c.tier]), [['dev', [], 'standard'], ['work', ['work_start', 'techcard_read'], 'work']]);
  assert.equal(cards[0]!.when, 'Добавление и изменение возможностей: когда владелец просит добавить или изменить возможность Волны');
  assert.match(cards[0]!.guide, /1\. Работать в проекте CallAssistant, код в отдельной ветке\./);
  assert.deepEqual(routeCards(skills, new ToolRegistry([tool('work_start')])).map(c => c.tools), [[], ['work_start']], 'no techcard_read in the call: nothing added');
});
