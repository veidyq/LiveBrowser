// LiveBrowser permission dialog — запросы сайтов (гео/камера/микрофон/…).
//
// Хост перехватывает PermissionRequested (Handled=true + деферрал) и шлёт
// {"type":"perm","id":N,"kind":"Геолокацию","uri":"example.com"} — здесь
// рисуем аккуратную карточку в стиле шелла (вместо системного попапа).
// Ответ {"type":"perm-answer","id":N,"allow":bool} уходит хосту; молчание
// дольше 45 с хост считает отказом.  Одна карточка на экран (очередь).
// Движение — transform/opacity, гейты no-anim/reduced-motion соблюдаются.
'use strict';

(function () {

  let card = null;
  const queue = [];

  function isQuiet() {
    return document.body.classList.contains('no-anim')
      || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function post(obj) {
    try { window.chrome?.webview?.postMessage(JSON.stringify(obj)); } catch { /* no host */ }
  }

  function show(item) {
    if (card) { queue.push(item); return; }
    card = document.createElement('div');
    card.className = 'perm-dialog';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'Запрос разрешения');
    card.innerHTML =
      '<div class="perm-row">' +
      '<span class="perm-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/></svg></span>' +
      '<div class="perm-text">Сайт <b class="perm-host"></b> запрашивает <b class="perm-kind"></b></div>' +
      '</div>' +
      '<div class="perm-actions">' +
      '<button class="perm-btn perm-deny" type="button">Запретить</button>' +
      '<button class="perm-btn perm-allow" type="button">Разрешить</button>' +
      '</div>';
    card.querySelector('.perm-host').textContent = item.uri;
    card.querySelector('.perm-kind').textContent = item.kind.toLowerCase();

    const answer = (allow) => {
      if (!card) return;
      post({ type: 'perm-answer', id: item.id, allow });
      const c = card;
      card = null;
      const done = () => { c.remove(); next(); };
      if (isQuiet()) { done(); return; }
      c.classList.add('out');
      c.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 220); // страховка
    };
    card.querySelector('.perm-allow').addEventListener('click', () => answer(true));
    card.querySelector('.perm-deny').addEventListener('click', () => answer(false));

    document.body.appendChild(card);
    if (isQuiet()) card.classList.add('in');
    else requestAnimationFrame(() => card.classList.add('in'));
  }

  function next() {
    if (queue.length) show(queue.shift());
  }

  // Хост → шелл: новый запрос разрешения.
  window.LivePerm = {
    ask(item) { show(item); },
  };
})();
