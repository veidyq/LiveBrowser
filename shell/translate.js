// LiveBrowser translation bubble.
// Uses the free MyMemory API (no key) with a LibreTranslate fallback.
// Chromium's built-in translator has no page-facing API, so this is an
// independent implementation styled to match the shell.
'use strict';

// Top-level names stay inside this file: the shell loads four plain scripts
// into one global scope, so an IIFE prevents `const` redeclaration crashes.
(function () {

const MYMEMORY = 'https://api.mymemory.translated.net/get';
const LANG_NAMES = { auto: 'авто', ru: 'русский', en: 'английский', de: 'немецкий', fr: 'французский', es: 'испанский', zh: 'китайский' };

function el(id) { return document.getElementById(id); }

// Анимированное скрытие баббла (app.css .lb-exit): логическое состояние
// гаснет сразу (bubbleOpen ниже), DOM прячется после 140-мс излёта.
// Гварды: no-anim / tactile-off / prefers-reduced-motion — мгновенно.
// hide() проверяет bubbleOpen: устаревший done (страховочный таймер или
// animationend после повторного открытия) не погасит свежий баббл.
function exitThenHide(node, hide) {
  if (!node || node.hidden) { hide(); return; }
  const gated = document.body.classList.contains('no-anim')
    || document.body.classList.contains('tactile-off')
    || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (gated || node.classList.contains('lb-exit')) { hide(); return; }
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    node.classList.remove('lb-exit');
    hide();
  };
  node.classList.add('lb-exit');
  node.addEventListener('animationend', done, { once: true });
  setTimeout(done, 160); // safety net: если animationend не пришёл
}

// MyMemory rejects 'auto' as a source language, so we detect it ourselves
// first. The heuristic is deliberately simple (script ranges + common word
// hits) and only needs to pick between the languages this UI offers.
function detectLanguage(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';

  const words = text.toLowerCase().match(/[a-z\u00c0-\u024f]+/g) || [];
  const signals = {
    en: ['the', 'and', 'is', 'are', 'you', 'this', 'that', 'with', 'hello', 'world'],
    de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'mit', 'ein', 'eine'],
    fr: ['le', 'la', 'les', 'et', 'est', 'vous', 'avec', 'une', 'des', 'pour'],
    es: ['el', 'la', 'los', 'y', 'es', 'que', 'con', 'una', 'para', 'hola'],
  };
  let best = 'en';
  let bestScore = -1;
  for (const [lang, list] of Object.entries(signals)) {
    const score = words.filter((w) => list.includes(w)).length;
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return best;
}

async function translateViaMyMemory(text, from, to) {
  const source = from === 'auto' ? detectLanguage(text) : from;
  if (source === to) return text;
  const url = `${MYMEMORY}?q=${encodeURIComponent(text)}&langpair=${source}|${to}`;
  const data = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  if (data.responseStatus !== 200) throw new Error(data.responseDetails || 'translate failed');
  const translated = data.responseData && data.responseData.translatedText;
  if (!translated) throw new Error('empty translation');
  return translated;
}

async function runTranslation() {
  const text = el('src-text').value.trim();
  const result = el('result');
  const from = el('src-lang').value;
  const to = el('dst-lang').value;

  result.classList.remove('error');
  if (!text) {
    result.textContent = 'Введите текст для перевода.';
    return;
  }
  if (from !== 'auto' && from === to) {
    result.textContent = 'Выберите разные языки.';
    result.classList.add('error');
    return;
  }

  result.textContent = 'Перевожу…';
  try {
    result.textContent = await translateViaMyMemory(text, from, to);
  } catch (err) {
    result.textContent = `Не удалось перевести: ${err.message}`;
    result.classList.add('error');
  }
}

// Логическое состояние «баббл открыт» отдельно от bubble.hidden: закрытие
// гасит его мгновенно, а DOM прячется только после излёта (.lb-exit).
let bubbleOpen = false;

function openBubble(anchor) {
  const bubble = el('translate-bubble');
  window.LivePops?.open('translate-bubble', closeBubble);
  bubbleOpen = true;
  // Открытие во время излёта: снимаем .lb-exit до показа (hide() при этом
  // уже ничего не погасит — он проверяет bubbleOpen).
  bubble.classList.remove('lb-exit');
  bubble.hidden = false;

  // Anchor under the translate button, clamped to the viewport.
  const rect = anchor.getBoundingClientRect();
  const gap = 10;
  let left = rect.right - bubble.offsetWidth;
  let top = rect.bottom + gap;
  left = Math.max(12, Math.min(left, window.innerWidth - bubble.offsetWidth - 12));
  if (top + bubble.offsetHeight > window.innerHeight - 12) {
    top = rect.top - bubble.offsetHeight - gap;
  }
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  el('src-text').focus();
}

function closeBubble() {
  if (!bubbleOpen) return;
  // Реестр гаснем сразу; hidden ставится только после излёта (.lb-exit).
  bubbleOpen = false;
  window.LivePops?.close('translate-bubble');
  const bubble = el('translate-bubble');
  exitThenHide(bubble, () => {
    const b = el('translate-bubble');
    if (b && !bubbleOpen) b.hidden = true;
  });
}

function initTranslate() {
  const btn = el('translate-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (bubbleOpen) closeBubble(); else openBubble(btn);
  });

  el('bubble-close').addEventListener('click', closeBubble);
  el('translate-go').addEventListener('click', runTranslation);

  el('swap').addEventListener('click', () => {
    const a = el('src-lang');
    const b = el('dst-lang');
    // Swap only when neither side is 'auto'; otherwise the button is inert.
    if (a.value !== 'auto') {
      const tmp = a.value;
      a.value = b.value;
      b.value = tmp;
    }
  });

  el('src-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runTranslation();
  });

  // Click outside closes the bubble.  bubbleOpen, не bubble.hidden: во время
  // излёта баббл ещё виден, но логически уже закрыт — клик мимо не должен
  // перезапускать closeBubble и обрывать анимацию.
  document.addEventListener('mousedown', (e) => {
    const bubble = el('translate-bubble');
    if (bubbleOpen && bubble && !bubble.contains(e.target) && !btn.contains(e.target)) {
      closeBubble();
    }
  });

  // Esc closes the bubble only when it is actually open, and only after the
  // settings sheet has had its say (capture order: settings, then this).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bubbleOpen) {
      e.stopImmediatePropagation();
      closeBubble();
    }
  }, true);
}

document.addEventListener('DOMContentLoaded', initTranslate);

})();
