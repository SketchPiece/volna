import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorText, parseSkillFile, readRules, slugify, writeRules } from './format.ts';
import { SkillStore } from './store.ts';
import { techCardTools, TECHCARD_TOOL_NAMES } from './tools.ts';
import { ToolRegistry } from '../assistant/tools/registry.ts';
import { silentLogger } from '../log.ts';

const now = new Date('2026-09-23T10:00:00Z');
const context = { callId: 'rtc_1', signal: new AbortController().signal, log: silentLogger, timeZone: 'UTC', now: () => now };
const temp = (name: string) => mkdtemp(join(tmpdir(), `volna-skills-${name}-`));

// Скилл в том виде, в каком его публикуют в интернете: многострочное описание, metadata, allowed-tools, файлы рядом.
const PDF_SKILL = `---
name: pdf-tools
description: >
  Extract text and tables from PDF files.
  Use when the user mentions a PDF.
license: Apache-2.0
allowed-tools: Bash Read
metadata:
  author: example-org
  version: "1.0"
---

# PDF tools

Use pdfplumber for tables. See [the guide](references/guide.md).
`;

async function writeSkill(root: string, name: string, text: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), text);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test('SKILL.md frontmatter: folded description, nested metadata, plain fields; body and owner rules', () => {
  const file = parseSkillFile(PDF_SKILL);
  assert.equal(file.frontmatter.name, 'pdf-tools');
  assert.equal(file.frontmatter.description, 'Extract text and tables from PDF files. Use when the user mentions a PDF.');
  assert.equal(file.frontmatter['allowed-tools'], 'Bash Read');
  assert.deepEqual(file.frontmatter.metadata, { author: 'example-org', version: '1.0' });
  assert.match(file.body, /^# PDF tools/);
  assert.deepEqual(readRules(file.body), []);

  const withRules = writeRules(file.body, ['Отчёты класть в Documents', 'Таблицы в CSV']);
  assert.deepEqual(readRules(withRules), ['Отчёты класть в Documents', 'Таблицы в CSV']);
  assert.match(withRules, /Use pdfplumber for tables\.[\s\S]*## Правила владельца\n\n1\. Отчёты класть в Documents\n2\. Таблицы в CSV\n$/);
  const rewritten = writeRules(withRules, ['Таблицы в CSV']);
  assert.deepEqual(readRules(rewritten), ['Таблицы в CSV']);
  assert.equal(authorText(rewritten), 'Use pdfplumber for tables. See [the guide](references/guide.md).');
  assert.equal(readRules(writeRules(rewritten, [])).length, 0);

  assert.equal(parseSkillFile('---\nname: a\ndescription: "Quoted: with colon"\n---\nBody').frontmatter.description, 'Quoted: with colon');
  assert.equal(parseSkillFile("---\nname: a\ndescription: |\n  line one\n  line two\n---\n").frontmatter.description, 'line one\nline two');
  assert.throws(() => parseSkillFile('# no frontmatter'));
  assert.equal(slugify('Разработка Волны'), 'razrabotka-volny');
  assert.equal(slugify('  !!  '), 'card');
});

test('tech cards by voice: a card is a skill folder, rewritten whole, old versions stay in history, delete removes it', async () => {
  const skills = new SkillStore({ ownerDir: await temp('owner') });
  const registry = new ToolRegistry(techCardTools(skills));
  assert.deepEqual(registry.names(), [...TECHCARD_TOOL_NAMES]);
  assert.deepEqual(JSON.parse(await registry.call('techcard_read', JSON.stringify({ topic: '' }), context)), { cards: [] });
  const created = JSON.parse(await registry.call('techcard_write', JSON.stringify({
    title: 'Разработка Волны', when: 'когда владелец просит поправить Волну', rules: ['Репозиторий CallAssistant', 'Сначала HTML-макет']
  }), context));
  assert.deepEqual(created, { saved: 'Разработка Волны', created: true, rules: 2 });
  const file = await readFile(join(skills.ownerDir, 'razrabotka-volny', 'SKILL.md'), 'utf8');
  assert.match(file, /^---\nname: razrabotka-volny\ndescription: "когда владелец просит поправить Волну"\nmetadata:\n  title: "Разработка Волны"\n  origin: "volna"\n---\n\n# Разработка Волны\n\n## Правила владельца\n\n1\. Репозиторий CallAssistant\n2\. Сначала HTML-макет\n$/);

  const read = JSON.parse(await registry.call('techcard_read', JSON.stringify({ topic: 'поправить волну' }), context));
  assert.deepEqual(read.card, { title: 'Разработка Волны', when: 'когда владелец просит поправить Волну', source: 'владельца', rules: ['1. Репозиторий CallAssistant', '2. Сначала HTML-макет'] });
  const updated = JSON.parse(await registry.call('techcard_write', JSON.stringify({
    title: 'разработка волны', when: 'когда владелец просит поправить Волну', rules: ['Репозиторий CallAssistant', 'Сначала HTML-макет', 'Прогнать npm test', 'Прогнать npm test']
  }), context));
  assert.deepEqual(updated, { saved: 'разработка волны', created: false, rules: 3 });
  assert.equal((await skills.list()).length, 1);
  assert.deepEqual((await skills.history('razrabotka-volny')).map(v => v.rules.length), [2]);
  assert.equal(JSON.parse(await registry.call('techcard_read', JSON.stringify({ topic: 'рецепты' }), context)).found, false);
  assert.equal(JSON.parse(await registry.call('techcard_delete', JSON.stringify({ title: 'рецепты' }), context)).deleted, false);
  assert.deepEqual(JSON.parse(await registry.call('techcard_delete', JSON.stringify({ title: 'Разработка Волны' }), context)), { deleted: true, title: 'разработка волны' });
  assert.deepEqual(await skills.list(), []);
  assert.deepEqual(await skills.history('razrabotka-volny'), []);
});

test('an installed skill from the internet: its text is kept, voice adds owner rules, files are readable only inside the folder', async () => {
  const skills = new SkillStore({ ownerDir: await temp('owner') });
  const source = await writeSkill(await temp('download'), 'pdf-tools', PDF_SKILL, { 'references/guide.md': 'Use camelot for lattice tables.', 'scripts/run.py': 'print(1)' });
  const installed = await skills.install(source);
  assert.deepEqual([installed.name, installed.title, installed.source, installed.byWave], ['pdf-tools', 'pdf-tools', 'owner', false]);
  assert.deepEqual(installed.files, ['references/guide.md', 'scripts/run.py']);
  await assert.rejects(skills.install(source), /already installed/);

  const registry = new ToolRegistry(techCardTools(skills));
  await registry.call('techcard_write', JSON.stringify({ title: 'pdf-tools', when: 'когда про PDF', rules: ['Отчёты класть в Documents'] }), context);
  const file = await readFile(join(skills.ownerDir, 'pdf-tools', 'SKILL.md'), 'utf8');
  assert.match(file, /^---\nname: pdf-tools\ndescription: >\n  Extract text/);
  assert.match(file, /Use pdfplumber for tables\.[\s\S]*## Правила владельца\n\n1\. Отчёты класть в Documents\n$/);

  const read = JSON.parse(await registry.call('techcard_read', JSON.stringify({ topic: 'pdf' }), context));
  assert.equal(read.card.when, 'Extract text and tables from PDF files. Use when the user mentions a PDF.');
  assert.match(read.card.instructions, /^Use pdfplumber for tables/);
  assert.doesNotMatch(read.card.instructions, /Правила владельца/);
  assert.deepEqual(read.card.rules, ['1. Отчёты класть в Documents']);
  const guide = JSON.parse(await registry.call('techcard_read', JSON.stringify({ topic: 'pdf-tools', file: 'references/guide.md' }), context));
  assert.equal(guide.text, 'Use camelot for lattice tables.');
  const escape = JSON.parse(await registry.call('techcard_read', JSON.stringify({ topic: 'pdf-tools', file: '../../etc/passwd' }), context));
  assert.equal(escape.found, false);

  assert.equal(await skills.wipeOwn(), 0);
  assert.equal((await skills.list()).length, 1, 'forget-all keeps installed skills');
});

test('built-in skill: read-only, voice rules lie in an overlay on top, deleting removes only the overlay', async () => {
  const builtin = await temp('builtin');
  await writeSkill(builtin, 'mail', '---\nname: mail\ndescription: Разбор почты и письма.\nmetadata:\n  title: Почта\n---\n\n# Почта\n\nВажное: письма от людей, которые ждут ответа.\n');
  const skills = new SkillStore({ ownerDir: await temp('owner'), builtinDir: builtin });
  const { skill, created } = await skills.writeRules({ title: 'Почта', when: 'про почту', rules: ['Письма от банка всегда важные'] });
  assert.equal(created, false);
  assert.deepEqual([skill.source, skill.overlay, skill.description, skill.rules], ['builtin', true, 'Разбор почты и письма.', ['Письма от банка всегда важные']]);
  assert.match(skill.body, /Важное: письма от людей[\s\S]*## Правила владельца\n\n1\. Письма от банка всегда важные/);
  assert.equal(await readFile(join(builtin, 'mail', 'SKILL.md'), 'utf8').then(text => text.includes('банка')), false, 'built-in file untouched');

  assert.equal(await skills.remove('mail'), 'removed');
  const [plain] = await skills.list();
  assert.deepEqual([plain!.overlay, plain!.rules], [false, []]);
  assert.equal(await skills.remove('mail'), 'readonly');
});

test('tech cards move from memory.json with their history; forget-all removes voice cards', async () => {
  const skills = new SkillStore({ ownerDir: await temp('owner') });
  const moved = await skills.migrate([{
    title: 'Добавление возможностей', when: 'когда просит новую фичу', rules: ['Новый чат в режиме плана'], updatedAt: now.toISOString(),
    history: [{ at: '2026-09-22T10:00:00Z', title: 'Добавление возможностей', when: 'когда просит', rules: [] }]
  }]);
  assert.equal(moved, 1);
  const [card] = await skills.list();
  assert.deepEqual([card!.name, card!.title, card!.byWave, card!.rules], ['dobavlenie-vozmozhnostey', 'Добавление возможностей', true, ['Новый чат в режиме плана']]);
  assert.equal((await skills.history(card!.name)).length, 1);
  assert.equal(await skills.migrate([{ title: 'Добавление возможностей', when: 'x', rules: [], updatedAt: '', history: [] }]), 0);
  assert.equal(await skills.index(), 'Техкарты: «Добавление возможностей» (когда просит новую фичу).');
  assert.equal(await skills.wipeOwn(), 1);
  assert.equal(await skills.index(), '');
});

test('memory API lists skills as tech cards, marks fresh rules, refuses to delete a built-in one', async () => {
  const { memoryRoutes } = await import('../http/memory-routes.ts');
  const { MemoryService } = await import('../memory/service.ts');
  const { MemoryStore } = await import('../memory/store.ts');
  const builtin = await temp('builtin');
  await writeSkill(builtin, 'mail', '---\nname: mail\ndescription: Почта.\n---\nТекст.\n');
  const skills = new SkillStore({ ownerDir: await temp('owner'), builtinDir: builtin });
  await skills.writeRules({ title: 'Разработка Волны', when: 'когда просит', rules: ['А', 'Б'] });
  await skills.writeRules({ title: 'Разработка Волны', when: 'когда просит', rules: ['А', 'В', 'Б'] });
  const store = new MemoryStore(await temp('memory'));
  await store.load(now);
  const memory = new MemoryService({ store, log: silentLogger, extractor: { apiKey: '', model: '', timeZone: 'UTC', log: silentLogger } });
  const app = memoryRoutes(memory, async (_c, next) => { await next(); }, undefined, skills);
  const view: any = await (await app.request('/')).json();
  assert.deepEqual(view.techCards.map((c: any) => [c.id, c.title, c.fresh, c.versions, c.source]), [
    ['razrabotka-volny', 'Разработка Волны', [1], 2, 'owner'], ['mail', 'mail', [], 1, 'builtin']
  ]);
  assert.equal((await app.request('/techcards/mail', { method: 'DELETE' })).status, 409);
  assert.equal((await app.request('/techcards/razrabotka-volny', { method: 'DELETE' })).status, 200);
  assert.equal((await app.request('/techcards/razrabotka-volny', { method: 'DELETE' })).status, 404);
});
