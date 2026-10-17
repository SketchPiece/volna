// Boards of the home-list scroll question. Each board is a live phone: scroll it with the wheel or a finger.
// `at` sets where the board rests (0 = top); the phone keeps scrolling from there.
window.Home = (() => {
  const TALKS = [
    ['Сегодня', '9:12 · 3 мин', 'Что купить к ужину на шестерых'],
    ['Сегодня', '8:30 · 1 мин', 'Будильник на 7:15 завтра'],
    ['Вчера', '21:40 · 4 мин', 'Что такое резонанс, по-простому'],
    ['Вчера', '18:05 · 2 мин', 'Перенести встречу с Олегом на пятницу'],
    ['Вчера', '12:20 · 7 мин', 'Сравнить два тарифа на интернет'],
    ['Пн', '22:30 · 11 мин', 'План переезда: что везти первым'],
    ['Пн', '8:47 · 1 мин', 'Погода в Тбилиси на выходные'],
    ['Вс', '19:15 · 6 мин', 'Идеи подарка маме'],
    ['Вс', '11:02 · 3 мин', 'Рецепт хачапури по-аджарски'],
    ['Сб', '16:44 · 9 мин', 'Починить тесты в колл ассистенте'],
    ['Сб', '10:10 · 2 мин', 'Сколько идти до вокзала пешком'],
    ['Пт', '23:05 · 5 мин', 'Почему небо синее'],
    ['Пт', '14:31 · 4 мин', 'Напомнить позвонить врачу'],
    ['Чт', '20:00 · 8 мин', 'Разбор расходов за сентябрь'],
  ];
  const DAYS = { 'Сегодня': 'СЕГОДНЯ', 'Вчера': 'ВЧЕРА', 'Пн': 'ЭТА НЕДЕЛЯ', 'Вс': 'ЭТА НЕДЕЛЯ', 'Сб': 'ЭТА НЕДЕЛЯ', 'Пт': 'ПРОШЛАЯ НЕДЕЛЯ', 'Чт': 'ПРОШЛАЯ НЕДЕЛЯ' };
  const row = ([d, k, t], day = true) => `<div class="item"><div class="body"><div class="k">${day ? `${d}, ` : ''}${k}</div><div class="t">${t}</div></div></div>`;
  const list = rows => `<div class="card list plain">${rows.map(r => row(r)).join('')}</div>`;
  const chrome = '<div class="island"></div><div class="sb"><span>9:41</span><span>●●● ▮</span></div><div class="home"></div>';
  const top = `<div class="topbar">${Volna.brand}ВОЛНА-1${Volna.settings}</div>
    <div class="title" style="margin-bottom:6px">Говорит Волна.</div><p class="status-line">Лампы прогреты.</p>`;
  const cta = `<div class="cta">${Volna.phoneIcon}<span class="lbl">Позвонить Волне</span></div>`;

  function days() {
    let html = '', current = null, rows = [];
    const flush = () => { if (rows.length) html += `<div class="day">${current}</div><div class="card list plain">${rows.join('')}</div>`; rows = []; };
    for (const r of TALKS) {
      if (DAYS[r[0]] !== current) { flush(); current = DAYS[r[0]]; }
      rows.push(row(r, current !== 'СЕГОДНЯ' && current !== 'ВЧЕРА'));
    }
    flush();
    return `<div class="days">${html}</div>`;
  }

  function mount(html, cls) {
    document.body.innerHTML = `<div class="phone-wrap"><div class="phone ${cls}">${html}${chrome}</div></div>`;
    return document.querySelector('.phone');
  }

  // A thin indicator that shows up only while the finger moves, like iOS.
  function indicator(phone, scroller) {
    const bar = document.createElement('div');
    bar.className = 'scrollhint';
    bar.style.opacity = 0;
    phone.appendChild(bar);
    let timer;
    const place = show => {
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      const h = Math.max(36, clientHeight * clientHeight / scrollHeight);
      const offset = scroller === phone.querySelector('.scroller') ? 0 : scroller.getBoundingClientRect().top - phone.getBoundingClientRect().top;
      bar.style.height = `${h}px`;
      bar.style.top = `${offset + 4 + (clientHeight - h - 8) * scrollTop / Math.max(1, scrollHeight - clientHeight)}px`;
      if (show) { bar.style.opacity = 1; bar.style.transition = 'opacity .1s'; clearTimeout(timer); timer = setTimeout(() => { bar.style.transition = 'opacity .6s'; bar.style.opacity = 0; }, 700); }
    };
    scroller.addEventListener('scroll', () => place(true));
    return place;
  }

  // Page scroll variants: the whole screen scrolls, the call key stays docked at the bottom.
  function page({ variant, at = 0, body = list(TALKS), fold = 120 }) {
    const phone = mount(`
      ${variant === 'b' ? `<div class="minibar">${Volna.brand}ВОЛНА-1<span class="sub">РАЗГОВОРЫ</span>${Volna.settings}</div>` : ''}
      <div class="topfade"></div>
      <div class="scroller">${top}<div class="stage top">${variant === 'd' ? '' : '<div class="eyebrow">РАЗГОВОРЫ</div>'}${body}</div><div class="tail"></div></div>
      <div class="botfade"></div><div class="dock">${cta}</div>`, `v-${variant}`);
    const scroller = phone.querySelector('.scroller');
    const place = indicator(phone, scroller);
    const update = () => phone.classList.toggle('scrolled', scroller.scrollTop > fold);
    scroller.addEventListener('scroll', update);
    requestAnimationFrame(() => { scroller.scrollTop = at; update(); place(false); if (at) showStill(phone, place); });
  }

  // Current app: the card takes the free height and the rows scroll inside it.
  function now({ at = 0 }) {
    const phone = mount(`<div class="fixed">${top}<div class="stage top" style="display:flex;flex-direction:column">
      <div class="eyebrow">РАЗГОВОРЫ</div><div class="card list plain"><div class="inner">${TALKS.map(r => row(r)).join('')}</div></div></div>
      <div class="cta" style="margin-top:24px">${Volna.phoneIcon}<span class="lbl">Позвонить Волне</span></div></div>`, 'v-now');
    const inner = phone.querySelector('.inner');
    const place = indicator(phone, inner);
    requestAnimationFrame(() => { inner.scrollTop = at; place(false); if (at) showStill(phone, place); });
  }

  // A scrolled board shows its indicator, as it looks mid-gesture.
  function showStill(phone, place) {
    place(false);
    const bar = phone.querySelector('.scrollhint');
    bar.style.opacity = 1;
  }

  return { page, now, days };
})();
