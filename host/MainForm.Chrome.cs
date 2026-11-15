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

// Window chrome half of MainForm (partial): theme, layout, the shell bridge
// (push + menu/suggests layer) and the native dropdown panel.
internal sealed partial class MainForm
{
    private void Activate(int id)
    {
        DebugLog("activate " + id + " from " + activeId);
        int prev = activeId;
        // Другая вкладка/рабочий стол: полоса «Перевести страницу» относится
        // к своей странице.  Выключаем сразу, затем (для сайта только что
        // загруженного в фоне) предлагаем заново — по его языку.
        if (id != activeId) Push(new { type = "translate-offer-hide" });
        if (tabs.All(t => t.Id != id)) { id = 0; }
        activeId = id;
        MarkActive(id);
        // The cookie/status endpoints answer for the site the user is on.
        var now = tabs.FirstOrDefault(t => t.Id == id);
        ShellApi.ActiveUrl = id != 0 ? (now?.Url ?? "") : "";
        LayoutSiteViews();
        // fast: подмена под шторкой и уходит ДЕСКТОП — шелл прячет его
        // мгновенно (fade дал бы «призрак» поверх сайта после полосы).
        PushTabs(fast: inCurtainSwap && prev == 0);
        PushNav(Current);
        // Рабочий стол → сайт: подмену вьюх прячет крест-фейд.  Сайт
        // появляется ПОД непрозрачным десктопом, который шелл гасит
        // transition'ом .24s; ui-вьюха на это время остаётся во всё окно
        // (см. HoldUiFullForHomeFade), иначе десктоп срезался бы кадром.
        // Исключение — проезд шторки (inCurtainSwap): подмена под полосой,
        // десктоп прячется мгновенно, догорание поверх сайта — артефакт.
        if (prev == 0 && id != 0 && SettingsStore.Animations() && !inCurtainSwap)
            HoldUiFullForHomeFade();
        // fast — только когда прячется ДЕСКТОП (0 → сайт) и только под шторкой.
        // Вкладку открыли/переключились на давно загруженную: NavigationCompleted
        // её уже отдал, полоса не покажется, пока не перезагрузить.  Поэтому
        // проверяем видимую страницу ещё и здесь (Translator сам помнит
        // закрытые url и повторно не предлагает).
        if (now != null && views.TryGetValue(id, out var av) && av != null &&
            !av.IsDisposed && av.CoreWebView2 != null)
            _ = MaybeOfferTranslateAsync(now, av);
    }

    // Пока true, ui-вьюха не сжимается до бара даже при активном сайте:
    // десктоп должен ДОГАСНУТЬ поверх уже показанного сайта (крест-фейд),
    // а не исчезнуть одним кадром.  Ставится только для перехода 0 → сайт
    // и снимается таймером (обычный LayoutSiteViews после).
    private bool uiHeldFull;

    private void HoldUiFullForHomeFade()
    {
        uiHeldFull = true;
        LayoutSiteViews();
        var t = new System.Windows.Forms.Timer { Interval = 280 };
        t.Tick += (_, _) =>
        {
            t.Stop();
            t.Dispose();
            uiHeldFull = false;
            if (activeId != 0) LayoutSiteViews();
        };
        t.Start();
    }

    // Свёрнутое окно не должно перерисовывать декорации: шелл ставит
    // body.occ и замирают бесконечные CSS-анимации (GPU в покое → 0).
    // У Form нет OnStateChanged — minimize/maximize/restore идут через resize.
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        bool gone = WindowState == FormWindowState.Minimized || !Visible;
        try { Push(new { type = "occ", on = WindowState == FormWindowState.Minimized }); } catch { }
        // Свернули/скрыли посреди проезда — полосу гасим сразу: она живёт
        // отдельным topmost-окном и иначе доезжала бы по рабочему столу.
        try { curtain?.OwnerGone(gone); } catch { }
    }

    // Смена вкладки через «штору»: цветная полоса проезжает по окну и прячет
    // подмену вьюх; направление — по положению вкладки в полосе (правее —
    // слева направо).  Закрытие/стартап остаются мгновенными: штора только
    // для явных переключений.  Анимации выключены или штора занята — просто
    // Activate, никаких задержек (урок кроссфейда).
    private void ActivateAnimated(int id)
    {
        int from = tabs.FindIndex(t => t.Id == activeId);
        int to = tabs.FindIndex(t => t.Id == id);
        // Шторка — на рабочий стол→сайт с ГОТОВОЙ вьюхой и на сайт↔сайт: она
        // накрывает подмену вьюх И ресайз ui-вьюхи (на ресайзе WebView2 мог
        // представить устаревший кадр — «десктоп мигает на миллисекунду»).
        // ВОЗВРАТ НА ДЕСКТОП — без шторки (по решению): сайт уходит сразу, а
        // контент десктопа ПОДНИМАЕТСЯ stage-enter'ом — это его анимация
        // входа.  Новая вкладка (вьюха ещё не готова) — крест-фейд шелла.
        var target = tabs.FirstOrDefault(t => t.Id == id);
        bool targetReady = to > 0 && target != null && target.Ready
            && views.TryGetValue(id, out var tv) && tv != null && !tv.IsDisposed
            && tv.CoreWebView2 != null;
        if (from < 0 || to < 0 || from == to || to == 0
            || !SettingsStore.Animations() || !targetReady)
        {
            Activate(id);
            return;
        }
        curtain ??= new Curtain(this);
        curtain.Cyber = cyberTheme;
        curtain.EdgeColor = accentColor2;
        Color band = BandColor();
        DebugLog($"curtain accent=#{accentColor.R:x2}{accentColor.G:x2}{accentColor.B:x2} edge=#{accentColor2.R:x2}{accentColor2.G:x2}{accentColor2.B:x2}"
            + $" band=#{band.R:x2}{band.G:x2}{band.B:x2} dark={darkTheme} cyber={cyberTheme}");
        // Подмену делает колбэк шторки: пока он выполняется, PushTabs помечен
        // fast — шелл прячет десктоп МГНОВЕННО (он под полосой, fade не нужен
        // и дал бы «призрак», догорающий поверх сайта после проезда полосы).
        inCurtainSwap = true;
        curtain.Sweep(to > from, band, () => { Activate(id); inCurtainSwap = false; });
    }

    // true внутри колбэка шторки: подмена происходит под полосой, шеллу надо
    // прятать десктоп без анимации (см. PushTabs(fast) → tabs.msg.fast).
    private bool inCurtainSwap;

    // Цвет «шторы»: акцент текущей темы, подмешанный к её фону.  Чистый
    // акцент на проезде выглядел одинаково и в тёмной, и в светлой теме
    // (акцент у палитры один на оба режима) — полоса «синяя поверх всего».
    // С подмесом к фону проезд читается как часть темы: в тёмной глуше, в
    // светлой высветленный.  Night City (cyber) остаётся чистым: жёлтый и
    // есть тамошний цвет, разбавлять его фоном нельзя.
    private System.Drawing.Color BandColor()
    {
        if (cyberTheme) return accentColor;
        return darkTheme
            // На тёмном фоне акцент чуть светлее — полоса читается как свечение.
            ? MixColor(accentColor, System.Drawing.Color.White, 0.12)
            // На светлом — чуть глубже: высветленная полоса на белой странице
            // почти растворялась и не прятала подмену вкладки.
            : MixColor(accentColor, System.Drawing.Color.FromArgb(0x12, 0x12, 0x1A), 0.25);
    }

    private static System.Drawing.Color MixColor(System.Drawing.Color a, System.Drawing.Color b, double k)
        => System.Drawing.Color.FromArgb(
            (int)Math.Round(a.R + (b.R - a.R) * k),
            (int)Math.Round(a.G + (b.G - a.G) * k),
            (int)Math.Round(a.B + (b.B - a.B) * k));

    // "#5e6ad2" / "5e6ad2" / "#5ea" — акцент темы из шелла.
    private static bool TryParseHexColor(string s, out System.Drawing.Color c)
    {
        c = default;
        if (string.IsNullOrEmpty(s)) return false;
        s = s.TrimStart('#').Trim();
        if (s.Length == 3) s = $"{s[0]}{s[0]}{s[1]}{s[1]}{s[2]}{s[2]}";
        if (s.Length != 6 || !int.TryParse(s, System.Globalization.NumberStyles.HexNumber, null, out int v))
            return false;
        c = System.Drawing.Color.FromArgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
        return true;
    }

    // Ad/tracker blocking for site views.  A blocked request gets an empty 200
    // instead of the usual "did not load" error page: an ad slot then collapses
    // quietly, while a hard failure paints Chromium's grey error frame in the
    // middle of the page.  Only subresources are stopped — a document request
    // is a navigation the user asked for, and breaking it would look like the
    // browser is broken.
    private void OnSiteResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            if (e.ResourceContext == CoreWebView2WebResourceContext.Document) return;
            if (!SettingsStore.AdBlock()) return;
            var uri = e.Request?.Uri;
            if (!AdBlock.ShouldBlock(uri)) return;
            var ctl = (sender as CoreWebView2);
            if (ctl == null) return;
            e.Response = ctl.Environment.CreateWebResourceResponse(
                null, 200, "OK", "Content-Type: text/plain\r\nAccess-Control-Allow-Origin: *");
            AdBlock.CountBlocked();
            // Debug log only at low volume: one line per blocked host per page
            // would drown the probe output on an ad-heavy site.
            if (AdBlock.SinceNavReset <= 5) DebugLog("adblock " + uri);
            if (AdBlock.SinceNavReset == 1 || AdBlock.SinceNavReset % 10 == 0)
                Push(AdBlock.Stats());
        }
        catch { /* a failed block must never break the page */ }
    }

    // Paints the native page background behind the shell and every site view.
    // Without it WebView2 shows white for a frame on resize/tab switch, which
    // is a bright flash in dark mode and the opposite in light mode.  The ui
    // view must stay TRANSPARENT: it overlays site views, and its HTML only
    // paints the bar / panels — everywhere else the site shows through.
    private void ApplyViewBackground(WebView2 v)
    {
        try
        {
            if (v == null || v.IsDisposed) return;
            // Нативная панель (подсказки/меню над сайтом) тоже прозрачна:
            // dd-list рисует карточку со скруглением, и раньше в углах
            // просвечивал ОПАК-фон вьюхи — те самые «чёрные уголочки».
            // Прозрачность = в углах виден сайт, как у локальных поповеров.
            v.DefaultBackgroundColor = v == ui || v == panelView
                ? System.Drawing.Color.Transparent
                : ThemeBg;
        }
        catch { /* view closing */ }
    }

    private void ApplyThemeMode(bool dark)
    {
        darkTheme = dark;
        // Single source of truth for the cyber look: the palette's raw flag
        // ANDed with the mode.  The old code let the "theme" message set
        // cyberTheme straight from the JSON (night-city always carries
        // cyber:true), so a switch to light left the window with the black
        // backdrop and the curtain in the previous colour until the next
        // accent message — order-dependent, hence "шторка не под цвет темы".
        cyberTheme = accentCyber && dark;
        var bg = ThemeBg;
        if (BackColor != bg)
        {
            BackColor = bg;
            if (IsHandleCreated) Win.Style(Handle, bg, dark);
        }
        if (ui != null && !ui.IsDisposed) ApplyViewBackground(ui);
        if (panelView != null && !panelView.IsDisposed) ApplyViewBackground(panelView);
        foreach (var v in views.Values) ApplyViewBackground(v);
        // The shell's own corners are rounded in CSS with --win-radius; DWM
        // rounds the frame too, so both use the same 12 px radius.
        Invalidate();
    }

    // Snapshot the outgoing view (site or the shell desktop) into the fade
    // layer.  The capture is async: the view swap happens immediately and the
    // snapshot appears on top a moment later, dissolving to reveal it.

    private void LayoutSiteViews()
    {
        int W = ClientSize.Width, H = ClientSize.Height;
        // DPI: the shell's bar is 56 CSS px, so child views start below it in
        // physical pixels.  96 = default scaling.
        BarHeight = (int)Math.Round(56 * (DeviceDpi / 96.0));
        // Вертикальные вкладки: колонка слева.  Ширина приходит из той же
        // константы, что и в CSS шелла (--vtabs-w), поэтому сайт начинается
        // ровно за правым краем полосы при любом DPI.
        SideWidth = verticalTabs ? (int)Math.Round(VerticalTabsCssWidth * (DeviceDpi / 96.0)) : 0;
        // Фокус-режим: полозья нет — сайт начинается от нуля.  Отдельной ветки
        // в теле раскладки не нужно: BarHeight = 0 сам опускает вьюху на всю
        // высоту, а ui ниже скрывается целиком.  Вертикальные вкладки в фокус-
        // режиме тоже уезжают: F11 — это «один сайт и ничего больше».
        int bar = focusMode ? 0 : BarHeight;
        int side = focusMode ? 0 : SideWidth;
        int siteX = verticalTabs && !focusMode ? side : 0;
        bool siteActive = false;
        foreach (var kv in views)
        {
            if (kv.Value == null || kv.Value.IsDisposed) continue;
            var tab = tabs.FirstOrDefault(t => t.Id == kv.Key);
            var isActive = kv.Key == activeId && tab != null && tab.Id != 0;
            if (!isActive) { kv.Value.Visible = false; continue; }
            // A view whose controller has not finished creating would paint a
            // flat dark rectangle over the home page — keep it hidden until it
            // can actually draw content (WireSiteViewAsync re-runs the layout).
            if (kv.Value.CoreWebView2 == null) { kv.Value.Visible = false; continue; }
            // The site lives below the bar and never moves: the suggestions
            // panel is drawn by the ui view, which is sized to float ABOVE
            // the site (see below) — like a real browser's dropdown.
            siteActive = true;
            kv.Value.Visible = true;
            kv.Value.Bounds = new Rectangle(siteX, bar, Math.Max(0, W - siteX), Math.Max(0, H - bar));
        }
        // Фокус-режим без сайта (на «Рабочем столе») смысла не имеет: полоса
        // вернётся сама, как только активной станет вкладка 0.
        if (focusMode && !siteActive) SetFocusMode(false);
        // The dropdown layer only ever floats above a site tab; on the home
        // desktop the ui view covers the whole window and its own panel
        // draws the suggestions.  (Shown/positioned by HandleSuggests.)
        if (!siteActive && panelView != null && !panelView.IsDisposed && panelView.Visible)
            HidePanelLayer();
        // The ui view is always the top layer.  On a site it shrinks to just
        // the bar so the mouse reaches the site everywhere else — EXCEPT while
        // the suggest panel is open: then it stretches over the whole window
        // with a transparent body (the site shows through), so the dropdown
        // can never be clipped by the view edge no matter how it scrolls.
        // On the home desktop it is simply the whole window.
        if (ui != null && !ui.IsDisposed)
        {
            int uiH = H;
            // uiHeldFull: крест-фейд «десктоп → сайт» — см. HoldUiFullForHomeFade.
            if (siteActive && overlayCss <= 0 && !uiHeldFull)
                uiH = verticalTabs ? H : BarHeight;   // колонка занимает всю высоту
            // Вертикальные вкладки: шеллу принадлежит колонка слева, а сайт
            // начинается за ней — подсказки омнибокса рисуются ВЫШЕ сайта в
            // правой части, поэтому ширина шелла = W - side (не 260).
            int uiW = side > 0 ? Math.Max(0, W - side) : W;
            // Фокус-режим: полосы нет вовсе — вьюху шелла прячем целиком,
            // иначе её прозрачное (но живое) окно осталось бы поверх сайта.
            ui.Visible = !focusMode;
            // Dock = Fill (set at creation) would re-stretch the view over the
            // whole client area on every layout pass and bury the site under
            // the page's dark body again — explicit bounds need Dock off.
            if (ui.Dock != DockStyle.None) ui.Dock = DockStyle.None;
            ui.Bounds = new Rectangle(0, 0, uiW, uiH);
            // Layering, bottom to top: sites, then the dropdown layer, then
            // the ui bar.  BringToFront order matters, so panel goes first.
            if (panelView != null && !panelView.IsDisposed && panelView.IsHandleCreated)
                Win.RaiseNoActivate(panelView.Handle);
            if (ui != null && !ui.IsDisposed && ui.IsHandleCreated)
                Win.RaiseNoActivate(ui.Handle);
        }
    }

    // User-initiated closes (bridge "close", Ctrl+W) remember the tab so
    // Ctrl+Shift+T can bring it back; the automatic popup cascade does not.
    // Drag & drop вкладки в стрипе: шелл считает финальную позицию и шлёт
    // {"type":"reorder", id, index}, где index — позиция среди САЙТОВЫХ
    // вкладок (0..n-1, «Рабочий стол» не считается: он всегда первый).
    // Авторитетный порядок держит хост: переставили в списке — отдали новый
    // tabs-push, стрип и glider пересоберутся по нему.
    private void Push(object message)
    {
        if (ui == null || ui.IsDisposed || ui.CoreWebView2 == null) return;
        string js;
        try { js = JsonSerializer.Serialize(message); }
        catch (Exception ex) { DebugLog("push serialize failed " + ex.Message); return; }
        try { ui.CoreWebView2.PostWebMessageAsJson(js); }
        catch (Exception ex) { DebugLog("push post failed len=" + js.Length + " " + ex.Message); }
    }

    // Полоса «Перевести страницу»: язык проверяет Translator (эвристика по
    // Cyrillic/dokument.lang), решение пользователя не перебиваем.  Мост
    // уходит только если вкладка всё ещё активна и url не сменился, пока
    // шла проба: иначе полоса показалась бы под чужой страницей.
    private async Task MaybeOfferTranslateAsync(TabPage page, WebView2 view)
    {
        try
        {
            var url = page.Url;
            if (!await Translator.MaybeOfferAsync(view.CoreWebView2, page.Id, url, DebugLog)) return;
            if (closing || !page.Alive || view.IsDisposed) return;
            if (page.Id != activeId) return;
            // Source мог уйти дальше (SPA/редирект), пока проба считала текст.
            try { if (!string.Equals(view.CoreWebView2?.Source, url, StringComparison.Ordinal)) return; } catch { return; }
            DebugLog("translate offer id=" + page.Id + " " + url);
            Push(new { type = "translate-offer", id = page.Id, url = page.Url });
        }
        catch (Exception ex) { DebugLog("translate offer failed " + ex.Message); }
    }

    // Шелл нажал «Перевести»: забираем видимый текст вкладки напрямую из
    // страницы (ExecuteScriptAsync) и отдаём JSON-строкой в шелл.  Раньше
    // текст ходил по кругу PostWebMessageAsJson -> инжект-скрипт -> хост:
    // тот канал возвращал undefined (слушатель скрипта не срабатывал), и
    // панель всегда писала «не удалось получить текст».  Прямой вызов
    // ExecuteScriptAsync — тот же путь, что у пробы языка в Translator.cs.
    // Полный перевод страницы не делаем — только видимый текст в панель.
    private async void SendSiteTextWanted(int id)
    {
        if (!views.TryGetValue(id, out var v) || v == null || v.IsDisposed || v.CoreWebView2 == null) return;
        string txt;
        try
        {
            var raw = await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){try{var t=(document.body&&document.body.innerText)||'';" +
                "return String(t).slice(0,4000);}catch(e){return '';}})()");
            // ExecuteScriptAsync кодирует результат как JSON-литерал строки
            // (в тексте есть переводы строк и кавычки) — разбираем его.
            try { txt = System.Text.Json.JsonSerializer.Deserialize<string>(raw) ?? ""; }
            catch { txt = ""; }
        }
        catch (Exception ex) { DebugLog("translate text want failed " + ex.Message); return; }
        if (!views.ContainsKey(id)) return; // вкладку закрыли, пока читали текст
        Push(new { type = "site-text", id, text = txt });
    }

    // Raw-JSON push for DownloadManager: it serializes once and fans the
    // message out to every open window (each calls this on its UI thread).
    internal void PostJson(string json)
    {
        if (ui == null || ui.IsDisposed || ui.CoreWebView2 == null) return;
        try { ui.CoreWebView2.PostWebMessageAsJson(json); }
        catch (Exception ex) { DebugLog("push raw failed " + ex.Message); }
    }

    private void PushTabs()
    {
        PushTabs(fast: false);
    }

    // fast: подмена происходит под шторкой (inCurtainSwap) — шелл прячет
    // десктоп без анимации, иначе он «догорал» бы поверх уже видимого сайта.
    private void PushTabs(bool fast)
    {
        // The bridge contract is camelCase (shell reads t.id / t.title ...).
        // PascalCase here silently turned every tab id into 0 client-side and
        // the strip rendered nothing — keep the names in sync with tabs.js.
        Push(new
        {
            type = "tabs",
            activeId,
            fast,
            tabs = tabs.Select(t => new
            {
                id = t.Id,
                title = t.Title,
                url = t.Url,
                favicon = t.Favicon,
                loading = t.Loading,
                accent = t.Accent,
                audible = t.Audible,
                muted = t.Muted,
                // Вкладка выгружена (гибернация): шелл рисует на таблетке
                // «спящий» значок, а страница перезагрузится при активации.
                slept = t.Slept,
            }).ToArray(),
        });
    }

    private void PushNav(TabPage t)
    {
        bool canBack = false, canForward = false, loading = false;
        bool isSite = t != null && t.Id != 0;
        var v = isSite && views.TryGetValue(t.Id, out var w) ? w : null;
        if (v != null && !v.IsDisposed && v.CoreWebView2 != null && t.Ready)
        {
            try { canBack = v.CoreWebView2.CanGoBack; canForward = v.CoreWebView2.CanGoForward; } catch { }
            loading = t.Loading;
        }
        // The address pill in the bar needs the live URL: the tab model can
        // lag a client-side (SPA) navigation until it completes.
        string url = t?.Url ?? "";
        // On the error card the view is about:blank; the model keeps the
        // address that failed so the pill and the retry button still work.
        bool onCard = t != null && errorPageUrls.ContainsKey(t.Id);
        if (v != null && !v.IsDisposed && v.CoreWebView2 != null && !onCard)
            try { url = v.CoreWebView2.Source ?? url; } catch { }
        Push(new { type = "nav", id = t?.Id ?? 0, canBack, canForward, loading, url });
    }
    private async void OnUiResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            if (!new Uri(e.Request.Uri).AbsolutePath.StartsWith("/api")) return; // static files: default handler
            await ShellApi.Handle(ui, e, DebugLog);
        }
        catch (Exception ex) { DebugLog("api failed " + ex.Message); }
    }

    private static int IntOr(JsonElement root, string name, int fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)
            ? n : fallback;

    private void OnUiMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string s;
        try { s = e.TryGetWebMessageAsString(); } catch { return; }
        if (string.IsNullOrEmpty(s)) return;

        // Typed gate (Ipc: core layer): not an object / no string "type" —
        // not our traffic, drop before a handler can half-read it.
        if (Ipc.Parse(s, out var type, out var root) != Ipc.ParseResult.Ok) return;
        DebugLog("msg type=" + type + " raw=" + s);
        {
            try
            {
                switch (type)
                {
                    case "open":
                        OpenTab(root.TryGetProperty("url", out var uv) && uv.ValueKind == JsonValueKind.String
                                    ? uv.GetString() : "",
                                root.TryGetProperty("label", out var lv) && lv.ValueKind == JsonValueKind.String
                                    ? lv.GetString() : null);
                        break;
                    case "activate":
                        ActivateAnimated(IntOr(root, "id", 0));
                        break;
                    case "session-answer":
                        // Ответ на «Восстановить вкладки?» после аварийного
                        // выхода: шелл делает свой fade до отправки ответа.
                        _ = AnswerSessionRestoreAsync(root.TryGetProperty("accept", out var sa) && sa.ValueKind == JsonValueKind.True);
                        break;
                    case "accent":
                        // Текущий акцент темы (пришёл из applyTheme): цвет шторы.
                        if (root.TryGetProperty("hex", out var hv) && hv.ValueKind == JsonValueKind.String
                            && TryParseHexColor(hv.GetString(), out var ac))
                            accentColor = ac;
                        if (root.TryGetProperty("hex2", out var hv2) && hv2.ValueKind == JsonValueKind.String
                            && TryParseHexColor(hv2.GetString(), out var ac2))
                            accentColor2 = ac2;
                        // Cyber-палитра: чёрный фон вьюх и резкая шторка.
                        // Шелл присылает cyber ВМЕСТЕ с режимом, но порядок
                        // сообщений не гарантирован: в светлой теме сравнение
                        // с уже сохранённым флагом каждый раз запускало
                        // перерисовку, а перекраска шторы шла от старого
                        // акцента.  Поэтому состояние ставится безусловно, а
                        // перерисовка — только когда оно реально изменилось.
                        bool cyber = root.TryGetProperty("cyber", out var cv) && cv.ValueKind == JsonValueKind.True;
                        accentCyber = cyber;
                        bool nextCyber = accentCyber && darkTheme;
                        if (nextCyber != cyberTheme)
                        {
                            // ApplyThemeMode recomputes cyberTheme from the raw
                            // flag + mode; just repaint through it.
                            ApplyThemeMode(darkTheme);
                        }
                        break;
                    case "reorder":
                        ReorderTab(IntOr(root, "id", 0), IntOr(root, "index", 0));
                        break;
                    case "toggle-mute":
                        ToggleMute(IntOr(root, "id", 0));
                        break;
                    case "focus-mode":
                        ToggleFocusMode();
                        break;
                    case "exit-focus":
                        SetFocusMode(false);
                        break;
                    case "close":
                        CloseTab(IntOr(root, "id", 0));
                        break;
                    case "reopen":
                        // Ctrl+Shift+T with the focus on the shell (id 0): the
                        // host owns the tab list, so it does the work.
                        ReopenLastClosed();
                        break;
                    case "toggle-vertical-tabs":
                        ToggleVerticalTabs();
                        break;
                    case "new-window":
                        OpenNormalWindow();
                        break;
                    case "new-private":
                        OpenPrivateWindow();
                        break;
                    case "nav":
                        var action = root.TryGetProperty("action", out var nv) && nv.ValueKind == JsonValueKind.String
                            ? nv.GetString() : "";
                        var cur = Current;
                        var curV = cur != null && views.TryGetValue(cur.Id, out var ww) ? ww : null;
                        if (curV == null || curV.IsDisposed || curV.CoreWebView2 == null) break;
                        switch (action)
                        {
                            case "back": if (curV.CoreWebView2.CanGoBack) curV.CoreWebView2.GoBack(); break;
                            case "forward": if (curV.CoreWebView2.CanGoForward) curV.CoreWebView2.GoForward(); break;
                            case "reload": curV.CoreWebView2.Reload(); break;
                        }
                        break;
                    case "theme":
                        bool? themeMode = root.TryGetProperty("mode", out var md) && md.ValueKind == JsonValueKind.String
                            ? md.GetString() != "light"
                            : (bool?)null;
                        if (root.TryGetProperty("theme", out var th) && th.ValueKind == JsonValueKind.String)
                        {
                            var json = th.GetString() ?? "{}";
                            File.WriteAllText(AppPaths.ThemeFile, json);
                            // Older shell builds only send the JSON; read the
                            // mode and the cyber flag out of it so the window
                            // still follows.
                            try
                            {
                                using var tdoc = JsonDocument.Parse(json);
                                var tr = tdoc.RootElement;
                                if (themeMode == null &&
                                    tr.TryGetProperty("mode", out var m2) &&
                                    m2.ValueKind == JsonValueKind.String)
                                    themeMode = m2.GetString() != "light";
                                // The palette decides the window surface, so this
                                // must land before ApplyThemeMode paints it.
                                // Raw flag only: ApplyThemeMode ANDs it with the
                                // mode (night-city ships cyber:true even when the
                                // mode is light).
                                accentCyber = tr.TryGetProperty("cyber", out var cy) &&
                                              cy.ValueKind == JsonValueKind.True;
                                if (tr.TryGetProperty("accent", out var ta) && ta.ValueKind == JsonValueKind.String)
                                    TryParseHexColor(ta.GetString(), out accentColor);
                                if (tr.TryGetProperty("accentSoft", out var tb) && tb.ValueKind == JsonValueKind.String)
                                    TryParseHexColor(tb.GetString(), out accentColor2);
                            }
                            catch { /* malformed theme: keep the current mode */ }
                        }
                        ApplyThemeMode(themeMode ?? darkTheme);
                        break;
                    case "newwin":
                        new MainForm().Show();
                        break;
                    case "translate-text":
                        // Шелл показывает панель перевода и просит текст сайта.
                        SendSiteTextWanted(IntOr(root, "id", 0));
                        break;
                    case "trans-page":
                        // In-place: собрать узлы, перевести батчем, заменить
                        // текст на странице (без перезагрузки).
                        {
                            var pid = IntOr(root, "id", 0);
                            var pv2 = views.TryGetValue(pid, out var pvv)
                                && pvv != null && !pvv.IsDisposed && pvv.CoreWebView2 != null ? pvv : null;
                            if (pv2 == null) break;
                            _ = HandleTranslatePageAsync(pid, pv2);
                        }
                        break;
                    case "trans-revert":
                        // «Показать оригинал»: откат заменённого текста.
                        {
                            var rid = IntOr(root, "id", 0);
                            var rv2 = views.TryGetValue(rid, out var rvv)
                                && rvv != null && !rvv.IsDisposed && rvv.CoreWebView2 != null ? rvv : null;
                            if (rv2 == null) break;
                            _ = HandleTransRevertAsync(rid, rv2);
                        }
                        break;
                    case "perm-answer":
                        // Ответ на диалог пермиссии: разрешить/запретить.
                        AnswerPerm(
                            IntOr(root, "id", -1),
                            root.TryGetProperty("allow", out var pa) && pa.GetBoolean());
                        break;
                    case "translate-dismiss":
                        // Полосу перевода закрыли («✕») или уже перевели:
                        // по этому url в этой вкладке больше не предлагаем.
                        Translator.Dismiss(
                            IntOr(root, "id", 0),
                            root.TryGetProperty("url", out var tu) && tu.ValueKind == JsonValueKind.String
                                ? tu.GetString() : "");
                        break;
                    case "overlay":
                        var css = IntOr(root, "height", 0);
                        if (css != overlayCss) { overlayCss = css; LayoutSiteViews(); }
                        break;
                    case "find":
                        // Поиск по странице (Ctrl+F → findbar.js): гоняем
                        // window.find в САЙТ-ВЬЮХЕ активной вкладки.  Результат
                        // (число совпадений) возвращается шеллу отдельным пушем.
                        {
                            var fq = root.TryGetProperty("q", out var fqq) && fqq.ValueKind == JsonValueKind.String
                                ? fqq.GetString() : "";
                            bool back = root.TryGetProperty("back", out var fb) && fb.GetBoolean();
                            bool wantCount = root.TryGetProperty("count", out var fc) && fc.GetBoolean();
                            var fv = Current != null && views.TryGetValue(Current.Id, out var fvv)
                                && fvv != null && !fvv.IsDisposed && fvv.CoreWebView2 != null ? fvv : null;
                            if (fv == null || string.IsNullOrEmpty(fq)) break;
                            _ = HandleFindAsync(fv, fq, back, wantCount);
                        }
                        break;
                    case "suggests":
                        HandleSuggests(root);
                        break;
                    case "menu":
                        HandleMenu(root);
                        break;
                    case "drag": Win.Drag(Handle); break;
                    case "mini": WindowState = FormWindowState.Minimized; break;
                    case "maxi":
                        MaximizedBounds = Screen.FromControl(this).WorkingArea;
                        WindowState = WindowState == FormWindowState.Maximized
                            ? FormWindowState.Normal : FormWindowState.Maximized;
                        LayoutSiteViews();
                        break;
                    case "closeapp": Close(); break;
                    case "download-cmd":
                        // pause | resume | cancel | open | show — all in the manager.
                        DownloadManager.Command(
                            IntOr(root, "id", -1),
                            root.TryGetProperty("cmd", out var dc) && dc.ValueKind == JsonValueKind.String
                                ? dc.GetString() : "");
                        break;
                    case "ready":
                        PushTabs();
                        PushNav(Current);
                        // The (re)loaded page has no download state yet: replay
                        // the persisted list so the panel rebuilds itself.
                        DownloadManager.PushAll();
                        // Диагностика восстановления: если маркер сбоя ждёт
                        // ответа — повторяем вопрос (первое сообщение могло
                        // уйти до готовности страницы).
                        if (pendingSessionUrls != null)
                            Push(new { type = "session-restore", count = pendingSessionUrls.Length });
                        // Невидимая перепроверка UI/API (LIVEBROWSER_PROBE=1):
                        // всё выполняется внутри шелла, окно не открывается и
                        // не фотографируется.  Приватное окно открывает сам
                        // зонд новым окном: его чип уже пришёл, а общий
                        // прогон в debug.log повторился бы (в том числе с
                        // "restore" из чужой сессии).
                        if (privateMode) Push(new { type = "private", on = true });
                        else if (Environment.GetEnvironmentVariable("LIVEBROWSER_PROBE") == "1")
                            _ = RunShellProbeAsync();
                        // Режим полосы: каждому (пере)загруженному шеллу, иначе
                        // после перезагруженной страницы вкладки повернутся
                        // обратно, а колонка останется.
                        if (verticalTabs) Push(new { type = "vertical-tabs", on = true });
                        break;
                }
            }
            catch (Exception ex) { DebugLog("msg failed " + type + ": " + ex.Message); }
        }
    }

    // Bridge "suggests" (shell -> host): while a site tab is active the shell's
    // local suggestion panel paints nothing, and the omnibox asks this native
    // dropdown layer (panelView) to take over.  Geometry arrives in client CSS
    // px measured on the shell page; the shell page fills the window, so CSS px
    // scale 1:1 with the client area at DeviceDpi/96.
    // One hide path for the shared dropdown layer (suggestions + gear menu).
    // The page keeps its rows between shows; telling it the layer went away
    // makes the next open cascade like an opening instead of a keystroke
    // refill (dropdown.js keeps `lastQuery` for exactly that distinction).
    // One hide path for the shared dropdown layer (suggestions + gear menu).
    // The page keeps its rows between shows; telling it the layer went away
    // makes the next open cascade like an opening instead of a keystroke
    // refill (dropdown.js keeps `lastQuery` for exactly that distinction).
    private void HidePanelLayer()
    {
        bool wasVisible = panelView != null && !panelView.IsDisposed && panelView.Visible;
        if (panelView != null && !panelView.IsDisposed)
            panelView.Visible = false;
        if (!wasVisible || panelReady == false || panelView?.CoreWebView2 == null) return;
        try { panelView.CoreWebView2.PostWebMessageAsJson("{\"layer-hidden\":true}"); }
        catch { /* controller gone */ }
    }


    private void HandleSuggests(JsonElement root)
    {
        bool open = root.TryGetProperty("open", out var ov) && ov.ValueKind == JsonValueKind.True;
        if (panelView == null || panelView.IsDisposed) return;
        if (!open || closing)
        {
            HidePanelLayer();
            return;
        }

        // Nothing to show (no rows, dropdown page not loaded yet, controller
        // still initializing): stay hidden — a blank rectangle over the site
        // would be worse than no dropdown.  Open tabs count too: they are
        // local data and render even when Yandex is unreachable.
        int itemCount = root.TryGetProperty("items", out var itemsEl) && itemsEl.ValueKind == JsonValueKind.Array
            ? itemsEl.GetArrayLength() : 0;
        int tabCount = root.TryGetProperty("tabRows", out var tabsEl) && tabsEl.ValueKind == JsonValueKind.Array
            ? tabsEl.GetArrayLength() : 0;
        if (itemCount == 0 && tabCount == 0) return;
        if (!panelReady || panelView.CoreWebView2 == null) return;

        double scale = DeviceDpi / 96.0;
        int l = (int)Math.Round(IntOr(root, "l", 0) * scale);
        int t = (int)Math.Round(IntOr(root, "t", 0) * scale);
        int w = (int)Math.Round(IntOr(root, "w", 0) * scale);
        int h = (int)Math.Round(IntOr(root, "h", 0) * scale);
        if (w <= 0 || h <= 0) { HidePanelLayer(); return; }
        // Clamp into the client area so a stray value can never push the
        // layer outside the window.
        int W = ClientSize.Width, H = ClientSize.Height;
        if (l < 0) l = 0;
        if (t < 0) t = 0;
        if (l + w > W) w = Math.Max(1, W - l);
        if (t + h > H) h = Math.Max(1, H - t);

        panelView.Bounds = new Rectangle(l, t, w, h);
        // Регион скругляет САМУ вьюху: вне карточки (радиус 12px) вьюхи нет —
        // ни пикселей, ни кликов.  Углы всегда показывают сайт, независимо
        // от прозрачности вьюхи и состояния её фона.
        Win.RoundChild(panelView.Handle, w, h, (int)Math.Round(12 * scale));
        panelView.Visible = true;
        // Keep the layering (sites < panel < ui bar) even if a site view was
        // fronted after the last layout pass.
        Win.RaiseNoActivate(panelView.Handle);
        if (ui != null) Win.RaiseNoActivate(ui.Handle);

        // Relay the rows to the dropdown page (full re-render there is fine).
        string query = root.TryGetProperty("query", out var qv) && qv.ValueKind == JsonValueKind.String
            ? qv.GetString() : "";
        try
        {
            string js = JsonSerializer.Serialize(new
            {
                items = itemsEl.ValueKind == JsonValueKind.Array ? itemsEl.Clone() : (JsonElement?)null,
                tabRows = tabsEl.ValueKind == JsonValueKind.Array ? tabsEl.Clone() : (JsonElement?)null,
                active = IntOr(root, "active", -1),
                query,
                mode = darkTheme ? "dark" : "light",
                cyber = cyberTheme && darkTheme,
            });
            panelView.CoreWebView2.PostWebMessageAsJson(js);
        }
        catch (Exception ex) { DebugLog("suggests relay failed " + ex.Message); }
    }

    // Bridge "menu" (shell -> host): the gear search-menu popover (palette
    // swatches, dark/light switch, "all settings") follows the same native
    // layer pattern as "suggests" — over a site tab the shell cannot paint
    // below the bar, so panelView shows the menu from the shell's measured
    // rect.  The same channel carries generic shell menus ("items": burger
    // «Ещё», context, recently closed) — palettes and items are exclusive.
    // Opening the menu over rows (or rows over the menu) simply
    // re-targets the one layer, so the states exclude each other.
    private void HandleMenu(JsonElement root)
    {
        bool open = root.TryGetProperty("open", out var ov) && ov.ValueKind == JsonValueKind.True;
        if (panelView == null || panelView.IsDisposed) return;
        if (!open || closing)
        {
            HidePanelLayer();
            return;
        }
        if (!panelReady || panelView.CoreWebView2 == null) return;

        double scale = DeviceDpi / 96.0;
        int l = (int)Math.Round(IntOr(root, "l", 0) * scale);
        int t = (int)Math.Round(IntOr(root, "t", 0) * scale);
        int w = (int)Math.Round(IntOr(root, "w", 0) * scale);
        int h = (int)Math.Round(IntOr(root, "h", 0) * scale);
        if (w <= 0 || h <= 0) { HidePanelLayer(); return; }
        int W = ClientSize.Width, H = ClientSize.Height;
        if (l < 0) l = 0;
        if (t < 0) t = 0;
        if (l + w > W) w = Math.Max(1, W - l);
        if (t + h > H) h = Math.Max(1, H - t);
        // Верх меню — не выше нижней кромки 56-px полосы шелла: ui-вьюха с
        // баром всегда рисуется ПОВЕРХ нативного слоя, и всё, что выше, ею
        // обрезается («бургер обрезан сверху»).  Меню прижато ВПЛОТНУЮ под
        // бар — ближе к кнопке физически нельзя.  Нижняя кромка сохраняется:
        // сдвиг компенсируется высотой.  Канал «suggests» не трогаем: панель
        // подсказок специально выглядывает из-под бара.
        int barTop = (int)Math.Round(56 * scale);
        if (t < barTop)
        {
            h -= barTop - t;
            t = barTop;
        }
        if (h <= 0) { HidePanelLayer(); return; }

        panelView.Bounds = new Rectangle(l, t, w, h);
        // Регион скругляет САМУ вьюху: вне карточки (радиус 12px) вьюхи нет —
        // ни пикселей, ни кликов.  Углы всегда показывают сайт, независимо
        // от прозрачности вьюхи и состояния её фона.
        Win.RoundChild(panelView.Handle, w, h, (int)Math.Round(12 * scale));
        panelView.Visible = true;
        Win.RaiseNoActivate(panelView.Handle);
        if (ui != null) Win.RaiseNoActivate(ui.Handle);

        // Relay the menu content.  The shell's mode wins when present: a
        // dark/light pick can arrive before its follow-up "theme" message.
        // items (generic menu) go through untouched — dropdown.js renders
        // them as .lb-menu-item rows; shell's LiveMenu.runItem executes.
        string mode = root.TryGetProperty("mode", out var mv) && mv.ValueKind == JsonValueKind.String
            ? mv.GetString() : (darkTheme ? "dark" : "light");
        JsonElement? palettes = root.TryGetProperty("palettes", out var pal) && pal.ValueKind == JsonValueKind.Array
            ? pal.Clone() : null;
        JsonElement? items = root.TryGetProperty("items", out var itms) && itms.ValueKind == JsonValueKind.Array
            ? itms.Clone() : (JsonElement?)null;
        try
        {
            string js = JsonSerializer.Serialize(new
            {
                menu = true,
                mode,
                isLight = mode != "dark",
                cyber = cyberTheme && mode == "dark",
                index = IntOr(root, "index", 0),
                palettes,
                items,
            });
            panelView.CoreWebView2.PostWebMessageAsJson(js);
        }
        catch (Exception ex) { DebugLog("menu relay failed " + ex.Message); }
    }

    // panelView -> host.  'panel-ready' arms the layer (the page is loaded
    // and will not show blank); 'pick' forwards a chosen suggestion to the
    // shell, which runs the same search jump a local pick would have.
    private void OnPanelMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string s;
        try { s = e.TryGetWebMessageAsString(); } catch { return; }
        if (string.IsNullOrEmpty(s)) return;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(s); } catch { return; }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            var type = root.TryGetProperty("type", out var tv) && tv.ValueKind == JsonValueKind.String
                ? tv.GetString() : "";
            if (type == "panel-ready") { panelReady = true; return; }
            if (type == "pick")
            {
                var value = root.TryGetProperty("value", out var vv) && vv.ValueKind == JsonValueKind.String
                    ? vv.GetString() : "";
                if (!string.IsNullOrEmpty(value))
                    Push(new { type = "suggest-pick", value });
            }
            if (type == "pick-tab")
            {
                // Open-tab row in the native dropdown: switch directly (same
                // path as clicking the tab in the strip — штора включается).
                HidePanelLayer();
                ActivateAnimated(IntOr(root, "id", 0));
            }
            if (type == "menu-pick")
            {
                // A menu item was picked in panelView (palette swatch /
                // mode tab / "all settings" / generic items row): forward it
                // to the shell, which applies the change and answers with a
                // fresh "menu" message (open again, new index/mode), runs
                // LiveMenu.runItem ("item") or closes the layer (settings).
                // Исключение — ОТКРЫТОЕ КОНТЕКСТНОЕ МЕНЮ: его пункты
                // исполняются хостом (ExecuteCtxAction), шелл не участвует.
                string action = root.TryGetProperty("action", out var av) && av.ValueKind == JsonValueKind.String
                    ? av.GetString() : "";
                var idxPick = IntOr(root, "index", -1);
                if (ctxOpen && action == "item" && idxPick >= 0 && idxPick < ctxActions.Count)
                {
                    var act = ctxActions[idxPick];
                    ctxOpen = false;
                    var cp = Current;
                    var cvp = cp != null && views.TryGetValue(cp.Id, out var cvv) ? cvv : null;
                    ExecuteCtxAction(act, cp, cvp);
                    return;
                }
                ctxOpen = false;
                if (!string.IsNullOrEmpty(action))
                    Push(new { type = "menu-pick", action, index = IntOr(root, "index", -1) });
            }
        }
    }

    // Поля контекстного меню сайта: открыт ли оно и список действий
    // текущего меню (индекс пункта → строка-команда).
    private readonly List<string> ctxActions = new();
    private bool ctxOpen;

    // Состояние открытого контекстного меню (для перестройки, когда придёт
    // фоновый ответ PiP-детектора) и кэш «есть ли на странице видео»:
    // ключ — адрес документа, значение — найден ли кандидат.  Кэш живёт
    // сеанс, ограничен по количеству: страницы SPA меняют адрес на каждый
    // шаг, и без капа словарь рос бы бесконечно.
    private TabPage ctxPage;
    private WebView2 ctxView;
    private Point ctxAt;
    private bool ctxLink;
    private bool ctxHasVideo;
    private bool ctxVideoDone;
    private string ctxVideoKey = "";
    private const int CtxVideoCacheCap = 200;
    private static readonly Dictionary<string, bool> ctxVideoCache = new(StringComparer.Ordinal);

}
