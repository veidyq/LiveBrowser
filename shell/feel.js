// LiveBrowser feel layer: so the browser answers the hand.
//
// Тактильный движок интерфейса — то, что нельзя выразить одним CSS и что не
// должен трогать ни один модуль по отдельности:
//
//   1. Squish: у нажимаемых контролов мгновенное «продавливание»
//      (класс .is-pressed ставится в кадре нажатия) и ПРУЖИННЫЙ возврат
//      на отпускании — двухфазный переход живёт в app.css (сжатие 45мс,
//      откат 320мс с перелётом cubic-bezier(0.34,1.56,0.64,1)).
//   2. LiveFeel.shake(el): микро-шейк ошибки (±2px, 160мс) — неверный URL,
//      упавший перевод, refused-запрос.  Драйвер — CSS-анимация на
//      независимом свойстве `translate`, чтобы не конфликтовать с transform.
//   3. Rubber band: у внутренних скролл-контейнеров (.stage, .page-scroll,
//      .suggests, .tabs, лента «Недавнее») у краёв появляется «резиновая
//      лента» — контент подтягивается за колесом и отпружинивает назад.
//      preventDefault только У КРАЯ: обычный скролл нативный, главного
//      потока это не касается (прошлый урок с перехватом колеса).
//   4. body.new-tab на один такт — сцена делает один «вдох».
//   5. Скролл-фейд у ленты «Что я видел» — край не обрывается ножом.
//
// Тумблеры: «Тактильный отклик» в настройках ставит body.tactile-off —
// гасит 1–3; «Анимации» (body.no-anim) и prefers-reduced-motion гасят всё.
// Стоимость: слушатели passive кроме колеса у контейнеров, один rAF-цикл
// на тянущийся контейнер и только пока он реально тянется.
'use strict';

(function () {

  const body = document.body;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const quiet = () => body.classList.contains('no-anim') || reduced.matches;
  // Тактильные эффекты (нажим/шейк/резинка) отдельно от «обычных» анимаций:
  // тумблер «Тактильный отклик» выключает именно их.
  const tactileOff = () => body.classList.contains('tactile-off');
  const skipTactile = () => tactileOff() || quiet();

  /* ------------------------------------------------------------------ */
  /* 1. Press feedback (squish)                                          */
  /* ------------------------------------------------------------------ */

  // Всё, что «нажимается».  Селектор один на document (capture), поэтому
  // перерисованные шаблоны подхватываются сами.  Барные .tab-btn, оконные
  // .win-ctrl (жмут свою иконку — см. app.css), строки меню/палитры,
  // тумблеры и чипы настроек — все дают один и тот же нажим.
  const PRESSABLE = [
    '.tab', '.tab-btn', '.icon-btn', '.link-tile', '.suggest',
    '.bubble-action', '.bubble-close', '.swap', '.btn', '.menu-item',
    '.palette-item', '.win-ctrl', '.sm-tab', '.sm-row', '.sm-swatch',
    '.swatch', '.settings-btn', '.dl-act', '.rc-row', '.rc-toggle',
    '.rc-clear', '.pal-row', '.lb-menu-item', '.page-nav-chip',
    '.tab-close', '.addr-copy', '.switch-row',
  ].join(', ');

  let pressed = null;
  let pressTimer = 0;

  const clearPress = () => {
    if (pressed) pressed.classList.remove('is-pressed');
    pressed = null;
    clearTimeout(pressTimer);
  };

  // Capture-фаза обязательно: кнопки бара глушат pointerdown
  // (app.js initTitlebar ставит stopPropagation, чтобы бар не начинал
  // перетаскивание окна), и bubble-слушатель на document их не увидел бы.
  document.addEventListener('pointerdown', (e) => {
    if (skipTactile()) return;
    if (e.button !== 0) return;
    const el = e.target.closest(PRESSABLE);
    if (!el || el.disabled || el.closest('[disabled]')) return;
    // Предыдущий нажим может не успеть сняться (быстрый перенос мыши без
    // pointerup) — снимаем прежде, чем жать новый.
    if (pressed && pressed !== el) pressed.classList.remove('is-pressed');
    pressed = el;
    el.classList.add('is-pressed');
    // Долгое удержание не должно оставлять элемент «вжатым».
    clearTimeout(pressTimer);
    pressTimer = setTimeout(clearPress, 1200);
  }, { capture: true, passive: true });

  document.addEventListener('pointerup', clearPress, { passive: true });
  document.addEventListener('pointercancel', clearPress, { passive: true });

  /* ------------------------------------------------------------------ */
  /* 2. Micro-shake (ошибки)                                             */
  /* ------------------------------------------------------------------ */

  // Один класс .lb-shake, анимация lb-shake в app.css (translate ±2px, 160мс).
  // Перезапуск — через снятие класса и reflow.  Вызов: LiveFeel.shake(el).
  function shake(el) {
    if (!el || skipTactile()) return;
    el.classList.remove('lb-shake');
    void el.offsetWidth; // рестарт анимации даже на повторной ошибке
    el.classList.add('lb-shake');
    const done = () => el.classList.remove('lb-shake');
    el.addEventListener('animationend', done, { once: true });
    setTimeout(done, 220); // страховка под no-anim
  }
  window.LiveFeel = { shake };

  /* ------------------------------------------------------------------ */
  /* 3. Rubber band на скролл-контейнерах                                */
  /* ------------------------------------------------------------------ */

  // Контейнер тянется на translateY/translateX (независимое свойство
  // translate — transform у .stage и прочих занят параллаксом/вдохом).
  // Отпускание: цель 0, экспоненциальное схождение через rAF; цикл живёт
  // только пока pull не пришёл к нулю.
  function rubber(el) {
    if (!el || el.__lbRubber) return;
    el.__lbRubber = true;

    const MAX = 26;          // максимальная вытяжка, px
    const FOLLOW = 0.28;     // доля подтягивания за тик колеса
    const K = 16;            // скорость возврата (1/с)
    let pullX = 0, pullY = 0;
    let tgtX = 0, tgtY = 0;
    let raf = 0, lastWheel = 0, lastT = 0;

    const apply = () => {
      const x = pullX.toFixed(2), y = pullY.toFixed(2);
      if (x === '0.00' && y === '0.00') el.style.translate = '';
      else el.style.translate = `${x}px ${y}px`;
    };

    const step = (ts) => {
      raf = 0;
      const dt = lastT ? Math.min(0.05, (ts - lastT) / 1000) : 1 / 60;
      lastT = ts;
      // Колесо замолчало (или ушло от края) — резинка отпускается.
      if (performance.now() - lastWheel > 160) { tgtX = 0; tgtY = 0; }
      const a = 1 - Math.exp(-K * dt);
      pullX += (tgtX - pullX) * a;
      pullY += (tgtY - pullY) * a;
      apply();
      if (Math.abs(pullX) < 0.2 && Math.abs(pullY) < 0.2
        && Math.abs(tgtX) < 0.2 && Math.abs(tgtY) < 0.2) {
        pullX = pullY = tgtX = tgtY = 0;
        apply();
        lastT = 0;
        return; // цикл паркуется — в покое ноль работы
      }
      raf = requestAnimationFrame(step);
    };

    const wake = () => { if (!raf) { lastT = 0; raf = requestAnimationFrame(step); } };

    el.addEventListener('wheel', (e) => {
      if (skipTactile()) return;
      const dx = e.deltaX, dy = e.deltaY;
      if (!dx && !dy) return;
      const maxX = el.scrollWidth - el.clientWidth;
      const maxY = el.scrollHeight - el.clientHeight;
      let ex = 0, ey = 0;
      // У края И тянем за него — preventDefault и тянем; в середине контента
      // ничего не перехватываем: скролл остаётся нативным.  Ось без
      // overflow (горизонтальная лента вкладок по вертикали) резинкой не
      // считается — событие уходит предкам, как и раньше.
      if (maxX > 0) {
        if (dx < 0 && el.scrollLeft <= 0) ex = dx;
        else if (dx > 0 && el.scrollLeft >= maxX - 1) ex = dx;
      }
      if (maxY > 0) {
        if (dy < 0 && el.scrollTop <= 0) ey = dy;
        else if (dy > 0 && el.scrollTop >= maxY - 1) ey = dy;
      }
      if (!ex && !ey) {
        if (tgtX || tgtY) { lastWheel = performance.now() - 200; wake(); }
        return;
      }
      e.preventDefault();
      lastWheel = performance.now();
      tgtX = Math.max(-MAX, Math.min(MAX, tgtX + ex * FOLLOW));
      tgtY = Math.max(-MAX, Math.min(MAX, tgtY + ey * FOLLOW));
      wake();
    }, { passive: false });

    // Курсор ушёл — резинка отпружинила.
    el.addEventListener('pointerleave', () => {
      if (tgtX || tgtY || pullX || pullY) { lastWheel = 0; wake(); }
    }, { passive: true });
  }

  // Внутренние скролл-области шелла.  Страницы настроек/загрузок появляются
  // в DOM сразу (hidden), так что хватает одного прохода; панель подсказок
  // и лента «Недавнее» дорисовываются позже — повторяем проход пару раз.
  function bindRubber() {
    if (skipTactile()) return;
    document.querySelectorAll(
      '.stage, .page-scroll, .suggests, .tabs, #recent-row, .rc-row, .rc-body, .page-nav',
    ).forEach(rubber);
  }

  /* ------------------------------------------------------------------ */
  /* 4. One breath for a new tab                                         */
  /* ------------------------------------------------------------------ */

  // body.new-tab живёт ровно один цикл stage-breathe (.42s) — сцена
  // «вдыхает», когда появляется новая карточка.  Ставим класс по входящему
  // push'у вкладок от хоста: старая вкладка означает, что ничего не
  // появилось, и трогать сцену не нужно.
  let lastCount = -1;

  function breathe() {
    if (quiet()) return;
    body.classList.add('new-tab');
    setTimeout(() => body.classList.remove('new-tab'), 460);
  }

  function onTabs(count) {
    if (lastCount >= 0 && count > lastCount) breathe();
    lastCount = count;
  }

  // Хост шлёт свои сообщения через chrome.webview 'message'; app.js держит
  // свой обработчик и не отдаёт детали, поэтому здесь — второй независимый
  // слушатель, который читает только количество вкладок.
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (e) => {
      let d = e.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { return; }
      }
      if (!d || d.type !== 'tabs' || !Array.isArray(d.tabs)) return;
      onTabs(d.tabs.length);
    });
  } else if (window.__lbTabs) {
    // Без хоста (страница открыта в обычном браузере для QA): берём
    // зеркало вкладок, если оно есть.
    window.__lbTabs.addEventListener?.('change', () => onTabs(window.__lbTabs.length || 0));
  }

  /* ------------------------------------------------------------------ */
  /* 5. Scroll fade on the "seen" strip and edge glow                    */
  /* ------------------------------------------------------------------ */

  // Лента истории под плитками: у краёв, где есть ещё карточки, появляется
  // мягкая тень — «продолжение следует», без стрелок и скроллбара.
  function bindFade(el) {
    if (!el || el.__lbFade) return;
    el.__lbFade = true;
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.classList.toggle('fade-l', max > 0 && el.scrollLeft > 4);
      el.classList.toggle('fade-r', max > 0 && el.scrollLeft < max - 4);
    };
    el.addEventListener('scroll', sync, { passive: true });
    // Контент доливается асинхронно (/api/history), поэтому за краем следит
    // ResizeObserver, а не один вызов при инициализации.
    if (window.ResizeObserver) new ResizeObserver(sync).observe(el);
    sync();
  }

  const watchStrips = () => {
    // Без .links: стрип плиток переносится строками и не скроллится —
    // fade-маска там не нужна и клиппила hover-подъём плиток.
    document.querySelectorAll('#recent-bar, .recent-strip').forEach(bindFade);
    bindRubber();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchStrips);
  else watchStrips();
  // Модули истории/плиток дорисовывают узлы позже.
  setTimeout(watchStrips, 400);
  setTimeout(watchStrips, 1500);
})();
