// LiveBrowser NTP — clock, weather, parallax, live themes, Material You accent.
'use strict';

// Top-level names stay inside this file: the shell loads four plain scripts
// into one global scope, so an IIFE prevents `const` redeclaration crashes.
(function () {

const PALETTES = [
  { id: 'aurora', name: 'Aurora', accent: '#7c5cff', accentSoft: '#b39bff', bgA: '#12121a', bgB: '#1c1730' },
  { id: 'ocean', name: 'Ocean', accent: '#1fb6ff', accentSoft: '#7ce0ff', bgA: '#0b1622', bgB: '#0f2b3d' },
  { id: 'sunset', name: 'Sunset', accent: '#ff6b6b', accentSoft: '#ffb199', bgA: '#1a1014', bgB: '#3a1a24' },
  { id: 'forest', name: 'Forest', accent: '#2ecc71', accentSoft: '#9df5c0', bgA: '#0d1a12', bgB: '#14301f' },
  { id: 'gold', name: 'Gold', accent: '#e0a020', accentSoft: '#ffd77a', bgA: '#181410', bgB: '#33291a' },
  // Cyberpunk 2077 / Night City: не «цвет акцента», а целая кожа —
  // [data-theme="cyberpunk"] в app.css (void black, жёлтый/циан/магента,
  // 0 скруглений, моно-шрифты, scanlines).  cyber:true включает её только
  // в тёмном режиме; accentSoft здесь — циан (кромка шторы, hover-обводки).
  { id: 'night-city', name: 'Night City', accent: '#fcee09', accentSoft: '#00f0ff', bgA: '#0a0a0a', bgB: '#1a1a1a', cyber: true },
];

const app = {
  currentTheme: PALETTES[0],
  paletteIndex: 0,
  accentPinned: false, // true once a site/favicon colour takes over
  mode: 'dark',        // 'dark' | 'light' — data-theme on <html>
  searchMenuOpen: false, // gear popover (local or native panel over a site)
};

const sEl = (id) => document.getElementById(id);

// True when the page runs inside the C# host (WebView2 bridge present).
function inHost() {
  return !!(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
}

/* ------------------------------------------------------------------ */
/* Bridge shim                                                         */
/* ------------------------------------------------------------------ */

// UI -> host.  Every message is a JSON string on the WebView2 channel.
function postToHost(msg) {
  if (!inHost()) return false;
  try {
    window.chrome.webview.postMessage(JSON.stringify(msg));
    return true;
  } catch (err) {
    return false;
  }
}

const THEME_KEY = 'livebrowser.theme';

// Without a host (plain browser / file://) theme lives in localStorage and
// sites open as real windows so the shell stays testable.
const fallbackBridge = {
  openTab: (url) => { window.open(url, '_blank', 'noopener'); },
  saveTheme: (theme) => {
    try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch { /* private mode */ }
    return Promise.resolve();
  },
  loadTheme: () => Promise.resolve(JSON.parse(localStorage.getItem(THEME_KEY) || 'null')),
};

// Host bridge.  Theme goes through the host's /api/theme endpoint; the
// postMessage "theme" message keeps older hosts in sync too.
const hostBridge = {
  openTab: (url, label) => {
    postToHost({ type: 'open', url, label: label || '' });
  },
  // One write path: /api/theme in the host.  The WebView2 storage quota is
  // small, so the page must not also mirror the theme into localStorage.
  // The same JSON also goes over the bridge so the native window frame and
  // the site views behind the page follow the dark/light mode live.
  saveTheme: (theme) => {
    postToHost({ type: 'theme', mode: theme.mode || 'dark', theme: JSON.stringify(theme) });
    return fetch('https://api.livebrowser.shell/api/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(theme),
      signal: AbortSignal.timeout(4000),
    }).then((r) => { if (!r.ok) throw new Error(`theme HTTP ${r.status}`); });
  },
  loadTheme: () => fetch('https://api.livebrowser.shell/api/theme',
    { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null),
};

window.__livebrowser = inHost() ? hostBridge : fallbackBridge;
const bridge = window.__livebrowser;

/* ------------------------------------------------------------------ */
/* Theming                                                             */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Blends two #rrggbb colours; t is the weight of b (0..1).
function mixHex(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const ch = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  l /= 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// The palette's backgrounds are designed for the dark desk; in light mode the
// same hues are lifted towards near-white so the desk matches the light bar
// and panels instead of staying black under white cards.
function applyBackground(theme) {
  const root = document.documentElement.style;
  const light = theme.mode === 'light';
  root.setProperty('--bg-a', light ? mixHex(theme.bgA, '#f5f6fa', 0.88) : theme.bgA);
  root.setProperty('--bg-b', light ? mixHex(theme.bgB, '#e9ecf5', 0.72) : theme.bgB);
}

function applyTheme(theme) {
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--accent-soft', theme.accentSoft);
  applyBackground(theme);
  // Тема ставится ДО setMode: его apply() читает currentTheme.cyber, чтобы
  // выбрать data-theme="cyberpunk" вместо "dark".
  app.currentTheme = theme;
  window.liveBrowserTheme = theme;
  // Хосту нужен акцент темы для «шторы» (нативный занавес).  hex2 — второй
  // цвет (в Night City это циановая кромка), cyber — резкие края и сканлайны.
  postToHost({ type: 'accent', hex: theme.accent, hex2: theme.accentSoft, cyber: !!theme.cyber });
  // Dark/light is a separate axis: the same accent works on both surfaces.
  setMode(theme.mode === 'light' ? 'light' : 'dark', false);
  syncSwatches();
}

// Flips the whole shell (bar, panels, bubbles) between dark and light.  The
// host is told as well so the native window frame and the site views behind
// the shell match instead of flashing dark corners around a light UI.
// A user-initiated switch (persist=true) gets a View Transition cross-fade
// when the engine supports it; engines without the API get a 180ms colour
// glide via a temporary html.theme-anim class (app.css).  The no-anim kill
// switch and the OS reduce-motion preference always get the instant path,
// and boot-time restoration stays instant too (persist=false).
let themeAnimTimer = 0;

function setMode(mode, persist = true) {
  const light = mode === 'light';
  const apply = () => {
    // Night City живёт только в тёмном режиме: пока активна кибер-палитра,
    // data-theme="cyberpunk" вместо "dark" (вся кожа — в app.css).  Светлая
    // тема при этом отступает стандартной светло-палитре; возврат в тёмную
    // возвращает кожу.
    const cyber = !light && app.currentTheme && app.currentTheme.cyber;
    document.documentElement.dataset.theme = light ? 'light' : (cyber ? 'cyberpunk' : 'dark');
    app.mode = light ? 'light' : 'dark';
    // Re-announce the accent for the NEW mode: the host derives the curtain's
    // cyber look from (accent.cyber && dark), and those two messages can race
    // — the accent posted by applyTheme used to win with the OLD mode, leaving
    // the sweep in the previous look until the next palette change.
    if (app.currentTheme) {
      postToHost({
        type: 'accent',
        hex: app.currentTheme.accent,
        hex2: app.currentTheme.accentSoft,
        cyber,
      });
    }
    if (persist) {
      const theme = { ...app.currentTheme, mode: app.mode };
      app.currentTheme = theme;
      window.liveBrowserTheme = theme;
      applyBackground(theme);
      saveTheme({ ...theme, paletteIndex: app.paletteIndex });
    }
    syncModeSwitch();
  };
  const animate = persist && !motionOff();
  if (animate && typeof document.startViewTransition === 'function') {
    // Primary path: the engine snapshots the page and cross-fades (0.22s,
    // see ::view-transition-* rules in app.css).
    document.startViewTransition(apply);
  } else if (animate) {
    // Fallback: a temporary class lets the key surfaces glide between the
    // palettes; removed right after so it never lingers or leaks into the
    // View Transition path.
    const root = document.documentElement;
    root.classList.add('theme-anim');
    apply();
    clearTimeout(themeAnimTimer);
    themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 240);
  } else {
    apply();
  }
}

function toggleMode() {
  setMode(app.mode === 'light' ? 'dark' : 'light');
}

function saveTheme(theme) {
  Promise.resolve(bridge.saveTheme(theme)).catch(() => {
    /* Persisting is best-effort; the UI stays themed either way. */
  });
}

// Material You-ish: keep the hue, normalise saturation/lightness to a
// readable accent regardless of how washed out the source colour was.
function accentFromColor(hex) {
  const [h, s] = rgbToHsl(...hexToRgb(hex));
  return {
    accent: hslToHex(h, Math.max(55, Math.min(s, 85)), 62),
    accentSoft: hslToHex(h, Math.max(45, Math.min(s, 80)), 80),
  };
}

function setPalette(i, persist) {
  const base = PALETTES[(i + PALETTES.length) % PALETTES.length];
  app.paletteIndex = PALETTES.indexOf(base);
  app.accentPinned = false;
  // Night City — тёмная кожа: выбранная из светлого режима, она уводит
  // поверхность в dark, иначе её token set просто не включится.
  if (base.cyber && app.mode === 'light') app.mode = 'dark';
  // A palette only swaps the accent; the surface mode is the user's choice.
  applyTheme({ ...base, mode: app.mode });
  if (persist !== false) saveTheme({ ...base, paletteIndex: app.paletteIndex });
}

// QA hook: switch palette by id from the host (selftest / probe only).
window.__lbSetPalette = function (id) {
  const i = PALETTES.findIndex((p) => p.id === id);
  if (i < 0) return false;
  setPalette(i);
  return true;
};
window.__lbPalettes = PALETTES;

function randomPalette() {
  // Never land on the palette already showing.
  let next = app.paletteIndex;
  while (next === app.paletteIndex) next = Math.floor(Math.random() * PALETTES.length);
  setPalette(next);
  return PALETTES[next];
}

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

// Time of day drives the desktop's mood (see "Living desktop" in app.css).
// Four phases, repainted on the existing blobs: no extra layers, no timers.
// Writing the attribute only when it actually changes keeps the 1s clock
// from restyling the page every tick.
function skyPhase(h) {
  if (h >= 5 && h < 9) return 'dawn';
  if (h >= 9 && h < 17) return 'day';
  if (h >= 17 && h < 21) return 'dusk';
  return 'night';
}

function applySkyPhase(now) {
  const phase = skyPhase(now.getHours());
  if (document.body.dataset.phase !== phase) document.body.dataset.phase = phase;
}

// Циферблат по спанам: смена цифры — мягкий тик (clock-tick в app.css),
// а не мгновенная подмена текста.  Ширина цифр держится tabular-nums,
// поэтому соседи не дёргаются.  Спаны пересобираются только при смене
// длины строки (локаль/полночь) — в обычный минутный тик пишется один-два
// textContent и не больше пары анимаций.
function renderClock(el, text) {
  if (!el) return;
  if (el.__lbClockText === text) return;
  el.__lbClockText = text;
  const chars = [...text];
  if (!Array.isArray(el.__lbClockDigits) || el.__lbClockDigits.length !== chars.length) {
    el.__lbClockDigits = chars.map((ch) => {
      const s = document.createElement('span');
      s.className = 'clock-d';
      s.textContent = ch;
      return s;
    });
    el.replaceChildren(...el.__lbClockDigits);
    return;
  }
  const animate = !motionOff();
  chars.forEach((ch, i) => {
    const s = el.__lbClockDigits[i];
    if (s.textContent === ch) return;
    s.textContent = ch;
    if (!animate) return;
    s.classList.remove('tick');
    void s.offsetWidth; // рестарт, если цифра меняется чаще кадра
    s.classList.add('tick');
    s.addEventListener('animationend', () => s.classList.remove('tick'), { once: true });
  });
}

function tick() {
  const now = new Date();
  renderClock(sEl('clock'), now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const dEl = sEl('date');
  if (dEl) {
    const dtext = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    if (dEl.textContent !== dtext) dEl.textContent = dtext;
  }
  applySkyPhase(now);
}

// Open-Meteo WMO codes -> the four buckets app.css knows about.
const SKY_BUCKETS = ['clear', 'cloudy', 'overcast', 'rain', 'snow'];

function skyCondition(code) {
  if (code == null) return 'clear';
  // Accept a bucket name as well as a WMO number: LiveUi.setSky is a public
  // hook, and the manual settings pass the word ("rain"), not the code.
  if (typeof code === 'string') return SKY_BUCKETS.includes(code) ? code : 'clear';
  if (code >= 95) return 'rain';                      // thunderstorm
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code === 45 || code === 48) return 'overcast';  // fog
  if (code === 3) return 'overcast';
  if (code === 2) return 'cloudy';
  return 'clear';
}

function applySkyCondition(code) {
  const cond = skyCondition(code);
  if (document.body.dataset.sky !== cond) document.body.dataset.sky = cond;
  return cond;
}

/* ------------------------------------------------------------------ */
/* Weather (Open-Meteo, no API key)                                    */
/* ------------------------------------------------------------------ */

const WEATHER_ICONS = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌦️', 61: '🌧️', 63: '🌧️', 65: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '❄️', 80: '🌧️', 81: '🌧️', 82: '⛈️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

// Карточка погоды перелистывается каскадом (wx-swap в app.css) при каждом
// обновлении — и при данных, и при «нет данных»: появление текста никогда
// не мгновенное.  Класс снимается по animationend последнего ребёнка
// (страховочный таймер — под no-anim).
function swapWeather() {
  const wx = sEl('weather');
  if (!wx || motionOff()) return;
  wx.classList.remove('wx-swap');
  void wx.offsetWidth;
  wx.classList.add('wx-swap');
  const done = () => wx.classList.remove('wx-swap');
  wx.lastElementChild?.addEventListener('animationend', done, { once: true });
  setTimeout(done, 600);
}

// The host knows the machine's time zone, and its city is usually the
// right one even behind a VPN; IP geolocation is only the fallback.
// (A host answer without coordinates is ignored: Open-Meteo then gets the
// default city instead of a request without lat/lon.)
const DEFAULT_LOCATION = { lat: 55.7558, lon: 37.6173 };
// Координаты последнего удачного прогноза — куда ведёт клик по карточке.
let weatherTarget = DEFAULT_LOCATION;
// Карточка погоды теперь живая ссылка (hover-подъём был с Wave 8, клика не
// было — ложный аффорданс).  Яндекс.Погода по координатам прогноза.
function bindWeatherClick() {
  const wx = sEl('weather');
  if (!wx || wx.__lbWxClick) return;
  wx.__lbWxClick = true;
  wx.addEventListener('click', () => {
    const { lat, lon } = weatherTarget || DEFAULT_LOCATION;
    const url = `https://yandex.ru/pogoda/?lat=${lat}&lon=${lon}`;
    if (window.LiveTabs) window.LiveTabs.open(url, 'Погода');
    else bridge.openTab(url, 'Погода');
  });
}
async function loadWeather() {
  const tempEl = sEl('weather-temp');
  const descEl = sEl('weather-desc');
  const iconEl = sEl('weather-icon');

  let place = null;
  // Outside WebView2 the api.livebrowser.shell host does not resolve at all,
  // so the request is skipped instead of waiting for a DNS timeout.
  if (inHost()) {
    try {
      const fromHost = await fetch('https://api.livebrowser.shell/api/where',
        { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (fromHost && typeof fromHost.lat === 'number' && typeof fromHost.lon === 'number') place = fromHost;
    } catch { /* host api unavailable: use the default city */ }
  }
  if ((!place || place.lat == null) && !inHost()) {
    try {
      const geo = await fetch('https://ipapi.co/json/').then((r) => r.json());
      if (typeof geo.latitude === 'number') place = { lat: geo.latitude, lon: geo.longitude, city: geo.city };
    } catch { /* offline */ }
  }

  try {
    // One `timezone` parameter only: Open-Meteo rejects a URL that names it
    // twice, so the default branch must not repeat it.
    const q = place?.lat != null && place?.lon != null
      ? `latitude=${place.lat}&longitude=${place.lon}`
      : `latitude=${DEFAULT_LOCATION.lat}&longitude=${DEFAULT_LOCATION.lon}`;
    window.__wq = q + ' place=' + JSON.stringify(place);
    const data = await fetch(`https://api.open-meteo.com/v1/forecast?${q}` +
      '&current=temperature_2m,weather_code&timezone=auto').then((r) => {
      if (!r.ok) throw new Error(`weather HTTP ${r.status}`);
      return r.json();
    });

    const t = Math.round(data.current.temperature_2m);
    iconEl.textContent = WEATHER_ICONS[data.current.weather_code] || '🌡️';
    tempEl.textContent = `${t}°`;
    descEl.textContent = place?.city || 'сейчас';
    // Куда ведёт клик по карточке (m6: ложный аффорданс → живая ссылка).
    weatherTarget = {
      lat: place?.lat ?? DEFAULT_LOCATION.lat,
      lon: place?.lon ?? DEFAULT_LOCATION.lon,
    };
    const cond = applySkyCondition(data.current.weather_code);
    swapWeather();
    window.__wstage = 'ok temp=' + tempEl.textContent + ' sky=' + cond + ' url=' + q;
  } catch (err) {
    window.__wstage = 'err ' + (err && err.stack || err) + ' q=' + (window.__wq || '');
    // Offline or the API is down: keep the card calm instead of showing a
    // broken satellite emoji next to "--°".
    iconEl.textContent = '☁️';
    tempEl.textContent = '--°';
    descEl.textContent = 'нет данных';
    swapWeather();
    // Offline: leave the desktop neutral rather than guessing a weather.
    applySkyCondition(null);
  }
}

/* ------------------------------------------------------------------ */
/* Parallax — one rAF loop, depth-scaled translate3d                   */
/* ------------------------------------------------------------------ */

// 3D-наклон hero и плиток — ПЛАВНЫЙ непрерывный (без квантования:
// квантованные ступени = мгновенные скачки = твитч).  Мыло тексту даёт
// только ДРОБНЫЙ сдвиг, поэтому translate всегда целыми пикселями, а
// rotation едет непрерывно (перерисовка под плавно меняющимся углом
// выглядит как честное 3D, а не как дрожь).  Плитки (#links) БЕЗ наклона и
// слежения: 3D-трекинг за курсором и магнит осуждены пользователем («некрасиво»)
// и сняты совсем — плитки статичны, живут только спокойный hover-подъём
// (-2px) и тень.  Параллакс остаётся только у hero.
const TILT_MAX = 2.4;

function initParallax() {
  const layers = Array.from(document.querySelectorAll('[data-depth]'));
  const tiltEl = document.querySelector('.hero');
  let targetX = 0, targetY = 0, curX = 0, curY = 0, running = false;

  function frame() {
    const quiet = document.body.classList.contains('no-anim')
      || document.body.classList.contains('tactile-off')
      || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (quiet) {
      for (const el of layers) el.style.transform = '';
      if (tiltEl) tiltEl.style.transform = '';
      running = false;
      return;
    }
    curX += (targetX - curX) * 0.08;
    curY += (targetY - curY) * 0.08;
    for (const el of layers) {
      const d = parseFloat(el.dataset.depth) || 0;
      if (!d) continue; // depth removed (e.g. the omnibox moved to the bar)
      if (el === tiltEl) {
        const rx = Math.max(-TILT_MAX, Math.min(TILT_MAX, -curY * TILT_MAX));
        const ry = Math.max(-TILT_MAX, Math.min(TILT_MAX, curX * TILT_MAX));
        el.style.transform =
          `translate3d(${Math.round(curX * d * 14)}px, ${Math.round(curY * d * 14)}px, 0) ` +
          `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
        continue;
      }
      el.style.transform =
        `translate3d(${Math.round(curX * d * 14)}px, ${Math.round(curY * d * 14)}px, 0)`;
    }
    const settled = Math.abs(targetX - curX) < 0.001
      && Math.abs(targetY - curY) < 0.001;
    if (!settled) {
      requestAnimationFrame(frame);
    } else {
      running = false;
    }
  }

  window.addEventListener('mousemove', (e) => {
    targetX = (e.clientX / window.innerWidth - 0.5) * 2;
    targetY = (e.clientY / window.innerHeight - 0.5) * 2;
    if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Quick links + omnibox                                               */
/* ------------------------------------------------------------------ */

// Six tiles fill one row at the default window width; keep it at six so the
// row never wraps into a lonely second tile.
const LINKS = [
  { name: 'YouTube', url: 'https://youtube.com', color: '#ff0033' },
  { name: 'GitHub', url: 'https://github.com', color: '#24292f' },
  { name: 'Wikipedia', url: 'https://ru.wikipedia.org', color: '#3a6ea5' },
  { name: 'Reddit', url: 'https://reddit.com', color: '#ff4500' },
  { name: 'Steam', url: 'https://store.steampowered.com', color: '#1b2838' },
  { name: 'Хабр', url: 'https://habr.com', color: '#629f43' },
];

/* --- Пользовательские быстрые вкладки -----------------------------------
   Плитки после дефолтных: [{name, url}], живут в settings.json хоста
   (поле quickLinks — пишет POST /api/settings, читает GET; слияние и
   чистка битых записей — в SettingsStore.cs).  Вне хоста список лежит в
   localStorage (ключ lb_quicklinks), чтобы страница оставалась
   работоспособной в обычном браузере.  Лимит 12: стрип не должен
   превращаться в решётку из трёх рядов. --- */
const SETTINGS_API = 'https://api.livebrowser.shell/api/settings';
const QUICKLINKS_KEY = 'lb_quicklinks';
const QUICKLINKS_MAX = 12;

let userLinks = []; // [{name, url}]

// Приводим сохранённый список к форме [{name, url}]: мусор выбрасывается,
// хвост обрезается по лимиту — битый settings.json не ломает рабочий стол.
function sanitizeLinks(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name || '').trim();
    const url = String(it.url || '').trim();
    if (!name || !url) continue;
    if (out.length >= QUICKLINKS_MAX) break;
    out.push({ name, url });
  }
  return out;
}

function readLocalLinks() {
  try { return sanitizeLinks(JSON.parse(localStorage.getItem(QUICKLINKS_KEY) || '[]')); }
  catch { return []; }
}

// Загрузка: в хосте — GET /api/settings (как loadTheme выше), без хоста или
// при ошибке — localStorage.  Дефолтные плитки уже нарисованы, поэтому
// приехавший список просто дорисовывается повторным renderLinks.
function loadUserLinks() {
  if (!inHost()) {
    userLinks = readLocalLinks();
    renderLinks(true);
    return;
  }
  fetch(SETTINGS_API, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    .then((r) => { if (!r.ok) throw new Error(`settings HTTP ${r.status}`); return r.json(); })
    .then((s) => {
      userLinks = sanitizeLinks(s && Array.isArray(s.quickLinks) ? s.quickLinks : []);
      renderLinks(true);
      scheduleIdle(fetchMissingFavicons, 300);
    })
    .catch(() => {
      // Хост недоступен (старый билд / страница в обычном браузере).
      userLinks = readLocalLinks();
      renderLinks(true);
      scheduleIdle(fetchMissingFavicons, 300);
    });
}

// Сохранение — тем же паттерном, что settings.js: POST с частичным JSON,
// таймаут 4 с, проверка r.ok, тост при провале.  Массив уходит ЦЕЛИКОМ:
// хост заменяет им прежний (SettingsStore.SanitizeQuickLinks вычищает
// битые записи на своей стороне).
function saveUserLinks(list) {
  userLinks = sanitizeLinks(list);
  if (inHost()) {
    fetch(SETTINGS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickLinks: userLinks }),
      signal: AbortSignal.timeout(4000),
    })
      .then((r) => { if (!r.ok) throw new Error(`settings HTTP ${r.status}`); })
      .catch(() => {
        // Хост не принял: дублируем в localStorage, чтобы плитки не пропали.
        try { localStorage.setItem(QUICKLINKS_KEY, JSON.stringify(userLinks)); } catch { /* private mode */ }
        window.showToast?.('Не удалось сохранить вкладки');
      });
    return;
  }
  try { localStorage.setItem(QUICKLINKS_KEY, JSON.stringify(userLinks)); } catch { /* private mode */ }
}

// Цвет точки пользовательской плитки — детерминированный по имени (простая
// хеш-функция): стрип выглядит разнородным, как у дефолтов, но цвет не
// приходится хранить в JSON.
function linkColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 42%)`;
}

// Одна фабрика плиток: дефолты и пользовательские отличаются цветом точки
// и наличием «×»; клик ведёт сайт одинаково — через хост или window.open.
// Иконка: реальный favicon из кэша (lb_fav_<host>), буква — запаска, когда
// иконки ещё нет (подтянется через fetchMissingFavicons и следующий рендер).
function buildLinkTile(link, removable) {
  const a = document.createElement('a');
  a.className = 'link-tile';
  a.href = '#';
  a.title = link.url;
  a.dataset.flipKey = link.url;

  const fav = typeof window.__lbFavicon === 'function' ? window.__lbFavicon(link.url) : null;
  const dot = document.createElement('span');
  dot.className = 'link-dot';
  if (fav) {
    dot.style.background = 'transparent';
    const img = document.createElement('img');
    img.className = 'link-dot-img';
    img.alt = '';
    img.draggable = false;
    img.src = fav;
    dot.appendChild(img);
  } else {
    dot.style.background = removable ? linkColor(link.name) : link.color;
    dot.textContent = link.name.charAt(0);
  }

  const label = document.createElement('span');
  label.textContent = link.name;

  a.append(dot, label);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    // The host opens the site as one of its tabs; search.js is not needed.
    if (window.LiveTabs) window.LiveTabs.open(link.url, link.name);
    else bridge.openTab(link.url, link.name);
  });

  if (removable) {
    a.style.position = 'relative'; // якорь для «×» (span.ql-del из ql-style)
    const del = document.createElement('span');
    del.className = 'ql-del';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', `Убрать ${link.name}`);
    del.title = 'Убрать вкладку';
    del.textContent = '×';
    // Удаление сразу сохраняет список; stopPropagation не даёт плитке
    // открыть сайт, preventDefault — перейти по href="#".
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      saveUserLinks(userLinks.filter((l) => l !== link));
      renderLinks(true); // без каскада: FLIP догоняет соседей
    });
    a.appendChild(del);
  }
  return a;
}

// Дозагрузка иконок для плиток без favicon: хост-релей /api/favicon тянет
// иконку сайта (и origin/favicon.ico), ответ кешируется в lb_fav_<host>.
// Один тихий проход после бута + после пользовательских плиток; ошибки и
// оффлайн — просто буквы, как раньше.
function fetchMissingFavicons() {
  if (!inHost()) return;
  const targets = [...LINKS, ...userLinks]
    .filter((l) => l && l.url && !window.__lbFavicon(l.url));
  let pending = targets.length;
  if (!pending) return;
  let dirty = false;
  for (const link of targets) {
    const u = 'https://api.livebrowser.shell/api/favicon?u=' + encodeURIComponent(link.url);
    fetch(u, { credentials: 'omit', signal: AbortSignal.timeout(7000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.favicon && window.__lbFaviconSave(link.url, d.favicon)) dirty = true;
      })
      .catch(() => { /* оффлайн: буквы остаются */ })
      .finally(() => {
        pending -= 1;
        if (pending === 0 && dirty) renderLinks(true); // тихий ререндер с логотипами
      });
  }
}

// Плитка «+» в конце стрипа — открывает форму добавления (openAddForm).
function buildAddTile() {
  const a = document.createElement('a');
  a.className = 'link-tile link-add';
  a.href = '#';
  a.title = 'Добавить вкладку';
  a.setAttribute('aria-label', 'Добавить вкладку');

  const plus = document.createElement('span');
  plus.className = 'link-dot';
  // Стили инлайном: app.css правят параллельно, своим классам там взяться
  // неоткуда; база — класс .link-dot, чтобы плитка была соразмерна соседним.
  plus.style.cssText =
    'display:grid;place-items:center;font-size:18px;font-weight:600;line-height:1;' +
    'color:var(--accent);background:var(--field-hover, rgba(255,255,255,0.10));';
  plus.textContent = '+';

  a.appendChild(plus);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    if (userLinks.length >= QUICKLINKS_MAX) {
      window.showToast?.('Максимум 12');
      return;
    }
    openAddForm();
  });
  return a;
}

// silent: перерисовка без каскада (повторный вызов при буте —
// loadUserLinks дорисовывает пользовательские плитки поверх уже
// выкатившегося стрипа; раньше каскад переигрывался дважды).
// soloUrl: при silent — единственная плитка с этим URL играет вход
// (добавление через «+»: новая плитка выкатывается, стрип не переигрывает).
function renderLinks(silent, soloUrl) {
  const host = sEl('links');
  if (!host) return;
  // Позиции плиток ДО перерисовки — для FLIP соседей при удалении
  // (без него остаток стрипа прыгает влево мгновенно).
  const before = silent
    ? new Map([...host.children].filter((el) => el.classList.contains('link-tile'))
      .map((el) => [el.dataset.flipKey || el.textContent, el.offsetLeft]))
    : null;
  host.replaceChildren(); // полная перерисовка: ни дублей, ни старых слушателей
  // Каскадный вход: стрип тихо проявляется волной (ступень 30мс, шапка
  // 10 шагов).  Спокойная анимация по решению пользователя — без scale и
  // перелётов.  Каналы translate/opacity — transform больше не занят
  // наклоном (плитки статичны), но каналы не смешиваем из принципа.
  const quiet = document.body.classList.contains('no-anim')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let i = 0;
  const add = (tile, link) => {
    host.appendChild(tile);
    const solo = silent && soloUrl && link && link.url === soloUrl;
    if (!quiet && (!silent || solo)) {
      tile.classList.add('tile-in');
      tile.style.animationDelay = (!silent || solo) ? '0ms' : `${Math.min(i, 10) * 30}ms`;
      tile.addEventListener('animationend', () => {
        tile.classList.remove('tile-in'); // hover-каналы свободны после входа
        tile.style.animationDelay = '';
      }, { once: true });
    }
    i++;
  };
  for (const link of LINKS) add(buildLinkTile(link, false), null);
  for (const link of userLinks) add(buildLinkTile(link, true), link);
  add(buildAddTile(), { url: '#' });
  // FLIP соседей при silent-перерисовке (удаление плитки «×»): узлы новые,
  // поэтому ключ — текст плитки (имя+URL уникальны в стрипе).
  if (before && before.size) {
    const moves = [];
    for (const el of host.children) {
      if (!el.classList.contains('link-tile')) continue;
      const prev = before.get(el.dataset.flipKey || el.textContent);
      if (prev == null) continue;
      const delta = prev - el.offsetLeft;
      if (delta) moves.push([el, delta]);
    }
    if (moves.length) {
      for (const [el, delta] of moves) {
        el.style.transition = 'none';
        el.style.transform = `translateX(${delta}px)`;
        el.style.willChange = 'transform';
      }
      void host.offsetWidth; // зафиксировать стартовый кадр
      for (const [el, delta] of moves) {
        el.style.transition = 'transform 180ms cubic-bezier(0.3,1.22,0.42,1)';
        el.style.transform = 'none';
        const my = (el.__lbTileFlip = (el.__lbTileFlip || 0) + 1);
        const done = () => {
          if (el.__lbTileFlip !== my) return;
          el.style.transition = '';
          el.style.transform = '';
          el.style.willChange = '';
        };
        el.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 250);
      }
    }
  }
}

/* --- Форма добавления вкладки -------------------------------------------
   Инлайн-карточка под стрипом плиток (последний ребёнок #links: стрип —
   flex-wrap, карточка шириной в строку и центрируется margin'ами, поэтому
   всегда встаёт под плитками по центру).  Стили целиком в JS: инлайн-
   атрибуты плюс один динамический <style> для @keyframes и hover-«×»
   (инлайном hover не сделать). --- */

// Динамический <style> создаётся один раз на жизнь страницы.
function ensureQlStyles() {
  if (sEl('ql-style')) return;
  const st = document.createElement('style');
  st.id = 'ql-style';
  st.textContent = [
    // Появление карточки: подъём + fade, как у остальных поповеров шелла.
    '@keyframes ql-form-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
    // Исход: уезд вниз + fade (ставит инлайном closeQlForm).
    '@keyframes ql-form-out { to { opacity: 0; transform: translateY(6px); } }',
    // «×» на пользовательской плитке виден на hover и с клавиатуры.
    '.ql-del { display: none; position: absolute; top: -7px; right: -7px; width: 17px; height: 17px;',
    '  border-radius: 50%; background: var(--panel-strong, #262633); color: var(--text, #fff);',
    '  border: 1px solid var(--glass-border, rgba(255,255,255,0.14)); font-size: 11px; line-height: 15px;',
    '  text-align: center; cursor: pointer; user-select: none; font-weight: 700; z-index: 1; }',
    '.link-tile:hover .ql-del, .link-tile:focus-within .ql-del { display: block; }',
    // Кил-свитч «Анимации» и prefers-reduced-motion: без анимации входа.
    'body.no-anim #ql-form { animation: none; }',
    '@media (prefers-reduced-motion: reduce) { #ql-form { animation: none; } }',
  ].join('\n');
  document.head.appendChild(st);
}

// «example.com» -> «https://example.com»; схема уже есть — оставляем, но
// не-http(s) схемы (javascript:, file:) во вкладки не пускаем.
function normalizeQuickUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
  } catch { return null; }
}

// Закрытие тоже анимируется: карточка уезжает вниз с fade.  Инлайн
// animation, потому что у формы вход-анимация уже инлайном (стили формы
// живут в JS — ensureQlStyles) и таблица её не перебьёт.
function closeQlForm() {
  const f = sEl('ql-form');
  if (!f) return;
  if (motionOff()) { f.remove(); return; }
  f.style.animation = 'ql-form-out .16s ease both';
  f.style.pointerEvents = 'none';
  const done = () => f.remove();
  f.addEventListener('animationend', (e) => {
    if (e.animationName === 'ql-form-out') done();
  }, { once: true });
  setTimeout(done, 200); // страховка
}

function openAddForm() {
  ensureQlStyles();
  const host = sEl('links');
  if (!host) return;
  const open = sEl('ql-form');
  if (open) { open.querySelector('input')?.focus(); return; } // уже открыта

  const card = document.createElement('form');
  card.id = 'ql-form';
  card.style.cssText =
    'flex:0 1 auto;width:100%;max-width:460px;margin:6px auto 0;padding:12px 14px;' +
    'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;' +
    'border-radius:var(--radius-lg, 12px);background:var(--tile-bg, rgba(255,255,255,0.05));' +
    'border:1px solid var(--glass-border, rgba(255,255,255,0.14));' +
    'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);' +
    'box-shadow:0 10px 28px rgba(0,0,0,0.28);color:var(--text, #fff);font-size:13px;' +
    'animation:ql-form-in 0.18s ease;';

  const inputStyle =
    'flex:1 1 150px;min-width:130px;padding:8px 10px;border-radius:10px;' +
    'border:1px solid var(--glass-border, rgba(255,255,255,0.14));' +
    'background:var(--field, rgba(255,255,255,0.05));color:var(--text, #fff);' +
    'font:inherit;outline:none;';

  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Название';
  name.maxLength = 40;
  name.setAttribute('aria-label', 'Имя вкладки');
  name.style.cssText = inputStyle;

  const url = document.createElement('input');
  url.type = 'text';
  url.placeholder = 'example.com';
  url.setAttribute('aria-label', 'Адрес сайта');
  url.style.cssText = inputStyle;
  // type="url" слишком строг к «example.com», поэтому проверка своя
  // (normalizeQuickUrl ниже), а не нативная валидация формы.

  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.textContent = 'Добавить';
  ok.style.cssText =
    'padding:8px 14px;border-radius:10px;border:0;background:var(--accent);' +
    'color:var(--on-accent, #fff);font:inherit;font-weight:600;cursor:pointer;flex:0 0 auto;';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Отмена';
  cancel.style.cssText =
    'padding:8px 14px;border-radius:10px;' +
    'border:1px solid var(--glass-border, rgba(255,255,255,0.14));' +
    'background:var(--field-hover, rgba(255,255,255,0.10));color:var(--text, #fff);' +
    'font:inherit;cursor:pointer;flex:0 0 auto;';
  cancel.addEventListener('click', closeQlForm);

  // Enter сабмитит форму (нативный submit), Esc закрывает: фокус почти
  // всегда в полях, поэтому слушателя на самой карточке достаточно.
  card.addEventListener('submit', (e) => {
    e.preventDefault();
    const nname = name.value.trim();
    const nurl = normalizeQuickUrl(url.value);
    if (!nname || !nurl) {
      // Красная рамка + микро-шейк: ошибка видна и ощутима там, где вводили.
      const bad = !nname ? name : url;
      bad.style.borderColor = '#ff6b6b';
      bad.focus();
      window.LiveFeel?.shake?.(bad);
      return;
    }
    if (userLinks.length >= QUICKLINKS_MAX) {
      window.showToast?.('Максимум 12');
      closeQlForm();
      return;
    }
    saveUserLinks([...userLinks, { name: nname, url: nurl }]);
    closeQlForm();
    renderLinks(true, nurl);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeQlForm();
  });
  // Красная рамка сбрасывается, как только поле снова трогают.
  for (const inp of [name, url]) {
    inp.addEventListener('input', () => { inp.style.borderColor = ''; });
  }

  card.append(name, url, ok, cancel);
  host.appendChild(card);
  name.focus();
}

// Checks whether `s` looks like a hostname (has a dot and no spaces) so we
// can treat it as a URL instead of a search query.
function aLooksLikeHost(s) {
  return /^[^\s]+\.[^\s]+$/.test(s) && !s.includes('/');
}

// Fallback typing path for when search.js has not taken over the omnibox.
function aNavigate(input) {
  const raw = input.trim();
  if (!raw) return;
  const isUrl = aLooksLikeHost(raw) || raw.includes('://');
  const url = isUrl
    ? (raw.includes('://') ? raw : `https://${raw}`)
    : `https://yandex.ru/search/?text=${encodeURIComponent(raw)}`;
  if (window.LiveTabs) window.LiveTabs.open(url, raw);
  else bridge.openTab(url, raw);
}

/* ------------------------------------------------------------------ */
/* Command surface                                                     */
/* ------------------------------------------------------------------ */

// The bar is either the tab strip (switching pages) or the omnibox
// (typing).  Fuzzy searches contain no "://" and no dot, so they can't be
// mistaken for a site.
function initChromeBar() {
  const bar = sEl('chrome-bar');
  const slot = sEl('bar-omni');
  const omni = sEl('ntp-omnibox');
  if (!bar || !slot || !omni) return;
  slot.hidden = false;
  slot.appendChild(omni);
  // The omnibox no longer lives on the parallax stage: once it sits in the
  // bar it must not drift with the mouse, or it visually detaches from the
  // native dropdown layer, whose rect is measured from its position.
  omni.removeAttribute('data-depth');
  omni.style.transform = '';
  setBarMode('tabs');
  sEl('search').value = '';
  // The two side clusters keep their size across modes, but zoom and a window
  // resize change them: re-balance from the live geometry.  One observer for
  // the life of the bar — the reboot path used to add a fresh one every time.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (bar.classList.contains('mode-omni')) balanceOmniSlot();
    }).observe(bar);
  }
}

/* --- Omnibox spring -----------------------------------------------------
   The capsule pops in when the bar hands over to typing mode and collapses
   back when it leaves.  In: 250ms overshoot spring, out: 180ms collapse —
   transform/opacity only; will-change lives in the animation class, so it
   disappears together with it (removed on animationend / safety timer). --- */
const omniMotion = {
  springTimer: 0,
  springEnd: null,
  closeTimer: 0, // non-zero while the collapse animation is in flight
  closeEnd: null,
};

// One gate for every new motion: the settings kill switch wins, and so does
// the OS "reduce motion" preference — both fall back to instant swaps.
function motionOff() {
  return document.body.classList.contains('no-anim')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function omniCapsule() {
  return sEl('ntp-omnibox')?.querySelector('.search') || null;
}

// Typing mode keeps the home tab on the left and the window controls on the
// right while hiding everything else.  The flex slot is then not centred on
// the bar, so the capsule would hop a few pixels on every focus.  Publish the
// two cluster widths as CSS vars and let the capsule translate by half their
// difference — same transform channel, no layout.
//
// The pill is #tab-home-tab (class .tab.tab-home), not #tab-home: the latter
// is the "go home" button inside the hidden right-hand cluster, and measuring
// it gave a bogus +8px on the left.  Everything here is measured, so a
// changed padding or a hidden window-controls cluster stays honest.
function balanceOmniSlot() {
  const bar = sEl('chrome-bar');
  const omni = sEl('ntp-omnibox');
  if (!bar || !omni) return;
  const home = sEl('tab-home-tab');
  const wins = bar.querySelector('.win-controls');
  const left = home && home.offsetWidth ? home.getBoundingClientRect().right : 0;
  const right = wins && wins.offsetParent !== null
    ? bar.getBoundingClientRect().right - wins.getBoundingClientRect().left
    : 0;
  omni.style.setProperty('--omni-left', `${left}px`);
  omni.style.setProperty('--omni-right', `${right}px`);
  // The flex slot is NOT symmetric with the bar: the left cluster is padded
  // in from the window edge while .win-controls runs flush to it, so the gap
  // the slot fills sits a few px right of the bar's centre.  Cancel exactly
  // half the imbalance — (left edge span) minus (right edge span).
  //
  // Derived from the cluster boxes alone, never from the slot's own rect:
  // reading the slot while its child is translated fed the offset back into
  // the next measurement, and the drift compounded a few px per call until
  // the pill was a whole half-bar off.  Pure function of the layout, so it
  // settles on the same number however often it runs.
  //
  // left / right above are already "distance from the left edge to the end of
  // the left cluster" and "distance from the right edge to the start of the
  // right cluster".  A capsule centred between them is off the bar's centre
  // by exactly half their difference, so shift it back by that much.
  const drift = (left - right) / 2;
  omni.style.setProperty('--omni-drift', `${drift.toFixed(2)}px`);
}

function playOmniSpring() {
  const capsule = omniCapsule();
  if (!capsule || motionOff()) return;
  capsule.classList.remove('omni-spring');
  capsule.removeEventListener('animationend', omniMotion.springEnd);
  void capsule.offsetWidth; // restart the animation even on quick re-opens
  capsule.classList.add('omni-spring');
  const done = () => {
    capsule.classList.remove('omni-spring'); // takes will-change with it
    capsule.removeEventListener('animationend', omniMotion.springEnd);
    clearTimeout(omniMotion.springTimer);
    omniMotion.springTimer = 0;
  };
  omniMotion.springEnd = (e) => { if (e.animationName === 'omni-spring-in') done(); };
  capsule.addEventListener('animationend', omniMotion.springEnd);
  omniMotion.springTimer = setTimeout(done, 320); // safety net (250ms + slack)
}

function applyTabsMode(bar) {
  bar.classList.remove('mode-omni');
  bar.classList.add('mode-tabs');
  // The strip was display:none while typing — the glider geometry is stale.
  window.LiveTabs?.syncGlider?.(false);
}

function cancelOmniClose() {
  if (!omniMotion.closeTimer) return;
  clearTimeout(omniMotion.closeTimer);
  omniMotion.closeTimer = 0;
  const capsule = omniCapsule();
  if (capsule) {
    capsule.classList.remove('omni-out');
    capsule.removeEventListener('animationend', omniMotion.closeEnd);
  }
}

function finishOmniClose() {
  if (!omniMotion.closeTimer) return; // already finished or cancelled
  clearTimeout(omniMotion.closeTimer);
  omniMotion.closeTimer = 0;
  const capsule = omniCapsule();
  if (capsule) {
    capsule.classList.remove('omni-out');
    capsule.removeEventListener('animationend', omniMotion.closeEnd);
  }
  const bar = sEl('chrome-bar');
  if (bar) applyTabsMode(bar);
}

function startOmniClose() {
  const capsule = omniCapsule();
  if (!capsule) {
    const bar = sEl('chrome-bar');
    if (bar) applyTabsMode(bar);
    return;
  }
  capsule.classList.remove('omni-spring');
  clearTimeout(omniMotion.springTimer);
  omniMotion.springTimer = 0;
  capsule.removeEventListener('animationend', omniMotion.springEnd);
  capsule.classList.add('omni-out');
  omniMotion.closeEnd = (e) => { if (e.animationName === 'omni-out') finishOmniClose(); };
  capsule.addEventListener('animationend', omniMotion.closeEnd);
  omniMotion.closeTimer = setTimeout(finishOmniClose, 220); // 180ms + slack
}

// The bar is either the tab strip (switching pages) or the omnibox
// (typing).  Fuzzy searches contain no "://" and no dot, so they can't be
// mistaken for a site.  The spring plays only on a real tabs -> omni
// hand-over: the capsule must actually appear (or re-appear) to animate.
function setBarMode(mode) {
  const bar = sEl('chrome-bar');
  if (!bar) return;
  const omni = mode === 'omni';
  const closing = omniMotion.closeTimer !== 0;
  if (omni) {
    balanceOmniSlot();
    if (closing) {
      // A collapse is mid-flight: cancel it and spring the capsule back.
      cancelOmniClose();
      bar.classList.add('mode-omni');
      bar.classList.remove('mode-tabs');
      playOmniSpring();
      return;
    }
    if (bar.classList.contains('mode-omni')) {
      bar.classList.remove('mode-tabs'); // keep the class pair consistent
      return;
    }
    bar.classList.add('mode-omni');
    bar.classList.remove('mode-tabs');
    playOmniSpring();
    return;
  }
  // Схлопывание в полёте — НЕ бросаем запрос: гасим анимацию и применяем
  // вкладки немедленно.  Раньше ранний return «ждал» finishOmniClose, и
  // капсула могла застрять в omni-режиме (запрос терялся).
  if (closing) cancelOmniClose();
  if (!bar.classList.contains('mode-omni')) {
    // Already in tabs mode — only normalise the class pair (boot path).
    bar.classList.add('mode-tabs');
    bar.classList.remove('mode-omni');
    return;
  }
  if (omniCapsule() && !motionOff()) startOmniClose();
  else applyTabsMode(bar);
}

// The host's nav push arrives here via onHostMessage and is handed to
// tabs.js, which owns the strip and the back/forward buttons.  search.js
// closes the gear popover through closeSearchMenu when suggestions open.
window.LiveUi = {
  setBarMode,
  toTabs: () => setBarMode('tabs'),
  closeSearchMenu: () => closeSearchMenu(),
  // Тема наружу: нужно QA-прогону и будущим «поиграть с видом» фичам.
  setPalette: (id) => window.__lbSetPalette(id),
  setMode: (m) => setMode(m === 'light' ? 'light' : 'dark'),
  // Living desktop, exposed so the QA probe (and future "fine-tune vibes"
  // controls) can drive the phase and the weather without waiting for 5 am.
  setSky: (phase, condition) => {
    if (phase) document.body.dataset.phase = phase;
    if (condition != null) applySkyCondition(condition);
    return { phase: document.body.dataset.phase, sky: document.body.dataset.sky };
  },
  skyPhase,
  skyCondition,
};
document.addEventListener('DOMContentLoaded', initChromeBar);

/* ------------------------------------------------------------------ */
/* Window chrome: drag zone + window controls                          */
/* ------------------------------------------------------------------ */

const INTERACTIVE = 'button, input, textarea, select, a, svg, .tab, .suggests, .win-ctrl';

function initTitlebar() {
  if (!inHost()) {
    document.body.classList.add('no-host');
    return;
  }

  // The whole bar is the title bar: pressing any spot that is not an
  // interactive control and moving the mouse a few px drags the window.
  // Controls themselves keep normal clicks; nothing reflows on press.
  const bar = sEl('chrome-bar');
  if (bar) {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(INTERACTIVE)) return;
      const sx = e.screenX;
      const sy = e.screenY;
      let dragging = false;
      const move = (ev) => {
        if (dragging) return;
        if (Math.hypot(ev.screenX - sx, ev.screenY - sy) < 4) return;
        dragging = true;
        postToHost({ type: 'drag' });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest(INTERACTIVE)) return;
      postToHost({ type: 'maxi' });
    });
  }

  for (const btn of document.querySelectorAll('.win-ctrl')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.win;
      if (action) postToHost({ type: action });
    });
  }

  // Everything interactive stops the drag before it reaches the bar.
  for (const el of document.querySelectorAll('.chrome-bar button, .chrome-bar input, .chrome-bar svg')) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
}

/* ------------------------------------------------------------------ */
/* Settings sheet                                                      */
/* ------------------------------------------------------------------ */

function syncSwatches() {
  const grid = sEl('swatch-grid');
  if (!grid) return;
  for (const sw of grid.querySelectorAll('.swatch')) {
    const on = Number(sw.dataset.palette) === app.paletteIndex;
    sw.classList.toggle('active', on);
    sw.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

// The palette row and the dark/light switch live in one grid row.
function ensureModeSwitch() {
  const grid = sEl('swatch-grid');
  if (!grid || sEl('mode-switch')) return;
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'swatch swatch-mode';
  sw.id = 'mode-switch';
  sw.title = 'Светлая / тёмная тема';
  sw.setAttribute('aria-label', 'Светлая или тёмная тема');
  sw.setAttribute('aria-pressed', 'false');
  sw.innerHTML =
    '<svg class="ico-sun" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.2"/>' +
    '<path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/></svg>' +
    '<svg class="ico-moon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/></svg>';
  sw.addEventListener('click', toggleMode);
  grid.appendChild(sw);
}

function syncModeSwitch() {
  const sw = sEl('mode-switch');
  if (!sw) return;
  const light = app.mode === 'light';
  sw.classList.toggle('active', false); // the ring marks palettes, not the mode
  sw.setAttribute('aria-pressed', light ? 'true' : 'false');
  sw.setAttribute('aria-label', light ? 'Тёмная тема' : 'Светлая тема');
  sw.title = light ? 'Тёмная тема' : 'Светлая тема';
}

function renderSwatches() {
  const grid = sEl('swatch-grid');
  if (!grid) return;
  grid.replaceChildren();
  PALETTES.forEach((p, i) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.dataset.palette = String(i);
    sw.title = p.name || p.id;
    sw.setAttribute('aria-label', `Палитра ${p.name || p.id}`);
    sw.style.background = `linear-gradient(140deg, ${p.accent}, ${p.accentSoft})`;
    sw.addEventListener('click', () => setPalette(i));
    grid.appendChild(sw);
  });
  ensureModeSwitch();
  syncSwatches();
  syncModeSwitch();
}


function initSettings() {
  renderSwatches();

  sEl('settings-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.LiveSettingsPage?.open();
  });
  sEl('random-palette')?.addEventListener('click', randomPalette);
  initSearchMenu();

  sEl('settings')?.addEventListener('pointerdown', (e) => {
    // Clicking the dimmed backdrop closes; clicks inside the card don't.
    if (e.target === sEl('settings')) closeSettings();
  });

  // Escape closes the topmost layer only: the gear menu, then the settings
  // sheet, instead of several layers acting on one key press.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (app.searchMenuOpen) {
      e.stopImmediatePropagation();
      closeSearchMenu();
    } else if (app.settingsOpen) {
      e.stopImmediatePropagation();
      closeSettings();
    }
  }, true);
}

/* ------------------------------------------------------------------ */
/* Search menu (gear popover: palettes + mode + all settings)          */
/* ------------------------------------------------------------------ */

// The gear in the omnibox capsule opens a small menu.  On the home screen it
// is the local #search-menu popover under the capsule; over a site tab the
// shell cannot paint below the bar, so the same content goes to the host's
// native panel layer (panelView) through the "menu" bridge — the same
// channel "suggests" uses, which keeps the two panels mutually exclusive.
// Rect kept between native re-sends: a palette/mode pick re-renders the menu
// in place (the capsule does not move while the menu is open).
let searchMenuRect = null;
let lastMenuPickAt = 0;

function menuOverSite() {
  return document.body.classList.contains('site-active') && !!window.chrome?.webview;
}

function searchMenuPalettes() {
  return (window.LiveTheme?.PALETTES || PALETTES).map((p) => p.accent);
}

// Shell -> host: show/hide the native menu layer over a site.  `rect` is the
// local popover's rect in CSS px (measured while it is laid out), exactly
// like tellHostSuggests in search.js.
function tellHostMenu(open, rect, modeOverride) {
  if (!window.chrome?.webview) return;
  const msg = { type: 'menu', open: !!open };
  if (open && rect) {
    msg.l = Math.round(rect.left);
    // Верх — не выше нижней кромки 56-px полосы: над сайтом бар рисуется
    // поверх нативного слоя, и всё выше обрезается им (вплотную = 56).
    msg.t = Math.round(Math.max(rect.top, 56));
    msg.w = Math.round(rect.width);
    msg.h = Math.round(rect.height);
    // An explicit mode keeps the native layer in step even while the shell's
    // View Transition has not applied the new data-theme yet.
    msg.mode = modeOverride || app.mode;
    msg.index = app.paletteIndex;
    msg.palettes = searchMenuPalettes();
  }
  try { window.chrome.webview.postMessage(JSON.stringify(msg)); }
  catch { /* host gone */ }
}

// Fill the local popover from the live theme state.
function renderSearchMenu() {
  const menu = sEl('search-menu');
  if (!menu) return;
  const grid = sEl('sm-swatches');
  const palettes = window.LiveTheme?.PALETTES || PALETTES;
  if (grid) {
    grid.replaceChildren();
    palettes.forEach((p, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'sm-swatch' + (i === app.paletteIndex ? ' active' : '');
      sw.dataset.palette = String(i);
      sw.title = p.name || p.id;
      sw.setAttribute('aria-label', `Палитра ${p.name || p.id}`);
      sw.setAttribute('aria-pressed', i === app.paletteIndex ? 'true' : 'false');
      sw.style.background = `linear-gradient(140deg, ${p.accent}, ${p.accentSoft})`;
      sw.addEventListener('click', () => applySearchMenuPalette(i));
      grid.appendChild(sw);
    });
  }
  syncSearchMenuMode();
}

function syncSearchMenuMode(mode) {
  const menu = sEl('search-menu');
  if (!menu) return;
  const light = (mode || app.mode) === 'light';
  for (const tab of menu.querySelectorAll('.sm-tab')) {
    const on = (tab.dataset.smMode === 'light') === light;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

function setGearExpanded(on) {
  sEl('theme-btn')?.setAttribute('aria-expanded', on ? 'true' : 'false');
}

// Over a site: measure the laid-out popover (hidden, animation frozen) and
// hand the content to the host's native layer — the same geometry trick as
// the suggestion panel's hand-off in search.js.
function openSearchMenuNative() {
  const menu = sEl('search-menu');
  if (!menu) return;
  renderSearchMenu();
  menu.classList.remove('lb-exit'); // замер геометрии не должен видеть исход
  menu.hidden = false;
  menu.style.animation = 'none';
  menu.style.visibility = 'hidden';
  searchMenuRect = menu.getBoundingClientRect();
  menu.hidden = true;
  menu.style.visibility = '';
  menu.style.animation = '';
  app.searchMenuOpen = true;
  // Реестр поповеров: gear-меню гасит палитру/подсказки/стрип истории.
  window.LivePops?.open('search-menu', closeSearchMenu);
  setGearExpanded(true);
  tellHostMenu(true, searchMenuRect);
}

// Локальная шторка уезжает с fade (lb-pop-out) — закрывание тоже
// анимируется.  Логическое состояние уже сброшено выше, задержка касается
// только видимости: повторное открытие снимет .lb-exit и покажет меню сразу.
function exitThenHideMenu(menu) {
  if (!menu || menu.hidden) return;
  if (motionOff()) { menu.hidden = true; return; }
  menu.classList.add('lb-exit');
  const done = () => {
    menu.classList.remove('lb-exit');
    menu.hidden = true;
    menu.removeEventListener('animationend', done);
  };
  menu.addEventListener('animationend', done);
  setTimeout(done, 170); // 140мс анимация + запас
}

function closeSearchMenu() {
  if (!app.searchMenuOpen) return;
  window.LivePops?.close('search-menu');
  app.searchMenuOpen = false;
  setGearExpanded(false);
  exitThenHideMenu(sEl('search-menu'));
  if (menuOverSite()) tellHostMenu(false);
}

// Toggle from the gear.  Over a site the popover itself stays hidden (the ui
// view is clipped to the bar): the host draws the same content.  An open
// suggestion panel goes first — one native layer, two states.
function toggleSearchMenu() {
  if (menuOverSite()) {
    if (app.searchMenuOpen) closeSearchMenu();
    else {
      window.LiveSearch?.hide?.();
      openSearchMenuNative();
    }
  } else {
    const menu = sEl('search-menu');
    if (!menu) return;
    app.searchMenuOpen = !app.searchMenuOpen;
    setGearExpanded(app.searchMenuOpen);
    if (app.searchMenuOpen) {
      menu.classList.remove('lb-exit'); // незавершённый исход не показываем
      renderSearchMenu();
      menu.hidden = false;
    } else {
      exitThenHideMenu(menu);
    }
  }
}

/* Picks.  A palette or the mode keep the menu open (live preview — the
   native one is refreshed with new state); "all settings" closes it. */

function applySearchMenuPalette(i) {
  // Any pick arms the blur-close guard: re-rendering the swatch row (and the
  // native layer moving focus) must not read as "focus left the omnibox".
  lastMenuPickAt = Date.now();
  window.LiveTheme?.setPalette(i);
  renderSearchMenu();
  if (menuOverSite()) tellHostMenu(true, searchMenuRect);
}

function applySearchMenuMode() {
  lastMenuPickAt = Date.now();
  // The explicit target dodges a View Transition race: app.mode (and the
  // host's own darkTheme) update only once the transition applies, while the
  // native menu must repaint with the right theme right now.
  const target = app.mode === 'light' ? 'dark' : 'light';
  window.LiveTheme?.setMode(target);
  syncSearchMenuMode(target);
  if (menuOverSite()) tellHostMenu(true, searchMenuRect, target);
}

function applySearchMenuSettings() {
  closeSearchMenu();
  // The full settings page (settings.js exports LiveSettingsPage; the old
  // SettingsPage name is accepted as a fallback).
  (window.LiveSettingsPage || window.SettingsPage)?.open?.();
}

function initSearchMenu() {
  renderSearchMenu();
  sEl('theme-btn')?.addEventListener('click', toggleSearchMenu);
  sEl('sm-mode')?.addEventListener('click', (e) => {
    if (e.target.closest('.sm-tab')) applySearchMenuMode();
  });
  sEl('sm-settings')?.addEventListener('click', applySearchMenuSettings);

  // Clicks outside the menu and the gear close it.  Capture phase: bar
  // buttons stop pointerdown propagation for the drag zone, so a bubble
  // listener would never see those clicks.
  document.addEventListener('pointerdown', (e) => {
    if (!app.searchMenuOpen) return;
    if (e.target.closest('#search-menu') || e.target.closest('#theme-btn')) return;
    closeSearchMenu();
  }, true);

  // Focus left the omnibox (a tab button, the site below, the native panel):
  // the menu follows the panel rules and closes — unless the blur is the
  // native menu's own pick coming back (lastMenuPickAt guard).
  sEl('search')?.addEventListener('blur', () => {
    if (!app.searchMenuOpen) return;
    setTimeout(() => {
      if (!app.searchMenuOpen) return;
      const ae = document.activeElement;
      if (ae && sEl('search-menu')?.contains(ae)) return;
      if (Date.now() - lastMenuPickAt < 400) return;
      closeSearchMenu();
    }, 160);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/* --- Стартовые тайминги (QA) -------------------------------------------
   window.__boot обновляется по мере прохождения фаз загрузки; QA-прогон
   читает финальные цифры из turbo.js (load), пока страница грузится —
   частичные.  Всё в try/catch: проверка не имеет права ронять boot. --- */
const bootAt = performance.now();

function bootMark(field, ms) {
  try {
    const b = window.__boot = window.__boot || {};
    b[field] = Math.round(ms);
    return b;
  } catch { return null; }
}

function bootFinish(field) {
  const b = bootMark(field, performance.now());
  if (b) b.done = { shell: b.shell != null, firstPaint: b.firstPaint != null, interactive: b.interactive != null };
  return b;
}

try {
  const b = bootMark('shell', bootAt); // сколько прошло до первого кода shell'а
  if (b) b.t0 = Math.round(performance.timeOrigin || 0); // эпоха навигации
} catch { /* probe is best-effort */ }

// Первый кадр: requestAnimationFrame срабатывает прямо перед отрисовкой —
// в этот момент мы ещё не дождались load, но экран уже не пустой.
try {
  requestAnimationFrame(() => {
    const b = bootMark('firstPaint', performance.now());
    if (b) b.paintDone = true;
  });
} catch { /* no rAF outside a window */ }

/* --- Отложенный старт ---------------------------------------------------
   Всё, что не нужно для первого кадра (погода, часы, параллакс, обои,
   файлы шрифтов), ставится в очередь requestIdleCallback.  Таска,
   бросившая исключение, не мешает следующим: каждая обёрнута в try/catch
   под отладочным именем (window.__bootFail).  Есть таймауты: браузер без
   requestIdleCallback (или постоянно занятый главный поток) всё равно
   доигрывает очередь.  Задачи, зависящие от момента появления на экране
   (часы, погода), в фоне не выполняются — они запускаются сразу при
   возврате вкладки на передний план (см. visibilitychange ниже). --- */
const idleQueue = [];
let idleDrained = false;
let idleTimer = 0;

function runIdleJob(job) {
  try { job(); }
  catch (err) {
    window.__bootFail = String(job.name || 'idle') + ': ' + (err && err.message || err);
  }
}

function scheduleIdle(cb, timeout) {
  const job = typeof cb === 'function' ? cb : () => {};
  if (idleDrained) return runIdleJob(job);
  idleQueue.push(job);
  // Один таймер-страховка на всю очередь, а не на задачу: срабатывает
  // раньше, чем idle успеет уйти в бесконечность (тяжёлый первый кадр).
  if (idleTimer) return;
  idleTimer = setTimeout(() => drainIdleQueue(timeout || 400), timeout || 400);
}

// Накопленное выполняется в порядке постановки — один requestIdleCallback
// на всю пачку, остаток кадра (timeRemaining) делит пачку сам движок.
function drainIdleQueue(timeout) {
  clearTimeout(idleTimer);
  idleTimer = 0;
  const batch = idleQueue.splice(0);
  if (!batch.length) return;
  const run = (deadline) => {
    // Скрытая вкладка (свёрнутое окно) не должна выполнять тяжёлые задачи:
    // первый кадр следующего показа важнее.  Пачка вернётся в очередь, а
    // visibilitychange поднимет её снова.
    if (document.hidden && typeof requestIdleCallback === 'function') {
      idleQueue.unshift(...batch);
      setTimeout(() => drainIdleQueue(timeout), timeout || 400);
      return;
    }
    for (let i = 0; i < batch.length; i++) {
      const job = batch[i];
      // Остаток кадра кончился, а браузер сам не прервёт исполнение —
      // останавливаемся по времени и продолжаем в следующем idle.
      if (deadline && !deadline.didTimeout && deadline.timeRemaining() <= 0 && i < batch.length - 1) {
        idleQueue.push(job);
      } else {
        runIdleJob(job);
      }
    }
    if (idleQueue.length) {
      idleTimer = setTimeout(() => drainIdleQueue(timeout), timeout || 400);
    } else {
      idleDrained = true;
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: timeout || 400 });
  else setTimeout(() => run(null), 0);
}

// Шрифты подгружаются лениво только тогда, когда их кто-то реально
// использует (кибер-кожа).  На обычном старте это лишние 50 КБ в
// критическом пути — грузим их в idle, чтобы первые же часы не мигали.
function warmFonts() {
  if (!document.fonts || typeof document.fonts.load !== 'function') return;
  // Только реальные файлы из shell/fonts: без сетевого CDN.
  const faces = [
    '400 16px "JetBrains Mono"',
    '700 16px "Orbitron"',
  ];
  for (const spec of faces) {
    try { document.fonts.load(spec, 'ЖAa0123').catch(() => {}); } catch { /* no-op */ }
  }
}

async function boot() {
  bootMark('bootStart', performance.now());
  // Theme can come back as an object or a JSON string; both are accepted.
  let saved = await Promise.resolve()
    .then(() => bridge.loadTheme())
    .catch(() => null);
  if (typeof saved === 'string') {
    try { saved = JSON.parse(saved); } catch { saved = null; }
  }

  // First run: follow the OS preference; after that the saved choice wins.
  const osLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  app.mode = saved && (saved.mode === 'light' || saved.mode === 'dark')
    ? saved.mode
    : (osLight ? 'light' : 'dark');

  if (saved && saved.accent) {
    const known = PALETTES.some((p) => p.id === saved.id);
    // A saved palette is restored verbatim; an accent a site pinned keeps
    // its hue and reuses the saved backdrop.
    applyTheme(known ? { ...saved, mode: app.mode } : { ...PALETTES[0], ...saved, mode: app.mode, id: saved.id || 'custom' });
    let index = Number.isInteger(saved.paletteIndex)
      ? saved.paletteIndex
      : PALETTES.findIndex((p) => p.id === saved.id);
    if (index < 0 || index >= PALETTES.length) index = 0;
    app.paletteIndex = index;
    app.accentPinned = !known;
  } else {
    applyTheme({ ...PALETTES[0], mode: app.mode });
  }
  syncSwatches();

  // The host needs the mode for its own background, even when nothing was
  // saved yet (fresh install on a light-themed Windows).
  postToHost({ type: 'theme', mode: app.mode, theme: JSON.stringify(app.currentTheme) });
  // Boot can restore a site-pinned accent on top of a palette (saved.id =
  // 'custom'); the host otherwise keeps whatever accent it had, and the sweep
  // does not match the bar.  Announce it once, in the same order the runtime
  // uses (accent, then theme).
  {
    const t = app.currentTheme;
    if (t && t.accent) postToHost({ type: 'accent', hex: t.accent, hex2: t.accentSoft, cyber: !!t.cyber });
  }

  // Циферблат: первый тик — в idle (он дороже всех, toLocale* страшные),
  // часовой дедлайн — через 1.2 с от boot, чтобы часы не мигали «--:--»
  // на медленном диске.  Дальше — обычный интервал раз в секунду.
  let clockTimer = 0;
  const startClock = () => {
    if (clockTimer) return;
    tick();
    clockTimer = setInterval(tick, 1000);
  };
  scheduleIdle(() => {
    if (document.hidden) return; // ждём visibilitychange
    startClock();
  }, 500);
  // Страховка: даже если главный поток занят, часы появятся через 1.2 с.
  setTimeout(() => { if (document.visibilityState !== 'hidden') startClock(); }, 1200);

  // Weather медленнее всего (сеть x2), на экранный кадр не влияет — idle.
  let weatherReady = false;
  const startWeather = () => {
    if (weatherReady) return;
    weatherReady = true;
    bindWeatherClick(); // карточка — живая ссылка на Яндекс.Погоду
    loadWeather();
    setInterval(loadWeather, 10 * 60 * 1000);
  };
  scheduleIdle(() => {
    if (document.hidden) return;
    startWeather();
  }, 400);

  renderLinks();
  // Пользовательские плитки приезжают асинхронно (GET /api/settings или
  // localStorage-фолбэк) и дорисовываются повторным renderLinks.
  loadUserLinks();
  // Логотипы плиток: тихий дозагрузка favicon через хост-релей после
  // того, как пользовательские плитки определились (и один раз по idle
  // для дефолтов — fetchMissingFavicons сам пропускает уже имеющиеся).
  scheduleIdle(fetchMissingFavicons, 700);
  // Параллакс и обои слушают pointermove; до первого idle их нет — и
  // это ок: до первого движения мыши idle уже наступит.
  scheduleIdle(initParallax, 300);
  // Шрифты: грузим в idle, чтобы они не висели в критическом пути
  // первого кадра (их всё равно применит каскад, но уже без мигания).
  scheduleIdle(warmFonts, 600);
  initTitlebar();
  initSettings();

  // Когда вкладка возвращается из фона, отложенные задачи могли ждать:
  // поднимаем их, чтобы не видеть «--:--» и «погода» дольше нужного.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    startClock();
    startWeather();
    if (!idleDrained && idleQueue.length) drainIdleQueue(300);
  });

  // The omnibox is owned by search.js (Yandex suggestions, keyboard nav,
  // page transition) — it overrides this one on load.

  // Fallback omnibox behaviour for when search.js hasn't taken over.
  if (!document.querySelector('script[src="search.js"]')) {
    sEl('search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') aNavigate(e.target.value);
    });
  }

  // Expose a tiny theming API for other shell modules (e.g. translation,
  // search menu picks).
  window.LiveTheme = { applyTheme, accentFromColor, setMode, toggleMode, setPalette, PALETTES };

  // Host pushes: register the listener first, then announce readiness so the
  // host answers with its tab list and nav state.
  if (inHost()) {
    window.chrome.webview.addEventListener('message', onHostMessage);
    postToHost({ type: 'ready' });
  } else {
    document.body.classList.add('no-host');
  }
  bootFinish('interactive'); // интерактивен: тема, вкладки, ввод готовы
}

function onHostMessage(e) {
  const msg = e && e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'tabs') {
    window.LiveTabs?._onTabs(msg);
    // Полоса «Перевести страницу» привязана к вкладке: ушёл на другую —
    // полоса уходит (translate-offer.js решает по activeId).
    window.LiveTranslateOffer?.onTabs(msg);
    // Смена вкладки: выделение на сайте ушло — findbar закрывается сам.
    window.LiveFind?.onTabs();
  }
  else if (msg.type === 'nav') window.LiveTabs?._onNav(msg);
  else if (msg.type === 'focus-mode') {
    // F11 в хосте: полоса уезжает, сайт занимает всё окно.  Шелл узнаёт об
    // этом, чтобы Esc с шелла и превью-состояние были согласованы.
    document.body.classList.toggle('focus-mode', !!msg.on);
    window.showToast?.(msg.on ? 'Фокус-режим: F11 или Esc — выйти' : 'Фокус-режим выключен', { timeout: 2200 });
  }
  else if (msg.type === 'vertical-tabs') {
    // Ctrl+Shift+E: полоса вкладок уезжает в колонку слева.  Раскладку сайта
    // (отступ слева) считает хост; здесь — только вид полосы и её ширина,
    // которую tabs.js держит в одной константе с CSS (--vtabs-w).
    document.body.classList.toggle('vertical-tabs', !!msg.on);
    window.LiveTabs?.layoutChanged();
  }
  else if (msg.type === 'omni') {
    // Ctrl+L pressed while a site view had focus: the host forwards it here
    // (it cannot reach the shell page as a key event).  tabs.js detaches the
    // old __liveCtrlL hook, so call the omnibox owner directly.
    window.LiveSearch?.focus();
  }
  else if (msg.type === 'suggest-pick') {
    // A row was picked in the native dropdown layer over a site: run the
    // same search jump a local pick would have (search.js).
    window.LiveSearch?.pick(msg.value);
  }
  else if (msg.type === 'menu-pick') {
    // A menu item was picked in the native panel over a site: apply it and
    // refresh the native menu (palette/mode stay open) or close it
    // (settings).  lastMenuPickAt keeps the blur-close timer from dropping
    // the freshly refreshed menu.
    lastMenuPickAt = Date.now();
    if (msg.action === 'palette' && Number.isInteger(msg.index)) {
      applySearchMenuPalette(msg.index);
    } else if (msg.action === 'mode') {
      applySearchMenuMode();
    } else if (msg.action === 'settings') {
      applySearchMenuSettings();
    } else if (msg.action === 'item') {
      // Generic-меню («Ещё», контекстное, «Недавно закрытые»): runItem сам
      // закрывает нативный слой и исполняет action по индексу items.
      // menu.js ленивый, но пункт нажали в нативном слое — значит он уже
      // был загружен там же, где рисовался; на всякий случай догружаем.
      const pick = () => window.LiveMenu?.runItem(msg.index);
      if (window.LiveMenu) pick();
      else window.LiveModules?.load('menu').then(pick).catch(() => { });
    }
  }
  else if (msg.type === 'suggest-hide') {
    // Хост скрыл слой подсказок (клик по сайту при открытой панели): гасим
    // локальную панель синхронно, как по Esc — иначе она «воскреснет».
    window.LiveSearch?.hide();
  }
  else if (msg.type === 'progress') {
    // Site navigation lifecycle for the 2px bar strip; tabs.js decides
    // whether the touched tab is the active one.
    window.LiveTabs?._onProgress(msg);
  }
  else if (msg.type === 'toast') {
    // Host-side status line (e.g. a finished download).  toasts.js queues it
    // while a site is active.
    if (typeof msg.text === 'string') window.showToast?.(msg.text);
  }
  else if (msg.type === 'download') {
    // A download tick (~10 Hz) or a final state; downloads.js mirrors it.
    window.LiveDownloads?.onItem(msg.item);
  }
  else if (msg.type === 'translate-offer') {
    // Хост решил, что язык страницы не русский (Translator.cs): показываем
    // полосу с предложением.  Перевод — только по кнопке пользователя.
    window.LiveTranslateOffer?.offer(msg);
  }
  else if (msg.type === 'translate-offer-hide') {
    // Смена вкладки: хост пришлёт новое предложение сам, если новая
    // страница иностранная.  Старую полосу убираем молча (не dismiss).
    window.LiveTranslateOffer?.hide();
  }
  else if (msg.type === 'site-text') {
    // Ответ сайт-вкладки на запрос текста для перевода.
    window.LiveTranslateOffer?.onSiteText(msg);
  }
  else if (msg.type === 'trans-page-done') {
    // In-place перевод страницы готов: найдено N фрагментов.
    window.LiveTranslateOffer?.onPageDone(Number(msg.count) || 0);
  }
  else if (msg.type === 'trans-reverted') {
    // «Показать оригинал» отработал на сайте.
    window.LiveTranslateOffer?.onReverted();
  }
  else if (msg.type === 'occ') {
    // Свёрнутое окно: замирать декорациям (body.occ в app.css ставит
    // animation-play-state: paused бесконечным дрейфам) — иначе GPU-process
    // перерисовывает невидимый экран.
    document.body.classList.toggle('occ', !!msg.on);
  }
  else if (msg.type === 'find-open') {
    // Ctrl+F на сайте: хост перевёл фокус в шелл — открыть findbar.
    // findbar.js ленивый: сначала грузим, потом зовём (иначе первый Ctrl+F
    // после старта молча ничего бы не сделал).
    window.LiveModules?.load('findbar').then(() => window.LiveFind?.open()).catch(() => { });
  }
  else if (msg.type === 'find-result') {
    // Число совпадений для последнего запроса findbar'а.
    window.LiveFind?.onResult(msg.n);
  }
  else if (msg.type === 'perm') {
    // Сайт просит разрешение (гео/камера/микрофон/…): аккуратный диалог
    // вместо системного попапа (perm.js → host {type:'perm-answer'}).
    if (msg.id && msg.kind && msg.uri)
      window.LiveModules?.load('perm').then(() => window.LivePerm?.ask(msg)).catch(() => { });
  }
  else if (msg.type === 'session-restore') {
    // Прошлый сеанс не закрылся штатно: хост держит вкладки до нашего ответа
    // (restore.js → {type:'session-answer', accept}).
    window.LiveModules?.load('restore')
      .then(() => window.LiveRestore?.show(Number(msg.count) || 0)).catch(() => { });
  }
}

// Оффлайн-индикатор: сеть пропала — тонкая янтарная полоска на баре
// (body.net-off в app.css), вернулась — ушла.  Стандартные online/offline
// события страницы: сетевые вьюхи живут в той же машине, отдельного
// хост-канала не нужно (NetworkStateChanged в этом SDK отсутствует).
function syncNetIndicator() {
  document.body.classList.toggle('net-off', navigator.onLine === false);
}
window.addEventListener('online', syncNetIndicator);
window.addEventListener('offline', syncNetIndicator);
syncNetIndicator();

document.addEventListener('DOMContentLoaded', boot);

// Diagnostics: the host probe reads this to see page-level errors that
// would otherwise only live in the devtools console.
window.addEventListener('error', (e) => {
  window.__err = String(e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?');
});

})();
