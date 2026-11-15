// LiveBrowser scroll layer: масляный скролл внутренних областей шелла.
//
// Lenis (shell/vendor/lenis.min.js, локальная UMD-сборка) сглаживает колесо
// по экспоненциальному лерпу (lerp 0.1, frame-rate independent) — списки
// настроек, подсказки, палитра и поповер «Недавнее» едут как на дорогом
// трекпаде.  Принципы, унаследованные от feel.js (НЕ ломать):
//
//   1. rAF-цикл паркуются в покое: драйвер живёт, только пока хоть один
//      инстанс Lenis isRunning; пробуждение — по wheel/scroll/resize/мутации.
//   2. Сайты НЕ трогаем: их скролл остаётся нативному композитору Chromium
//      (JS-перехват колеса на сайтах уже пробовали — фризы, откат в
//      MainForm.cs).  Инъекция на сайты — только CSS (SiteBootScript).
//   3. Тумблеры: body.no-anim и prefers-reduced-motion выключают сглаживание
//      целиком (инстансы уничтожаются, скролл мгновенный нативный).
//      «Тактильный отклик» (body.tactile-off) скролл НЕ гасит — это не
//      нажим/резинка, а базовая плавность.
//   4. Резинка feel.js продолжает работать у краёв: её wheel-слушатель
//      зарегистрирован раньше и тянет контент за краем, Lenis в этот момент
//      зажат лимитом — каналы не спорят.
//
// QA: window.__lbScroll() — { count, running, els } без открытия настроек.
'use strict';

(function () {

  const hasLenis = typeof window.Lenis === 'function';
  const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // Живое переключение reduce-motion в ОС: разворачиваем/возвращаем Lenis
  // без ожидания следующей DOM-мутации (иначе тумблер «не работает» до
  // первого клика).
  if (reduced && typeof reduced.addEventListener === 'function') {
    reduced.addEventListener('change', () => scheduleScan());
  }

  // Те же ворота, что у «обычных» анимаций шелла: no-anim + reduce-motion.
  const quiet = () => document.body.classList.contains('no-anim')
    || !!(reduced && reduced.matches);

  const SELECTOR = [
    '.stage',        // десктоп (короткое окно)
    '.suggests',     // панель подсказок омнибокса
    '.page-scroll',  // настройки / загрузки / история
    '.palette-list', // палитра Ctrl+K
    '.rp-list',      // поповер «Недавно закрытые»
    '.td-body',      // диалог перевода
  ].join(', ');

  const instances = new Map(); // el -> Lenis
  let raf = 0;
  let lastT = 0;

  function wake() {
    if (!instances.size || raf) return;
    lastT = 0;
    raf = requestAnimationFrame(step);
  }

  function step(t) {
    raf = 0;
    let running = false;
    for (const lenis of instances.values()) {
      lenis.raf(t);
      if (lenis.isRunning) running = true;
    }
    if (running) raf = requestAnimationFrame(step);
    else lastT = 0; // все осели — цикл паркуется, в покое ноль работы
  }

  function bind(el) {
    if (!hasLenis || !el || instances.has(el) || quiet()) return;
    // Скрытый контейнер (display:none) даёт нулевые размеры — Lenis сам
    // пересчитает через ResizeObserver при показе, но не стоит заводить
    // инстанс для никогда не показываемых узлов.
    if (!el.isConnected) return;
    try {
      const lenis = new window.Lenis({
        wrapper: el,
        content: el,           // измеряем сам контейнер (scrollHeight)
        lerp: 0.1,             // экспоненциальное сглаживание, как у hero-лерпа
        wheelMultiplier: 1,
        overscroll: true,      // у края событие уходит feel.js-резинке
        syncTouch: false,      // тач в десктопном шелле не сглаживаем
        autoRaf: false,        // единый драйвер ниже
        anchors: false,
        autoResize: true,
      });
      instances.set(el, lenis);
      // Нативный скролл (scrollIntoView из настроек/истории) будит драйвер:
      // Lenis синхронизируется в onNativeScroll, финализации нужен кадр.
      el.addEventListener('scroll', wake, { passive: true });
    } catch {
      /* Lenis отказался от контейнера — он остаётся нативным */
    }
  }

  function unbind(el) {
    const lenis = instances.get(el);
    if (!lenis) return;
    instances.delete(el);
    try { lenis.destroy(); } catch { /* уже мёртв */ }
  }

  function scan() {
    if (!hasLenis) return;
    if (quiet()) {
      if (instances.size) {
        for (const el of [...instances.keys()]) unbind(el);
      }
      return;
    }
    document.querySelectorAll(SELECTOR).forEach(bind);
  }

  // Дерево живое: панели дорисовываются позже, страницы открываются/закрываются.
  // Дебаунс в rAF: пакет мутаций = один проход.
  let scanPending = false;
  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    requestAnimationFrame(() => {
      scanPending = false;
      scan();
      wake();
    });
  }

  if (window.MutationObserver) {
    // Два УЗКИХ наблюдателя вместо одного всеядного: полный subtree с
    // attributes будил скан на каждом class-toggle в документе (is-pressed
    // на каждый клик, классы glider) — постоянный мусор.  Смена классов
    // важна только на самом body (no-anim), появление/уход узлов — childList.
    new MutationObserver(scheduleScan).observe(document.body, {
      childList: true,
      subtree: true,
    });
    new MutationObserver(scheduleScan).observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  // Wheel будит драйвер (capture, passive: ничего не перехватываем —
  // preventDefault делает сам Lenis на своём слушателе).
  document.addEventListener('wheel', wake, { capture: true, passive: true });
  window.addEventListener('resize', wake, { passive: true });

  // Публичный API: плавный скролл области из чужих модулей (настройки —
  // навигация по секциям, история — к дате).  Fallback — нативный smooth.
  window.LiveScroll = {
    bind,
    refresh(el) {
      const lenis = instances.get(el);
      if (!lenis) return;
      try { lenis.resize(); } catch { /* размеры придут сами */ }
      wake();
    },
    scrollTo(el, target, opts) {
      const lenis = instances.get(el);
      if (!lenis || quiet()) {
        const behavior = opts && opts.instant ? 'auto' : 'smooth';
        try { el.scrollTo({ top: target, left: 0, behavior }); } catch { el.scrollTop = target; }
        return;
      }
      wake();
      try {
        lenis.scrollTo(target, {
          duration: opts && opts.duration != null ? opts.duration : 0.55,
          easing: (t) => 1 - Math.pow(1 - t, 3), // мягкий выкат без ступеней
          immediate: !!(opts && opts.instant),
          lock: false,
        });
      } catch {
        try { el.scrollTo({ top: target, behavior: 'smooth' }); } catch { el.scrollTop = target; }
      }
    },
  };

  // QA-хук: живая проверка из консоли/CDP без открытия настроек.
  window.__lbScroll = () => ({
    engine: hasLenis ? 'lenis' : 'native',
    count: instances.size,
    running: [...instances.values()].filter((l) => l.isRunning).length,
    els: [...instances.keys()].map((el) => el.className || el.id || el.tagName),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  // Поздние панельки (подсказки/палитра дорисовываются асинхронно) —
  // подстраховка в том же ритме, что у feel.js.
  setTimeout(scan, 400);
  setTimeout(scan, 1500);
})();
