// Arrow variants for the empty home screen. shape: 'wave' (calming sine, as in the app) or 'logo' (the mark's wave turned down).
window.arrowSVG = ({ color = '#B8321F', width = 3.6, w = 32, h = 84, shape = 'wave', glow = true }) => {
  const mid = w / 2, tip = h - 2, len = tip - 8;
  let d = `M${mid} 0`;
  for (let i = 1; i <= 60; i++) {
    const t = i / 60;
    const x = shape === 'logo'
      ? mid + 8 * Math.exp(-2.8 * Math.pow((t - 0.45) / 0.45, 2)) * Math.sin(2 * Math.PI * (t * 2.2 - 0.05))
      : mid + 7 * (1 - t) * Math.sin(t * Math.PI * 5);
    d += ` L${x.toFixed(2)} ${(t * len).toFixed(2)}`;
  }
  const head = 9 + width;
  d += ` L${mid} ${tip} M${mid - head * 0.9} ${tip - head} L${mid} ${tip} L${mid + head * 0.9} ${tip - head}`;
  const shadow = glow ? `filter:drop-shadow(0 1px 3px rgba(142,36,21,.35))` : '';
  return `<svg class="wavy" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible;${shadow}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
};
