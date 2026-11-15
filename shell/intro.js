// LiveBrowser intro — кинематографичный экран первого запуска.
//
// Это не «модалка с анимациями», а короткий фильм с честным ходом времени:
// каждый кадр строится из абсолютного t.
//
//     t ──► frameAt(t) ──► transform/opacity слоёв + canvas-пыль
//
// Поэтому на 60 Гц видно 60 ключевых моментов, на 200 Гц — 200; ни одна
// величина не «тикает» со скоростью кадра.  Контракт времени (Timeline,
// Stage, Ease) общий с композицией HyperFrames в integrations/hyperframes.
//
// ИСТОЧНИКИ КАДРА — один и тот же фильм, разная доставка:
//
//   live  — этот файл: DOM + canvas.  Обычный режим.
//   film  — intro/intro-film.mp4 (рендер той же композиции через
//           HyperFrames).  Для машин, где живой рендер не уложился в
//           бюджет трёх кадров подряд; для точного повтора; для
//           prefers-reduced-motion (там движение есть, но в записи, а не
//           в кадрах композитора).
//   quiet — типографическая карточка: reduced-motion + нет плёнки.
//           Ни частиц, ни параллакса.
//
// Что запоминается МЕЖДУ запусками.  Плёнка — не только аварийный
// фолбэк, но и осознанный выбор: если она в прошлый раз оказалась нужна
// или пользователь просил reduced-motion, следующий показ начнётся сразу
// с плёнки.  Живому режиму это ничего не стоит — он так и так считает
// кадр первым.
//
// Маркер показа.  Требование звучит как localStorage, в LiveBrowser он
// хранится ФЛАГОМ firstrun.flag: settings.json успевает создаться до
// инициализации SettingsStore, поэтому «нет файла — значит первый запуск»
// уже опровергалось.  Флаг ставит хост при старте и снимает на первом
// POST /api/settings — интро закрывается ровно этим запросом.  Те же
// события заодно наполняют localStorage-кэш, чтобы при повторном запуске
// не мелькнуло ни одного кадра: флаг → кэш → (никакого интро).
'use strict';

(function () {

  const { Timeline, Stage, curve, Ease, span, clamp, lerp } = window.LiveIntroClock;

  const API = 'https://api.livebrowser.shell/api';
  const CACHE_KEY = 'livebrowser.welcome.seen.v1';
  const FILM_CACHE_KEY = 'livebrowser.welcome.film.v1';
  const FILM_URL = 'intro/intro-film.mp4';

  // Целевые 200 Гц — это «не просить больше, чем умеет монитор», а не
  // жёсткие 200: кадр собирается за 1/200 с, и на 60 Гц показ идёт ровно
  // 60 кадров в секунду без расписания на 16.6 мс.
  const TARGET_HZ = 200;
  // Сколько подряд кадров должны выйти за бюджет, прежде чем отдать кадр
  // плёнке.  Ошибка в одном кадре (GC, загрузка вкладки) — не повод.
  const SLOW_RUN = 3;
  const SLOW_LIMIT = 1.55;   // x бюджета: 1.55 / 200 Гц ≈ 7.8 мс — всё ещё 120+

  // Пружина кадра — одна на раскадровку и на краску букв: paint() тоже
  // считает посадку каждой буквы, и вторая копия кривой разошлась бы с
  // первой на первом же изменении демпфирования.
  const sp = Ease.spring;

  // ---------------------------------------------------------------------
  // Опции среды
  // ---------------------------------------------------------------------

  function env() {
    const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // body.no-anim — «Анимации: выкл» в настройках LiveBrowser.
    const quiet = document.body.classList.contains('no-anim');
    // Плёнка предпочтительна: прошлый раз машине тесно / просили reduced
    // motion — запись там и покажется, и не придётся прогревать декодер
    // посреди показа.
    let preferFilm = false;
    try { preferFilm = localStorage.getItem(FILM_CACHE_KEY) === '1'; } catch { /* private */ }
    return { reduce, quiet, preferFilm };
  }

  function inHost() {
    return !!(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
  }

  // ---------------------------------------------------------------------
  // Раскадровка (секунды).  Числа продублированы в
  // integrations/hyperframes/beats.json — по ним рендерится MP4, и
  // расхождение там означало бы, что фолбэк показывает другой фильм.
  // ---------------------------------------------------------------------

  const END = 8.00;

  // Кадр для режима quiet — момент, когда композиция уже собрана и ещё не
  // начала уходить.  Не END: в END сцена честно пришла в ноль (exit=0,
  // scrim=0), и статичная карточка показала бы пустой экран.  4.50 —
  // середина «покоя»: подпись встала на 3.40, уход начинается на 4.65
  // (parallax), так что имя, кнопки и свет стоят на своих местах.
  const QUIET_AT = 4.50;

  // Чистая функция t -> состояние кадра.  Каждый рендер (живой кадр,
  // плёнка, композиция HyperFrames) описывает тот же фильм.
  //
  // Ритм.  Фильм собран не из плавных проявлений, а из БИТОВ: каждый бит
  // это удар — 0.5–0.8 с на разгон и посадку, между ними короткая тишина.
  // Бит всегда заканчивается переходом на 0.03–0.08 сверх цели (spring),
  // поэтому глаз читает массу, а не кроссфейд.  Всего пять битов:
  //
  //   I.  свет   — из темноты поднимается мягкий свет
  //   II. тишина — свет становится фоном, ничего не происходит (пауза)
  //   III.имя    — LiveBrowser проявляется целиком, без буквенной сборки
  //   IV. строка — подзаголовок и кнопки догоняют
  //   V.  уход   — всё гаснет в рабочий стол
  //
  // Минимализм: три объекта в кадре (свет, имя, кнопки).  Всё остальное —
  // движение, а не детали.  Ни одна величина не читает performance.now()
  // или номер кадра: только t.
  function frameAt(t) {
    const p = {};

    // --- I. Свет: 0.0–1.1 -----------------------------------------------
    // Мягкое разгорание из темноты, но короткое: раньше здесь было 1.9 с
    // пустого фона, и кадр успевал надоесть до появления имени.  Свет
    // читается за секунду — дальше он уже просто подложка.
    // veil — это не только разгон света, но и его уход.  Раньше величина
    // оставалась 1 до самого END: к 8.0 с горел полный свет, слой
    // снимался, и переход в рабочий стол был скачком из яркого кадра в
    // тёмный.  Теперь свет поднимается и опускается одной величиной —
    // так его невозможно забыть погасить при следующей правке.
    p.veil = span(t, 0.0, 0.85, Ease.sept) * (1 - span(t, 5.90, 7.20, Ease.sept));
    // Один долгий контрзум: камера отходит на полсекунды дольше, чем свет.
    p.depthScale = lerp(1.06, 1.0, span(t, 0.0, 1.9, Ease.out));
    p.seed = 0;
    p.seedScale = 0;
    p.ring = 0;
    p.ringScale = 0;
    p.mark = 0;
    p.markPop = 0;
    p.markY = 0;
    p.markLift = 0;
    p.markPane = 0;
    p.markBar = 0;
    p.markRail = 0;
    p.markTicks = 0;
    p.markDots = 0;
    p.kicker = 0;
    p.kickerY = 0;
    p.sheet = 0;
    p.sheetY = 0;
    p.sheetScale = 0;
    p.sheetRot = 0;
    p.line = 0;
    p.tabs = 0;
    p.address = 0;
    p.addressBar = 0;
    p.shield = 0;
    p.tile0 = 0;
    p.tile1 = 0;
    p.tile2 = 0;
    p.split = 0;
    p.splitBlur = 0;
    // Световой проход убран целиком: блик по сцене — деталь, которой
    // минимализм не платит.
    p.sweep = 0;

    // --- III. Имя: 0.6–2.85 ---------------------------------------------
    // Имя не собирается по буквам: оно проявляется как целое тело.  Из
    // движения у него осталась одна разрядка с 0.12em к 0.02em — это и есть
    // «типографский жест»: буквы расходятся из плотного блока и встают на
    // место.  Прозрачность и разрядка идут по одной шкале времени.
    //
    // Начинается сразу за светом: имя видно уже на ~1.2 с, фон не успевает
    // стать «пустым экраном».
    p.name = span(t, 0.60, 2.20, Ease.sept);
    // Подъём имени убран, и это не экономия.  translate3d на .intro-name —
    // сдвиг ТЕКСТОВОГО слоя: Chromium держит такой текст в кеше масок и при
    // каждом дробном сдвиге перерисовывает глифы.  Для кегля до 124 px это
    // самая дорогая операция в кадре, и приходилась она ровно на первый
    // переход, когда сцена и так только собирается.  Движение в кадре
    // теперь держат свет и камера (сдвиг композиторного слоя, глифы не
    // трогает), а имя только проявляется.
    p.nameY = 0;
    // Разрядка заканчивается вместе с проявлением (2.20), а не на 2.50:
    // та разница в 0.3 с давала на хвосте кадр, где буквы ещё едут, а
    // прозрачность уже стоит — лишний мелкий толчок на ровном месте.
    p.nameTrack = lerp(0.12, 0.02, p.name);

    // --- IV. Строка и кнопки: 1.7–3.4 -----------------------------------
    // Подзаголовок чуть отстаёт от имени, кнопки — от подзаголовка.
    // Одна и та же кривая, разные смещения: движение читается как цепочка,
    // а не как три одновременных фейда.
    p.tagline = span(t, 1.70, 2.65, Ease.sept);
    // Подъём подзаголовка — в шагах, а не в процентах высоты строки: в
    // paint() множитель переводит его в пиксели (2.4 px на шаг).  Буквы
    // высотой 12 px при сдвиге на 11 px наполовину выезжали за кромку
    // маски — не как задуманный выезд, а как случайная обрезка на средине
    // кривой, где скорость наибольшая.
    p.taglineY = lerp(3, 0, p.tagline);
    p.ctas = span(t, 2.20, 3.05, Ease.sept);
    p.ctasY = lerp(10, 0, p.ctas);
    // Служебная подпись.  Ей не нужен собственный «бит»: раньше она
    // стартовала на 0.05 с позже кнопок и с той же кривой, то есть
    // добавляла четвёртый толчок туда, где движение уже должно затихать.
    // Теперь она просто догоняет кнопки — длиннее и слабее по амплитуде
    // (в paint() множитель 0.82), поэтому в кадре читается как подпись,
    // а не как ещё один объект.
    p.notes = span(t, 2.20, 3.40, Ease.sept);

    // --- V. Уход: 5.0–END -----------------------------------------------
    // Кадр собран к 3.3 с, держится собранным ~1.7 с — этого хватает,
    // чтобы прочитать имя и кнопки, и не настолько много, чтобы ждать.
    //
    // Конец гасит СЦЕНА, а не transition корня: раньше scrim/tail падали
    // в ноль раньше END, и на уже прозрачном слое включался ещё и
    // opacity-переход .is-closing — два затухания разной длины подряд
    // читались как залом в последней секунде.  Теперь к END всё кроме
    // фона уже на месте, и уход выглядит одной непрерывной линией.
    // Никакого подъёма панели: гаснет свет — уходит и вся заставка.
    //
    // Уход заканчивается на 7.55, а не на END.  Это не запас на глаз:
    // при гашении ровно в END последний кадр показывал scrim=0, и снятие
    // слоя приходилось на тот же тик, что и финальный кадр.  Ноль и
    // removeChild в одном кадре — это обрыв, а не уход.  Две десятых
    // секунды пустой сцены не видно (там уже ничего нет), зато уход
    // успевает дожить до конца сам.
    // settle должен закончиться ДО начала ухода.  Раньше он доезжал до
    // 1.0 на 6.45, а свет уже гас с 5.90 — кадр пять десятых секунды
    // одновременно собирался и гас, два встречных движения в одной точке.
    // Теперь кадр встал на 5.95 и только потом начинается уход.
    p.settle = span(t, 5.10, 5.95, Ease.sept);
    p.scrim = 1 - span(t, 6.20, 7.20, Ease.sept);
    p.tail = 1 - span(t, 6.20, 7.20, Ease.sept);
    // Содержимое уходит на волосок раньше фона: сначала имя и кнопки,
    // потом свет.  Наоборот — значит имя висит на ещё горевшем фоне.
    p.exit = 1 - span(t, 6.10, 7.10, Ease.sept);
    p.parallax = 1 - span(t, 4.65, 6.65, Ease.sept);

    // camX — параллакс камеры в пикселях: по нему curve() считает
    // инерцию (камера отстаёт от сцены на кадр-два).  Ноль к концу.
    //
    // Один период синуса, а не произведение двух.  Произведение sin·cos
    // меняло знак дважды за фильм: камера шла вправо, останавливалась и
    // возвращалась.  Смена знака скорости — это остановка, и глаз её
    // видит даже на 4 px.
    //
    // Обрезки min(half, PI) нет намеренно: она даёт излом производной в
    // точке обрезки.  Вместо неё — span с smooth-кривой, у которой и
    // скорость, и ускорение на концах нули, поэтому камера плавно
    // поднимается и плавно возвращается, без обрыва.
    p.camX = 5 * Math.sin(Math.PI * span(t, 0.20, 6.20, Ease.sept));

    return p;
  }

  // Инверсия пружины удара — точка, где кадр «дошёл» до цели.  Нужна
  // только плёнке (она не может проиграть пружину в DOM), поэтому
  // выставляется вручную по таймингам выше.

  // Кривая камеры снимается один раз при старте: скорость сцены известна
  // заранее, и инерцию можно посчитать до первого нарисованного кадра.
  // Сетка 240 Гц — это 4 сэмпла на самый быстрый кадр (60 Гц), значит
  // lag/vel не «зубья», а плавная производная.
  let CAM = null;
  function camCurve() {
    if (!CAM) CAM = curve(frameAt, END, 240);
    return CAM;
  }

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------

  function markup(quiet) {
    return (
      '<div class="intro-scrim"></div>' +
      '<div class="intro-viewport">' +
      // Небо — единственный «объект» до появления имени: два мягких
      // градиента, никаких колец, семян и частиц.  Группа нужна, чтобы у
      // света была одна непрозрачность на границе композиторного слоя.
      '<div class="intro-sky-group" aria-hidden="true">' +
      '  <div class="intro-sky">' +
      '    <span class="intro-glow intro-glow-a"></span>' +
      '    <span class="intro-glow intro-glow-b"></span>' +
      '  </div>' +
      '</div>' +

      // Имя — центр кадра.  Каждая буква отдельным span не для сборки
      // по буквам (её больше нет), а чтобы разрядка шла посимвольно и
      // балансировалась внутри строки.
      '<div class="intro-name-mask">' +
      '  <h1 class="intro-name" aria-label="LiveBrowser">' +
      '    <span>L</span><span>i</span><span>v</span><span>e</span><span>B</span><span>r</span><span>o</span><span>w</span><span>s</span><span>e</span><span>r</span>' +
      '  </h1>' +
      '</div>' +
      '<div class="intro-tagline-mask"><p class="intro-tagline">Браузерная оболочка, которая держит фокус.</p></div>' +

      '<div class="intro-ctas">' +
      '  <button class="intro-start" id="intro-start" type="button">Начать</button>' +
      '</div>' +
      '<p class="intro-notes">Показывается один раз · вернуть можно в настройках</p>' +

      '<div class="intro-tail" aria-hidden="true"></div>' +
      '</div>'
    );
  }


  function build(st) {
    const el = document.createElement('div');
    el.className = 'intro';
    el.id = 'intro';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Добро пожаловать в LiveBrowser');
    el.innerHTML = markup();
    el.hidden = true;

    const q = (s) => el.querySelector(s);
    const viewport = q('.intro-viewport');
    st.root = el;
    st.viewport = viewport;
    st.refs = {
      scrim: q('.intro-scrim'),
      skyGroup: q('.intro-sky-group'),
      sky: q('.intro-sky'),
      viewport,
      name: q('.intro-name'),
      letters: [...el.querySelectorAll('.intro-name span')],
      tagline: q('.intro-tagline'),
      ctas: q('.intro-ctas'),
      notes: q('.intro-notes'),
      tail: q('.intro-tail'),
      start: q('#intro-start'),
    };
    // Particle canvas is gone: this film is type and light, so the only
    // stage work left is the camera.  Stage is still created because paint()
    // and the probe read its curve/quality, but it draws nothing.
    st.stage = new Stage(viewport, { budget: 1000 / TARGET_HZ / 1.6 });
    document.body.appendChild(el);
    return el;
  }

  function paint(st, t) {
    const p = frameAt(t);
    const R = st.refs;
    const S = st.set;

    R.scrim.style.opacity = clamp(p.scrim, 0, 1).toFixed(3);
    R.sky.style.opacity = clamp(p.veil, 0, 1).toFixed(3);
    S.sky.style.transform = `scale(${p.depthScale.toFixed(4)})`;
    // Проявление неба — на самом слое контейнера, а не на .intro-sky.
    // Тот лежит внутри «камеры» (.intro-viewport), и opacity на дочернем
    // слое заставил бы композитор либо слить его с прозрачной группой
    // (и тогда каждый сдвиг камеры перерисовывает ВСЕ градиенты света),
    // либо держать отдельный буфер и обновлять его масштаб каждый кадр.
    // Одна непрозрачность на границе группы сливает её в плоскую картинку
    // один раз, а дальше камера просто двигает готовый слой.
    R.skyGroup.style.opacity = clamp(p.veil, 0, 1).toFixed(3);
    R.sky.style.opacity = '1';

    // Имя — одно тело.  Никакой посимвольной сборки: буквы получают
    // только общую прозрачность от родителя, а движение идёт блоком.
    for (let i = 0; i < R.letters.length; i++) R.letters[i].style.opacity = '1';
    R.name.style.opacity = clamp(p.name, 0, 1).toFixed(3);
    R.name.style.letterSpacing = `${p.nameTrack.toFixed(3)}em`;

    R.tagline.style.opacity = clamp(p.tagline, 0, 1).toFixed(3);
    // 2.4 px на шаг: при высоте строки 24 px это ровно её десятая часть.
    R.tagline.style.transform =
      `translate3d(0, ${(p.taglineY * 2.4).toFixed(2)}px, 0)`;

    R.ctas.style.opacity = clamp(p.ctas, 0, 1).toFixed(3);
    R.ctas.style.transform = `translate3d(-50%, ${p.ctasY.toFixed(2)}px, 0)`;
    R.notes.style.opacity = (clamp(p.notes, 0, 1) * 0.82).toFixed(3);
    R.tail.style.opacity = clamp(p.tail, 0, 1).toFixed(3);

    // Камера: ТОЛЬКО сдвиг в пикселях, без scale и без rotateY.
    //
    // Почему.  Любой дробный scale на контейнере с текстом заставляет
    // браузер растрировать слой в промежуточный буфер и затем растягивать
    // его — буквы получают билинейную интерполяцию и выглядят мыльными.
    // Без округления, субпиксельно.  Казалось бы, целые пиксели — это
    // «резко», но при амплитуде 5 px целые пиксели дают всего 10 различимых
    // положений на 6 с: камера стоит, потом переставляется скачком.  Это
    // и читается как мелкая дёрганность посреди плавного хода.
    //
    // Дробный translate3d безопасен там, где дробный scale — нет: сдвиг
    // готового слоя делает композитор на GPU, глифы не перерастрируются.
    // Мыльный текст давал именно scale (буфер + билинейная выборка).
    S.camera.style.transform =
      `translate3d(${p.camX.toFixed(3)}px, 0, 0)`;

    // Уход гасит ВСЁ содержимое одним свойством.
    //
    // Почему отдельным слоем, а не opacity на имени и кнопках по
    // отдельности.  Раньше сцена гасила только фон и кольцо, а имя стояло
    // на полной непрозрачности до самого снятия слоя — фильм обрывался
    // кадром, а не дожимался.  Три отдельные непрозрачности с чуть разными
    // кривыми дали бы то же самое рассогласование, только незаметнее;
    // один слой с одной кривой свести невозможно.
    R.viewport.style.opacity = clamp(p.exit, 0, 1).toFixed(3);

    // Частиц больше нет: экран пуст по построению, canvas только чистится.
    if (st.stage) st.stage.ctx.clearRect(0, 0, st.stage.w, st.stage.h);

    st.lastT = t;
  }

  // Прогрев слоя до того, как он станет видимым.
  //
  // Зачем.  Chromium поднимает элемент в отдельный композиторный слой,
  // когда видит, что его transform меняется каждый кадр, — и всё, что уже
  // было нарисовано, при первом таком кадре перерисовывается заново.  Если
  // это случается, пока слой в глаз, кадр стоит в разы дороже обычного.
  //
  // Здесь сдвиг в один пиксель и обратно уходит ДО снятия hidden: браузер
  // видит «этот слой двигают» на кадре, которого никто не видел, и второй
  // тик только снимает старое положение.  Смена на 1.06→1.0 больше ничего
  // не растеризует.
  //
  // Пиксель, а не пять: свободные текстовые слои Chromium квантует по
  // целым пикселям с трекингом, и последующая поправка раскладки внутри
  // файла не должна оставить за собой ещё один готовый к перерисовке кадр.
  //
  // flush() ниже — обязателен: без него оба сдвига склеились бы в один
  // тик и браузер увидел бы только конечное положение.
  function warmup(st) {
    if (!st.set) return;
    const cam = st.set.camera;
    cam.style.transform = 'translate3d(1px, 0, 0)';
    flush(cam);
    cam.style.transform = 'translate3d(0, 0, 0)';
    flush(cam);
  }

  // Заставить браузер посчитать стиль/раскладку прямо сейчас.  Чтение
  // offsetWidth — самый дешёвый из flush-API: остальные (getBoundingClientRect)
  // возвращают объект и дороже, а нам нужен только факт синхронизации.
  function flush(node) {
    void node.offsetWidth;
  }

  // ---------------------------------------------------------------------
  // Плёнка (HyperFrames MP4) как источник кадра
  // ---------------------------------------------------------------------

  function attachFilm(st, force) {
    if (st.filmTried || env().quiet) return;
    // force=true: плёнка предпочтительна (предпочла её lap), значит
    // грузим сразу, а не ждём, пока живому станет тесно.
    if (!force) st.filmTried = true;
    const v = document.createElement('video');
    v.className = 'intro-film';
    v.muted = true;                // без автозвука: звука в интро нет вовсе
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('aria-hidden', 'true');
    const fail = () => { st.filmReady = false; st.film = null; v.remove(); st.filmTried = true; };
    v.addEventListener('error', fail, { once: true });
    v.addEventListener('loadeddata', () => { st.filmReady = true; }, { once: true });
    v.src = FILM_URL;
    st.viewport.appendChild(v);
    st.film = v;
    v.load().catch ? null : null;
  }

  function promoteFilm(st) {
    if (!st.film || !st.filmReady || st.src === 'film' || st.finished) return false;
    const v = st.film;
    try { v.currentTime = Math.min(st.lastT, Math.max(0, (v.duration || END) - 0.05)); } catch { /* нет метаданных */ }
    const go = () => {
      st.src = 'film';
      st.root.classList.add('is-film');
      if (st.stage) st.stage.ctx.clearRect(0, 0, st.stage.w, st.stage.h);
      try { localStorage.setItem(FILM_CACHE_KEY, '1'); } catch { /* private */ }
    };
    const play = v.play();
    if (play && play.then) play.then(go).catch(() => { st.src = 'live'; });
    else go();
    return true;
  }

  // ---------------------------------------------------------------------
  // Показ
  // ---------------------------------------------------------------------

  function show(opts) {
    opts = opts || {};
    if (st.root) return false;
    const e = env();
    st.src = e.reduce || e.quiet ? 'quiet' : 'live';
    st.preferFilm = e.reduce || e.preferFilm;   // выбор источника кэшируется
    st.finished = false;
    st.lastT = 0;
    st.filmTried = false;
    st.filmReady = false;
    st.film = null;
    st.slowRun = 0;
    st.prismBlurOn = null;
    st.onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
    st.onCloseEnd = null;
    st._closed = false;
    manual = !!opts.full;

    const el = build(st);
    // Две трансформируемые группы: камера (весь кадр) и небо (контрзум).
    st.set = {
      camera: el.querySelector('.intro-viewport'),
      sky: el.querySelector('.intro-sky'),
    };
    st.burstColor = null;
    st.burst = null;
    st.burstN = 0;
    st.burstW = 0;
    // Два цвета вспышки читаются из CSS-переменных, а не зашиты здесь:
    // палитра кадра остаётся в одном месте — intro.css.
    const cs = getComputedStyle(el);
    st.burstWarm = cs.getPropertyValue('--intro-spark').trim() || 'rgba(150,168,255,0.9)';
    st.burstCool = cs.getPropertyValue('--intro-spark-cool').trim() || 'rgba(124,208,255,0.9)';

    el.classList.toggle('is-quiet', st.src === 'quiet');
    if (e.quiet) el.classList.add('is-still');

    // Первый кадр до видимости: нет вспышки неуложенного интро.  Если
    // краска падает на первом кадре, слой снимается целиком: пустой
    // экран хуже, чем онбординг без фильма — рабочий стол должен
    // открыться в любом случае.
    try {
      // Прогрев (см. warmup) идёт до показа: он тратит один кадр, который
      // человек и так не видел, а взамен первый реальный кадр фильма не
      // несёт работы по подъёму слоя в композитор.  Первый дорогой кадр
      // при показах замерен и уходит вместе со сборкой: это одна
      // растеризация на 40–50 мс, ровно на первом тике после показа.
      // Убрать её из краски нельзя — только спрятать за тишиной до
      // показа, но тогда те же 50 мс платятся до первой картинки.  Здесь
      // выбран видимый прогресс: свет уже горит, прерванное интро
      // выглядит как кадр на нулевой секунде, а не как пустой экран.
      paint(st, 0);
      warmup(st);
    } catch (err) {
      el.remove();
      st.root = null;
      st.stage = null;
      throw err;
    }
    el.hidden = false;
    document.body.classList.add('intro-on');

    st.clock = new Timeline(TARGET_HZ);
    st.clock.onFrame = onFrame;

    bind(st);
    requestAnimationFrame(() => {
      el.classList.add('is-live');
      st.refs.start.focus({ preventScroll: true });
      st.clock.play();
    });
    return true;
  }

  function onFrame(t) {
    if (st.finished) return;
    // Режим quiet (reduced-motion / «Анимации: выкл») движения не имеет
    // вовсе: показывается финальный кадр, кадр не пересобирается 60 раз в
    // секунду.  Раньше здесь стоял живой paint(st, t) — класс is-quiet
    // висел, а JS каждый кадр переписывал opacity и transform живыми
    // значениями, поэтому «упрощённая версия» на деле показывала тот же
    // фильм, только без CSS-переходов у кнопок.
    //
    // Время всё равно доводится до END таймлайном: выход (Esc, кнопка)
    // должен работать так же, как в обычном режиме.
    if (st.src === 'quiet') {
      if (!st._quietPainted) { paint(st, QUIET_AT); st._quietPainted = true; }
      if (t >= END - 0.001) finish(true);
      return;
    }
    paint(st, t);

    // Бюджет кадра.  Живой режим идёт сам; плёночная замена — только когда
    // живому тесно SLOW_RUN кадров подряд.  Плёнка не загружается, пока
    // фильм не пошёл (первый кадр никогда не ждёт видео).
    if (st.src === 'live') {
      if (frameCost(st) > SLOW_LIMIT) st.slowRun++;
      else st.slowRun = Math.max(0, st.slowRun - 1);

      // Плёнка предпочтительна: качаем с 0.5 с, но заменяем живой кадр
      // только по готовности — первый кадр не ждёт декодер.
      if (st.preferFilm && !st.filmTried) attachFilm(st, true);
      if (st.preferFilm && st.filmReady) promoteFilm(st);

      if (t > 0.8 && st.slowRun >= SLOW_RUN) {
        attachFilm(st);
        if (st.filmReady) promoteFilm(st);
      }
    } else if (st.src === 'film') {
      // Лента ведёт таймлайн, но кадр всё равно строится по t: если запись
      // отстала или замерла (кодек, декодер), DOM не рассинхронизируется.
      const v = st.film;
      if (v && !v.paused && Math.abs(v.currentTime - t) > 0.35) {
        try { v.currentTime = t; } catch { /* seek not ready */ }
      }
    }

    if (t >= END - 0.001) finish(true);
  }

  // Кадр стоит дороже бюджета?  Меряем сглаженную стоимость рисования от
  // Stage (ema), а не отдельный фрагмент: только тогда она отражает кадр.
  function frameCost(st) {
    return st.stage ? st.stage.ema / st.stage.budget : 0;
  }

  function bind(st) {
    const el = st.root;

    st.onKey = (ev) => {
      // Esc остаётся: кнопки «Пропустить» больше нет, и без клавиши у
      // человека не было бы способа выйти до конца фильма.
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        finish(false);
        return;
      }
      if (ev.key === 'Tab') {
        // Модальность: фокус не уходит в бар под слоем.  Кнопка одна,
        // значит Tab её удерживает, а не ходит по кругу.
        ev.preventDefault();
        st.refs.start.focus();
      }
    };
    el.addEventListener('keydown', st.onKey);

    st.refs.start.addEventListener('click', () => finish(false));

    st.onVis = () => {
      if (!st.clock) return;
      if (document.hidden) st.clock.pause();
      else if (!st.finished) st.clock.play();
    };
    document.addEventListener('visibilitychange', st.onVis);

    // Уход фокуса из окна: ничего не ломаем, просто лента подождёт стадии.
  }

  function finish(natural) {
    if (!st.root || st.finished) return;
    st.finished = true;
    if (st.clock) { st.clock.stop(); st.clock = null; }
    document.removeEventListener('visibilitychange', st.onVis);
    const el = st.root;
    const v = st.film;
    if (v) { try { v.pause(); } catch { /* already gone */ } }

    if (!manual) markSeen();

    // Уход.  Два разных случая, и путать их нельзя:
    //   * natural — фильм доиграл, сцена уже свела scrim и tail к нулю.
    //     Дополнительный opacity-переход тут был бы ВТОРЫМ затуханием
    //     поверх первого: слой успевает стать прозрачным по кадру, а потом
    //     его ещё 0.42 с гасит CSS.  Именно это и читалось как рывок в
    //     конце.  Значит снимаем слой сразу — за кадр, без перехода.
    //   * ранний выход (Esc, «Начать») — кадр ещё полный, и резкое
    //     исчезновение было бы вспышкой.  Вот здесь переход нужен.
    // reduced-motion и no-anim — сразу в обоих случаях.
    const e = env();
    const done = () => {
      if (st._closed) return;
      st._closed = true;
      el.removeEventListener('keydown', st.onKey);
      el.removeEventListener('transitionend', st.onCloseEnd);
      st.onCloseEnd = null;
      el.remove();
      document.body.classList.remove('intro-on');
      st.root = null;
      st.viewport = null;
      manual = false;
      st.stage = null;
      // Куда вернуть фокус.  Раньше здесь стоял getElementById('search') —
      // но #search в разметке оболочки это СКРЫТОЕ шаблон-поле (hidden,
      // ширина 0): focus() на нём молча не срабатывал, и после закрытия
      // заставки активным оставался <body>.  То есть требование «фокус не
      // теряется» не выполнялось ни разу.
      //
      // Настоящий адресный хост — LiveSearch.focus(): он переводит полосу
      // в режим ввода и сам переустанавливает фокус после перекладки.  Если
      // модуля ещё нет (интро открыто вне оболочки), фокус отдаётся первой
      // фокусируемой кнопке интерфейса, а не остаётся в теле документа.
      let placed = false;
      try {
        if (window.LiveSearch && typeof window.LiveSearch.focus === 'function') {
          window.LiveSearch.focus();
          placed = true;
        }
      } catch { /* полоса не готова */ }
      if (!placed) {
        const under = document.querySelector('button:not([disabled]), [tabindex="0"]');
        if (under) { try { under.focus({ preventScroll: true }); } catch { /* inert */ } }
      }
      const cb = st.onDone;
      st.onDone = null;
      if (cb) cb({ natural: !!natural });
    };
    if (e.quiet || e.reduce || natural) { done(); return; }
    el.classList.add('is-closing');
    // Слушаем только transition корня: первый transitionend придёт от
    // ВЛОЖЕННОГО элемента (у кнопок и панели свои transition), и тогда
    // уход закрылся бы раньше, чем погасла заставка.
    st.onCloseEnd = (ev) => { if (ev.target === el) done(); };
    el.addEventListener('transitionend', st.onCloseEnd);
    setTimeout(done, 460);   // страховка: transitionend может не прийти
  }

  function markSeen() {
    try { localStorage.setItem(CACHE_KEY, '1'); } catch { /* private/quota */ }
    // Флаг firstrun снимает хост на любом POST /api/settings — это уже
    // штатная часть контракта (онбординг).  Отправляем пустой патч,
    // уход слоя не ждём.
    if (!inHost()) return;
    try {
      fetch(API + '/settings', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).catch(() => { /* флаг снимет следующий POST */ });
    } catch { /* best-effort */ }
  }

  // ---------------------------------------------------------------------
  // Запуск / внешний API
  // ---------------------------------------------------------------------

  // Первый 'full'-показ идёт и в живой оболочке, значит метку «видели» он
  // не ставит: иначе первое же открытие интро съело бы онбординг для
  // пользователя.  Для прогонов боевого кода (и будущих скриншотов)
  // годится; в обычном запуске флаг ни разу не поднимается.
  let manual = false;

  const st = {
    root: null, viewport: null, stage: null, clock: null, refs: null, set: null,
    src: 'live', film: null, filmTried: false, filmReady: false, preferFilm: false,
    finished: false, slowRun: 0, lastT: 0, burst: null, burstN: 0, burstW: 0,
    onDone: null, onKey: null, onVis: null, onCloseEnd: null, _closed: false, prismBlurOn: null,
  };

  function shouldShow() {
    // Требование «без мигания»: сначала быстрый кэш, затем флаг хоста.
    // Если кэш говорит «уже видели», флаг уже снят первым же POST —
    // сеть не нужна, ни одного кадра интро до ответа.
    try { if (localStorage.getItem(CACHE_KEY) === '1') return Promise.resolve(false); } catch { /* private */ }
    if (!inHost()) return Promise.resolve(false);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    return fetch(API + '/firstrun', { credentials: 'omit', signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !!(d && d.firstRun))
      .catch(() => false)
      .finally(() => clearTimeout(timer));
  }

  window.LiveIntro = {
    show,
    // Загрузить модуль (и его CSS) без решения «показывать ли»: для
    // прогона/замера первого кадра в любой странице оболочки.
    load() {
      if (st.layersAdded) return Promise.resolve();
      st.layersAdded = true;
      const link = document.createElement('link');
      link.id = 'intro-css';
      link.rel = 'stylesheet';
      link.href = 'intro.css';
      // Резолвимся по load, а не сразу: прогон должен мерить кадр уже
      // с применёнными правилами, иначе цифры будут про другой фильм.
      const ready = new Promise((res) => {
        link.addEventListener('load', res, { once: true });
        link.addEventListener('error', res, { once: true });
      });
      document.head.appendChild(link);
      return ready;
    },
    shouldShow,
    isOpen: () => !!st.root,
    // QA: один кадр без часов — повторяемый снимок по t (детерминизм) и
    // та же функция, что у композиции HyperFrames.
    frameAt,
    snapshot(t) {
      if (!st.root) return null;
      paint(st, t);
      return { t, src: st.src, burst: st.burst ? st.burst.length : 0, quality: st.stage ? st.stage.quality : null };
    },
    // QA: плёнка ли сейчас показывается / сколько времени ленты прошло.
    state() {
      return {
        open: !!st.root,
        src: st.src,
        t: st.lastT,
        filmReady: st.filmReady,
        filmTried: st.filmTried,
        quality: st.stage ? st.stage.quality : null,
        paintCost: st.paintCost || 0,
      };
    },
  };

})();
