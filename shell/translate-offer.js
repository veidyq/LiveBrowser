// LiveBrowser translate offer ("Перевести страницу?" like Chrome's bar).
//
// The host decides WHETHER to offer (Translator.cs samples document.lang and
// the Cyrillic share) and pushes {"type":"translate-offer", id, url}.  This
// file only renders and talks back; it never translates on its own — the
// user presses "Перевести" or closes the bar.
//
// Painting rules (see PROGRESS.md): over a site tab the ui view is clipped to
// the 56px bar, so the bar is a compact capsule INSIDE the bar — right of
// the tabs, left of the nav/actions; the strip flexes and the bar's contents
// stay intact.  The translated text is NOT painted over the site either: it
// is shown in the shell as a dialog (host overlay channel stretches the ui
// view over the window, like settings do).  The page text itself is fetched
// from the site view through the host: {type:'translate-text', id} →
// {"type":"site-text", id, text}, then GET /api/translate?text=&to=ru&sl=auto.
//
// Wiring: app.js forwards the two host messages to window.LiveTranslateOffer.
// Top-level names stay inside the IIFE (the shell shares one global scope).
(function () {
  'use strict';

  const LANGS = [
    { code: 'ru', label: 'Русский' },
    { code: 'en', label: 'English' },
  ];
  const TEXT_WAIT_MS = 2500; // how long to wait for the site's innerText
  const MAX_CHARS = 4000;    // same cap as /api/translate and the sniffer
  const BUBBLE_GAP = 10;     // px between the bar and the open dialog

  let bar = null;         // the offer capsule
  let dialog = null;      // the translated-text dialog
  let toast = null;       // small "Переводим…" / error notice
  let offer = null;       // { id, url } while shown
  let langIndex = 0;      // LANGS entry the dialog is on
  let busy = false;       // a translate request is in flight
  let waitText = null;    // pending TextWait while a site text is asked
  let busyTimer = 0;      // watchdog for the spinner state

  const el = (id) => document.getElementById(id);

  function post(msg) {
    try { window.chrome?.webview?.postMessage(JSON.stringify(msg)); }
    catch { /* host gone */ }
  }

  /* -------------------- bar -------------------- */

  function ensureBar() {
    if (bar && bar.isConnected) return bar;
    bar = document.createElement('div');
    bar.className = 'translate-offer';
    bar.id = 'translate-offer';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Перевести страницу');
    bar.hidden = true;
    bar.innerHTML =
      '<span class="to-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/>' +
      '<path d="M3.5 9.5h17M3.5 14.5h17M12 3.2c2.6 2.4 4 5.4 4 8.8s-1.4 6.4-4 8.8c-2.6-2.4-4-5.4-4-8.8s1.4-6.4 4-8.8z"/>' +
      '</svg></span>' +
      '<span class="to-title">Перевести страницу?</span>' +
      '<label class="to-lang"><span class="to-lang-text">Русский</span>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>' +
      '<select class="to-lang-select" aria-label="Язык перевода"></select></label>' +
      '<button class="to-go" type="button">Перевести</button>' +
      '<button class="to-close" type="button" title="Закрыть" aria-label="Закрыть">✕</button>';
    const select = bar.querySelector('.to-lang-select');
    for (const l of LANGS) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.label;
      select.appendChild(o);
    }
    select.value = LANGS[langIndex].code;
    select.addEventListener('change', () => {
      langIndex = Math.max(0, LANGS.findIndex((l) => l.code === select.value));
      bar.querySelector('.to-lang-text').textContent = LANGS[langIndex].label;
    });
    // Keep typing/keys inside the bar away from tabs.js hotkeys etc.
    select.addEventListener('keydown', (e) => e.stopPropagation());
    bar.querySelector('.to-go').addEventListener('click', () => {
      if (!offer || busy) return;
      langIndex = Math.max(0, LANGS.findIndex((l) => l.code === select.value));
      translateNow();
    });
    bar.querySelector('.to-close').addEventListener('click', () => dismiss());
    // Lives INSIDE the bar as a flex item right before the window controls:
    // an absolutely positioned capsule was painted under the bar's right
    // cluster (.chrome-bar > * outranks it) and its clicks never landed.
    const host = document.getElementById('chrome-bar');
    const winControls = host && host.querySelector('.win-controls');
    if (host) host.insertBefore(bar, winControls || null);
    else document.body.appendChild(bar);
    return bar;
  }

  function showOffer(msg) {
    const id = Number(msg.id) || 0;
    const url = String(msg.url || '');
    if (!id || !url || !window.chrome?.webview) return;
    // The same page again (SPA pushState, reload): the bar is already there.
    if (offer && offer.id === id && offer.url === url && !bar.hidden) return;
    // Another page in the same tab: whatever the dialog showed is stale.
    if (dialog && !dialog.hidden) closeDialog();
    busy = false;
    ensureBar();
    offer = { id, url };
    cancelExit(bar, 'to-out'); // мгновенный повторный показ бьёт излёт
    bar.hidden = false;
    // Enter animation only on a fresh show; a re-push just stays.
    bar.classList.remove('in');
    void bar.offsetWidth;
    bar.classList.add('in');
  }

  // ---------- Плавные уходы (Smoothness Law) ----------
  // Уход живёт в том же канале, что и вход: класс излёта ставится, hidden —
  // только после animationend (страховка-таймер покрывает no-anim/паузу).
  // Токен на элемент: мгновенное повторное появление отменяет излёт.
  function exitHide(el, cls, waitMs) {
    const quiet = document.body.classList.contains('no-anim')
      || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (quiet) { el.hidden = true; return; }
    const tok = (el.__lbOutTok = (el.__lbOutTok || 0) + 1);
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    el.style.pointerEvents = 'none';
    let timer = setTimeout(finish, waitMs);
    function finish() {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      if (el.__lbOutTok !== tok) return; // показали заново — излёт отменён
      el.classList.remove(cls);
      el.style.pointerEvents = '';
      el.hidden = true;
    }
    el.addEventListener('animationend', finish, { once: true });
  }

  function cancelExit(el, cls) {
    if (!el) return;
    el.__lbOutTok = (el.__lbOutTok || 0) + 1;
    el.classList.remove(cls);
    el.style.pointerEvents = '';
  }

  function hideOfferBar() {
    if (bar && !bar.hidden) exitHide(bar, 'to-out', 180);
    if (bar) bar.classList.remove('in');
  }

  // ✕ (or "already translated"): the host remembers the page so it never
  // offers it again in this tab.
  function dismiss() {
    if (offer) post({ type: 'translate-dismiss', id: offer.id, url: offer.url });
    hideOfferBar();
    closeDialog();
    hideToast();
    offer = null;
  }

  /* -------------------- toast -------------------- */

  function showToast(text) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'translate-toast';
      toast.id = 'translate-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    // Отменить идущий излёт: иначе отложенный finish() из exitHide
    // спрячет ТОЛЬКО ЧТО показанный тост (re-show в окне излёта).
    cancelExit(toast, 'tt-out');
    toast.textContent = text;
    toast.hidden = false;
  }

  function hideToast() {
    if (toast && !toast.hidden) exitHide(toast, 'tt-out', 160);
  }

  // Message that dismisses itself (a status, not a state).
  let noteTimer = 0;
  function note(text, ms) {
    showToast(text);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(hideToast, ms || 1800);
  }

  /* -------------------- dialog (translated text) -------------------- */

  function ensureDialog() {
    if (dialog && dialog.isConnected) return dialog;
    dialog = document.createElement('div');
    dialog.className = 'translate-dialog';
    dialog.id = 'translate-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.setAttribute('aria-label', 'Перевод страницы');
    dialog.hidden = true;
    dialog.innerHTML =
      '<header class="td-head">' +
      '<div class="td-titles"><span class="td-eyebrow">Перевод страницы</span>' +
      '<span class="td-sub"></span></div>' +
      '<div class="td-langs">' +
      '<label class="td-lang">Перевод с' +
      '<select class="td-sl" aria-label="Исходный язык">' +
      '<option value="auto">Авто</option><option value="en">English</option>' +
      '<option value="de">Deutsch</option><option value="fr">Français</option>' +
      '<option value="es">Español</option></select></label>' +
      '<label class="td-lang">на' +
      '<select class="td-tl" aria-label="Язык перевода"></select></label>' +
      '</div>' +
      '<button class="td-close icon-btn" type="button" title="Закрыть" aria-label="Закрыть">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
      '</header>' +
      '<div class="td-body">' +
      '<div class="td-orig"><span class="td-label">Оригинал</span>' +
      '<p class="td-orig-text"></p></div>' +
      '<div class="td-trans"><span class="td-label">Перевод</span>' +
      '<p class="td-trans-text"></p></div>' +
      '</div>' +
      '<footer class="td-foot"><span class="td-note"></span>' +
      '<button class="td-copy" type="button">Копировать</button></footer>' +
      '<div class="td-page-actions">' +
      '<button class="td-page-replace" type="button">Заменить текст на странице</button>' +
      '<button class="td-page-revert" type="button" hidden>Показать оригинал</button>' +
      '</div>';
    const tl = dialog.querySelector('.td-tl');
    for (const l of LANGS) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.label;
      tl.appendChild(o);
    }
    dialog.querySelector('.td-close').addEventListener('click', () => closeDialog());
    dialog.querySelector('.td-page-replace').addEventListener('click', () => {
      if (!offer) return;
      const noteEl = dialog.querySelector('.td-note');
      noteEl.textContent = 'Заменяю текст на странице…';
      post({ type: 'trans-page', id: offer.id });
    });
    dialog.querySelector('.td-page-revert').addEventListener('click', () => {
      if (!offer) return;
      post({ type: 'trans-revert', id: offer.id });
    });
    dialog.querySelector('.td-sl').addEventListener('change', () => runTranslation());
    dialog.querySelector('.td-tl').addEventListener('change', () => {
      langIndex = Math.max(0, LANGS.findIndex((l) => l.code === tl.value));
      if (bar) bar.querySelector('.to-lang-select').value = LANGS[langIndex].code;
      if (bar) bar.querySelector('.to-lang-text').textContent = LANGS[langIndex].label;
      runTranslation();
    });
    dialog.querySelector('.td-copy').addEventListener('click', async () => {
      const text = dialog.querySelector('.td-trans-text').textContent || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        note('Перевод скопирован', 1800);
      } catch { note('Не удалось скопировать', 1800); }
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function positionDialog() {
    if (!dialog || dialog.hidden) return;
    const bh = el('chrome-bar');
    const h = bh ? bh.getBoundingClientRect().height : 56;
    dialog.style.top = Math.round(h + BUBBLE_GAP) + 'px';
  }

  // Над сайтом ui-вьюха обрезана хостом до 56px бара, поэтому, открывая
  // диалог, просим хост растянуть вьюху на всё окно — ровно тот же
  // overlay-канал, что у страницы настроек (settings.js): {type:'overlay'}
  // + body-класс.  Тело на сайте и так прозрачно (body.site-active в
  // app.css), красит себя только карточка диалога — вокруг неё виден сайт.
  // На рабочем столе вьюха уже на всё окно, диалог и так виден: там
  // overlay не нужен (высоту settings решает так же — только над сайтом).
  function openDialog() {
    const d = ensureDialog();
    // Пере-открытие в окне излёта (hidden ещё false, а класс show уже снят):
    // токен-бамп отменяет отложенный hidden, show возвращается — диалог
    // доезжает с новым контентом, а не исчезает.
    const wasHidden = d.hidden;
    d.__lbOutTok = (d.__lbOutTok || 0) + 1; // отменить идущий излёт
    if (wasHidden) d.hidden = false;
    // Overlay на сайте нужен и при пере-открытии в окне излёта
    // (closeDialog уже сдал высоту вьюхи); запрос идемпотентен.
    if (document.body.classList.contains('site-active')) {
      document.body.classList.add('translate-open');
      // Ровно как settings.js: окно целиком (innerHeight), а не высота
      // вьюхи — над сайтом вьюха обрезана до бара, и её clientHeight
      // оставил бы диалог обрезанным.
      post({ type: 'overlay', open: true, height: window.innerHeight });
    }
    requestAnimationFrame(() => d.classList.add('show'));
    positionDialog();
  }

  // Единственная точка закрытия диалога: через неё идут ✕, Esc, dismiss,
  // смена вкладки (onTabs), reset/hide — overlay закрывается только если
  // был открыт.  Ровно как settings.js при закрытии: height:0 — хост сам
  // возвращает вьюхе высоту бара (56), пока активен сайт.
  function closeDialog() {
    if (!dialog || dialog.hidden) return;
    const d = dialog;
    d.classList.remove('show');
    // Уход по transition .show→default (0.18s): hidden — после transitionend
    // (страховка 200мс), иначе диалог «выключается кадром».
    const quiet = document.body.classList.contains('no-anim')
      || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (quiet) {
      d.hidden = true;
    } else {
      const tok = (d.__lbOutTok = (d.__lbOutTok || 0) + 1);
      d.style.pointerEvents = 'none';
      let timer = setTimeout(finish, 200);
      function finish() {
        if (!timer) return;
        clearTimeout(timer);
        timer = 0;
        if (d.__lbOutTok !== tok) return;
        d.style.pointerEvents = '';
        d.hidden = true;
      }
      d.addEventListener('transitionend', finish, { once: true });
    }
    if (document.body.classList.contains('translate-open')) {
      document.body.classList.remove('translate-open');
      post({ type: 'overlay', open: false, height: 0 });
    }
  }

  /* -------------------- translate flow -------------------- */

  // Ask the active site view for its visible text.  Resolves "" on timeout:
  // the host may have no sniffer (older build) — the bar then says so.
  function requestPageText(id) {
    if (!window.chrome?.webview) return Promise.resolve('');
    return new Promise((resolve) => {
      if (waitText) { clearTimeout(waitText.timer); waitText.resolve(''); }
      const timer = setTimeout(() => {
        if (waitText && waitText.id === id) { waitText = null; resolve(''); }
      }, TEXT_WAIT_MS);
      waitText = { id, resolve, timer };
      post({ type: 'translate-text', id });
    });
  }

  // Хост -> shell: in-place перевод страницы готов (или провал).
  function onPageDone(count) {
    if (!dialog || dialog.hidden) return;
    const replaceBtn = dialog.querySelector('.td-page-replace');
    const revertBtn = dialog.querySelector('.td-page-revert');
    const noteEl = dialog.querySelector('.td-note');
    if (!replaceBtn || !revertBtn) return;
    setBusy(false);
    if (count > 0) {
      replaceBtn.hidden = true;
      revertBtn.hidden = false;
      noteEl.textContent = 'Страница переведена: заменено фрагментов — ' + count + '.';
    } else {
      noteEl.textContent = 'Не получилось: страница осталась без изменений.';
    }
  }

  // «Показать оригинал» отработал — вернуть кнопку замены.
  function onReverted() {
    if (!dialog || dialog.hidden) return;
    const replaceBtn = dialog.querySelector('.td-page-replace');
    const revertBtn = dialog.querySelector('.td-page-revert');
    const noteEl = dialog.querySelector('.td-note');
    if (replaceBtn && revertBtn) {
      revertBtn.hidden = true;
      replaceBtn.hidden = false;
      noteEl.textContent = 'Оригинальный текст возвращён.';
    }
  }

  // Host -> shell {"type":"site-text", id, text}
  function onSiteText(msg) {
    if (!waitText || Number(msg.id) !== waitText.id) return;
    clearTimeout(waitText.timer);
    const r = waitText.resolve;
    waitText = null;
    r(String(msg.text || ''));
  }

  function setBusy(on) {
    busy = on;
    clearTimeout(busyTimer);
    if (!bar) return;
    bar.classList.toggle('busy', on);
    const go = bar.querySelector('.to-go');
    if (go) {
      go.disabled = on;
      go.textContent = on ? 'Переводим…' : 'Перевести';
    }
    if (on) {
      showToast('Переводим…');
      // A hung endpoint must not freeze the bar forever.  Хост держит цепочку
      // провайдеров (gtx → MyMemory) до ~15 с, сторож чуть щедрее.
      busyTimer = setTimeout(() => { if (busy) { setBusy(false); hideToast(); showToast('Перевод не удался'); } }, 20000);
    }
  }

  async function translateNow() {
    if (!offer || busy) return;
    openDialog();
    setBusy(true);
    dialog.classList.add('loading');
    // Keep what is already there while a re-run (language change) works.
    runTranslation();
  }

  async function runTranslation() {
    if (!offer || !dialog) return;
    const text = await requestPageText(offer.id);
    if (!offer || dialog.hidden) return;
    if (!text || text.length < 2) {
      setBusy(false);
      hideToast();
      dialog.querySelector('.td-note').textContent =
        'Не удалось получить текст страницы — возможно, он ещё грузится.';
      return;
    }
    const sl = dialog.querySelector('.td-sl').value || 'auto';
    const tl = LANGS[langIndex].code;
    try {
      const res = await fetch(
        'https://api.livebrowser.shell/api/translate?text=' + encodeURIComponent(text) +
        '&to=' + encodeURIComponent(tl) + '&sl=' + encodeURIComponent(sl),
        { cache: 'no-store' });
      const data = await res.json();
      if (!offer) return; // the bar was dismissed meanwhile
      if (!data || !data.ok) throw new Error((data && data.error) || 'no text');
      const out = String(data.text || '').trim();
      dialog.querySelector('.td-orig-text').textContent = text.slice(0, MAX_CHARS);
      dialog.querySelector('.td-trans-text').textContent = out || text;
      dialog.querySelector('.td-note').textContent =
        'Переведён видимый текст страницы (' + text.length + ' символов).';
      const replaceBtn = dialog.querySelector('.td-page-replace');
      const revertBtn = dialog.querySelector('.td-page-revert');
      if (replaceBtn && revertBtn) {
        replaceBtn.hidden = false;
        revertBtn.hidden = true;
      }
      dialog.querySelector('.td-sub').textContent = hostOf(offer.url);
      // Пользователь уже получил перевод: больше полосу по этой странице не
      // показываем (хост запоминает url, повторный показ — только вручную).
      post({ type: 'translate-dismiss', id: offer.id, url: offer.url });
      hideOfferBar();
      note('Готово', 1800);
    } catch {
      if (!offer) return;
      // Хост теперь сам держит цепочку провайдеров (gtx → MyMemory) и наружу
      // отдаёт только generic-ошибку: 429/таймаут снаружи не различить.
      // Одна честная подпись на любой провал вместо старой классификации.
      dialog.querySelector('.td-note').textContent =
        'Сервис перевода недоступен. Попробуйте позже.';
      // Тактильный маркер провала: диалог вздрагивает, а не только пишет.
      window.LiveFeel?.shake?.(dialog.querySelector('.td-note') || dialog);
    } finally {
      setBusy(false);
      if (dialog) dialog.classList.remove('loading');
    }
  }

  // Host shown in the dialog header; a malformed url simply shows none.
  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  /* -------------------- host events -------------------- */

  function reset() {
    if (offer) post({ type: 'translate-dismiss', id: offer.id, url: offer.url });
    offer = null;
    setBusy(false);
    hideOfferBar();
    hideToast();
    closeDialog();
  }

  // Host: switch happened; the host pushes a fresh offer for the new page
  // when its language qualifies, so nothing stale may stay on screen.
  function hide() {
    offer = null;
    setBusy(false);
    hideOfferBar();
    hideToast();
    closeDialog();
  }

  function onTabs(msg) {
    const active = Number(msg.activeId) || 0;
    if (!offer) return;
    // The offer belongs to the page it was pushed for: another tab or the
    // desktop means the bar goes away (and the current page is not marked as
    // dismissed — it was never answered).
    if (active !== offer.id) { offer = null; hideOfferBar(); hideToast(); closeDialog(); return; }
    const live = Array.isArray(msg.tabs) ? msg.tabs.find((t) => Number(t.id) === active) : null;
    if (live && live.url && live.url !== offer.url) {
      // A client-side navigation moved on; the host pushes a fresh offer for
      // the new page if it qualifies.
      offer = { id: active, url: String(live.url) };
      hideOfferBar();
      closeDialog();
    }
  }

  window.addEventListener('resize', positionDialog);

  // Esc закрывает диалог (capture, как у settings.js) — единственный путь
  // закрытия, которого не хватало: все остальные (✕, dismiss, reset/hide,
  // смена вкладки) уже сходятся в closeDialog.  Обработчик app.js
  // зарегистрирован раньше: если его слой открыт (поиск/лист настроек),
  // он закроется первым и заглушит нас; иначе Esc закрывает только диалог.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog && !dialog.hidden) {
      e.stopImmediatePropagation();
      closeDialog();
    }
  }, true);

  window.LiveTranslateOffer = {
    offer: showOffer,
    hide,
    dismiss: reset,
    onTabs,
    onSiteText,
    onPageDone,
    onReverted,
  };
})();
