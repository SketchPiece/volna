// Live call mark for the canvas boards. One 15-second loop of a conversation:
// silence → owner speaks → pause → Volna thinks → Volna speaks → silence.
// The wave is drawn in the same 120-unit box as WaveMark.swift (disc 272 pt, inner box 82 %).
(() => {
  const C = { ivory: '#E7E0D2', signal: '#B8321F', lamp: '#E8A33D', lampHot: '#F2B550', lampOff: '#CFC6B6' };
  const variant = document.body.dataset.variant;

  const icons = {
    listening: '<svg viewBox="0 0 24 24"><path d="M6 10a6 6 0 0 1 12 0c0 3-2 4-3 6s-1 4-3 4"/><path d="M9 10a3 3 0 0 1 6 0c0 2-2 2-2 4"/></svg>',
    thinking: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
    speaking: '<svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>',
  };
  const words = { listening: 'Слушаю', thinking: 'Думаю', speaking: 'Говорю' };

  document.body.innerHTML = `
  <div class="phone-wrap"><div class="phone">
    <div class="island"></div><div class="sb"><span>9:41</span><span>●●● ▮</span></div>
    <div class="topbar"><svg width="26" height="26" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="58" fill="#B8321F"/><path d="M16 60 Q23 54 30 60 Q38 70 46 60 Q55 34 64 60 Q73 86 82 60 Q90 50 98 60 Q101 63 104 60" fill="none" stroke="#E7E0D2" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>ВОЛНА-1</div>
    <div class="title">Волна</div>
    <p class="status-line" id="status"></p>
    <div class="stagearea"><div class="markbox"><div class="disc" id="disc"></div><canvas id="cv" width="800" height="800"></canvas></div><span class="timer" id="timer">00:41</span></div>
    <div class="row3">
      <span class="ctl sm"><span class="k"><svg width="22" height="22" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg></span><span class="l">Микрофон</span></span>
      <span class="ctl"><span class="end"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FBF6EC" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2.5a9 9 0 0 0-7 0V14l-3 1.5z"/></svg></span></span>
      <span class="ctl sm"><span class="k"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M9 10h6M9 14h6M9 18h4"/></svg></span><span class="l">Стенограмма</span></span>
    </div>
    <div class="home"></div>
  </div></div>`;

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const disc = document.getElementById('disc');
  const statusEl = document.getElementById('status');
  const timerEl = document.getElementById('timer');

  // ---- conversation script ----
  const LOOP = 15.2;
  function script(T) {
    if (T < 1) return { phase: 'listening', me: 0, volna: 0 };
    if (T < 4.6) return { phase: 'listening', me: speech(T - 1, 3.6, 4.4, 1), volna: 0 };
    if (T < 5.6) return { phase: 'listening', me: 0, volna: 0 };
    if (T < 8) return { phase: 'thinking', me: 0, volna: 0 };
    if (T < 13.6) return { phase: 'speaking', me: 0, volna: speech(T - 8, 5.6, 4.8, 7) };
    return { phase: 'listening', me: 0, volna: 0 };
  }
  function hash(n) { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); }
  // Syllables at `rate` per second, a short pause every fifth one, soft start and end.
  function speech(tau, length, rate, seed) {
    const x = tau * rate, i = Math.floor(x), f = x - i;
    const edge = Math.min(1, tau / 0.25, (length - tau) / 0.35);
    if (i % 5 === 4 && hash(Math.floor(i / 5) + seed) > 0.25) return 0.02;
    const a = 0.4 + 0.6 * hash(i * 1.7 + seed);
    return Math.max(0, edge) * a * Math.pow(Math.sin(Math.PI * f), 1.3);
  }

  // ---- motion (same easing as WaveMotion in WaveMark.swift) ----
  const m = { me: 0, volna: 0, amp: null, phase: 0, travel: 0, sampled: { me: 0, volna: 0 }, lastSample: -1,
              orbit: 0, thinkingFor: 0, echoes: [], ripples: [], prev: { me: 0, volna: 0 }, peakArmed: { me: true, volna: true } };
  const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
  const follow = (cur, target, dt) => ease(cur, target, target > cur ? 18 : 6, dt);

  // ---- drawing helpers ----
  const DPR = 2, PX = 400;            // canvas CSS size
  const D = 272, INNER = D * 0.82, U = INNER / 120;
  const OX = PX / 2 - INNER / 2, OY = PX / 2 - INNER / 2;
  const RING = 57, DISC_R = 60 / 0.82;
  const toPx = (x, y) => [OX + x * U, OY + y * U];

  function wavePath(fn) {
    const pts = [];
    for (let x = 16; x <= 104.001; x += 0.5) pts.push(toPx(x, fn(x)));
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }
  const K = 2 * Math.PI / 36;
  const gauss = x => { const u = (x - 60) / 44; return Math.exp(-2.8 * u * u); };
  function strokeWave(fn, width, color, alpha) {
    wavePath(fn);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = width * U; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Ring as 51 separate dashes so each can be lit on its own. Angle 0 is the top, clockwise.
  const DASHES = 51;
  function ring(style) {
    const cx = PX / 2, cy = PX / 2, r = RING * U;
    for (let i = 0; i < DASHES; i++) {
      const a = (i / DASHES) * 2 * Math.PI;
      const s = style(a);                         // { color, alpha, len, glow }
      const half = (s.len * U) / r / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a - Math.PI / 2 - half, a - Math.PI / 2 + half);
      ctx.strokeStyle = s.color; ctx.globalAlpha = s.alpha; ctx.lineWidth = (s.width || 1.6) * U; ctx.lineCap = 'butt';
      if (s.glow) { ctx.shadowColor = C.lamp; ctx.shadowBlur = s.glow * DPR; }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }
  function solidRing(color, alpha) {
    ctx.beginPath(); ctx.arc(PX / 2, PX / 2, RING * U, 0, 2 * Math.PI);
    ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = 1.6 * U;
    ctx.shadowColor = C.lamp; ctx.shadowBlur = 3 * DPR; ctx.stroke(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
  function orb(angle, color, glow = 3) {
    const r = RING * U, a = angle * Math.PI / 180 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(PX / 2 + r * Math.cos(a), PX / 2 + r * Math.sin(a), 3 * U, 0, 2 * Math.PI);
    ctx.fillStyle = color; ctx.shadowColor = C.lamp; ctx.shadowBlur = glow * DPR; ctx.fill(); ctx.shadowBlur = 0;
  }
  const angDist = (a, b) => { const d = Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI); return d; };
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  function halo(strength) {
    disc.style.boxShadow = `var(--raised-flat), 0 0 ${30 + 24 * strength}px rgba(232,163,61,${(0.38 * strength).toFixed(3)})`;
  }

  function drawRipples(s, include) {
    const cx = PX / 2, cy = PX / 2, rDisc = DISC_R * U;
    m.ripples = m.ripples.filter(r => s.t - r.born < r.life);
    for (const r of m.ripples.filter(include)) {
      const p = (s.t - r.born) / r.life;
      const out = r.dir > 0;
      const reach = r.reach || 58;
      const radius = out ? rDisc + 4 + reach * (1 - Math.pow(1 - p, 2)) : rDisc + reach + 4 - reach * (p * p);
      const alpha = out ? r.strength * 0.55 * (1 - p) : r.strength * 0.55 * Math.sin(Math.PI * p);
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.strokeStyle = out ? C.lampHot : C.lamp; ctx.globalAlpha = alpha;
      ctx.lineWidth = r.width ? r.width * (1 - 0.6 * p) : (out ? 3 - 2 * p : 1 + 2 * p);
      ctx.shadowColor = C.lamp; ctx.shadowBlur = 8 * DPR; ctx.stroke(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
  }

  // ---- variants ----
  // Each returns nothing and draws one frame. `s` holds phase and eased levels.
  const baseAmp = s => s.phase === 'thinking' ? 0.4
    : s.phase === 'speaking' ? 0.55 + 0.6 * s.volna
    : 0.4 + 0.5 * s.me;
  const travelFor = s => s.phase === 'speaking' ? 3.2 : 0;

  const variants = {
    // Current mark after the fix: the ring stays glued to the disc, wave eased and without phase jumps.
    now(s) {
      const amp = m.amp;
      if (s.phase === 'speaking') solidRing(C.lampHot, 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(s.t * 2 * Math.PI / 1.6)));
      else ring(() => ({ color: C.lamp, alpha: 1, len: 2, glow: 3 }));
      orb(m.orbit, s.phase === 'listening' ? C.lamp : C.lampHot);
      strokeWave(x => 60 - 26 * amp * gauss(x) * Math.sin(K * (x - 62) + m.phase), 5.5, C.signal, 1);
      halo(s.phase === 'speaking' ? 1 : 0);
    },

    // A. Echo: Volna's voice leaves fading copies behind the running wave;
    // the owner's voice enters from both edges: tails ripple inward, side lamps brighten.
    echo(s) {
      const me = s.me, v = s.volna;
      ring(a => {
        const side = Math.exp(-Math.pow(angDist(a, Math.PI / 2) / 0.55, 2)) + Math.exp(-Math.pow(angDist(a, 3 * Math.PI / 2) / 0.55, 2));
        const lit = Math.min(1, me * 1.3 * side + v * 0.7);
        return { color: lit > 0.2 ? C.lampHot : C.lamp, alpha: 0.55 + 0.45 * Math.min(1, lit + 0.4), len: 2 + 1.6 * lit, glow: 2 + 6 * lit };
      });
      orb(m.orbit, s.phase === 'listening' ? C.lamp : C.lampHot, 3 + 5 * v);
      // Echoes: the same wave a little earlier in phase and amplitude, drawn under the main stroke.
      const hist = m.echoes;
      [[14, 0.30, 3.6], [28, 0.14, 2.4]].forEach(([lag, alpha, w]) => {
        const h = hist[Math.max(0, hist.length - 1 - lag)];
        if (!h || h.v < 0.02) return;
        strokeWave(x => 60 - 26 * h.amp * gauss(x) * Math.sin(K * (x - 62) + h.phase), w, C.signal, alpha * Math.min(1, h.v * 3));
      });
      const amp = m.amp;
      strokeWave(x => {
        const u = (x - 60) / 44;
        const inward = 5.5 * me * u * u * Math.sin(2.2 * K * Math.abs(x - 60) + s.t * 11);
        return 60 - 26 * amp * gauss(x) * Math.sin(K * (x - 62) + m.phase) - inward;
      }, 5.5, C.signal, 1);
      halo(s.phase === 'speaking' ? 0.35 + 0.65 * v : me * 0.35);
    },

    // B. Lamp scale: the dotted ring is a level meter. The owner fills it from the bottom
    // (where the phone's microphone is), Volna from the top (where her lamp orb lives).
    meter(s) {
      const me = s.me, v = s.volna;
      ring(a => {
        const fromBottom = angDist(a, Math.PI) / Math.PI;       // 0 at bottom … 1 at top
        const fromTop = angDist(a, 0) / Math.PI;                 // 0 at top … 1 at bottom
        const litMe = smooth(-0.08, 0.04, me * 0.95 - fromBottom);
        const litV = smooth(-0.08, 0.04, v * 0.95 - fromTop);
        const lit = Math.max(litMe, litV);
        return { color: litV > litMe ? C.lampHot : C.lamp, alpha: 0.38 + 0.62 * lit, len: 2 + 1.8 * lit, width: 1.6 + 0.8 * lit, glow: 7 * lit };
      });
      orb(m.orbit, s.phase === 'listening' ? C.lamp : C.lampHot, 3 + 5 * v);
      const amp = m.amp;
      strokeWave(x => 60 - 26 * amp * gauss(x) * Math.sin(K * (x - 62) + m.phase), 5.5, C.signal, 1);
      halo(s.phase === 'speaking' ? 0.3 + 0.5 * v : 0);
    },

    // C. Ripples: Volna's syllables send soft rings outward, the owner's syllables draw rings in.
    ripples(s) {
      drawRipples(s, r => r.kind !== 'think');
      if (s.phase === 'speaking') solidRing(C.lampHot, 0.6 + 0.4 * s.volna);
      else ring(() => ({ color: C.lamp, alpha: 0.7 + 0.3 * Math.min(1, s.me * 2), len: 2, glow: 3 + 5 * s.me }));
      orb(m.orbit, s.phase === 'listening' ? C.lamp : C.lampHot);
      const amp = m.amp;
      strokeWave(x => 60 - 26 * amp * gauss(x) * Math.sin(K * (x - 62) + m.phase), 5.5, C.signal, 1);
      halo(s.phase === 'speaking' ? 0.5 + 0.5 * s.volna : 0);
    },
  };

  // D. Together: the lamp scale while the owner speaks, slow ripples while Volna thinks,
  // echoes behind the running wave while Volna speaks.
  variants.mix = function (s) {
    const me = s.me, v = s.volna;
    drawRipples(s, r => r.kind === 'think');
    ring(a => {
      const fromBottom = angDist(a, Math.PI) / Math.PI;
      const litMe = smooth(-0.08, 0.04, me * 0.95 - fromBottom);
      const lit = Math.max(litMe, v * 0.7);
      return { color: lit > 0.2 ? (v > me ? C.lampHot : C.lamp) : C.lamp, alpha: s.phase === 'listening' ? 0.38 + 0.62 * lit : 0.55 + 0.45 * Math.min(1, lit + 0.4),
               len: 2 + 1.8 * litMe + 1.6 * v * 0.7, width: 1.6 + 0.8 * litMe, glow: 2 + 6 * lit };
    });
    orb(m.orbit, s.phase === 'listening' ? C.lamp : C.lampHot, 3 + 5 * v);
    [[14, 0.30, 3.6], [28, 0.14, 2.4]].forEach(([lag, alpha, w]) => {
      const h = m.echoes[Math.max(0, m.echoes.length - 1 - lag)];
      if (!h || h.v < 0.02) return;
      strokeWave(x => 60 - 26 * h.amp * gauss(x) * Math.sin(K * (x - 62) + h.phase), w, C.signal, alpha * Math.min(1, h.v * 3));
    });
    const amp = m.amp;
    strokeWave(x => 60 - 26 * amp * gauss(x) * Math.sin(K * (x - 62) + m.phase), 5.5, C.signal, 1);
    halo(s.phase === 'speaking' ? 0.35 + 0.65 * v : 0);
  };

  // ---- loop ----
  let last = null;
  const start = performance.now() - (parseFloat(location.hash.replace('#t=', '')) || 0) * 1000;
  function frame(now) {
    const dt = last == null ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = (now - start) / 1000;
    const T = t % LOOP;
    const sc = script(T);

    // The app gets levels ten times per second; sample-and-hold, then ease.
    const tick = Math.floor(t * 10);
    if (tick !== m.lastSample) { m.lastSample = tick; m.sampled = { me: sc.me, volna: sc.volna }; }
    m.me = follow(m.me, m.sampled.me, dt);
    m.volna = follow(m.volna, m.sampled.volna, dt);
    const s = { t, phase: sc.phase, me: m.me, volna: m.volna };

    m.amp = m.amp == null ? baseAmp(s) : ease(m.amp, baseAmp(s), 10, dt);
    m.phase = (m.phase + travelFor(s) * dt) % (2 * Math.PI);
    m.echoes.push({ amp: m.amp, phase: m.phase, v: m.volna });
    if (m.echoes.length > 40) m.echoes.shift();

    // Orb: orbits while thinking, then glides forward to the top.
    if (s.phase === 'thinking') m.orbit += 360 / 9 * dt;
    else if (m.orbit % 360 !== 0) {
      const target = Math.ceil(m.orbit / 360) * 360;
      m.orbit = ease(m.orbit, target, 3, dt);
      if (target - m.orbit < 0.2) m.orbit = 0;
    }

    // While Volna thinks, a slow calm ripple leaves the disc every 1.1 s.
    if (variant === 'mix' && s.phase === 'thinking' && (m.lastThink == null || t - m.lastThink > 1.1)) {
      m.lastThink = t;
      m.ripples.push({ kind: 'think', born: t, life: 2.4, dir: 1, reach: 36, width: 2, strength: 0.8 });
    }
    if (s.phase !== 'thinking') m.lastThink = null;

    // Ripples spawn on syllable peaks.
    for (const who of ['me', 'volna']) {
      const lv = m[who];
      if (m.peakArmed[who] && lv > 0.28 && lv < m.prev[who]) {
        m.ripples.push({ born: t, life: who === 'volna' ? 1.7 : 1.3, dir: who === 'volna' ? 1 : -1, strength: Math.min(1, lv * 1.4) });
        m.peakArmed[who] = false;
      }
      if (lv < 0.18) m.peakArmed[who] = true;
      m.prev[who] = lv;
    }

    statusEl.innerHTML = icons[s.phase] + words[s.phase];
    statusEl.classList.toggle('hot', s.phase === 'speaking');
    const secs = 41 + Math.floor(t);
    timerEl.textContent = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, PX, PX);
    variants[variant](s);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
