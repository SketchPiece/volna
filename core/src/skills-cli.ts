import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fetchSource } from './cli/fetch-source.ts';
import { loadConfig } from './config.ts';
import { PluginStore } from './plugins/store.ts';
import { SKILL_FILE } from './skills/format.ts';
import { SkillStore } from './skills/store.ts';
import { checkRouting, readProbes, ROUTING_PROBES } from './skills/check.ts';
import { routeWhen, textOnly } from './skills/routing.ts';
import { jevClient, JEV_PROVIDERS } from './jev/client.ts';

/**
 * `npm run skills`: техкарты (скиллы) ядра. `-- add <папка | git URL | github.com/…/tree/<ветка>/<путь>> [путь внутри]
 * [--force]` ставит скилл в data/skills; `-- remove <имя>` удаляет свой или установленный; `-- check <имя>` проверяет,
 * узнаёт ли Jev техкарту по её пробным фразам (skills/check.ts). Ядро видит изменения со
 * следующего звонка, перезапуск не нужен. Скрипты из скиллов ядро не запускает (docs/skills.md).
 */
const config = loadConfig();
const plugins = new PluginStore(resolve(config.memoryDir, 'plugins'));
const skills = new SkillStore({
  ownerDir: resolve(config.memoryDir, 'skills'), builtinDir: resolve(import.meta.dirname, '..', 'skills'), externalDirs: config.skillsExtraDirs,
  pluginDirs: () => plugins.skillDirs()
});
const args = process.argv.slice(2);
const force = args.includes('--force');
const [command = 'list', target, inside] = args.filter(arg => arg !== '--force');

if (command === 'add' && target) {
  const { dir, cleanup } = await fetchSource(target);
  try {
    const found = await findSkills(inside ? join(dir, inside) : dir);
    if (found.length !== 1) {
      console.log(found.length ? `Found ${found.length} skills, pick one:\n${found.map(path => `  npm run skills -- add ${target} ${relative(dir, path) || '.'}`).join('\n')}` : `No ${SKILL_FILE} in ${target}`);
      process.exitCode = 1;
    } else {
      const skill = await skills.install(found[0]!, { force });
      console.log(`Installed «${skill.name}»: ${skill.description}`);
      if (skill.files.some(file => file.startsWith('scripts/'))) console.log('Note: the skill has scripts; the core never runs them, only reads the text.');
    }
  } finally {
    await cleanup();
  }
} else if (command === 'check' && target) {
  // Проверка маршрута новой техкарты на Jev (skills/check.ts): её запускает агент, который техкарту написал.
  const all = await skills.list();
  const skill = all.find(s => s.name === target);
  const probes = skill ? await readProbes(skill) : null;
  if (!skill || !probes) {
    console.log(skill ? `No ${ROUTING_PROBES} in ${skill.dir}: write should/shouldNot phrases first.` : `No skill «${target}».`);
    process.exitCode = 1;
  } else if (!config.jev.apiKey) {
    console.log('No Jev key (TYPESAFE_API_KEY or OPEN_ROUTER_API_KEY) in core/.env: cannot check.');
    process.exitCode = 1;
  } else {
    const jev = jevClient({ apiKey: config.jev.apiKey, model: config.jev.model, url: JEV_PROVIDERS[config.jev.provider].url, timeoutMs: 10_000 });
    const cards = all.filter(s => s.tools.length || textOnly(s) || s.name === skill.name).map(s => ({ name: s.name, when: routeWhen(s) }));
    const result = await checkRouting(skill.name, cards, probes, jev, config.jev.routeThreshold);
    for (const [group, rows] of [['should', result.should], ['shouldNot', result.shouldNot]] as const) {
      console.log(`${group}: ${rows.filter(r => r.ok).length}/${rows.length}`);
      for (const row of rows.filter(r => !r.ok)) console.log(`  ✗ «${row.text}» → ${row.choice} (${row.p})`);
    }
    console.log(result.passed ? `Passed: Jev picks «${skill.name}» among ${cards.length} tech cards.` : `Failed: sharpen the description and check again, or set metadata.route: "off".`);
    if (!result.passed) process.exitCode = 1;
  }
} else if (command === 'remove' && target) {
  const result = await skills.remove(target);
  console.log(result === 'removed' ? `Removed «${target}».` : result === 'readonly' ? `«${target}» is built-in, external or from a plugin; remove it from its folder or with npm run plugins -- remove.` : `No skill «${target}».`);
} else {
  const all = await skills.list();
  if (!all.length) console.log('No tech cards yet.');
  for (const skill of all) {
    console.log(`${skill.name} [${skill.source}${skill.overlay ? ' + owner rules' : ''}] ${skill.title !== skill.name ? `«${skill.title}» ` : ''}— ${skill.description}`);
    if (skill.rules.length) console.log(`  owner rules: ${skill.rules.length}`);
  }
}

async function findSkills(dir: string, depth = 0): Promise<string[]> {
  if (await stat(join(dir, SKILL_FILE)).then(() => true, () => false)) return [dir];
  if (depth >= 4) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => findSkills(join(dir, e.name), depth + 1)));
  return nested.flat();
}
