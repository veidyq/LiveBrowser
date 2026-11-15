// intro-clock — общий контракт времени для интро и для HyperFrames.
//
// Зачем отдельный файл.  Живое интро в шелле, MP4-фолбэк (HyperFrames) и
// композиция integrations/hyperframes должны показывать ОДИН И ТОТ ЖЕ кадр
// в момент времени t.  Поэтому единственный авторитет — функция
// «время -> состояние», а не цепочка твинов:
//
//   постановка (intro.js)  = (tSec) => void      — функция от абсолютного t;
//   композиция (HF)        = paused GSAP tl + tl.seek(t) на каждом кадре.
//
// И то, и другое сходится, потому что кадр всегда строится по t, а не по
// «сколько тиков прошло».  На 60 Гц интро показывает 60 ключевых моментов,
// на 200 Гц — 200: никакой привязки к 60 FPS в коде нет.
//
// Две части:
//   * Timeline — часы с абсолютным временем: пауза по visibilitychange,
//     отсечение кадра на машинном шаге (длинный кадр не перепрыгивает
//     целые сцены), seek по кнопке.
//   * Stage — куда рисовать: canvas с честным DPR (≤2), раз-в-кадр
//     частные производные (все частицы одного стиля) и деградация
//     качества, когда кадр не помещается в бюджет.
'use strict';

(function () {

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, k) => a + (b - a) * k;

  // Ход времени с абсолютным t.  pause()/resume() сдвигают начало отсчёта,
  // поэтому после возврата из фона анимация продолжается, а не телепортом.
  class Timeline {
    constructor() {
      this.rate = 0;            // 0 — стоит; 1 — идёт
      this.offset = 0;          // t на момент последнего старта
      this.t0 = 0;
      this.raf = 0;
      // Частоты здесь нет намеренно.  Кадр идёт по requestAnimationFrame,
      // то есть по частоте дисплея: 60, 100, 144, 200 — сколько даёт
      // система, столько и рисуем.  Никакого «периода 5 мс под 200 Гц»
      // нет: на 100-герцовом экране такой период означал бы, что половина
      // тиков попадает между кадрами и тратит время впустую.
      this.last = 0;
      this.onFrame = null;      // (t) => void, вызывается до этого же кадра
      this._frame = this._frame.bind(this);
    }

    // t — СЕКУНДЫ, как и в frameAt(), END и в композиции HyperFrames.
    // performance.now() отдаёт миллисекунды, поэтому делим: без этого
    // фильм на 6.55 с проходил за 6.55 мс.
    get t() {
      return this.rate ? this.offset + (performance.now() - this.t0) / 1000 : this.offset;
    }

    play() {
      if (this.rate) return;
      this.rate = 1;
      this.t0 = performance.now();
      // Первый кадр — не «рывок»: last выставляется в текущий t, иначе
      // накопленное до старта время (сборка слоя, фокус, первый rAF)
      // уйдёт в offset и фильм начнётся не с нуля, а со середины.
      this.last = this.t;
      this._tick();
    }

    pause() {
      if (!this.rate) return;
      this.offset = this.t;
      this.rate = 0;
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    }

    // Жёсткая установка t (пропуск, перемотка) — без сдвига начала отсчёта.
    seek(t) {
      this.offset = Math.max(0, t);
      if (this.rate) this.t0 = performance.now();
      this._paint();
    }

    stop() {
      this.pause();
      this.onFrame = null;
    }

    _tick() {
      const t = this.t;
      // Длинный кадр (вкладку не видели, машина загрузилась) не должен
      // перепрыгивать сцены: анимируем не больше чем на 100 мс за кадр.
      let dt = t - this.last;
      if (this.last && dt > 0.1) { this.offset -= dt - 0.1; }
      this.last = this.t;
      this._paint();
      if (this.rate) this.raf = requestAnimationFrame(this._frame);
    }

    _frame() {
      this.raf = 0;
      if (!this.rate) return;
      this._tick();
    }

    _paint() {
      if (this.onFrame) this.onFrame(this.t);
    }
  }

  // Canvas на честном DPR.  Первая частная производная — за кадр:
  // у всех частиц один стиль fill/stroke, менять его 700 раз в кадр незачем.
  class Stage {
    constructor(root, opts) {
      this.opts = opts;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'intro-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      root.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
      this.dpr = 1;
      this.w = 1;
      this.h = 1;
      this.quality = 1;         // 1 — полный, ниже — частиц меньше
      this.budget = (opts && opts.budget) || 6.5; // мс на кадр
      this.ema = 0;
      this.resize();
    }

    resize() {
      // DPR честно, но ограничен: 4x на 4K-мониторе — это x16 пикселей
      // на пыль, которая и на 1.5x неотличима.
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    clear() {
      this.ctx.clearRect(0, 0, this.w, this.h);
    }

    // measure() возвращает долю времени, которую рисование заняло от
    // бюджета кадра.  При систематическом перерасходе качество падает
    // (частиц меньше), при запасе — поднимается не выше 1.
    measure(ms) {
      this.ema = this.ema ? this.ema * 0.9 + ms * 0.1 : ms;
      if (this.ema > this.budget && this.quality > 0.34) this.quality = Math.max(0.34, this.quality - 0.12);
      else if (this.ema < this.budget * 0.55 && this.quality < 1) this.quality = Math.min(1, this.quality + 0.04);
      return this.ema / this.budget;
    }
  }

  // Кривая кадра целиком: массив сэмплов по t, снятых с frameAt() до
  // начала показа.  Нужна не «для истории», а чтобы у камеры была
  // инерция: положение камеры в момент t — это интеграл от скорости
  // сцены, а не сама скорость.  Считать производную прямо в кадре нельзя
  // (t приходит переменно и с шумом rAF), поэтому кривая заранее снята
  // на равномерной сетке и читается с линейной интерполяцией.
  //
  // Стоимость: одна выборка на кадр (два деления и два чтения массива) —
  // не зависит ни от герц, ни от разрешения.
  function curve(frameFn, duration, hz) {
    const n = Math.max(2, Math.round(duration * (hz || 240)));
    const dt = duration / (n - 1);
    const xs = new Float32Array(n);
    const vs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      xs[i] = t;
      vs[i] = frameFn(t).camX || 0;
    }
    return {
      n,
      dt,
      xs,
      vs,
      // Значение сцены в момент t (линейная интерполяция по сетке).
      at(t) {
        const f = t / this.dt;
        const i = clamp(f | 0, 0, this.n - 2);
        const k = f - i;
        return this.vs[i] + (this.vs[i + 1] - this.vs[i]) * k;
      },
      // Скорость сцены (px/с) — разность соседей сетки.
      vel(t) {
        const f = t / this.dt;
        const i = clamp(f | 0, 0, this.n - 3);
        const k = f - i;
        const a = (this.vs[i + 1] - this.vs[i]) / this.dt;
        const b = (this.vs[i + 2] - this.vs[i + 1]) / this.dt;
        return a + (b - a) * k;
      },
    };
  }

  // Кривые движения: те же, что в intro.css и в композиции HyperFrames.
  // Единый источник — чтобы живой кадр и рендер совпадали.
  //
  // Почему не одни cubic-bezier.  Дорогое движение отличается не формой
  // кривой, а ФИЗИКОЙ: у него есть разгон, удар и посадка по инерции.  Здесь
  // три инструмента, которыми это собирается без единого лишнего кадра:
  //
  //   spring(k) — затухающая пружина: проскакивает цель и возвращается.
  //               Это не «back.out», у того перелёт задан константой; здесь
  //               амплитуда перелёта убывает по закону, как у настоящей
  //               пружины, поэтому посадка выглядит тяжёлой, а не игрушечной.
  //   wind(k)   — долгий разгон и резкая остановка (ease-in только в конце):
  //               так входят тяжёлые вещи, у которых есть масса.
  //   overshoot — перелёт сверх цели, отдельной функцией: нужен для
  //               масштабов и смещений, где важно именно «сколько за цель».
  //
  // Все они — чистые функции k∈[0,1] и возвращают [0..1+] — значит кадр
  // по-прежнему функция только от t, и на 60/144/200 Гц он идентичен.
  const TAU = Math.PI * 2;

  // Пружина: k — доля пути, d — демпфирование (0.9–1.6), f — число
  // полуколебаний до посадки.  При k=1 ровно 1 — кадр в конце сцены
  // совпадает с финальной позой без «дрожи» в последнем пикселе.
  const spring = (k, d, f) => {
    const dd = d || 1;
    const ff = f || 1.6;
    if (k >= 1) return 1;
    if (k <= 0) return 0;
    return 1 - Math.exp(-dd * 4.2 * k) * Math.cos(TAU * ff * k);
  };

  // Разгон с массой: k^2.4 даёт почти прямую в середине и резкий стоп.
  const wind = (k) => Math.pow(clamp(k, 0, 1), 2.4);

  // Перелёт: value(k) в долях, a — амплитуда в тех же долях.
  const overshoot = (k, a) => {
    const kk = clamp(k, 0, 1);
    return kk + Math.sin(Math.PI * kk) * (a || 0.1) * (1 - kk * 0.4);
  };

  const Ease = {
    linear: (k) => k,
    out: (k) => 1 - Math.pow(1 - k, 3),
    outQuint: (k) => 1 - Math.pow(1 - k, 5),
    outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    // Квинтическая «мягче мягкого» (smootherstep).  Отличие от inOut не в
    // форме, а в границах: у inOut вторая производная на концах равна
    // 6, то есть кадр стартует с мгновенным максимальным ускорением —
    // глаз читает это как короткий толчок в начале движения.  У smooth
    // и скорость, и ускорение на обоих концах ровно нули, поэтому
    // движение не «трогается», а набирается.
    //
    // Нужна именно на входах (свет, кнопки, разрядка) и на уходе: там
    // начало движения приходится на видимую точку кадра.
    smooth: (k) => {
      const x = k < 0 ? 0 : k > 1 ? 1 : k;
      return x * x * x * (x * (x * 6 - 15) + 10);
    },
    // Септ-кривая: у smooth на концах нули у скорости и ускорения, но не
    // у РЫВКА (третьей производной).  Измерение это показало: на границах
    // любого перехода третья производная smooth даёт 94.8 — одинаково у
    // всех величин, потому что это свойство самой кривой.  На 10 мс это
    // ниже порога различимости, но раз цель — идеал, доводим до нуля:
    // у септ-кривой на концах обнуляются и третья, и четвёртая.
    //
    // Стоит она ровно столько же (четыре умножения), поэтому нет причины
    // держать smooth там, где важен чистый старт.  smooth оставлен для
    // величин, чьи значения сейчас сверяются с плёнкой HyperFrames.
    sept: (k) => {
      const x = k < 0 ? 0 : k > 1 ? 1 : k;
      // 35k⁴ − 84k⁵ + 70k⁶ − 20k⁷
      return x * x * x * x * (35 + x * (-84 + x * (70 - 20 * x)));
    },
    in: (k) => k * k * k,
    // Перелёт: чуть больше единицы на конце — так приземляется марка.
    back: (k) => {
      const c = 1.24;
      return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
    },
    spring,
    wind,
    overshoot,
  };

  // Промежуточная величина по [from,to] и [0,1]: clamp, чтобы формула была
  // тотальной (сегменты легко выйти за границы сцены).
  function span(t, from, to, ease) {
    if (to <= from) return t >= to ? 1 : 0;
    const k = clamp((t - from) / (to - from), 0, 1);
    return (ease || Ease.out)(k);
  }

  window.LiveIntroClock = { Timeline, Stage, curve, Ease, span, clamp, lerp };

})();
