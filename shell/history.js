// LiveBrowser "what I have seen": two history surfaces that the rest of the
// shell does not own.
//
//   1. #recent-bar — a collapsible strip under the quick-link tiles on the
//      desktop: the last pages from GET /api/history, glass cards in one
//      horizontally scrolling row, plus "N записей · Очистить".
//   2. #recent-btn + #recent-pop — the "recently closed tabs" postcard stack
//      in the bar.  The host keeps only its own lastClosed record (used by
//      {type:"reopen"}); this module keeps a local top-8 diffed from every
//      {"type":"tabs"} push, so a closed tab can be brought back from a list.
//
// Boundaries: app.js/tabs.js/search.js/settings.js/downloads.js are NOT
// modified.  This module only reads LiveTabs.state (the strip mirror) and
// calls window.showToast / window.LiveTabs.open, and it posts the two
// messages the host already understands (open/activate) — see PROGRESS.md,
// "Мост UI <-> C#".  Data from the web (url, title) never goes through
// innerHTML: every node is built with createElement/textContent.
'use strict';

(function () {

const R = (id) => document.getElementById(id);

// The host serves its API on a sibling virtual host, like /api/suggest
// (search.js) and /api/settings (settings.js).
const API = 'https://api.livebrowser.shell/api/history';

const STORE_RECENT_OPEN = 'lb.recentOpen';
const STORE_CLOSED = 'lb.closedTabs';
const CLOSED_MAX = 8;       // postcards kept in lb.closedTabs
const STRIP_LIMIT = 12;     // /api/history?limit= — one row of cards

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function post(msg) {
  try {
    if (window.chrome?.webview) window.chrome.webview.postMessage(JSON.stringify(msg));
  } catch { /* host gone */ }
}

function motionOk() {
  return !document.body.classList.contains('no-anim')
    && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Анимированное скрытие поповера (app.css .lb-exit): логическое состояние
// гаснет сразу (в closePop выше), DOM прячется после 140-мс излёта.
// Гварды: no-anim / tactile-off / prefers-reduced-motion — мгновенно.
// hide() проверяет !pop.open — устаревший done (страховочный таймер или
// animationend после повторного открытия) не погасит заново открытый поповер.
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

// Пустое состояние («Здесь появятся вкладки…» / «Пока ничего нет») получает
// мягкий поздний fade-in (.lb-empty-in), но только когда узел показывается
// заново, а не при каждой перерисовке.  Один раз проигранная анимация
// снимается классом — при следующем пустом рендере переиграется.
function flashEmptyIn(el, show) {
  if (!el) return;
  if (!show) { el.classList.remove('lb-empty-in'); return; }
  if (!el.hidden) return; // уже виден — это не «свежий» показ
  el.classList.remove('lb-empty-in');
  if (!motionOk()) return;
  void el.offsetWidth; // reflow: перезапустить анимацию, если класс был
  el.classList.add('lb-empty-in');
}

// Over a site tab the shell cannot paint below the bar (same check as
// search.js/menu.js): popovers go to the host's native layer instead.
function overSite() {
  return document.body.classList.contains('site-active') && !!window.chrome?.webview;
}

function storeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private */ }
}

// Bare hostname for display ("https://www.a.ru/x" -> "a.ru"), '' for garbage.
function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Deterministic accent per domain, the way tabs.js colours favicon-less
// tabs: the same site keeps the same hue across the strip and the cards.
// FNV-1a over the hostname -> hue; two tones (chroma/lightness) are kept
// inside the theme's range so both dark and light glass stay readable.
function accFor(key) {
  const s = String(key || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = h % 360;
  // Chroma and lightness chosen to sit at ~4.5:1 against white text.
  return `hsl(${hue} 62% 46%)`;
}

function letterFor(url, title) {
  const host = hostOf(url);
  const letter = (host.charAt(0) || String(title || '').charAt(0) || '•').toUpperCase();
  return /[A-ZА-ЯЁ0-9]/i.test(letter) ? letter : '•';
}

// "сегодня 02:14" / "вчера 23:40" / "14 ноя" (this year) / "14 ноя 2025".
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function clockOf(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// `t` may be seconds or milliseconds (the host is not decided yet); anything
// under 1e12 is read as unix seconds.
function stampOf(t) {
  const n = Number(t) || 0;
  return n > 0 && n < 1e12 ? n * 1000 : n;
}

function timeLabel(t, now) {
  const ms = stampOf(t);
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = 86400000;
  if (ms >= startToday) return `сегодня ${clockOf(d)}`;
  if (ms >= startToday - day) return `вчера ${clockOf(d)}`;
  const md = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? md : `${md} ${d.getFullYear()}`;
}

/* ------------------------------------------------------------------ */
/* Part 1 — the "Недавнее" strip on the desktop                        */
/* ------------------------------------------------------------------ */

const strip = {
  built: false,
  open: false,      // mirrors body class `recent-open`
  loading: false,
  items: [],        // { t, url, title } as returned by the host
  loadSeq: 0,       // guards a slow fetch against a newer one
  emptyShown: false, // статус «Пока ничего нет» уже на экране (для fade-in)
};

function initRecentStrip() {
  if (strip.built) return;
  // The section itself is the strip (there is no inner wrapper): its id is
  // what R() finds, and cards land in #recent-row.
  const host = R('recent-bar');
  if (!host) return;
  strip.built = true;

  strip.open = storeGet(STORE_RECENT_OPEN, false) === true;
  document.body.classList.add('recent-host');
  document.body.classList.toggle('recent-open', strip.open);

  R('recent-toggle')?.addEventListener('click', () => toggleRecent());
  R('recent-clear')?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearRecent();
  });

  // A click on the header row (but not on its button, which the handler
  // above already owns) toggles as well — the whole bar is the target.
  R('recent-head')?.addEventListener('click', (e) => {
    if (e.target.closest('#recent-toggle, #recent-clear')) return;
    toggleRecent();
  });

  // Track scrolling, so the row can fade its edges only when there is
  // actually something hidden past them.
  const row = R('recent-row');
  row?.addEventListener('scroll', () => stripEdgeHint(), { passive: true });

  // A card opened from the strip: left or middle click, both open it.
  row?.addEventListener('click', (e) => {
    const card = e.target.closest('.rc-card');
    if (!card) return;
    e.preventDefault();
    openFromCard(card);
  });
  row?.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const card = e.target.closest('.rc-card');
    if (!card) return;
    e.preventDefault();
    openFromCard(card);
  });

  if (strip.open) loadRecent();
}

function toggleRecent() {
  strip.open = !strip.open;
  document.body.classList.toggle('recent-open', strip.open);
  storeSet(STORE_RECENT_OPEN, strip.open);
  syncRecentToggleLabel();
  window.dispatchEvent(new CustomEvent('lb:recent-strip', { detail: { open: strip.open } }));
  if (strip.open) loadRecent();
}

// Label + arrow for the header button and the palette command.
function syncRecentToggleLabel() {
  const btn = R('recent-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', strip.open ? 'true' : 'false');
    btn.title = strip.open ? 'Свернуть недавнее' : 'Развернуть недавнее';
    btn.setAttribute('aria-label', btn.title);
  }
  const bar = R('recent-bar');
  if (bar) bar.setAttribute('aria-expanded', strip.open ? 'true' : 'false');
}

function openFromCard(card) {
  const url = card.dataset.url || '';
  if (!url) return;
  const title = card.dataset.title || url;
  post({ type: 'open', url, label: title });
}

// GET /api/history?limit=12 — graceful: any failure is an empty list.
async function fetchHistory(limit) {
  if (!window.chrome?.webview) return [];
  const url = `${API}?limit=${Number(limit) || STRIP_LIMIT}`;
  const data = await fetch(url, {
    credentials: 'omit',
    signal: AbortSignal.timeout(4000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .filter((it) => it && typeof it.url === 'string' && it.url)
    .map((it) => ({
      t: Number(it.t) || 0,
      url: it.url,
      title: typeof it.title === 'string' && it.title ? it.title : it.url,
    }));
}

async function loadRecent() {
  const seq = ++strip.loadSeq;
  strip.loading = true;
  // Keep the old cards on screen while the new list arrives: the strip
  // never blinks empty on a refresh.
  setRecentStatus('Загружаю…');
  const items = await fetchHistory(STRIP_LIMIT);
  if (seq !== strip.loadSeq) return; // a newer load won
  strip.loading = false;
  strip.items = items;
  renderRecent();
}

function makeCard(item, now) {
  const host = hostOf(item.url);
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'rc-card';
  card.dataset.url = item.url;
  card.dataset.title = item.title;
  card.title = `${item.title}\n${item.url}`;
  card.style.setProperty('--rc-accent', accFor(host || item.url));

  const top = document.createElement('span');
  top.className = 'rc-top';
  const dot = document.createElement('span');
  dot.className = 'rc-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = letterFor(item.url, item.title);
  const dom = document.createElement('span');
  dom.className = 'rc-dom';
  dom.textContent = host || item.url;   // textContent only: titles/urls are web data
  top.append(dot, dom);

  const name = document.createElement('span');
  name.className = 'rc-title';
  name.textContent = item.title;

  const foot = document.createElement('span');
  foot.className = 'rc-time';
  foot.textContent = timeLabel(item.t, now);

  card.append(top, name, foot);
  return card;
}

function renderRecent() {
  const row = R('recent-row');
  if (!row) return;
  row.replaceChildren();
  const now = Date.now();
  for (const item of strip.items) row.appendChild(makeCard(item, now));
  const emptyNow = strip.items.length === 0;
  document.body.classList.toggle('recent-empty', emptyNow);
  // The footer line under the row: "N записей · Очистить".
  const status = emptyNow
    ? 'Пока ничего нет'
    : `${strip.items.length} ${plural(strip.items.length, 'запись', 'записи', 'записей')}`;
  setRecentStatus(status);
  // Свежее пустое состояние стрипа: статусная строка мягко выплывает
  // (.lb-empty-in), но не мигает на каждом обновлении счётчика.
  const line = R('recent-count-line');
  if (line) {
    if (emptyNow && !strip.emptyShown) {
      line.classList.remove('lb-empty-in');
      if (motionOk()) {
        void line.offsetWidth; // reflow: переиграть, если класс уже был
        line.classList.add('lb-empty-in');
      }
    } else if (!emptyNow) {
      line.classList.remove('lb-empty-in');
    }
  }
  strip.emptyShown = emptyNow;
  stripEdgeHint();
  // A fresh list animates in (the cards cascade a few ms apart).
  if (motionOk()) {
    const cards = row.querySelectorAll('.rc-card');
    cards.forEach((c, i) => {
      if (i >= 12) return;
      c.style.setProperty('--rc-delay', `${i * 18}ms`);
      c.classList.add('rc-in');
      c.addEventListener('animationend', () => {
        c.classList.remove('rc-in');
        c.style.removeProperty('--rc-delay');
      }, { once: true });
    });
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function setRecentStatus(text) {
  const el = R('recent-count-line');
  if (el) el.textContent = text;
}

// Edge fade: the row is a scroller, so the right fade appears only when the
// last card is cut off, the left one only after scrolling away from the start.
function stripEdgeHint() {
  const row = R('recent-row');
  const bar = R('recent-bar');
  if (!row || !bar) return;
  const max = row.scrollWidth - row.clientWidth;
  bar.classList.toggle('rc-scrolled', row.scrollLeft > 4);
  bar.classList.toggle('rc-more', max > 4 && row.scrollLeft < max - 4);
}

async function clearRecent() {
  // The strip's «Очистить» clears the history list; the recently-closed
  // postcards are a separate list and must go too, or the «Ещё» badge keeps
  // counting tabs whose history was just wiped.
  closedList = [];
  saveClosed();
  if (pop.open) renderPop();
  syncRecentButtonState();
  const btn = R('recent-clear');
  if (btn) btn.disabled = true;
  try {
    await fetch(`${API}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'omit',
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* old host build without the endpoint: still clear the view */ }
  strip.items = [];
  renderRecent();
  setRecentStatus('Очищено');
  if (btn) btn.disabled = false;
  window.showToast?.('История очищена');
  if (strip.open) loadRecent();
}

/* ------------------------------------------------------------------ */
/* Part 2 — "recently closed" postcards (local diff of tab pushes)     */
/* ------------------------------------------------------------------ */

// {"url", "title", "ts"} newest last.  Persisted, so closing the window does
// not forget the last eight pages you shut.
let closedList = [];

const pop = {
  built: false,
  open: false,
};
// Over a site tab the shell is clipped to the bar, so the popover itself
// cannot be painted: the same rows go to the native layer (panelView) as a
// generic items menu (LiveMenu.showNativeItems).  This flag mirrors pop.open
// for that mode, so toggling/Esc/outside-clicks keep working.
let popNativeOpen = false;

function loadClosed() {
  const raw = storeGet(STORE_CLOSED, []);
  if (!Array.isArray(raw)) { closedList = []; return; }
  closedList = raw
    .filter((c) => c && typeof c.url === 'string' && c.url)
    .map((c) => ({ url: c.url, title: typeof c.title === 'string' ? c.title : c.url, ts: Number(c.ts) || 0 }))
    .slice(-CLOSED_MAX);
}

function saveClosed() {
  storeSet(STORE_CLOSED, closedList.slice(-CLOSED_MAX));
}

// Called from the second 'message' listener below with every tabs push.
// An id that was present and is gone now = a tab that just closed; its url
// and title were still in the previous push.  The home tab (id 0) is
// permanent and never counts.
let prevTabIds = null;
let prevTabMap = new Map();

function trackClosed(msg) {
  if (!msg || !Array.isArray(msg.tabs)) return;
  const now = new Map();
  for (const t of msg.tabs) {
    const id = Number(t.id) || 0;
    if (id !== 0) now.set(id, { url: t.url || '', title: t.title || '' });
  }
  if (prevTabIds) {
    let changed = false;
    for (const [id, info] of prevTabMap) {
      if (now.has(id) || !info.url) continue;
      // A tab loading its first page may have an empty title: fall back to
      // the hostname so the row is still something you can recognise.
      closedList.push({
        url: info.url,
        title: info.title || hostOf(info.url) || info.url,
        ts: Date.now(),
      });
      changed = true;
    }
    if (changed) {
      // Dedupe by url: a page closed twice keeps its newest position, and it
      // is therefore already first in the popover.
      const seen = new Set();
      closedList = closedList
        .filter((c) => {
          if (seen.has(c.url)) return false;
          seen.add(c.url);
          return true;
        })
        .slice(-CLOSED_MAX);
      saveClosed();
      if (pop.open) renderPop();
      // Native menu over a site: re-send the fresh list in place.
      if (popNativeOpen) {
        window.LiveMenu?.showNativeItems?.(nativePopItems(), R('more-btn')?.getBoundingClientRect() || null);
      }
      syncRecentButtonState();
    }
  }
  prevTabIds = new Set(now.keys());
  prevTabMap = now;
}

function syncRecentButtonState() {
  const btn = R('recent-btn');
  if (!btn) return;
  const n = closedList.length;
  btn.classList.toggle('has-closed', n > 0);
  btn.title = n ? `Недавно закрытые (${n})` : 'Недавно закрытые';
  btn.setAttribute('aria-label', btn.title);
  const badge = R('recent-count');
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = String(n);
  }
}

function initRecentPop() {
  const btn = R('recent-btn');
  const outside = (e) => {
    if (!pop.open && !popNativeOpen) return;
    if (pop.el?.contains(e.target) || btn?.contains(e.target)) return;
    closePop();
  };
  btn?.addEventListener('click', () => togglePop());
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', (e) => {
    if (!pop.open && !popNativeOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePop();
      btn?.focus();
    }
  }, true);
  // Window resize/zoom can move the button: re-align while open.
  window.addEventListener('resize', () => { if (pop.open) placePop(); }, { passive: true });
  // The palette (z 85) and the fullscreen pages sit over this popover:
  // never leave it stranded under/over one of them.
  window.addEventListener('lb:palette-open', closePop);
  const mo = new MutationObserver(() => {
    // On a site tab the shell is clipped to the bar (CSS hides the popover);
    // close it so returning to the desktop does not resurrect it.
    if (document.body.classList.contains('site-active')) closePop();
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // settings-page / downloads-page are stretched over the site by the host's
  // overlay channel and rendered by this same page — a fixed popover would
  // land on top of them, so it steps aside.
  for (const id of ['settings-page', 'downloads-page']) {
    const el = R(id);
    if (!el) continue;
    new MutationObserver(() => { if (el.hidden === false) closePop(); })
      .observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }
}

function buildPop() {
  if (pop.built) return;
  const root = R('recent-pop');
  if (!root) return;
  pop.built = true;
  pop.el = root;

  const head = document.createElement('div');
  head.className = 'rp-head';
  const title = document.createElement('span');
  title.className = 'rp-title';
  title.textContent = 'Недавно закрытые';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.id = 'recent-restore-all';
  restore.className = 'rp-restore';
  restore.textContent = 'Восстановить все';
  restore.addEventListener('click', (e) => {
    e.stopPropagation();
    restoreAll();
  });
  head.append(title, restore);

  const list = document.createElement('div');
  list.className = 'rp-list';
  list.id = 'recent-pop-list';
  list.setAttribute('role', 'list');

  const empty = document.createElement('div');
  empty.className = 'rp-empty';
  empty.id = 'recent-pop-empty';
  empty.hidden = true; // первый рендер renderPop честно считает «свежим»
  empty.textContent = 'Здесь появятся вкладки, которые ты закроешь.';

  const foot = document.createElement('div');
  foot.className = 'rp-foot';
  foot.textContent = 'Средний клик — убрать из списка · Esc — закрыть';

  root.append(head, list, empty, foot);

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.rp-row');
    if (!row) return;
    const url = row.dataset.url || '';
    if (!url) return;
    post({ type: 'open', url, label: row.dataset.title || url });
    closePop();
  });
  // Middle click removes the row (a postcard you do not want anymore).
  list.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const row = e.target.closest('.rp-row');
    if (!row) return;
    e.preventDefault();
    removeClosed(row.dataset.url || '');
  });
  // Kill the native autoscroll / selection dance for the middle button.
  list.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
}

function renderPop() {
  const list = R('recent-pop-list');
  if (!list) return;
  list.replaceChildren();
  const now = Date.now();
  // Newest first: the one you just closed is the first postcard.
  for (const item of [...closedList].reverse()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rp-row';
    row.setAttribute('role', 'listitem');
    row.dataset.url = item.url;
    row.dataset.title = item.title;
    row.title = `${item.title}\n${item.url}`;

    const dot = document.createElement('span');
    dot.className = 'rp-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.background = accFor(hostOf(item.url) || item.url);
    dot.textContent = letterFor(item.url, item.title);

    const body = document.createElement('span');
    body.className = 'rp-body';
    const name = document.createElement('span');
    name.className = 'rp-name';
    name.textContent = item.title;
    const sub = document.createElement('span');
    sub.className = 'rp-sub';
    sub.textContent = `${hostOf(item.url) || item.url} · ${timeLabel(item.ts, now)}`;
    body.append(name, sub);

    row.append(dot, body);
    list.appendChild(row);
  }
  const empty = R('recent-pop-empty');
  if (empty) {
    const showEmpty = closedList.length === 0;
    flashEmptyIn(empty, showEmpty); // мягкий fade-in только для свежего показа
    empty.hidden = showEmpty;
  }
  const all = R('recent-restore-all');
  if (all) all.disabled = closedList.length === 0;
  pop.el?.classList.toggle('has-items', closedList.length > 0);
}

function removeClosed(url) {
  if (!url) return;
  closedList = closedList.filter((c) => c.url !== url);
  saveClosed();
  renderPop();
  syncRecentButtonState();
}

function restoreAll() {
  if (!closedList.length) return;
  // Oldest first, so the final stack reads in the order they were closed
  // (the host stacks new tabs to the right like every browser).
  const stash = closedList.slice();
  closedList = [];
  saveClosed();
  renderPop();
  syncRecentButtonState();
  for (const item of stash) post({ type: 'open', url: item.url, label: item.title });
  closePop();
  window.showToast?.(`Возвращаю ${stash.length} ${plural(stash.length, 'вкладку', 'вкладки', 'вкладок')}…`);
}

// One row of the native items menu: the same post({type:"open"}) the local
// .rp-row click does, and the popover goes away with it (runItem has already
// dropped the layer; closePop only resets popNativeOpen).
function restoreClosed(item) {
  if (!item || !item.url) return;
  post({ type: 'open', url: item.url, label: item.title || item.url });
  closePop();
}

// The popover as generic menu items: header (disabled), one row per closed
// tab (titles capped, the .lb-menu-item ellipsis trims the rest), then
// restore-all and clear — the same actions the local popover's buttons run.
function nativePopItems() {
  const trunc = (s) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
  const rows = [...closedList].reverse().map((item) => ({
    label: trunc(item.title || item.url),
    action: () => restoreClosed(item),
  }));
  return [
    { label: 'Недавно закрытые', disabled: true },
    { sep: true },
    ...rows,
    { sep: true },
    { label: 'Восстановить всё', action: restoreAll, disabled: closedList.length === 0 },
    { label: 'Очистить', danger: true, action: () => { closePop(); clearRecent(); } },
  ];
}

function placePop() {
  // The popover is opened from the bar's «Ещё» menu now: anchor to whichever
  // button is actually visible (the old #recent-btn is a zero-size anchor).
  const anchor = (() => {
    const a = R('more-btn');
    const b = R('recent-btn');
    if (a && a.offsetWidth > 0) return a;
    return b || a;
  })();
  const btn = anchor;
  if (!btn || !pop.el) return;
  const rect = btn.getBoundingClientRect();
  const width = pop.el.offsetWidth || 300;
  // Right-aligned under the button, clamped to the window.
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  pop.el.style.left = `${Math.round(left)}px`;
  pop.el.style.top = `${Math.round(rect.bottom + 8)}px`;
}

function openPop() {
  // Popover над сайтом рисует нативный слой через LiveMenu (menu.js ленивый):
  // сначала греем модуль, а если он ещё не готов — повторяем открытие после
  // загрузки.  Клик не должен «пропадать».
  if (overSite() && !window.LiveMenu) {
    window.LiveModules?.load('menu')
      .then(() => { if (!pop.open && !popNativeOpen) openPop(); })
      .catch(() => { });
    return;
  }
  buildPop();
  if (!pop.built || pop.open || popNativeOpen) return;
  // One layer at a time: the suggest panel, the gear menu, the burger menu
  // and a full settings page all own screen space over this popover.
  window.LiveSearch?.hide?.();
  window.LiveUi?.closeSearchMenu?.();
  window.LiveMenu?.close?.();
  // Over a site the rows are painted by the native layer (panelView), not
  // by this page: hand them over with the anchor button as the rect.
  if (overSite()) {
    const anchor = (() => {
      const a = R('more-btn');
      if (a && a.offsetWidth > 0) return a;
      return R('recent-btn') || a;
    })();
    const rect = anchor ? anchor.getBoundingClientRect() : null;
    if (window.LiveMenu?.showNativeItems?.(nativePopItems(), rect)) {
      popNativeOpen = true;
      R('recent-btn')?.setAttribute('aria-expanded', 'true');
    }
    return;
  }
  // Реестр поповеров: открытие стрипа гасит палитру/подсказки/меню.
  window.LivePops?.open('recent', closePop);
  renderPop();
  pop.open = true;
  // Открытие во время излёта: снимаем .lb-exit до показа, чтобы не остался
  // «мёртвый» класс и не играл оборванная анимация (done() при этом уже
  // ничего не сломает — его hide() проверяет !pop.open).
  pop.el.classList.remove('lb-exit');
  pop.el.hidden = false;
  placePop();
  R('recent-btn')?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    if (!pop.open) return;
    placePop();               // real width is only known once laid out
    pop.el.classList.add('open');
  });
}

function closePop() {
  if (!pop.open && !popNativeOpen) return;
  window.LivePops?.close('recent');
  // Native mode: drop the items menu through the same LiveMenu channel.
  if (popNativeOpen) {
    popNativeOpen = false;
    window.LiveMenu?.close?.();
    R('recent-btn')?.setAttribute('aria-expanded', 'false');
    return;
  }
  pop.open = false;
  pop.el?.classList.remove('open');
  R('recent-btn')?.setAttribute('aria-expanded', 'false');
  // Реестр/aria уже погашены выше — теперь визуальный излёт (.lb-exit,
  // 140 мс) и отложенный hidden.  hide() проверяет !pop.open: повторное
  // открытие до конца излёта не даст устаревшему done() погасить поповер.
  const el = pop.el;
  exitThenHide(el, () => { if (!pop.open && el) el.hidden = true; });
}

function togglePop() {
  if (pop.open || popNativeOpen) closePop(); else openPop();
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

// One extra 'message' listener (app.js keeps its own): only tabs pushes are
// consumed here, for the closed-tab diff.
if (window.chrome?.webview?.addEventListener) {
  window.chrome.webview.addEventListener('message', (e) => {
    const msg = e && e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'tabs') trackClosed(msg);
  });
}

function boot() {
  loadClosed();
  initRecentStrip();
  initRecentPop();
  syncRecentButtonState();
  syncRecentToggleLabel();
  // Seed the diff with whatever the host has already pushed, so a tab that
  // was open before this module initialised is not counted as "closed".
  const st = window.LiveTabs?.state;
  if (st && Array.isArray(st.tabs) && !prevTabIds) {
    const m = new Map();
    for (const t of st.tabs) {
      const id = Number(t.id) || 0;
      if (id !== 0) m.set(id, { url: t.url || '', title: t.title || '' });
    }
    prevTabIds = new Set(m.keys());
    prevTabMap = m;
  }
  // The palette command "Открыть недавнюю вкладку" drives this popover.
  window.LiveRecent = {
    toggle: togglePop,
    openPop,
    closePop,
    isOpen: () => pop.open || popNativeOpen,
    isStripOpen: () => strip.open,
    toggleStrip: toggleRecent,
    clear: clearRecent,
    closed: () => closedList.slice(),
    refreshStrip: loadRecent,
    removeClosed,
  };
  window.dispatchEvent(new CustomEvent('lb:recent-ready'));
}

document.addEventListener('DOMContentLoaded', boot);

})();

/* ------------------------------------------------------------------ */
/* Параллакс стрипа «Недавнее»: лента слегка следит за курсором        */
/* ------------------------------------------------------------------ */
/* «Следить за мышкой», дешевле одного rAF: pointermove копит цель,
   цикл лерпит translateX внутреннего ряда (НЕ скролл-обёртки — скролл
   не трогаем).  Полный парк: reduced-motion, no-anim, ряд переполнен
   (тогда полосой управляет скролл) или стрип закрыт. */
  (function () {
    const row = document.querySelector('.recent-bar .rc-row');
    if (!row) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, target = 0, cur = 0, active = false;

    const idle = () => reduced.matches || document.body.classList.contains('no-anim');
    const fits = () => row.scrollWidth <= row.clientWidth + 1;
    const visible = () => document.body.classList.contains('recent-open');

    function frame() {
      raf = 0;
      cur += (target - cur) * 0.08;
      if (Math.abs(target - cur) < 0.05) { cur = target; row.style.transform = ''; return; }
      row.style.transform = `translateX(${cur.toFixed(2)}px)`;
      raf = requestAnimationFrame(frame);
    }
    function wake() { if (!raf && !idle() && fits() && visible()) raf = requestAnimationFrame(frame); }
    function park() { target = 0; wake(); }

    document.addEventListener('pointermove', (e) => {
      if (idle() || !fits() || !visible()) { if (target !== 0) park(); return; }
      const half = window.innerWidth / 2;
      target = ((e.clientX - half) / half) * -10; // лента противоходом, ±10px
      wake();
    }, { passive: true });
    document.addEventListener('pointerleave', park, { passive: true });
    window.addEventListener('blur', park);
    document.body.addEventListener('transitionend', (e) => {
      if (e.target === document.querySelector('.rc-body') && !visible()) park();
    }, { passive: true });
  })();
