// LiveBrowser downloads UI.  The C# host owns every transfer (its own
// HttpClient with Range support) and pushes {"type":"download", item:{...}}
// at ~10 Hz; this module only mirrors those pushes row-by-row and sends
// {"type":"download-cmd", id, cmd:"pause|resume|cancel|open|show"} back.
// v1 keeps no history of its own: the list is exactly what arrived this run.
'use strict';

(function () {

const dEl = (id) => document.getElementById(id);

// id -> item ({id,url,name,path,received,total,state,speed}); row element is
// looked up from the DOM by data-id.
const items = new Map();

const STATE_TEXT = {
  downloading: 'Загрузка…',
  paused: 'Пауза',
  done: 'Завершено',
  error: 'Ошибка',
  canceled: 'Отменено',
};
const ACTIVE_STATES = new Set(['downloading', 'paused']);

function dPost(msg) {
  try { window.chrome.webview.postMessage(JSON.stringify(msg)); } catch { /* host gone */ }
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function fmtBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? Math.round(v) : v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${s} ${units[i]}`;
}

function fmtSpeed(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${fmtBytes(n)}/с`;
}

// ETA is only meaningful while the transfer is running with a known size.
function fmtEta(item) {
  if (item.state !== 'downloading') return '';
  const total = Number(item.total) || 0;
  const speed = Number(item.speed) || 0;
  if (total <= 0 || speed <= 0) return '';
  const sec = Math.max(1, Math.round((total - Number(item.received) || 0) / speed));
  if (sec < 60) return `осталось ~${sec} с`;
  const min = Math.round(sec / 60);
  if (min < 60) return `осталось ~${min} мин`;
  return `осталось ~${Math.floor(min / 60)} ч ${min % 60} мин`;
}

function fmtAmount(item) {
  const received = Number(item.received) || 0;
  const total = Number(item.total) || 0;
  if (total > 0) return `${fmtBytes(received)} из ${fmtBytes(total)}`;
  return fmtBytes(received);
}

/* ------------------------------------------------------------------ */
/* Row rendering                                                       */
/* ------------------------------------------------------------------ */

function iconSvg(name) {
  switch (name) {
    case 'pause':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
    case 'resume':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
    case 'cancel':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    case 'open':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 10.5 13.5"/><path d="M19.5 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5.5 18.5v-11A1.5 1.5 0 0 1 7 6h4"/></svg>';
    case 'show':
    default:
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z"/></svg>';
  }
}

function dlButton(name, title, item) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `dl-act dl-${name}`;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = iconSvg(name);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    dPost({ type: 'download-cmd', id: item.id, cmd: name });
  });
  return b;
}

// Buttons depend on the state: pause/resume swap, cancel is for active
// transfers only, open appears once the file exists, show always works.
function buildActions(item) {
  const wrap = document.createElement('div');
  wrap.className = 'dl-actions';
  if (item.state === 'downloading') wrap.append(dlButton('pause', 'Пауза', item));
  if (item.state === 'paused') wrap.append(dlButton('resume', 'Продолжить', item));
  if (ACTIVE_STATES.has(item.state)) wrap.append(dlButton('cancel', 'Отменить', item));
  if (item.state === 'done') wrap.append(dlButton('open', 'Открыть файл', item));
  if (item.path) wrap.append(dlButton('show', 'Показать в папке', item));
  return wrap;
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = `dl-item st-${item.state}`;
  row.dataset.id = String(item.id);

  const main = document.createElement('div');
  main.className = 'dl-main';

  const name = document.createElement('div');
  name.className = 'dl-name';
  name.textContent = item.name || item.url || 'Файл';
  name.title = item.url || item.name || '';

  const path = document.createElement('div');
  path.className = 'dl-path';
  path.textContent = item.path || '';
  if (item.path) path.title = item.path;

  const meta = document.createElement('div');
  meta.className = 'dl-meta';

  const amount = document.createElement('span');
  amount.className = 'dl-amount';
  amount.textContent = fmtAmount(item);

  const speed = document.createElement('span');
  speed.className = 'dl-speed';
  speed.textContent = fmtSpeed(item.speed);

  const eta = document.createElement('span');
  eta.className = 'dl-eta';
  eta.textContent = fmtEta(item);

  const state = document.createElement('span');
  state.className = 'dl-state';
  state.textContent = STATE_TEXT[item.state] || item.state || '';
  if (item.state === 'error') state.classList.add('bad');

  meta.append(amount, state);
  if (speed.textContent) meta.append(speed);
  if (eta.textContent) meta.append(eta);

  main.append(name, path);

  const total = Number(item.total) || 0;
  const received = Number(item.received) || 0;
  if (ACTIVE_STATES.has(item.state) || (item.state === 'done' && total > 0)) {
    const bar = document.createElement('div');
    bar.className = 'dl-bar';
    const fill = document.createElement('span');
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100))
      : (item.state === 'done' ? 100 : 0);
    fill.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
    bar.append(fill);
    main.append(bar, meta);
  } else {
    main.append(meta);
  }

  row.append(main, buildActions(item));
  return row;
}

// Only the touched row is replaced — the host ticks at ~10 Hz, so re-rendering
// the whole list would be wasteful and would fight the scroll position.
// Replacement rows must NOT replay the entry animation: each push rebuilds
// the node, so an unscoped animation would flash on every tick.  Only
// genuinely new rows get .dl-new (settings.css animates that class alone).
function renderRow(item) {
  const list = dEl('downloads-list');
  if (!list) return;
  const key = String(item.id);
  const fresh = buildRow(item);
  const old = list.querySelector(`.dl-item[data-id="${CSS.escape(key)}"]`);
  if (old) {
    // Ошибка на живой строке: микро-шейк, чтобы провал был ощутим, а не
    // только прочитан (остальные обновления проходят без анимации — строки
    // перерисовываются ~10 Гц, см. .dl-new в app.css).
    if (item.state === 'error' && !old.classList.contains('st-error')) {
      window.LiveFeel?.shake?.(fresh);
    }
    old.replaceWith(fresh);
  } else {
    fresh.classList.add('dl-new');
    list.prepend(fresh);
    if (item.state === 'error') window.LiveFeel?.shake?.(fresh);
  }
  syncEmpty();
}

function syncEmpty() {
  const list = dEl('downloads-list');
  const empty = dEl('downloads-empty');
  if (!list || !empty) return;
  empty.hidden = list.childElementCount > 0;
}

function updateBadge() {
  const badge = dEl('dl-badge');
  if (!badge) return;
  let n = 0;
  for (const item of items.values()) if (ACTIVE_STATES.has(item.state)) n++;
  badge.textContent = String(n);
  badge.hidden = n === 0;
  const btn = dEl('downloads-btn');
  if (btn) btn.classList.toggle('has-active', n > 0);
}

/* ------------------------------------------------------------------ */
/* Host push + page open/close                                         */
/* ------------------------------------------------------------------ */

// Called from app.js's bridge listener on {"type":"download"}.
function onItem(item) {
  if (!item || item.id == null) return;
  items.set(String(item.id), {
    id: item.id,
    url: item.url || '',
    name: item.name || '',
    path: item.path || '',
    received: Number(item.received) || 0,
    total: Number(item.total) || 0,
    state: STATE_TEXT[item.state] ? item.state : 'downloading',
    speed: Number(item.speed) || 0,
  });
  renderRow(items.get(String(item.id)));
  updateBadge();
}

function overlay(open) {
  if (!window.chrome?.webview) return;
  try {
    window.chrome.webview.postMessage(JSON.stringify({
      type: 'overlay', open, height: open ? window.innerHeight : 0,
    }));
  } catch { /* host gone */ }
}

function openPage() {
  const page = dEl('downloads-page');
  if (!page) return;
  // The small settings sheet and this page share the host's overlay channel;
  // free it first (app.js's closeSettings runs on the click).
  if (dEl('settings')?.hidden === false) dEl('settings-close')?.click();
  page.hidden = false;
  requestAnimationFrame(() => page.classList.add('show'));
  overlay(true);
  syncEmpty();
  dEl('downloads-close')?.focus();
}

function closePage() {
  const page = dEl('downloads-page');
  if (!page || page.hidden) return;
  page.classList.remove('show');
  overlay(false);
  dEl('downloads-btn')?.focus();
  setTimeout(() => { if (!page.classList.contains('show')) page.hidden = true; }, 220);
}

function initDownloads() {
  dEl('downloads-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const page = dEl('downloads-page');
    if (!page) return;
    if (page.hidden) openPage(); else closePage();
  });
  dEl('downloads-close')?.addEventListener('click', closePage);
  dEl('downloads-page')?.addEventListener('pointerdown', (e) => {
    if (e.target === dEl('downloads-page')) closePage();
  });
  // Escape closes this layer first; the capture handler in app.js only owns
  // the small sheet, and this one registered later so ordering is safe.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dEl('downloads-page')?.hidden === false) {
      e.stopImmediatePropagation();
      closePage();
    }
  }, true);

  window.LiveDownloads = { onItem, openPage, closePage, items };
}

document.addEventListener('DOMContentLoaded', initDownloads);

})();
