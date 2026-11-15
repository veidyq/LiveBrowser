// LiveBrowser omnibox: Yandex search engine, live suggestions, and the
// page transition.  Replaces app.js's default `navigate` so every path
// (Enter, suggestion click, quick links) goes through one ripple overlay.
'use strict';

// Top-level names stay inside this file: the shell loads four plain scripts
// into one global scope, so an IIFE prevents `const` redeclaration crashes.
(function () {

/* ------------------------------------------------------------------ */
/* Search engines                                                      */
/* ------------------------------------------------------------------ */

// Поисковик выбирается на welcome-экране и в настройках (settings.json ->
// "search").  Подсказки работают только у Яндекса (хост-релей /api/suggest);
// у остальных движков панель подсказок просто не открывается, Enter ищет.
const ENGINES = {
  yandex: {
    label: 'Яндекс', dot: 'Я',
    search: (q) => `https://yandex.ru/search/?text=${encodeURIComponent(q)}`,
    suggest: true,
  },
  google: {
    label: 'Google', dot: 'G',
    search: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    suggest: false,
  },
  duckduckgo: {
    label: 'DuckDuckGo', dot: 'D',
    search: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    suggest: false,
  },
};
let engine = 'yandex';

function syncEngineUi() {
  const e = ENGINES[engine] || ENGINES.yandex;
  const dot = document.querySelector('.engine-badge .engine-dot');
  if (dot) dot.textContent = e.dot;
  const badge = document.querySelector('.engine-badge');
  if (badge) badge.setAttribute('aria-label', `Поиск в ${e.label}`);
  const input = document.getElementById('search');
  if (input) input.placeholder = `Найти в ${e.label} или ввести адрес…`;
}

// Точка интеграции: welcome.js и settings.js переключают движок здесь.
window.LiveSearchEngine = {
  get: () => engine,
  set(name) {
    if (!ENGINES[name] || name === engine) return;
    engine = name;
    syncEngineUi();
  },
  ENGINES,
};

// Стартовое значение — из сохранённых настроек (независимо от settings.js).
fetch('https://api.livebrowser.shell/api/settings', { credentials: 'omit' })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => { if (s && s.search) window.LiveSearchEngine.set(s.search); })
  .catch(() => { /* без хоста — Яндекс по умолчанию */ });

// Yandex's suggest endpoint sends no CORS headers, so the host relays it on
// a sibling host of this page (/api/suggest).  Without the host the fetch fails
// and suggestions stay off.
const SUGGEST_API = 'https://api.livebrowser.shell/api/suggest';

const sEl = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Yandex suggestions                                                  */
/* ------------------------------------------------------------------ */

// Returns the suggestion strings for a query.  Accepts both the raw Yandex
// array (["q", ["s1", ...], ...]) and a bare list of strings.
async function fetchSuggests(q, signal) {
  const url = `${SUGGEST_API}?part=${encodeURIComponent(q)}`;
  // The host relay answers in ~200 ms; a stuck request must not keep the
  // panel blank forever, so give it a ceiling of its own.
  const data = await fetch(url, {
    credentials: 'omit',
    signal: signal || AbortSignal.timeout(4000),
  }).then((r) => {
    if (!r.ok) throw new Error(`suggest HTTP ${r.status}`);
    return r.json();
  });
  const items = Array.isArray(data)
    ? (Array.isArray(data[1]) ? data[1] : data)
    : [];
  // Occasionally the first row is "xhr=<size>"; drop it.
  return items.filter((row, i) => typeof row === 'string' && (i > 0 || !row.startsWith('xhr=')));
}

/* ------------------------------------------------------------------ */
/* Suggestion panel                                                    */
/* ------------------------------------------------------------------ */

const suggestState = {
  items: [],      // current suggestion strings
  tabRows: [],    // open tabs matching the query (rendered above the strings)
  active: -1,     // highlighted row index (-1 = none)
  controller: null,
  timer: 0,
  stagger: true,  // cascade the rows of the NEXT panel render (see renderPanel)
};

// Open tabs whose title or url contains the query, host order, max 3.
// Data comes from LiveTabs.state (the strip mirror, kept in sync by 'tabs').
function matchingTabs(q) {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return [];
  const tabs = (window.LiveTabs?.state?.tabs) || [];
  const out = [];
  for (const t of tabs) {
    const hay = `${t.title || ''} ${t.url || ''}`.toLowerCase();
    if (hay.includes(needle) && t.id !== 0) {
      out.push({ id: t.id, title: t.title || t.url || '', favicon: t.favicon || '' });
      if (out.length >= 3) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Quick answers («погода», «курс доллара», «12*3+5»)                  */
/* ------------------------------------------------------------------ */

// Три вида ответа, все первые в панели:
//   calc    — локально, без сети: строгое выражение «числа и операторы»;
//   weather — /api/quick?where=weather (хост: город из Windows часы);
//   rate    — /api/quick?where=rate&code=USD (хост: ЦБ РФ, без ключа).
// Сеть отвечает ~200 мс; ответ приходит асинхронно и дорисовывается только
// если запрос в омнибоксе не сменился (quick.token) — иначе старая погода
// висела бы над новыми подсказками.
const QUICK_API = 'https://api.livebrowser.shell/api/quick';
const quickState = { card: null, token: 0, cache: new Map() };

// Точный разбор арифметики без eval: числа (в т.ч. с точкой/запятой),
// + - * / % ^ ( ) и унарный минус.  Всё прочее → null (значит, это поиск).
function evalExpr(src) {
  const s = String(src).trim().replace(/,/g, '.').replace(/[×х]/g, '*').replace(/[÷:]/g, '/');
  if (!s || s.length > 80) return null;
  if (!/^[\d\s+\-*/%^().]+$/.test(s)) return null;
  if (!/\d/.test(s) || !/[+\-*/%^]/.test(s)) return null; // одно число — не калькулятор
  const toks = s.match(/\d+\.?\d*|[+\-*/%^()]/g) || [];
  if (toks.join('') !== s.replace(/\s+/g, '')) return null;
  let i = 0;
  const peek = () => toks[i];
  const eat = (t) => (toks[i] === t ? (i++, true) : false);
  function atom() {
    if (eat('-')) { const v = atom(); return v == null ? null : -v; }
    if (eat('+')) return atom();
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) return null;
      return v;
    }
    const n = peek();
    if (n == null || !/^\d/.test(n)) return null;
    i++;
    return parseFloat(n);
  }
  function power() {
    const base = atom();
    if (base == null) return null;
    if (eat('^')) { const e = power(); return e == null ? null : Math.pow(base, e); }
    return base;
  }
  function term() {
    let v = power();
    if (v == null) return null;
    for (;;) {
      if (eat('*')) { const r = power(); if (r == null) return null; v *= r; }
      else if (eat('/')) { const r = power(); if (r == null || r === 0) return null; v /= r; }
      else if (eat('%')) { const r = power(); if (r == null || r === 0) return null; v %= r; }
      else return v;
    }
  }
  function expr() {
    let v = term();
    if (v == null) return null;
    for (;;) {
      if (eat('+')) { const r = term(); if (r == null) return null; v += r; }
      else if (eat('-')) { const r = term(); if (r == null) return null; v -= r; }
      else return v;
    }
  }
  const val = expr();
  if (val == null || i !== toks.length || !isFinite(val)) return null;
  // Хвостовые нули убираем, крупные — с разделителями разрядов.
  const fixed = Math.round(val * 1e10) / 1e10;
  const text = Math.abs(fixed) >= 1e6
    ? fixed.toLocaleString('ru-RU', { maximumFractionDigits: 6 })
    : String(fixed);
  return { value: text, expr: s.replace(/\s+/g, ' ') };
}

// Какой быстрый ответ просит запрос (или null).
function quickKind(q) {
  // кириллица проходит \w в JS — границей слова служит (?![а-яё]) ниже
  const s = q.toLowerCase().trim().replace(/ё/g, 'е');
  if (/^погода(?![а-я])/.test(s)) return { kind: 'weather' };
  if (/^weather\b/.test(s) || /^(температура|какая погода)/.test(s)) return { kind: 'weather' };
  if (/^курс(?![а-я])/.test(s) || /^rate\b/.test(s) || /курс\s+(доллар|евро|юан|валют)/.test(s)) {
    let code = 'USD';
    if (/евро|\beur\b/.test(s)) code = 'EUR';
    else if (/юан|\bcny\b/.test(s)) code = 'CNY';
    else if (/фунт|\bgbp\b/.test(s)) code = 'GBP';
    else if (/тенге|\bkzt\b/.test(s)) code = 'KZT';
    return { kind: 'rate', code };
  }
  const calc = evalExpr(q);
  if (calc) return { kind: 'calc', ...calc };
  return null;
}

async function fetchQuick(what, code) {
  const key = what + ':' + (code || '');
  const hit = quickState.cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data; // 10 мин
  const url = `${QUICK_API}?where=${what}${code ? '&code=' + code : ''}`;
  const data = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : null));
  if (data && data.ok) quickState.cache.set(key, { at: Date.now(), data });
  return data && data.ok ? data : null;
}

// Локальная калькуляторная карточка.
function calcCard(hit) {
  return {
    kind: 'calc', icon: '=',
    value: hit.value,
    text: hit.expr,
    note: 'копировать',
    url: '',
  };
}

// Строка-карточка: тот же .suggest, но с крупным значением.  dataset.query
// хранит НЕ текст, а маркер: клик/Enter идут по своей ветке (quick-pick).
function buildQuickRow(card) {
  const row = document.createElement('button');
  row.type = 'button';
  row.setAttribute('role', 'option');
  row.className = 'suggest quick-row';
  row.dataset.quick = '1';
  row.dataset.query = card.kind === 'calc' ? card.value + ' ' : '__quick__';
  const icon = document.createElement('span');
  icon.className = 'suggest-icon';
  icon.textContent = card.icon || 'ℹ';
  const main = document.createElement('span');
  main.className = 'quick-main';
  const val = document.createElement('span');
  val.className = 'quick-value';
  val.textContent = card.value;
  const txt = document.createElement('span');
  txt.className = 'quick-text';
  txt.textContent = card.text;
  main.append(val, txt);
  const go = document.createElement('span');
  go.className = 'suggest go quick-note';
  go.textContent = card.note || '→';
  go.style.opacity = '0';
  row.append(icon, main, go);
  row.addEventListener('click', () => quickPick(row));
  row.addEventListener('pointerenter', () => setActive(row));
  return row;
}

function fillQuickRow(row, card) {
  row.children[0].textContent = card.icon || 'ℹ';
  row.children[1].children[0].textContent = card.value;
  row.children[1].children[1].textContent = card.text;
  row.children[2].textContent = card.note || '→';
  row.dataset.query = card.kind === 'calc' ? card.value + ' ' : '__quick__';
}

// Что делает выбор карточки: калькулятор копирует результат, погода/курс
// открывают источник (карточка — живая ссылка, ложного аффорданса нет).
function quickPick(row) {
  const card = row.__lbQuickCard;
  if (!card) return;
  hidePanel();
  sEl('search').blur();
  if (card.kind === 'calc') {
    try { navigator.clipboard.writeText(card.value); } catch { }
    if (window.showToast) window.showToast(`Скопировано: ${card.value}`);
    return;
  }
  if (card.url) jumpToSite(card.url, row);
}

// Текущая (сетевая) карточка по запросу; null — нечего показывать.
async function quickCard(q) {
  const want = quickKind(q);
  if (!want) return null;
  if (want.kind === 'calc') return calcCard(want);
  if (!window.chrome?.webview) return null; // без хоста: релей недоступен
  try {
    const data = await fetchQuick(want.kind, want.code);
    if (!data) return null;
    return {
      kind: want.kind,
      icon: data.icon || (want.kind === 'weather' ? '🌡' : '₽'),
      value: data.value || '—',
      text: data.title || '',
      note: data.note || '→',
      url: data.url || '',
    };
  } catch { return null; }
}

/* Row cascade for the local panel: opacity + translateY only.
   Every render that REPLACES the list animates — opening the panel and each
   per-keystroke refresh.  Previously only the opening cascaded, so typing the
   second letter swapped a full list of rows in one frame: the "resko
   poyavilsya" jump.  A refresh now costs one short run of staggered fades
   instead.
   Timing is two-tier so the list never lags behind fast typing: the opening
   gets a relaxed 22ms beat, live refreshes a tighter 12ms, and the animation
   itself is short.  Skipped over a site tab (the native dropdown layer paints
   the rows there), under the no-anim kill switch and for reduced-motion. */
const SUGGEST_STAGGER_OPEN_MS = 22;
const SUGGEST_STAGGER_REFILL_MS = 12;
const SUGGEST_STAGGER_ROWS = 10;

function markSuggestIn(row, index, fresh) {
  if (overSite()) return;
  if (document.body.classList.contains('no-anim')) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (index >= SUGGEST_STAGGER_ROWS) return;
  const step = fresh ? SUGGEST_STAGGER_OPEN_MS : SUGGEST_STAGGER_REFILL_MS;
  row.style.setProperty('--sug-delay', `${index * step}ms`);
  row.classList.add('suggest-in');
  row.addEventListener('animationend', () => {
    row.classList.remove('suggest-in'); // drops the cascade for hover/press
    row.style.removeProperty('--sug-delay');
  }, { once: true });
}

// On a site tab the suggestions cannot be drawn by this page: the site is a
// native view stacked ABOVE the ui (transparency between sibling HWNDs does
// not work).  The host owns a second native view (panelView) that floats
// over the site, below the bar; the panel's rows are relayed to it and the
// local #suggests stays laid out but paints nothing.
function overSite() {
  return document.body.classList.contains('site-active') && !!window.chrome?.webview;
}

// Shell -> host: show/hide the native dropdown layer.  `rect` is the local
// panel's rect in CSS px (measured while it is still laid out); the host
// positions its view there.  The overlay channel stays reserved for the
// settings sheet — suggestions never touch it.
function tellHostSuggests(open, rect) {
  if (!window.chrome?.webview) return;
  const msg = { type: 'suggests', open: !!open };
  if (open && rect) {
    msg.l = Math.round(rect.left);
    msg.t = Math.round(rect.top);
    msg.w = Math.round(rect.width);
    msg.h = Math.round(rect.height);
    msg.items = suggestState.items;
    msg.tabRows = suggestState.tabRows;
    msg.active = suggestState.active;
    msg.query = (sEl('search').value || '').trim();
  }
  try { window.chrome.webview.postMessage(JSON.stringify(msg)); }
  catch { /* host gone */ }
}

function hidePanel() {
  const box = sEl('suggests');
  // Отменяем летящий запрос подсказок: ответ после закрытия панели иначе
  // переоткрыл бы её со устаревшим списком (панель «воскресала» пустой).
  if (suggestState.controller) { try { suggestState.controller.abort(); } catch { } }
  // On a site tab the panel is "open" while hidden via visibility, so both
  // flags are checked before telling the host to drop the layer.
  if (!box.hidden || box.style.visibility === 'hidden') tellHostSuggests(false);
  window.LivePops?.close('suggests');
  suggestState.items = [];
  suggestState.tabRows = [];
  suggestState.active = -1;
  quickState.card = null;
  quickState.token++; // летящий быстрый ответ больше не нужен
  suggestState.stagger = true; // the next opening cascades its rows in
  sEl('search').setAttribute('aria-expanded', 'false');
  sEl('search').removeAttribute('aria-activedescendant');
  // Бар покидает режим набора: капсула поиска не остаётся «вместо вкладок»
  // (клик мимо / Esc / пик / клик по сайту — всё возвращает стрип).
  // Исключение — home(): он сам ставит omni-режим ПОСЛЕ hidePanel.
  window.LiveUi?.setBarMode('tabs');

  // Логика закрыта синхронно; картинка уезжает с fade (lb-pop-out).
  // Токен отменяет отложенное скрытие, если посреди исхода пришёл новый
  // рендер (набор продолжается): панель не должна «уехать» после открытия.
  const noMotion = document.body.classList.contains('no-anim')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const token = (suggestState.hideToken || 0) + 1;
  suggestState.hideToken = token;
  clearTimeout(suggestState.hideTimer);
  suggestState.hideTimer = 0;
  const finish = () => {
    if (token !== suggestState.hideToken) return; // открыт заново — не трогаем
    box.classList.remove('lb-exit');
    box.hidden = true;
    box.style.visibility = '';
    box.replaceChildren();
    suggestState.hideTimer = 0;
  };
  box.style.visibility = ''; // над сайтом панель была visibility:hidden
  // Над сайтом локальную панель не анимируем: её рисует нативный слой, а
  // копия, подрезанная до бара, мигнула бы уездом в никуда.
  if (box.hidden || noMotion || overSite()) {
    finish();
    return;
  }
  box.classList.add('lb-exit');
  box.replaceChildren();
  box.addEventListener('animationend', finish, { once: true });
  suggestState.hideTimer = setTimeout(finish, 160); // 140мс анимация + запас
}

function clearTimer() {
  clearTimeout(suggestState.timer);
}

/* Instant narrowing, before the network answers.
   The host relay needs ~150-250ms; until it replies the panel used to keep
   the PREVIOUS query's list, so typing "вал" over "вайл..." showed a row of
   words that no longer matched and then swapped them out in one frame — the
   "пропадают и появляются" flicker.  Here the rows already on screen are
   filtered by the new prefix and grey-faded for the wait; the reply replaces
   them with the real list.  Local only: no DOM rebuild, no network. */
function previewFilter(q) {
  const box = sEl('suggests');
  if (!box || box.hidden) return;
  const needle = q.toLowerCase();
  for (const row of box.children) {
    // Карточка быстрого ответа уже относится к новому запросу (пересобирается
    // в scheduleLookup) — старое затухание по чужому тексту ей не нужно.
    if (row.dataset.quick) continue;
    const text = (row.dataset.query || '').toLowerCase();
    const hit = !needle || text.startsWith(needle) || text.includes(' ' + needle);
    row.classList.toggle('suggest-stale', !hit);
  }
}

function scheduleLookup(q) {
  previewFilter(q);
  // Синхронная часть быстрого ответа (калькулятор) — сразу, иначе результат
  // ждал бы ответа подсказок.  Погода/курс — параллельно с подсказками.
  refreshQuick(q);
  clearTimer();
  suggestState.timer = setTimeout(() => lookup(q), 120);
}

// Пересобирает карточку быстрого ответа под новый запрос.  Карточка — не
// часть списка подсказок: она живёт до следующего ввода/закрытия панели.
function refreshQuick(q) {
  const want = quickKind(q);
  const token = ++quickState.token;
  const set = (card) => {
    if (token !== quickState.token) return; // ввод сменился — ответ устарел
    quickState.card = card;
    // Панель открыта — перерисовать на месте; закрыта — откроет lookup
    // (или покажет только карточку, если подсказки пусты).
    if (!sEl('suggests').hidden) renderPanel(suggestState.items, suggestState.tabRows, q);
    else if (card) renderPanel([], [], q);
  };
  if (!want) { set(null); return; }
  if (want.kind === 'calc') { set(calcCard(want)); return; }
  set(null); // старую погоду/курс не показываем под новым запросом
  quickCard(q).then(set);
}

async function lookup(q) {
  if (suggestState.controller) suggestState.controller.abort();
  if (!q) return hidePanel();
  suggestState.controller = new AbortController();
  const signal = suggestState.controller.signal;
  const tabRows = matchingTabs(q);
  let items;
  try {
    // Подсказки есть только у Яндекса (хост-релей): у Google/DDG панель
    // показывает локальные вкладки, а Enter сразу ищет в выбранном движке.
    items = (ENGINES[engine] || ENGINES.yandex).suggest
      ? await fetchSuggests(q, signal)
      : [];
  } catch (err) {
    window.__lastHide = 'fetch-error: ' + (err && err.message || err);
    // Yandex недоступен — вкладки/карточка всё равно показываются, это
    // локальные данные и собственный ответ хоста.
    if (tabRows.length === 0 && !quickState.card) return;
    items = [];
  }
  if (signal.aborted) { window.__lastHide = 'aborted'; return; }
  if (items.length === 0 && tabRows.length === 0 && !quickState.card) { window.__lastHide = 'empty'; return hidePanel(); }
  suggestState.items = items;
  suggestState.tabRows = tabRows;
  suggestState.active = -1;
  renderPanel(items, tabRows, q);
  window.__lastHide = 'rendered';
}


/* ---- Row lifecycle for the diff-render above ---- */

// Новая строка: каркас + обработчики.  Данные читаются из dataset в момент
// события — одна и та же строка переживает несколько запросов, и замыкание
// на старый текст прыгнуло бы по устаревшему адресу.
function buildSuggestRow(w) {
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
  row.append(icon, textEl, go);
  return row;
}

// Обновление содержимого на месте: иконка (фавикон при смене), текст с
// болдом префикса, dataset.  Дешевле пересоздания и не трогает анимации.
function fillSuggestRow(row, w, q) {
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

function bindSuggestRow(row) {
  row.addEventListener('click', () => {
    if (row.classList.contains('tab-row')) chooseTab(Number(row.dataset.tabId), row);
    else chooseSuggestion(row.dataset.query, row);
  });
  row.addEventListener('pointerenter', () => setActive(row));
}

function renderPanel(items, tabRows, q) {
  const box = sEl('suggests');
  // The gear menu and the suggestion panel share the same surface (the local
  // popover or the native layer over a site): suggestions opening wins, so
  // the menu goes first (app.js owns the menu and the "menu" bridge).
  window.LiveUi?.closeSearchMenu?.();
  // Was the panel already on screen?  A render into a open panel is a
  // keystroke refresh (tight cascade); the one that reveals it is the open
  // (relaxed cascade).  Read BEFORE replaceChildren touches the DOM.
  const fresh = box.hidden || suggestState.stagger;
  suggestState.stagger = false;
  // Рендер в закрывающуюся панель отменяет исход: снимаем класс и гасим
  // отложенное скрытие, иначе панель пропала бы на глазах у печатавшего.
  suggestState.hideToken = (suggestState.hideToken || 0) + 1;
  clearTimeout(suggestState.hideTimer);
  suggestState.hideTimer = 0;
  box.classList.remove('lb-exit');

  // Дифф-рендер вместо replaceChildren на каждый символ.  Строка, которая
  // уже на экране (совпала по ключу вкладка-id / текст), переживает новый
  // запрос: текст с болдом обновляется на месте, анимация не перезапускается,
  // высота панели не прыгает.  Полный снос DOM + каскад заново на каждое
  // нажатие и читались как «плашка в 30 fps»: постоянная перерисовка и
  // дрожание при быстром наборе.
  const want = [];
  // Открытые вкладки идут первыми: они самые «верные» совпадения.
  for (const t of tabRows || []) want.push({ kind: 'tab', id: t.id, title: t.title, fav: t.favicon });
  // Быстрый ответ — самая первая строка: «погода» сразу показывает градусы,
  // «12*3» — результат.  Карточка живёт вне items/tabRows (иначе подсказки
  // Яндекса вытеснили бы её), но занимает индекс 0 в подсветке и Enter.
  const quick = quickState.card;
  if (quick) want.push({ kind: 'quick', card: quick });
  for (const text of items) want.push({ kind: 'item', text });

  const keyOf = (w) => (w.kind === 'tab' ? 'tab:' + w.id : w.kind === 'quick' ? 'quick' : 'item:' + w.text);
  const pool = new Map();
  for (const el of [...box.children]) {
    box.removeChild(el);
    pool.set(el.dataset.key, el);
  }
  want.forEach((w, i) => {
    const key = keyOf(w);
    const kept = pool.get(key) || null;
    pool.delete(key);
    const el = kept || (w.kind === 'quick' ? buildQuickRow(w.card) : buildSuggestRow(w));
    if (w.kind === 'quick') { fillQuickRow(el, w.card); el.__lbQuickCard = w.card; }
    else fillSuggestRow(el, w, q);
    el.dataset.key = key;
    box.appendChild(el); // append перемещает существующий узел без пересоздания
    if (!kept) {
      if (w.kind !== 'quick') bindSuggestRow(el);
      markSuggestIn(el, i, fresh);
    }
  });
  pool.clear(); // строки, которых больше нет в списке, выбрасываются

  // Активная строка и «→» — один проход по уже готовым узлам.
  [...box.children].forEach((el, i) => {
    const on = i === suggestState.active;
    el.classList.toggle('active', on);
    // Ответ релея пришёл — список снова авторитетный: предварительное
    // затухание (previewFilter) снимаем, иначе строка остаётся серой.
    el.classList.remove('suggest-stale');
    const go = el.querySelector('.go');
    if (go) go.style.opacity = on ? '1' : '0';
  });
  // Lay the panel out first: the native layer is positioned from its rect.
  box.hidden = false;
  if (overSite()) {
    // Hand the rows to the host's native dropdown layer above the site; the
    // local panel stays laid out (so arrows/Enter keep working untouched)
    // but paints nothing — the ui view is clipped to the bar here anyway.
    // The entry animation must not scale the measured rect: freeze it.
    box.style.animation = 'none';
    box.style.visibility = 'hidden';
    tellHostSuggests(true, box.getBoundingClientRect());
  } else {
    box.style.visibility = '';
  }
  sEl('search').setAttribute('aria-expanded', 'true');
  // Реестр поповеров: открытие подсказок гасит палитру/меню/стрип истории.
  if (!overSite()) window.LivePops?.open('suggests', hidePanel);
}

function highlight(text, prefix) {
  const frag = document.createDocumentFragment();
  const i = text.toLowerCase().indexOf(prefix.toLowerCase());
  if (i > 0) frag.appendChild(document.createTextNode(text.slice(0, i)));
  if (i >= 0) {
    const b = document.createElement('b');
    b.textContent = text.slice(i, i + prefix.length);
    frag.appendChild(b);
    frag.appendChild(document.createTextNode(text.slice(i + prefix.length)));
  } else {
    frag.appendChild(document.createTextNode(text));
  }
  return frag;
}

// Syncs .active + "→" affordance to a row.  Returns its index or -1.
function setActive(row) {
  const rows = [...sEl('suggests').children];
  const i = rows.indexOf(row);
  for (const el of rows) {
    const on = el === row;
    el.classList.toggle('active', on);
    el.querySelector('.go').style.opacity = on ? '1' : '0';
  }
  suggestState.active = i;
  return i;
}

function stepActive(delta) {
  const rows = [...sEl('suggests').children];
  if (!rows.length) return;
  const box = sEl('suggests');
  // The input keeps focus while a row is highlighted, so drive the
  // highlight from state and mirror it into the row styling ourselves.
  const current = box.querySelector('.suggest.active');
  const hasActive = current !== null;
  let next;
  if (hasActive) {
    next = suggestState.active + delta;
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
  } else {
    next = delta > 0 ? 0 : rows.length - 1;
  }
  for (const el of rows) {
    const on = rows[next] === el;
    el.classList.toggle('active', on);
    el.querySelector('.go').style.opacity = on ? '1' : '0';
  }
  suggestState.active = next;
  // Do NOT write the suggestion into the input: that would re-fire
  // `input`, schedule a new lookup and reset the highlight. Enter acts on
  // the highlighted row directly.
  if (!rows[next].id) rows[next].id = `sg-${next}`;
  sEl('search').setAttribute('aria-activedescendant', rows[next].id);
  // Подсветка дотягивается мягко (как revealRow палитры), а не прыжком:
  // стрелки по подсказкам скользят, список дышит за курсором.
  const top = rows[next].offsetTop;
  const rowBottom = top + rows[next].offsetHeight;
  const maxScroll = box.scrollHeight - box.clientHeight;
  if (top < box.scrollTop) {
    if (window.LiveScroll) LiveScroll.scrollTo(box, Math.max(0, top), { duration: 0.3 });
    else box.scrollTop = top;
  } else if (rowBottom > box.scrollTop + box.clientHeight) {
    const target = Math.min(maxScroll, rowBottom - box.clientHeight);
    if (window.LiveScroll) LiveScroll.scrollTo(box, target, { duration: 0.3 });
    else box.scrollTop = target;
  }
  // On a site tab the highlight lives in the native layer: re-send the rows
  // with the new active index (the geometry has not changed).
  if (overSite()) tellHostSuggests(true, box.getBoundingClientRect());
}

function chooseSuggestion(text, row) {
  sEl('suggests').dataset.chosen = '1';
  jumpToSearch(text, row);
}

// Клик по строке открытой вкладки: мгновенная активация, панель — прочь.
function chooseTab(id, row) {
  sEl('suggests').dataset.chosen = '1';
  hidePanel();
  sEl('search').blur();
  try { window.chrome?.webview?.postMessage(JSON.stringify({ type: 'activate', id })); }
  catch { /* host gone */ }
  if (window.LiveTabs) window.LiveTabs.switchTo(id);
}

/* ------------------------------------------------------------------ */
/* Page transition                                                     */
/* ------------------------------------------------------------------ */

// Tear-down timers, so a second jump cannot hide a newer overlay early.
const jumpTimers = { fade: 0, hide: 0 };

function stopJumpTimers() {
  clearTimeout(jumpTimers.fade);
  clearTimeout(jumpTimers.hide);
  jumpTimers.fade = 0;
  jumpTimers.hide = 0;
}

// Opens `url` right away and covers the hand-off with a short ripple that
// grows from `from` (a DOMRect / element) and fades in <=380 ms.  The
// overlay never takes pointer events and is hidden as soon as it is clear.
function jump(url, label, from) {
  const overlay = sEl('jump');
  const ripple = sEl('jump-ripple');
  const labelEl = sEl('jump-label');

  stopJumpTimers();

  // Coordinates come from the viewport, so the overlay must not be inside a
  // transformed/positioned ancestor. Page coordinates + fixed inset:0 is
  // equivalent because the shell never scrolls.
  const rect = (from && from.getBoundingClientRect ? from : null)?.getBoundingClientRect()
    || sEl('search').getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // One oversized disc covers any viewport from the click point.
  const size = Math.ceil(2.6 * Math.hypot(innerWidth, innerHeight));
  ripple.style.left = `${cx - size / 2}px`;
  ripple.style.top = `${cy - size / 2}px`;
  ripple.style.width = ripple.style.height = `${size}px`;

  labelEl.textContent = label;
  overlay.hidden = false;
  overlay.classList.remove('anim');
  // Force reflow so the animation restarts even on repeat jumps.
  void overlay.offsetWidth;
  overlay.classList.add('anim');

  ripple.addEventListener('animationend', fadeJump, { once: true });
  jumpTimers.fade = setTimeout(fadeJump, 360);
  jumpTimers.hide = setTimeout(finishJump, 420);

  // Hand the viewport over immediately: the host swaps in the site while the
  // ripple fades, and the fallback opens a window.
  if (window.LiveTabs) window.LiveTabs.open(url, label);
  else window.open(url, '_blank', 'noopener');

  // The query has been used: the next time the omnibox opens it starts clean
  // (the blur handler only clears when it did not see a chosen suggestion).
  const qInput = sEl('search');
  if (qInput) {
    qInput.dataset.used = '1';
    qInput.value = '';
  }

  hidePanel();
  if (document.activeElement === sEl('search')) sEl('search').blur();
  window.LiveUi?.setBarMode('tabs');
}

// The growth phase (0.36 s) is over: start the fade inside the same window.
function fadeJump() {
  clearTimeout(jumpTimers.fade);
  const overlay = sEl('jump');
  if (!overlay || overlay.hidden) return;
  overlay.classList.add('out');
  jumpTimers.hide = setTimeout(finishJump, 90);
}

// Everything is over: retire the overlay without blocking input.
function finishJump() {
  const overlay = sEl('jump');
  if (!overlay || overlay.hidden) return;
  stopJumpTimers();
  overlay.classList.remove('anim', 'out');
  overlay.hidden = true;
}

function jumpToSearch(query, from) {
  const e = ENGINES[engine] || ENGINES.yandex;
  jump(e.search(query), `${e.label}: «${query}»`, from);
}

function jumpToSite(url, from) {
  let label;
  try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { label = url; }
  jump(url, label, from);
}

/* ------------------------------------------------------------------ */
/* Omnibox behaviour (overrides app.js's navigate)                    */
/* ------------------------------------------------------------------ */

// `app.js` defines this, but each shell module must stay standalone.
function sLooksLikeHost(s) {
  return /^[^\s]+\.[^\s]+$/.test(s) && !s.includes('/');
}

function sNavigate(input, from) {
  const raw = (input || '').trim();
  if (!raw) return;
  const isUrl = raw.includes('://') || sLooksLikeHost(raw);
  if (isUrl) jumpToSite(raw.includes('://') ? raw : `https://${raw}`, from);
  else jumpToSearch(raw, from);
}
window.sNavigate = sNavigate;

// The native dropdown layer picks a row: the host relays 'suggest-pick'
// here (app.js onHostMessage) and the same search jump runs as if the row
// had been clicked in the local panel.  `hide` lets app.js close an open
// suggestion panel before it hands the same native layer to the gear menu.
window.LiveSearch = { pick: (q) => jumpToSearch(q), focus: focusOmnibox, hide: hidePanel };

// Ctrl+L from anywhere: focus (and select) the omnibox.
function focusOmnibox() {
  const input = sEl('search');
  if (!input) return;
  window.LiveUi?.setBarMode('omni');
  input.focus();
  input.select();
  // The mode switch re-layouts the host views; focus can be stolen right
  // after (back to a tab button) — re-assert once the dust settles.
  setTimeout(() => { if (document.activeElement !== input) { input.focus(); input.select(); } }, 80);
  setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 300);
}

function onOmniShortcut(e) {
  if (e.altKey || e.metaKey) return;
  // e.code is layout-independent: on a Russian keyboard e.key is 'л'.
  // Only the two documented bindings (Ctrl+L, F6) — Ctrl+F6 is what the
  // browser's own accelerator table would send, and nothing here needs it.
  if ((e.ctrlKey && !e.shiftKey && e.code === 'KeyL') || (!e.ctrlKey && e.key === 'F6')) {
    e.preventDefault();
    focusOmnibox();
  }
}

function initSearch() {
  const input = sEl('search');
  const box = sEl('suggests');

  input.addEventListener('input', () => {
    clearTimer();
    const q = input.value.trim();
    if (q) scheduleLookup(q); else hidePanel();
  });
  // Focusing the omnibox switches the bar to typing mode; clicking the tab
  // strip switches it back (the strip has no text cursor).
  input.addEventListener('focus', () => window.LiveUi?.setBarMode('omni'));
  input.addEventListener('blur', () => {
    // On a site the dropdown is a native layer whose visibility must not be
    // tied to the omnibox focus: showing it steals focus right back (host
    // layout), and a blur-hide here would blink it away mid-typing.  It
    // closes on Escape / pick instead.
    if (overSite()) return;
    // Keep the panel usable while a suggestion click is in flight; once the
    // omnibox is left for good the panel and the query go away, so search
    // can never be "abandoned" invisibly over the home screen.
    setTimeout(() => {
      if (document.activeElement !== input && !box.matches(':hover')) {
        window.__lastHide = 'blur (active=' + (document.activeElement && document.activeElement.id || document.activeElement && document.activeElement.tagName || 'null') + ')';
        hidePanel();
        if (!box.dataset.chosen && !input.dataset.used) input.value = '';
        delete input.dataset.used;
        // «Поисковик убирается полностью»: капсула уходит, стрип вкладок
        // возвращается.  Клик по пустому месту = отказ от поиска.
        window.LiveUi?.setBarMode('tabs');
      }
      delete box.dataset.chosen;
    }, 140);
  });

  // Keyboard navigation.  Capture phase so earlier defaults (app.js Enter)
  // never fire while the panel drives input.
  input.addEventListener('keydown', (e) => {
    const n = suggestState.items.length + suggestState.tabRows.length + (quickState.card ? 1 : 0);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!n || box.hidden || !input.value.trim()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stepActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (suggestState.active >= 0 && !box.hidden) {
        // Строки панели идут в порядке: карточка быстрого ответа (если есть),
        // вкладки, подсказки — выбор берётся по DOM, не по смещённому индексу.
        const rows = [...box.children];
        const row = rows[suggestState.active];
        if (row && row.dataset.tabId) chooseTab(Number(row.dataset.tabId), row);
        else if (row && row.dataset.quick) quickPick(row);
        else jumpToSearch(row ? row.dataset.query : input.value.trim());
      } else if (input.value.trim()) {
        sNavigate(input.value, input);
      } else {
        // Empty Enter = done editing: hand the bar to the tab strip.
        hidePanel();
        if (window.LiveTabs) window.LiveTabs.home();
        else input.blur();
      }
    } else if (e.key === 'Escape') {
      // First Escape closes the suggestion panel; a second one drops the
      // query and hands the bar back to the tab strip.
      if (!box.hidden) hidePanel();
      else {
        input.value = '';
        input.blur();
        window.LiveUi?.setBarMode('tabs');
      }
      e.stopImmediatePropagation();
    }
  });

  // Pressing a real tab with the omnibox open is a switch, not an edit.
  // The mode flips in place (no reflow before the click) and only when the
  // press is not on a tab, so the user's click always lands on what it hit.
  sEl('tabs').addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.tab')) {
      input.blur();
      window.LiveUi?.setBarMode('tabs');
    }
  });

  // tabs.js (loaded before this file) owns Ctrl+L once it boots; registering
  // the handler here keeps a plain browser fallback working until then.
  window.__liveCtrlL = onOmniShortcut;
  window.addEventListener('keydown', onOmniShortcut);
}

document.addEventListener('DOMContentLoaded', initSearch);

})();
