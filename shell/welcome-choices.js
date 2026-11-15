// LiveBrowser welcome-choices — второй такт онбординга первого запуска.
//
// Первый такт — интро (intro.js).  После него этот экран: тема, палитра,
// поисковик — один экран, выборы применяются живьём (LiveTheme /
// LiveSearchEngine), «Начать» сохраняет поисковик и закрывает.  Дефолты уже
// стоят, поэтому Esc/закрытие ничего не ломают: рабочий стол готов сразу.
//
// Открывается ТОЛЬКО оркестратором (welcome.js) — сам он /api/firstrun не
// спрашивает: иначе после сброса флага настройками интро и этот экран
// решали бы независимо, и онбординг показался бы без интро.
// Правила feel-слоя соблюдаются: transform/opacity, gates no-anim/reduced.
'use strict';

(function () {

  let root = null;
  let mode = null;     // 'dark' | 'light'
  let palette = null;  // индекс палитры
  let engine = null;   // 'yandex' | 'google' | 'duckduckgo'
  let busy = false;

  function isQuiet() {
    return document.body.classList.contains('no-anim')
      || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function post(partial) {
    try {
      window.fetch('https://api.livebrowser.shell/api/settings', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      }).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
  }

  function open() {
    if (root) return;
    const theme = window.LiveTheme;
    if (!theme) return;
    mode = theme.PALETTES && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    palette = (window.app && typeof window.app.paletteIndex === 'number')
      ? window.app.paletteIndex : 0;
    engine = window.LiveSearchEngine?.get() || 'yandex';

    root = document.createElement('div');
    root.className = 'welcome';
    root.id = 'welcome';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Добро пожаловать в LiveBrowser');
    root.innerHTML =
      '<div class="welcome-card">' +
      '<h1 class="welcome-title">Добро пожаловать в LiveBrowser</h1>' +
      '<p class="welcome-sub">Две настройки — и вы в деле. Всё уже работает, это можно поменять потом.</p>' +
      '<div class="welcome-row"><span class="welcome-label">Тема</span>' +
      '<div class="welcome-seg" id="wx-modes">' +
      '<button class="welcome-opt" data-mode="dark" type="button">Тёмная</button>' +
      '<button class="welcome-opt" data-mode="light" type="button">Светлая</button>' +
      '</div></div>' +
      '<div class="welcome-row"><span class="welcome-label">Палитра</span>' +
      '<div class="welcome-swatches" id="wx-pals"></div></div>' +
      '<div class="welcome-row"><span class="welcome-label">Поисковик</span>' +
      '<div class="welcome-seg" id="wx-engines"></div></div>' +
      '<button class="welcome-go" id="wx-go" type="button">Начать</button>' +
      '</div>';

    // Тема: две кнопки, живое применение.
    const modes = root.querySelector('#wx-modes');
    const syncModes = () => {
      modes.querySelectorAll('.welcome-opt').forEach((b) =>
        b.classList.toggle('on', b.dataset.mode === mode));
    };
    modes.addEventListener('click', (e) => {
      const b = e.target.closest('.welcome-opt');
      if (!b) return;
      mode = b.dataset.mode;
      theme.setMode(mode);
      syncModes();
    });

    // Палитры: свотчи из LiveTheme.PALETTES, живое применение.
    const pals = root.querySelector('#wx-pals');
    const list = theme.PALETTES || [];
    const syncPals = () => {
      pals.querySelectorAll('.welcome-swatch').forEach((b, i) =>
        b.classList.toggle('on', i === palette));
    };
    list.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'welcome-swatch';
      b.title = p.name;
      b.setAttribute('aria-label', `Палитра ${p.name}`);
      b.style.setProperty('--sw-a', p.accent);
      b.style.setProperty('--sw-b', p.accentSoft || p.accent);
      b.addEventListener('click', () => {
        palette = i;
        theme.setPalette(i);
        syncPals();
      });
      pals.appendChild(b);
    });

    // Поисковик: сегменты из LiveSearchEngine.ENGINES.
    const eng = root.querySelector('#wx-engines');
    const engines = window.LiveSearchEngine?.ENGINES || {};
    const syncEng = () => {
      eng.querySelectorAll('.welcome-opt').forEach((b) =>
        b.classList.toggle('on', b.dataset.engine === engine));
    };
    Object.entries(engines).forEach(([id, e]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'welcome-opt';
      b.dataset.engine = id;
      b.textContent = e.label;
      b.addEventListener('click', () => {
        engine = id;
        window.LiveSearchEngine.set(id);
        syncEng();
      });
      eng.appendChild(b);
    });

    document.body.appendChild(root);
    syncModes();
    syncPals();
    syncEng();

    // «Начать»: сохранить поисковик (тема/палитра уже у хоста) и закрыть.
    root.querySelector('#wx-go').addEventListener('click', finish);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(); }
      if (e.key === 'Tab') {
        // Модальный фокус: Tab не уходит в бар под оверлеем.
        const items = root.querySelectorAll('button');
        const i = [...items].indexOf(document.activeElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
      }
    });
    root.querySelector('#wx-go').focus();
  }

  function finish() {
    if (busy || !root) return;
    busy = true;
    post({ search: engine });
    const done = () => {
      if (!root) return;
      root.remove();
      root = null;
      busy = false;
      // Сразу в дело: фокус в омнибокс рабочего стола.
      const input = document.getElementById('search');
      if (input) { input.focus(); input.select(); }
    };
    if (isQuiet()) { done(); return; }
    root.classList.add('closing');
    root.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 280); // страховка
  }

  window.LiveWelcomeChoices = { open, isOpen: () => !!root };
})();
