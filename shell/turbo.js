// LiveBrowser turbo: стартовая диагностика и кэш фавиконов.
//
// Грузится ПОСЛЕДНИМ, ничего не ждёт и ничего не меняет:
//   1) window.__lbFavicon(url) — model-api для тех модулей, которые ищут
//      фавикон вкладки: берёт data: кэш из localStorage (key lb_fav_<host>),
//      без сети.  Если кэша нет — null, вызывающий рисует свою заглушку.
//      Улитка (запись) — отдельный, явно вызываемый хелпер кэша: app.js
//      его не использует, чтобы не менять поведение.
//   2) На window load — строка диагностики старта по window.__boot
//      (shell / firstPaint / interactive, ms) в window.__lbTurbo и в
//      консоль.  Это единственный console.log в shell: рапорт для QA.
// Стиль: IIFE, без глобальных const-ов; всё в одном месте.
'use strict';

(function () {

  const PREFIX = 'lb_fav_';

  // Хост: "www.", порт и путь к фавикону не нужны — один кэш на сайт.
  function hostOf(url) {
    try {
      return new URL(String(url || '')).hostname.replace(/^www\./i, '') || null;
    } catch {
      return null;
    }
  }

  function readFavicon(host) {
    try {
      return localStorage.getItem(PREFIX + host) || null;
    } catch {
      return null; // приватный режим / квота: ведём себя как «кэша нет»
    }
  }

  // Только data:image/*; javascript:/http: из localStorage не принимаем.
  function safeFavicon(value) {
    return typeof value === 'string' && /^data:image\//i.test(value) ? value : null;
  }

  // Кэшированные фавиконы по хосту — для кода, которому нужен быстрый
  // ответ без сети.  Промах = null, исключений не бросает никогда.
  window.__lbFavicon = function (url) {
    const host = hostOf(url);
    if (!host) return null;
    return safeFavicon(readFavicon(host));
  };

  // Опциональная запись кэша: __lbFaviconSave(url, dataUrl) -> boolean.
  // Кириллица в value не проверяется, только схема.
  window.__lbFaviconSave = function (url, dataUrl) {
    const host = hostOf(url);
    if (!host || !safeFavicon(dataUrl)) return false;
    try {
      localStorage.setItem(PREFIX + host, dataUrl);
      return true;
    } catch {
      return false;
    }
  };

  /* ------------------------------------------------------------------ */
  /* Стартовые тайминги                                                   */
  /* ------------------------------------------------------------------ */

  function bootData() {
    const b = window.__boot || {};
    return {
      shell: b.shell != null ? b.shell : null,
      firstPaint: b.firstPaint != null ? b.firstPaint : null,
      interactive: b.interactive != null ? b.interactive : null,
    };
  }

  // На load страница уже дорисована: если firstPaint не успел (rAF был
  // занят), отмечаем его сейчас — лучше честная верхняя оценка, чем null.
  function finishBoot() {
    const b = window.__boot = window.__boot || {};
    if (b.firstPaint == null) b.firstPaint = Math.round(performance.now());
    if (b.interactive == null) b.interactive = Math.round(performance.now());
    b.done = { shell: b.shell != null, firstPaint: b.firstPaint != null, interactive: b.interactive != null };
    b.load = Math.round(performance.now());

    const one = bootData();
    window.__lbTurbo = one;
    try {
      console.log(
        `[turbo] boot shell=${one.shell ?? '?'}ms firstPaint=${one.firstPaint ?? '?'}ms ` +
        `interactive=${one.interactive ?? '?'}ms load=${b.load}ms` +
        (window.__bootFail ? ` fail=${window.__bootFail}` : ''),
      );
    } catch { /* консоль недоступна — не ошибка */ }
    return one;
  }

  // Скрипт стоит в конце body, поэтому load обычно ещё впереди; readyState
  // проверяем на случай, если документ уже полностью загружен.
  if (document.readyState === 'complete') finishBoot();
  else window.addEventListener('load', finishBoot, { once: true });

})();
