// Shared pieces of the home-screen boards: phone chrome and the WaveMark drawn as SVG
// (same 120-unit box as WaveMark.swift: disc, dotted ring of 51 lamps at r 57, red wave).
window.Volna = (() => {
  const C = { signal: '#B8321F', lamp: '#E8A33D', lampHot: '#F2B550', lampOff: '#CFC6B6' };
  const K = 2 * Math.PI / 36;
  const gauss = x => { const u = (x - 60) / 44; return Math.exp(-2.8 * u * u); };

  function wavePath(amp, phase = 0) {
    let d = '';
    for (let x = 16; x <= 104.001; x += 1) {
      const y = 60 - 26 * amp * gauss(x) * Math.sin(K * (x - 62) + phase);
      d += (d ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(2);
    }
    return d;
  }
  // Mark contents in a 120×120 viewBox, disc excluded (the disc is a CSS circle with a shadow).
  function markInner({ amp = 0.4, lit = () => 0 } = {}) {
    let ring = '';
    for (let i = 0; i < 51; i++) {
      const a = i / 51 * 2 * Math.PI, half = 1 / 57;
      const a0 = a - half - Math.PI / 2, a1 = a + half - Math.PI / 2;
      const p = (ang) => [(60 + 57 * Math.cos(ang)).toFixed(2), (60 + 57 * Math.sin(ang)).toFixed(2)];
      const [x0, y0] = p(a0), [x1, y1] = p(a1);
      ring += `<path class="dash" data-i="${i}" d="M${x0} ${y0} A57 57 0 0 1 ${x1} ${y1}" stroke="${lit(i) ? C.lamp : C.lampOff}" stroke-width="1.6" fill="none"/>`;
    }
    return `${ring}<path class="wave" d="${wavePath(amp)}" fill="none" stroke="${C.signal}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  // A full mark: raised disc plus SVG; the inner box is 82 % of the disc like the app.
  function mark(size, opts) {
    const inner = size * 0.82, off = (size - inner) / 2;
    return `<div class="markbox" style="width:${size}px;height:${size}px"><div class="disc"></div>
      <svg viewBox="0 0 120 120" style="position:absolute;left:${off}px;top:${off}px;width:${inner}px;height:${inner}px;overflow:visible">${markInner(opts)}</svg></div>`;
  }

  const brand = '<svg width="26" height="26" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="58" fill="#B8321F"/><path d="M16 60 Q23 54 30 60 Q38 70 46 60 Q55 34 64 60 Q73 86 82 60 Q90 50 98 60 Q101 63 104 60" fill="none" stroke="#E7E0D2" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const settings = '<span class="iconbtn"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></span>';
  const phoneIcon = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg>';

  // Phone frame with the idle top: brand, settings, title, one status line. `stage` fills the middle.
  function idle({ stage, stageClass = '', title = 'Говорит Волна.', status = 'Лампы прогреты.', cta = 'Позвонить Волне' }) {
    document.body.innerHTML = `
    <div class="phone-wrap"><div class="phone">
      <div class="island"></div><div class="sb"><span>9:41</span><span>●●● ▮</span></div>
      <div class="topbar">${brand}ВОЛНА-1${settings}</div>
      <div class="title" style="margin-bottom:6px">${title}</div>
      <p class="status-line">${status}</p>
      <div class="stage ${stageClass}">${stage}</div>
      <div class="cta">${phoneIcon}${cta}</div>
      <div class="home"></div>
    </div></div>`;
  }
  return { C, wavePath, markInner, mark, brand, settings, phoneIcon, idle };
})();
