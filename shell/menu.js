/* Меню и жесты оболочки (shell), без правки tabs.js.
   - контекстное меню нативного вида для вкладок и рабочего стола;
   - перенос вкладки как жест: отпустил над другой вкладкой — она активна;
   - приём перетащенной ссылки на полосу вкладок.
   Микро-отклик на нажатие живёт в feel.js (.is-pressed, там же все гварды
   no-anim/prefers-reduced-motion) — дублировать его здесь не нужно. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Контекстное меню                                                    */
  /* ------------------------------------------------------------------ */

  const MENU_ID = 'lb-ctx-menu';
  let menuEl = null;   // общий div, создаётся лениво и живёт между показами
  let returnFocus = null; // куда вернуть фокус при Escape
  // Логическое состояние «меню открыто» отдельно от menuEl.hidden: закрытие
  // гасит его мгновенно, а DOM прячется только после излёта (.lb-exit).
  let menuOpen = false;

  function el(id) {
    return document.getElementById(id);
  }

  // Анимированное скрытие локального меню (app.css .lb-exit): пункты видны,
  // пока меню тает, но клики уже проходят мимо (pointer-events:none).
  // Гварды: no-anim / tactile-off / prefers-reduced-motion — мгновенно.
  // hide() проверяет !menuOpen, поэтому устаревший done (страховочный таймер
  // или animationend после повторного показа) не погасит свежее меню.
  function exitThenHide(node, hide) {
    if (!node || node.hidden) { hide(); return; }
    const gated = document.body.classList.contains('no-anim')
      || document.body.classList.contains('tactile-off')
      || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (gated || node.classList.contains('lb-exit')) { hide(); return; }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      node.classList.remove('lb-exit');
      hide();
    };
    node.classList.add('lb-exit');
    node.addEventListener('animationend', done, { once: true });
    setTimeout(done, 160); // safety net: если animationend не пришёл
  }

  // Над сайтом шелл обрезан хостом до высоты бара: любой поповер «съедается»
  // вьюхой сайта.  Как подсказки в search.js, меню рисует нативный слой
  // (panelView / dropdown.html): шлём пункты и прямоугольник, клики
  // возвращаются мостом menu-pick action:"item" (app.js -> runItem).
  function overSite() {
    return document.body.classList.contains('site-active') && !!window.chrome?.webview;
  }

  function post(msg) {
    try { window.chrome?.webview?.postMessage(JSON.stringify(msg)); }
    catch { /* host gone */ }
  }

  // Последний отправленный список (с живыми action): runItem исполняет по
  // индексу — ровно тому, что был в msg.items (sep считаются).
  let nativeItems = null;

  // Отложенное закрытие по blur (см. обработчик ниже): таймер живёт здесь,
  // чтобы nativeClose/hideMenu могли его отменить — пик пункта меню гасит
  // меню сам и не должен получить «догоняющее» закрытие после себя.
  let blurCloseTimer = 0;

  // Нижняя кромка 56-px полосы шелла: над сайтом ui-вьюха с баром рисуется
  // ПОВЕРХ нативного слоя, и верх панели выше этой кромки ею обрезается
  // («бургер обрезан сверху»).  56 = вплотную под бар, ближе физически
  // нельзя.  Хост клампит тем же числом.
  const BAR_BOTTOM = 56;

  function nativeOpen() { return !!nativeItems; }

  function nativeClose() {
    if (blurCloseTimer) { clearTimeout(blurCloseTimer); blurCloseTimer = 0; }
    if (!nativeItems) return;
    nativeItems = null;
    window.LivePops?.close('menu');
    post({ type: 'menu', open: false });
  }

  // Геометрия будущего меню: ширина по самому длинному пункту (как у
  // .lb-menu: 190..280, плюс паддинги карточки), высота — сумма строк
  // (пункт ~31px, разделитель 9px, паддинги 8+8), зажата в окно.
  // anchor — rect кнопки (меню под ней, по правому краю) или точка
  // курсора (width: 0) для контекстного меню.
  function nativeRectFor(items, anchor) {
    const maxLen = items.reduce((m, it) => Math.max(m, it && it.label ? it.label.length : 0), 0);
    const w = Math.min(320, Math.max(236, Math.round(maxLen * 6.6) + 56));
    let h = 16;
    for (const it of items) h += it && it.sep ? 9 : 31;
    h = Math.round(h);
    const pad = 6;
    let l; let t;
    if (anchor && anchor.width > 0) { l = anchor.right - w; t = anchor.bottom + 4; }
    else { l = anchor ? anchor.left : pad; t = anchor ? anchor.top : pad; }
    l = Math.max(pad, Math.min(l, window.innerWidth - w - pad));
    t = Math.max(pad, Math.min(t, window.innerHeight - h - pad));
    // Верх панели — не выше нижней кромки бара (см. BAR_BOTTOM).
    t = Math.max(t, BAR_BOTTOM);
    return { l: Math.round(l), t: Math.round(t), w, h };
  }

  // Показ нативного меню: items — локальные объекты с action; в хост уходит
  // копия без функций (JSON их всё равно теряет).  Возвращает true, если
  // сообщение ушло (history.js решает по этому, показывать ли свой поповер).
  function showNativeItems(items, anchor) {
    if (!overSite() || !Array.isArray(items) || !items.length) return false;
    // Реестр поповеров: меню гасит палитру/подсказки/стрип истории.
    window.LivePops?.open('menu', () => nativeClose());
    const r = nativeRectFor(items, anchor || null);
    nativeItems = items.slice();
    post({
      type: 'menu', menu: true, open: true,
      l: r.l, t: r.t, w: r.w, h: r.h,
      items: items.map((it) => (it && it.sep)
        ? { sep: true }
        : { label: String((it && it.label) || ''), danger: !!(it && it.danger), disabled: !!(it && it.disabled) }),
    });
    return true;
  }

  // Пункт из нативного меню: слой закрываем ДО action (пункты вроде
  // «Настройки» открывают страницы), затем исполняем по индексу.
  function runItem(index) {
    const items = nativeItems;
    nativeClose();
    const it = items && items[Number(index)];
    if (!it || it.sep || it.disabled || typeof it.action !== 'function') return;
    try { it.action(); } catch (err) { console.warn('[menu] item', err); }
  }

  // Точка курсора как «якорь» контекстного меню над сайтом.
  function nativePoint(e) {
    return { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 };
  }

  // Сообщение о действии без буфера: у оболочки есть тосты (toasts.js).
  function say(text) {
    try { window.showToast?.(text); } catch { /* тостов ещё нет */ }
  }

  // Кнопка «Обновить» в полосе уже умеет перезагружать страницу (tabs.js):
  // клик по ней — самый безопасный способ без нового мостового сообщения.
  function reloadActive() {
    const btn = el('nav-reload');
    if (btn && !btn.disabled) btn.click();
  }

  // Дублировать = открыть тот же адрес ещё раз; хост даст новую вкладку.
  function duplicateTab(id) {
    const tabs = window.LiveTabs?.state?.tabs || [];
    const tab = tabs.find((t) => t.id === id);
    if (!tab || !tab.url) { say('Нечего дублировать'); return; }
    window.LiveTabs?.open(tab.url, tab.title || '');
  }

  // Закрываем пачкой: список вкладок снимаем ДО первого close, потому что
  // после него хост может прислать новый список.
  function closeMany(ids) {
    const api = window.LiveTabs;
    if (!api) return;
    for (const id of ids) {
      if (id !== 0) api.close(id);
    }
  }

  function tabIds() {
    const tabs = window.LiveTabs?.state?.tabs || [];
    return tabs.map((t) => t.id);
  }

  function newTab() {
    window.LiveTabs?.home();
  }

  // Новое окно: хост создаёт форму сам (Ctrl+N идёт тем же путём в
  // ProcessCmdKey), так что пункт меню и горячая клавиша не расходятся.
  function newWindow() {
    post({ type: 'new-window' });
  }

  // Приватное окно: отдельный профиль, который стирается при закрытии.
  function newPrivateWindow() {
    post({ type: 'new-private' });
  }

  function openHistory() {
    // Полноценной страницы истории в сборке нет; «недавнее» показывает
  // поповер недавно закрытых вкладок (history.js) — им и открываем.
    if (window.LiveRecent?.openPop) window.LiveRecent.openPop();
  }

  function openSettings() {
    if (window.LiveSettingsPage?.open) { window.LiveSettingsPage.open(); return; }
    // Legacy path without the settings page: the bar's gear opens the sheet.
    el('settings-btn')?.click();
  }

  function openDownloads() {
    el('downloads-btn')?.click();
  }

  // Пункт меню: { label, action, disabled, danger, sep }
  function buildMenu(items, variant) {
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = MENU_ID;
      menuEl.className = 'lb-menu';
      menuEl.setAttribute('role', 'menu');
      menuEl.hidden = true;
      document.body.appendChild(menuEl);
    }
    const frag = document.createDocumentFragment();
    for (const item of items) {
      if (!item) continue;
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'lb-menu-sep';
        sep.setAttribute('role', 'separator');
        frag.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lb-menu-item' + (item.danger ? ' lb-danger' : '');
      btn.setAttribute('role', 'menuitem');
      btn.textContent = item.label;
      if (item.disabled) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.addEventListener('click', () => {
          hideMenu(true);
          try { item.action?.(); } catch (err) { console.warn('[menu]', err); }
        });
      }
      frag.appendChild(btn);
    }
    menuEl.classList.toggle('bar-menu', variant === 'bar');
    menuEl.replaceChildren(frag);
    return menuEl;
  }

  // Показ у курсора с учётом границ окна: меню не должно вылезать за край.
  function placeMenu(x, y) {
    const r = menuEl.getBoundingClientRect();
    const pad = 6;
    let left = x;
    let top = y;
    if (left + r.width + pad > window.innerWidth) left = window.innerWidth - r.width - pad;
    if (top + r.height + pad > window.innerHeight) top = y - r.height;
    menuEl.style.left = `${Math.max(pad, Math.round(left))}px`;
    menuEl.style.top = `${Math.max(pad, Math.round(top))}px`;
  }

  function showMenu(items, x, y, variant) {
    window.LivePops?.open('menu', () => hideMenu(false));
    buildMenu(items, variant);
    menuOpen = true;
    // Показ во время излёта предыдущего меню (клик мимо -> правый клик,
    // hideMenu+showMenu в одном ходе): снимаем .lb-exit до показа, чтобы
    // не остался «мёртвый» класс и не играл оборванная анимация.  Излёт
    // никогда не блокирует повторное открытие: его hide() увидит menuOpen.
    menuEl.classList.remove('lb-exit');
    menuEl.hidden = false;
    menuEl.classList.add('show');
    placeMenu(x, y);
    const first = menuEl.querySelector('.lb-menu-item:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  function hideMenu(returnFocusToTrigger) {
    if (!menuOpen || !menuEl) return;
    // Логическое состояние гаснет сразу: реестр поповеров, класс .show,
    // возврат фокуса — всё синхронно, как раньше.
    menuOpen = false;
    if (blurCloseTimer) { clearTimeout(blurCloseTimer); blurCloseTimer = 0; }
    window.LivePops?.close('menu');
    menuEl.classList.remove('show');
    const back = returnFocus;
    returnFocus = null;
    if (returnFocusToTrigger && back && typeof back.focus === 'function' && back.isConnected) {
      try { back.focus({ preventScroll: true }); } catch { /* уже удалён */ }
    }
    // Только DOM прячется после излёта (.lb-exit, 140 мс).  window blur/resize
    // и повторный показ в этот момент — no-op: hide() проверяет menuOpen.
    exitThenHide(menuEl, () => {
      if (!menuOpen && menuEl) {
        menuEl.hidden = true;
        menuEl.replaceChildren();
      }
    });
  }

  function isMenuOpen() {
    return menuOpen;
  }

  // Меню для вкладки: id вкладки, соседи берём из состояния LiveTabs.
  function tabMenuItems(id) {
    const ids = tabIds();
    const at = ids.indexOf(id);
    const others = ids.filter((t) => t !== id);
    const right = at >= 0 ? ids.slice(at + 1) : [];
    return [
      { label: 'Обновить', action: reloadActive },
      { label: 'Дублировать вкладку', action: () => duplicateTab(id) },
      { sep: true },
      { label: 'Закрыть', action: () => window.LiveTabs?.close(id) },
      { label: 'Закрыть другие', action: () => closeMany(others) },
      { label: 'Закрыть справа', action: () => closeMany(right), disabled: right.length === 0 },
      { sep: true },
      { label: 'Новая вкладка', action: newTab },
    ];
  }

  // «Ещё» (overlay menu in the bar): every secondary action in one place.
  // The primary cluster keeps only back/forward/reload + new tab.
  function moreMenuItems() {
    const hasHistory = !!(window.LiveHistory?.open || window.LiveRecent?.openPop);
    return [
      { label: 'Новое окно', action: newWindow },
      { label: 'Приватное окно', action: newPrivateWindow },
      { sep: true },
      { sep: true },
      { label: 'Недавно закрытые', action: () => window.LiveRecent?.openPop?.() },
      { label: 'История', action: openHistory, disabled: !hasHistory },
      { label: 'Загрузки', action: openDownloads },
      { sep: true },
      { label: 'На главную', action: () => window.LiveTabs?.home() },
      { label: 'Настройки', action: openSettings },
    ];
  }

  // Меню рабочего стола: только shell-уровневые действия.
  function desktopMenuItems() {
    const hasHistory = !!(window.LiveHistory?.open || window.LiveRecent?.openPop);
    return [
      { label: 'Новая вкладка', action: newTab },
      { label: 'Новое окно', action: newWindow },
      { label: 'Приватное окно', action: newPrivateWindow },
      { sep: true },
      { label: 'Открыть историю', action: openHistory, disabled: !hasHistory },
      { label: 'Загрузки', action: openDownloads },
      { sep: true },
      { label: 'Настройки', action: openSettings },
    ];
  }

  // Родное меню браузера остаётся внутри сайтов (их WebView2 рисует его
  // сам).  Здесь гасим его только в оболочке: полоса, вкладки, рабочий стол.
  function onContextMenu(e) {
    // Поля ввода и выделенный текст — оставляем системное меню: там нужны
    // «Копировать»/«Вставить», которых в нашем списке нет.
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (window.getSelection && String(window.getSelection()) !== '') return;

    const tab = e.target.closest('#tabs .tab[data-id], .tab-home');
    if (tab) {
      const id = tab.classList.contains('tab-home') ? 0 : Number(tab.dataset.id) || 0;
      e.preventDefault();
      returnFocus = tab;
      // Над сайтом то же меню рисует нативный слой (см. overSite).
      if (overSite()) { showNativeItems(tabMenuItems(id), nativePoint(e)); return; }
      showMenu(tabMenuItems(id), e.clientX, e.clientY);
      return;
    }

    // Рабочий стол: .stage/.links и «голое» тело страницы.  На сайте тело
    // прозрачно для нативных вьюх, но это не повод менять поведение кликов.
    const desktop = e.target.closest('#stage, .links') || e.target === document.body;
    if (desktop) {
      e.preventDefault();
      returnFocus = null;
      if (overSite()) { showNativeItems(desktopMenuItems(), nativePoint(e)); return; }
      showMenu(desktopMenuItems(), e.clientX, e.clientY);
    }
  }

  // Закрытие по клику мимо.  mousedown закрывает до того, как клик дойдёт
  // до кнопки под меню (иначе меню «съедало» бы первый клик).
  function onAnyDown(e) {
    // Нажатие на «••» не гасит меню здесь: click по той же кнопке — Тоггл
    // (openMore закроет).  Гасить на mousedown + открывать на click = пара
    // close+open за 4мс, меню никогда не закрыто («•• не работает»).
    const onMore = !!(e.target.closest && e.target.closest('#more-btn'));
    if (nativeOpen() && !onMore) nativeClose();
    if (!isMenuOpen()) return;
    if (e.target.closest('#' + MENU_ID) || onMore) return;
    hideMenu(false);
  }

  // Прокрутка (колесо, страница рабочего стола) уводит меню от точки, где
  // его открыли, — прячем, как нативные меню.
  function onAnyScroll() {
    if (nativeOpen()) nativeClose();
    if (isMenuOpen()) hideMenu(false);
  }

  function onKey(e) {
    // Esc закрывает и нативное меню над сайтом; остальные клавиши — не наши.
    if (nativeOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        nativeClose();
        const back = returnFocus;
        returnFocus = null;
        if (back && typeof back.focus === 'function' && back.isConnected) {
          try { back.focus({ preventScroll: true }); } catch { /* нет узла */ }
        }
      }
      return;
    }
    if (!isMenuOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideMenu(true);
      return;
    }
    // Стрелки / Home / End — как у нативного меню Windows.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const items = [...menuEl.querySelectorAll('.lb-menu-item:not(:disabled)')];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement);
      let next = 0;
      if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
      else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
      items[next].focus({ preventScroll: true });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Перенос вкладки (жест, без перестановки) + приём ссылок в полосе     */
  /* ------------------------------------------------------------------ */

  // Полоса вкладок перерисовывается tabs.js, поэтому слушаем на контейнере.
  // dragstart на .tab: ставим dataTransfer (иначе Chromium не начнёт drag),
  // на dragend считаем, куда отпустили, и просто активируем ту вкладку.
  // Перестановку не делаем: порядок принадлежит хосту (tabs.js не трогаем).
  function initDrag() {
    const strip = el('tabs');
    if (!strip) return;

    strip.addEventListener('dragstart', (e) => {
      const tab = e.target.closest('.tab[data-id]');
      if (!tab) return;
      try {
        const dt = e.dataTransfer;
        if (!dt) return;
        dt.effectAllowed = 'link';
        dt.setData('text/plain', tab.title || '');
      } catch { /* древний движок без DataTransfer */ }
      tab.classList.add('lb-dragging');
    });

    strip.addEventListener('dragend', (e) => {
      const src = e.target.closest('.tab[data-id]');
      src?.classList.remove('lb-dragging');
      // Перетащили не саму вкладку (текст/адрес) — dragend не про жест.
      if (!src) return;
      // Над полосой — активируем вкладку под курсором (как «отпустил над»).
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#tabs .tab[data-id]');
      if (!over) return;
      const id = Number(over.dataset.id) || 0;
      const active = Number(window.LiveTabs?.state?.activeId) || 0;
      if (id !== active) window.LiveTabs?.switchTo(id);
    });

    // Приём перетащенной ссылки: в оболочку можно уронить текст/uri-list.
    // Из сайта в полосу не перетащить (нативные вьюхи — отдельные окна);
    // пригодится для ссылок из других приложений и внутренних дrops.
    const accept = (target) => {
      target.addEventListener('dragover', (e) => {
        if (!hasUrl(e.dataTransfer)) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'link'; } catch { /* нет доступа */ }
        target.classList.add('lb-drop-ok');
      });
      target.addEventListener('dragleave', () => target.classList.remove('lb-drop-ok'));
      target.addEventListener('drop', (e) => {
        target.classList.remove('lb-drop-ok');
        const url = pickUrl(e.dataTransfer);
        if (!url) return;
        e.preventDefault();
        e.stopPropagation();
        try { window.LiveTabs?.open(url, ''); } catch (err) { console.warn('[menu] drop', err); }
      });
    };
    accept(el('chrome-bar') || strip);

    // Есть элемент #drag-zone (маркер свободного места в баре) — он тоже
    // принимает дроп, если появится в макете.
    const zone = el('drag-zone');
    if (zone) accept(zone);
  }

  function hasUrl(dt) {
    try {
      if (!dt) return false;
      if (!dt.types) return false;
      return [...dt.types].some((t) => t === 'text/uri-list' || t === 'text/plain');
    } catch { return false; }
  }

  function pickUrl(dt) {
    try {
      const uri = dt.getData('text/uri-list');
      if (uri) {
        // uri-list: строки, «#» — комментарии; берём первый http(s)/валидный.
        const line = uri.split(/\r?\n/).map((s) => s.trim()).find((s) => s && s[0] !== '#');
        if (line) return line;
      }
      const text = dt.getData('text/plain').trim();
      if (/^(https?:|file:|about:|data:)/i.test(text)) return text;
      // «example.com/путь» без схемы — похоже на адрес, а не на слово.
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return text;
    } catch { /* DataTransfer закрыт после drop */ }
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* Запуск                                                              */
  /* ------------------------------------------------------------------ */

  // The bar's «Ещё» button: anchors the same overlay menu to its corner.
  function openMore(trigger) {
    const btn = trigger || el('more-btn');
    // Тоггл: повторный клик по «Ещё» при уже открытом меню ЗАКРЫВАЕТ его —
    // нативное (любое меню канала, включая поп «Недавно закрытые») или
    // локальное bar-варианта.  Без этого «••» выглядела сломанной: меню
    // переоткрывалось тем же списком и не закрывалось.
    if (btn === el('more-btn')) {
      if (nativeOpen()) { nativeClose(); return; }
      if (isMenuOpen() && menuEl && menuEl.classList.contains('bar-menu')) {
        hideMenu(true);
        return;
      }
    }
    const items = moreMenuItems();
    // Settings/history panels are real pages: close them first.
    window.LiveSettingsPage?.close?.();
    window.LiveHistory?.close?.();
    if (overSite()) {
      // Над сайтом локальное меню съедается вьюхой сайта: рисует нативный
      // слой.  Один слой за раз — подсказки и поповер «Недавно закрытые»
      // закрываем (канал у них общий).
      hideMenu(false);
      window.LiveSearch?.hide?.();
      window.LiveRecent?.closePop?.();
      returnFocus = btn;
      const r = btn && btn.offsetWidth > 0
        ? btn.getBoundingClientRect()
        : { left: innerWidth - 40, top: 56, right: innerWidth - 40, bottom: 56, width: 0, height: 0 };
      showNativeItems(items, r);
      return;
    }
    const open = () => {
      const r = btn ? btn.getBoundingClientRect() : { left: innerWidth - 40, bottom: 56 };
      hideMenu(false);
      returnFocus = btn;
      showMenu(items, r.left, r.bottom + 6, 'bar');
    };
    open();
  }

  // The visible badges now live on «Ещё» (the originals sit on the hidden
  // anchors).  Total = downloads in flight + recently closed groups.
  function syncMoreBadge() {
    const badge = el('more-badge');
    if (!badge) return;
    const dl = Number(el('dl-badge')?.textContent) || 0;
    const rc = Number(el('recent-count')?.textContent) || 0;
    const n = dl + rc;
    badge.textContent = String(n);
    badge.hidden = n <= 0;
    el('more-btn')?.classList.toggle('has-badge', n > 0);
  }

  function watchBadges() {
    for (const id of ['dl-badge', 'recent-count']) {
      const src = el(id);
      if (!src) continue;
      new MutationObserver(syncMoreBadge).observe(src, {
        attributes: true, childList: true, characterData: true, subtree: true,
      });
    }
    syncMoreBadge();
  }

  function init() {
    // menu.js грузится лениво (modules.js): к этому моменту модуль уже
    // исполнен, поэтому привязка одна и повторной загрузки не будет.
    el('more-btn')?.addEventListener('click', (e) => { e.stopPropagation(); openMore(); });
    watchBadges();
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onAnyDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onAnyScroll, true);
    // Блюр шелла = фокус ушёл в другую вьюху (панель меню или сайт).  НЕ
    // гасим меню мгновенно: клик по ПУНКТУ нативного меню сам забирает
    // фокус в панель (WebView2 забирает фокус ДО доставки pointerdown) —
    // мгновенное закрытие убивало пункт до того, как его pick доезжал
    // («кнопки меню не работают на сайте»).  Откладываем на 140мс и
    // отменяем, если pick приехал (runItem/nativeClose сами гасят).
    window.addEventListener('blur', () => {
      if (!nativeOpen() && !isMenuOpen()) return;
      clearTimeout(blurCloseTimer);
      blurCloseTimer = setTimeout(() => {
        blurCloseTimer = 0;
        hideMenu(false);
        nativeClose();
      }, 140);
    });
    window.addEventListener('focus', () => {
      if (blurCloseTimer) { clearTimeout(blurCloseTimer); blurCloseTimer = 0; }
    });
    window.addEventListener('resize', () => {
      if (blurCloseTimer) { clearTimeout(blurCloseTimer); blurCloseTimer = 0; }
      hideMenu(false);
      nativeClose();
    });
    initDrag();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Хост спрятал слой (фокус ушёл на сайт при клике): состояние нативного
  // меню гасим, чтобы Esc/toggle не ссылались на уже невидимое меню.
  if (window.chrome?.webview?.addEventListener) {
    window.chrome.webview.addEventListener('message', (e) => {
      if (e && e.data && e.data.type === 'suggest-hide') nativeItems = null;
    });
  }

  // Наружу — минимум: отладке (QA-проба), history.js (showNativeItems/
  // runItem) и будущим сценариям.
  window.LiveMenu = {
    isOpen: isMenuOpen,
    close: () => { hideMenu(false); nativeClose(); },
    openAt: (x, y) => {
      // Над сайтом — нативный слой, на рабочем столе — как раньше.
      if (overSite()) showNativeItems(desktopMenuItems(), nativePoint({ clientX: x, clientY: y }));
      else showMenu(desktopMenuItems(), x, y);
    },
    openMore,
    runItem,
    showNativeItems,
  };
})();
