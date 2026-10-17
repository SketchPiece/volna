import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { DecisionModel } from '../jev/client.ts';
import { readChoice, routeRequest, type CardOption } from '../jev/questions.ts';
import type { Skill } from './store.ts';

/**
 * Проверка новой техкарты на Jev (docs/skills.md): узнаёт ли маршрутизатор её по пробным фразам среди всех техкарт.
 * Фразы пишет автор техкарты (агент со skill-creator) в `evals/volna-routing.json`: `should` — просьбы, для которых она
 * нужна, `shouldNot` — похожие, для которых нет. Техкарта, не прошедшая проверку, остаётся текстом: `metadata.route: "off"`.
 */
export const ROUTING_PROBES = 'evals/volna-routing.json';
export const PASS_SHARE = 0.85;

const probesSchema = z.object({ should: z.array(z.string().min(1)).min(1), shouldNot: z.array(z.string().min(1)).min(1) });
export type RoutingProbes = z.infer<typeof probesSchema>;

export async function readProbes(skill: Pick<Skill, 'dir'>): Promise<RoutingProbes | null> {
  try { return probesSchema.parse(JSON.parse(await readFile(join(skill.dir, ROUTING_PROBES), 'utf8'))); } catch { return null; }
}

export interface ProbeResult { text: string; choice: string; p: number; ok: boolean }
export interface RoutingCheck { should: ProbeResult[]; shouldNot: ProbeResult[]; passed: boolean }

/** Каждая фраза — отдельный запрос к Jev, как реплика пользователя в звонке. Уверенность ниже `threshold` не считается выбором. */
export async function checkRouting(name: string, cards: readonly CardOption[], probes: RoutingProbes, jev: DecisionModel, threshold = 0.6): Promise<RoutingCheck> {
  const ask = async (text: string, wanted: boolean): Promise<ProbeResult> => {
    const request = routeRequest([{ role: 'assistant', text: 'Слушаю.' }, { role: 'user', text }], [], cards);
    const choice = readChoice((await jev.decide(request, AbortSignal.timeout(10_000))).answers, 'techcard');
    const picked = Boolean(choice && choice.choice === name && choice.p >= threshold);
    return { text, choice: choice?.choice ?? '?', p: Math.round((choice?.p ?? 0) * 100) / 100, ok: picked === wanted };
  };
  const should = await Promise.all(probes.should.map(text => ask(text, true)));
  const shouldNot = await Promise.all(probes.shouldNot.map(text => ask(text, false)));
  const share = (results: ProbeResult[]) => results.filter(r => r.ok).length / results.length;
  return { should, shouldNot, passed: share(should) >= PASS_SHARE && share(shouldNot) >= PASS_SHARE };
}
