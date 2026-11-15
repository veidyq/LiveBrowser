// LiveBrowser findbar — поиск по странице (Ctrl+F).
//
// Поток: Ctrl+F на сайте → хост пушит {"type":"find-open"} → панель в баре
// шелла → ввод (debounce 250мс) → {"type":"find","q","count":true} → хост
// гоняет window.find/__lbCount в сайт-вьюхе → {"type":"find-result","n"} →
// бейдж «N совпадений», стрелки шлют {"back":true|false} — нативный
// window.find листает совпадения с подсветкой выделением и автоскроллом.
// Esc / смена вкладки / «×» — закрыть (сбрасывает выделение пустым find).
// Гейты feel-слоя не трогаем: движение панели — transform/opacity.
'use strict';

(function () {

  let bar = null;
  let input = null;
  let badge = null;
  let open = false;
  let debounce = 0;
  let q = '';
  let idx = 0;   // текущий (человеческий) номер совпадения
  let n = 0;     // всего совпадений по последнему ответу хоста

  function isQuiet() {
    return document.body.classList.contains('no-anim')
      || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function post(obj) {
    try { window.chrome?.webview?.postMessage(JSON.stringify(obj)); } catch { /* no host */ }
  }

  function ensure() {
    if (bar && bar.isConnected) return;
    bar = document.createElement('div');
    bar.className = 'findbar';
    bar.id = 'findbar';
    bar.hidden = true;
    bar.innerHTML =
      '<input class="findbar-input" type="text" placeholder="Найти на странице…" ' +
      'spellcheck="false" autocomplete="off" aria-label="Найти на странице">' +
      '<span class="findbar-count" id="findbar-count">—</span>' +
      '<button class="findbar-btn" data-d="-1" type="button" aria-label="Предыдущее" title="Предыдущее (Shift+Enter)">↑</button>' +
      '<button class="findbar-btn" data-d="1" type="button" aria-label="Следующее" title="Следующее (Enter)">↓</button>' +
      '<button class="findbar-btn findbar-close" type="button" aria-label="Закрыть" title="Закрыть (Esc)">×</button>';
    input = bar.querySelector('.findbar-input');
    badge = bar.querySelector('#findbar-count');
    document.body.appendChild(bar);

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => start(input.value.trim()), 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.findbar-btn');
      if (!b) return;
      if (b.classList.contains('findbar-close')) close();
      else step(Number(b.dataset.d) || 1);
    });
    // Клик мимо панели (по сайту под ней) — закрыть.
    document.addEventListener('pointerdown', (e) => {
      if (!open || !bar) return;
      if (!bar.contains(e.target)) close();
    }, true);
  }

  // Новый запрос: сброс счётчика, спрашиваем у хоста число совпадений и
  // сразу прыгаем на первое.
  function start(text) {
    q = text;
    idx = 0;
    if (!q) { post({ type: 'find', q: '' }); badge.textContent = '—'; return; }
    post({ type: 'find', q, count: true });
    post({ type: 'find', q });
    idx = 1;
    paint();
  }

  function step(d) {
    if (!q || !n) return;
    idx = ((idx - 1 + d + n) % n) + 1;
    post({ type: 'find', q, back: d < 0 });
    paint();
  }

  function paint() {
    if (!badge) return;
    badge.textContent = q ? `${idx} из ${n}` : '—';
    badge.classList.toggle('none', !q || !n);
  }

  function openBar() {
    ensure();
    open = true;
    if (isQuiet()) bar.hidden = false;
    else {
      bar.hidden = false;
      bar.classList.remove('out');
      void bar.offsetWidth;
      bar.classList.add('in');
    }
    if (input) {
      input.value = '';
      input.focus();
    }
    q = ''; n = 0; idx = 0;
    if (badge) badge.textContent = '—';
  }

  function close() {
    if (!open || !bar) return;
    open = false;
    clearTimeout(debounce);
    post({ type: 'find', q: '' }); // снять выделение на сайте
    const done = () => { if (bar) bar.hidden = true; };
    if (isQuiet()) { done(); return; }
    bar.classList.remove('in');
    bar.classList.add('out');
    bar.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 200); // страховка
  }

  // Результат от хоста: сколько совпадений у последнего запроса.
  function onResult(nn) {
    n = Math.max(0, Number(nn) || 0);
    if (idx > n || idx === 0) idx = n ? 1 : 0;
    paint();
  }

  // Смена вкладки: выделение на старой странице всё равно ушло.
  function onTabs() { if (open) close(); }

  window.LiveFind = { open: openBar, close, onResult, onTabs };
})();
