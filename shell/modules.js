// Ленивая загрузка модулей оболочки.
//
// Стартовая страница подключает только то, что нужно первому кадру и
// базовому управлению: рабочий стол, стрип вкладок, омнибокс, поиск,
// тосты, тема, плавность.  Всё остальное (меню, поиск по странице,
// диалог пермиссий, «восстановить вкладки?», приветствие) грузится по
// требованию — то есть ровно тогда, когда пользователь впервые дотянулся
// до этой функции.  Каждый модуль — один <script>, ответ сервера кэширует
// его в Chromium, поэтому повторный вызов стоит один lookup и не трогает
// сеть.
//
// Контракт: loadModule(name) возвращает промис, который резолвится после
// исполнения модуля.  Если модуль ещё не загружен, а вызывающий код, не
// дожидаясь промиса, зовёт window.LiveX?.foo() — вызов молча пропадёт.
// Поэтому все точки входа, которые МОГУТ прийти раньше загрузки, сначала
// зовут loadModule и только затем обращаются к API (см. app.js/tabs.js).
'use strict';

(function () {
  // name -> адрес.  Один список на всё: в консоли handy, а модулю не нужно
  // знать про соседей.
  const FILES = {
    menu: 'menu.js',
    findbar: 'findbar.js',
    perm: 'perm.js',
    restore: 'restore.js',
    // Онбординг — два файла: оркестратор решает, показывать ли интро, и
    // после него открывает выборы.  Контракт времени (intro-clock.js) —
    // отдельный скрипт в index.html: он нужен ровно на старте, до интро.
    welcome: 'welcome.js',
    intro: 'intro.js',
    // Контракт времени — отдельный <script> в index.html, но модуль нужен
    // и для прогона/замера на произвольной странице оболочки.
    'intro-clock': 'intro-clock.js',
    'welcome-choices': 'welcome-choices.js',
  };

  // name -> Promise, уже начатый.  Повторный вызов возвращает тот же
  // промис, поэтому два клика подряд не создают два <script>.
  const pending = new Map();

  function loadModule(name) {
    const file = FILES[name];
    if (!file) return Promise.reject(new Error('unknown module: ' + name));
    const done = pending.get(name);
    if (done) return done;

    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = file;
      s.async = false;
      // Порядок при параллельной загрузке: async=false у динамических
      // скриптов сохраняет порядок вставки, но нам он не нужен — модули
      // независимы и берут API друг друга в момент вызова.
      s.onload = () => resolve(true);
      s.onerror = () => {
        // Провал не кешируем: следующий вызов попробует снова (например,
        // после того как профиль снова станет читаемым).
        pending.delete(name);
        reject(new Error('module failed: ' + name));
      };
      document.head.appendChild(s);
    });
    pending.set(name, p);
    return p;
  }

  // Готов ли модуль прямо сейчас (без ожидания).
  function moduleReady(name) {
    return name === 'menu' ? !!window.LiveMenu : true;
  }

  // Предзагрузка на «почти наверняка»: hover/pointerdown по кнопке «Ещё»
  // или отправка клавиши, ведущей в меню.  Ошибку глотаем — модуль всё
  // равно загрузится в момент реального клика.
  function prefetch(name) {
    if (pending.has(name)) return;
    loadModule(name).catch(() => { });
  }

  window.LiveModules = { load: loadModule, prefetch, ready: moduleReady, files: FILES };

  // Первые «почти наверняка»: курсор дотянулся до «••» — греем menu.js, чтобы
  // клик открыл меню сразу; Action Center/уведомления «Ещё» ищутся в меню.
  // Делегирование на document: кнопка живёт в стрипе и переживает ре-рендеры.
  document.addEventListener('pointerenter', (e) => {
    if (e.target && e.target.closest && e.target.closest('#more-btn')) prefetch('menu');
  }, true);

  // Перенос вкладки/дроп ссылки в полосе слушает menu.js.  Первое касание
  // полосы грузит модуль заранее: если пользователь начнёт drag сразу после
  // старта, скрипт успеет исполниться до dragstart (обработчики на контейнере).
  document.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.closest && e.target.closest('#tabs')) prefetch('menu');
  }, true);

  // Приветствие первого запуска — сразу после старта, но вне критического
  // пути: оно само решает показываться или нет и первым делом спрашивает
  // хост.  Откладываем до idle, чтобы не отнимать кадр у десктопа.
  // Выборы (второй такт) грузятся только после интро — их
  // догружает оркестратор, когда интро действительно было.
  const warm = () => { prefetch('welcome'); };
  if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 2500 });
  else setTimeout(warm, 1200);
})();
