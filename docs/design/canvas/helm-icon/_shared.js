// Иконки «Штурвала» в той же сетке, что иконка Волны: viewBox 120, диск r=44, линия 5.5.
const C = { ivory:'#E7E0D2', bakelite:'#26211D', signal:'#B8321F', lamp:'#E8A33D', ether:'#1F1B18' };
const WAVE = 'M27 60 Q32 55 37 60 Q43 68 49 60 Q55 40 62 60 Q69 80 75 60 Q81 52 87 60 Q90 62 93 60';

function polar(r, deg) { const a = deg * Math.PI / 180; return [60 + r * Math.cos(a), 60 + r * Math.sin(a)]; }
function seg(r1, r2, deg, color, w) {
  const [x1, y1] = polar(r1, deg), [x2, y2] = polar(r2, deg);
  return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
}
// Штурвал: обод, ступица, спицы и рукояти за ободом.
function helm({ color, rim = 24, hub = 6.5, reach = 35, n = 8, rot = 22.5, w = 5.5, knob = 8, skip = [] }) {
  let s = `<circle cx="60" cy="60" r="${rim}" fill="none" stroke="${color}" stroke-width="${w}"/>`;
  s += `<circle cx="60" cy="60" r="${hub}" fill="none" stroke="${color}" stroke-width="${w}"/>`;
  for (let i = 0; i < n; i++) {
    if (skip.includes(i)) continue;
    const d = rot + i * 360 / n;
    s += seg(hub + w / 2, rim, d, color, w * 0.8);
    s += seg(rim + w / 2 + 1.5, reach, d, color, knob);
  }
  return s;
}

const ICONS = {
  volna: () => `<circle cx="60" cy="60" r="44" fill="${C.signal}"/><path d="${WAVE}" fill="none" stroke="${C.ivory}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  // А3. Атомный век: тонкий обод, ступица-шар, спицы-антенны с шариками.
  a3: () => disc() + `<circle cx="60" cy="60" r="24" fill="none" stroke="${C.ivory}" stroke-width="4"/>`
    + `<circle cx="60" cy="60" r="9" fill="${C.ivory}"/>`
    + [30, 90, 150, 210, 270, 330].map(d => { const [x, y] = polar(35, d); return seg(9, 35, d, C.ivory, 3.4) + `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="4.4" fill="${C.ivory}"/>`; }).join(''),
};

function arc(r, from, to, color, w) {
  const [x1, y1] = polar(r, from), [x2, y2] = polar(r, to);
  return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
}
function disc() { return `<circle cx="60" cy="60" r="44" fill="${C.signal}"/>`; }

const ball = (r, d, rad, color = C.ivory) => { const [x, y] = polar(r, d); return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${rad}" fill="${color}"/>`; };
const lampBall = r => `<circle cx="60" cy="60" r="${r}" fill="${C.lamp}" style="filter:drop-shadow(0 0 3px rgba(232,163,61,.9))"/>`;
Object.assign(ICONS, {
  // А3·1. Лампа в шаре: ступица горит янтарём, как лампа Волны.
  c1: () => disc() + `<circle cx="60" cy="60" r="24" fill="none" stroke="${C.ivory}" stroke-width="4"/>`
    + [30, 90, 150, 210, 270, 330].map(d => seg(12, 35, d, C.ivory, 3.4) + ball(35, d, 4.4)).join('')
    + `<circle cx="60" cy="60" r="9.5" fill="none" stroke="${C.ivory}" stroke-width="3"/>` + lampBall(6.5),
  // А3·3. Звёздный взрыв 50-х: антенны разной длины.
  c3: () => disc() + `<circle cx="60" cy="60" r="21" fill="none" stroke="${C.ivory}" stroke-width="3.6"/>` + `<circle cx="60" cy="60" r="8" fill="${C.ivory}"/>`
    + [0, 90, 180, 270].map(d => seg(8, 37, d, C.ivory, 3.4) + ball(37, d, 4.6)).join('')
    + [45, 135, 225, 315].map(d => seg(8, 29, d, C.ivory, 3) + ball(29, d, 3.4)).join(''),
  // А3·4. Двойной обод, как орбиты; ступица — кольцо с точкой.
  c4: () => disc() + `<circle cx="60" cy="60" r="19" fill="none" stroke="${C.ivory}" stroke-width="2.8"/><circle cx="60" cy="60" r="26" fill="none" stroke="${C.ivory}" stroke-width="2.8"/>`
    + [30, 90, 150, 210, 270, 330].map(d => seg(11, 36, d, C.ivory, 3) + ball(36, d, 4.4)).join('')
    + `<circle cx="60" cy="60" r="8" fill="none" stroke="${C.ivory}" stroke-width="3"/><circle cx="60" cy="60" r="3.4" fill="${C.ivory}"/>`,
  // А3·5. Спутник: крупный шар, четыре длинные антенны по диагоналям, короткие спицы до обода.
  c5: () => disc() + `<circle cx="60" cy="60" r="26" fill="none" stroke="${C.ivory}" stroke-width="3.4"/>`
    + [45, 135, 225, 315].map(d => seg(12, 38, d, C.ivory, 3.2) + ball(38, d, 4.6)).join('')
    + [0, 90, 180, 270].map(d => seg(12, 26, d, C.ivory, 3.2)).join('') + `<circle cx="60" cy="60" r="12" fill="${C.ivory}"/>`,
});

const pc = (cx, cy, r, deg) => { const a = deg * Math.PI / 180; return [(cx + r * Math.cos(a)).toFixed(2), (cy + r * Math.sin(a)).toFixed(2)]; };
const glow = 'style="filter:drop-shadow(0 0 3px rgba(232,163,61,.9))"';
const L = (w = 5.5) => `fill="none" stroke="${C.ivory}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
Object.assign(ICONS, {
  // Д. Машинный телеграф: мостик отдаёт команду, машинное отделение выполняет.
  d: () => { const cx = 60, cy = 70; const [lx, ly] = pc(cx, cy, 27, -58), [ax, ay] = pc(cx, cy, 36.5, -58);
    return disc() + `<path d="M${pc(cx, cy, 30, 180).join(' ')} A30 30 0 0 1 ${pc(cx, cy, 30, 0).join(' ')}" ${L()}/>`
      + [-160, -122, -90, -20].map(d => { const [x1, y1] = pc(cx, cy, 35, d), [x2, y2] = pc(cx, cy, 38.5, d); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${L(4)}/>`; }).join('')
      + `<circle cx="${ax}" cy="${ay}" r="4.4" fill="${C.lamp}" ${glow}/>`
      + `<line x1="${cx}" y1="${cy}" x2="${lx}" y2="${ly}" ${L(5.5)}/><circle cx="${lx}" cy="${ly}" r="5" fill="${C.ivory}"/>`
      + `<line x1="26" y1="${cy}" x2="94" y2="${cy}" ${L(4)}/><circle cx="${cx}" cy="${cy}" r="7.5" fill="${C.ivory}"/>`; },
  // Е. Голос становится работой: волна знака переходит в цифровой сигнал.
  e: () => disc() + `<path d="M26 60 Q30 50 34 60 Q38 70 42 60 Q46 50 50 60 Q54 70 58 60 L58 47 L70 47 L70 73 L82 73 L82 60 L93 60" ${L()}/>`,
  // Ж. Радар: вся работа на экране, лампа — то, что сейчас идёт.
  f: () => disc() + `<defs><linearGradient id="sw" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${C.ivory}" stop-opacity="0"/><stop offset="1" stop-color="${C.ivory}" stop-opacity=".55"/></linearGradient></defs>`
    + `<circle cx="60" cy="60" r="34" ${L(4)}/><circle cx="60" cy="60" r="21" ${L(2.8)}/><line x1="26" y1="60" x2="94" y2="60" ${L(2.4)}/><line x1="60" y1="26" x2="60" y2="94" ${L(2.4)}/>`
    + `<path d="M60 60 L${pc(60, 60, 34, -100).join(' ')} A34 34 0 0 1 ${pc(60, 60, 34, -35).join(' ')} Z" fill="url(#sw)"/>`
    + `<line x1="60" y1="60" x2="${pc(60, 60, 34, -35)[0]}" y2="${pc(60, 60, 34, -35)[1]}" ${L(4.4)}/>`
    + `<circle cx="${pc(60, 60, 25, -62)[0]}" cy="${pc(60, 60, 25, -62)[1]}" r="4.6" fill="${C.lamp}" ${glow}/>`
    + `<circle cx="${pc(60, 60, 14, 150)[0]}" cy="${pc(60, 60, 14, 150)[1]}" r="3.2" fill="${C.ivory}"/><circle cx="${pc(60, 60, 28, 110)[0]}" cy="${pc(60, 60, 28, 110)[1]}" r="3.2" fill="${C.ivory}"/><circle cx="60" cy="60" r="4" fill="${C.ivory}"/>`,
  // З. Маяк: ведёт работу в темноте, свет расходится волнами.
  g: () => disc() + `<path d="M53.5 88 L55.5 56 H64.5 L66.5 88 Z" fill="${C.ivory}"/><path d="M52 88 H68" ${L(4)}/>`
    + `<rect x="54" y="44" width="12" height="9" rx="2" fill="${C.lamp}" ${glow}/><path d="M52 44 L60 36 L68 44 Z" fill="${C.ivory}"/><path d="M52 53.5 H68" ${L(3.4)}/>`
    + [[14, 24], [24, 28]].map(([r, sp]) => `<path d="M${pc(60, 48.5, r, -sp).join(' ')} A${r} ${r} 0 0 1 ${pc(60, 48.5, r, sp).join(' ')}" ${L(4.4)}/><path d="M${pc(60, 48.5, r, 180 - sp).join(' ')} A${r} ${r} 0 0 1 ${pc(60, 48.5, r, 180 + sp).join(' ')}" ${L(4.4)}/>`).join(''),
  // И. Буква Ш из столбиков сигнала: имя и уровень связи сразу.
  h: () => disc() + `<path d="M40 64 V82 H80 V40 M60 52 V82" ${L(8)}/><circle cx="80" cy="30" r="0" fill="none"/>`,
});

// Развития Е: тот же сигнал, но силуэт или цвет сразу отличает от Волны.
const E_PATH = 'M26 60 Q30 50 34 60 Q38 70 42 60 Q46 50 50 60 Q54 70 58 60 L58 47 L70 47 L70 73 L82 73 L82 60 L93 60';
const BG = { e1: C.bakelite, e4: C.signal };
Object.assign(ICONS, {
  // Е1. Ночная: тёмный бакелит вместо слоновой кости.
  e1: () => disc() + `<path d="${E_PATH}" ${L()}/>`,
  // Е2. Экран осциллографа: квадратный тёмный экран, сигнал горит лампой.
  e2: () => `<rect x="16" y="16" width="88" height="88" rx="20" fill="${C.bakelite}"/>`
    + [38, 60, 82].map(v => `<line x1="${v}" y1="24" x2="${v}" y2="96" stroke="${C.ivory}" stroke-opacity=".1" stroke-width="1.2"/><line x1="24" y1="${v}" x2="96" y2="${v}" stroke="${C.ivory}" stroke-opacity=".1" stroke-width="1.2"/>`).join('')
    + `<path d="${E_PATH}" fill="none" stroke="${C.lamp}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" ${glow}/>`,
  // Е3. Голос в команду: волна переходит в приглашение терминала, курсор горит лампой.
  e3: () => disc() + `<path d="M25 60 Q29 50 33 60 Q37 70 41 60 Q45 50 49 60" ${L()}/><path d="M57 47 L69 60 L57 73" ${L(6)}/>`
    + `<line x1="76" y1="73" x2="92" y2="73" stroke="${C.lamp}" stroke-width="6" stroke-linecap="round" ${glow}/>`,
  // Е4. Инверсия: красное поле, диск слоновой кости, сигнал бакелитом.
  e4: () => `<circle cx="60" cy="60" r="44" fill="${C.ivory}"/><path d="${E_PATH}" fill="none" stroke="${C.bakelite}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>`,
});

// Развития Е2: экран с горящим сигналом, разные корпуса и подачи.
const sig = (s = 1, cy = 60, color = C.lamp, lit = true) => `<g transform="translate(60 ${cy}) scale(${s}) translate(-60 -60)"><path d="${E_PATH}" fill="none" stroke="${color}" stroke-width="${(5.5 / s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" ${lit ? glow : ''}/></g>`;
const grid = (xs, ys, x1, x2, y1, y2) => xs.map(v => `<line x1="${v}" y1="${y1}" x2="${v}" y2="${y2}" stroke="${C.ivory}" stroke-opacity=".1" stroke-width="1.2"/>`).join('')
  + ys.map(v => `<line x1="${x1}" y1="${v}" x2="${x2}" y2="${v}" stroke="${C.ivory}" stroke-opacity=".1" stroke-width="1.2"/>`).join('');
Object.assign(BG, { e22: C.signal, e23: C.bakelite });
Object.assign(ICONS, {
  // Е2·1. Красная рамка: экран в красном корпусе, красный связывает с Волной.
  e21: () => `<rect x="14" y="14" width="92" height="92" rx="24" fill="${C.signal}"/><rect x="24" y="24" width="72" height="72" rx="13" fill="${C.bakelite}"/>`
    + grid([42, 60, 78], [42, 60, 78], 28, 92, 28, 92) + sig(.84),
  // Е2·2. Круглый экран на красном: как у лампового осциллографа.
  e22: () => `<circle cx="60" cy="60" r="44" fill="${C.bakelite}"/><circle cx="60" cy="60" r="44" fill="none" stroke="${C.ivory}" stroke-width="3"/>`
    + grid([38, 60, 82], [38, 60, 82], 20, 100, 20, 100).replace(/<line/g, '<line clip-path="url(#rs)"') + `<clipPath id="rs"><circle cx="60" cy="60" r="41"/></clipPath>` + sig(.95),
  // Е2·3. Весь экран: иконка целиком тёмная, в углу красная лампа «идёт работа».
  e23: () => grid([30, 45, 60, 75, 90], [30, 45, 60, 75, 90], 12, 108, 12, 108) + sig(1.08)
    + `<circle cx="93" cy="27" r="5" fill="${C.signal}"/>`,
  // Е2·4. Прибор: экран сверху, под ним красные ручки, как на панели осциллографа.
  e24: () => `<rect x="14" y="14" width="92" height="92" rx="22" fill="${C.bakelite}"/><rect x="22" y="22" width="76" height="52" rx="10" fill="#1A1613"/>`
    + grid([41, 60, 79], [35, 48, 61], 24, 96, 24, 72) + sig(.82, 48)
    + [42, 78].map(x => `<circle cx="${x}" cy="89" r="8" fill="${C.signal}"/><line x1="${x}" y1="89" x2="${x}" y2="83" stroke="${C.ivory}" stroke-width="2.6" stroke-linecap="round"/>`).join('')
    + `<circle cx="60" cy="89" r="3.4" fill="${C.lamp}" ${glow}/>`,
  // Е2·5. Кремовый след: сигнал светлый, горит только точка на конце — где сейчас идёт работа.
  e25: () => `<rect x="16" y="16" width="88" height="88" rx="20" fill="${C.bakelite}"/>`
    + [28, 36, 44, 52, 60, 68, 76, 84, 92].map(y => `<line x1="20" y1="${y}" x2="100" y2="${y}" stroke="${C.ivory}" stroke-opacity=".07" stroke-width="1.6"/>`).join('')
    + `<path d="M26 60 Q30 50 34 60 Q38 70 42 60 Q46 50 50 60 Q54 70 58 60 L58 47 L70 47 L70 73 L82 73 L82 60 L86 60" ${L()}/><circle cx="91" cy="60" r="5.2" fill="${C.lamp}" ${glow}/>`,
});

function icon(key, size, { shape = 'ios' } = {}) {
  const bg = `<rect width="120" height="120" rx="27" fill="${BG[key] || C.ivory}"/>`;
  if (shape === 'mac') // macOS: квадрат 824/1024 с полями, лёгкая тень
    return `<svg width="${size}" height="${size}" viewBox="0 0 120 120"><defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-opacity=".28"/></filter></defs><g filter="url(#sh)"><g transform="translate(11.7 11.7) scale(.805)">${bg}${ICONS[key]()}</g></g></svg>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 120 120">${bg}${ICONS[key]()}</svg>`;
}

function board(key, title, line) {
  document.body.innerHTML = `
  <main>
    <div class="big">${icon(key, 380)}</div>
    <div class="side">
      <h1>${title}</h1>
      <p>${line}</p>
      <div class="sizes">${[128, 64, 32, 16].map(s => `<figure>${icon(key, s)}<figcaption>${s}</figcaption></figure>`).join('')}</div>
      <div class="dock">${icon('volna', 76, { shape: 'mac' })}${icon(key, 76, { shape: 'mac' })}<span class="dot"></span></div>
      <div class="pair"><span>Волна</span><span>Штурвал</span></div>
    </div>
  </main>`;
}
