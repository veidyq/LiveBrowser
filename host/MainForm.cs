using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LiveBrowser;

/// <summary>
/// Frameless main window.  The shell page (UI) fills the window and draws its
/// own title/tab bar; every real site gets its own WebView2 child that covers
/// the content area below the bar while active.  UI <-> host talk through
/// postMessage (UI -> host) and PostWebMessageAsJson (host -> UI).
///
/// Message contract (UI -> host, JSON via window.chrome.webview.postMessage):
///   {"type":"open","url":...,"label":...}  open url, new tab if not open
///   {"type":"activate","id":...}           switch tab
///   {"type":"close","id":...}              close tab
///   {"type":"reopen"}                      reopen the last closed site tab
///                                          (Ctrl+Shift+T while the shell,
///                                          id 0, has the focus)
///   {"type":"nav","action":"back|forward|reload"}
///   {"type":"theme","theme":<json string>} persist theme.json
///   {"type":"newwin"}                      second window sharing the profile
///   {"type":"drag"} {"type":"mini"} {"type":"maxi"} {"type":"closeapp"}
///   {"type":"suggests","open":...,"l","t","w","h" (css px),"items":[...],
///    "active":N,"query":...}               show/hide the native dropdown
///                                          layer (panelView) over a site
///   {"type":"menu","open":...,"l","t","w","h" (css px),"mode":...,
///    "index":N,"palettes":[accent,...]}    the gear search menu in panelView
///                                          over a site (same layer as
///                                          suggests, so they exclude each
///                                          other)
///    {"type":"menu","open":true,...,
///     "items":[{label,danger,disabled,sep},...]}
///                                          a generic shell menu (burger
///                                          «Ещё», context, recently
///                                          closed) in panelView; picks
///                                          come back as menu-pick
///                                          action:"item" with the index
///                                          into items (seps included)
///   {"type":"download-cmd","id":N,"cmd":"pause|resume|cancel|open|show"}
///                                          drive a DownloadManager item
///   {"type":"translate-text","id":N}
///                                          the user pressed "Перевести": the
///                                          site page answers {"type":
///                                          "site-text",text} via the bridge
///   {"type":"translate-dismiss","id":N,"url":...}
///                                          the translate offer was closed /
///                                          used: never offer this page again
///
/// Host -> UI events, dispatched via PostWebMessageAsJson:
///   {"type":"tabs","tabs":[...],"activeId":...}
///   {"type":"nav","id":...,"canBack":...,"canForward":...,"loading":...}
///   {"type":"suggest-pick","value":...}    a row was picked in panelView
///   {"type":"menu-pick","action":"palette|mode|settings|item","index":N}
///                                          a menu item was picked in
///                                          panelView (shell re-opens or
///                                          closes the menu; "item" is a
///                                          generic items row run by the
///                                          shell's LiveMenu.runItem)
///   {"type":"progress","id":N,"phase":"start"|"done"}  site navigation
///   {"type":"download","item":{id,url,name,path,received,total,state,speed}}
///                                          download created / ticking /
///                                          paused / done / canceled / errored
///   {"type":"toast","text":...}            a download just finished
///   {"type":"translate-offer","id":N,"url":...}
///                                          the page language looks foreign:
///                                          the shell may show its translate bar
///
/// panelView (dropdown.html) <-> host:
///   host -> panel: {"items":[...],"active":N,"query":...,"mode":"dark|light"}
///                  / {"menu":true,"mode":...,"isLight":...,"index":N,
///                     "palettes":[...]}
///                  / {"menu":true,"items":[{label,danger,disabled,sep},...]}
///   panel -> host: {"type":"panel-ready"} / {"type":"pick","value":...}
///                  / {"type":"menu-pick","action":...,"index":N}
/// </summary>
internal sealed partial class MainForm : Form
{
    // One environment for the whole process: every window shares the profile.
    private static Task<CoreWebView2Environment> envTask;
    // The private window's environment: a different user-data folder means a
    // different environment object, so it cannot share the cached envTask.
    private static Task<CoreWebView2Environment> privateEnvTask;

    // System-wide diagnostics switch: LIVEBROWSER_DEBUG=1 turns on DevTools,
    // probe logs and the /api/debug endpoint.
    private static readonly bool DebugMode = Environment.GetEnvironmentVariable("LIVEBROWSER_DEBUG") == "1";

    private int BarHeight; // device px kept free for the shell bar
    // Вертикальные вкладки: полоса шелла занимает колонку слева, сайт
    // начинается правее неё.  Флаг читается из settings.json при старте;
    // тумблера и горячей клавиши у него больше нет, так что включить режим
    // можно только правкой файла вручную.  Отрисовка осталась: шелл узнаёт о
    // режиме пушем, а сами вкладки — его DOM.
    private bool verticalTabs;
    // Ширина колонки в CSS px: tabs.js держит её в одной константе с CSS
    // (--vtabs-w).  Раскладка сайта считается из этой же величины.
    private const int VerticalTabsCssWidth = 260;
    private int SideWidth;  // device px kept free on the left in vertical mode
    // Фокус-режим (F11): полоса уезжает, сайт занимает всю клиентскую область.
    // Esc/F11 возвращают.  Флаг держит хост — раскладка вьюх пересчитывается
    // из него, а шелл получает push "focus-mode" для своей анимации.
    private bool focusMode;
    private WebView2 ui;                       // the shell page (id 0 = home)
    // Native suggestion-dropdown layer (shell/dropdown.html).  It floats
    // ABOVE the active site and BELOW the ui bar while the omnibox is open
    // on a site tab; transparency between sibling HWNDs does not work, so
    // the shell cannot draw the dropdown itself there.
    private WebView2 panelView;
    private bool panelReady; // dropdown.html has loaded and announced itself
    private readonly List<TabPage> tabs = new();
    private Curtain curtain;               // «штора» при смене вкладки (лениво)
    private System.Drawing.Color accentColor = System.Drawing.Color.FromArgb(0x5E, 0x6A, 0xD2);
    // Вторичный цвет палитры (accentSoft из шелла) — циановая кромка шторы в cyber.
    private System.Drawing.Color accentColor2 = System.Drawing.Color.FromArgb(0x5E, 0x6A, 0xD2);
    // Активна тема Night City: окно/вьюхи чёрные (#0a0a0a), шторка резкая.
    // Custom error card: the theme-aware page in ShowErrorPage.
    private const bool ShowCustomErrorPages = true;
    private bool cyberTheme;
    private readonly Dictionary<int, WebView2> views = new();
    // Popups a site opened (window.open / target=_blank) become ordinary
    // tabs; parentId -> child tab ids so they die with their parent.
    private readonly Dictionary<int, List<int>> popupChildren = new();
    // The most recently closed site tab {url,label}, for Ctrl+Shift+T /
    // bridge "reopen".  null after it has been reopened.
    private (string Url, string Label)? lastClosed;
    private int activeId;
    private int seq = 1;
    private CoreWebView2Environment env;
    private bool closing;
    // InitAsync reached its end: the shell and its panel view are up.  The
    // probe waits on this instead of inferring "loaded" from a source string.
    private volatile bool initDone;
    // Сохранённые вкладки, ждущие ответа «Восстановить?» после сбоя.
    private string[] pendingSessionUrls;
    // CSS px of page that the shell wants uncovered under the bar (the
    // suggestion panel).  The active site view starts below that instead of
    // under the bar, so dropdowns are never hidden by the native view.
    private int overlayCss;
    // What the shell's theme sheet says.  The window frame and the page
    // background behind every site view follow it, so a light shell never
    // sits inside a dark window with dark flashes on tab switches.
    private bool darkTheme = true;
    // Сырой cyber-флаг последнего акцента/темы от шелла; cyberTheme — всегда
    // производная accentCyber && darkTheme (см. ApplyThemeMode).
    private bool accentCyber;
    // Live site views are capped (QA C1: 20 rapid "open" messages created 20
    // WebView2s and none was disposed).  24 leaves room for the 20 restored
    // session tabs plus a few popups; beyond that the user gets a toast.
    private const int MaxLiveViews = 24;
    // Inactive views older than this are suspended by CoreWebView2 (they keep
    // their page but release the renderer's CPU/memory), unless the shell
    // turned backgroundSuspend off in settings.json.
    private static readonly TimeSpan SuspendAfter = TimeSpan.FromMinutes(3);
    // tab id -> when it last became active; drives the suspend sweep.
    private readonly Dictionary<int, DateTime> lastActive = new();
    private readonly HashSet<int> suspended = new();
    private System.Windows.Forms.Timer suspendTimer;
    private static readonly Color DarkBg = Color.FromArgb(18, 16, 28);
    private static readonly Color LightBg = Color.FromArgb(238, 241, 247);
    // Night City: фон нативных вьюх и рамки окна — без белых вспышек.
    private static readonly Color CyberBg = Color.FromArgb(10, 10, 10);

    public MainForm() : this(false) { }

    // A private window shares the shell and the keyboard paths with the normal
    // one, so it is the same form with three switches flipped: its own profile
    // folder, no session/history bookkeeping, and a wipe when it closes.  A
    // copy-pasted second window class would drift from the real one within a
    // week, which is the actual risk with private mode (one forgotten write
    // and the promise is a lie).
    private readonly bool privateMode;
    // Set for the probe's private window: it must be created and exercised
    // without being shown, because the user's desktop is off limits.
    private readonly bool headlessMode;

    public MainForm(bool isPrivate) : this(isPrivate, false) { }

    // headless is used by the probe: the private window must be exercised
    // without ever raising it on the user's desktop.
    public MainForm(bool isPrivate, bool headless)
    {
        privateMode = isPrivate;
        headlessMode = headless;
        ShellApi.PrivateModeRequested = privateMode;
        // Read before the first layout pass: the very first site view must
        // already start beside the column, not jump sideways a frame later.
        try { verticalTabs = SettingsStore.VerticalTabs(); } catch { }
        if (privateMode) lock (privateGate) privateWindowsOpen++;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(880, 600);
        BackColor = DarkBg;
        Size = new Size(1280, 820);
            Text = "LiveBrowser";
        Icon = LoadIcon();
        // Start in the mode the shell saved last time, before the first frame,
        // so the window never opens dark and then flips light.
        darkTheme = SavedThemeIsLight() == false;
        Color savedAccent = default, savedAccent2 = default;
        // Same invariant as ApplyThemeMode: cyber look = raw flag AND dark.
        accentCyber = SavedThemeIsCyber(out savedAccent, out savedAccent2);
        cyberTheme = accentCyber && darkTheme;
        if (cyberTheme)
        {
            accentColor = savedAccent;
            accentColor2 = savedAccent2;
        }
        BackColor = ThemeBg;

        // Every open window receives download pushes (multi-window aware).
        DownloadManager.RegisterSink(this);

        var saved = WindowStateStore.Load();
        // Two windows share one window.json: a private window must not write
        // its own geometry over the layout of the real one.
        if (!privateMode && saved != null && saved.W >= MinimumSize.Width && saved.H >= MinimumSize.Height)
        {
            Bounds = WindowStateStore.ClampToScreens(new Rectangle(saved.X, saved.Y, saved.W, saved.H));
            if (saved.Max) WindowState = FormWindowState.Maximized;
        }

        Shown += async (_, _) => await InitAsync();
        // Headless (probe) window: no window is ever raised, but the shell
        // still needs its Shown pass to build the views.
        if (headlessMode)
            HandleCreated += (_, _) => BeginInvoke(new Action(async () => await InitAsync()));
        HandleCreated += (_, _) => Win.Style(Handle, BackColor, darkTheme);
        ResizeBegin += (_, _) => LayoutSiteViews();
        Resize += (_, _) => LayoutSiteViews();
        DpiChanged += (_, _) => { MaximizedBounds = Screen.FromControl(this).WorkingArea; LayoutSiteViews(); };
        FormClosing += (_, _) =>
        {
            closing = true;
            if (privateMode) _ = Task.Run(ClearPrivateProfileAsync);
            // Stop pushing here; if this was the last open window, pause every
            // running download so the next start finds them resumable
            // (leftover "downloading" rows in downloads.json are re-read as
            // paused).  Closing a secondary window keeps downloads running.
            DownloadManager.WindowClosing(this);
            // The suspend sweep must not fire into views being torn down.
            try { suspendTimer?.Stop(); } catch { }
            suspendTimer = null;
            // Save from the live views first: a tab closed mid-navigation
            // still has the old Url in its model.
            foreach (var t in tabs.ToList())
                try { if (t.View?.CoreWebView2 != null && IsNavigable(t.View.CoreWebView2.Source)) t.Url = t.View.CoreWebView2.Source; }
                catch { }
            // A private window must not leave its tabs behind for "restore
            // tabs?" on the next start — that would hand the session to a
            // later, non-private run.
            if (!privateMode) SessionStore.Save(tabs);
            // Штатный выход: снимаем маркер «мог упасть», который ставит
            // Program.Main.  Если процесс убили/он упал, файл останется — на
            // следующем старте RestoreSessionAsync спросит «Восстановить?».
            try { if (!privateMode) SessionStore.MarkCleanExit(); } catch { }
            if (!privateMode) WindowStateStore.Save(this);
            // `ui` is also tabs[0], so disposing every tab covers the shell
            // page too; without it msedgewebview2.exe lingers after exit.
            // A snapshot, because disposing a view runs its Closed handlers,
            // and those may still touch the tab list while it is enumerated.
            foreach (var t in tabs.ToList())
            {
                try { t.View?.CoreWebView2?.Stop(); } catch { }
                t.Dispose();
            }
            foreach (var v in views.Values) { try { v.CoreWebView2?.Stop(); v.Dispose(); } catch { } }
            views.Clear();
            suspended.Clear();
            lastActive.Clear();
            tabs.Clear();
            // The dropdown layer is not a tab: dispose it separately.
            try { panelView?.Dispose(); } catch { }
            panelView = null;
            panelReady = false;
            // Last window: rewrite history.jsonl compacted (deduplicated by
            // url) so the next start loads fast.  A private window never
            // touches the file it never wrote to.
            if (!privateMode) History.Flush();
            // CoreWebView2Environment is a COM wrapper owned by the views;
            // tearing it down here would be a second release.
            env = null;
            ShellApi.ActiveUrl = "";
        };
    }

    // The exe carries app.ico (csproj ApplicationIcon); pull it back out so
    // the taskbar, Alt+Tab and the window itself show it too.
    // theme.json is tiny and optional; a broken file just means "dark".
    private static bool? SavedThemeIsLight()
    {
        try
        {
            if (!File.Exists(AppPaths.ThemeFile)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(AppPaths.ThemeFile));
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty("mode", out var m) && m.ValueKind == JsonValueKind.String)
                return m.GetString() == "light";
            return null;
        }
        catch { return null; }
    }

    // theme.json от Night City: палитра cyber и только при тёмном режиме
    // (тема тёмная по замыслу; light — обычная светлая).
    private static bool SavedThemeIsCyber(out Color first, out Color second)
    {
        first = Color.FromArgb(0xFC, 0xEE, 0x09);
        second = Color.FromArgb(0x00, 0xF0, 0xFF);
        try
        {
            if (!File.Exists(AppPaths.ThemeFile)) return false;
            using var doc = JsonDocument.Parse(File.ReadAllText(AppPaths.ThemeFile));
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return false;
            if (r.TryGetProperty("mode", out var m) && m.ValueKind == JsonValueKind.String &&
                m.GetString() == "light") return false;
            if (!r.TryGetProperty("cyber", out var c) || c.ValueKind != JsonValueKind.True) return false;
            if (r.TryGetProperty("accent", out var a) && a.ValueKind == JsonValueKind.String)
                TryParseHexColor(a.GetString(), out first);
            if (r.TryGetProperty("accentSoft", out var a2) && a2.ValueKind == JsonValueKind.String)
                TryParseHexColor(a2.GetString(), out second);
            return true;
        }
        catch { return false; }
    }

    // Фон окна / нативных вьюх по текущей теме (cyber имеет приоритет).
    private Color ThemeBg => cyberTheme ? CyberBg : darkTheme ? DarkBg : LightBg;

    // Окно берёт кадры прямо из host/app.ico, а не через
    // ExtractAssociatedIcon: тот всегда отдаёт 32 px, и на 200 % DPI
    // заголовок показывает растянутую копию.  Свой загрузчик знает, что
    // System.Drawing не умеет PNG-кадры в .ico (наш их и не содержит) и
    // выбирает кадр под масштаб экрана.
    private static Icon LoadIcon()
    {
        try { return AppIcon.Load(Application.ExecutablePath); }
        catch { return null; }
    }

    /* ---------------------------------------------------------- */
    /* Init                                                         */
    /* ---------------------------------------------------------- */

    private static Task<CoreWebView2Environment> GetEnvAsync()
    {
        // «Использовать кеш» из раздела Оптимизация: выключено — профиль
        // уходит в профиль-сессию (тот же вход, но кеш и куки не переживают
        // выход); включено — обычный persistent profile\ с кешем страниц.
        string folder = AppPaths.ProfileDir;
        try { if (!SettingsStore.UseCache()) folder = AppPaths.ProfileDir + "-ephemeral"; }
        catch { }
        return envTask ??= CoreWebView2Environment.CreateAsync(null, folder, BuildOptions());
    }

    // Private windows: a folder of their own, wiped when the last private
    // window closes.  Reusing the normal profile would leak the session into
    // it; reusing the "-ephemeral" folder would collide with the caching
    // switch (two environments, one folder — the runtime refuses that).
    private static Task<CoreWebView2Environment> GetPrivateEnvAsync()
    {
        var folder = AppPaths.ProfileDir + "-private";
        return privateEnvTask ??= CoreWebView2Environment.CreateAsync(null, folder, BuildOptions());
    }

    // How many private windows are open right now.  The folder is deleted only
    // when this reaches zero, otherwise a second private window would lose the
    // profile (cookies, logins) under its own feet.
    private static int privateWindowsOpen;
    private static readonly object privateGate = new();

    // Deleting the folder is what makes the promise real: closing the window
    // is not "clearing the cache", it is removing every byte of the session.
    // It is *deferred* on purpose: FormClosing still holds the views, so a
    // wipe started there would race the runtime releasing the files.  The
    // delay lets the renderers exit; a positive verdict is published on
    // privateCleared so the probe can wait for the outcome instead of polling
    // the folder itself.
    private static int privateClearsRunning;
    internal static volatile bool privateCleared;

    private static async Task ClearPrivateProfileAsync()
    {
        lock (privateGate) { if (--privateWindowsOpen > 0) return; }
        var dir = AppPaths.ProfileDir + "-private";
        Interlocked.Increment(ref privateClearsRunning);
        DebugLog("private: wipe started (" + dir + ")");
        try
        {
            await Task.Delay(1200);
            for (var attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    if (!Directory.Exists(dir)) { privateCleared = true; DebugLog("private: nothing to wipe"); return; }
                    Directory.Delete(dir, true);
                    privateCleared = true;
                    DebugLog("private: profile cleared");
                    return;                }
                catch (Exception ex)
                {
                    // Files still held by the exiting renderers: retry shortly.
                    if (attempt % 5 == 4)
                        DebugLog("private: delete attempt " + (attempt + 1) + " failed (" + ex.GetType().Name
                            + ": " + ex.Message + ")");
                    await Task.Delay(500);
                }
            }
            DebugLog("private: profile could not be fully removed (" + dir + ")");
        }
        catch (Exception ex) { DebugLog("private: wipe crashed (" + ex.GetType().Name + ": " + ex.Message + ")"); }
        finally { Interlocked.Decrement(ref privateClearsRunning); }
    }

    private static CoreWebView2EnvironmentOptions BuildOptions()
    {
        var opts = new CoreWebView2EnvironmentOptions("--lang=ru-RU",
            "--disable-features=msWebOOUI,msPdfOOUI");
        opts.AdditionalBrowserArguments += " --disable-sync --password-store=basic";
        // Cap the caches so profile\ does not grow without bound (256 MB disk,
        // 64 MB media).  Deliberately nothing else by default: --disable-gpu
        // would break the shell's blur/aurora rendering and the curtain, and
        // the back-forward cache is left to the runtime's defaults.
        opts.AdditionalBrowserArguments += " --disk-cache-size=268435456 --media-cache-size=67108864";
        // Тумблер "Аппаратное ускорение" в разделе Оптимизация: GPU выключает
        // только явный отказ пользователя (по умолчанию — как раньше).
        // backgroundBlur хост не трогает: размытие гасит сам shell.
        var accel = true;
        try { accel = SettingsStore.HardwareAccel(); } catch { }
        if (!accel)
        {
            opts.AdditionalBrowserArguments += " --disable-gpu";
            DebugLog("options: hardwareAccel=false -> --disable-gpu");
        }
        if (Environment.GetEnvironmentVariable("LIVEBROWSER_CDP") == "1") opts.AdditionalBrowserArguments += " --remote-debugging-port=9333"; //QA-TEMP
        return opts;
    }

    private async Task InitAsync()
    {
        try
        {
            env = privateMode ? await GetPrivateEnvAsync() : await GetEnvAsync();

            // A maximized borderless window covers the taskbar unless its max
            // size is clamped to the working area.
            MaximizedBounds = Screen.FromControl(this).WorkingArea;

            ui = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(ui);
            ui.BringToFront();
            await ui.EnsureCoreWebView2Async(env);
            ApplyViewBackground(ui);

            ui.CoreWebView2.Settings.IsStatusBarEnabled = false;
            ui.CoreWebView2.Settings.AreDefaultContextMenusEnabled = DebugMode;
            ui.CoreWebView2.Settings.AreDevToolsEnabled = DebugMode;
            ui.CoreWebView2.Settings.IsWebMessageEnabled = true; // the bridge

            ui.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "livebrowser.shell", AppPaths.ShellDir,
                CoreWebView2HostResourceAccessKind.Allow);

            // Static shell files are served by the virtual host mapping; only
            // /api/* is intercepted here (suggest relay + theme persist).
            // api.* lives on a second, unmapped host so WebView2 never answers
            // it itself; one subscription covers both filters (subscribing
            // twice would run the handler twice per request).
            ui.CoreWebView2.AddWebResourceRequestedFilter(
                "https://livebrowser.shell/*", CoreWebView2WebResourceContext.All);
            ui.CoreWebView2.AddWebResourceRequestedFilter(
                "https://api.livebrowser.shell/*", CoreWebView2WebResourceContext.All);
            ui.CoreWebView2.WebResourceRequested += OnUiResourceRequested;

            ui.CoreWebView2.WebMessageReceived += OnUiMessage;
            var hook = (Environment.GetEnvironmentVariable("LIVEBROWSER_PROBE") == "1")
                       || (Environment.GetEnvironmentVariable("LIVEBROWSER_SELFTEST") == "1");
            if (hook)
                await ui.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                    "window.__errs=[];addEventListener('error',function(e){window.__errs.push(String(e.message)+' @ '+e.filename+':'+e.lineno);},true);" +
                    "addEventListener('unhandledrejection',function(e){window.__errs.push('REJ '+e.reason);});");
            ui.CoreWebView2.NavigationCompleted += (_, e) =>
            {
                DebugLog($"UI nav completed success={e.IsSuccess} status={e.WebErrorStatus}");
                // Smoke test hook: раньше здесь жил старый ProbeAsync (внешняя
                // сеть/погода), он конфликтовал с диалогом восстановления
                // в живом профиле.  Всё нужное теперь делает RunShellProbeAsync
                // по сообщению "ready" (см. case "ready").
                if (Environment.GetEnvironmentVariable("LIVEBROWSER_PROBE") != "1")
                    _ = Shelleness(ui);
                // Probe mode logs the page's uncaught errors too (registered
                // on every document already).
                if (Environment.GetEnvironmentVariable("LIVEBROWSER_PROBE") == "1" ||
                    Environment.GetEnvironmentVariable("LIVEBROWSER_SELFTEST") == "1")
                    _ = Task.Delay(5000).ContinueWith(_ => _ = ShellErrorsAsync());
            };
            // A site asking for "a new window" from the shell itself (a link
            // target=_blank inside the NTP, if any) becomes a tab.
            ui.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (!string.IsNullOrEmpty(e.Uri)) OpenTab(e.Uri, null);
            };
            // The shell must never navigate away from itself: reroute links as tabs.
            ui.CoreWebView2.NavigationStarting += (_, e) =>
            {
                if (closing || !e.Uri.StartsWith("https://livebrowser.shell/"))
                {
                    e.Cancel = true;
                    if (!closing && IsNavigable(e.Uri))
                        OpenTab(e.Uri, null);
                }
            };

            // The UI always lives on the real host name: api.* devirtualizes
            // the adjacent shell host name when it is served over HTTP.
            var home = new TabPage { Id = 0, Title = "Рабочий стол", Url = AppPaths.ShellUrl, View = ui, Ready = true };
            tabs.Add(home);
            activeId = 0;
            // Файлы шелла отдаёт виртуальный хост БЕЗ Cache-Control — Chromium
            // кеширует их по эвристике, и после пересборки вьюхи грузили СТАРЫЙ
            // html/js: «чёрные уголки» меню = непрозрачный html старого
            // dropdown.html, «не работают кнопки» = старый dropdown.js.
            // Кеш профиля чистится на каждом старте: он больше никогда не
            // старше кода на диске.  Куки и сайт-данные не трогаем.
            try { await ui.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache); }
            catch { /* нет кеша — не критично */ }
            ui.CoreWebView2.Navigate(AppPaths.ShellUrl);

            // The suggestion-dropdown layer: created before any site tab so
            // the base z-order is already sites < panel < bar (LayoutSiteViews
            // re-asserts it on every pass).  Opaque background like the sites
            // (ApplyViewBackground) — this view must show its own card, not
            // the form's BackColor, and never pretend to be transparent.
            panelView = new WebView2 { Dock = DockStyle.None };
            Controls.Add(panelView);
            HidePanelLayer();
            await panelView.EnsureCoreWebView2Async(env);
            ApplyViewBackground(panelView);
            panelView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            panelView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            panelView.CoreWebView2.Settings.AreDevToolsEnabled = DebugMode;
            panelView.CoreWebView2.Settings.IsWebMessageEnabled = true; // pick bridge
            panelView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "livebrowser.shell", AppPaths.ShellDir,
                CoreWebView2HostResourceAccessKind.Allow);
            panelView.CoreWebView2.WebMessageReceived += OnPanelMessage;
            panelView.CoreWebView2.Navigate("https://livebrowser.shell/dropdown.html");

            // All views share this profile: hand it to the privacy endpoints
            // (cookies / ClearBrowsingData) and to the suspend sweep.
            DataStore.AttachController(ui.CoreWebView2);

            // Фон больше не считается «стеклом, которое нечем прочитать»:
            // при выключенном аппаратном ускорении (или без доступного GPU)
            // включаем упрощённый режим — без тяжёлых blur(36px) под стеклом,
            // которые при программной отрисовке стоят десятки процентов.
            if (!SettingsStore.HardwareAccel())
                await ui.CoreWebView2.ExecuteScriptAsync(
                    "document.documentElement.classList.add('no-gpu')");

            // «Оптимизация» в настройках живёт в settings.json; шелл узнаёт
            // текущие значения сразу при старте, не дожидаясь открытия
            // страницы настроек (иначе no-blur/кеш включались бы только
            // после визита в настройки).
            try
            {
                bool blur = true, suspend = true;
                try { blur = SettingsStore.BackgroundBlur(); } catch { }
                try { suspend = SettingsStore.BackgroundSuspend(); } catch { }
                Push(new { type = "optimize", backgroundBlur = blur, backgroundSuspend = suspend });
            }
            catch { }

            // "Restore tabs?" belongs to the normal session.  A private window
            // opens on its own empty desktop: offering the previous session
            // there would mix the two.
            if (!privateMode) await RestoreSessionAsync();
            else Push(new { type = "private", on = true });

            // Background optimisation: suspend site views that have been
            // inactive for a while (1 min ticks, 3 min threshold).
            if (SettingsStore.BackgroundSuspend())
            {
                suspendTimer = new System.Windows.Forms.Timer { Interval = 60 * 1000 };
                suspendTimer.Tick += (_, _) => SuspendIdleViews();
                suspendTimer.Start();
            }
            // History compaction timer (5 min) — independent of the views.
            History.StartTimer();
            initDone = true;
        }
        catch (Exception ex)
        {
            // "Resource busy" does not mean the runtime is missing: the profile
            // is still held by a previous instance.  Saying so saves the user
            // from reinstalling WebView2 to fix something a restart solves.
            bool busy = ex is InvalidOperationException
                && (ex.Message.Contains("0x800700AA") || ex.Message.Contains("resource is busy", StringComparison.OrdinalIgnoreCase));
            string head = busy
                ? "Профиль браузера занят другим запущенным экземпляром LiveBrowser."
                : "Не удалось запустить WebView2.";
            string tail = busy
                ? "Закройте все окна LiveBrowser и запустите снова."
                : "Для работы LiveBrowser нужен Microsoft Edge WebView2 Runtime.";
            MessageBox.Show(
                head + "\n\n" + ex.Message + "\n\n" + tail,
                "LiveBrowser", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.Exit(1);
        }
    }

    // Is the view showing a real page rather than the browser's own error
    // page?  Source is the same (the attempted url) in both cases and the tab
    // title survives too, so the only honest probe is the document: a live page
    // always has some text, a chrome error page has none.
    private static async Task<bool> HasRealDocumentAsync(Microsoft.Web.WebView2.Core.CoreWebView2 core)
    {
        if (core == null) return false;
        try
        {
            var json = await core.ExecuteScriptAsync("(document.body&&document.body.innerText?document.body.innerText:'').length");
            return json != null && int.TryParse(json.Trim('"'), out var n) && n > 20;
        }
        catch { return false; }
    }

    // Only real web pages belong in a site view.  javascript: / data: / file:
    // typed or handed over by a page would run inside the site context with
    // local-file access, so they are refused at the door.  The single exception
    // is the probe's own local fixtures (dist/_sc, dist/_heavy): the stress and
    // scroll checks need a page that costs nothing on the network, and they may
    // only reach those two folders — never the filesystem in general.
    private static bool IsNavigable(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps) return true;
        if (u.Scheme != Uri.UriSchemeFile) return false;
        if (Environment.GetEnvironmentVariable("LIVEBROWSER_PROBE") != "1") return false;
        var root = Path.GetFullPath(AppPaths.Root);
        var path = Path.GetFullPath(u.LocalPath);
        foreach (var dir in new[] { "_sc", "_heavy", "_ads" })
        {
            var want = Path.Combine(root, dir) + Path.DirectorySeparatorChar;
            if (path.StartsWith(want, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private async Task RestoreSessionAsync()
    {
        var urls = SessionStore.Load();
        // Аварийное завершение (маркер с прошлого старта не снят): не открываем
        // вкладки молча — спрашиваем.  Ответ приходит мостом "session-answer".
        if (SessionStore.CrashedLastTime() && urls.Length > 0)
        {
            pendingSessionUrls = urls;
            Push(new { type = "session-restore", count = urls.Length });
            return;
        }
        foreach (var url in urls)
        {
            if (!IsNavigable(url)) continue;
            try { await OpenAsync(url, null); } catch { }
        }
        if (views.Count > 0) Activate(tabs[tabs.Count - 1].Id);
    }

    // Вопрос «Восстановить вкладки?» после сбоя: accepted — открываем
    // сохранённый список по порядку, иначе сессия просто остаётся на диске
    // (дальше её перезапишет обычный выход).
    private async Task AnswerSessionRestoreAsync(bool accepted)
    {
        var urls = pendingSessionUrls;
        pendingSessionUrls = null;
        if (!accepted || urls == null) return;
        foreach (var url in urls)
        {
            if (!IsNavigable(url)) continue;
            try { await OpenAsync(url, null); } catch { }
        }
        if (views.Count > 0) Activate(tabs[tabs.Count - 1].Id);
    }

    // Window-level shortcuts.  With the shell page focused the form owns the
    // keyboard and this is the only entry point; with a site focused the key
    // usually goes to Chromium and the injected listener answers instead.
    // Both roads end in the same Hotkeys table + Execute, so a key cannot
    // work in one place and be dead in the other.
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (msg.Msg != WM_KEYDOWN && msg.Msg != WM_SYSKEYDOWN) return base.ProcessCmdKey(ref msg, keyData);

        var mods = keyData & Keys.Modifiers;
        bool ctrl = (mods & Keys.Control) != 0;
        bool shift = (mods & Keys.Shift) != 0;
        bool alt = (mods & Keys.Alt) != 0;
        // Only the bare key code: Keys.Control|Keys.L (0x40004C) compares
        // equal to Keys.L, and the modifiers are already read above.
        var code = (Keys)(keyData & Keys.KeyCode);
        var cmd = Hotkeys.Map(code.ToString(), ctrl, shift, alt, focusMode);
        if (cmd == Hotkeys.Cmd.None) return base.ProcessCmdKey(ref msg, keyData);

        // Ctrl+W on the home tab must not close the window: the shell owns
        // that key and handles it itself (tabs.js), so let it through.
        if (cmd == Hotkeys.Cmd.CloseTab && activeId == 0)
            return base.ProcessCmdKey(ref msg, keyData);

        return Execute(cmd, Current, activeId != 0 ? SiteViewOrNull(activeId) : null)
            || base.ProcessCmdKey(ref msg, keyData);
    }

    private WebView2 SiteViewOrNull(int id)
        => views.TryGetValue(id, out var v) && v != null && !v.IsDisposed && v.CoreWebView2 != null ? v : null;

    // Every window launch goes through these two so the probe can count what
    // opened without the keyboard or the menu being real.
    internal static int WindowsOpened;
    internal static int PrivateWindowsOpened;

    private static void OpenNormalWindow()
    {
        Interlocked.Increment(ref WindowsOpened);
        new MainForm().Show();
    }

    private static void OpenPrivateWindow()
    {
        Interlocked.Increment(ref PrivateWindowsOpened);
        new MainForm(isPrivate: true).Show();
    }

    // Keyboard shortcuts while a site tab has focus (see wire comment above).
    // WinForms KeyDown only fires when the site view itself has the Windows
    // focus (not when the page has it — then the injected listener below is
    // the one that sees the key), but both feed the same Hotkeys table.
    private void HandleSiteKey(WebView2 view, TabPage page, KeyEventArgs ev)
    {
        if (closing || page == null || !page.Alive) return;
        var cmd = Hotkeys.Map(ev.KeyCode.ToString(), ev.Control, ev.Shift, ev.Alt, focusMode);
        if (cmd == Hotkeys.Cmd.None) return;
        ev.Handled = Execute(cmd, page, view);
    }

    /// <summary>
    /// The one place a shortcut does something.  <paramref name="page"/> is
    /// the tab the key was pressed in; when <paramref name="view"/> is null
    /// there is no site in front (window or shell focus) and page-level
    /// commands fall back to the current tab.
    /// </summary>
    private bool Execute(Hotkeys.Cmd cmd, TabPage page, WebView2 view)
    {
        if (cmd == Hotkeys.Cmd.None) return false;
        var pageNow = page ?? Current;
        var cv = view != null && !view.IsDisposed ? view.CoreWebView2
            : (pageNow != null && views.TryGetValue(pageNow.Id, out var v) && v != null && !v.IsDisposed)
                ? v.CoreWebView2 : null;
        switch (cmd)
        {
            case Hotkeys.Cmd.Omni:
            case Hotkeys.Cmd.Find:
                // Focus must cross two WebView2 HWNDs, so the ui view is
                // focused first; the shell page then owns the actual bar.
                if (ui != null && !ui.IsDisposed) ui.Focus();
                Push(new { type = cmd == Hotkeys.Cmd.Omni ? "omni" : "find-open" });
                return true;
            case Hotkeys.Cmd.Palette:
                if (ui != null && !ui.IsDisposed) ui.Focus();
                Push(new { type = "palette" });
                return true;
            case Hotkeys.Cmd.NewTab:
                // Ctrl+T is "home + omnibox": the shell does the same on its
                // own keydown, and its id-0 activation restores the bar.  The
                // WinForms focus still has to move to the ui view, exactly as
                // for Ctrl+L — otherwise the omnibox cursor sits in the page.
                ActivateAnimated(0);
                if (ui != null && !ui.IsDisposed) ui.Focus();
                Push(new { type = "omni" });
                return true;
            case Hotkeys.Cmd.CloseTab:
                if (pageNow != null && pageNow.Id != 0) { CloseTab(pageNow.Id); return true; }
                return false;   // the home tab (and the window) stay on Ctrl+W
            case Hotkeys.Cmd.ReopenTab:
                ReopenLastClosed();
                return true;
            case Hotkeys.Cmd.NewWindow:
                OpenNormalWindow();
                return true;
            case Hotkeys.Cmd.NewPrivate:
                OpenPrivateWindow();
                return true;
            case Hotkeys.Cmd.Reload:
                if (cv == null) return false;
                cv.Reload();
                return true;
            case Hotkeys.Cmd.NextTab:
            case Hotkeys.Cmd.PrevTab:
                CycleTab(cmd == Hotkeys.Cmd.NextTab ? 1 : -1);
                return true;
            case Hotkeys.Cmd.ZoomIn:
            case Hotkeys.Cmd.ZoomOut:
            case Hotkeys.Cmd.ZoomReset:
                if (pageNow == null || pageNow.Id == 0 || cv == null) return false;
                var z = view != null && !view.IsDisposed
                    ? view
                    : views.TryGetValue(pageNow.Id, out var zv) ? zv : null;
                if (z == null || z.IsDisposed) return false;
                z.ZoomFactor = cmd == Hotkeys.Cmd.ZoomIn ? Math.Min(3.0, z.ZoomFactor + 0.1)
                    : cmd == Hotkeys.Cmd.ZoomOut ? Math.Max(0.3, z.ZoomFactor - 0.1)
                    : 1.0;
                RememberZoom(z);
                return true;
            case Hotkeys.Cmd.Back:
                if (cv != null && cv.CanGoBack) { cv.GoBack(); return true; }
                return false;
            case Hotkeys.Cmd.Forward:
                if (cv != null && cv.CanGoForward) { cv.GoForward(); return true; }
                return false;
            case Hotkeys.Cmd.Print:
                if (cv == null) return false;
                try { _ = cv.ExecuteScriptAsync("window.print()"); } catch { }
                return true;
            case Hotkeys.Cmd.FocusMode:
                ToggleFocusMode();
                return true;
            case Hotkeys.Cmd.VerticalTabs:
                ToggleVerticalTabs();
                return true;
            case Hotkeys.Cmd.ExitFocus:
                if (!focusMode) return false;
                SetFocusMode(false);
                return true;
        }
        return false;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab over the tab list the strip shows (id 0 is
    // part of it: the home tab is reachable with the same key).
    private void CycleTab(int dir)
    {
        if (tabs.Count < 2) return;
        int i = tabs.FindIndex(t => t.Id == activeId);
        if (i < 0) i = 0;
        int n = tabs.Count;
        ActivateAnimated(tabs[((i + dir) % n + n) % n].Id);
    }

    // Runs in every site document (capture phase): reports shortcut keydowns
    // to the host, because with focus inside a WebView2 the host never sees
    // raw keys (ProcessCmdKey/KeyDown are bypassed by the browser pipeline).
    // Reported keys are exactly the ones the browser itself would otherwise
    // act on (tab switching, find bar, zoom…) — the host's Hotkeys table
    // decides what, if anything, they mean.  Ctrl+Tab has to be reported
    // before Chromium moves the (single) view to another tab, which would
    // leave the host switching to a tab the shell never showed.
    private const string SiteKeyScript =
        "window.addEventListener('keydown',function(e){" +
        "try{if(window.chrome&&window.chrome.webview){" +
        "window.chrome.webview.postMessage(JSON.stringify({type:'sitekey'," +
        "code:e.code,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey}));" +
        // Handled keys must not also reach Chromium: otherwise Ctrl+F opens
        // its own find bar behind ours and Ctrl+Tab moves the single view to
        // another tab.  Only for combos the host actually claims, so a page's
        // own Ctrl+Z etc. keep working.
        "if(window.__lbHot && window.__lbHot(e.code,e.ctrlKey,e.shiftKey,e.altKey))" +
        "{e.preventDefault();e.stopPropagation();}" +
        "}}catch(_){}},true);" +
        // Клик по сайту = «клик мимо» для панели подсказок, висящей над
        // сайтом.  Фокусный путь ненадёжен (клик может не менять фокус
        // ОС), поэтому сайт сам сообщает о нажатии — одно сообщение на
        // клик, дешевле любого наблюдателя.
        "window.addEventListener('pointerdown',function(e){" +
        "try{if(window.chrome&&window.chrome.webview){" +
        "window.chrome.webview.postMessage(JSON.stringify({type:'siteclick'}));}}catch(_){}},true);";

    // Тонкий «плавающий» скроллбар на сайтах: капсула с прозрачным треком.
    // Только CSS (никакого JS-колеса — тот урок усвоен): сайт, стилизующий
    // скроллбар сам, победит по порядку документа (наша <style> вставляется
    // раньше его стилей).  Гейт — «Тактильный отклик», как у scroll-behavior.
    private const string SiteScrollbarCss =
        "::-webkit-scrollbar{width:11px;height:11px}" +
        "::-webkit-scrollbar-track{background:transparent}" +
        "::-webkit-scrollbar-thumb{background:rgba(128,128,128,.42);" +
        "border-radius:8px;border:3px solid transparent;background-clip:content-box}" +
        "::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.62);" +
        "background-clip:content-box}" +
        "::-webkit-scrollbar-thumb:active{background:rgba(128,128,128,.72);" +
        "background-clip:content-box}" +
        "::-webkit-scrollbar-corner{background:transparent}";

    // Скрипт загрузки сайт-вьюхи = SiteKeyScript + «тактильные» надстройки.
    // scroll-behavior:smooth (только программные прокрутки/якоря; колесо
    // мыши остаётся нативному композитору — перехватывать его JS-ом мы
    // перестали принципиально) включается тумблером «Тактильный отклик».
    // Плюс fade-in первой отрисовки (тумблер «Анимации»): страница
    // проявляется за 180мс вместо «резкого включения» вьюхи.  Только
    // top-level документ — iframes не трогаем.
    // Поиск по странице: self-contained find в сайт-вьюхе.  window.find —
    // нативный Chromium-поиск с подсветкой выделением и автоскроллом;
    // __lbCount считает совпадения по innerText (приближённо, но честно для
    // бейджа «N совпадений»).  Инжектится ВСЕГДА (не гейтится тумблерами —
    // это базовая функция, а не декорация).
    private const string FindScript =
        "window.__lbFind=function(q,back){try{if(!q){window.getSelection().removeAllRanges();return 1;}" +
        "return window.find(q,false,!!back,true,false,false)?1:0;}catch(e){return -1;}};" +
        "window.__lbCount=function(q){try{if(!q)return 0;" +
        "var t=(document.body.innerText||'').toLowerCase(),s=q.toLowerCase(),n=0,i=0;" +
        "while((i=t.indexOf(s,i))>=0){n++;i+=Math.max(1,s.length);}return n;}catch(e){return 0;}};";

    // In-place перевод страницы: __lbTrans собирает уникальные текстовые
    // узлы (без script/style/code/pre), применяет пары «оригинал→перевод»
    // с сохранением оригинала и умеет откатывать.  Инжектится всегда.
    private const string TransScript =
        "window.__lbTrans=(function(){var saved=[],active=false;" +
        "function collect(){var out=[],seen=Object.create(null);" +
        "try{var w=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT,{acceptNode:function(n){" +
        "if(!n.nodeValue)return 2;var t=n.nodeValue.trim();if(t.length<3||t.length>600)return 2;" +
        "var p=n.parentElement;if(!p)return 2;var g=p.tagName;" +
        "if(g==='SCRIPT'||g==='STYLE'||g==='NOSCRIPT'||g==='TEXTAREA'||g==='CODE'||g==='PRE'||g==='INPUT')return 2;" +
        "return 1;}});while(w.nextNode()){var n=w.currentNode,t=n.nodeValue.trim();" +
        "if(!seen[t]){seen[t]=1;}out.push({n:n,t:t});}}catch(e){}return out;}" +
        "return {" +
        "texts:function(){var c=collect(),seen=Object.create(null),out=[];" +
        "for(var i=0;i<c.length;i++){var t=c[i].t;if(!seen[t]){seen[t]=1;out.push(t);}}return out;}," +
        "apply:function(pairs){try{var map=Object.create(null);" +
        "for(var i=0;i<pairs.length;i++){if(pairs[i]&&pairs[i].r)map[pairs[i].t]=pairs[i].r;}" +
        "var c=collect(),sw=0;for(var i=0;i<c.length;i++){var e=c[i],r=map[e.t];if(!r)continue;" +
        "if(!e.n.__lbOrig){e.n.__lbOrig=e.n.nodeValue;saved.push(e.n);}" +
        "e.n.nodeValue=e.n.nodeValue.replace(e.t,r);sw++;}active=true;return sw;}catch(e){return 0;}}," +
        "revert:function(){try{var k=0;for(var i=0;i<saved.length;i++){try{saved[i].nodeValue=saved[i].__lbOrig;k++;}catch(e){}}" +
        "saved=[];active=false;return k;}catch(e){return 0;}}," +
        "isActive:function(){return active;}" +
        "};})();";

    // Mirrors Hotkeys.Map for the injected listener: true = the host owns
    // this combo, the page must not also act on it.  Kept as a switch rather
    // than generated at runtime: the injection has to prove which keys it
    // claims (SHELLPROBE keys compares this against the C# table).
    private const string SiteClaimScript =
        "window.__lbHot=function(c,c1,s,a){if(c=='F11'||c=='F5'||c=='F6')return true;" +
        "if(a&&!c1&&!s)return c=='ArrowLeft'||c=='ArrowRight';" +
        "if(!c1||a)return false;" +
        "if(s)return c=='KeyT'||c=='Tab'||c=='KeyN'||c=='KeyE';" +
        "return c=='KeyL'||c=='KeyK'||c=='KeyF'||c=='KeyP'||c=='KeyW'||c=='KeyT'||" +
        "c=='KeyN'||c=='KeyR'||c=='Tab'||c=='Equal'||c=='Add'||c=='Minus'||" +
        "c=='Subtract'||c=='Digit0'||c=='Numpad0';};";

    private static string SiteBootScript()
    {
        string s = SiteKeyScript + SiteClaimScript;
        if (SettingsStore.Tactile())
        {
            s += "try{document.documentElement.style.scrollBehavior='smooth'}catch(_){}";
            // Скроллбар — <style> в head при создании документа: автор-уровень,
            // но до стилей сайта, поэтому сайт с собственным стилем скроллбара
            // выигрывает тай-брейк по порядку (наше = красивый дефолт).
            s += "try{(function(){var st=document.createElement('style');" +
                 "st.textContent='" + SiteScrollbarCss + "';" +
                 "(document.head||document.documentElement).appendChild(st);})()}catch(_){}";
        }
        if (SettingsStore.Animations())
            s += "try{(function(){if(window.top!==window)return;" +
                 "var d=document.documentElement;d.style.opacity='0';" +
                 "var go=function(){requestAnimationFrame(function(){" +
                 "d.style.transition='opacity .18s ease';d.style.opacity='1';});};" +
                 "if(document.readyState==='complete')setTimeout(go,20);" +
                 "else window.addEventListener('DOMContentLoaded',function(){setTimeout(go,20)},{once:true});" +
                 "})()}catch(_){}";
        // Поиск по странице (Ctrl+F): self-contained find в сайт-вьюхе —
        // нативный window.find (подсветка выделением + автоскролл) и счётчик
        // совпадений по innerText.  Базовая функция — инжектится ВСЕГДА,
        // без гейтов тумблеров.
        s += FindScript;
        // In-place перевод страницы: сбор текстовых узлов, замена и откат
        // («Показать оригинал»).  Тоже базовая функция — всегда.
        s += TransScript;
        return s;
    }

    // Релей поиска: шелл прислал {type:'find', q, back, count} — исполняем в
    // сайт-вьюхе активной вкладки и отдаём число совпадений назад в findbar.
    /* ---------------------------------------------------------- */
    /* Site tabs                                                    */
    /* ---------------------------------------------------------- */

    private TabPage Current => tabs.FirstOrDefault(t => t.Id == activeId);
}
