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

// Site-side half of MainForm (partial): everything that talks to a site page —
// keys, find, translate, the error card, context menu, permissions, zoom.
internal sealed partial class MainForm
{
    private async Task HandleFindAsync(WebView2 v, string q, bool back, bool wantCount)    {
        try
        {
            var jq = System.Text.Json.JsonSerializer.Serialize(q);
            var script = wantCount
                ? $"window.__lbCount({jq})"
                : $"window.__lbFind({jq},{(back ? "true" : "false")})";
            var res = await v.CoreWebView2.ExecuteScriptAsync(script);
            var n = long.TryParse(res?.Trim(), out var nn) ? nn : 0;
            Push(new { type = "find-result", n });
        }
        catch { /* страница закрылась / навигация */ }
    }

    // In-place перевод страницы: соберём уникальные тексты узлов, переведём
    // батчем (ShellApi.TranslateBatch, до 80 узлов / 8000 символов) и вернём
    // на страницу парами «оригинал→перевод» — без перезагрузки и без ключей.
    // Оригинал хранится на странице (__lbTrans.revert откатывает).
    private async Task HandleTranslatePageAsync(int id, WebView2 v)
    {
        try
        {
            var raw = await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify(window.__lbTrans?window.__lbTrans.texts():[])");
            string arr = raw?.Trim() ?? "\"[]\"";
            // ExecuteScript возвращает JSON-представление результата: строка
            // приехала двойно-закодированной — разворачиваем один раз.
            using (var doc = System.Text.Json.JsonDocument.Parse(arr))
            {
                if (doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.String)
                    arr = doc.RootElement.GetString() ?? "[]";
            }
            var texts = new List<string>();
            int total = 0;
            using (var doc = System.Text.Json.JsonDocument.Parse(arr))
            {
                if (doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    foreach (var el in doc.RootElement.EnumerateArray())
                    {
                        if (el.ValueKind != System.Text.Json.JsonValueKind.String) continue;
                        var t = el.GetString() ?? "";
                        if (t.Length < 3 || total + t.Length > 8000 || texts.Count >= 80) continue;
                        texts.Add(t);
                        total += t.Length;
                    }
                }
            }
            if (texts.Count == 0)
            {
                Push(new { type = "trans-page-done", id, count = 0 });
                return;
            }
            var translated = await ShellApi.TranslateBatch(texts.ToArray(), "ru", "auto",
                m => DebugLog("trans page: " + m));
            var pairs = new List<object>();
            for (int i = 0; i < texts.Count; i++)
            {
                var r = (translated[i] ?? "").Trim();
                if (r.Length > 0 && r != texts[i]) pairs.Add(new { t = texts[i], r });
            }
            if (pairs.Count == 0)
            {
                Push(new { type = "trans-page-done", id, count = 0 });
                return;
            }
            var json = System.Text.Json.JsonSerializer.Serialize(pairs);
            var swapped = await v.CoreWebView2.ExecuteScriptAsync(
                $"window.__lbTrans.apply({json})");
            var count = long.TryParse(swapped?.Trim(), out var c1) ? c1 : 0;
            Push(new { type = "trans-page-done", id, count });
        }
        catch (Exception ex)
        {
            DebugLog("trans page failed " + ex.Message);
            Push(new { type = "trans-page-done", id, count = -1 });
        }
    }

    // «Показать оригинал»: откат in-place перевода.
    private async Task HandleTransRevertAsync(int id, WebView2 v)
    {
        try
        {
            await v.CoreWebView2.ExecuteScriptAsync("window.__lbTrans?window.__lbTrans.revert():0");
            Push(new { type = "trans-reverted", id });
        }
        catch { }
    }


    // Chromium's own error page is a grey slab that ignores the theme and looks
    // broken next to the shell.  Ours is a quiet card in the current palette:
    // what happened, the address, one retry button — no red banners, no noise.
    // tab id -> адрес, который показывает карточка ошибки.
    private readonly Dictionary<int, string> errorPageUrls = new();
    // Bumped by every navigation outcome IN THAT TAB: a delayed error-card
    // check only fires when its token is still the latest for its own tab
    // (see NavigationCompleted).  It used to be one counter for the whole
    // window, so a *different* tab finishing a load cancelled the check —
    // a tab whose DNS failed while the neighbour opened normally was left
    // with Chromium's grey slab and no card at all.
    private readonly Dictionary<int, int> errorCheckSeq = new();
    private int NextErrorToken(int id)
    {
        errorCheckSeq.TryGetValue(id, out var n);
        errorCheckSeq[id] = ++n;
        return n;
    }
    // True while the tab's view shows the custom error card (about:blank).
    private bool OnErrorCard(int id) =>
        errorPageUrls.ContainsKey(id) && views.TryGetValue(id, out var v)
        && v != null && !v.IsDisposed && v.CoreWebView2 != null
        && string.Equals(v.CoreWebView2.Source, "about:blank", StringComparison.OrdinalIgnoreCase);
    // Tabs whose next successful navigation is the error card itself
    // (NavigateToString → about:blank), not a page that recovered.
    private readonly HashSet<int> errorCardPending = new();

    private void ShowErrorPage(WebView2 view, TabPage page)
    {
        try
        {
            if (view?.CoreWebView2 == null) return;
            // Prefer the tab's own url: after a failed navigation Source can
            // already read about:blank (the previous NavigateToString), which
            // turned the retry button into a jump to a blank page.
            string url = !string.IsNullOrEmpty(page.PendingUrl) ? page.PendingUrl : (page.Url ?? "");
            try
            {
                var live = view.CoreWebView2.Source;
                if (IsNavigable(live) && !string.Equals(live, "about:blank", StringComparison.OrdinalIgnoreCase))
                    url = live;
            }
            catch { }
            string host;
            try { host = new Uri(url).Host; } catch { host = url; }
            if (string.IsNullOrWhiteSpace(host)) host = "этой страницы";

            bool dark = ThemeBg.R < 128;
            string bg = $"#{ThemeBg.R:x2}{ThemeBg.G:x2}{ThemeBg.B:x2}";
            string fg = dark ? "#f7f7ff" : "#1a1a20";
            string dim = dark ? (cyberTheme ? "#8a8aa8" : "#9a9ab0") : "#5a5a6a";
            string accent = $"#{accentColor.R:x2}{accentColor.G:x2}{accentColor.B:x2}";
            string radius = cyberTheme ? "0px" : "14px";
            // Cyber uses the square, hard-shadowed shell; everything else keeps
            // the soft one so the card does not look pasted in.
            string cardShadow = cyberTheme ? $"8px 8px 0 {bg}" : "0 24px 60px rgba(0,0,0,.28)";
            string font = cyberTheme
                ? "'JetBrains Mono','Cascadia Mono',monospace"
                : "-apple-system,'Segoe UI',system-ui,sans-serif";
            string mark = cyberTheme
                ? $"<span style=\"color:{accent}\">//</span> SIGNAL LOST"
                : "Не удалось открыть страницу";

            string html =
                "<!doctype html><meta charset=utf-8><style>" +
                $"html,body{{height:100%;margin:0;background:{bg};color:{fg};font-family:{font};" +
                "-webkit-font-smoothing:antialiased}" +
                "body{display:flex;align-items:center;justify-content:center;padding:32px;box-sizing:border-box}" +
                ".c{max-width:520px;width:100%;border-radius:" + radius + ";" +
                $"border:1px solid {dim}44;padding:28px 28px 24px;box-shadow:{cardShadow};" +
                "animation:in .22s cubic-bezier(.2,.9,.2,1) both}" +
                "@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}" +
                $"@media (prefers-reduced-motion:reduce){{.c{{animation:none}}}}" +
                $"h1{{font-size:17px;font-weight:600;margin:0 0 10px;letter-spacing:-.01em}}" +
                $"p{{margin:0 0 6px;font-size:13.5px;line-height:1.5;color:{dim}}}" +
                $"code{{font-size:12.5px;color:{fg};word-break:break-all;opacity:.85}}" +
                "form{margin:18px 0 0}" +
                $"button{{font:inherit;font-size:13px;padding:9px 16px;border-radius:{radius};" +
                $"border:1px solid {accent};background:{accent};color:{bg};cursor:pointer;" +
                "transition:transform .12s ease,filter .12s ease}" +
                $"button:hover{{filter:brightness(1.08)}}button:active{{transform:scale(.97)}}" +
                $"@media (prefers-reduced-motion:reduce){{button{{transition:none}}}}" +
                "</style>" +
                "<div class=c>" +
                $"<h1>{mark}</h1>" +
                $"<p>Сайт <code>{System.Net.WebUtility.HtmlEncode(host)}</code> не ответил.</p>" +
                "<p>Проверьте адрес или соединение — остальные вкладки работают как обычно.</p>" +
                $"<form action=\"{System.Net.WebUtility.HtmlEncode(url)}\" method=get><button>Повторить</button></form>" +
                "</div>";
            // Запоминаем, какой адрес прячет карточка: сама карточка —
            // NavigateToString (url about:blank), поэтому «Повторить» не
            // может взять адрес из вьюхи.
            errorPageUrls[page.Id] = url;
            errorCardPending.Add(page.Id);
            // The tab keeps the address it failed on, not about:blank.
            page.Url = url;
            page.Title = ShortTitle(page.Title, url);
            PushTabs();
            PushNav(page);
            view.CoreWebView2.NavigateToString(html);
        }
        catch (Exception ex) { DebugLog("error page failed " + ex.Message); }
    }

    // Maps a shortcut reported by the injected listener to browser actions.
    // Same table as the window and the WinForms KeyDown handler — this path
    // is the one that fires while the page itself owns the keyboard.
    private void HandleSiteHotkey(TabPage page, WebView2 view, string code, bool ctrl, bool shift, bool alt)
    {
        if (closing || page == null || !page.Alive || page.Id != activeId) return;
        var cmd = Hotkeys.Map(code, ctrl, shift, alt, focusMode);
        if (cmd != Hotkeys.Cmd.None) Execute(cmd, page, view);
    }

    /* ---------------------------------------------------------- */
    /* Site tabs                                                    */
    /* ---------------------------------------------------------- */


    private void RememberZoom(WebView2 v)
    {
        try
        {
            if (v?.CoreWebView2 == null) return;
            var host = new Uri(v.CoreWebView2.Source).Host;
            SettingsStore.SetSiteZoom(host, v.ZoomFactor);
        }
        catch { /* best-effort */ }
    }

    // …и применить сохранённый масштаб при попадании на этот хост.
    private void ApplySiteZoom(WebView2 v)
    {
        try
        {
            if (v?.CoreWebView2 == null) return;
            var host = new Uri(v.CoreWebView2.Source).Host;
            var z = SettingsStore.GetSiteZoom(host);
            if (z.HasValue) v.ZoomFactor = z.Value;
        }
        catch { /* best-effort */ }
    }

    // Ожидающие ответа пермиссии: id → (args, deferral, таймер автотаймаута).
    private readonly Dictionary<int, (CoreWebView2PermissionRequestedEventArgs Args, CoreWebView2Deferral Def, System.Windows.Forms.Timer Timer)> permPending = new();
    private int permSeq;

    private void AnswerPerm(int id, bool allow)
    {
        if (!permPending.TryGetValue(id, out var entry)) return;
        permPending.Remove(id);
        try
        {
            entry.Timer.Stop();
            entry.Timer.Dispose();
            entry.Args.State = allow
                ? CoreWebView2PermissionState.Allow
                : CoreWebView2PermissionState.Deny;
            entry.Def.Complete();
        }
        catch (Exception ex) { DebugLog("perm answer failed " + ex.Message); }
    }

    // Исполнение выбранного пункта контекстного меню сайта.
    private void ExecuteCtxAction(string action, TabPage page, WebView2 view)
    {
        try
        {
            var cv = view != null && !view.IsDisposed ? view.CoreWebView2 : null;
            switch (action)
            {
                case "back": if (cv != null && cv.CanGoBack) cv.GoBack(); break;
                case "forward": if (cv != null && cv.CanGoForward) cv.GoForward(); break;
                case "reload": cv?.Reload(); break;
                case "find":
                    if (ui != null && !ui.IsDisposed) ui.Focus();
                    Push(new { type = "find-open" });
                    break;
                case "print": try { _ = cv.ExecuteScriptAsync("window.print()"); } catch { } break;
                case "pip":
                    // webkitEnterFullscreen / requestPictureInPicture доступны
                    // только с жестом пользователя; выбор пункта меню жестом и
                    // является, поэтому запрос идёт сразу, без таймеров.
                    try
                    {
                        _ = cv.ExecuteScriptAsync(
                            "(()=>{const v=[...document.querySelectorAll('video')]" +
                            ".find(x=>x.readyState>0&&!x.disablePictureInPicture);" +
                            "if(!v)return 'novideo';" +
                            "if(document.pictureInPictureElement===v){document.exitPictureInPicture();return 'exit';}" +
                            "v.requestPictureInPicture().then(()=>{},()=>{});return 'enter';})()");
                    }
                    catch { }
                    break;
                case "translate":
                    if (page != null && page.Alive) Push(new { type = "translate-text", id = page.Id });
                    break;
                case "copylink":
                    if (TryCtxLink(out var link))
                    {
                        try { Clipboard.SetText(link); } catch { }
                        Push(new { type = "toast", text = "Ссылка скопирована" });
                    }
                    break;
                case "openlink":
                    if (TryCtxLink(out var link2)) OpenTab(link2, null);
                    break;
            }
        }
        catch (Exception ex) { DebugLog("ctx action failed: " + ex.Message); }
    }

    // Адрес ссылки последнего контекстного меню (ContextMenuTarget.LinkUri).
    private string ctxLinkUri = "";
    private bool TryCtxLink(out string uri)
    {
        uri = ctxLinkUri;
        return !string.IsNullOrWhiteSpace(uri);
    }

    // Пересобирает и (пере)открывает контекстное меню сайта по сохранённому
    // состоянию.  Вызывается сразу по правому клику (с тем, что уже знаем)
    // и повторно, когда фоновый детектор видео принёс ответ.
    private void ShowSiteMenu()
    {
        var cv = ctxView != null && !ctxView.IsDisposed ? ctxView.CoreWebView2 : null;
        if (cv == null) return;
        var list = new List<object>();
        ctxActions.Clear();
        void Add(string label, string action, bool disabled = false)
        {
            if (disabled) { list.Add(new { label, disabled = true }); }
            else list.Add(new { label });
            ctxActions.Add(action);
        }
        Add("Назад", "back", !cv.CanGoBack);
        Add("Вперёд", "forward", !cv.CanGoForward);
        Add("Обновить", "reload");
        list.Add(new { sep = true });
        Add("Перевести страницу", "translate");
        Add("Поиск на странице…", "find");
        // PiP: пункт показываем, только если на странице есть видео (иначе
        // он либо падал бы, либо был вечно серым).
        if (ctxHasVideo) Add("Картинка в картинке", "pip");
        Add("Печать…", "print");
        if (ctxLink)
        {
            list.Add(new { sep = true });
            Add("Копировать адрес ссылки", "copylink");
            Add("Открыть ссылку в новой вкладке", "openlink");
        }

        int mw = 232;
        int mh = list.Count * 30 + 12;
        var payload = JsonSerializer.SerializeToElement(new
        {
            menu = true,
            open = true,
            l = ctxAt.X, t = ctxAt.Y, w = mw, h = mh,
            items = list,
        });
        ctxOpen = true;
        HandleMenu(payload);
    }

    // Фоновый PiP-детектор: страница отвечает через ExecuteScriptAsync, UI-
    // поток этого не ждёт.  Ответ кладётся в кэш по адресу документа, и если
    // меню, из которого мы его спрашивали, всё ещё открыто — перестраивается.
    private async void ProbeVideoAsync(CoreWebView2 cv, TabPage page, string src)
    {
        bool has = false;
        try
        {
            string r = await cv.ExecuteScriptAsync(
                "(()=>{const v=document.querySelectorAll('video');" +
                "return String(Array.prototype.some.call(v,x=>x.readyState>0&&!x.disablePictureInPicture));})()");
            has = r != null && r.Contains("true");
        }
        catch { /* страница не ответила — считаем, что видео нет */ }
        if (closing) return;

        string key = src;
        try { key = cv.Source ?? src; } catch { }
        if (key.Length > 0)
        {
            if (ctxVideoCache.Count >= CtxVideoCacheCap) ctxVideoCache.Clear();
            ctxVideoCache[key] = has;
        }
        // Меню уже закрыли или правый клик пришёл по другой странице — кэш
        // обновили, перестраивать нечего.
        if (!ctxOpen || !ctxVideoDone || !string.Equals(key, ctxVideoKey, StringComparison.Ordinal)) return;
        ctxHasVideo = has;
        if (ctxPage != page || ctxView == null || ctxView.IsDisposed) return;
        try { ShowSiteMenu(); }
        catch (Exception ex) { DebugLog("ctx menu rebuild failed " + ex.Message); }
    }


}
