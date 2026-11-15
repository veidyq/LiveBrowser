// LiveBrowser full settings page (Wave 5).  Unlike the palette sheet this is
// a complete dialog: appearance (animations), browser (search engine, new
// tab, default zoom), downloads, hotkeys reference and settings.json
// export/import.  Values live in the host's settings.json (version:1, next to
// the exe) behind /api/settings: GET fills the controls, every change is
// POSTed as partial JSON (debounced) and the host merges, saves and applies.
'use strict';

(function () {

const sEl = (id) => document.getElementById(id);

const API = 'https://api.livebrowser.shell/api/settings';
const VERSION = '1.0';
const SAVE_DEBOUNCE = 400;

// The contract's defaults; also the fill-in when the host has not answered
// (older build without /api/settings — the page still works, POSTs are best
// effort).
const DEFAULTS = {
  version: 1,
  animations: true,
  tactile: true,             // тактильный слой feel.js (нажимы/шейк/резинка)
  search: 'yandex',
  newTab: 'desktop',
  defaultZoom: 1,
  downloads: { dir: '', askEach: false, autoOpen: false },
  // Cyberpunk-кожа (Night City): тонкие настройки видны в настройках только
  // пока активна [data-theme="cyberpunk"].  Хост хранит ключи как есть
  // (SettingsStore мержит сырой JSON — схема не менялась).
  cyberScanlines: false,
  cyberGlitch: false,
  // «Оптимизация»: те же ключи читает и хост (SettingsStore).
  backgroundSuspend: true,   // пауза неактивных вкладок
  backgroundBlur: true,      // тяжёлый backdrop-filter
  hardwareAccel: true,       // GPU у WebView2 (требует перезапуска)
  useCache: true,            // кеш страниц между запусками
  adBlock: true,             // блокировка рекламных/трекерных хостов
};

const settingsState = {
  cached: null,   // last known settings object (normalized)
  pending: {},    // partial JSON waiting for the debounced POST
  timer: 0,
};

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

function apiGet() {
  return fetch(API, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    .then((r) => { if (!r.ok) throw new Error(`settings HTTP ${r.status}`); return r.json(); });
}

function apiPost(partial) {
  return fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
    signal: AbortSignal.timeout(4000),
  }).then((r) => { if (!r.ok) throw new Error(`settings HTTP ${r.status}`); });
}

// Keeps the shell's view of the settings sane even if the host answer is
// sparse or the import file is hand-edited.
function normalize(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dl = s.downloads && typeof s.downloads === 'object' ? s.downloads : {};
  return {
    version: 1,
    animations: s.animations !== false,
    tactile: s.tactile !== false,
    search: s.search === 'yandex' ? 'yandex' : (s.search || DEFAULTS.search),
    newTab: s.newTab === 'blank' ? 'blank' : 'desktop',
    defaultZoom: Math.min(2, Math.max(0.5, Number(s.defaultZoom) || 1)),
    downloads: {
      dir: typeof dl.dir === 'string' ? dl.dir : '',
      askEach: dl.askEach === true,
      autoOpen: dl.autoOpen === true,
    },
    cyberScanlines: s.cyberScanlines === true,
    cyberGlitch: s.cyberGlitch === true,
    backgroundSuspend: s.backgroundSuspend !== false,
    backgroundBlur: s.backgroundBlur !== false,
    hardwareAccel: s.hardwareAccel !== false,
    useCache: s.useCache !== false,
    adBlock: s.adBlock !== false,
  };
}

function queueSave(partial) {
  Object.assign(settingsState.pending, partial);
  clearTimeout(settingsState.timer);
  settingsState.timer = setTimeout(() => {
    const body = settingsState.pending;
    settingsState.pending = {};
    apiPost(body).catch(() => window.showToast?.('Не удалось сохранить настройки'));
  }, SAVE_DEBOUNCE);
}

// One write path per change: update the local mirror first so a later change
// builds its partial on top of the newest value.
function change(partial) {
  if (!settingsState.cached) settingsState.cached = normalize(null);
  const c = settingsState.cached;
  if ('animations' in partial) c.animations = partial.animations;
  if ('tactile' in partial) c.tactile = partial.tactile;
  if ('search' in partial) c.search = partial.search;
  if ('newTab' in partial) c.newTab = partial.newTab;
  if ('defaultZoom' in partial) c.defaultZoom = partial.defaultZoom;
  if ('downloads' in partial) c.downloads = { ...c.downloads, ...partial.downloads };
  if ('cyberScanlines' in partial) c.cyberScanlines = partial.cyberScanlines;
  if ('cyberGlitch' in partial) c.cyberGlitch = partial.cyberGlitch;
  if ('backgroundSuspend' in partial) c.backgroundSuspend = partial.backgroundSuspend;
  if ('backgroundBlur' in partial) c.backgroundBlur = partial.backgroundBlur;
  if ('hardwareAccel' in partial) c.hardwareAccel = partial.hardwareAccel;
  if ('useCache' in partial) c.useCache = partial.useCache;
  if ('adBlock' in partial) c.adBlock = partial.adBlock;
  queueSave(partial);
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

function fill(s) {
  const anim = sEl('set-anim');
  if (anim) anim.checked = s.animations;
  // «О браузере»: версия и живая проверка обновлений.
  const ver = sEl('about-version');
  if (ver) ver.textContent = '1.0';
  const rt = sEl('about-runtime');
  if (rt && navigator.userAgentData && navigator.userAgentData.brands) {
    const e = navigator.userAgentData.brands.find((b) => /Edge|Chromium/i.test(b.brand));
    if (e) rt.textContent = `Microsoft Edge WebView2 (${e.version})`;
  }
  // Движок живёт в search.js (LiveSearchEngine): бейдж, placeholder, URL.
  window.LiveSearchEngine?.set(s.search);
  const newTab = sEl('set-newtab');
  if (newTab) newTab.value = s.newTab;
  const zoom = sEl('set-zoom');
  if (zoom) zoom.value = String(Math.round(s.defaultZoom * 100));
  syncZoomLabel();
  const dir = sEl('set-dl-dir');
  if (dir) dir.value = s.downloads.dir;
  const ask = sEl('set-dl-ask');
  if (ask) ask.checked = s.downloads.askEach;
  const auto = sEl('set-dl-auto');
  if (auto) auto.checked = s.downloads.autoOpen;
  // The kill switch is applied live so the effect is visible immediately.
  document.body.classList.toggle('no-anim', !s.animations);
  // «Тактильный отклик» (feel.js): нажимы, шейк, резинка.  Тоже живой.
  document.body.classList.toggle('tactile-off', s.tactile === false);
  const tactile = sEl('set-tactile');
  if (tactile) tactile.checked = s.tactile;
  // «Стеклянный фон» из раздела Оптимизация: тяжёлые blur(36px) у стекла и
  // бара снимаются, панели остаются плотными (app.css: body.no-blur).
  document.body.classList.toggle('no-blur', s.backgroundBlur === false);
  applyCyberToggles(s);
  applyOptimizeToggles(s);
  syncAdBlockCount();
}

// «Оптимизация»: тумблеры + живой эффект.  Стеклянный фон — класс no-blur
// (app.css гасит backdrop-filter; тот же класс ставит optimize.js по
// стартовому push'у); аппаратное ускорение вступает в силу только после
// перезапуска, поэтому здесь лишь сохраняем значение.
function applyOptimizeToggles(s) {
  const suspend = sEl('set-bg-suspend');
  if (suspend) suspend.checked = s.backgroundSuspend !== false;
  const blur = sEl('set-bg-blur');
  if (blur) blur.checked = s.backgroundBlur !== false;
  const hw = sEl('set-hw-accel');
  if (hw) hw.checked = s.hardwareAccel !== false;
  const cache = sEl('set-cache');
  if (cache) cache.checked = s.useCache !== false;
  const ad = sEl('set-adblock');
  if (ad) ad.checked = s.adBlock !== false;
  document.body.classList.toggle('no-blur', s.backgroundBlur === false);
}

// Night City: scanlines и усиленный глитч — классы на body, CSS кожи
// подхватывает их только при активной [data-theme="cyberpunk"].  Ставится
// и при заполнении страницы, и при старте (boot apiGet ниже).
function applyCyberToggles(s) {
  document.body.classList.toggle('scanlines', s.cyberScanlines === true);
  document.body.classList.toggle('glitch-max', s.cyberGlitch === true);
  const scan = sEl('set-cyber-scanlines');
  if (scan) scan.checked = s.cyberScanlines === true;
  const glitch = sEl('set-cyber-glitch');
  if (glitch) glitch.checked = s.cyberGlitch === true;
}

/* ------------------------------------------------------------------ */
/* Показ приветствия снова                                             */
/* ------------------------------------------------------------------ */

// Приветствие — не настройка, а событие: сброс хранится во флаге хоста
// (firstrun.flag), а не в settings.json.
//
// Почему не «покажем при следующем запуске».  Так кнопка работала раньше, и
// результат был невидим: заказчик нажал, перезапустил — и ничего.  Причина
// в том, что маркер показа ставится дважды: welcome.js сохраняет его ДО
// открытия экрана выборов, а сам экран шлёт ещё один POST.  Любой POST снимает
// флаг, поэтому сразу после показа он уже пуст — «следующий запуск» флаг не
// видит.  Просто поставить файл нельзя: маркер появится у того, кто уже
// смотрел, и сломает настройки.  Поэтому кнопка делает и то, и то:
// сбрасывает флаг для честного следующего запуска И сразу проигрывает
// заставку здесь, чтобы её было видно.
const WELCOME_CACHE = 'livebrowser.welcome.seen.v1';
const WELCOME_FILM_CACHE = 'livebrowser.welcome.film.v1';

function initWelcomeReplay() {
  const btn = sEl('set-welcome-replay');
  const note = sEl('set-welcome-note');
  if (!btn) return;
  btn.addEventListener('click', () => {
    try { localStorage.removeItem(WELCOME_CACHE); } catch { /* private */ }
    // Плёночный кэш — тоже: следующий запуск должен решить заново,
    // тянет ли машина живой рендер.
    try { localStorage.removeItem(WELCOME_FILM_CACHE); } catch { /* private */ }
    btn.disabled = true;
    if (note) note.textContent = 'Играем…';
    apiPost({ hideWelcome: true })
      .then(() => {
        // Модуль заставки мог не грузиться в этом сеансе вовсе: повтор
        // поднимет его сам (welcome.js), а здесь только вызов.
        if (window.LiveWelcome) return window.LiveWelcome.replay();
        return window.LiveModules?.load('welcome')
          .then(() => window.LiveWelcome?.replay());
      })
      .then(() => {
        if (note) note.textContent = 'Заставка проиграна. Вернётся и при следующем запуске';
      })
      .catch(() => {
        if (note) note.textContent = 'Не удалось сбросить — хост не ответил';
        btn.disabled = false;
      });
  });
}

function syncZoomLabel() {
  const zoom = sEl('set-zoom');
  const label = sEl('set-zoom-val');
  if (zoom && label) label.textContent = `${zoom.value}%`;
  // Filled-track position for the custom range styling (settings.css reads
  // --fill on the input; the double-position gradient paints up to it).
  if (zoom) {
    const min = Number(zoom.min);
    const max = Number(zoom.max);
    const pct = max > min ? Math.round(((Number(zoom.value) - min) / (max - min)) * 100) : 0;
    zoom.style.setProperty('--fill', `${pct}%`);
  }
}

function initControls() {
  sEl('set-anim')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    // Instant feedback, persistence follows through the debounced POST.
    document.body.classList.toggle('no-anim', !on);
    change({ animations: on });
  });

  sEl('set-tactile')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    document.body.classList.toggle('tactile-off', !on);
    change({ tactile: on });
  });

  initWelcomeReplay();

  sEl('set-cyber-scanlines')?.addEventListener('change', (e) => {
    document.body.classList.toggle('scanlines', e.target.checked);
    change({ cyberScanlines: e.target.checked });
  });
  sEl('set-cyber-glitch')?.addEventListener('change', (e) => {
    document.body.classList.toggle('glitch-max', e.target.checked);
    change({ cyberGlitch: e.target.checked });
  });

  sEl('set-search')?.addEventListener('change', (e) => change({ search: e.target.value }));

  // Проверка обновлений (портативная сборка): честный сетевой запрос к
  // официальному манифесту; сервер недоступен/нет сети — мягкое сообщение.
  const updBtn = sEl('set-update-check');
  updBtn?.addEventListener('click', async () => {
    if (updBtn.disabled) return;
    updBtn.disabled = true;
    const old = updBtn.textContent;
    updBtn.textContent = 'Проверяю…';
    const note = () => window.showToast?.('Проверка обновлений: сервер недоступен — вы на последней версии.');
    try {
      const res = await fetch('https://api.livebrowser.shell/api/update-check', {
        cache: 'no-store', signal: AbortSignal.timeout(6000),
      }).catch(() => null);
      // Релей отвечает {"update":false} (нет новой версии) или ошибкой.
      if (res && res.ok) {
        const d = await res.json().catch(() => null);
        window.showToast?.(d && d.update
          ? 'Доступна новая версия: ' + (d.version || 'см. сайт проекта')
          : 'Обновлений нет — у вас последняя версия.');
      } else note();
    } catch { note(); }
    updBtn.textContent = old;
    updBtn.disabled = false;
  });
  sEl('set-newtab')?.addEventListener('change', (e) => change({ newTab: e.target.value }));

  sEl('set-zoom')?.addEventListener('input', () => {
    syncZoomLabel();
    change({ defaultZoom: Number(sEl('set-zoom').value) / 100 });
  });

  const dlPartial = () => ({
    downloads: {
      dir: sEl('set-dl-dir')?.value ?? '',
      askEach: !!sEl('set-dl-ask')?.checked,
      autoOpen: !!sEl('set-dl-auto')?.checked,
    },
  });
  sEl('set-dl-dir')?.addEventListener('input', () => change(dlPartial()));
  sEl('set-dl-ask')?.addEventListener('change', () => change(dlPartial()));
  sEl('set-dl-auto')?.addEventListener('change', () => change(dlPartial()));

  sEl('set-export')?.addEventListener('click', exportSettings);
  sEl('set-import')?.addEventListener('click', () => sEl('set-import-file')?.click());
  sEl('set-import-file')?.addEventListener('change', importSettings);

  initOptimizeControls();
}

/* ------------------------------------------------------------------ */
/* Оптимизация: тумблеры + данные                                      */
/* ------------------------------------------------------------------ */

// /api/data/clear (POST {what}) и /api/status (GET) — см. ShellApi.cs.
const DATA_API = 'https://api.livebrowser.shell/api/data/clear';
const STATUS_API = 'https://api.livebrowser.shell/api/status';
const ADBLOCK_API = 'https://api.livebrowser.shell/api/adblock';

// Блокировка рекламы: тумблер действует сразу (хост читает флаг на каждый
// запрос), а «Обновить базу» — единственный сетевой вызов, поэтому он идёт
// только по нажатию и честно сообщает, что скачалось.
async function updateAdBlockList(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Обновляю…'; }
  try {
    const res = await fetch(ADBLOCK_API, { method: 'POST', body: '{"action":"update"}' });
    const j = await res.json();
    if (j?.ok) window.showToast?.(`Список обновлён: ${j.count} хостов`);
    else window.showToast?.('Не удалось обновить список');
    syncAdBlockCount();
  } catch {
    window.showToast?.('Не удалось обновить список');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Обновить базу'; }
  }
}

async function syncAdBlockCount() {
  const out = sEl('adblock-count');
  if (!out) return;
  try {
    const j = await (await fetch(ADBLOCK_API)).json();
    const extra = j?.extra ? ` (+${j.extra} из базы)` : '';
    out.textContent = `Встроенных хостов: ${j?.builtin ?? 0}${extra}`;
  } catch { /* счётчик — не критичная часть */ }
}

function initOptimizeControls() {
  sEl('set-bg-suspend')?.addEventListener('change', (e) => change({ backgroundSuspend: e.target.checked }));
  sEl('set-hw-accel')?.addEventListener('change', (e) => {
    change({ hardwareAccel: e.target.checked });
    window.showToast?.('Аппаратное ускорение изменится после перезапуска');
  });
  sEl('set-cache')?.addEventListener('change', (e) => change({ useCache: e.target.checked }));
  sEl('set-adblock')?.addEventListener('change', (e) => change({ adBlock: e.target.checked }));
  sEl('adblock-update')?.addEventListener('click', (e) => updateAdBlockList(e.currentTarget));
  syncAdBlockCount();
  sEl('set-bg-blur')?.addEventListener('change', (e) => {
    document.body.classList.toggle('no-blur', !e.target.checked);
    change({ backgroundBlur: e.target.checked });
  });

  sEl('clear-cache')?.addEventListener('click', () => clearData('cache'));
  sEl('clear-cookies')?.addEventListener('click', () => clearData('cookies'));
  sEl('clear-history')?.addEventListener('click', () => clearData('history'));
  sEl('clear-all')?.addEventListener('click', () => clearData('all'));
}

// Один путь на все кнопки: очистка -> тост -> обновление строки статуса.
// История есть и в собственном эндпоинте, но /api/data/clear её тоже чистит
// (DataStore.ClearAsync), так что шлём только его.
async function clearData(what) {
  try {
    const r = await fetch(DATA_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ what }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`clear HTTP ${r.status}`);
    const res = await r.json().catch(() => null);
    if (res && res.ok === false) throw new Error('host refused');
    window.showToast?.('Данные очищены');
  } catch {
    window.showToast?.('Не удалось очистить данные');
  }
  refreshStatus();
}

// Строка «История: N · Куки: M · Кеш: K МБ · Память: L МБ» из GET /api/status.
async function refreshStatus() {
  const line = sEl('opt-status');
  if (!line) return;
  try {
    const r = await fetch(STATUS_API, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`status HTTP ${r.status}`);
    const s = await r.json();
    const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
    line.textContent = `История: ${n(s.history)} · Куки: ${n(s.cookies)} · Кеш: ${n(s.cacheMb)} МБ · Память: ${n(s.memMb)} МБ`;
  } catch {
    line.textContent = 'История: — · Куки: — · Кеш: — · Память: —';
  }
}

/* ------------------------------------------------------------------ */
/* Export / import                                                     */
/* ------------------------------------------------------------------ */

async function exportSettings() {
  let data = settingsState.cached;
  if (!data) {
    try { data = await apiGet(); } catch { data = DEFAULTS; }
  }
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    window.showToast?.('Настройки экспортированы');
  } catch {
    window.showToast?.('Не удалось экспортировать настройки');
  }
}

async function importSettings() {
  const input = sEl('set-import-file');
  const file = input?.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    // The host merges and saves; send the whole object and mirror it locally.
    await apiPost(obj);
    settingsState.cached = normalize(obj);
    fill(settingsState.cached);
    window.showToast?.('Настройки импортированы');
  } catch {
    window.showToast?.('Не удалось импортировать настройки');
  }
}

/* ------------------------------------------------------------------ */
/* Page open/close                                                     */
/* ------------------------------------------------------------------ */

function overlay(open) {
  if (!window.chrome?.webview) return;
  try {
    window.chrome.webview.postMessage(JSON.stringify({
      type: 'overlay', open, height: open ? window.innerHeight : 0,
    }));
  } catch { /* host gone */ }
}

async function openPage() {
  const page = sEl('settings-page');
  if (!page) return;
  // The palette sheet and this page share the host's overlay channel: hand it
  // over cleanly (app.js's closeSettings runs on the simulated click).
  if (sEl('settings')?.hidden === false) sEl('settings-close')?.click();

  page.hidden = false;
  // Opening always starts at the top: the chips then light the first group.
  const scroll = page.querySelector('.page-scroll');
  if (scroll) {
    // Мгновенный ноль (страница только что открылась) — скролл не едет.
    if (window.LiveScroll) LiveScroll.scrollTo(scroll, 0, { instant: true });
    else scroll.scrollTop = 0;
  }
  requestAnimationFrame(() => page.classList.add('show'));
  overlay(true);
  sEl('settings-page-done')?.focus();

  // «Оптимизация»: цифры истории/куки/кеша/памяти — свежие при каждом
  // открытии страницы (запрос лёгкий, host считается по профилю).
  refreshStatus();

  // Fresh values every time the page opens; local mirror is the fallback.
  try {
    const s = await apiGet();
    settingsState.cached = normalize(s);
    fill(settingsState.cached);
  } catch {
    if (!settingsState.cached) {
      settingsState.cached = normalize(null);
      fill(settingsState.cached);
    }
  }
}

function closePage() {
  const page = sEl('settings-page');
  if (!page || page.hidden) return;
  page.classList.remove('show');
  overlay(false);
  
  setTimeout(() => { if (!page.classList.contains('show')) page.hidden = true; }, 220);
}

function initSettingsPage() {
  const versionEl = sEl('app-version');
  if (versionEl) versionEl.textContent = `LiveBrowser ${VERSION} · настройки в settings.json рядом с exe`;

  // Entry point from the palette sheet.
  sEl('open-settings-page')?.addEventListener('click', () => {
    openPage();
  });
  sEl('settings-page-close')?.addEventListener('click', closePage);
  sEl('settings-page-done')?.addEventListener('click', closePage);
  pageBackdropClose();

  // Escape closes this layer only; the sheet's own capture handler (app.js)
  // registered earlier and stays inert while the sheet is hidden.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sEl('settings-page')?.hidden === false) {
      e.stopImmediatePropagation();
      closePage();
    }
  }, true);

  initControls();
  initSectionNav();

  // Kill switch at boot: «Анимации» — стартовая настройка, а не только
  // диалоговая.  Без этого no-anim не применялся, пока пользователь не
  // откроет настройки (и GPU продолжал гонять aurora-анимации в покое).
  apiGet()
    .then((s) => { if (s) fill(normalize(s)); })
    .catch(() => { /* старый билд хоста без /api/settings: анимации по умолчанию */ });

  window.LiveSettingsPage = { open: openPage, close: closePage };
}

// Section chips: scroll the page column to a group, and keep the chip that
// matches the visible part of the column lit.  One passive scroll listener;
// the active chip is recomputed at most once per frame while scrolling.
function initSectionNav() {
  const nav = sEl('settings-nav');
  const scroller = sEl('settings-page')?.querySelector('.page-scroll');
  if (!nav || !scroller) return;
  const chips = Array.from(nav.querySelectorAll('[data-goto]'));
  const targets = chips.map((c) => sEl(c.dataset.goto)).filter(Boolean);
  if (!targets.length) return;

  const setActive = (id) => {
    chips.forEach((c) => c.classList.toggle('is-active', c.dataset.goto === id));
  };

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const el = sEl(chip.dataset.goto);
      if (!el) return;
      // LiveScroll (Lenis) едет пружинным выкатом; без него — нативный smooth.
      const target = Math.max(0, el.offsetTop - scroller.offsetTop - 8);
      if (window.LiveScroll) LiveScroll.scrollTo(scroller, target, { duration: 0.6 });
      else scroller.scrollTo({ top: target, behavior: 'smooth' });
      setActive(chip.dataset.goto);
    });
  });

  let queued = false;
  const sync = () => {
    queued = false;
    const y = scroller.scrollTop + 24;
    let best = targets[0];
    for (const t of targets) if (t.offsetTop - scroller.offsetTop <= y) best = t;
    setActive(best.id);
  };
  scroller.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sync);
  }, { passive: true });

  // A chip clicked in the hidden page is measured while the column is still
  // 0×0, so every target sits at the same offset.  The baseline is measured
  // on the first open and on every resize; the chips then keep working.
  const measure = () => {
    if (!scroller.clientHeight) return;
    sync();
  };
  new ResizeObserver(measure).observe(scroller);
  if (scroller.clientHeight) measure();
}

// Clicking the dimmed backdrop closes, clicks inside the card do not (same
// behaviour as the palette sheet).
function pageBackdropClose() {
  const page = sEl('settings-page');
  if (!page) return;
  page.addEventListener('pointerdown', (e) => {
    if (e.target === page) closePage();
  });
}

document.addEventListener('DOMContentLoaded', initSettingsPage);

})();
