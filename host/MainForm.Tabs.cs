using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LiveBrowser;

// Tab lifecycle half of MainForm (partial): open/wire/activate/close, the
// view cap, hibernation, zoom bookkeeping of the live views.
internal sealed partial class MainForm
{
    private string Normalize(string url)
    {
        url = url?.Trim() ?? "";
        if (url.Length == 0) return "";
        // Typed bare text that is not a host goes to the search engine.
        if (!url.Contains("://") && !url.StartsWith("about:"))
            url = url.StartsWith("//") ? "https:" + url : "https://" + url;
        return url;
    }

    // Duplicate detection ignores scheme case, a trailing slash and the
    // www. prefix so "ya.ru" and "https://ya.ru/" are the same tab.
    private static string TabKey(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return url ?? "";
        var host = u.Host.ToLowerInvariant();
        if (host.StartsWith("www.")) host = host.Substring(4);
        var path = u.AbsolutePath.TrimEnd('/');
        return host + path + u.Query;
    }

    internal async void OpenTab(string url, string label)
    {
        try { await OpenAsync(url, label); }
        catch (Exception ex) { DebugLog("open failed " + ex.Message); }
    }

    // Opens a tab and returns it (or the already-open duplicate that was
    // activated instead); null when the url is not navigable.  Callers that
    // need the new tab id (popup linking) await this directly.
    private async Task<TabPage> OpenAsync(string url, string label)
    {
        url = Normalize(url);
        DebugLog("open " + url + " label=" + label);
        if (url.Length == 0 || !IsNavigable(url)) return null;

        var key = TabKey(url);
        var existing = tabs.FirstOrDefault(t => t.Id != 0 && TabKey(t.Url) == key);
        // A tab stuck on the error card is not a hit: navigating to that url
        // again means "try it once more", in this very tab.
        if (existing != null && errorPageUrls.ContainsKey(existing.Id)
            && views.TryGetValue(existing.Id, out var ev2) && ev2 != null && !ev2.IsDisposed
            && ev2.CoreWebView2 != null)
        {
            try
            {
                errorCardPending.Remove(existing.Id);
                errorPageUrls.Remove(existing.Id);
                DebugLog("retry in tab id=" + existing.Id + " " + url);
                Activate(existing.Id);
                existing.PendingUrl = url;
                ev2.CoreWebView2.Navigate(url);
                return existing;
            }
            catch { }
        }
        if (existing != null) { Activate(existing.Id); return existing; }

        // QA C1: every "open" used to create a WebView2 unconditionally, so a
        // burst of 20 messages left 20 live views behind.  A new view is only
        // created when there is a free slot: a tab whose controller has not
        // finished creating (still failing / interrupted) is reused first,
        // never a working site.
        if (!TryReserveViewSlot())
        {
            DebugLog("open refused: " + LiveViewCount() + " live views");
            Push(new { type = "toast", text = "Слишком много вкладок" });
            return null;
        }

        var page = new TabPage { Id = seq++, Url = url, Title = label ?? ShortHost(url) };
        try { page.Accent = AccentFor(ShortHost(url)); } catch { }

        var view = new WebView2();
        view.Dock = DockStyle.None;
        Controls.Add(view);
        view.BringToFront();
        view.Visible = false;
        views[page.Id] = view;

        page.View = view;
        tabs.Add(page);
        page.Loading = true;
        PushTabs();
        Activate(page.Id);

        await WireSiteViewAsync(page, view);
        if (!page.Alive || view.IsDisposed || view.CoreWebView2 == null) return page;
        try { DebugLog("navigate id=" + page.Id + " " + url); view.CoreWebView2.Navigate(url); }
        catch (Exception ex) { DebugLog("navigate failed id=" + page.Id + " " + ex.Message); }
        return page;
    }

    private async Task WireSiteViewAsync(TabPage page, WebView2 view)
    {
        try
        {
            DebugLog("wire start id=" + page.Id);
            await view.EnsureCoreWebView2Async(env);
            if (!page.Alive || view.IsDisposed) return;
            ApplyViewBackground(view);
            // Default zoom from settings.json applies to NEW views only —
            // existing tabs keep whatever the user zoomed them to.
            view.ZoomFactor = SettingsStore.DefaultZoom();
            page.Ready = true;
            DebugLog("wire ok id=" + page.Id);
            // Site hotkeys are answered by the injected listener (it sees keys
            // before Chromium does and can cancel them); the KeyDown handler
            // is a backstop for the few keys that reach the control unhandled.
            // Both call Hotkeys.Map, so they cannot disagree.
            view.KeyDown += (s, ev) => HandleSiteKey(view, page, ev);
            // The view was kept hidden while the controller was creating; the
            // active one can be shown now (re-runs the readiness gating).
            LayoutSiteViews();

            view.CoreWebView2.Settings.IsStatusBarEnabled = false;
            // The site menu carries "Inspect", which would open DevTools even
            // when AreDevToolsEnabled is off in release builds.
            view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = DebugMode;
            // Browser accelerator keys are OFF: WebView2 eats Ctrl+L (its own
            // "focus address bar") and F5/zoom before the host ever sees them,
            // which silently killed the omnibox shortcut from a site.  The
            // host re-implements the useful ones in ProcessCmdKey instead.
            view.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            view.CoreWebView2.Settings.AreDevToolsEnabled = DebugMode;
            // Chrome автоматически предлагает сохранить логин/пароль после
            // формы входа; без интерфейса управления сохранёнными паролями
            // такое предложение некуда девать, а менеджером паролей браузер
            // не является.  Отключено и без нативного пузыря, и без автосохранения.
            try
            {
                view.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
                view.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
            }
            catch { /* старый рантайм: настройки просто нет */ }
            // The web message channel is ON for site views, but the only
            // thing it carries is the injected hotkey listener below (the
            // host validates the message type).  Chromium consumes keys with
            // focus in a WebView2, so ProcessCmdKey/KeyDown never fire — the
            // page itself reports the shortcuts back to the host.
            view.CoreWebView2.Settings.IsWebMessageEnabled = true;
            // Ad/tracker blocking lives in one place (AdBlock.cs): the filter
            // sees every request of every site view, and it reads the setting
            // per request, so switching it off in the settings page takes
            // effect in already-open tabs instead of only in new ones.
            try
            {
                view.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                view.CoreWebView2.WebResourceRequested += OnSiteResourceRequested;
                view.CoreWebView2.NavigationStarting += (_, __) => AdBlock.ResetPageCounter();
            }
            catch { /* a runtime without filters only loses the blocklist */ }
            // Our own navigation error card (ShowErrorPage) replaces Chromium's
            // grey slab; eager error pages would overwrite it right after.
            try
            {
                view.CoreWebView2.Settings.IsBuiltInErrorPageEnabled = !ShowCustomErrorPages;
            }
            catch { }
            // Fire-and-forget: the injection is queued on the WebView2 side and
            // the UI thread has no reason to wait for the round trip.
            _ = view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(SiteBootScript());
            // Текст для полосы перевода читается по запросу шелла напрямую
            // через ExecuteScriptAsync (см. SendSiteTextWanted) — отдельный
            // инжект-скрипт не нужен.
            // Скролл сайтов — только нативный (композитор Chromium): прежний
            // инъект перехватывал колесо preventDefault'ом и вёз его через
            // rAF на главном потоке — «резиновый» отклик и фризы на тяжёлых
            // страницах (главный поток занят — скролл стоит). Нативный скролл
            // идёт в композиторе: и плавно, и мгновенно отзывчиво.
            view.CoreWebView2.WebMessageReceived += (s, ev) =>
            {
                try
                {
                    // Сайт шлёт postMessage(JSON.stringify(...)) — это СТРОКА.
                    // WebMessageAsJson оборачивает её в JSON-строку ещё раз;
                    // Parse тогда даёт String-корень и TryGetProperty кидает
                    // исключение — все сообщения сайтов (sitekey/siteclick)
                    // молча глотались.  Разворачиваем двойное кодирование.
                    string raw = ev.WebMessageAsJson;
                    using var doc = System.Text.Json.JsonDocument.Parse(raw);
                    var root0 = doc.RootElement;
                    using var doc2 = root0.ValueKind == JsonValueKind.String
                        ? System.Text.Json.JsonDocument.Parse(root0.GetString() ?? "{}")
                        : System.Text.Json.JsonDocument.Parse("{}");
                    // Не-строка: работаем от исходного документа (doc2 пуст).
                    var root = root0.ValueKind == JsonValueKind.String ? doc2.RootElement : root0;
                    if (!root.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) return;
                    var kind = t.GetString();
                    if (kind == "siteclick")
                    {
                        // Любой клик по сайту = «клик мимо» для бара: панель
                        // подсказок гасится, режим набора закрывается, стрип
                        // возвращается.  Работает и когда панели не было —
                        // омнибокс в фокусе с URL сайта — тот самый «бар не
                        // исчезает» из репорта.
                        HidePanelLayer();
                        Push(new { type = "suggest-hide" });
                    }
                    else if (kind == "sitekey")
                        HandleSiteHotkey(page, view,
                            root.TryGetProperty("code", out var c) ? c.GetString() : "",
                            root.TryGetProperty("ctrl", out var c1) && c1.GetBoolean(),
                            root.TryGetProperty("shift", out var c2) && c2.GetBoolean(),
                            root.TryGetProperty("alt", out var c3) && c3.GetBoolean());
                    else if (kind == "site-text")
                    {
                        // Ответ на site-text-want: отдаём текст шеллу вместе с
                        // id вкладки — шелл сверяет, того ли это таба.
                        var txt = root.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String
                            ? tx.GetString() : "";
                        Push(new { type = "site-text", id = page.Id, text = txt ?? "" });
                    }
                }
                catch { /* malformed message from a page */ }
            };

            // Browser accelerators cover Ctrl+F / Ctrl+± / Alt+← / print inside
            // a site.  The tab-level keys (Ctrl+W / Ctrl+T / Ctrl+N) are handled
            // by the host in WndProc: while a site view has focus the shell page
            // never sees keystrokes, but they still bubble to the window.

            view.CoreWebView2.NavigationStarting += (_, e) =>
            {
                if (!page.Alive) return;
                page.NavSeq++;
                // Remember the target: on failure Source may have moved on.
                try
                {
                    if (!string.IsNullOrEmpty(e.Uri) && IsNavigable(e.Uri)) page.PendingUrl = e.Uri;
                }
                catch { }
                // A real page load starts: whatever the error card was
                // hiding is replaced by this attempt.
                if (!errorCardPending.Contains(page.Id)) errorPageUrls.Remove(page.Id);
                page.Loading = true;
                PushTabs();
                PushNav(page);
                // Top progress strip in the bar (shell draws it).
                Push(new { type = "progress", id = page.Id, phase = "start" });
            };
            view.CoreWebView2.NavigationCompleted += (_, ev) =>
            {
                if (!page.Alive) return;
                DebugLog("site nav done ok=" + ev.IsSuccess + " id=" + page.Id
                         + " pending=" + page.PendingUrl + " seq=" + page.NavSeq);
                // A failure belongs to the attempt that started the current
                // navigation: once an attempt succeeds the pending check is
                // moot (a redirect chain may still fail once more afterwards,
                // but the page is already there).
                if (ev.IsSuccess) NextErrorToken(page.Id);
                // A successful navigation clears the error card marker, so the
                // same tab can show a fresh error later.
                // Only a real page clears the marker: the card's own
                // NavigateToString lands about:blank and would otherwise
                // forget that this tab is showing an error.
                var wasErrorCard = errorCardPending.Remove(page.Id);
                if (ev.IsSuccess && !wasErrorCard && errorPageUrls.Remove(page.Id))
                    DebugLog("error page cleared id=" + page.Id);
                // Per-site zoom: у хоста сохранён масштаб — применяем сразу
                // после загрузки (прыжок размера до отрисовки не виден).
                if (ev.IsSuccess)
                {
                    try { ApplySiteZoom(view); } catch { /* decorative */ }
                }
                // The card was requested but this outcome is not its own
                // load (the redirect chain said "success" first): remember
                // that the tab is still showing the card.
                if (wasErrorCard && !OnErrorCard(page.Id))
                    errorCardPending.Add(page.Id);
                // A dead host reports "Unknown" too, so that status alone must
                // not be skipped (it used to be filtered out with
                // OperationCanceled); only explicit cancellations are ignored.
                if (!ev.IsSuccess && ev.WebErrorStatus != Microsoft.Web.WebView2.Core.CoreWebView2WebErrorStatus.OperationCanceled
                    && !errorPageUrls.ContainsKey(page.Id))
                {
                    // Some failures are only a step in a redirect chain:
                    // news.ycombinator.com reports ERR_ABORTED/Unknown at
                    // ~1 s and settles ~1 s later.  Only the tab's navigation
                    // counter can tell a transient from a dead host: wait, and
                    // show the card only if no newer attempt started meanwhile
                    // (page.Loading is false between the chain's hops, so it
                    // cannot be used as the guard).
                    var failedId = page.Id;
                    var failedNav = page.NavSeq;
                    page.FailedNavSeq = failedNav;
                    var failedToken = NextErrorToken(page.Id);
                    // Probe after 1.2 s, then every 500 ms: the card appears
                    // only when a refresh of the same address also fails.
                    // Waiting for another "attempt" does not work — WebView2
                    // finishes HN's chain without starting a new navigation.
                    var t = new System.Windows.Forms.Timer { Interval = 1200 };
                    t.Tick += async (_, __) =>
                    {
                        t.Stop();
                        t.Dispose();
                        if (!page.Alive) return;
                        // Another navigation finished in this tab since the
                        // failure: its outcome owns the screen now.
                        if (!errorCheckSeq.TryGetValue(failedId, out var latest)
                            || latest != failedToken) return;
                        if (page.NavSeq != failedNav)
                        {
                            DebugLog("error check dropped id=" + failedId + " (recovered)");
                            return;
                        }
                        if (!views.TryGetValue(failedId, out var v2) || v2 == null || v2.IsDisposed) return;
                        // Live pages: Source is http(s) and the document is not
                        // the browser's own error page.  A dead host keeps the
                        // attempted http(s) Source and even a title, so the
                        // inner origin (Source.ToString()) is the honest probe.
                        bool ok = await HasRealDocumentAsync(v2.CoreWebView2);
                        DebugLog("error probe id=" + failedId + " doc=" + ok);
                        if (ok)
                        {
                            DebugLog("error check dropped id=" + failedId + " (page shown)");
                            return;
                        }
                        DebugLog("error page status=" + ev.WebErrorStatus + " id=" + failedId);
                        ShowErrorPage(v2, page);
                    };
                    t.Start();
                }
                // A failed navigation is over too: keep the spinner off so
                // the tab does not look busy forever (the site shows its own
                // error page).
                page.Loading = false;
                // The card itself is about:blank.  Keeping that as the tab's
                // url made the omnibox show about:blank and re-shortened the
                // title to "blank"; the tab stays on what it tried to open.
                if (wasErrorCard)
                {
                    // The card is ours: it must not rename the tab or leak
                    // "about:blank" into the omnibox.
                }
                else if (errorPageUrls.ContainsKey(page.Id))
                    page.Url = errorPageUrls[page.Id];
                else
                    try
                    {
                        var src = view.CoreWebView2?.Source;
                        // A shell started on a site (second window) may hand
                        // the view about:blank until the first paint.
                        if (!string.IsNullOrEmpty(src) && src != "about:blank") page.Url = src;
                    }
                    catch { }
                page.Title = ShortTitle(page.Title, page.Url);
                PushTabs();
                PushNav(page);
                Push(new { type = "progress", id = page.Id, phase = "done" });
                // Visit history: successful http(s) page loads only.  History
                // ignores a url repeated back-to-back by itself, so a plain
                // reload or an in-page anchor does not count twice.  The error
                // card is not a visit either.
                if (ev.IsSuccess && !wasErrorCard && !errorPageUrls.ContainsKey(page.Id)
                    && !string.IsNullOrEmpty(page.Url) && !privateMode)
                {
                    var visitUrl = page.Url;
                    var visitTitle = page.Title;
                    _ = Task.Run(() => History.Add(visitUrl, visitTitle));
                }
                // Полоса «Перевести страницу» (как в Chrome): только после
                // успешной загрузки http(s)-страницы и только для АКТИВНОЙ
                // вкладки — полоса живёт в шелле, а шелл виден лишь у неё.
                // Сам перевод не запускаем: предлагаем, решает пользователь.
                if (ev.IsSuccess && !wasErrorCard && page.Id == activeId)
                    _ = MaybeOfferTranslateAsync(page, view);
            };
            // Клик по сайту при открытой панели подсказок = «клик мимо»:
            // панель обязана закрыться (как по Esc).  Фокус уходит на view
            // сайта — здесь и ловим.  Пик по самой панели фокус не отдаёт
            // сайту, поэтому этот путь не мешает выбору строки.
            view.GotFocus += (_, _) =>
            {
                DebugLog("site view got focus id=" + page.Id
                    + " panelVisible=" + (panelView != null && !panelView.IsDisposed && panelView.Visible));
                if (panelView != null && !panelView.IsDisposed && panelView.Visible)
                {
                    HidePanelLayer();
                    Push(new { type = "suggest-hide" });
                }
            };
            // Native downloads are refused: DownloadManager fetches the file
            // itself so the shell can pause / resume / cancel it.
            // Кастомное контекстное меню (правый клик на сайте): нативное
            // меню Chromium глушим (Handled=true) и открываем СОБСТВЕННОЕ —
            // тот же нативный слой, что у «Ещё» (HandleMenu → dropdown.html):
            // единый стиль, те же гейты и анимации.  Выбор пункта возвращается
            // menu-pick'ом (ctxOpen флаг роутит его в ExecuteCtxAction).
            view.CoreWebView2.ContextMenuRequested += (s, e) =>
            {
                if (!page.Alive || view.IsDisposed || view.CoreWebView2 == null) return;
                e.Handled = true;
                try
                {
                    var cv = view.CoreWebView2;
                    var t = e.ContextMenuTarget;
                    ctxLinkUri = t != null && t.HasLinkUri ? t.LinkUri ?? "" : "";
                    bool hasLink = t != null && t.HasLinkUri && !string.IsNullOrWhiteSpace(t.LinkUri);

                    // Location — физические пиксели относительно вьюхи; меню
                    // ждёт CSS-пиксели окна (HandleMenu сам домножит на DPI).
                    double k = view.DeviceDpi / 96.0;
                    ctxPage = page;
                    ctxView = view;
                    ctxLink = hasLink;
                    ctxAt = new Point((int)Math.Round(e.Location.X / k), (int)Math.Round(e.Location.Y / k));

                    // PiP-детектор больше НЕ ждёт страницу: раньше здесь стоял
                    // probe.Wait(120), и каждый правый клик подвешивал UI-поток
                    // до 120 мс.  Теперь берём кэш по адресу документа и сразу
                    // открываем меню; если ответа ещё нет — зонд уходит в фон,
                    // а готовое меню перестраивается (ShowSiteMenu) с тем же
                    // списком действий.
                    string src = "";
                    try { src = cv.Source ?? ""; } catch { }
                    bool known = false, cached = false;
                    if (src.Length > 0) known = ctxVideoCache.TryGetValue(src, out cached);
                    ctxHasVideo = known && cached;
                    ctxVideoDone = known;
                    ctxVideoKey = src;
                    ShowSiteMenu();
                    if (!known) ProbeVideoAsync(cv, page, src);
                }
                catch (Exception ex) { DebugLog("ctx menu failed " + ex.Message); ctxOpen = false; }
            };

            view.CoreWebView2.DownloadStarting += (_, e) =>
            {
                e.Handled = true;
                if (closing || !page.Alive) return;
                try
                {
                    var d = e.DownloadOperation;
                    if (d == null) return;
                    // «Спрашивать, куда сохранять» (askEach): системный
                    // Save-as с именем из браузера.  Отмена диалога = отмена
                    // загрузки.  По умолчанию (выкл) файл молча едет в
                    // стандартные «Загрузки».
                    string explicitDir = null;
                    string suggested = d.ResultFilePath;
                    if (SettingsStore.DownloadsAskEach())
                    {
                        using var dlg = new SaveFileDialog
                        {
                            FileName = string.IsNullOrWhiteSpace(suggested)
                                ? DownloadManager.SuggestName(d.Uri)
                                : Path.GetFileName(suggested),
                            InitialDirectory = DownloadManager.DefaultDir(),
                            Filter = "Все файлы (*.*)|*.*",
                            CheckFileExists = false,
                            OverwritePrompt = true,
                        };
                        if (dlg.ShowDialog(this) != DialogResult.OK) return; // отмена
                        explicitDir = Path.GetDirectoryName(dlg.FileName);
                        suggested = dlg.FileName; // имя из диалога; ResultFilePath read-only
                    }
                    DownloadManager.Start(d.Uri, suggested, d.TotalBytesToReceive, explicitDir);
                }
                catch (Exception ex) { DebugLog("download start failed " + ex.Message); }
            };
            view.CoreWebView2.DocumentTitleChanged += (_, _) =>
            {
                if (!page.Alive) return;
                // The error card (about:blank) has no title worth keeping;
                // it used to replace the tab name with "about:blank".  (Only
                // while the card is actually shown: after a retry the real
                // page's title must come through again.)
                if (OnErrorCard(page.Id)) return;
                try
                {
                    if (view.CoreWebView2 != null && !string.IsNullOrWhiteSpace(view.CoreWebView2.DocumentTitle))
                        page.Title = view.CoreWebView2.DocumentTitle;
                }
                catch { return; }
                PushTabs();
            };
            // Пермиссии (гео/камера/микрофон/уведомления/буфер): системный
            // попап не показываем (Handled=true + деферрал), вместо него —
            // аккуратный диалог в шелле.  Ответ приходит {type:'perm-answer'};
            // молчание дольше 45 с = отказ (не держим getUserMedia вечно).
            view.CoreWebView2.PermissionRequested += (_, e) =>
            {
                if (!page.Alive) return;
                var kindLabel = e.PermissionKind switch
                {
                    CoreWebView2PermissionKind.Geolocation => "Геолокацию",
                    CoreWebView2PermissionKind.Microphone => "Микрофон",
                    CoreWebView2PermissionKind.Camera => "Камеру",
                    CoreWebView2PermissionKind.Notifications => "Уведомления",
                    CoreWebView2PermissionKind.ClipboardRead => "Чтение буфера обмена",
                    _ => "",
                };
                if (kindLabel.Length == 0) return; // экзотика — решает WebView2
                e.Handled = true;
                try
                {
                    var def = e.GetDeferral();
                    int id = ++permSeq;
                    var timer = new System.Windows.Forms.Timer { Interval = 45000 };
                    permPending[id] = (e, def, timer);
                    timer.Tick += (s2, e2) => { timer.Stop(); AnswerPerm(id, false); };
                    timer.Start();
                    string host = "";
                    try { host = new Uri(e.Uri).Host.Replace("www.", ""); } catch { host = e.Uri ?? ""; }
                    Push(new { type = "perm", id, kind = kindLabel, uri = host });
                }
                catch (Exception ex) { DebugLog("perm dialog failed " + ex.Message); }
            };

            view.CoreWebView2.FaviconChanged += async (_, _) =>
            {
                if (!page.Alive || view.IsDisposed) return;
                try
                {
                    var uri = view.CoreWebView2?.FaviconUri;
                    if (string.IsNullOrEmpty(uri) || !IsNavigable(uri)) return;
                    // Процессный кэш иконок (FaviconStore): второе окно или
                    // повторный визит не тянут тот же значок по сети.
                    var host = page.Host;
                    if (host.Length > 0 && FaviconStore.TryGet(host, out var cached))
                    {
                        page.Favicon = cached;
                        PushTabs();
                        return;
                    }
                    var bytes = await ShellApi.FetchFaviconAsync(uri);
                    if (!page.Alive || bytes.Length == 0 || bytes.Length > 512 * 1024) return;
                    var mime = uri.EndsWith(".svg", StringComparison.OrdinalIgnoreCase) ? "image/svg+xml" : "image/png";
                    page.Favicon = "data:" + mime + ";base64," + Convert.ToBase64String(bytes);
                    FaviconStore.Store(host, page.Favicon);
                }
                catch { /* favicon is decorative */ }
                if (page.Alive) PushTabs();
            };
            // Звук вкладки: Chromium сам знает, играет ли документ (медиа,
            // WebRTC), и поднимает событие при смене.  Флаг уходит в push
            // "tabs" — шелл рисует динамик на таблетке и даёт mute.
            view.CoreWebView2.IsDocumentPlayingAudioChanged += (_, _) =>
            {
                if (!page.Alive || view.IsDisposed) return;
                try { page.Audible = view.CoreWebView2.IsDocumentPlayingAudio; }
                catch { return; }
                PushTabs();
            };
            try
            {
                // Глушилка переживает навигацию: это свойство вьюхи, не страницы.
                view.CoreWebView2.IsMuted = page.Muted;
                page.Audible = view.CoreWebView2.IsDocumentPlayingAudio;
            }
            catch { }
            // window.open / target=_blank inside a site: never a top-level
            // window — the url is opened as an ordinary tab through the same
            // OpenAsync path the bridge "open" message uses, and the new tab
            // is linked to this one so it closes together with its parent.
            view.CoreWebView2.NewWindowRequested += async (_, e) =>
            {
                if (closing) return;
                if (string.IsNullOrEmpty(e.Uri)) { e.Handled = false; return; }
                e.Handled = true;
                try
                {
                    var child = await OpenAsync(e.Uri, null);
                    if (child != null && child.Id != 0 && child.Alive && page.Alive)
                        RegisterPopupChild(page.Id, child.Id);
                }
                catch (Exception ex) { DebugLog("popup open failed " + ex.Message); }
            };
            view.CoreWebView2.SourceChanged += (_, _) =>
            {
                if (!page.Alive) return;
                try
                {
                    var src = view.CoreWebView2?.Source;
                    // The error card lives at about:blank but the tab must
                    // keep the address it failed on (retry, omnibox).
                    if (!string.IsNullOrEmpty(src)
                        && !(src == "about:blank" && errorPageUrls.ContainsKey(page.Id)))
                        page.Url = src;
                }
                catch { return; }
                PushTabs();
                PushNav(page);
            };
        }
        catch (Exception ex) { DebugLog("wire failed " + ex.Message); }
    }

    private void ReorderTab(int id, int index)
    {
        if (id == 0) return; // «Рабочий стол» закреплён первым
        int from = tabs.FindIndex(t => t.Id == id);
        if (from < 0) return;
        var tab = tabs[from];
        tabs.RemoveAt(from);
        // Вставка идёт в диапазон сайт-вкладок [1..Count]: Clamp держит и
        // случай «перетащили за последний» (вставить в самый конец).
        int to = Math.Clamp(index + 1, 1, tabs.Count);
        tabs.Insert(to, tab);
        PushTabs();
    }

    // F11: сайт на весь экран без полосы.  Возврат — тем же F11, Esc с сайта
    // (хост ловит его в ProcessCmdKey) и с шелла (bridge-сообщение).
    private void ToggleFocusMode() => SetFocusMode(!focusMode);

    // Переключение колонки.  Горячей клавиши и пункта меню больше нет, так
    // что вызывать его из UI нечем; остался путь через ipc
    // "toggle-vertical-tabs" и проба.  Хост владеет только геометрией (где
    // начинается сайт и какой кусок клиентской области принадлежит шеллу);
    // как вкладки выглядят в колонке, решает шелл по пушу "vertical-tabs".
    private void ToggleVerticalTabs() => SetVerticalTabs(!verticalTabs);

    private void SetVerticalTabs(bool on)
    {
        if (on == verticalTabs) return;
        verticalTabs = on;
        // Сохраняем: режим переживает перезапуск, как у настоящих браузеров.
        try { SettingsStore.SetVerticalTabs(on); } catch { }
        LayoutSiteViews();
        Push(new { type = "vertical-tabs", on });
        if (ui != null && !ui.IsDisposed) ui.Focus();
    }

    private void SetFocusMode(bool on)
    {
        // На «Рабочем столе» прятать нечего: там нет сайта под полосой.
        if (on && (activeId == 0 || Current == null || Current.Id == 0)) on = false;
        if (on == focusMode) return;
        focusMode = on;
        LayoutSiteViews();
        Push(new { type = "focus-mode", on });
        if (on && Current != null && views.TryGetValue(Current.Id, out var fv)
            && fv != null && !fv.IsDisposed) fv.Focus();
        else if (!on && ui != null && !ui.IsDisposed) ui.Focus();
    }
    // а не страницу: mute переживает навигацию, как в настоящем браузере.
    private void ToggleMute(int id)
    {
        var tab = tabs.FirstOrDefault(t => t.Id == id);
        if (tab == null || id == 0) return;
        // Флаг модели — источник истины даже если вьюхи ещё нет.
        tab.Muted = !tab.Muted;
        if (views.TryGetValue(id, out var v) && v != null && !v.IsDisposed && v.CoreWebView2 != null)
        {
            try { v.CoreWebView2.IsMuted = tab.Muted; } catch { }
        }
        PushTabs();
    }

    private void CloseTab(int id) => CloseTab(id, rememberLastClosed: true);

    private void CloseTab(int id, bool rememberLastClosed)
    {
        if (id == 0) return;
        var i = tabs.FindIndex(t => t.Id == id);
        if (i < 0) return;
        var closed = tabs[i];

        // Snapshot the live url before the view dies: the model can lag a
        // client-side (SPA) navigation, and the tab must reopen as it was.
        if (rememberLastClosed)
        {
            try
            {
                if (closed.View?.CoreWebView2 != null && IsNavigable(closed.View.CoreWebView2.Source))
                    closed.Url = closed.View.CoreWebView2.Source;
            }
            catch { }
            lastClosed = (closed.Url, closed.Title);
        }

        // QA C1: a closed tab used to leave its WebView2 alive (TabPage.Dispose
        // drops the child, but the browser process was not asked to stop).
        // Stop the navigation first, then dispose; both are best-effort
        // because a tab can be closed while its controller is still pending.
        try { closed.View?.CoreWebView2?.Stop(); }
        catch { /* controller gone */ }
        closed.Dispose(); // sets Alive = false first, then disposes the view
        views.Remove(id);
        suspended.Remove(id);
        lastActive.Remove(id);
        sleptTabs.Remove(id);
        errorPageUrls.Remove(id);
        tabs.RemoveAt(i);
        foreach (var kids in popupChildren.Values) kids.Remove(id); // no dangling links
        // Popups die with the tab that opened them (and the cascade reaches
        // their own popups too, through the recursive CloseTab calls).
        if (popupChildren.TryGetValue(id, out var children))
        {
            popupChildren.Remove(id);
            foreach (var child in children) CloseTab(child, rememberLastClosed: false);
        }
        if (activeId == id)
        {
            var next = tabs[Math.Min(i, tabs.Count - 1)];
            Activate(next.Id);
        }
        else if (tabs.All(t => t.Id != activeId))
        {
            // The active tab was a popup killed by the cascade above.
            Activate(0);
        }
        else
        {
            PushTabs();
        }
    }

    private void RegisterPopupChild(int parentId, int childId)
    {
        if (parentId == 0 || parentId == childId) return;
        if (!popupChildren.TryGetValue(parentId, out var kids))
            popupChildren[parentId] = kids = new List<int>();
        if (!kids.Contains(childId)) kids.Add(childId);
    }

    /* ---------------------------------------------------------- */
    /* Live view budget / suspension                                */
    /* ---------------------------------------------------------- */

    private int LiveViewCount() => views.Count(kv => kv.Value != null && !kv.Value.IsDisposed);

    // True when a new site view may be created.  When the budget is full, a
    // tab that never got a working controller (creation failed or was
    // interrupted) gives up its placeholder instead of the user's site.
    private bool TryReserveViewSlot()
    {
        if (LiveViewCount() < MaxLiveViews) return true;
        var dead = tabs.FirstOrDefault(t => t.Id != 0 && t.Alive &&
            (!views.TryGetValue(t.Id, out var v) || v == null || v.IsDisposed || v.CoreWebView2 == null));
        if (dead == null) return false;
        DebugLog("reusing slot of tab " + dead.Id);
        CloseTab(dead.Id, rememberLastClosed: false);
        return true;
    }

    // Every activation (including the home tab, which clears the counter).
    private void MarkActive(int id)
    {
        lastActive[id] = DateTime.UtcNow;
        // A suspended view must come back before it is shown again.
        if (id != 0 && suspended.Contains(id) && views.TryGetValue(id, out var v) && v != null && !v.IsDisposed)
        {
            try { v.CoreWebView2?.Resume(); } catch { }
            suspended.Remove(id);
            DebugLog("resume id=" + id);
        }
        // Гибернация: вкладку выгрузили — возвращаем её из состояния (адрес +
        // прокрутка + поля формы), а не из «пустой замороженной страницы».
        // Вьюху получаем заново в том же слоте.
        if (id != 0 && sleptTabs.TryGetValue(id, out var snap))
        {
            var tab = tabs.FirstOrDefault(t => t.Id == id);
            if (tab != null && tab.Alive)
            {
                WakeTab(tab, snap);
                // Свежая вьюха создаётся уже внутри активации: LayoutSiteViews
                // ниже увидит её, а PushNav получит модель с восстановленным
                // адресом.
            }
        }
    }

    // Гибернация: 15 минут без активации и вкладка выгружается целиком —
    // вьюха уничтожается (память рендерера и DOM освобождаются), остаются
    // адрес и снимок состояния.  Первые SuspendAfter — «сон» на месте
    // (TrySuspendAsync: страница и форма живы, CPU рендерера ноль), это
    // мгновенное возвращение для недавно открытых.
    private static readonly TimeSpan HibernateAfter = TimeSpan.FromMinutes(15);
    // id -> адрес и то, что страница отдала в снимок (scrollY, поля формы).
    private readonly Dictionary<int, HibernateSnapshot> sleptTabs = new();

    internal sealed class HibernateSnapshot
    {
        public string Url = "";
        public string State = "";      // JSON из страницы: {y:number, f:{name:value}}
        public int HistoryIndex;
    }

    // Один проход раз в минуту: сон по SuspendAfter, выгрузка по HibernateAfter.
    // Активная вкладка, рабочий стол и карточки ошибок (локальный
    // NavigateToString) не трогаются никогда.
    private void SuspendIdleViews()
    {
        if (closing || !SettingsStore.BackgroundSuspend()) return;
        var now = DateTime.UtcNow;
        foreach (var kv in views.ToArray())
        {
            int id = kv.Key;
            var v = kv.Value;
            if (id == activeId || v == null || v.IsDisposed || v.CoreWebView2 == null) continue;
            var tab = tabs.FirstOrDefault(t => t.Id == id);
            if (tab == null || !tab.Alive || !tab.Ready) continue;   // still creating
            if (errorPageUrls.ContainsKey(id)) continue;              // local error card
            if (sleptTabs.ContainsKey(id)) continue;                  // already unloaded
            if (!lastActive.TryGetValue(id, out var at)) { lastActive[id] = now; continue; }
            var idle = now - at;

            // Сначала дольше 15 минут — выгружаем (это дороже сна, поэтому
            // проверяется первым: вкладку, проспавшую 3 минуты, никто не
            // обязан будить ради того, чтобы через минуту всё равно выгрузить).
            if (idle >= HibernateAfter)
            {
                if (tab.Audible && !tab.Muted) continue;              // музыка/видео не глушим
                if (!CanHibernate(tab)) continue;                     // popup-родитель?
                HibernateTab(tab, v);
                continue;
            }
            if (suspended.Contains(id) || idle < SuspendAfter) continue;
            try
            {
                var op = v.CoreWebView2.TrySuspendAsync();
                suspended.Add(id);
                DebugLog("suspend id=" + id);
                _ = op.ContinueWith(_ => { }, TaskContinuationOptions.OnlyOnFaulted); // swallowed: best-effort
            }
            catch { /* runtime older than suspend support */ }
        }
    }

    // Снимок состояния страницы: позиция прокрутки и заполненные поля формы.
    // Ничего не бросаем в лог — на страницы с паролями состояние не пишем
    // (type=password исключён в скрипте).
    private const string CaptureStateScript =
        "(()=>{try{const f={};const els=document.querySelectorAll('input,textarea,select');" +
        "let n=0;for(const e of els){if(n>=40)break;if(!e.name&&!e.id)continue;" +
        "if((e.type||'')==='password'||e.type==='file'||e.type==='hidden')continue;" +
        "const k=e.name||e.id;if(k in f)continue;" +
        "f[k]=e.type==='checkbox'||e.type==='radio'?String(e.checked):String(e.value||'');n++;}" +
        "return JSON.stringify({y:Math.round(window.scrollY||0),f:f});}catch(_){return '{}';}})()";

    // Возврат после гибернации: новая вьюха в том же слоте, навигация по
    // сохранённому адресу, затем восстановление прокрутки и полей один раз.
    private void WakeTab(TabPage tab, HibernateSnapshot snap)
    {
        int id = tab.Id;
        sleptTabs.Remove(id);
        suspended.Remove(id);
        tab.Slept = false;
        lastActive[id] = DateTime.UtcNow;
        DebugLog("wake id=" + id + " " + snap.Url);
        // Вьюха могла умереть, пока вкладка спала (упавший рендерер).
        bool alive = views.TryGetValue(id, out var v) && v != null && !v.IsDisposed && v.CoreWebView2 != null;
        if (!alive)
        {
            // Слот выгрузки уже освобождён, поэтому новая вьюха создаётся
            // через тот же путь, что и обычная вкладка: вешаем обработчики,
            // навигируем — и только потом приходит восстановление.
            _ = ReopenAsleepTabAsync(tab, snap);
            return;
        }
        string url = IsNavigable(snap.Url) ? snap.Url : tab.Url;
        if (!IsNavigable(url)) return;
        try { v.CoreWebView2.Navigate(url); } catch { return; }
        if (!string.IsNullOrEmpty(snap.State)) RestoreWhenLoaded(v, snap.State);
    }

    // Снимок прокрутки/полей применяется один раз после загрузки страницы:
    // однократный обработчик NavigationCompleted снимает себя сам.
    private void RestoreWhenLoaded(WebView2 view, string state)
    {
        EventHandler<CoreWebView2NavigationCompletedEventArgs> h = null;
        h = async (_, _) =>
        {
            try { view.CoreWebView2.NavigationCompleted -= h; } catch { }
            if (view.IsDisposed || view.CoreWebView2 == null) return;
            try
            {
                await Task.Delay(120); // SPA дорисовывает контент после complete
                if (view.IsDisposed || view.CoreWebView2 == null) return;
                string js = "(function(){try{const s=" + state + ";window.scrollTo(0,s.y||0);" +
                    "const f=s.f||{};for(const k in f){try{const e=document.querySelector(" +
                    "'[name=\"'+CSS.escape(k)+'\"]')||document.getElementById(k);if(!e)continue;" +
                    "if(e.type==='checkbox'||e.type==='radio')e.checked=f[k]==='true';" +
                    "else if(!e.value)e.value=f[k];}catch(_){}}}catch(_){}})()";
                _ = view.CoreWebView2.ExecuteScriptAsync(js);
            }
            catch { /* состояние — необязательная косметика */ }
        };
        try { view.CoreWebView2.NavigationCompleted += h; } catch { }
    }

    private async Task ReopenAsleepTabAsync(TabPage tab, HibernateSnapshot snap)
    {
        string url = IsNavigable(snap.Url) ? snap.Url : tab.Url;
        if (!IsNavigable(url)) return;
        if (!TryReserveViewSlot())
        {
            // Слота нет — честно оставляем адрес в модели и подсказываем.
            tab.Url = url;
            PushTabs();
            Push(new { type = "toast", text = "Слишком много вкладок" });
            return;
        }
        var view = new WebView2 { Dock = DockStyle.None };
        Controls.Add(view);
        view.BringToFront();
        view.Visible = false;
        views[tab.Id] = view;
        tab.View = view;
        tab.Ready = false;
        tab.Loading = true;
        PushTabs();
        LayoutSiteViews();
        await WireSiteViewAsync(tab, view);
        if (!tab.Alive || view.IsDisposed || view.CoreWebView2 == null) return;
        try { view.CoreWebView2.Navigate(url); } catch { return; }
        if (!string.IsNullOrEmpty(snap.State)) RestoreWhenLoaded(view, snap.State);
        if (tab.Id == activeId && !view.Visible) LayoutSiteViews();
    }

    // Запреты выгрузки: вкладка, у которой есть открытые popup'ы (дочерние
    // окна живут в её процессе), и вкладка, чью вьюху сейчас кто-то держит.
    private bool CanHibernate(TabPage tab)
    {
        if (closing) return false;
        // Вкладка с открытыми дочерними окнами не выгружается: popup'ы
        // держат её процесс, и «оживить» их посреди чужой сессии нельзя.
        if (tab != null && popupChildren.TryGetValue(tab.Id, out var kids) && kids.Count > 0) return false;
        return true;
    }

    private void HibernateTab(TabPage tab, WebView2 view)
    {
        int id = tab.Id;
        var snap = new HibernateSnapshot
        {
            Url = tab.Url,
            HistoryIndex = 0,
        };
        // Адрес — из модели, а если она отстала (SPA) — из вьюхи.
        try
        {
            var src = view.CoreWebView2.Source;
            if (IsNavigable(src)) snap.Url = src;
        }
        catch { }
        // Снимок запрашиваем, но не ждём: выгрузка не должна зависеть от
        // того, ответила ли страница (она может быть занята или зависла).
        var pending = default(Task<string>);
        try { pending = view.CoreWebView2.ExecuteScriptAsync(CaptureStateScript); }
        catch { }
        tab.Slept = true;
        tab.Ready = false;
        tab.Loading = false;
        tab.Url = snap.Url;
        sleptTabs[id] = snap;
        // Вьюху гасим сразу: память рендерера освобождается, адрес остался
        // в sleptTabs — при активации вкладка откроется заново.
        try { view.CoreWebView2.Stop(); } catch { }
        views.Remove(id);
        suspended.Remove(id);
        lastActive.Remove(id);
        try { view.Dispose(); } catch { }
        tab.View = null;
        DebugLog("hibernate id=" + id + " " + snap.Url);
        if (pending != null)
        {
            _ = pending.ContinueWith(t =>
            {
                try
                {
                    if (t.Status != TaskStatus.RanToCompletion) return;
                    var raw = t.Result;
                    if (string.IsNullOrEmpty(raw) || raw.Length < 3) return;
                    // ExecuteScriptAsync отдаёт JSON-строку в кавычках.
                    if (raw[0] == '"') raw = JsonSerializer.Deserialize<string>(raw) ?? "{}";
                    if (raw.Length > 65536) return;   // мусор — не копим
                    if (sleptTabs.TryGetValue(id, out var s)) s.State = raw;
                }
                catch { }
            }, TaskContinuationOptions.ExecuteSynchronously);
        }
        PushTabs();
    }

    // Ctrl+Shift+T on a site tab / bridge "reopen" from the shell: bring the
    // last closed site tab back as a new tab, once.
    private void ReopenLastClosed()
    {
        if (lastClosed == null) return;
        var (url, label) = lastClosed.Value;
        lastClosed = null;
        if (IsNavigable(url)) OpenTab(url, label);
    }

}
