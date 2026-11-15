// LiveBrowser onboarding — экран первого запуска.
//
// Два такта:
//   1. интро (intro.js): кинематографичная заставка 6.55 с, пропуск Esc /
//      «Пропустить», флаг seen, reduced-motion показывает тихую версию;
//   2. выборы (welcome-choices.js): тема, палитра, поисковик — всё
//      применяется живьём, «Начать» просто сохраняет поисковик.
//
// Когда показывать.  Вопрос к хосту один: /api/firstrun (флаг
// firstrun.flag).  Интро спрашивает само — до вызова choice-экрана, и
// оно же ставит кэш localStorage, чтобы при повторном запуске не мелькнуло
// ни кадра.  Выборы показываются только если был первый запуск; после
// интро — с задержкой в один кадр, чтобы не было наложения слоёв.
//
// Повтор (настройки → «Показать снова»).  Заставка играется сразу, в этом
// же окне: ждать перезапуска — значит показать её один раз и потерять.
// После повтора выборы НЕ открываются — человек уже прошёл онбординг, и
// второй экран выборов поверх рабочего стал бы неожиданностью.
'use strict';

(function () {

  function inHost() {
    return !!(window.chrome && window.chrome.webview);
  }

  // Второй такт: выборы темы/палитры/поисковика.  Модуль (и его CSS)
  // грузится только когда интро действительно показалось, — повторный
  // запуск не скачает и байта онбординга.
  function openChoices() {
    const go = () => {
      if (!window.LiveWelcomeChoices) return;
      try { window.LiveWelcomeChoices.open(); } catch { /* модуль упал на сборке */ }
    };
    if (window.LiveWelcomeChoices) { go(); return; }
    const link = document.createElement('link');
    link.id = 'welcome-choices-css';
    link.rel = 'stylesheet';
    link.href = 'welcome-choices.css';
    document.head.appendChild(link);
    window.LiveModules?.load('welcome-choices').then(go).catch(() => { /* без выборов */ });
  }

  // Один показ заставки.  Вынесен отдельно: в него приходят два пути —
  // «хост сразу сказал first-run» и «кэш сказал нет, но флаг сняли».
  function runIntro(intro, opts) {
    const replay = !!(opts && opts.replay);
    let shown = false;
    try {
      shown = intro.show({
        onDone: () => {
          if (replay) return;              // повтор: рабочий стол уже готов
          // Кадр-разрыв: слой интро уже снят, рабочий стол в покое.
          requestAnimationFrame(() => openChoices());
        },
      });
    } catch (err) {
      // Заставка — украшение, а не условие первого запуска.  Если фильм не
      // собрался (нет кадра, сломан CSS), пользователь всё равно должен
      // попасть на выборы, а не в пустой экран.
      console.error('[welcome] intro failed', err);
      openChoices();
      return;
    }
    // Интро не открылось (слой уже был) — включаем выборы без него.
    if (!shown && !replay) openChoices();
  }

  function start() {
    if (!inHost()) return;                 // dev-браузер: онбординг только в живом профиле
    // Порядок загрузки: этот модуль (оркестратор) берёт LiveIntro, но не
    // требует его до того, как принято решение показывать.
    const ready = window.LiveIntro ? Promise.resolve() : window.LiveModules?.load('intro') || Promise.reject();
    Promise.resolve(ready)
      .then(() => {
        const intro = window.LiveIntro;
        if (!intro) { openChoices(); return; }
        return Promise.resolve(intro.shouldShow()).then((first) => {
          if (!first) return;              // уже видели: сразу рабочий стол
          runIntro(intro);
        });
      })
      // В хосте упала загрузка модулей — онбординг не должен уронить
      // первый запуск: выборы открываются и без заставки.
      .catch(() => openChoices());
  }

  // Настройки → «Показать приветствие снова».  Зовётся из settings.js:
  // модуль интро мог ещё не грузиться (онбординг в этом сеансе не был
  // первым), поэтому сначала грузим контракт времени и модуль.
  function replay() {
    // Уже играем: второй вызов не должен ни открыть вторую копию, ни
    // завести второй цикл выборов.
    if (window.LiveIntro && window.LiveIntro.isOpen && window.LiveIntro.isOpen()) {
      return Promise.resolve(false);
    }
    if (!window.LiveIntro || !window.LiveIntroClock) {
      const load = window.LiveModules?.load
        ? Promise.all([window.LiveModules.load('intro-clock'), window.LiveModules.load('intro')])
        : Promise.reject(new Error('no modules'));
      return load.then(() => {
        if (window.LiveIntro) runIntro(window.LiveIntro, { replay: true });
      }).catch((err) => { console.error('[welcome] replay failed', err); });
    }
    runIntro(window.LiveIntro, { replay: true });
    return Promise.resolve(true);
  }

  window.LiveWelcome = { replay };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

})();
