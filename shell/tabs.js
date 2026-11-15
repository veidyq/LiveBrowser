// LiveBrowser tabs: the strip is a mirror of the host's tab list (tab 0 is the
// home page).  The C# host owns every real site in its own WebView2 child and
// pushes {"type":"tabs", ...} whenever something changes; this module only
// renders that push and forwards clicks back over the bridge.  Without a host
// (the page opened in a normal browser) tabs fall back to window.open windows.
'use strict';

// Top-level names stay inside this file: the shell loads four plain scripts
// into one global scope, so an IIFE prevents `const` redeclaration crashes.
(function () {

const tEl = (id) => document.getElementById(id);

const tabState = {
  tabs: [],       // { id, title, url, favicon, loading, accent } as pushed by the host
  activeId: 0,    // 0 = the home NTP
};

// Recently closed tabs (most recent last), capped at 25: a mirror of the
// host's own lastClosed record.  The shell never reopens from it — the host
// does the reopening; Ctrl+Shift+T only tells it to (see reopenClosedTab).
const closedStack = []; // { url, label }
const CLOSED_STACK_MAX = 25;

/* ------------------------------------------------------------------ */
/* Page-load progress strip                                            */
/* ------------------------------------------------------------------ */

// The host reports site navigation as {"type":"progress", id, phase} —
// "start" when the navigation commits, "done" when the page settles.  The 2px
// strip on the bar's bottom edge follows the ACTIVE tab only: background tabs
// just record their phase until they are switched to.
const progressState = new Map(); // tab id -> 'start'
let progressTimer = 0;

function progressShow() {
  const box = tEl('bar-progress');
  if (!box) return;
  clearTimeout(progressTimer);
  box.classList.remove('done');
  // Ширина бара меняется с окном, а анимация гоняет трансформ: путь
  // считается от клиентской ширины, один раз на показ.
  box.style.setProperty('--slide-span', `${Math.round(box.clientWidth * 1.35 + 40)}px`);
  box.classList.add('on', 'indeterminate');
}

// Quick run to 100% and a 300 ms fade-out (CSS .bar-progress.done).
function progressFinish() {
  const box = tEl('bar-progress');
  if (!box || !box.classList.contains('on')) return;
  box.classList.remove('indeterminate');
  box.classList.add('done');
  progressTimer = setTimeout(() => box.classList.remove('on', 'done'), 320);
}

// Tab switch: the strip follows the newly active tab — a tab that is still
// loading resumes the indeterminate run, an idle tab fades the strip away.
function progressSyncActive() {
  const id = tabState.activeId;
  if (id !== 0 && progressState.get(id) === 'start') progressShow();
  else progressFinish();
}

// Called from app.js's bridge listener on {"type":"progress"}.
function onProgress(msg) {
  const id = Number(msg && msg.id) || 0;
  if (!id) return; // the home tab has no site to load
  if (msg.phase === 'start') {
    progressState.set(id, 'start');
    if (id === tabState.activeId) progressShow();
  } else {
    progressState.delete(id);
    if (id === tabState.activeId) progressFinish();
  }
}

// "0xRRGGBB" (host) or "#rrggbb" -> rgb(); anything else gets the accent.
function accentColor(accent, fallback) {
  let n = null;
  if (typeof accent === 'number') n = accent;
  else if (typeof accent === 'string' && /^0x[0-9a-f]{6}$/i.test(accent)) n = parseInt(accent.slice(2), 16);
  else if (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)) n = parseInt(accent.slice(1), 16);
  if (n === null || !Number.isFinite(n)) return fallback || 'var(--accent)';
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function currentTab() {
  return tabState.tabs.find((t) => t.id === tabState.activeId) || null;
}

/* ------------------------------------------------------------------ */
/* Bridge                                                              */
/* ------------------------------------------------------------------ */

function tPostToHost(msg) {
  try { window.chrome.webview.postMessage(JSON.stringify(msg)); } catch { /* host gone */ }
}

function isHome() {
  return tabState.activeId === 0;
}

// The home stage is what the shell window shows; a site tab is a host child
// view drawn below the bar, so the stage steps aside for it.  Шаг в сторону
// анимирован: класс site-active запускает CSS-переходы (фон/аврора/контент
// гаснут .15s поверх уже показанного сайта — хост держит ui-вьюху во всё
// окно 190мс), а возврат поднимает контент из лёгкого сдвига (stage-enter).
let prevHome = null;

// GSAP-таймлайн исхода/входа сцены.  Прежние «голые» setTimeout не
// отменялись: спам переключениями (десктоп→сайт→десктоп за <290мс) давал
// гонку — таймер прошлого перехода снимал классы посреди нового.  Таймлайн
// убивается при перенацеливании, CSS-переходы при смене классов сами
// ретаргетятся с текущего interpolated-состояния —redirect выходит плавным,
// без рестарта с нуля.  Расписанные точки синхронизированы с нативной
// шторкой хоста (Curtain.cs, 160мс, своп на середине): 290мс — шторка
// отыграла, hidden можно ставить; 380мс — каскад бара дошёл до конца.
let stageTl = null;

function killStageTimeline() {
  if (stageTl) { stageTl.kill(); stageTl = null; }
}

// Один шаг расписания: классы ставит/снимает таймлайн, визуал остаётся
// в CSS (правило «анимируются только transform/opacity» не трогаем).
function stageSchedule(home, stage, aurora) {
  killStageTimeline();
  // Прошлая фаза могла остаться на body — новая фаза начинается чистой,
  // иначе выходной класс застрянет под входным.
  document.body.classList.remove('stage-leaving', 'stage-entering', 'bar-leaving');
  if (window.gsap && !document.body.classList.contains('no-anim')) {
    const tl = (stageTl = gsap.timeline());
    if (!home) {
      // Уход с десктопа: контент ДОГАСАЕТ поверх сайта (не прячется кадром),
      // итоговое hidden ставится после перехода.
      if (stage) stage.hidden = false;
      if (aurora) aurora.hidden = false;
      tl.call(() => document.body.classList.add('stage-leaving'), null, 0);
      tl.call(() => {
        document.body.classList.remove('stage-leaving');
        if (!isHome()) {
          if (stage) stage.hidden = true;
          if (aurora) aurora.hidden = true;
        }
      }, null, 0.29);
    } else {
      // Возврат на десктоп: контент мягко поднимается, а навигация бара
      // (обновить → вперёд → назад) уходит зеркальным каскадом — она живёт
      // только на сайте.  Класс снимает таймлайн, layout освобождается по
      // его окончанию.
      if (stage) stage.hidden = false;
      if (aurora) aurora.hidden = false;
      tl.call(() => document.body.classList.add('stage-entering', 'bar-leaving'), null, 0);
      tl.call(() => {
        document.body.classList.remove('stage-entering', 'bar-leaving');
      }, null, 0.38);
    }
    return;
  }
  // Fallback без GSAP (вендор не загрузился): прежнее поведение — setTimeout.
  if (!home) {
    document.body.classList.add('stage-leaving');
    setTimeout(() => {
      document.body.classList.remove('stage-leaving');
      if (!isHome()) {
        if (stage) stage.hidden = true;
        if (aurora) aurora.hidden = true;
      }
    }, 290);
  } else {
    document.body.classList.add('stage-entering', 'bar-leaving');
    setTimeout(() => {
      document.body.classList.remove('stage-entering', 'bar-leaving');
    }, 380);
  }
}

// opts.instant: подмена происходит под шторкой (host PushTabs(fast)) —
// десктоп прячется мгновенно, fade дал бы «призрак» поверх видимого сайта.
function syncStage(opts) {
  const home = isHome();
  const stage = tEl('stage');
  const aurora = document.querySelector('.aurora');
  const quiet = document.body.classList.contains('no-anim')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    || !!(opts && opts.instant);
  if (prevHome !== null && prevHome !== home && !quiet) {
    stageSchedule(home, stage, aurora);
  } else {
    if (quiet) {
      // Мгновенная подмена (шторка/no-anim/reduced): расписание не нужно,
      // но бросать НЕДОДЕЛАННОЕ нельзя — убитый таймлайн больше не снимет
      // классы и не спрячет сцену. Финальное состояние применяем сразу:
      // иначе stage-leaving течёт по body, а десктоп с авророй и блюром
      // продолжает рендериться за сайтом всю сессию (GPU впустую).
      killStageTimeline();
      document.body.classList.remove('stage-leaving', 'stage-entering', 'bar-leaving');
      if (stage) stage.hidden = !home;
      if (aurora) aurora.hidden = !home;
    } else {
      // Эхо-пуш без мгновенной подмены: расписание живо и само приберётся
      // по своему графику — hidden в полёте не трогаем.
      const midFlight = document.body.classList.contains('stage-leaving')
        || document.body.classList.contains('stage-entering');
      if (!midFlight) {
        if (stage) stage.hidden = !home;
        if (aurora) aurora.hidden = !home;
      }
    }
  }
  document.body.classList.toggle('on-home', home);
  // On a site the ui view covers the whole window while the suggest panel is
  // open (so the dropdown can never be clipped) — with a transparent body the
  // site shows through everywhere except the bar and the panel itself.
  document.body.classList.toggle('site-active', !home);
  // Канва html гасится вместе с десктопом (см. html.site-active в app.css):
  // без этого непрозрачный --bg-a прятал бы сайт в окна крест-фейда.
  document.documentElement.classList.toggle('site-active', !home);
  // Темп каскада бара: под шторкой (instant) фон за стеклом успокоился
  // к ~100мс — каскад стартует почти сразу; новая вкладка (крест-фейд,
  // фон меняется до ~280мс) — по позднему расписанию.  Класс снимается
  // только на возврате на десктоп: эхо-пуш не должен трогать идущий
  // каскад (смена delay перезапустила бы анимацию).
  if (opts && opts.instant) document.body.classList.add('site-fast');
  else if (home) document.body.classList.remove('site-fast');
  prevHome = home;
}

/* ------------------------------------------------------------------ */
/* Tab strip rendering                                                 */
/* ------------------------------------------------------------------ */

// Creates the button shell and its listeners ONCE.  Everything that changes
// during a load (title, url, favicon, spinner) is written by updateTab() below
// into the existing nodes.  The strip used to be thrown away and rebuilt on
// every host push — a page load alone pushes it 4-6 times (url, title, favicon,
// loading flags), and each rebuild left the tab buttons without text content
// for a frame, so the active tab flipped between its 96px minimum and its real
// ~190px width.  The spring then re-targeted to that flicker every frame, which
// is exactly the underline wobble seen while a page loads.
function buildTab(tab) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tab';
  btn.dataset.id = String(tab.id);
  btn.setAttribute('role', 'tab');

  const fav = document.createElement('span');
  fav.className = 'tab-fav';
  const title = document.createElement('span');
  title.className = 'tab-title';
  btn.append(fav, title);

  // The home tab is permanent; all others can be closed.
  if (tab.id !== 0) {
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', 'Закрыть вкладку');
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeTab(tab.id);
    });
    btn.appendChild(close);
  }

  btn.addEventListener('click', () => switchTab(tab.id));

  // Middle click closes the tab, like in every browser.  auxclick only fires
  // for non-primary buttons; the × glyph must not close twice (its own click
  // handler already did), so a hit on .tab-close is ignored here.
  btn.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    if (e.target.closest('.tab-close')) return;
    e.preventDefault();
    closeTab(tab.id);
  });
  updateTab(btn, tab);
  return btn;
}

// In-place refresh of a live button.  Only touches nodes whose value actually
// changed, so a repeated push with identical data is a no-op and an image is
// not re-decoded on every call.
function updateTab(btn, tab) {
  const active = tab.id === tabState.activeId;
  btn.classList.toggle('active', active);
  btn.classList.toggle('spin', !!tab.loading);
  btn.setAttribute('aria-selected', active ? 'true' : 'false');
  const tip = tab.url || 'Рабочий стол';
  if (btn.title !== tip) btn.title = tip;

  const fav = btn.querySelector('.tab-fav');
  if (fav) {
    const label = tab.title || tab.url || 'Без названия';
    if (tab.id === 0) {
      if (!fav.classList.contains('tab-fav-home')) {
        fav.className = 'tab-fav tab-fav-home';
        fav.textContent = '⌂';
        fav.style.background = '';
      }
    } else if (tab.favicon) {
      const img = fav.querySelector('img.tab-fav-img');
      if (img) {
        if (img.getAttribute('src') !== tab.favicon) img.src = tab.favicon;
      } else {
        fav.className = 'tab-fav';
        fav.style.background = '';
        const el = document.createElement('img');
        el.className = 'tab-fav-img';
        el.alt = '';
        el.draggable = false;
        el.src = tab.favicon;
        fav.replaceChildren(el);
      }
    } else {
      // No favicon yet: буква-аватар — первая буква заголовка (без заголовка
      // — хоста из адреса) на кружке с фоном accent вкладки.  Хост шлёт
      // accent числом или hex; без него — нейтральный var(--accent) (см.
      // accentColor).  Стиль span.tab-fav-letter инлайном: app.css правят
      // параллельно, цвет буквы — белый/чёрный по яркости фона (YIQ).
      // Тот же узел переиспользуется, чтобы полоса не теряла ширину на кадр.
      const src = (tab.title || '').trim();
      let letter = src.charAt(0);
      if (!letter) {
        try { letter = new URL(tab.url || '').hostname.replace(/^www\./, '').charAt(0); }
        catch { /* нет и адреса — покажем точку */ }
      }
      letter = (letter || '•').toUpperCase();
      const bg = accentColor(tab.accent);
      let sp = fav.querySelector('.tab-fav-letter');
      if (!sp) {
        fav.className = 'tab-fav';
        fav.style.background = ''; // фон теперь на самой букве, слот прозрачен
        sp = document.createElement('span');
        sp.className = 'tab-fav-letter';
        sp.style.cssText =
          'display:flex;align-items:center;justify-content:center;width:100%;height:100%;' +
          'border-radius:inherit;font:inherit;line-height:1;user-select:none;pointer-events:none;';
        fav.replaceChildren(sp);
      }
      if (sp.textContent !== letter) sp.textContent = letter;
      if (sp.style.background !== bg) sp.style.background = bg;
      // Цвет текста по яркости фона: rgb() от accentColor парсится прямо,
      // var(--accent) резолвится из :root; крайний случай — дефолт Aurora.
      const resolveRgb = (c) => {
        const m = /rgb\((\d+)[,\s]+(\d+)[,\s]+(\d+)\)/.exec(c || '');
        if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
        try {
          const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
          const n = /^#[0-9a-f]{6}$/i.test(v) ? parseInt(v.slice(1), 16) : NaN;
          if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        } catch { /* стили недоступны */ }
        return [124, 92, 255];
      };
      const [r, g, b] = resolveRgb(bg);
      const fg = (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#101014' : '#ffffff';
      if (sp.style.color !== fg) sp.style.color = fg;
    }
    const t = btn.querySelector('.tab-title');
    if (t && t.textContent !== label) t.textContent = label;
  }
  updateTabSound(btn, tab);
}

// Динамик на таблетке: виден, только когда вкладка реально звучит (или
// заглушена нами — тогда значок перечёркнут и остаётся видимым, чтобы
// можно было вернуть звук).  Кнопка живёт на таблетке и переключает mute
// через мост; клик по ней не должен переключать саму вкладку.
function updateTabSound(btn, tab) {
  const audible = !!tab.audible;
  const muted = !!tab.muted;
  const want = audible || muted ? (muted ? 'muted' : 'on') : 'none';
  let snd = btn.querySelector('.tab-sound');
  if (want === 'none') {
    if (snd) snd.remove();
    return;
  }
  if (!snd) {
    snd = document.createElement('span');
    snd.className = 'tab-sound';
    snd.setAttribute('role', 'button');
    snd.addEventListener('click', (e) => {
      // Таблетка ловит click на switchTab — это вложенный контрол.
      e.stopPropagation();
      e.preventDefault();
      const id = Number(btn.dataset.id) || 0;
      if (!id) return;
      if (window.chrome?.webview) tPostToHost({ type: 'toggle-mute', id });
      else tabState.tabs.forEach((t) => { if (t.id === id) t.muted = !t.muted; });
      renderStrip();
    });
    btn.appendChild(snd);
  }
  if (snd.dataset.state !== want) {
    snd.dataset.state = want;
    snd.textContent = muted ? '🔇' : '🔊';
    snd.title = muted ? 'Включить звук' : 'Заглушить вкладку';
    snd.setAttribute('aria-label', snd.title);
  }
}

function renderStrip(addedIds) {
  const box = tEl('tabs');
  if (!box) return;

  // Во время драга порядок DOM принадлежит жесту: обычный reconcile двигал
  // бы кнопки (appendChild) прямо под курсором.  Поэтому точечно: закрытые
  // вкладки убираем (закрыть могли из другого окна), живые обновляем на
  // месте, новые НЕ вставляем и glider не двигаем — полный reconcile
  // догонит на первом рендере после drop/cancel (с хостом tabs-push идёт
  // следом за reorder, так что дырка не живёт долго).  Если закрыли саму
  // драгуемую вкладку — молча отменяем драг и рендерим начисто.
  if (drag.active) {
    const wanted = new Set(tabState.tabs.filter((t) => t.id !== 0).map((t) => t.id));
    for (const el of [...box.querySelectorAll(':scope > .tab[data-id]')]) {
      if (wanted.has(Number(el.dataset.id))) continue;
      if (el === drag.btn) { cancelDrag(true); return renderStrip(addedIds); }
      el.remove();
    }
    for (const tab of tabState.tabs) {
      if (tab.id === 0) continue;
      const btn = box.querySelector(`:scope > .tab[data-id="${String(tab.id)}"]`);
      if (btn) updateTab(btn, tab);
    }
    return;
  }

  const fresh = new Set(addedIds || []);
  // Reconcile by id instead of wiping the strip.  appendChild on an element
  // that is already in the box is a cheap move to the end, so the usual push
  // (same tabs, one changed title) rewrites a text node and reorders nothing;
  // only genuinely closed tabs leave the DOM.  The glider and indicator stay
  // in place the whole time, so no frame is ever measured against a strip
  // whose buttons are missing.
  const wanted = new Set(tabState.tabs.filter((t) => t.id !== 0).map((t) => t.id));
  for (const el of [...box.querySelectorAll(':scope > .tab[data-id]')]) {
    if (!wanted.has(Number(el.dataset.id))) el.remove();
  }
  for (const tab of tabState.tabs) {
    if (tab.id === 0) continue; // home is the pinned tab in the markup
    const id = String(tab.id);
    let btn = box.querySelector(`:scope > .tab[data-id="${id}"]`);
    if (btn) {
      updateTab(btn, tab);
    } else {
      btn = buildTab(tab);
      if (fresh.has(tab.id)) markTabEnter(btn);
    }
    box.appendChild(btn);
  }

  const indicator = getIndicator(box);
  moveIndicator(indicator, box.querySelector('.tab.active'));
  // The glider rides on top of every render: adding, closing and switching
  // all end here, so this is the one place that keeps it honest.
  // Один замер, один переход.  Повторный вызов со снапом на следующем
  // кадре обрывал начатую анимацию и телепортировал полоску — это и было
  // дёрганье при быстрых кликах по вкладкам.
  syncGlider();
  const home = tEl('tab-home-tab');
  if (home) {
    const onHome = isHome();
    home.classList.toggle('active', onHome);
    home.setAttribute('aria-selected', onHome ? 'true' : 'false');
  }
}

/* ------------------------------------------------------------------ */
/* Tab open/close animations (light, skipped under the no-anim switch)  */
/* ------------------------------------------------------------------ */

// Birth of a freshly opened tab: quick scale-in.  The kill switch disables
// CSS animations entirely, in which case animationend would never fire — so
// the class is skipped there and also removed by a safety timeout.
function markTabEnter(btn) {
  if (document.body.classList.contains('no-anim')) return;
  btn.classList.add('tab-enter');
  btn.addEventListener('animationend', () => btn.classList.remove('tab-enter'), { once: true });
  setTimeout(() => btn.classList.remove('tab-enter'), 400);
}

// Death of a closed tab: the real button goes away with the strip rerender,
// while an inert clone stays in its place and shrinks/fades out.  Geometry is
// captured from the live button, so the caller runs this BEFORE renderStrip;
// the clone is attached one frame later, once the original is gone.
function animateTabClose(id) {
  if (document.body.classList.contains('no-anim')) return;
  const box = tEl('tabs');
  const btn = box && box.querySelector(`.tab[data-id="${id}"]`);
  if (!btn) return;
  const ghost = btn.cloneNode(true);
  ghost.classList.remove('active');
  ghost.classList.add('tab-ghost', 'tab-leave');
  ghost.removeAttribute('data-id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.tabIndex = -1;
  ghost.style.left = `${btn.offsetLeft}px`;
  ghost.style.top = `${btn.offsetTop}px`;
  ghost.style.width = `${btn.offsetWidth}px`;
  ghost.style.height = `${btn.offsetHeight}px`;
  requestAnimationFrame(() => {
    if (!box.isConnected) return;
    box.appendChild(ghost);
    const remove = () => ghost.remove();
    ghost.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 400); // safety net when animations are disabled
  });
}

/* FLIP соседей закрывающейся вкладки: без него живые вкладки телепортируются
   на освободившее место одним кадром (сам призрак при этом плавно сжимается —
   картинка «сжалась и съехала» читается рывком).  Позиции снимаются ДО
   ререндера, rAF-колбэк выполняется ДО отрисовки нового layout'а, поэтому
   сдвиг ставится в тот же кадр: смены позиций на экране не видно вообще —
   только 150-мс съезд трансформом.  Тот же токен, что у drag-FLIP. */
function flipAfterClose(removedIds) {
  if (!removedIds.length) return;
  if (document.body.classList.contains('no-anim')
    || document.body.classList.contains('tactile-off')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  const box = tEl('tabs');
  if (!box) return;
  const dying = new Set(removedIds);
  const before = new Map();
  for (const el of box.querySelectorAll(':scope > .tab[data-id]')) {
    if (!dying.has(Number(el.dataset.id))) before.set(el, el.offsetLeft);
  }
  if (!before.size) return;
  requestAnimationFrame(() => {
    for (const [el, old] of before) {
      if (!el.isConnected) continue;
      const delta = old - el.offsetLeft;
      if (!delta) continue;
      el.style.transition = 'none';
      el.style.transform = `translateX(${delta}px)`;
      void el.offsetWidth; // зафиксировать стартовый кадр
      el.style.transition = 'transform 150ms cubic-bezier(0.22, 0.9, 0.3, 1)';
      el.style.transform = 'none';
      const my = (el.__lbFlip = (el.__lbFlip || 0) + 1);
      const done = () => {
        if (el.__lbFlip !== my) return;
        el.style.transition = '';
        el.style.transform = '';
      };
      el.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 220); // страховка
    }
  });
}

function getIndicator(box) {
  let indicator = box.querySelector('.tab-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'tab-indicator';
    box.appendChild(indicator);
  }
  return indicator;
}

function moveIndicator(indicator, activeBtn) {
  if (!activeBtn) {
    indicator.style.opacity = '0';
    return;
  }
  indicator.style.opacity = '1';
  // With many tabs the active one can sit outside the visible strip.
  const box = activeBtn.parentElement;
  if (box) {
    const left = activeBtn.offsetLeft;
    const right = left + activeBtn.offsetWidth;
    if (left < box.scrollLeft) box.scrollLeft = left - 8;
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth + 8;
  }
  // The indicator lives inside the scroll box, so offsets are content-relative.
  // Layout-animation ban: position and size go through transform only — a
  // constant 100px base width is stretched with scaleX (radius distortion at
  // extreme scales is invisible on a 2px underline).
  const base = 100;
  const x = activeBtn.offsetLeft + 10;
  const w = Math.max(24, activeBtn.offsetWidth - 20);
  indicator.style.left = '0px';
  indicator.style.width = `${base}px`;
  indicator.style.transformOrigin = 'left center';
  indicator.style.transform = `translateX(${x}px) scaleX(${w / base})`;
}

/* ------------------------------------------------------------------ */
/* Sliding highlight (glider) behind the active tab                    */
/* ------------------------------------------------------------------ */

/* A persistent pill that travels to the active tab on every switch.  The
   strip is rebuilt on each host push (replaceChildren), so the element is
   re-inserted after every render and slid explicitly from its previous
   spot.  The slide is transform-only: translateX moves the left edge
   (transform-origin 0 50%) and scaleX carries the width against a 100px
   base, so no layout property is ever animated.  Positions come from
   getBoundingClientRect with the strip's scroll offset folded back in. */
const GLIDER_BASE_W = 100;

const gliderState = {
  el: null,
  x: 0,
  w: 0,
  valid: false,   // false whenever the last attempt could not measure
  settleTimer: 0,
  onSettle: null,
};

function ensureGlider(box) {
  if (gliderState.el && gliderState.el.parentElement === box) return gliderState.el;
  let glider = box.querySelector('.tab-glider');
  if (!glider) {
    glider = document.createElement('span');
    glider.className = 'tab-glider';
    glider.setAttribute('aria-hidden', 'true');
  }
  // First child: the .tab buttons are position:relative, so they paint above.
  box.insertBefore(glider, box.firstChild);
  gliderState.el = glider;
  return glider;
}

function gliderTransform(x, w) {
  return `translateX(${x.toFixed(2)}px) scaleX(${(w / GLIDER_BASE_W).toFixed(5)})`;
}

/* Interpolation instead of a CSS transition.  A transition restarts from the
   property value at the moment it is re-triggered, which for a fast second
   click means snapping back to the old tab before travelling again — the
   "дёрганье" this replaces.  Here every frame continues from wherever the
   pill actually is, so a rapid A->B->C reads as one continuous sweep. */
// Пружина второго порядка с недодемпфированием: пилюля прилетает к вкладке
// с одним мягким выбросом (~3% пути) — переключение ощущается как физический
// объект, а не как линейное схождение.  Интегратор — полушаг Эйлера с
// подшагами ≤ 8мс: один и тот же трек на 30 и на 144 Гц, устойчив на любом
// кадре.  Состояние скорости (vx/vw) живёт в gliderCur; QA-проба, кормящая
// чистую функцию, наследует его из возвращаемого объекта.
const GLIDER_W = 30;          // собственная частота (rad/с)
const GLIDER_ZETA = 0.75;     // демпфирование: выброс ~3%, оседание ~200мс
let gliderRaf = 0;
let gliderCur = null;
let gliderLast = 0;

function stopGliderLoop() {
  if (gliderRaf) cancelAnimationFrame(gliderRaf);
  gliderRaf = 0;
  gliderLast = 0;
}

// Один шаг пружины.  Чистая функция от состояния и времени — её же гоняет
// QA-проба (window.__lbGliderStep), поэтому «бесшовность» проверяется без
// зависимости от тиков rAF в фоновом окне.
function gliderStep(cur, ts, to, last) {
  const dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
  let x = cur.x, w = cur.w;
  let vx = cur.vx || 0, vw = cur.vw || 0;
  const n = Math.max(1, Math.ceil(dt / 0.008));
  const h = dt / n;
  const k = GLIDER_W * GLIDER_W;
  const c = 2 * GLIDER_ZETA * GLIDER_W;
  for (let i = 0; i < n; i++) {
    vx += (-k * (x - to.x) - c * vx) * h;
    x += vx * h;
    vw += (-k * (w - to.w) - c * vw) * h;
    w += vw * h;
  }
  if (Math.abs(to.x - x) < 0.35 && Math.abs(to.w - w) < 0.35
    && Math.abs(vx) < 30 && Math.abs(vw) < 30) return { x: to.x, w: to.w };
  return { x, w, vx, vw };
}
// Published on window (not just inside the IIFE) so the host's QA probe can
// replay the exact same step.  A module-scoped hook reads as undefined from
// ExecuteScriptAsync and silently turns the glide check into a null.
window.__lbGliderStep = (cur, ts, to) => gliderStep(cur, ts, to, ts - 16);

function animateGlider(glider, from, to) {
  stopGliderLoop();
  gliderCur = { x: from.x, w: from.w };
  const step = (ts) => {
    gliderRaf = 0;
    if (!gliderCur) return;
    const dx = to.x - gliderCur.x;
    const dw = to.w - gliderCur.w;
    gliderCur = gliderStep(gliderCur, ts, to, gliderLast);
    gliderLast = ts;
    if (Math.abs(dx) < 0.35 && Math.abs(dw) < 0.35) {
      gliderCur = { x: to.x, w: to.w };
      glider.style.transform = gliderTransform(to.x, to.w);
      glider.style.willChange = '';
      return;
    }
    glider.style.transform = gliderTransform(gliderCur.x, gliderCur.w);
    gliderRaf = requestAnimationFrame(step);
  };
  glider.style.willChange = 'transform';
  gliderRaf = requestAnimationFrame(step);
}

function applyGlider(glider, prev, next, animate) {
  const canSlide = !!(animate && prev)
    && !document.body.classList.contains('no-anim')
    && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  glider.style.transition = 'none';
  if (!canSlide) {
    // Snap (first paint, resize, return from omni mode): no motion, so the
    // pill lands instantly; the CSS opacity transition fades it in.
    stopGliderLoop();
    gliderCur = { x: next.x, w: next.w };
    glider.style.transform = gliderTransform(next.x, next.w);
    glider.style.willChange = '';
    glider.style.opacity = '1';
    return;
  }
  // Continue from the real on-screen position when a slide is in flight.
  const from = gliderCur || prev;
  if (!gliderCur) glider.style.transform = gliderTransform(from.x, from.w);
  animateGlider(glider, from, next);
  glider.style.opacity = '1';
}

function syncGlider(animate = true) {
  const box = tEl('tabs');
  if (!box) return;
  // A snap request that arrives while a slide is in flight would teleport the
  // pill mid-motion (switchTab re-renders the strip, then setBarMode snaps it).
  // Keep the running animation instead.
  if (!animate && gliderRaf) return;
  const glider = ensureGlider(box);
  const active = box.querySelector('.tab.active');
  // Hidden strip (omni mode) or no site tab active (home): hide the pill and
  // invalidate, so the next show snaps into place instead of sliding from a
  // stale spot.
  if (!active || box.offsetParent === null) {
    gliderState.valid = false;
    glider.style.opacity = '0';
    return;
  }
  const boxRect = box.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  if (!boxRect.width || !rect.width) {
    gliderState.valid = false;
    glider.style.opacity = '0';
    return;
  }
  const prev = gliderState.valid ? { x: gliderState.x, w: gliderState.w } : null;
  const next = {
    x: rect.left - boxRect.left + box.scrollLeft,
    w: rect.width,
  };
  gliderState.x = next.x;
  gliderState.w = next.w;
  gliderState.valid = true;
  applyGlider(glider, prev, next, animate);
}

/* ------------------------------------------------------------------ */
/* Drag & drop reordering of site tabs (mouse)                         */
/* ------------------------------------------------------------------ */

/* Mouse drag on a .tab inside #tabs.  The dragged button chases the cursor
   with exponential smoothing (rAF, frame-rate independent lag), the siblings
   FLIP out of the way (transform-only, 150ms), and on drop the final slot
   goes to the host as {"type":"reorder", id, index} — index counts SITE tabs
   (home excluded); the host owns the authoritative order and pushes tabs
   back, so tabState is never mutated locally when the bridge exists.
   Without a bridge the order is mirrored into tabState directly.
   Gates: no-anim / tactile-off / reduced-motion keep the functionality but
   skip the lag, the FLIP and the settle spring.                            */

const DRAG_ARM_DIST = 5;    // px of movement before the gesture becomes a drag
const DRAG_DOMINANCE = 1.5; // vertical/horizontal ratio that means "not a reorder"
const DRAG_K = 14;          // скорость схождения лага (1/с), как у glider
const FLIP_MS = 150;        // FLIP-переход соседей
const DRAG_LIFT = 1.055;    // подъём драгуемой вкладки (канал scale)
const DRAG_VEL_MAX = 4200;  // кламп скорости жеста (px/с) — защита от телепортов
const SETTLE_W = 26;        // собственная частота пружины досадки (rad/с)
const SETTLE_ZETA = 0.78;   // недодемпфирование: один мягкий выброс у слота

const drag = {
  pending: false,   // pointerdown есть, порог 5px ещё не пройден
  active: false,    // драг начался
  id: 0,
  btn: null,
  box: null,
  pointerId: -1,
  startX: 0,
  startY: 0,
  pointerCX: 0,     // курсор в контентных координатах стрипа (с scrollLeft)
  grabDx: 0,        // курсор относительно левого края вкладки в момент старта
  boxRect: null,
  tabW: 0,
  contentW: 0,
  cur: 0,           // текущий translateX драгуемой кнопки (px)
  scale: 1,         // текущий scale подъёма (канал того же transform)
  vel: 0,           // скорость жеста (px/с, EMA) — стартовая скорость досадки
  prevCX: 0,        // pointerCX прошлой выборки — база скорости
  moveTs: 0,        // timestamp прошлой выборки курсора
  index: -1,        // текущий слот среди сайт-вкладок
  origIndex: -1,    // слот на момент старта
  origNext: null,   // сосед справа на старте — точка возврата Escape-отмены
  raf: 0,
  lastTs: 0,
};

const REDUCED_MQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

// Гейты физики: сам драг работает всегда, лаг/FLIP/пружина — нет.
function motionOff() {
  return document.body.classList.contains('no-anim')
    || document.body.classList.contains('tactile-off')
    || !!(REDUCED_MQ && REDUCED_MQ.matches);
}

function siteIndex(box, btn) {
  return [...box.querySelectorAll(':scope > .tab[data-id]')].indexOf(btn);
}

function stopDragLoop() {
  if (drag.raf) cancelAnimationFrame(drag.raf);
  drag.raf = 0;
  drag.lastTs = 0;
}

function releaseCapture(btn, pointerId) {
  try { btn.releasePointerCapture(pointerId); } catch { /* не был захвачен */ }
}

// Инлайн-стили драга собираются и снимаются одним местом: will-change и
// z-index живут только пока кнопка реально анимируется.
function clearDragStyles(btn) {
  btn.style.transition = '';
  btn.style.transform = '';
  btn.style.willChange = '';
  btn.style.zIndex = '';
  btn.classList.remove('tab-drag-src');
}

function resetDragFields() {
  drag.id = 0;
  drag.btn = null;
  drag.box = null;
  drag.pointerId = -1;
  drag.startX = 0;
  drag.startY = 0;
  drag.pointerCX = 0;
  drag.grabDx = 0;
  drag.boxRect = null;
  drag.tabW = 0;
  drag.contentW = 0;
  drag.cur = 0;
  drag.scale = 1;
  drag.vel = 0;
  drag.prevCX = 0;
  drag.moveTs = 0;
  drag.index = -1;
  drag.origIndex = -1;
  drag.origNext = null;
}

/* ------------------------------------------------------------------ */
/* Settle: мягкая досадка кнопки в её слот после drop/отмены            */
/* ------------------------------------------------------------------ */

// Одновременно живёт максимум один settle — новый вызов прибирает прошлый,
// поэтому ни стили, ни таймер не протекают между жестами.
let settleCleanup = null;

function finishSettle() {
  if (settleCleanup) settleCleanup(); // finish() сам обнулит settleCleanup
}

function settleDragged(btn, syncAfter, snap) {
  finishSettle();
  // Стартовое состояние: позиция и скорость в момент отпускания.  Раньше
  // досадка была константным CSS-переходом и всегда стартовала с нулевой
  // скорости — при флинге вкладка «умирала» у слота.  Теперь пружина
  // наследует скорость жеста: бросок доезжает инерцией, плавный перенос —
  // мягкой досадкой.  Тот же объект — тумблер и сам выход из него.
  let x = snap ? snap.x : 0;
  let v = snap ? Math.max(-DRAG_VEL_MAX, Math.min(DRAG_VEL_MAX, snap.v || 0)) : 0;
  let s = snap && snap.s ? snap.s : 1;
  let raf = 0;
  let last = 0;
  let timer = 0;
  const finish = (skipSync) => {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearDragStyles(btn);
    settleCleanup = null;
    if (!skipSync && syncAfter) syncGlider(); // пилюля догоняет после досадки
  };
  if (motionOff() || (Math.abs(x) < 0.5 && Math.abs(v) < 30 && Math.abs(s - 1) < 0.004)) {
    finish(false);
    return;
  }
  const step = (ts) => {
    raf = 0;
    if (!btn.isConnected) { finish(false); return; } // стрип пересобрал пуш
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
    last = ts;
    // Полушаг Эйлера с подшагами ≤ 8мс: устойчиво на любом fps (30…144+).
    const n = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / n;
    const k = SETTLE_W * SETTLE_W;
    const c = 2 * SETTLE_ZETA * SETTLE_W;
    for (let i = 0; i < n; i++) {
      v += (-k * x - c * v) * h;
      x += v * h;
      s += (1 - s) * (1 - Math.exp(-18 * h));
    }
    if (Math.abs(x) < 0.4 && Math.abs(v) < 24 && Math.abs(s - 1) < 0.004) {
      finish(false);
      return;
    }
    btn.style.transform = `translateX(${x.toFixed(2)}px) scale(${s.toFixed(3)})`;
    raf = requestAnimationFrame(step);
  };
  timer = setTimeout(() => { if (raf) finish(false); }, 550); // страховка
  settleCleanup = () => finish(true);
  raf = requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ */
/* Сторож синтетического click                                          */
/* ------------------------------------------------------------------ */

/* Гасить click на САМОЙ кнопке каптурой нельзя: на целевом узле порядок
   регистрации решает, а switchTab там зарегистрирован раньше.  Поэтому один
   общий каптурный слушатель на document: он глотает ровно один click по
   кнопке — тот, что приходит сразу за pointerup драга.  Любой новый
   pointerdown сторож снимает: легитимный клик всегда начинается с нажатия,
   так что сторож не проживёт дольше мгновения и не съест чужой клик.       */
let clickGuard = null;

function guardClick(btn) {
  clickGuard = btn || null;
}

/* ------------------------------------------------------------------ */
/* Жест                                                                 */
/* ------------------------------------------------------------------ */

function onStripPointerDown(e) {
  if (e.button !== 0) return;
  if (drag.pending || drag.active) return;
  if (e.target.closest('.tab-close')) return; // × — закрытие, не драг
  const box = tEl('tabs');
  const btn = e.target.closest('.tab[data-id]');
  if (!box || !btn || !box.contains(btn)) return;
  const id = Number(btn.dataset.id);
  if (!id) return; // «Рабочий стол» закреплён и живёт вне бокса
  clickGuard = null; // новое нажатие обнуляет сторож прошлого драга
  drag.pending = true;
  drag.id = id;
  drag.btn = btn;
  drag.box = box;
  drag.pointerId = e.pointerId;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.origIndex = siteIndex(box, btn);
  drag.origNext = btn.nextSibling;
  try { btn.setPointerCapture(e.pointerId); } catch { /* пойнтер уже ушёл */ }
}

function abortPending() {
  if (!drag.pending) return;
  drag.pending = false;
  if (drag.btn) releaseCapture(drag.btn, drag.pointerId);
  resetDragFields();
}

// Ось полосы: в обычном режиме вкладки стоят рядом по X, в колонке — по Y.
// Перетаскивание меряет ту же ось, что и раскладка, иначе в колонке жест
// «вертикаль доминирует» навсегда отменял бы реордер.
function stripVertical() {
  return document.body.classList.contains('vertical-tabs');
}

// Координата по оси полосы для точки курсора (с учётом прокрутки стрипа).
function axisPos(e, box) {
  const r = box.getBoundingClientRect();
  return stripVertical() ? e.clientY - r.top + box.scrollTop
                         : e.clientX - r.left + box.scrollLeft;
}

// Позиция и размер вкладки по оси полосы (в координатах контента стрипа).
function axisOffset(el) {
  return stripVertical() ? el.offsetTop : el.offsetLeft;
}

function axisSize(el) {
  return stripVertical() ? el.offsetHeight : el.offsetWidth;
}

// Смещение по оси полосы (не по X экрана): какая ось у transform, решает
// режим — подписи «translateX» в вызывающем коде остаются смыслом «вдоль».
function axisTransform(px, scale) {
  const t = stripVertical() ? `translateY(${px.toFixed(2)}px)` : `translateX(${px.toFixed(2)}px)`;
  return scale === undefined ? t : `${t} scale(${scale.toFixed(3)})`;
}

function beginDrag(e) {
  const d = drag;
  const box = d.box;
  const btn = d.btn;
  finishSettle(); // прошлый settle мог ещё досаживать на этой же кнопке
  // Пока палец лежал до порога, DOM мог перекроиться (пуш, Ctrl+W) — точку
  // возврата и слот переснимаем: «исходный» = где кнопка визуально сейчас.
  d.origIndex = siteIndex(box, btn);
  d.origNext = btn.nextSibling;
  d.pending = false;
  d.active = true;
  d.boxRect = box.getBoundingClientRect();
  d.tabW = axisSize(btn);
  d.contentW = stripVertical() ? box.scrollHeight : box.scrollWidth;
  d.pointerCX = axisPos(e, box);
  d.grabDx = d.pointerCX - axisOffset(btn);
  d.cur = 0;
  d.index = d.origIndex;
  box.classList.add('tab-dragging');
  btn.classList.add('tab-drag-src');
  // Squish уже сыграл в кадре нажатия; с этого момента transform ведёт
  // только drag-код (лаг + подъём).  .is-pressed под .tab-dragging имел
  // !important-трансформ — он не должен пересекаться с инлайном ни при
  // какой интерпретации каскада.
  btn.classList.remove('is-pressed');
  // z-index инлайном: кнопка должна жить над соседями независимо от css.
  btn.style.zIndex = '5';
  // Килл css-переходов кнопки в ОБЕИХ режимах: feel-слой вешает на .tab
  // пружину transform .32s — без неё каждый кадр лага анимировался бы заново
  // поверх rAF, а «мгновенный» режим тянулся бы резиной.
  btn.style.transition = 'none';
  if (motionOff()) return; // без физики: трансформ ставится прямо в pointermove
  btn.style.willChange = 'transform';
  d.lastTs = 0;
  d.raf = requestAnimationFrame(dragFrame);
  // Пилюля могла остаться у прошлого неописанного рендера (settle оборвали)
  // — сверяем позицию по активной вкладке, пока геометрия ещё чистая.
  syncGlider();
}

function onStripPointerMove(e) {
  const d = drag;
  if ((!d.pending && !d.active) || e.pointerId !== d.pointerId) return;
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  if (d.pending) {
    if (Math.hypot(dx, dy) < DRAG_ARM_DIST) return;
    // Движение ПОПЕРЁК полосы явно доминирует — жест не про реордер, тихо
    // отпускаем (в колонке поперёк — это X, в обычной полосе — Y).
    const across = stripVertical() ? Math.abs(dx) > Math.abs(dy) * DRAG_DOMINANCE
                                   : Math.abs(dy) > Math.abs(dx) * DRAG_DOMINANCE;
    if (across) { abortPending(); return; }
    // Кнопка могла пережить пересборку стрипа за время нажатия.
    if (!d.btn.isConnected || d.btn.dataset.id !== String(d.id)) { abortPending(); return; }
    beginDrag(e);
  }
  if (!d.active || !d.btn) return;
  d.pointerCX = axisPos(e, d.box);
  // Скорость жеста (EMA по выборкам pointermove) — стартовая скорость
  // пружины досадки.  В steady-state скорость кнопки ≈ скорости курсора,
  // так что бросок «доезжает» честно.
  const nowTs = e.timeStamp || performance.now();
  if (d.moveTs) {
    const dms = Math.max(1, nowTs - d.moveTs);
    d.vel = d.vel * 0.75 + ((d.pointerCX - d.prevCX) / dms) * 1000 * 0.25;
    if (d.vel > DRAG_VEL_MAX) d.vel = DRAG_VEL_MAX;
    else if (d.vel < -DRAG_VEL_MAX) d.vel = -DRAG_VEL_MAX;
  }
  d.prevCX = d.pointerCX;
  d.moveTs = nowTs;
  const idx = computeIndex(d.box, d.btn, d.pointerCX);
  if (idx !== d.index) {
    d.index = idx;
    reorderTo(d.box, d.btn, idx);
  }
  if (motionOff()) d.btn.style.transform = axisTransform(targetTransform());
}

/* Один шаг лага.  Экспоненциальное сглаживание по времени (1 - exp(-k*dt)):
   шаг не зависит от fps — тот же визуальный трек на 30 и на 144 герцах,
   как у glider-пружины.  rAF — единственный драйвер физики.                */
function dragFrame(ts) {
  const d = drag;
  d.raf = 0;
  if (!d.active || !d.btn || !d.btn.isConnected) return;
  if (!d.box || d.box.offsetParent === null) { cancelDrag(false); return; } // стрип скрыли
  const dt = d.lastTs ? Math.min(0.05, (ts - d.lastTs) / 1000) : 1 / 60;
  d.lastTs = ts;
  const to = targetTransform();
  d.cur += (to - d.cur) * (1 - Math.exp(-DRAG_K * dt));
  // Курсор замер — инерция броска затухает: долгое удержание не должно
  // выстреливать вкладкой при отпускании.
  if (d.moveTs && performance.now() - d.moveTs > 90) d.vel *= Math.exp(-7 * dt);
  // Подъём — отдельный канал того же transform: вкладка «отрывается» от
  // полосы, тень проявляет ::after (см. .tab-drag-src в app.css).
  d.scale += (DRAG_LIFT - d.scale) * (1 - Math.exp(-18 * dt));
  if (Math.abs(to - d.cur) < 0.35) d.cur = to;
  if (Math.abs(DRAG_LIFT - d.scale) < 0.001) d.scale = DRAG_LIFT;
  d.btn.style.transform = axisTransform(d.cur, d.scale);
  d.raf = requestAnimationFrame(dragFrame);
}

// Куда сейчас должна смотреть трансформация: курсор минус точка захвата,
// зажатый в пределах контента стрипа, минус текущий слот кнопки (слот
// меняется на каждой перестановке — см. компенсацию в reorderTo).
function targetTransform() {
  const d = drag;
  const max = Math.max(0, d.contentW - d.tabW);
  const visual = Math.max(0, Math.min(d.pointerCX - d.grabDx, max));
  return visual - axisOffset(d.btn);
}

// Индекс вставки по серединам остальных вкладок (контентные координаты).
function computeIndex(box, draggedBtn, contentX) {
  let idx = 0;
  for (const el of box.querySelectorAll(':scope > .tab[data-id]')) {
    if (el === draggedBtn) continue;
    if (contentX > axisOffset(el) + axisSize(el) / 2) idx++;
  }
  return idx;
}

/* ------------------------------------------------------------------ */
/* Перестановка: перенос слота + FLIP соседей                           */
/* ------------------------------------------------------------------ */

function reorderTo(box, btn, newIndex) {
  const all = [...box.querySelectorAll(':scope > .tab[data-id]')];
  if (all.indexOf(btn) === newIndex) return;
  const others = all.filter((el) => el !== btn);
  const animated = !motionOff();
  const before = new Map();
  if (animated) for (const el of others) before.set(el, axisOffset(el));
  const slotBefore = axisOffset(btn);
  box.insertBefore(btn, others[newIndex] || null);
  // Слот драгуемой кнопки сместился — поправка на ту же визуальную точку:
  // лаг продолжается без прыжка, а FLIP ниже её трансформ не трогает.
  drag.cur += slotBefore - axisOffset(btn);
  if (animated) flipSiblings(box, others, before);
}

/* FLIP соседей: старые offsetLeft сняты ДО перестановки, после неё сдвиг
   компенсируется трансформом из старой позиции, один форс-рефлоу на партию
   фиксирует старт — затем 150ms переход в «none».  Только transform:
   offsetLeft читается, но не анимируется.                                  */
function flipSiblings(box, others, before) {
  const moves = [];
  for (const el of others) {
    const delta = (before.get(el) || 0) - axisOffset(el);
    if (delta) moves.push([el, delta]);
  }
  if (!moves.length) return;
  for (const [el, delta] of moves) {
    el.style.transition = 'none';
    el.style.transform = axisTransform(delta);
    el.style.willChange = 'transform';
  }
  void box.offsetWidth; // зафиксировать стартовый кадр до включения перехода
  for (const [el] of moves) {
    // Лёгкий перелёт (1.22): соседи съезжаются как пружинящие предметы, а не
    // как линейные тени.  Тот же канал transform, длительность прежняя.
    el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.3,1.22,0.42,1)`;
    el.style.transform = 'none';
    // Токен на элемент: если по кнопке уже идёт прошлый FLIP, его страховка
    // и transitionend не посмеют снять стили нового.
    const my = (el.__lbFlip = (el.__lbFlip || 0) + 1);
    const done = () => {
      if (el.__lbFlip !== my) return;
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
    };
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, FLIP_MS + 70); // страховка (setTimeout не драйвит анимацию)
  }
}

/* ------------------------------------------------------------------ */
/* Drop / cancel                                                        */
/* ------------------------------------------------------------------ */

function onStripPointerUp(e) {
  const d = drag;
  if ((!d.pending && !d.active) || e.pointerId !== d.pointerId) return;
  if (d.pending) { abortPending(); return; } // клик без драга проходит как всегда
  finishDrag();
}

function onStripPointerCancel(e) {
  const d = drag;
  if ((!d.pending && !d.active) || e.pointerId !== d.pointerId) return;
  if (d.pending) abortPending();
  else cancelDrag(false);
}

// Escape среди драга: вернуть как было, reorder не слать.
function onDragKeydown(e) {
  if (e.key !== 'Escape') return;
  if (drag.pending) abortPending();
  else if (drag.active) cancelDrag(false);
}

function finishDrag() {
  const d = drag;
  const btn = d.btn;
  const box = d.box;
  if (!btn || !box) { resetDragFields(); return; }
  stopDragLoop();
  d.active = false;
  d.pending = false;
  box.classList.remove('tab-dragging');
  releaseCapture(btn, d.pointerId);
  guardClick(btn); // синтетический click после отпускания не активирует вкладку
  const finalIndex = siteIndex(box, btn);
  const moved = finalIndex !== d.origIndex;
  if (moved) {
    if (window.chrome?.webview) {
      // Хост — авторитет порядка: шлём финальный слот и ждём его tabs-push,
      // tabState локально не трогаем, чтобы не спорить с хостом.
      tPostToHost({ type: 'reorder', id: Number(d.id), index: finalIndex });
    } else {
      reorderLocal(d.id, finalIndex);
      renderStrip();
    }
  }
  // Снапшот ДО сброса полей: пружина досадки наследует позицию, скорость
  // жеста и подъём — бросок доезжает инерцией, а не умирает у слота.
  const snap = { x: d.cur, v: d.vel, s: d.scale };
  resetDragFields();
  settleDragged(btn, moved, snap);
}

/* Отмена драга.  silent=true — пуш хоста посреди драга: порядок всё равно
   перезамет хост, снимаем мгновенно, без анимаций и без сторожа клика
   (отпустив кнопку после чужого пуша, пользователь просто кликает вкладку).
   silent=false — явная отмена (Escape/pointercancel): вернуть кнопку на
   исходный слот и пружинкой довести трансформ до нуля.                     */
function cancelDrag(silent) {
  const d = drag;
  if (!d.pending && !d.active) return;
  const wasActive = d.active;
  const btn = d.btn;
  const box = d.box;
  const origNext = d.origNext;
  stopDragLoop();
  d.active = false;
  d.pending = false;
  if (box) box.classList.remove('tab-dragging');
  if (btn) {
    releaseCapture(btn, d.pointerId);
    if (silent) {
      clearDragStyles(btn);
    } else {
      if (wasActive) guardClick(btn);
      // Точка возврата зафиксирована на старте; сосед мог умереть посреди
      // драга (закрыли из другого окна) — тогда просто в конец, renderStrip
      // ниже всё равно сверит порядок с tabState.
      if (origNext && origNext.parentElement === box) box.insertBefore(btn, origNext);
      else box.appendChild(btn);
      // Слоты ещё живы — снимаем позицию/скорость/подъём до resetDragFields.
      settleDragged(btn, true, { x: d.cur, v: d.vel, s: d.scale });
    }
  }
  resetDragFields();
  if (!silent) renderStrip(); // дозакрыть правки, пропущенные во время драга
}

// Без хоста: зеркало порядка в tabState.  index — позиция среди САЙТОВЫХ
// вкладок («Рабочий стол» не считается), ровно как в сообщении хосту.
function reorderLocal(id, index) {
  const arr = tabState.tabs;
  const i = arr.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [item] = arr.splice(i, 1);
  let seen = 0;
  let at = arr.length;
  for (let k = 0; k < arr.length; k++) {
    if (arr[k].id === 0) continue;
    if (seen === index) { at = k; break; }
    seen++;
  }
  arr.splice(at, 0, item);
}

/* ------------------------------------------------------------------ */
/* Tab operations                                                      */
/* ------------------------------------------------------------------ */

// Opens (or re-focuses) `url` in the host.  The host pushes the new tab list;
// in fallback mode we mirror the tab ourselves and open a real window.
function openTab(url, label) {
  if (window.chrome?.webview) {
    // Бар обязан вернуться в режим вкладок ДО открытия: плитку часто жмут,
    // когда омнибокс в фокусе (после «+») — без этого mode-omni переживал
    // открытие сайта, стрип скрывался и «поисковик не убирался».
    window.LiveUi?.setBarMode('tabs');
    const search = tEl('search');
    if (search) { search.value = ''; search.blur(); }
    tPostToHost({ type: 'open', url, label: label || '' });
    return;
  }
  const existing = tabState.tabs.find((t) => t.url === url);
  if (existing) return switchTab(existing.id);

  const id = tabState.tabs.reduce((max, t) => Math.max(max, t.id), 0) + 1;
  tabState.tabs.push({ id, title: label || url, url, favicon: '', loading: false, accent: 0x7c5cff });
  tabState.activeId = id;
  syncStage();
  renderStrip([id]);
  window.LiveUi?.setBarMode('tabs');
  tEl('search').value = '';
  window.open(url, `lb-${id}`, 'noopener');
}

function switchTab(id) {
  if (!tabState.tabs.some((t) => t.id === id)) return;
  // Mirror the switch locally first: the UI never keeps showing a stale tab.
  tabState.activeId = id;
  syncStage();
  renderStrip();
  progressSyncActive();
  if (window.chrome?.webview) tPostToHost({ type: 'activate', id });
  window.LiveUi?.setBarMode('tabs');
}

function closeTab(id) {
  if (id === 0) return; // the home tab cannot be closed
  if (window.chrome?.webview) {
    tPostToHost({ type: 'close', id });
    return;
  }
  const i = tabState.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  animateTabClose(id);
  tabState.tabs.splice(i, 1);
  if (tabState.activeId === id) {
    const neighbor = tabState.tabs[Math.min(i, tabState.tabs.length - 1)];
    tabState.activeId = neighbor ? neighbor.id : 0;
    syncStage();
  }
  renderStrip();
}

// Home button / Ctrl+T: back to the desktop with the omnibox focused.
function goHome() {
  switchTab(0);
  const input = tEl('search');
  window.LiveUi?.setBarMode('omni');
  if (input) {
    input.focus();
    input.select();
  }
}

// Ctrl+Tab / Ctrl+Shift+Tab: cycle over the tabs we currently know about.
function cycleTab(dir) {
  const list = tabState.tabs;
  if (list.length < 2) return;
  let i = list.findIndex((t) => t.id === tabState.activeId);
  if (i < 0) i = 0;
  switchTab(list[(i + dir + list.length) % list.length].id);
}

// Ctrl+Shift+T: ask the host to reopen the last closed tab.  The host owns
// the lastClosed record and does the reopening itself — the shell only sends
// the message, unconditionally (our closedStack is just a mirror and may be
// empty after a reload while the host still remembers).  When a site tab
// owns the keyboard focus, the host intercepts Ctrl+Shift+T in its
// ProcessCmdKey first, so exactly one side reacts — no double reopen.
function reopenClosedTab() {
  if (window.chrome?.webview) {
    tPostToHost({ type: 'reopen' });
    // Acknowledge the command (the host decides whether a reopen is actually
    // possible — its lastClosed record is the authority).
    window.showToast?.('Восстанавливаю вкладку…');
  }
}

/* ------------------------------------------------------------------ */
/* Host pushes                                                         */
/* ------------------------------------------------------------------ */

// Mirror of the host's tab list; called from app.js's bridge listener.
function handleTabs(msg) {
  if (!msg || !Array.isArray(msg.tabs)) return;
  // Пуш хоста посреди драга: порядок хоста — авторитет, живой драг снимаем
  // молча (без анимаций и восстановления слота), reconcile ниже пересоберёт
  // strip по его порядку.
  if (drag.pending || drag.active) cancelDrag(true);
  // Diagnostics: the host probe dumps this counter to see whether tabs
  // messages actually reach this handler.
  window.__tabsSeen = (window.__tabsSeen || 0) + 1;
  window.__lastTabsCount = msg.tabs.length;
  // Фавиконки вкладок — в постоянный кэш (turbo.js, lb_fav_<host>):
  // ими пользуются плитки рабочего стола (buildLinkTile) и заглушки
  // вкладок.  Запись бесплатна — favicon уже приехал в пушe хоста.
  for (const t of msg.tabs) {
    if (t && t.url && t.favicon && typeof window.__lbFaviconSave === 'function') {
      try { window.__lbFaviconSave(t.url, t.favicon); } catch { /* quota */ }
    }
  }
  const prevActive = tabState.activeId;
  const prevTabs = tabState.tabs;
  tabState.tabs = msg.tabs.map((t) => ({
    id: Number(t.id) || 0,
    title: t.title || '',
    url: t.url || '',
    favicon: t.favicon || '',
    loading: !!t.loading,
    accent: t.accent,
    audible: !!t.audible,
    muted: !!t.muted,
  }));
  tabState.activeId = Number(msg.activeId) || 0;
  rememberClosed(prevTabs);
  // Animation diff: ids the host added were just born, ids it dropped just
  // closed (the host never reuses an id within a session).
  const prevIds = new Set(prevTabs.map((t) => t.id));
  const currentIds = new Set(tabState.tabs.map((t) => t.id));
  const addedIds = tabState.tabs
    .filter((t) => t.id !== 0 && !prevIds.has(t.id))
    .map((t) => t.id);
  const removedIds = prevTabs
    .filter((t) => t.id !== 0 && !currentIds.has(t.id))
    .map((t) => t.id);
  for (const id of removedIds) progressState.delete(id);
  if (tabState.activeId !== prevActive) {
    flashTabSwitch();
    // The home stage has no site: its address is our own page, hide the pill.
    const tab = tabState.tabs.find((t) => t.id === tabState.activeId);
    showAddress(tab ? tab.url : '');
  }
  // Ghosts must capture the live buttons' geometry BEFORE the strip rerenders.
  for (const id of removedIds) animateTabClose(id);
  // Соседи закрывшейся вкладки съезжают на её место плавным трансформом.
  flipAfterClose(removedIds);
  // fast: подмена под шторкой — десктоп прячется мгновенно (msg.fast ставит
  // хост в PushTabs(fast) из колбэка шторки).
  syncStage({ instant: !!msg.fast });
  renderStrip(addedIds);
  progressSyncActive();
}

// Diffs the previous tab list against the new one: every id the host dropped
// has just been closed, so its url/title goes into closedStack (the newest
// last, capped).  Bookkeeping only — the host keeps its own lastClosed and
// does the actual reopening.
function rememberClosed(prevTabs) {
  const alive = new Set(tabState.tabs.map((t) => t.id));
  for (const t of prevTabs) {
    if (t.id === 0 || alive.has(t.id)) continue; // home is permanent
    closedStack.push({ url: t.url, label: t.title });
    if (closedStack.length > CLOSED_STACK_MAX) closedStack.shift();
  }
}

/* ------------------------------------------------------------------ */
/* Address pill                                                        */
/* ------------------------------------------------------------------ */

let lastShownUrl = '';

// Splits a URL into the bold host and the grey path/query, the way every
// browser's address bar does.  Anything unparsable is shown as-is.
// Исход капсулы адреса (возврат на десктоп): уезжает вверх с fade, hidden —
// после анимации.  Данные чистим сразу, чтобы «призрак» не словил клик.
function hideAddressPill() {
  const pill = tEl('addr-pill');
  if (!pill || pill.hidden) return;
  const quiet = document.body.classList.contains('no-anim')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (quiet) { pill.hidden = true; return; }
  pill.classList.remove('pill-out');
  void pill.offsetWidth; // рестарт на быстрой смене вкладок
  pill.classList.add('pill-out');
  const tok = (pill.__lbPillTok = (pill.__lbPillTok || 0) + 1);
  const done = () => {
    if (pill.__lbPillTok !== tok) return; // капсулу показали заново
    pill.classList.remove('pill-out');
    pill.hidden = true;
    pill.removeEventListener('animationend', done);
  };
  pill.addEventListener('animationend', done);
  setTimeout(done, 220); // 180мс анимация + запас
}

// Вход капсулы адреса: зеркален pill-out (уезд вверх + fade).  Токен гасит
// гонку с hideAddressPill: излёт в окне входа не должен ждать снятия класса
// от немого таймера (раньше pill-in переигрывал pill-out).
function playPillIn(pill) {
  const quiet = document.body.classList.contains('no-anim')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (quiet) return;
  const tok = (pill.__lbPillInTok = (pill.__lbPillInTok || 0) + 1);
  pill.classList.remove('pill-in');
  void pill.offsetWidth; // рестарт при быстрой смене вкладок
  pill.classList.add('pill-in');
  const done = () => {
    if (pill.__lbPillInTok !== tok) return; // излёт уже забрал пилюлю
    pill.classList.remove('pill-in');
  };
  pill.addEventListener('animationend', done, { once: true });
  setTimeout(done, 240); // страховка под no-anim/паузу
}

function showAddress(url) {
  const pill = tEl('addr-pill');
  if (!pill) return;
  if (!url || url.startsWith('https://livebrowser.shell')) {
    hideAddressPill();
    pill.dataset.url = '';
    return;
  }
  // Показ отменяет исход: гасим отложенное скрытие (токен) и классы.
  pill.__lbPillTok = (pill.__lbPillTok || 0) + 1;
  // Вход-класс снять немедленно и погасить его cleanup-таймер (иначе
  // pill-in переигрывает pill-out в окне излёта).
  pill.__lbPillInTok = (pill.__lbPillInTok || 0) + 1;
  pill.classList.remove('pill-in');
  pill.classList.remove('pill-out');
  let u;
  try { u = new URL(url); } catch { u = null; }
  if (!u) { pill.hidden = true; return; }
  // The lock must not lie: plain http gets the crossed-out, danger-tinted
  // state so an unprotected site is recognisable at a glance.
  const secure = u.protocol === 'https:' || u.protocol === 'about:' || u.protocol === 'file:';
  pill.classList.toggle('addr-insecure', !secure);
  pill.title = secure
    ? 'Адрес сайта — нажми, чтобы изменить'
    : 'Соединение не защищено — нажми, чтобы изменить адрес';
  const host = u.host.replace(/^www\./, '');
  const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
  tEl('addr-host').textContent = host;
  tEl('addr-rest').textContent = rest;
  // A new address is a new page: the block counter starts from zero, so the
  // shield never shows the previous page's number on this one.
  window.__lbAdShieldReset?.();
  pill.dataset.url = url;
  // Вход зеркален выходу (pill-out): пилюля не «включается кадром».
  // Обновление URL при уже видимой пилюле каскад не переигрывает.
  const wasHidden = pill.hidden;
  pill.hidden = false;
  if (wasHidden) playPillIn(pill);
  lastShownUrl = url;
}

async function copyAddress() {
  const url = tEl('addr-pill')?.dataset.url;
  if (!url) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    else {
      // Clipboard API can be refused without a user gesture; the old
      // execCommand path still works in WebView2.  A refused copy returns
      // false — surface that instead of pretending it worked.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy refused');
    }
    const pill = tEl('addr-pill');
    pill.classList.add('copied');
    setTimeout(() => pill.classList.remove('copied'), 900);
    window.showToast?.('Адрес скопирован');
  } catch {
    window.showToast?.('Не удалось скопировать');
  }
}

function initAddrPill() {
  const pill = tEl('addr-pill');
  if (!pill) return;
  if (window.chrome?.webview) pill.hidden = false;
  // Clicking the pill opens the omnibox prefilled with the current address;
  // the copy icon is a nested control and must not trigger that.
  pill.addEventListener('click', (e) => {
    if (e.target.closest('.addr-copy')) return;
    const input = tEl('search');
    if (!input) return;
    window.LiveUi?.setBarMode('omni');
    input.value = pill.dataset.url || '';
    input.focus();
    input.select();
  });
  tEl('addr-copy')?.addEventListener('click', (e) => {
    e.stopPropagation();
    copyAddress();
  });
  tEl('addr-copy')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); copyAddress(); }
  });
}

// A short accent bloom under the bar when the active tab changes; it makes
// the hand-off feel instant even before the new page paints.
function flashTabSwitch() {
  const wash = tEl('tab-wash');
  if (!wash) return;
  wash.classList.remove('flash');
  void wash.offsetWidth;
  wash.classList.add('flash');
}

function onNav(msg) {
  if (!msg || Number(msg.id) !== tabState.activeId) return;
  const bar = tEl('chrome-bar');
  if (!bar) return;
  bar.classList.toggle('is-loading', !!msg.loading);
  const home = msg.id === 0;
  if (tEl('nav-back')) tEl('nav-back').disabled = !msg.canBack || home;
  if (tEl('nav-forward')) tEl('nav-forward').disabled = !msg.canForward || home;
  if (typeof msg.url === 'string') showAddress(msg.url);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function initTabs() {
  if (!window.chrome?.webview) document.body.classList.add('no-host');

  tEl('tab-home-tab')?.addEventListener('click', () => switchTab(0));
  tEl('tab-new')?.addEventListener('click', goHome);
  tEl('tab-home')?.addEventListener('click', goHome);

  // Bridge nav buttons only make sense with a host; hide them otherwise.
  for (const [id, action] of [['nav-back', 'back'], ['nav-forward', 'forward'], ['nav-reload', 'reload']]) {
    const btn = tEl(id);
    if (!btn) continue;
    if (!window.chrome?.webview) { btn.hidden = true; continue; }
    btn.addEventListener('click', () => tPostToHost({ type: 'nav', action }));
  }

  initAddrPill();
  syncStage();
  renderStrip();

  // Window resizes and zoom changes reshape the strip: re-measure the glider
  // without a slide (the pill should never travel across a resize).
  window.addEventListener('resize', () => syncGlider(false), { passive: true });

  // Драг-реордер вкладок: слушатели живут на боксе ПОСТОЯННО (делегирование),
  // а не навешиваются на каждый жест.  setPointerCapture перенаправляет
  // события пойнтера на кнопку, и они всплывают до бокса.
  const strip = tEl('tabs');
  if (strip) {
    strip.addEventListener('pointerdown', onStripPointerDown);
    strip.addEventListener('pointermove', onStripPointerMove);
    strip.addEventListener('pointerup', onStripPointerUp);
    strip.addEventListener('pointercancel', onStripPointerCancel);
    // Колесо над полосой: стрип скроллится по горизонтали (overflow-x),
    // а колесо приходит вертикальным (deltaY), поэтому без перевода
    // переполненная полоса не листается вовсе.  Слушатель passive:false —
    // нужен preventDefault, иначе браузер ещё и страницу под курсором
    // попробует прокрутить.  Пока всё влезает, событие не трогаем.
    strip.addEventListener('wheel', (e) => {
      // Колонка листается по вертикали нативно: браузер делает это сам.
      if (stripVertical()) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!d) return;
      const before = strip.scrollLeft;
      strip.scrollLeft = before + d;
      // Край стрипа: отдаём событие дальше (страница/рабочий стол).
      if (strip.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
  }
  window.addEventListener('keydown', onDragKeydown);
  // Сторож синтетического клика — один каптурный слушатель на всё время
  // (см. комментарий у clickGuard: каптура на предке, не на самой кнопке).
  document.addEventListener('click', (e) => {
    const btn = clickGuard;
    if (!btn) return;
    if (e.target !== btn && !btn.contains(e.target)) return;
    clickGuard = null;
    e.stopPropagation(); // switchTab на кнопке не должен услышать этот click
    e.preventDefault();
  }, true);
  // Любое новое нажатие гасит сторож: он живёт только между pointerup драга
  // и мгновенно следующим за ним click.
  document.addEventListener('pointerdown', () => { clickGuard = null; }, true);

  window.addEventListener('keydown', (e) => {
    // Esc в фокус-режиме с фокусом на шелле: возврат полосы.  Только когда
    // ничего не перекрывает страницу — иначе Esc принадлежит панели/диалогу.
    if (e.key === 'Escape' && document.body.classList.contains('focus-mode')
        && !document.querySelector('.menu.show, .lb-menu.show, .restore-dialog, .perm-dialog')) {
      e.preventDefault();
      tPostToHost({ type: 'exit-focus' });
      return;
    }
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    // Never steal keys from a dialog or a text field (settings sheet, the
    // fullscreen settings/downloads pages, the translate bubble): Ctrl+W
    // there means "close this layer", not the tab.
    if (tEl('settings')?.hidden === false
      || tEl('settings-page')?.hidden === false
      || tEl('downloads-page')?.hidden === false) return;
    // Ctrl+Shift+T (reopen last closed) is checked before plain Ctrl+T so
    // the shift variant is not swallowed by the go-home shortcut; a text
    // field or a select in focus blocks it, like the other shortcuts.  On a
    // focused site tab the host takes this key in ProcessCmdKey instead.
    // e.code (physical key) instead of e.key: on a Russian layout e.key is
    // 'е'/'л'/'ц' and every shortcut would silently die.
    if (e.shiftKey && e.code === 'KeyT') {
      if (e.target.closest?.('textarea, input, select, [contenteditable="true"]')) return;
      e.preventDefault();
      reopenClosedTab();
      return;
    }
    // Ctrl+Shift+E — колонка вкладок слева.  Без Shift это клавиша ввода
    // (Ctrl+E в поле адреса), поэтому проверка строго с Shift.
    if (e.shiftKey && e.code === 'KeyE') {
      if (e.target.closest?.('textarea, input, [contenteditable="true"]')) return;
      e.preventDefault();
      // Хост владеет раскладкой сайта и помнит режим в settings.json:
      // он переключит, разложит вьюхи и пришлёт "vertical-tabs" назад.
      if (window.chrome?.webview) tPostToHost({ type: 'toggle-vertical-tabs' });
      else document.body.classList.toggle('vertical-tabs');
      return;
    }
    const typing = e.target.closest?.('textarea, input, [contenteditable="true"]');
    if (typing && e.code !== 'KeyL') return;
    if (e.code === 'KeyT') {
      e.preventDefault();
      goHome();
    } else if (e.code === 'KeyW') {
      if (!isHome()) {
        e.preventDefault();
        closeTab(tabState.activeId);
      }
    // Ctrl+Tab and Ctrl+Shift+Tab: with the shell focused no page or site
    // sees these keys, so the strip is the only place they can be handled;
    // a focused site sends the same pair through the host's Hotkeys table.
    } else if (e.code === 'Tab') {
      e.preventDefault();
      if (!e.repeat) cycleTab(e.shiftKey ? -1 : 1);
    } else if (e.code === 'KeyN') {
      // A second window on the same profile (second monitor, side-by-side).
      e.preventDefault();
      if (window.chrome?.webview) tPostToHost({ type: 'newwin' });
    } else if (e.code === 'KeyL') {
      e.preventDefault();
      const input = tEl('search');
      if (input) {
        window.LiveUi?.setBarMode('omni');
        input.focus();
        input.select();
      }
    }
  });
}

// search.js keeps its own Ctrl+L; LiveTabs absorbs it while this module loads.
if (window.__liveCtrlL) {
  window.removeEventListener('keydown', window.__liveCtrlL);
  window.__liveCtrlL = null;
}

window.LiveTabs = {
  open: openTab,
  home: goHome,
  close: closeTab,
  switchTo: switchTab,
  state: tabState,
  closedStack, // debug mirror of the host's lastClosed (see rememberClosed)
  syncGlider,  // app.js snaps the pill after the bar leaves omni mode
  // Смена раскладки (обычная полоса ↔ колонка): штора и подсветка меряют
  // вкладки заново, иначе подсветка остаётся там, где была до переворота.
  layoutChanged() {
    // Ширина колонки меняет место подсказок омнибокса.  Тянем строку
    // подсказок вдоль нижней кромки нижней вкладки, а не бара: в колонке
    // бар во всю высоту, и «под баром» означало бы «поверх сайта».
    if (stripVertical()) {
      const box = tEl('tabs');
      if (box) {
        const bottom = Math.round(box.getBoundingClientRect().bottom);
        if (bottom > 0) document.documentElement.style.setProperty('--tabbar-bottom', `${bottom}px`);
      }
    } else {
      document.documentElement.style.removeProperty('--tabbar-bottom');
    }
    syncGlider(false);
  },
  _onTabs: handleTabs,
  _applyTabSound: updateTabSound, // host QA probe: sound badge states
  _onNav: onNav,
  _onProgress: onProgress,
  gliderStep,  // pure step, also published on window for the host's QA probe
};

document.addEventListener('DOMContentLoaded', initTabs);

})();
