// LiveBrowser popover exclusion registry.
// Правило интерфейса: два всплывающих слоя не сосуществуют — открытие одного
// закрывает все остальные (иначе палитра и translate-bubble, меню и
// подсказки перекрывали друг друга, что запрещено поведенческим ТЗ).
// Модули НЕ знают друг о друге: каждый при открытии зовёт
//   window.LivePops?.open('<id>', closeFn)
// где closeFn гасит именно его слой, а при закрытии —
//   window.LivePops?.close('<id>').
// Реестр держит только «открытые сейчас» поповеры; закрытие чужим слоем
// вызывается БЕЗ взаимного каскада (closedByRegistry) — повторный open на
// уже открытый id — просто продление.
'use strict';

(function () {
  const open_ = new Map(); // id -> closeFn

  window.LivePops = {
    open(id, closeFn) {
      if (!id || typeof closeFn !== 'function') return;
      if (open_.has(id)) { open_.set(id, closeFn); return; }
      for (const [otherId, otherClose] of [...open_]) {
        open_.delete(otherId);
        try { otherClose(); } catch { /* слой уже скрыт */ }
      }
      open_.set(id, closeFn);
    },
    close(id) { open_.delete(id); },
    isOpen(id) { return open_.has(id); },
  };
})();
