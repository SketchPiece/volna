// The empty home screen as the app draws it (HomeList.swift → EmptyHome), with layout knobs for the boards.
window.mastSVG = size => {
  const arc = (r, side) => {
    const a0 = (side - 45) * Math.PI / 180, a1 = (side + 45) * Math.PI / 180;
    const x0 = 32 + r * Math.cos(a0), y0 = 26 + r * Math.sin(a0), x1 = 32 + r * Math.cos(a1), y1 = 26 + r * Math.sin(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 57 L32 31 L42 57" stroke="#26211D" stroke-width="2.6"/>
    <path d="M27 44 H37 M27 44 L42 57 M37 44 L22 57" stroke="#26211D" stroke-width="1.8"/>
    <path class="w1" d="${arc(10, 180)} ${arc(10, 0)}" stroke="#E8A33D" stroke-width="2.4"/>
    <path class="w2" d="${arc(17, 180)} ${arc(17, 0)}" stroke="#E8A33D" stroke-width="2.4"/>
    <circle cx="32" cy="26" r="4.2" fill="#E8A33D" style="filter:drop-shadow(0 0 4px rgba(232,163,61,.9))"/>
  </svg>`;
};
// o: badge, icon, title (px), gapTitle, arrowH, top (flex before block), mid (flex between text and arrow), bottom (px under arrow)
window.emptyHome = o => {
  const arrow = arrowSVG({ width: 5.5, w: 36, h: o.arrowH || 84 });
  Volna.idle({ stage: `<div style="flex:1;display:flex;flex-direction:column;align-items:center;text-align:center;height:100%">
    <div style="flex:${o.top}"></div>
    <div class="badge" style="width:${o.badge}px;height:${o.badge}px">${mastSVG(o.icon)}</div>
    <h2 style="margin:${o.gapTitle || 28}px 0 10px;font:600 ${o.title || 22}px/1.25 var(--font-display);letter-spacing:-.01em">Первый выход в эфир</h2>
    <p style="font:15px/1.5 var(--font-body);color:var(--ink-2);margin:0">Позвони и спроси что угодно.</p>
    <div style="flex:${o.mid};min-height:16px"></div>
    ${arrow}
    <div style="height:${o.bottom}px;flex-shrink:0"></div>
  </div>` });
};
