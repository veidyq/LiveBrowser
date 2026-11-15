// LiveBrowser «Оптимизация» boot hook.
//
// Настройки оптимизации читаются из settings.json, но применяются к окну
// раньше, чем пользователь зайдёт в настройки: хост при старте шлёт
// {"type":"optimize", backgroundBlur, backgroundSuspend}, а этот модуль
// переводит флаги в классы body.  Это не UI — UI живёт в settings.js.
//
// body.no-blur  — тяжёлые backdrop-filter сняты (app.css, блок «Стеклянный
//                 фон»).  Страница настроек ставит тот же класс сама, так
//                 что оба пути согласованы.
// Плюс: QA-хук window.__lbOptimize() возвращает текущее состояние, чтобы
// живую проверку можно было снять из консоли/CDP без открытия настроек.
'use strict';

(function () {

  const body = document.body;
  const state = { backgroundBlur: true, backgroundSuspend: true };

  function apply() {
    body.classList.toggle('no-blur', state.backgroundBlur === false);
  }

  window.__lbOptimize = () => ({ ...state, noBlur: body.classList.contains('no-blur') });

  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (e) => {
      let d = e.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { return; }
      }
      if (!d || d.type !== 'optimize') return;
      if (typeof d.backgroundBlur === 'boolean') state.backgroundBlur = d.backgroundBlur;
      if (typeof d.backgroundSuspend === 'boolean') state.backgroundSuspend = d.backgroundSuspend;
      apply();
    });
  }

  apply();
})();
