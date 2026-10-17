import { allPhrases, pickGreeting, type DayPart, type Gap } from './greeting/phrases.ts';
import { CREATOR } from './assistant/tools/about-wave.ts';

/**
 * `npm run greetings`: весь набор фраз приветствия и по нескольку выборов для каждой ситуации, чтобы послушать глазами
 * до звонка. Правка фраз — в greeting/phrases.ts, ядро подхватывает их после перезапуска.
 */
for (const { group, texts } of allPhrases()) console.log(`${group}: ${texts.map(text => `«${text}»`).join(', ')}`);

console.log('\nВыбор по ситуациям (5 звонков подряд):');
const parts: DayPart[] = ['morning', 'day', 'evening', 'night'];
// «none» бывает только у самого первого звонка, его фразы видны в списке выше.
const gaps: Gap[] = ['minutes', 'hours', 'long'];
for (const name of [null, CREATOR]) {
  for (const part of parts) for (const gap of gaps) {
    const recent: string[] = [];
    for (let i = 0; i < 5; i++) recent.push(pickGreeting({ part, gap, name, creator: name === CREATOR }, recent).text);
    console.log(`${part.padEnd(7)} ${gap.padEnd(7)} ${name ?? '—'}: ${recent.join(' | ')}`);
  }
}
