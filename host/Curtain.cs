using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace LiveBrowser;

// «Штора» — быстрый полупрозрачный цветной занавес, который проезжает по
// всему окну в момент смены вкладки и прячет подмену вьюх.  Свойства:
//  - никаких скриншотов страниц (кроссфейд именно ими ломался о задержку) —
//    рисуется только цветная полоса, поэтому сломаться не о чем: сайт может
//    быть хоть чёрным, хоть ещё грузиться — эффект одинаков;
//  - per-pixel alpha через UpdateLayeredWindow на TOP-LEVEL layered-окне,
//    лежащем ровно над окном браузера (сразу после него в z-order): деть
//    полосу в child-HWND нельзя — ULW на child-окнах падает с err=31
//    (проверено), а прозрачный WebView2-оверлей показал бы BackColor формы,
//    а не соседние HWND (ловушка, проверенная на ui-вьюхе);
//  - окно ровно размером с полосу: поверхность (clear + колонки полосы в
//    DIB-секции) собирается ОДИН раз и отдаётся ULW, а движение — это
//    SetWindowPos по кадрам, то есть готовый слой двигает DWM.  Пересборка
//    и повторная пересылка всего экрана каждый кадр на живом окне полосу
//    «теряли» (Show=True, а пиксели — от страницы), хотя одиночный ULW в
//    самопробе её показывал;
//  - подмена вьюх выполняется, когда полоса накрывает центр
//    (eased progress = 0.5 — ровно середина пути полосы);
//  - клики сквозь полосу проходят (WS_EX_TRANSPARENT + WS_DISABLED),
//    фокус и таскбар она не трогает (NOACTIVATE + TOOLWINDOW).
public sealed class Curtain : IDisposable
{
    // 0.16 с — спека перехода: на 80-й мс полоса накрывает центр окна
    // (eased 0.5) и происходит подмена вьюх, к 160-й проезд завершён.
    // Полоса ходит только между ГОТОВЫМИ вьюхами — «дольше живёт поверх
    // не нарисованной страницы» не грозит; LIVEBROWSER_SLOWCURTAIN=1
    // замедляет до 1.2 с — режим отладки/скриншотов.
    private const int DurationMs = 160;
    private const double EdgeFrac = 0.30;   // доля ширины на мягкий растворяющийся край
    private const double SoftEdgeTone = 0.72; // маска кромки → доля альфы (растворение)
    private const double CyberEdgeTone = 1.0; // cyber: жёсткий край, маска 0..1
    private const byte MaxAlpha = 236;      // в ядре «за полосой ничего не видно»
    // Подложки под полосой больше нет (см. ComposeFrame): полоса идёт прямо
    // по странице, которую сменяет.  BarCssPx остался для DPI высоты баров.
    private const int BarCssPx = 56;

    private const int WS_POPUP = unchecked((int)0x80000000);
    private const int WS_DISABLED = 0x08000000;
    private const int WS_EX_LAYERED = 0x00080000;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    // Owning the WebView2 window right below the curtain is what keeps the
    // band on top: the browser's compositor surface (DirectComposition) is a
    // sibling window, NOT a child of the form, so the band was dropping under
    // it a frame after the swap — that was the black jump / flicker.
    private const uint SWP_NOOWNERZORDER = 0x0200;
    private const uint SW_SHOWNOACTIVATE = 4;
    private const uint SW_HIDE = 0;
    private const uint ULW_ALPHA = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int W; public int H; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BLENDFUNCTION
    {
        public byte Op; public byte Flags; public byte SourceConstantAlpha; public byte AlphaFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public int Size; public int Width; public int Height;
        public short Planes; public short BitCount; public int Compression;
        public int SizeImage; public int XPels; public int YPels; public int ClrUsed; public int ClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO { public BITMAPINFOHEADER Header; public uint Colors; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowExW(int exStyle, string cls, string name, int style,
        int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(IntPtr h, IntPtr hdcDst, ref POINT dst, ref SIZE size, IntPtr hdcSrc, ref POINT src, uint crKey, ref BLENDFUNCTION blend, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, ref RECT r);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr h);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

    private readonly Control owner;
    private IntPtr hwnd;
    private IntPtr memDc, dib, dibBits, oldObj;
    private byte[] surface;      // кадр целиком: W*H*4 premultiplied BGRA
    private byte[] bandCol;      // колонки полосы: bw*4 (BGRA premultiplied)
    // Маски кромок по i = tx - x (bw*256 байт).  Края полосы при движении
    // должны считаться в субпикселях: иначе колонка «включается» целиком,
    // и на мониторе 60 Гц полоса проходит 3-4 px между кадрами — кромка
    // дёргается.  Порядок байтов одинаков на x86 и ARM, 64-битность не
    // важна — читаем полуслово через BitConverter.
    // Покрытие колонки полосой: bw*256+buf байт в масштабе 1/256.  Для
    // колонки экрана wx покрытие = covTable[round((wx - x)*256)], поэтому
    // субпиксельное движение кромки передаётся напрямую — без этого край
    // «ползёт» на 2-4 px между кадрами и дёргается.
    private byte[] covTable;         // доля яркости: 0..255 (soft) / c сканлайн-гашением
    private int covScale = 256;
    private int fw, fh, bw;
    private Color color;
    private Color bandColor;         // акцент, с которым собран bandCol
    // Night City: полоса не градиент, а резкая жёлтая плашка с циановой
    // кромкой, глитч-выпадениями по колонкам и сканлайн-строками кадра.
    public bool Cyber { get; set; }
    public Color EdgeColor { get; set; } = Color.Empty;
    // Высота баров (device px) — основной и панельный.
    public int TopPx { get; set; }
    public int BarPx { get; set; }
    private volatile bool busy;
    private volatile bool disposed;
    // Окно свернули/скрыли посреди проезда: полосу гасим в ближайшем кадре,
    // иначе отдельное topmost-окно доезжало по рабочему столу.
    private volatile bool gone;

    public void OwnerGone(bool isGone)
    {
        if (isGone) gone = true;
    }
    private bool needsMidLog;
    private bool layertestDone;
    private Thread runner;

    public Curtain(Control owner) { this.owner = owner; }

    // leftToRight: вкладка правее текущей — полоса едет слева направо,
    // «привозя» её; левее — справа налево.  Направление связывает движение
    // шторы с положением вкладки в полосе — переход читается как жест.
    // onSwap выполняется на UI-потоке, когда полоса накрыла центр экрана.
    // Одноразовая проверка самогó механизма layered-окна на этой машине:
    // полупрозрачная полоса поверх формы, без свипа.  Пиксель на экране
    // должен прийти в акцент — иначе полоса не видна вовсе.
    private void LayerTest(Color accent)
    {
        try
        {
            int w = owner.ClientSize.Width, h = owner.ClientSize.Height;
            Point origin = owner.PointToScreen(Point.Empty);
            EnsureWindow(origin.X, origin.Y, w, h);
            bw = 704;
            bandColor = Color.Empty;          // сбросить кэш полосы под новый цвет
            BuildBand(bw, accent);
            uiXF = double.NaN;
            BuildSurface(w, h, accent);
            uiXF = double.NaN;
            ComposeFrame(w / 2.0 - bw / 2.0);
            var dst = new POINT { X = origin.X, Y = origin.Y };
            var size = new SIZE { W = w, H = h };
            var src = new POINT { X = 0, Y = 0 };
            var blend = new BLENDFUNCTION { Op = 0, Flags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            bool ok;
            MainForm.DebugLog("layertest pre ulw scr=" + SampleScreen(origin.X + w / 2, origin.Y + h / 2));
            // Голый экранный DC: оконный DC снижал refcount DIB, который
            // слою ещё нужен, — следующий FreeSurface ронял поверхность.
            IntPtr screen0 = GetDC(IntPtr.Zero);
            try { ok = UpdateLayeredWindow(hwnd, screen0, ref dst, ref size, memDc, ref src, 0, ref blend, ULW_ALPHA); }
            finally { ReleaseDC(IntPtr.Zero, screen0); }
            RaiseBand();
            MainForm.DebugLog($"layertest ulw={ok} err={Marshal.GetLastWin32Error()}");
            for (int i = 0; i < 3; i++)
            {
                Thread.Sleep(700);
                MainForm.DebugLog($"layertest t{i} scr={SampleScreen(origin.X + w / 2, origin.Y + h / 2)} vis={IsWindowVisible(hwnd)}");
            }
            ShowWindow(hwnd, SW_HIDE);
        }
        catch (Exception ex) { MainForm.DebugLog("layertest fail " + ex.GetType().Name + " " + ex.Message + " @ " + ex.StackTrace?.Replace("\r", " ").Replace("\n", " | ")); }
        try { DestroyWindow(hwnd); hwnd = IntPtr.Zero; } catch (Exception ex) { MainForm.DebugLog("layertest destroy " + ex.Message); }
        try { FreeSurface(); } catch (Exception ex) { MainForm.DebugLog("layertest free " + ex.Message); }
        // Свип как в бою: тот же экземпляр и тот же путь Sweep (busy=false).
        MainForm.DebugLog("layertest -> sweep");
        layertestDone = true;
        Sweep(true, accent, () => { });
    }

    public void Sweep(bool leftToRight, Color accent, Action onSwap)
    {
        if (Environment.GetEnvironmentVariable("LIVEBROWSER_LAYERTEST") == "1" && !layertestDone)
        {
            // Один раз на экземпляр: дальше — обычный путь свипа ниже.
            LayerTest(accent);
            return;
        }
        if (disposed || owner == null || owner.IsDisposed || !owner.IsHandleCreated
            || !owner.Visible || (owner as Form)?.WindowState == FormWindowState.Minimized || busy)
        {
            // Свёрнутое окно: штора не нужна вовсе — полоса летала бы поверх
            // рабочего стола, а прятать подмену нечего.
            onSwap();
            return;
        }
        gone = false;
        try
        {
            int w = owner.ClientSize.Width, h = owner.ClientSize.Height;
            if (w < 80 || h < 80) { onSwap(); return; }
            int dur = Environment.GetEnvironmentVariable("LIVEBROWSER_SLOWCURTAIN") == "1"
                ? 1200 : DurationMs;
            needsMidLog = dur == 1200;
            Point origin = owner.PointToScreen(Point.Empty); // клиент == всё окно (frameless)

            // Ширина полосы: 55 % окна (cyber — не уже 320 px, иначе резкая
            // плашка перелетает кадр рывком и читается как мельтешение).
            bw = Math.Min(w, Math.Max(Cyber ? 320 : 260, w * 55 / 100));
            if (bandColor != accent || bandCol == null || bandCol.Length != bw * 4)
            {
                BuildBand(bw, accent);
                bandColor = accent;
            }

            // Окно ровно размером полосы, а не всего клиента: поверхность
            // рисуется ОДИН раз, дальше DWM двигает готовый слой.  Раньше
            // каждый кадр пересобирался и пересылался весь экран (W×H ULW),
            // и на живом окне полоса не появлялась — при том что одиночный
            // ULW в самопробе показывал её на экране.
            if (!BuildSurface(bw, h, accent))
            {
                busy = false;
                onSwap();
                return;
            }
            uiXF = double.NaN;
            ComposeFrame(0); // полоса занимает всё своё окно
            EnsureWindow(origin.X, origin.Y, bw, h);

            int travel = w + bw;
            int x0 = leftToRight ? -bw : w;
            int startX = origin.X + x0;
            var dst = new POINT { X = startX , Y = origin.Y };
            var size = new SIZE { W = bw, H = h };
            var src = new POINT { X = 0, Y = 0 };
            var blend = new BLENDFUNCTION { Op = 0, Flags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
            // ULW до показа: в журнале прошлой ночи «показать → ULW» давало
            // Show=True, но пиксели оставались от страницы.  Слой получает
            // содержимое ещё невидимым, потом показывается уже готовым.
            IntPtr screen = GetDC(IntPtr.Zero);
            bool ok;
            try { ok = UpdateLayeredWindow(hwnd, screen, ref dst, ref size, memDc, ref src, 0, ref blend, ULW_ALPHA); }
            finally { ReleaseDC(IntPtr.Zero, screen); }
            MainForm.DebugLog($"curtain hwnd={hwnd != IntPtr.Zero} ulw={ok} err={Marshal.GetLastWin32Error()} band={bw}x{h} ltr={leftToRight} accent=#{accent.R:x2}{accent.G:x2}{accent.B:x2} cyber={Cyber}");
            if (!ok)
            {
                busy = false;
                onSwap();
                return;
            }
            busy = true;
            MainForm.DebugLog("curtain running x=" + startX);

            bool swapDone = false;
            bool midLogged = false;
            bool shown = false;
            bool edgeLogged = false;
            runner = new Thread(() =>
            {
                var sw = Stopwatch.StartNew();
                try
                {
                    while (!disposed)
                    {
                        if (gone)
                        {
                            // Свернули окно на проезде: полосу гасим, вкладку
                            // доводим до конца — подменять уже нечего.
                            MainForm.DebugLog("curtain abort owner hidden");
                            ShowWindow(hwnd, SW_HIDE);
                            if (!swapDone) { swapDone = true; try { owner.Invoke(onSwap); } catch { } }
                            break;
                        }
                        double t = sw.ElapsedMilliseconds / (double)dur;
                        if (t >= 1) break;
                        double e = EaseInOutCubic(t);
                        double x = leftToRight ? x0 + e * travel : x0 - e * travel;
                        // Двигаем окно с готовой поверхностью.  HWND_TOPMOST в
                        // каждом кадре ещё и возвращает слой наверх, если
                        // композитор сайта всплыл при подмене вьюх.
                        int sx = origin.X + (int)Math.Round(x);
                        SetWindowPos(hwnd, new IntPtr(-1), sx, origin.Y, 0, 0,
                            SWP_NOSIZE | SWP_NOACTIVATE);
                        // Полоса — отдельное popup-окно: пока она въезжает и
                        // выезжает, её часть висела бы над рабочим столом.
                        // Область окна режет слой ровно по клиентской области
                        // формы, поэтому за границы окна пикселей не видно.
                        bool vis = ClipToClient(sx, origin, w, h);
                        if (vis && !shown)
                        {
                            shown = true;
                            RaiseBand();
                            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                        }
                        if (needsMidLog && !midLogged && e >= 0.5)
                        {
                            midLogged = true;
                            var r = new RECT(); GetWindowRect(hwnd, ref r);
                            int bm = (bw / 2) * 4;
                            MainForm.DebugLog($"curtain mid t={t:0.00} rect={r.Left},{r.Top},{r.Right - r.Left}x{r.Bottom - r.Top}"
                                + $" band b={bandCol[bm]} g={bandCol[bm + 1]} r={bandCol[bm + 2]} a={bandCol[bm + 3]}"
                                + $" surf b={surface[bm]} g={surface[bm + 1]} r={surface[bm + 2]} a={surface[bm + 3]}"
                                + $" cov={covTable[Math.Min(covTable.Length - 1, (bw / 2) * covScale)]}"
                                + $" scr={SampleScreen(origin.X + w / 2, origin.Y + h / 2)}");
                            // Кадр ровно в середине проезда — для пробы: снимок
                            // всего окна с запасом, чтобы проверить и цвет, и то,
                            // что полоса не вылезает за границы окна.
                            try { owner.BeginInvoke(new Action(() => (owner as MainForm)?.ProbeGrab($"probe-curtain-mid-{accent.R:x2}{accent.G:x2}{accent.B:x2}", 260))); } catch { }
                        }
                        if (needsMidLog && !edgeLogged && t > 0.15)
                        {
                            // В этот момент полоса торчит за клиентом формы:
                            // снаружи окна пикселей быть не должно (клип области).
                            edgeLogged = true;
                            MainForm.DebugLog($"curtain edge x={x:0} outL={SampleScreen(origin.X - 24, origin.Y + h / 2)}"
                                + $" outR={SampleScreen(origin.X + w + 24, origin.Y + h / 2)}");
                        }
                        if (!swapDone && e >= 0.5)
                        {
                            // Полоса накрыла центр — тихо подменяем вьюхи.
                            swapDone = true;
                            MainForm.DebugLog("curtain swap mid");
                            owner.Invoke(onSwap);
                        }
                        Thread.Sleep(1);
                    }
                }
                catch
                {
                    if (!swapDone) { swapDone = true; try { owner.Invoke(onSwap); } catch { } }
                }
                finally
                {
                    MainForm.DebugLog("curtain done");
                    try { owner.BeginInvoke(() => { try { ShowWindow(hwnd, SW_HIDE); } catch { } busy = false; }); }
                    catch { busy = false; }
                }
            });
            runner.IsBackground = true;
            runner.Start();
        }
        catch
        {
            // Эффект не получился — но вкладка обязана переключиться в любом случае.
            busy = false;
            try { if (hwnd != IntPtr.Zero) ShowWindow(hwnd, SW_HIDE); } catch { }
            onSwap();
        }
    }

    public void Dispose()
    {
        disposed = true;
        try { runner?.Join(250); } catch { }
        try { if (hwnd != IntPtr.Zero) DestroyWindow(hwnd); } catch { }
        hwnd = IntPtr.Zero;
        FreeSurface();
    }

    // HWND_TOPMOST — поверх всего, включая композитор WebView2, который
    // живёт отдельным HWND и при показе вьюхи всплывает над формой.
    private void RaiseBand()
    {
        if (hwnd == IntPtr.Zero) return;
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    private void EnsureWindow(int x, int y, int w, int h)
    {
        if (hwnd != IntPtr.Zero) return;
        // Без владельца: WS_POPUP с owner держит окно над владельцем, но
        // композитор WebView2 — отдельный HWND, который всплывает выше формы
        // и прятал полосу под страницей.  z-order держит RaiseBand.
        hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            "STATIC", "", WS_POPUP | WS_DISABLED,
            x, y, w, h, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        MainForm.DebugLog("curtain create hwnd=" + hwnd + " err=" + Marshal.GetLastWin32Error());
        if (hwnd != IntPtr.Zero) StyleTopmost(hwnd);
    }

    // Область окна полосы = пересечение её прямоугольника с клиентом формы
    // (в координатах самого окна полосы).  False — полоса целиком снаружи.
    private bool ClipToClient(int sx, Point origin, int w, int h)
    {
        int l = Math.Max(sx, origin.X) - sx;
        int r = Math.Min(sx + bw, origin.X + w) - sx;
        if (r <= l || h <= 0) return false;
        IntPtr rgn = CreateRectRgn(l, 0, r, h);
        if (rgn == IntPtr.Zero) return true;
        if (SetWindowRgn(hwnd, rgn, false) == 0) DeleteObject(rgn);
        return true;
    }

    // HWND_TOPMOST — выше композитора WebView2 в том же процессе хоста.
    private static void StyleTopmost(IntPtr h)
    {
        SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    // Непрерывное покрытие колонки полосой, шаг 1/256 пикселя.  edgeFrac в
    // старых единицах сохранён для числа зонности (0.30 = широкий мягкий
    // край, 2/width = жёсткий cyber).  covTable[i] = Smooth(t) где t — доля
    // пути «внутри» кромки; внутренние пиксели сплошные (t >= 1).
    private void BuildCoverageTable(int width, double edgeFrac, int scale)
    {
        covScale = scale;
        int n = width * scale + 64; // +запас на субпиксель края
        covTable = new byte[n];
        int ramp = (int)Math.Round(edgeFrac * width);
        if (ramp < 1) ramp = 1;
        for (int i = 0; i < n; i++)
        {
            double t = i / (double)scale;                 // позиция в полосе
            double cov;
            if (t < 0) cov = 0;
            else if (t < ramp) cov = Smooth(t / ramp);    // ведущий край
            else if (t > width - ramp) cov = Smooth(Math.Max(0, (width - t) / ramp)); // замыкающий
            else cov = 1;                                 // ядро
            covTable[i] = (byte)Math.Round(cov * 255);
        }
    }

    // Полоса: колонки с мягкими краями (alpha 0 → MaxAlpha → 0) и чуть более
    // светлым «бликом» в ядре — ладонь, а не плоская плашка.
    private void BuildBand(int width, Color accent)
    {
        bandCol = new byte[width * 4];
        si = 0; // ядро без фринжа: маски кромок дают плавный край
        if (Cyber)
        {
            BuildCyberCore(width, accent);
            si = 3; // в cyber — тройная сканлайн-строка
            return;
        }
        BuildCoverageTable(width, EdgeFrac, covScale);
        for (int x = 0; x < width; x++)
        {
            // Ядро — чистый цвет темы.  Раньше в него подмешивался белый «блик»
            // (до +26 %), и плашка читалась бледной, «не своего» цвета —
            // требование «полоска под цвет темы» значит ровно --accent.
            int al = (int)Math.Round(MaxAlpha * (Cyber ? CyberEdgeTone : SoftEdgeTone));
            int r = accent.R, g = accent.G, b = accent.B;
            int o = x * 4;
            bandCol[o] = (byte)(b * al / 255);
            bandCol[o + 1] = (byte)(g * al / 255);
            bandCol[o + 2] = (byte)(r * al / 255);
            bandCol[o + 3] = (byte)al;
        }
    }

    // Резкая плашка: край в 2-3 px (антиалиасинг, не градиент), ядро — чистый
    // цвет, циановая кромка по 3 колонки по обе стороны.  Выпадения — целые
    // колонки с пониженной альфой на детерминированных позициях (глитч не
    // мерцает случайно, шторка каждый раз выглядит одинаково), плюс тонкие
    // тёмные линии каждые 3 колонки внутри ядра.
    private void BuildCyberCore(int width, Color accent)
    {
        BuildCoverageTable(width, 2.0 / Math.Max(1, width), covScale);
        const int edgePx = 2;    // отступ до циановой кромки
        const int fringePx = 3;  // циановая кромка внутри ядра с обеих сторон
        // Детерминированный «Паркинсон»-набор: (позиция в долях, доля ширины).
        double[] glitchAt = { 0.17, 0.29, 0.41, 0.58, 0.72, 0.86 };
        double[] glitchLen = { 0.035, 0.018, 0.055, 0.024, 0.04, 0.02 };
        Color edge = EdgeColor.IsEmpty ? Color.Cyan : EdgeColor;
        for (int x = 0; x < width; x++)
        {
            double t = width > 1 ? x / (double)(width - 1) : 0.5;
            double al = MaxAlpha; // границу плашки рисует маска кромки
            // Глитч: колонка целиком гаснет до 40 % или вспыхивает на весь цвет.
            for (int g = 0; g < glitchAt.Length; g++)
            {
                double g0 = glitchAt[g], g1 = glitchAt[g] + glitchLen[g];
                if (t >= g0 && t < g1)
                {
                    al *= (g % 2 == 0) ? 0.40 : 1.16;
                    break;
                }
            }
            al = Math.Min(255, al);
            int r = accent.R, gg = accent.G, b = accent.B;
            // Сдвиг к циану — кромки, чтобы торец плашки читался.
            if (x >= edgePx && x < edgePx + fringePx) { r = edge.R; gg = edge.G; b = edge.B; }
            else if (x < width - edgePx && x >= width - edgePx - fringePx) { r = edge.R; gg = edge.G; b = edge.B; }
            int trip = x % 3;
            if (trip == 1)
            {
                // тонкие тёмные линии сканлайнов вдоль полосы
                r *= 3 / 4; gg *= 3 / 4; b *= 3 / 4;
            }
            int ai = (int)Math.Round(al);
            int o = x * 4;
            bandCol[o] = (byte)(b * ai / 255);
            bandCol[o + 1] = (byte)(gg * ai / 255);
            bandCol[o + 2] = (byte)(r * ai / 255);
            bandCol[o + 3] = (byte)ai;
        }
    }

    // Поверхность окна целиком (W*H*4) + DIB-секция.  Порядок GDI-вызовов —
    // ровно как в самопробке, которая проходит внутри приложения: один
    // экранный DC, затем DIB, затем совместимый DC.  Обнаружено: отдельно
    // созданный в EnsureWindow memDc приходил NULL (ulw=False err=31), хотя
    // та же пара DIB+DC через секунду в пробе работала.
    private bool BuildSurface(int w, int h, Color accent)
    {
        if (dib != IntPtr.Zero && fw == w && fh == h && color == accent && surface != null) return true;
        FreeSurface();
        fw = w; fh = h; color = accent;

        var bmi = new BITMAPINFO();
        bmi.Header.Size = Marshal.SizeOf<BITMAPINFOHEADER>();
        bmi.Header.Width = fw;
        bmi.Header.Height = -fh; // top-down
        bmi.Header.Planes = 1;
        bmi.Header.BitCount = 32;

        IntPtr screen = GetDC(IntPtr.Zero);
        dib = CreateDIBSection(screen, ref bmi, 0, out dibBits, IntPtr.Zero, 0);
        if (dib != IntPtr.Zero)
            memDc = CreateCompatibleDC(screen);
        if (memDc == IntPtr.Zero)
        {
            memDc = CreateCompatibleDC(IntPtr.Zero); // запасной путь: DC экрана по умолчанию
            MainForm.DebugLog("curtain gdi retry memDc=" + memDc);
        }
        ReleaseDC(IntPtr.Zero, screen);
        if (dib == IntPtr.Zero || dibBits == IntPtr.Zero || memDc == IntPtr.Zero)
        {
            MainForm.DebugLog($"curtain gdi FAIL dib={dib} bits={dibBits} memDc={memDc}");
            return false;
        }
        surface = new byte[fw * fh * 4];
        oldObj = SelectObject(memDc, dib);
        return true;
    }

    // Кадр: очистить, вколотить колонки полосы по текущему x, выгрузить в DIB.
    // Сканлайн-модуляция (cyber) накладывается прямо в цикле копирования —
    // второй проход по миллиону пикселей на кадр был бы лишним.
    // Собирается один раз на проходку (x = 0, окно размером с полосу):
    // дальше двигается само окно, поэтому полная очистка нужна только
    // на первом кадре.
    private double uiXF = double.NaN;   // позиция полосы в прошлом кадре
    private int si;   // шаг сканлайн-строки: 3 = cyber, 0 = без полос

    private void ComposeFrame(double x)
    {
        int stride = fw * 4;
        int x256 = (int)Math.Round(x * covScale);
        // Колонки экрана, которые полоса накрывает в этом кадре (с запасом
        // на кромку): за их пределами всё прозрачно.
        int lo = Math.Max(0, (int)Math.Floor(x));
        int hi = Math.Min(fw - 1, (int)Math.Ceiling(x + bw));
        if (double.IsNaN(uiXF) && surface != null) Array.Clear(surface);
        // Полоса закрыта своей же областью: всё, что она покинула за шаг,
        // гасится в прозрачность, всё остальное в кадре и так прозрачно с
        // первого Array.Clear.  Раньше здесь заливался фон темы — сначала
        // весь экран на первом кадре, потом «покинутые» колонки, — и за
        // шторкой ехала сплошная плашка мимо полосы, перекрывавшая сайт.
        bool first = double.IsNaN(uiXF);
        if (!first)
        {
            int from = Math.Max(0, (int)Math.Floor(uiXF));
            int to = Math.Min(fw - 1, (int)Math.Ceiling(uiXF + bw));
            for (int wx = from; wx <= to; wx++) ClearCol(wx, stride);
        }
        for (int wx = lo; wx <= hi; wx++)
        {
            // Позиция пикселя в координатах полосы (субпиксельная, 1/256).
            int t256 = wx * covScale - x256;
            int ci = t256;
            if (ci < 0 || ci >= covTable.Length)
            {
                ClearCol(wx, stride);
                continue;
            }
            byte cov = covTable[ci];
            // Индекс колонки полосы для цвета (ядро/фринж) — целая часть.
            int bx = t256 / covScale;
            if (bx < 0) bx = 0;
            if (bx >= bw) bx = bw - 1;
            int co = bx * 4;
            // bandCol хранится в порядке BGRA (как и surface): b, g, r, a.
            int bB = bandCol[co], bG = bandCol[co + 1], bR = bandCol[co + 2], bA = bandCol[co + 3];
            // bandCol уже премультиплицирован на альфу полосы, поэтому
            // домножать надо ТОЛЬКО на покрытие (cov), а не ещё раз на a/255:
            // двойное домножение затемняло цвет (синий #1fb6ff выходил #1479a9).
            int xo = wx * 4;
            for (int y = 0; y < fh; y++)
            {
                int o = y * stride + xo;
                int sc = (si != 0 && (y % si) == si - 1) ? (cov * 2) / 5 : cov;
                if (sc == 0)
                {
                    surface[o] = surface[o + 1] = surface[o + 2] = surface[o + 3] = 0;
                }
                else if (sc == 255)
                {
                    surface[o] = (byte)bB;
                    surface[o + 1] = (byte)bG;
                    surface[o + 2] = (byte)bR;
                    surface[o + 3] = (byte)bA;
                }
                else
                {
                    surface[o] = (byte)((bB * sc) / 255);
                    surface[o + 1] = (byte)((bG * sc) / 255);
                    surface[o + 2] = (byte)((bR * sc) / 255);
                    surface[o + 3] = (byte)((bA * sc + 127) / 255);
                }
            }
        }
        uiXF = x;
        Marshal.Copy(surface, 0, dibBits, surface.Length);
    }

    // Колонка прозрачности.  Подложки из фона темы больше нет: полупрозрачная
    // полоса идёт прямо по странице, которую сменяет, — так она и читается
    // "свипом темы", а не вторым окном поверх сайта.
    private void ClearCol(int wx, int stride)
    {
        if (wx < 0 || wx >= fw) return;
        int xo = wx * 4;
        for (int y = 0; y < fh; y++)
        {
            int o = y * stride + xo;
            surface[o] = surface[o + 1] = surface[o + 2] = surface[o + 3] = 0;
        }
    }

    // Пиксель композита прямо на экране (DWM + layered): доказывает, что
    // поверхность действительно видна, а не только собрана в памяти.
    private static string SampleScreen(int sx, int sy)
    {
        IntPtr dc = GetDC(IntPtr.Zero);
        try { return "0x" + GetPixel(dc, sx, sy).ToString("x8"); }
        catch { return "err"; }
        finally { ReleaseDC(IntPtr.Zero, dc); }
    }
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("gdi32.dll")] private static extern uint GetPixel(IntPtr dc, int x, int y);

    private static double Smooth(double u)
    {
        u = Math.Clamp(u, 0, 1);
        return u * u * (3 - 2 * u);
    }

    // Симметричный easeInOut: полоса разгоняется и тормозит как жест ладони;
    // e = 0.5 достигается ровно на половине времени — точка подмены.
    private static double EaseInOutCubic(double t)
        => t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;

    private void FreeSurface()
    {
        if (memDc != IntPtr.Zero)
        {
            if (oldObj != IntPtr.Zero) { SelectObject(memDc, oldObj); oldObj = IntPtr.Zero; }
            DeleteDC(memDc);
            memDc = IntPtr.Zero;
        }
        if (dib != IntPtr.Zero) { DeleteObject(dib); dib = IntPtr.Zero; dibBits = IntPtr.Zero; }
        surface = null;
        // bandCol здесь НЕ обнуляется: порядок «BuildBand → BuildSurface» в
        // свипе означал бы null-полосу в первом кадре.  Сброс — только через
        // bandColor, по которому и проверяется кэш.
    }
}
