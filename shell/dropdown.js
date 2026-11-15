// LiveBrowser native dropdown layer (host panelView): a plain list page the
// host positions above the active site.  Two states share this one view:
//   - suggestion rows: {items, active, query, mode} -> pick {type:'pick',value}
//   - the gear search menu: {menu:true, mode, palettes, index} -> picks
//     {type:'menu-pick', action:'palette'|'mode'|'settings', index?}
// The host forwards every pick to the shell, which answers with a fresh
// menu (palette/mode) or closes the layer (settings).
'use strict';

(function () {

  const list = document.getElementById('dd-list');

  function post(msg) {
    try { window.chrome.webview.postMessage(JSON.stringify(msg)); }
    catch { /* host gone */ }
  }

  // Same prefix-bolding rule as the shell's own panel (search.js).
  function highlight(text, prefix) {
    const frag = document.createDocumentFragment();
    const q = prefix || '';
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i > 0) frag.appendChild(document.createTextNode(text.slice(0, i)));
    if (i >= 0) {
      const b = document.createElement('b');
      b.textContent = text.slice(i, i + q.length);
      frag.appendChild(b);
      frag.appendChild(document.createTextNode(text.slice(i + q.length)));
    } else {
      frag.appendChild(document.createTextNode(text));
    }
    return frag;
  }

  // Full re-render per message is fine: the lists are short (~10 rows).
  function render(msg) {
    if (msg.menu) return renderMenu(msg);
    renderRows(msg);
  }

  /* Row cascade, mirroring the shell's local panel (search.js).
     This view is a separate page from the shell, so it needs the animation
     of its own: over a site the shell's #suggests is clipped to the bar and
     paints nothing, and everything the user sees comes from here.
     Two tiers like the shell: the first list after the layer opens gets the
     relaxed beat, keystroke refills the tight one.  `lastQuery` is how we
     tell them apart — a new query means the user typed since the last draw. */
  const STAGGER_OPEN_MS = 22;
  const STAGGER_REFILL_MS = 12;
  const STAGGER_ROWS = 10;
  let lastQuery = null;

  function cascadeRows(rows, fresh, delays) {
    // The host may hand us the delay map from the shell (identical timing on
    // both sides); fall back to the local rhythm when it does not.
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    rows.forEach((row, i) => {
      if (i >= STAGGER_ROWS) return;
      const step = fresh ? STAGGER_OPEN_MS : STAGGER_REFILL_MS;
      const d = Array.isArray(delays) && delays[i] != null ? delays[i] : i * step;
      row.style.setProperty('--sug-delay', `${d}ms`);
      row.classList.add('suggest-in');
      row.addEventListener('animationend', () => {
        row.classList.remove('suggest-in');
        row.style.removeProperty('--sug-delay');
      }, { once: true });
    });
  }

  function renderRows(msg) {
    if (msg.mode === 'light' || msg.mode === 'dark')
      document.documentElement.dataset.theme = msg.cyber === true ? 'cyberpunk' : msg.mode;
    const items = Array.isArray(msg.items) ? msg.items : [];
    const tabRows = Array.isArray(msg.tabRows) ? msg.tabRows : [];
    const q = typeof msg.query === 'string' ? msg.query : '';
    const active = typeof msg.active === 'number' ? msg.active : -1;
    list.setAttribute('aria-label', 'Подсказки поиска');
    // После generic-меню слой мог остаться с role="menu" — возвращаем свою.
    list.setAttribute('role', 'listbox');

    // Дифф-рендер, как в шелле (search.js): строка, совпавшая по ключу,
    // переживает запрос — текст обновляется на месте, без пересоздания и
    // без повторного каскада.  Полный replaceChildren на каждое нажатие
    // клавиши дрожал и переигрывал анимации — то самое «30 fps».
    const want = [];
    // Открытые вкладки идут первыми, как в локальной панели шелла.
    for (const t of tabRows) want.push({ kind: 'tab', id: t.id, title: t.title || '', fav: t.favicon || '' });
    for (const text of items) want.push({ kind: 'item', text });

    const keyOf = (w) => (w.kind === 'tab' ? 'tab:' + w.id : 'item:' + w.text);
    const pool = new Map();
    for (const el of [...list.children]) {
      list.removeChild(el);
      pool.set(el.dataset.key, el);
    }
    const freshRows = [];
    want.forEach((w) => {
      const key = keyOf(w);
      const kept = pool.get(key) || null;
      pool.delete(key);
      const el = kept || buildRow(w);
      fillRow(el, w, q);
      el.dataset.key = key;
      list.appendChild(el); // append перемещает существующий узел без пересоздания
      if (!kept) freshRows.push(el);
    });
    pool.clear();

    // Активная строка и «→» — один проход после сборки списка.
    [...list.children].forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      el.classList.remove('suggest-stale'); // список снова авторитетный
      const go = el.querySelector('.go');
      if (go) go.style.opacity = on ? '1' : '0';
    });

    // Cascade AFTER layout, and only for rows that are genuinely new: the
    // delays are applied in one pass, so the rows start from their final
    // positions and never reflow the panel under the host's measured rect.
    const wasHidden = list.dataset.wasHidden === '1';
    const fresh = lastQuery === null || lastQuery !== q;
    lastQuery = q;
    cascadeRows(freshRows, fresh || wasHidden, msg.delays);
    if (wasHidden) playPanelIn(); // слой заново показан — карточка входит
    list.dataset.wasHidden = '0';
    // Keyboard navigation (arrows in the omnibox) must keep the highlighted
    // row visible, exactly like the shell's own panel does.
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function buildRow(w) {
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'option');
    const icon = document.createElement('span');
    if (w.kind === 'tab') {
      row.className = 'suggest tab-row';
      icon.className = 'suggest-icon suggest-fav';
      row.dataset.tabId = String(w.id);
      row.dataset.query = w.title;
    } else {
      row.className = 'suggest';
      icon.className = 'suggest-icon';
      row.dataset.query = w.text;
    }
    const textEl = document.createElement('span');
    textEl.className = 'suggest-text';
    const go = document.createElement('span');
    go.className = 'suggest go' + (w.kind === 'tab' ? ' suggest-tab-hint' : '');
    go.textContent = w.kind === 'tab' ? 'Вкладка' : '→';
    go.style.opacity = '0';

    // pointerdown, not click: pressing the row moves the native focus to
    // this view, which blurs the shell's omnibox — its blur timer hides
    // the layer ~140 ms later, so the pick must be out of the door at
    // mousedown or a slow click would never land.  Данные — из dataset в
    // момент события: строка переживает несколько запросов.
    row.addEventListener('pointerdown', () => {
      if (row.classList.contains('tab-row')) post({ type: 'pick-tab', id: Number(row.dataset.tabId) });
      else post({ type: 'pick', value: row.dataset.query });
    });

    row.append(icon, textEl, go);
    return row;
  }

  function fillRow(row, w, q) {
    const icon = row.children[0];
    const textEl = row.children[1];
    const title = w.kind === 'tab' ? w.title : w.text;
    if (w.kind === 'tab' && w.fav) {
      const img = icon.querySelector('img');
      if (!img || img.getAttribute('src') !== w.fav) {
        icon.replaceChildren();
        const el = document.createElement('img');
        el.src = w.fav;
        el.alt = '';
        el.loading = 'lazy';
        icon.appendChild(el);
      }
    } else if (!icon.querySelector('svg')) {
      icon.innerHTML = w.kind === 'tab'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
          '<path d="M3.5 12h17M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
          '<path d="M16.5 16.5 21 21"/></svg>';
    }
    textEl.replaceChildren(highlight(title, q));
    row.dataset.query = title;
  }

  // The search menu over a site: same elements as the shell's local popover
  // (#search-menu).  The .sm-* styles come from app.css (linked below);
  // palettes arrive as plain accent colours, one swatch each.
  function renderMenu(msg) {
    if (msg.mode === 'light' || msg.mode === 'dark')
      document.documentElement.dataset.theme = msg.cyber === true ? 'cyberpunk' : msg.mode;
    // Generic-меню («Ещё», контекстное, «Недавно закрытые»): пункты приходят
    // как [{label, danger, disabled, sep}] — стили .lb-menu-* из menu.css.
    // palettes и items взаимоисключаемы: шелл шлёт что-то одно.
    if (Array.isArray(msg.items)) return renderItems(msg.items);
    const palettes = Array.isArray(msg.palettes) ? msg.palettes : [];
    const index = typeof msg.index === 'number' ? msg.index : -1;
    const light = msg.mode === 'light' || msg.isLight === true;
    list.setAttribute('aria-label', 'Настройки вида');
    list.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'dd-menu';

    const swatches = document.createElement('div');
    swatches.className = 'sm-swatches';
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', 'Палитры');
    palettes.forEach((accent, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'sm-swatch' + (i === index ? ' active' : '');
      sw.dataset.palette = String(i);
      sw.style.background = accent;
      sw.setAttribute('aria-label', `Палитра ${i + 1}`);
      sw.setAttribute('aria-pressed', i === index ? 'true' : 'false');
      sw.addEventListener('pointerdown', () =>
        post({ type: 'menu-pick', action: 'palette', index: i }));
      swatches.appendChild(sw);
    });

    const modeRow = document.createElement('div');
    modeRow.className = 'sm-mode';
    modeRow.setAttribute('role', 'group');
    modeRow.setAttribute('aria-label', 'Тёмная или светлая тема');
    for (const [mode, label] of [['dark', 'Тёмная'], ['light', 'Светлая']]) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'sm-tab' + ((mode === 'light') === light ? ' active' : '');
      tab.textContent = label;
      tab.setAttribute('role', 'menuitemradio');
      tab.setAttribute('aria-checked', (mode === 'light') === light ? 'true' : 'false');
      tab.addEventListener('pointerdown', () => post({ type: 'menu-pick', action: 'mode' }));
      modeRow.appendChild(tab);
    }

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'sm-row';
    all.setAttribute('role', 'menuitem');
    all.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6"/></svg>' +
      '<span>Все настройки</span>';
    all.addEventListener('pointerdown', () => post({ type: 'menu-pick', action: 'settings' }));

    wrap.append(swatches, modeRow, all);
    list.appendChild(wrap);
  }

  // Плоское меню из массива items: sep -> .lb-menu-sep, пункт ->
  // button.lb-menu-item (классы danger/disabled совпадают с menu.css шелла).
  // Индекс i — позиция в msg.items, СЧИТАЯ разделители: ровно этот индекс
  // вернётся в шелл, где LiveMenu.runItem исполняет action по нему же.
  function renderItems(items) {
    list.setAttribute('aria-label', 'Меню');
    list.setAttribute('role', 'menu');
    list.replaceChildren();
    items.forEach((it, i) => {
      if (it && it.sep) {
        const sep = document.createElement('div');
        sep.className = 'lb-menu-sep';
        sep.setAttribute('role', 'separator');
        list.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lb-menu-item' + (it && it.danger ? ' lb-danger' : '');
      btn.setAttribute('role', 'menuitem');
      btn.textContent = (it && it.label) || '';
      if (it && it.disabled) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      } else {
        // pointerdown, как у строк подсказок: медленный клик должен уйти
        // в шелл до того, как хост успеет спрятать слой.
        btn.addEventListener('pointerdown', () =>
          post({ type: 'menu-pick', action: 'item', index: i }));
      }
      list.appendChild(btn);
    });
    // Вход меню: карточка + каскад пунктов (≤150мс, opacity+translate —
    // рецепт guide "menu").  Нативное меню открывается чаще всего с нуля,
    // поэтому каскад играет на каждом renderItems.
    playPanelIn();
    cascadeItems();
  }

  // Вход карточки панели: dd-in в dropdown.html, снимается по animationend.
  function playPanelIn() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    list.classList.remove('dd-in');
    void list.offsetWidth; // рестарт на быстром reopen
    list.classList.add('dd-in');
    const done = () => {
      list.classList.remove('dd-in');
      list.removeEventListener('animationend', done);
    };
    list.addEventListener('animationend', done);
    setTimeout(done, 200); // страховка
  }

  // Каскад пунктов меню: ступенька 18мс, первые 9 пунктов — дальше уже
  // заметная очередь, а не «плавность».
  function cascadeItems() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    [...list.children].forEach((el, i) => {
      if (i >= 9 || !el.classList.contains('lb-menu-item')) return;
      el.style.setProperty('--dd-i', `${i * 18}ms`);
      el.classList.add('dd-new');
      el.addEventListener('animationend', () => {
        el.classList.remove('dd-new');
        el.style.removeProperty('--dd-i');
      }, { once: true });
    });
  }

  // Crossfade: the host reuses this layer to dissolve between views — a
  // full-bleed snapshot of the outgoing view fades out, then we report back.
  const snap = document.createElement('img');
  snap.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;transition:opacity 0.18s ease;z-index:50';
  snap.addEventListener('transitionend', () => {
    snap.remove();
    post({ type: 'fade-done' });
  });
  function runFade(dataUrl) {
    snap.remove();
    snap.style.opacity = '1';
    snap.src = dataUrl;
    document.body.appendChild(snap);
    requestAnimationFrame(() => requestAnimationFrame(() => snap.style.opacity = '0'));
  }

  window.chrome?.webview?.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (typeof d.fade === 'string') { runFade(d.fade); return; }
    // Host hid the layer: the next list is a fresh opening, not a refill.
    if (d['layer-hidden']) { lastQuery = null; list.dataset.wasHidden = '1'; return; }
    render(d);
  });

  // The host waits for this before ever showing the view: showing earlier
  // would flash a blank rectangle over the site.
  post({ type: 'panel-ready' });

})();
