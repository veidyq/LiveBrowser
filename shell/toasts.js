// LiveBrowser toasts: short status bubbles under the bar ("Адрес скопирован",
// "Вкладка восстановлена", download finished, ...).  The shell desktop is the
// only place where a toast makes sense — while a site view owns the window the
// shell page is clipped to the bar, so messages arriving then are queued and
// played when the user comes back (the body class tells us where we are).
'use strict';

// Top-level names stay inside this file: the shell loads several plain scripts
// into one global scope, so an IIFE prevents `const` redeclaration crashes.
(function () {

const MAX_VISIBLE = 3;    // stacked toasts on screen at once
const QUEUE_MAX = 10;     // held messages while a site is active
const DEFAULT_TIMEOUT = 4000;

const toastState = {
  box: null,      // .toasts container (created on demand)
  queue: [],      // texts waiting for the desktop to come back
  live: [],       // currently shown toast elements, newest last
};

// Public API: window.showToast('Текст', { timeout: 4000 }).
function showToast(text, opts) {
  const msg = String(text == null ? '' : text).trim();
  if (!msg) return null;
  const timeout = Number(opts && opts.timeout) || DEFAULT_TIMEOUT;

  // Over a site the ui view is clipped to the bar (or stretched for an
  // overlay) — either way a toast under the bar would sit on top of the page
  // the user is reading.  Hold the message until they return.
  if (document.body.classList.contains('site-active')) {
    toastState.queue.push({ text: msg, timeout });
    if (toastState.queue.length > QUEUE_MAX) toastState.queue.shift();
    return null;
  }
  return spawn(msg, timeout);
}

function ensureContainer() {
  if (toastState.box && toastState.box.isConnected) return toastState.box;
  const box = document.createElement('div');
  box.className = 'toasts';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  document.body.appendChild(box);
  toastState.box = box;
  return box;
}

function spawn(text, timeout) {
  const box = ensureContainer();

  // The stack never holds more than MAX_VISIBLE: the oldest one leaves now.
  while (toastState.live.length >= MAX_VISIBLE) dismiss(toastState.live[0], true);

  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  el.title = 'Нажми, чтобы скрыть';
  el.addEventListener('click', () => dismiss(el, false));
  // will-change only for the life of the slide animations: released on
  // animationend (in or out), the safety timeout below covers the case where
  // the no-anim kill switch stops the animation from ever ending.
  el.addEventListener('animationend', (e) => {
    if (e.target === el && (e.animationName === 'toast-in' || e.animationName === 'toast-out')) {
      el.style.willChange = '';
    }
  });
  box.appendChild(el);
  toastState.live.push(el);
  el.style.willChange = 'transform, opacity';
  el.__timer = setTimeout(() => dismiss(el, false), timeout);
  return el;
}

// `fast` skips the slide-out animation (stack overflow / teardown).
function dismiss(el, fast) {
  if (!el || el.__leaving) return;
  el.__leaving = true;
  clearTimeout(el.__timer);

  const i = toastState.live.indexOf(el);
  if (i >= 0) toastState.live.splice(i, 1);

  if (fast || document.body.classList.contains('no-anim')) {
    el.remove();
    pruneContainer();
    return;
  }
  el.style.willChange = 'transform, opacity'; // released by the listener above
  el.style.animationDelay = ''; // .out не должен ждать входную ступень
  el.classList.add('out');
  // animationend is the clean exit; the timeout is a safety net for the
  // no-anim kill switch and paused animations.
  el.addEventListener('animationend', () => { el.remove(); pruneContainer(); }, { once: true });
  setTimeout(() => { el.style.willChange = ''; el.remove(); pruneContainer(); }, 400);
}

function pruneContainer() {
  if (toastState.box && !toastState.box.childElementCount && !toastState.live.length) {
    toastState.box.remove();
    toastState.box = null;
  }
}

// Desktop <-> site transitions: body.site-active is toggled by tabs.js
// syncStage.  Watching the class attribute keeps this module independent of
// tabs.js internals.
const mo = new MutationObserver(() => {
  if (!document.body.classList.contains('site-active')) flushQueue();
});
mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });

function flushQueue() {
  if (!toastState.queue.length) return;
  const pending = toastState.queue.splice(0);
  // The newest messages matter most; the desktop shows up to MAX_VISIBLE.
  // Шторм тостов не хлопает залпом: каждый въезжает на 36мс позже —
  // каскад читается как очередь, а не как стена.
  const quiet = document.body.classList.contains('no-anim')
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  pending.slice(-MAX_VISIBLE).forEach((msg, i) => {
    const el = spawn(msg.text, msg.timeout);
    if (i && !quiet) {
      el.style.animationDelay = `${i * 36}ms`; // toast-in с fill backwards
      // Осиротевший таймер spawn гасить обязательно: иначе тост уйдёт по
      // старому расписанию и каскадная задержка исчезновения не сработает.
      clearTimeout(el.__timer);
      el.__timer = setTimeout(() => dismiss(el, false), msg.timeout + i * 36);
    }
  });
}

window.showToast = showToast;

})();
