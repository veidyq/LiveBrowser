// LiveBrowser «Восстановить вкладки?» — после аварийного завершения.
//
// Хост кладёт на старте стикер crash.flag и в FormClosing его снимает.
// Если файл остался (процесс убили / падение / питание), RestoreSessionAsync
// не открывает вкладки молча, а шлёт {"type":"session-restore","count":N}.
// Здесь — аккуратная карточка по центру: «Браузер закрылся неожиданно.
// Восстановить N вкладок?»  Ответ {"type":"session-answer","accept":bool};
// шелл сначала проигрывает свой fade и только потом отправляет ответ,
// чтобы шторка открытия сайтов не просвечивала сквозь исчезающую карточку.
// Движение — transform/opacity, гейты no-anim / reduced-motion соблюдаются.
'use strict';

(function () {

  let card = null;
  let count = 0;

  function isQuiet() {
    return document.body.classList.contains('no-anim')
      || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function post(obj) {
    try { window.chrome?.webview?.postMessage(JSON.stringify(obj)); } catch { /* no host */ }
  }

  function close(accept) {
    if (!card) return;
    const c = card;
    card = null;
    if (c.__key) document.removeEventListener('keydown', c.__key);
    const answer = () => {
      c.remove();
      post({ type: 'session-answer', accept });
    };
    if (isQuiet()) { answer(); return; }
    c.classList.add('out');
    c.addEventListener('transitionend', answer, { once: true });
    setTimeout(answer, 240); // страховка: transitionend может не прийти
  }

  function show(n) {
    if (card) close(false);
    count = Number(n) || 0;
    card = document.createElement('div');
    card.className = 'restore-dialog';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'Восстановление вкладок');
    card.innerHTML =
      '<div class="restore-title">Браузер закрылся неожиданно</div>' +
      '<div class="restore-text"></div>' +
      '<div class="restore-actions">' +
      '<button class="restore-btn restore-no" type="button">Начать с пустой</button>' +
      '<button class="restore-btn restore-yes" type="button">Восстановить</button>' +
      '</div>';
    card.querySelector('.restore-text').textContent = count > 0
      ? `Восстановить ${count} ${plural(count, 'вкладку', 'вкладки', 'вкладок')}, открытые в прошлый раз?`
      : 'Восстановить вкладки, открытые в прошлый раз?';
    card.querySelector('.restore-yes').addEventListener('click', () => close(true));
    card.querySelector('.restore-no').addEventListener('click', () => close(false));

    // Enter / Esc с клавиатуры: Enter = восстановить (действие по умолчанию),
    // Esc = пустой старт.  Слушатель снимается вместе с карточкой.
    card.__key = (e) => {
      if (!card) return;
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    };
    document.addEventListener('keydown', card.__key);

    document.body.appendChild(card);
    if (isQuiet()) card.classList.add('in');
    else requestAnimationFrame(() => card.classList.add('in'));
  }

  // «1 вкладку / 2 вкладки / 5 вкладок».
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  window.LiveRestore = { show };
})();
