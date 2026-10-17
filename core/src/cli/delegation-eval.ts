import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.ts';
import { currentTime } from '../assistant/tools/current-time.ts';
import { aboutWave } from '../assistant/tools/about-wave.ts';
import { endCall } from '../assistant/tools/end-call.ts';
import { buildBackendInstructions } from '../assistant/persona.ts';
import { silentLogger } from '../log.ts';
import { MemoryStore } from '../memory/store.ts';
import { memoryTools } from '../memory/tools.ts';
import { historyTools } from '../memory/history.ts';
import { TaskStore } from '../tasks/store.ts';
import { workTools } from '../tasks/tools.ts';
import { SkillStore } from '../skills/store.ts';
import { techCardTools } from '../skills/tools.ts';
import { techcardCreateTool } from '../skills/create.ts';
import { routeCards } from '../skills/routing.ts';
import { HelmClient } from '../helm/client.ts';
import { pickProject } from '../helm/projects.ts';
import { helmTools } from '../helm/tools.ts';
import { ToolRegistry, type Tool } from '../assistant/tools/registry.ts';
import { jevClient, JEV_PROVIDERS } from '../jev/client.ts';
import { backendModel, type ChatModel } from '../delegation/llm.ts';
import { ClientDelegate } from '../delegation/client.ts';
import { attachSideband } from '../realtime/sideband.ts';
import { CallTrace } from '../telemetry/trace.ts';
import { FakeSocket } from '../test-support.ts';

/**
 * Прогон просьб из записанного звонка на разных моделях класса standard, без звонка и без действий:
 * читающие инструменты настоящие, остальные отвечают заглушкой. `node --env-file=.env src/cli/delegation-eval.ts <консоль звонка> <модель>...`
 * Спецификация модели: `модель[@effort][+тариф]`, например `openai/gpt-5.6-luna+fast` (тариф уходит в `service_tier`).
 */
const [file, ...models] = process.argv.slice(2);
if (!file || !models.length) throw new Error('usage: delegation-eval.ts <console json> <model[@effort][+tier]>...');
const config = loadConfig();
const cd = config.clientDelegation!;
const store = new MemoryStore(resolve(config.memoryDir));
await store.load();
const tasks = new TaskStore(resolve(config.memoryDir));
await tasks.load();
const skills = new SkillStore({ ownerDir: resolve(config.memoryDir, 'skills'), builtinDir: resolve(import.meta.dirname, '..', '..', 'skills'), log: silentLogger });
const helm = new HelmClient({ url: config.helm!.url, token: config.helm!.token });
const dirs = { defaultDir: config.helm!.projectDir, defaultTitle: 'Волна: Работа', newDir: config.helm!.newProjectsDir };
const runner = {} as any;
const real: Tool[] = [
  currentTime, aboutWave, endCall, ...memoryTools(store), ...historyTools(store, () => tasks), ...techCardTools(skills),
  ...workTools(runner, tasks, { pickProject: (asked, create, signal) => pickProject(helm, asked, create, dirs, signal) }),
  techcardCreateTool({ runner, ownerDir: skills.ownerDir, serverDir: resolve(import.meta.dirname, '..', '..'), toolNames: () => [] }),
  ...helmTools({ client: helm, store: tasks, runtimeMode: config.helm!.runtimeMode })
];
const actions: string[] = [];
const tools = new ToolRegistry(real.map(tool => tool.effect === 'read' ? tool : { ...tool, execute: (args: unknown) => {
  actions.push(`${tool.name} ${JSON.stringify(args)}`);
  return { started: true, sent: true, saved: true, id: 'eval', say: 'Готово.' };
} } as Tool));
const cards = routeCards(await skills.list(), tools);
const techCards = await skills.index();
const jev = config.jev;

// EVAL_FILTER: свой отбор просьб (регулярное выражение), `.` берёт все делегирования звонка.
const ONLY = new RegExp(process.env.EVAL_FILTER ?? 'Call Assistant|новый чат|кошечками|цвет выбрать|обсуждали|техкарту|тарифы тр|немецким|загрузк|работу запустить|PDF|AirPods|скриншоты|Удали|Переименуй');
const recorded = JSON.parse(await readFile(file, 'utf8'));
const cases: { turns: { role: string; text: string }[] }[] = recorded.events
  .filter((e: any) => e.type === 'console.context')
  .map((e: any) => ({ turns: e.data.turns }))
  .filter((c: any) => ONLY.test(c.turns.at(-1).text) || ONLY.test(c.turns.at(-2)?.text ?? ''));

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const summary: string[] = [];
for (const spec of models) {
  const [base, tier] = spec.split('+');
  const [model, effort] = base!.split('@');
  const served = new Map<string, number>();
  const rounds: number[] = [], requests: number[] = [];
  let cost = 0, outTokens = 0;
  for (const { turns } of cases) {
    actions.length = 0;
    const log: string[] = [];
    const wrap = (inner: ChatModel): ChatModel => ({ model: inner.model, complete: async (messages, list, signal) => {
      const started = performance.now();
      const result = await inner.complete(messages, list, signal);
      if (inner.model === model) { rounds.push(performance.now() - started); cost += result.usage.costUsd ?? 0; outTokens += result.usage.outTokens ?? 0; served.set(result.serviceTier ?? '-', (served.get(result.serviceTier ?? '-') ?? 0) + 1); }
      log.push(`  ${inner.model.split('/')[1]} ${Math.round(performance.now() - started)}ms out=${result.usage.outTokens} tier=${result.serviceTier ?? '-'} r=${result.usage.reasoningTokens ?? '-'} ${result.toolCalls.map(c => `${c.function.name}(${c.function.arguments.slice(0, 260)})`).join(' ') || JSON.stringify(result.content?.slice(0, 200))}`);
      return result;
    } });
    // Модели openai/* как в ядре: напрямую в Responses API; EVAL_VIA=openrouter — через OpenRouter, для сравнения.
    const keys = { openRouterKey: cd.apiKey, openAiKey: process.env.EVAL_VIA === 'openrouter' ? null : cd.openAiKey };
    const extra = { ...(effort ? { reasoning: { effort } } : {}), ...(tier ? { service_tier: tier } : {}) };
    const delegate = new ClientDelegate({
      // EVAL_SIMPLE=same: та же модель и в классе simple, чтобы сравнить модель на всех просьбах, а не только на standard.
      models: { simple: wrap(process.env.EVAL_SIMPLE === 'same' ? backendModel({ ...keys, model, extra }) : backendModel({ ...keys, model: cd.models.simple })), standard: wrap(backendModel({ ...keys, model, extra })) },
      tools, cards, instructions: names => buildBackendInstructions(names, { techCards }),
      timeZone: config.timeZone, log: { ...silentLogger, warn: (m: string, f?: object) => log.push(`  WARN ${m} ${JSON.stringify(f)}`), error: (m: string, f?: object) => log.push(`  ERROR ${m} ${JSON.stringify(f)}`) } as any, callId: 'eval', trace: new CallTrace({ callId: 'eval', config: {}, onMark: e => {
        if (e.type === 'jev.result' && 'card' in (e.data as any)) log.push(`  jev ${(e.data as any).card}/${(e.data as any).tier} ${(e.data as any).action}`);
        // Упавший запрос модели (таймаут, ошибка API) не виден в кругах: его выдаёт только эскалация с причиной.
        if (e.type === 'client.escalate') log.push(`  ESCALATE ${(e.data as any).from}→${(e.data as any).to} ${(e.data as any).reason}`);
      } }),
      jev: { model: jevClient({ apiKey: jev.apiKey, model: jev.model, url: JEV_PROVIDERS[jev.provider].url }), threshold: jev.toolThreshold, routeThreshold: jev.routeThreshold },
      settleMs: 1, maxSettleMs: 5
    });
    FakeSocket.reset();
    attachSideband({ apiKey: 'k', callId: 'eval', tools, log: silentLogger, timeZone: config.timeZone, socketFactory: FakeSocket.factory, listeners: [delegate] });
    const socket = FakeSocket.instances[0]!;
    for (const turn of turns) {
      socket.message({ type: turn.role === 'user' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta: turn.text });
      await new Promise(r => setTimeout(r, 5));
    }
    const started = performance.now();
    socket.message({ type: 'session.delegation.created', delegation: { id: 'item_eval', type: 'delegation', target: 'client' } });
    let answer: any;
    while (!(answer = socket.sent.find((e: any) => e.type === 'session.commentary.append')) && performance.now() - started < 90_000) await new Promise(r => setTimeout(r, 50));
    requests.push(performance.now() - started);
    console.log(`\n### ${spec} | «${turns.at(-1)!.text.slice(0, 70)}» | ${((performance.now() - started) / 1000).toFixed(1)}s`);
    console.log(log.join('\n'));
    if (actions.length) console.log(`  ACTION ${actions.join('; ')}`);
    console.log(`  => ${answer?.content?.slice(0, 300) ?? 'TIMEOUT'}`);
    socket.close();
  }
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} с`;
  summary.push(`| ${spec} | ${rounds.length} | ${s(pct(rounds, 0.5))} / ${s(pct(rounds, 0.9))} | ${s(pct(requests, 0.5))} / ${s(Math.max(...requests))} | ${outTokens} | $${cost.toFixed(4)} | ${[...served].map(([t, n]) => `${t}×${n}`).join(' ')} |`);
}
console.log(`\n| Модель | Кругов | Круг p50 / p90 | Просьба p50 / макс. | Выход, токены | Цена | Тариф ответа |\n|---|---|---|---|---|---|---|\n${summary.join('\n')}`);
process.exit(0);
