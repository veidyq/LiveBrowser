/* Living wallpaper — the desktop answers the mouse, and only the mouse.

   Feature 17: курсор — единственный источник движения фона.  В покое блобы
   СТОЯТ (app.css держит их keyframes на play-state: paused), поэтому
   композитор не тикает ни одного кадра и blur под стеклом не пересчитывается
   — это и есть снятый CPU покоя из аудита C4.  Как только курсор реально
   движется, класс body.wall-live будит дрейф; когда он замирает (или уходит
   из окна), класс снимается и сцена снова парковывается.

   Поверх дрейфа — два compositor-only слоя:
   - .wall-glow: мягкое акцентное свечение, идущее за точкой с коротким
     запаздыванием и лёгким «дыханием» (scale), пока окно активно;
   - клик подталкивает свечение (pulse) и оставляет короткое кольцо.

   Дисциплина стоимости: не больше одного rAF, только transform/opacity,
   ни одного чтения layout, полный парк (transform очищен, glow погашен)
   когда курсор ушёл; молчит под no-anim, prefers-reduced-motion, свёрнутым
   окном (body.occ), на странице сайта и в упрощённом режиме без GPU. */
(() => {
  const aurora = document.querySelector('.aurora');
  const glow = document.getElementById('wall-glow');
  if (!aurora || !glow) return;

  const AMP_X = 12, AMP_Y = 9;     // wallpaper parallax, px
  const EASE = 0.38;               // approach per frame
                                   // было 0.16 (~100 мс хвост): свечение
                                   // «отставало» от курсора — та самая
                                   // «подлагивающая белая штука».  0.38
                                   // держит мягкость, но следует почти
                                   // мгновенно (хвост ~40 мс).
  const PULSE_DECAY = 0.05;        // click push, per frame
  const GLOW_OPACITY = 0.5;
  // Дрейф блобов просыпается, пока курсор двигался за это время; после
  // паузы он замирает снова (анимация снимается с паузы в том же кадре,
  // в котором жила, поэтому «прыжка» нет).
  const DRIFT_HOLD_MS = 1400;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const body = document.body;

  // Курсор за пределами окна внутренности не видит: событий pointermove
  // нет, и курсор «замерзает» там, где его оставили.  Один таймер на весь
  // монитор возвращает точку в центральную полосу, чтобы после ухода мыши
  // сцена плавно отпустила параллакс и остановила дрейф.
  const EXIT = { x: 0.52, y: 0.46 };
  let pollTimer = 0;

  let tx = 0.5, ty = 0.45;         // target, fractions of the window
  let cx = 0.5, cy = 0.45;         // eased position
  let inside = false, pulse = 0, breath = 0, raf = 0;
  let driftAwake = false;
  let width = innerWidth, height = innerHeight;

  const asleep = () =>
    body.classList.contains('no-anim') ||
    body.classList.contains('occ') ||
    body.classList.contains('site-active') ||
    document.documentElement.classList.contains('no-gpu') ||
    document.hidden ||
    reduced.matches;

  function setDrift(on) {
    if (driftAwake === on) return;
    driftAwake = on;
    body.classList.toggle('wall-live', on);
  }

  function park() {
    aurora.style.transform = '';
    glow.style.opacity = '0';
    setDrift(false);
    tx = cx = 0.5;
    ty = cy = 0.45;
    pulse = 0;
    breath = 0;
  }

  // Пока курсор движется — дрейф идёт, свечение дышит; после паузы обе
  // вещи засыпают, но параллакс плавно возвращается к покою.
  function frame(now) {
    raf = 0;
    if (asleep()) { park(); return; }
    cx += (tx - cx) * EASE;
    cy += (ty - cy) * EASE;
    const dx = (cx - 0.5) * 2, dy = (cy - 0.5) * 2;
    aurora.style.transform =
      `translate3d(${(dx * AMP_X).toFixed(2)}px, ${(dy * AMP_Y).toFixed(2)}px, 0)`;

    breath = inside ? Math.min(1, breath + 0.03) : Math.max(0, breath - 0.05);
    const breathe = 1 + Math.sin(now / 900) * 0.035 * breath;
    glow.style.transform =
      `translate3d(${(cx * width).toFixed(1)}px, ${(cy * height).toFixed(1)}px, 0)` +
      ` scale(${((1 + pulse) * breathe).toFixed(3)})`;
    glow.style.opacity = String(GLOW_OPACITY * (0.75 + 0.25 * breath));

    if (pulse > 0) pulse = Math.max(0, pulse - PULSE_DECAY);

    const settled = Math.abs(tx - cx) < 0.0015 && Math.abs(ty - cy) < 0.0015;
    if (!inside && settled && pulse === 0) { park(); return; }
    raf = requestAnimationFrame(frame);
  }

  const kick = () => { if (!raf && !asleep()) raf = requestAnimationFrame(frame); };

  let driftTimer = 0;
  // Отложенный старт (турбо): первый кадр важнее фона.  Подписки на
  // pointermove/pointerdown ставятся в idle (fallback — таймер): пока их
  // нет, ввод даже не вызывает лишних чтений, а картинка в покое —
  // блобы стоят на паузе, glow прозрачен.  Поведение после arm — прежнее.
  let armed = false;
  const arm = () => {
    if (armed) return;
    armed = true;

    addEventListener('pointermove', (e) => {
      width = innerWidth; height = innerHeight;
      tx = Math.min(1, Math.max(0, e.clientX / width));
      ty = Math.min(1, Math.max(0, e.clientY / height));
      if (!inside) {
        // Land the halo under the pointer instead of flying it across the desk.
        cx = tx; cy = ty;
      }
      inside = true;
      lastMoveAt = Date.now();
      glow.style.opacity = String(GLOW_OPACITY);
      if (!asleep()) setDrift(true);
      clearTimeout(driftTimer);
      driftTimer = setTimeout(() => setDrift(false), DRIFT_HOLD_MS);
      kick();
    }, { passive: true });

    addEventListener('pointerdown', () => {
      if (asleep()) return;
      pulse = 0.16;
      kick();
    }, { passive: true });
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(arm, { timeout: 600 });
  else setTimeout(arm, 60);

  // Leaving the window: the desk eases back to its resting centre and fades
  // the glow, then frame() parks both layers (and the drift).
  const leave = () => { inside = false; tx = 0.5; ty = 0.45; setDrift(false); kick(); };
  document.addEventListener('pointerleave', leave);
  window.addEventListener('blur', leave);

  // A minimised window parks the loop mid-gesture; re-arm it on the way back
  // so the glow does not stay dark until the pointer happens to move.
  addEventListener('visibilitychange', () => {
    if (!document.hidden && inside && !asleep()) {
      glow.style.opacity = String(GLOW_OPACITY);
      kick();
    } else if (document.hidden) {
      setDrift(false);
    }
  }, { passive: true });

  addEventListener('resize', () => { width = innerWidth; height = innerHeight; }, { passive: true });

  // 8 Гц — дешевле, чем один rAF: узнаём, что курсор ушёл из окна, и
  // переводим цель в EXIT (то же, что делает leave(), но для мыши, которая
  // просто уехала за край окна и не вернулась).
  //
  // Пруф «ушёл» — только отсутствие pointermove дольше DRIFT_HOLD_MS:
  // leave()/blur уже паркуют сцену сразу, а вот повторный pointermove
  // приезжает на доли секунды позже, чем мы успели бы «покинуть» окно по
  // таймеру.  Так что таймер не трогает состояние, пока движение свежее:
  // иначе дрейф гас бы через 125 мс вместо 1400 и сцена дёргалась.
  let lastMoveAt = 0;
  if (window.chrome && window.chrome.webview) {
    pollTimer = setInterval(() => {
      if (document.hidden || !inside) return;
      if (Date.now() - lastMoveAt < DRIFT_HOLD_MS) return;
      tx = EXIT.x; ty = EXIT.y; inside = false; setDrift(false);
    }, 125);
  }

  // Тумблер «Анимации» в настройках: гасим сцену сразу, не дожидаясь кадра.
  new MutationObserver(() => { if (asleep()) park(); })
    .observe(body, { attributes: true, attributeFilter: ['class'] });
  if (reduced.addEventListener) reduced.addEventListener('change', () => { if (asleep()) park(); });
})();
