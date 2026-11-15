// LiveBrowser command palette (Ctrl+K): a Raycast-style glass overlay with
// the open tabs and shell commands.  Wave 7, Agent-Features.
//
// Boundaries: everything lives in #palette-root (index.html adds only the
// root div, the stylesheet link and this script).  app.js/tabs.js/search.js/
// settings.js are NOT modified — this module only *reads* their exports:
//   LiveTabs (state.tabs/state.activeId/switchTo/close/home), LiveTheme
//   (toggleMode/setPalette/PALETTES), LiveSettingsPage.open, LiveDownloads
//   .openPage, LiveSearch.hide, LiveUi.closeSearchMenu, showToast.
//
// Host -> page: {"type":"palette"} opens the palette.  The orchestrator will
// forward Ctrl+K pressed on a site tab (ui.Focus() + Push, same pattern as
// "omni" — see FEATURES_NOTES.md).  A SECOND 'message' listener is added
// here on purpose: app.js keeps its own onHostMessage and the two do not
// overlap — this module consumes only 'palette' and 'tabs'.
'use strict';

(function () {

const R = (id) => document.getElementById(id);

const state = {
  built: false,
  open: false,
  items: [],   // every source row: {kind, group, title, sub, keywords, icon, favicon?, url?, badge?, run(shift)}
  shown: [],   // filtered + ranked; index == DOM row index
  active: 0,   // highlighted row in state.shown (-1 when the list is empty)
};

let overlayEl = null;
let panelEl = null;
let inputEl = null;
let listEl = null;
let emptyEl = null;

/* ------------------------------------------------------------------ */
/* Bridge + environment                                                */
/* ------------------------------------------------------------------ */

// Same channel as app.js/tabs.js: JSON strings over the WebView2 bridge.
function post(msg) {
  try {
    if (window.chrome?.webview) window.chrome.webview.postMessage(JSON.stringify(msg));
  } catch { /* host gone */ }
}

// The shell's no-anim kill switch and the OS preference both mean "instant".
function motionOk() {
  return !document.body.classList.contains('no-anim')
    && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// How long a modal layer takes to leave the screen; used by commands that
// must open another layer only after this one is gone.
function closeDelay() {
  return motionOk() ? 220 : 0;
}

// Анимированное скрытие (app.css .lb-exit): логическое состояние гаснет
// сразу (выше по коду), а DOM прячется только после 140-мс излёта.
// Гварды: no-anim / tactile-off / prefers-reduced-motion — прячем мгновенно.
// Возврат: скрыть по animationend ИЛИ по страховочному таймеру (гонка
// двойного скрытия снята флагом); повторное открытие снимает .lb-exit
// в open(), а hide() проверяет !state.open — устаревший done не погасит
// заново открытую палитру.
function exitThenHide(el, hide) {
  if (!el || el.hidden) { hide(); return; }
  const gated = document.body.classList.contains('no-anim')
    || document.body.classList.contains('tactile-off')
    || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (gated || el.classList.contains('lb-exit')) { hide(); return; }
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    el.classList.remove('lb-exit');
    hide();
  };
  el.classList.add('lb-exit');
  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, 160); // safety net: если animationend не пришёл
}

// The fullscreen settings/downloads pages claim the host's shared 'overlay'
// channel to stretch the ui view over the site.  The palette claims it the
// same way, but never steals or releases another page's claim: with a page
// open the channel is already in the "full window" state, and closing the
// palette must not shrink the ui view out from under that page.
function pageClaimsOverlay() {
  return ['settings-page', 'downloads-page']
    .some((id) => { const el = R(id); return !!el && el.hidden === false; });
}

function sendOverlay(open) {
  if (pageClaimsOverlay()) return;
  post({ type: 'overlay', open, height: open ? window.innerHeight : 0 });
}

/* ------------------------------------------------------------------ */
/* Icons: minimal 16px strokes, the shell's icon language              */
/* ------------------------------------------------------------------ */

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10V20h11V10"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><ellipse cx="12" cy="12" rx="3.6" ry="8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M10.6 3.4h2.8l.4 2.1a6.8 6.8 0 0 1 1.9.8l1.9-1.2 2 2-1.2 1.9c.36.6.63 1.24.8 1.9l2.1.4v2.8l-2.1.4a6.8 6.8 0 0 1-.8 1.9l1.2 1.9-2 2-1.9-1.2a6.8 6.8 0 0 1-1.9.8l-.4 2.1h-2.8l-.4-2.1a6.8 6.8 0 0 1-1.9-.8l-1.9 1.2-2-2 1.2-1.9a6.8 6.8 0 0 1-.8-1.9l-2.1-.4v-2.8l2.1-.4c.17-.66.44-1.3.8-1.9L4.3 7.1l2-2 1.9 1.2a6.8 6.8 0 0 1 1.9-.8l.4-2.1z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v9.5"/><path d="M8.2 9.7 12 13.5l3.8-3.8"/><path d="M4.5 18.5h15"/></svg>',
  theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/></svg>',
  dice: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.9 17.5a8 8 0 1 1 2.6 2.1"/><path d="M4.5 20.5v-3h3"/><path d="M12 8v4.2l2.8 1.7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 5.5H6.7A2.2 2.2 0 0 0 4.5 7.7v8.8"/></svg>',
  broom: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h15"/><path d="M6.5 15.5 15 7a2.1 2.1 0 0 1 3 3l-8.5 8.5z"/><path d="M9.5 18.5l-1-5"/><path d="M12.5 18.5l-.6-5"/></svg>',
};

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}

// app.js never exported randomPalette, so the palette rolls its own: pick a
// palette index different from the current one (the active swatch in the
// settings grid is the live truth; the theme id is the fallback) and hand it
// to LiveTheme.setPalette — the same write path the swatches use.
function currentPaletteIndex(palettes) {
  const sw = document.querySelector('#swatch-grid .swatch.active');
  if (sw && sw.dataset.palette != null && Number.isFinite(Number(sw.dataset.palette))) {
    return Number(sw.dataset.palette);
  }
  const id = window.liveBrowserTheme?.id;
  const i = palettes.findIndex((p) => p.id === id);
  return i >= 0 ? i : 0;
}

function randomPalette() {
  const theme = window.LiveTheme;
  const palettes = theme?.PALETTES;
  if (!theme?.setPalette || !Array.isArray(palettes) || palettes.length < 2) {
    window.showToast?.('Палитры недоступны');
    return;
  }
  const cur = currentPaletteIndex(palettes);
  let next = cur;
  while (next === cur) next = Math.floor(Math.random() * palettes.length);
  theme.setPalette(next);
}

// Active site tab's live address.  The host "tabs" push carries the committed
// url and app.js "nav" pushes the live one into the address pill
// (tabs.js showAddress stores it on #addr-pill[data-url]) — prefer the pill,
// fall back to the tab list so a pushed title/url refresh never wins here.
function activeUrl() {
  const st = window.LiveTabs?.state;
  const id = st ? st.activeId : 0;
  if (!id) return '';
  const pill = R('addr-pill');
  if (pill && pill.hidden === false && pill.dataset.url && !pill.dataset.url.startsWith('https://livebrowser.shell')) {
    return pill.dataset.url;
  }
  const tab = (st?.tabs || []).find((t) => t.id === id);
  return (tab && tab.url) || '';
}

// Clipboard with the execCommand fallback (same shape as tabs.js copyAddress):
// navigator.clipboard can be refused without a user gesture in WebView2.
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the legacy path */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// Rebuilt on every open/refresh so the tab rows mirror the host's latest
// push (LiveTabs.state is tabs.js's own mirror of {"type":"tabs"}).
function buildItems() {
  const items = [];
  const st = window.LiveTabs?.state;
  const tabs = Array.isArray(st?.tabs) ? st.tabs : [];
  const activeId = st ? st.activeId : 0;

  for (const t of tabs) {
    const home = Number(t.id) === 0;
    const url = home ? '' : (t.url || '');
    items.push({
      kind: 'tab',
      group: 'Вкладки',
      title: home ? 'Рабочий стол' : (t.title || t.url || 'Без названия'),
      sub: home ? 'Домашняя страница LiveBrowser' : (hostOf(url) || 'Вкладка'),
      keywords: url,
      icon: home ? ICONS.home : null, // null -> favicon, else globe
      favicon: home ? '' : (t.favicon || ''),
      url, // Shift+Enter opens this in a NEW tab instead of switching
      badge: t.id === activeId ? 'активная' : '',
      run: () => {
        if (window.LiveTabs?.switchTo) window.LiveTabs.switchTo(t.id);
        else post({ type: 'activate', id: t.id });
      },
    });
  }

  const actions = [
    {
      title: 'Новая вкладка',
      sub: 'Рабочий стол с омнибоксом — Ctrl+T',
      icon: ICONS.plus,
      keywords: 'new tab открыть создать',
      // There is no "newtab" bridge type: in this shell a new tab IS the
      // desktop (the + button and Ctrl+T both call goHome).  The raw post is
      // only a fallback for a future host that learns the type.
      run: () => {
        if (window.LiveTabs?.home) window.LiveTabs.home();
        else post({ type: 'newtab' });
      },
    },
    {
      title: 'Закрыть текущую вкладку',
      sub: 'Ctrl+W',
      icon: ICONS.close,
      keywords: 'close убрать',
      run: () => {
        const id = window.LiveTabs?.state?.activeId || 0;
        if (!id) { window.showToast?.('Рабочий стол нельзя закрыть'); return; }
        if (window.LiveTabs?.close) window.LiveTabs.close(id);
        else post({ type: 'close', id });
      },
    },
    {
      title: 'Открыть настройки',
      sub: 'Вид, браузер, загрузки, горячие клавиши',
      icon: ICONS.gear,
      keywords: 'settings preferences параметры',
      run: () => {
        const api = window.LiveSettingsPage || window.SettingsPage;
        if (api?.open) api.open();
        else R('settings-btn')?.click();
      },
    },
    {
      title: 'Загрузки',
      sub: 'Файлы, скачанные в этом запуске',
      icon: ICONS.download,
      keywords: 'downloads файлы скачанное',
      run: () => {
        if (window.LiveDownloads?.openPage) window.LiveDownloads.openPage();
        else R('downloads-btn')?.click();
      },
    },
    {
      title: 'Сменить тему',
      sub: 'Тёмная ↔ светлая',
      icon: ICONS.theme,
      keywords: 'theme dark light режим оформления',
      run: () => { window.LiveTheme?.toggleMode?.(); },
    },
    {
      title: 'Случайная палитра',
      sub: 'Другой акцент из набора',
      icon: ICONS.dice,
      keywords: 'random accent цвет randomPalette',
      run: randomPalette,
    },
    // ---- History (history.js): the "Недавнее" strip and closed postcards.
    // Every run() re-reads LiveRecent / the DOM, so the state shown in `sub`
    // is the one at open time (the palette rebuilds its rows each open).
    {
      title: 'История: очистить',
      sub: 'Удалить все записи из «Недавнего»',
      icon: ICONS.broom,
      keywords: 'history clear очистить историю удалить недавнее',
      run: () => {
        const api = window.LiveRecent;
        if (api?.clear) { api.clear(); return; }
        // Module not ready: go through the strip's own button.
        R('recent-clear')?.click();
      },
    },
    {
      title: 'Открыть недавнюю вкладку',
      sub: 'Список только что закрытых вкладок',
      icon: ICONS.restore,
      keywords: 'recent closed недавно закрытые вкладки restore вернуть reopen',
      run: () => {
        const api = window.LiveRecent;
        if (api?.openPop) {
          // The palette overlay is still "open" for a moment while it fades
          // out; opening the popover after it closes keeps the layers honest.
          setTimeout(() => api.openPop(), closeDelay());
          return;
        }
        R('recent-btn')?.click();
      },
    },
    {
      title: 'Копировать адрес текущей страницы',
      sub: 'Ссылка на сайт — в буфер обмена',
      icon: ICONS.copy,
      keywords: 'copy url адрес ссылка скопировать clipboard',
      run: () => {
        const url = activeUrl();
        if (!url) { window.showToast?.('На рабочем столе нет адреса'); return; }
        copyText(url).then((ok) => {
          window.showToast?.(ok ? 'Скопировано' : 'Не удалось скопировать');
        }).catch(() => window.showToast?.('Не удалось скопировать'));
      },
    },
    // The wording follows the strip's live state: the row is relabelled in
    // place when history.js reports a toggle, and once more on every open.
    {
      title: 'История: развернуть недавнее',
      sub: 'Последние страницы под плитками',
      icon: ICONS.clock,
      keywords: 'recent недавнее история свернуть развернуть закрыть показать скрыть',
      run: () => {
        const api = window.LiveRecent;
        if (api?.toggleStrip) { api.toggleStrip(); return; }
        R('recent-toggle')?.click();
      },
    },
  ];
  for (const a of actions) {
    a.kind = 'action';
    a.group = 'Команды';
    items.push(a);
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Fuzzy matching + <mark> highlighting                                */
/* ------------------------------------------------------------------ */

// Case-insensitive; a contiguous substring hit wins, a subsequence hit still
// matches (positions drive the highlight).  Returns null when `text` is not
// a match for `q`.
function findIn(text, q) {
  const hay = (text || '').toLowerCase();
  const needle = (q || '').toLowerCase();
  if (!hay || !needle) return null;
  const idx = hay.indexOf(needle);
  if (idx >= 0) {
    const positions = [];
    for (let i = 0; i < needle.length; i++) positions.push(idx + i);
    return { positions, direct: true, at: idx, gaps: 0 };
  }
  const positions = [];
  let prev = -1;
  let gaps = 0;
  for (let i = 0; i < hay.length && positions.length < needle.length; i++) {
    if (hay[i] === needle[positions.length]) {
      if (prev >= 0) gaps += i - prev - 1;
      positions.push(i);
      prev = i;
    }
  }
  if (positions.length < needle.length) return null;
  return { positions, direct: false, at: positions[0], gaps };
}

// Best field wins: a title hit outranks a subtitle hit, which outranks a
// hidden-keyword hit; direct hits outrank scattered ones.
function scoreItem(item, q) {
  let best = null;
  const tryField = (text, base) => {
    const m = findIn(text, q);
    if (!m) return;
    const s = m.direct
      ? base + 400 - Math.min(m.at, 200)
      : base + 150 - Math.min(m.gaps, 120);
    if (!best || s > best.s) best = { s, field: text, m };
  };
  tryField(item.title, 3000);
  tryField(item.sub, 2000);
  tryField(item.keywords, 1000);
  return best;
}

function applyFilter() {
  const q = (inputEl.value || '').trim();
  if (!q) {
    state.shown = state.items.slice();
  } else {
    const scored = [];
    for (const item of state.items) {
      const m = scoreItem(item, q);
      if (m) scored.push({ item, s: m.s, m });
    }
    // sort is stable: equal scores keep the tabs-first source order.
    scored.sort((a, b) => b.s - a.s);
    state.shown = scored.map((x) => {
      x.item._match = x.m;
      return x.item;
    });
  }
  state.active = state.shown.length ? 0 : -1;
}

// Writes `text` into `el`, wrapping the matched characters in <mark>.  Only
// the field that actually produced the match gets marks.
function fillHighlighted(el, text, match) {
  const positions = match && match.field === text ? new Set(match.m.positions) : null;
  if (!positions) {
    el.textContent = text;
    return;
  }
  el.textContent = '';
  let run = '';
  let runHit = positions.has(0);
  const flush = (hit) => {
    if (!run) return;
    if (hit) {
      const mk = document.createElement('mark');
      mk.textContent = run;
      el.appendChild(mk);
    } else {
      el.appendChild(document.createTextNode(run));
    }
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hit = positions.has(i);
    if (hit !== runHit) { flush(runHit); runHit = hit; }
    run += text[i];
  }
  flush(runHit);
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

function build() {
  if (state.built) return;
  const root = R('palette-root');
  if (!root) return;

  overlayEl = document.createElement('div');
  overlayEl.className = 'palette';
  overlayEl.id = 'palette-overlay';
  overlayEl.hidden = true;

  panelEl = document.createElement('div');
  panelEl.className = 'palette-panel';
  panelEl.id = 'palette-panel';
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'true');
  panelEl.setAttribute('aria-label', 'Палитра команд');

  const head = document.createElement('div');
  head.className = 'palette-head';
  const glyph = document.createElement('span');
  glyph.className = 'palette-glyph';
  glyph.innerHTML = ICONS.search;
  inputEl = document.createElement('input');
  inputEl.id = 'palette-input';
  inputEl.className = 'palette-input';
  inputEl.type = 'text';
  inputEl.placeholder = 'Команда или вкладка…';
  inputEl.spellcheck = false;
  inputEl.autocomplete = 'off';
  inputEl.setAttribute('role', 'combobox');
  inputEl.setAttribute('aria-expanded', 'false');
  inputEl.setAttribute('aria-controls', 'palette-list');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-label', 'Поиск команд и вкладок');
  const esc = document.createElement('kbd');
  esc.className = 'palette-esc';
  esc.textContent = 'esc';
  head.append(glyph, inputEl, esc);

  listEl = document.createElement('div');
  listEl.className = 'palette-list';
  listEl.id = 'palette-list';
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Действия и вкладки');

  emptyEl = document.createElement('div');
  emptyEl.className = 'palette-empty';
  emptyEl.id = 'palette-empty';
  emptyEl.hidden = true;
  emptyEl.textContent = 'Ничего не найдено';

  const foot = document.createElement('div');
  foot.className = 'palette-foot';
  foot.innerHTML =
    '<span><kbd>↑</kbd><kbd>↓</kbd> выбор</span>' +
    '<span><kbd>Enter</kbd> открыть</span>' +
    '<span><kbd>Shift</kbd>+<kbd>Enter</kbd> в новой вкладке</span>' +
    '<span><kbd>Esc</kbd> закрыть</span>';

  panelEl.append(head, listEl, emptyEl, foot);
  overlayEl.append(panelEl);
  root.append(overlayEl);

  // The dimmed backdrop closes; clicks inside the panel do not.
  overlayEl.addEventListener('pointerdown', (e) => {
    if (e.target === overlayEl) { e.preventDefault(); close(); }
  });
  inputEl.addEventListener('input', () => { applyFilter(); render(); });

  state.built = true;
}

function render() {
  listEl.replaceChildren();
  const q = (inputEl.value || '').trim();
  let lastGroup = null;
  state.shown.forEach((item, i) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      const g = document.createElement('div');
      g.className = 'palette-group';
      g.setAttribute('aria-hidden', 'true');
      g.textContent = item.group;
      listEl.appendChild(g);
    }

    const row = document.createElement('button');
    row.type = 'button';
    // Каскад строк (как у подсказок search.js): ступень 12мс, шапка ≤ 8
    // шагов — открытая палитра «дышит» списком, а не включается залпом.
    row.className = 'pal-row pal-row-in' + (i === state.active ? ' active' : '');
    row.style.animationDelay = `${Math.min(i, 8) * 12}ms`;
    row.id = `pr-${i}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === state.active ? 'true' : 'false');

    const ic = document.createElement('span');
    ic.className = 'pr-icon';
    if (item.favicon) {
      const img = document.createElement('img');
      img.className = 'pr-fav';
      img.alt = '';
      img.draggable = false;
      img.src = item.favicon;
      img.addEventListener('error', () => { ic.innerHTML = item.icon || ICONS.globe; });
      ic.appendChild(img);
    } else {
      ic.innerHTML = item.icon || ICONS.globe;
    }

    const body = document.createElement('span');
    body.className = 'pr-body';
    const title = document.createElement('span');
    title.className = 'pr-title';
    fillHighlighted(title, item.title, q ? item._match : null);
    const sub = document.createElement('span');
    sub.className = 'pr-sub';
    fillHighlighted(sub, item.sub, q ? item._match : null);
    body.append(title, sub);

    row.append(ic, body);

    if (item.badge) {
      const b = document.createElement('span');
      b.className = 'pr-badge';
      b.textContent = item.badge;
      row.appendChild(b);
    }

    row.addEventListener('click', () => { state.active = i; runActive(false); });
    // Hover follows the mouse like in search.js's panel: it moves the
    // keyboard highlight, so there is exactly one active row at all times.
    row.addEventListener('pointerenter', () => setActive(i, false));
    listEl.appendChild(row);
  });
  emptyEl.hidden = state.shown.length > 0;
  listEl.hidden = state.shown.length === 0;
  syncActiveDesc();
}

/* ------------------------------------------------------------------ */
/* Active row + scrolling                                              */
/* ------------------------------------------------------------------ */

function syncActiveDesc() {
  const row = listEl.querySelector('.pal-row.active');
  if (state.active >= 0 && row) {
    inputEl.setAttribute('aria-activedescendant', row.id);
    inputEl.setAttribute('aria-expanded', 'true');
  } else {
    inputEl.removeAttribute('aria-activedescendant');
  }
}

function setActive(i, reveal) {
  if (i < 0 || i >= state.shown.length) return;
  state.active = i;
  const rows = listEl.querySelectorAll('.pal-row');
  rows.forEach((row, j) => {
    row.classList.toggle('active', j === i);
    row.setAttribute('aria-selected', j === i ? 'true' : 'false');
  });
  syncActiveDesc();
  if (reveal && rows[i]) revealRow(rows[i]);
}

// Keeps the highlighted row inside the list; smooth when motion is welcome.
function revealRow(row) {
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  const behavior = motionOk() ? 'smooth' : 'auto';
  if (top < listEl.scrollTop) {
    listEl.scrollTo({ top: Math.max(0, top - 6), behavior });
  } else if (bottom > listEl.scrollTop + listEl.clientHeight) {
    listEl.scrollTo({ top: bottom - listEl.clientHeight + 6, behavior });
  }
}

function step(delta) {
  const n = state.shown.length;
  if (!n) return;
  let next = state.active + delta;
  if (next < 0) next = n - 1;
  if (next >= n) next = 0;
  setActive(next, true);
}

/* ------------------------------------------------------------------ */
/* Run + open/close                                                    */
/* ------------------------------------------------------------------ */

function runActive(shift) {
  const row = state.shown[state.active];
  if (!row) return;
  close();
  // Shift+Enter on a URL row means "in a new tab": the host opens it, the
  // palette still closes.  Every other action runs and closes as usual.
  // close() goes first so commands that stack another layer (the recent-tabs
  // popover) never start it under a fading modal overlay.
  if (shift && row.url) post({ type: 'open', url: row.url, label: row.title || '' });
  else row.run(shift);
}

function open() {
  build();
  if (!state.built || state.open) return;
  // The suggestion panel and the gear menu share native host layers with
  // the palette's stretched ui view — they step aside first.
  window.LiveSearch?.hide?.();
  window.LiveUi?.closeSearchMenu?.();

  state.items = buildItems();
  applyFilter(); // keeps the previous query: like Raycast, the search survives
  render();
  // Реестр поповеров: палитра — модальный слой, другие всплывашки уходят.
  window.LivePops?.open('palette', () => window.LivePalette?.close());
  state.open = true;
  // Открытие во время излёта (закрыли и тут же Ctrl+K): сбрасываем класс,
  // чтобы не остался «мёртвый» .lb-exit и не играл оборванная анимация.
  overlayEl.classList.remove('lb-exit');
  overlayEl.hidden = false;
  // Next frame so the 0.96 -> 1 transition always plays from the hidden state.
  requestAnimationFrame(() => { if (state.open) overlayEl.classList.add('open'); });
  sendOverlay(true);
  inputEl.focus();
  inputEl.select();
}

function close() {
  if (!state.open) return;
  window.LivePops?.close('palette');
  state.open = false;
  overlayEl.classList.remove('open');
  inputEl.blur();
  sendOverlay(false);
  // Реестр/фокус/оверлей уже погашены выше — теперь только визуальный излёт
  // (.lb-exit, 140 мс) и отложенный hidden.  hide() проверяет !state.open:
  // если палитру открыли заново до конца излёта, done не погасит её.
  exitThenHide(overlayEl, () => { if (!state.open) overlayEl.hidden = true; });
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

// Window capture: beats every other shell handler (tabs.js's bubble
// listener, the omnibox input, the settings Escape handlers on document),
// so Ctrl+K and the palette's own keys never leak into the layers below.
function onWindowKeyDown(e) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyK') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (state.open) close(); else open();
    return;
  }
  if (!state.open) return;
  // Escape closes only the palette — a settings page underneath stays open.
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
    return;
  }
  if (!panelEl.contains(e.target)) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopImmediatePropagation();
    step(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopImmediatePropagation();
    runActive(e.shiftKey);
  } else if (e.key === 'Tab') {
    // The palette is modal: Tab must not walk focus into the bar beneath.
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/* ------------------------------------------------------------------ */
/* Host pushes (second listener — app.js owns the first)               */
/* ------------------------------------------------------------------ */

if (window.chrome?.webview?.addEventListener) {
  window.chrome.webview.addEventListener('message', (e) => {
    const msg = e && e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'palette') {
      // Ctrl+K forwarded from a site tab.  Already open = just refocus.
      if (state.open) { inputEl.focus(); inputEl.select(); }
      else open();
    } else if (msg.type === 'tabs' && state.open) {
      // Tab rows stay live while the palette is visible.
      state.items = buildItems();
      applyFilter();
      if (state.active >= state.shown.length) state.active = state.shown.length - 1;
      if (state.active < 0 && state.shown.length) state.active = 0;
      render();
    }
  });
}

// A tiny API for probes and future callers; nothing else in the shell
// depends on it.
window.LivePalette = {
  open,
  close,
  toggle: () => { if (state.open) close(); else open(); },
  isOpen: () => state.open,
};

window.addEventListener('keydown', onWindowKeyDown, true);

})();
