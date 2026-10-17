import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { TraceStore } from './telemetry/trace.ts';
import { greetingSummary, summarize, turnsCsv, type Stat } from './telemetry/summary.ts';
import { defaultTools } from './assistant/tools/index.ts';

/**
 * `npm run metrics` — сводка задержек по сохранённым звонкам, сгруппированная по настройкам.
 * `-- --since 2026-09-22` только звонки с этой даты; `-- --csv` все ходы в CSV; `-- --json` сводка в JSON.
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const config = loadConfig();
const store = new TraceStore(resolve(value('dir') ?? config.metricsDir ?? 'data/metrics'));
const files = await store.load(value('since'));

if (flag('csv')) {
  process.stdout.write(turnsCsv(files));
} else {
  const summary = summarize(files, defaultTools().jevCandidates().map(c => c.name));
  if (flag('json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (!files.length) {
    console.log(`Замеров нет в ${store.dir}. Они пишутся после каждого звонка, если METRICS=on.`);
  } else {
    const show = (s: Stat) => s.n ? `p50 ${s.p50} · p90 ${s.p90} · n ${s.n}` : '—';
    console.log(`Звонков ${summary.calls}, ходов ${summary.turns}. Каталог ${store.dir}\n`);
    for (const group of summary.groups) {
      console.log(`■ ${group.config}  (звонков ${group.calls}, ходов ${group.turns})`);
      console.log(`  ответ слышен, ход с инструментом    ${show(group.answerWithTools)}`);
      console.log(`  ответ слышен, без делегирования     ${show(group.answerDirect)}`);
      for (const [name, s] of Object.entries(group.metrics)) console.log(`  ${name.padEnd(35)}${show(s)}`);
      for (const [tool, s] of Object.entries(group.perTool)) {
        console.log(`  · ${tool.padEnd(20)} выбор ${show(s.select)} | исполнение ${show(s.tool)} | ответ ${show(s.answer)}`);
      }
      for (const [route, r] of Object.entries(group.perRoute)) {
        console.log(`  ↳ ${route.padEnd(20)} ответ ${show(r.answer)} | подняли ${r.escalated}`);
      }
      if (group.jev) {
        const actions = Object.entries(group.jev.actions).map(([k, v]) => `${k} ${v}`).join(', ');
        console.log(`  Jev: совпал с бэкендом ${group.jev.agree}/${group.jev.evaluated}; действия: ${actions}`);
      }
      console.log('');
    }
    const greeting = greetingSummary(files);
    if (greeting.calls) {
      console.log(`Приветствие (звонков с командой ${greeting.calls}): сразу ${greeting.said}, позже 4 с ${greeting.late}, молча ${greeting.silent}`);
      console.log(`  через сколько мс после команды  ${show(greeting.saidMs)}`);
      console.log(`  вход до команды, дБ: поздоровалась ${show(greeting.inDbSaid)} | нет ${show(greeting.inDbSilent)}\n`);
    }
    console.log('Интервалы в мс; смысл каждого в core/src/telemetry/summary.ts.');
  }
}
