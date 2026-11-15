using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace LiveBrowser;

/// <summary>
/// Определение языка страницы для полосы «Перевести страницу» (как в Chrome).
/// Хост НИЧЕГО не переводит сам: он только решает, предложить ли перевод,
/// и через мост просит шелл показать полосу.  Перевод — по кнопке
/// пользователя через /api/translate (ShellApi.cs).
///
/// Эвристика:
///   * http(s) без фрагмента — единственное, что вообще предлагаем
///     (about:blank, наши error-карточки, livebrowser.shell — пропуск);
///   * document.documentElement.lang = ru — молчим;
///   * доля кириллицы > 25% в образце (первые ~200 слов) — считаем русским,
///     молчим.  Доли хватает: язык страницы — это не «есть ли русские буквы»,
///     а «каких букв больше»;
///   * пустая страница (меньше 40 букв латиницы/кириллицы) — молчим.
///
/// Повторно по одному url не пристаём: dismissed-ключи хранятся здесь
/// (bridge "translate-dismiss" из MainForm.OnUiMessage).
/// </summary>
internal static class Translator
{
    // Страницы короче этого (букв) язык не определить — предложение не показываем.
    private const int MinLetters = 40;
    // Сколько первых слов (по пробелам) отдаём на подсчёт доли кириллицы.
    private const int SampleWords = 200;
    // Доля кириллицы, выше которой страница считается русской.
    private const double CyrillicShare = 0.25;
    // Ключей в dismissed не накапливаем бесконечно.
    private const int MaxDismissed = 500;

    // "tabId|url" в нижнем регистре — по этой странице больше не предлагаем.
    private static readonly HashSet<string> dismissed = new(StringComparer.Ordinal);
    private static readonly object dismissedLock = new();

    // Скрипт-проба: язык документа + образец начала текста.  Возвращает JSON
    // {lang:"ru"|"en"|..., latin, cyr} — главное для решения.  innerText
    // может быть дорогим на огромных страницах, поэтому берём только
    // document.body первой и сразу режем — eval не строит копию DOM.
    private static readonly string ProbeScript =
        "(function(){try{" +
        "var lang=(document.documentElement.lang||'')+" +
        "'|'+((document.documentElement.getAttribute('xml:lang'))||'');" +
        "var t='';try{t=(document.body&&document.body.innerText)||'';}catch(_){t='';}" +
        // Достаточно начала страницы: подвал/меню в конце не нужны, а
        // innerText уже отдаёт видимый текст без скриптов и стилей.
        "t=t.slice(0,200000).split(/\\s+/).slice(0," + SampleWords + ").join(' ');" +
        "var cyr=0,latin=0;" +
        "for(var i=0;i<t.length;i++){var c=t.charCodeAt(i);" +
        "if((c>=0x0400&&c<=0x04FF)||c===0x0451||c===0x0401)cyr++;" +
        "else if((c>=0x41&&c<=0x5A)||(c>=0x61&&c<=0x7A)||" +
        "(c>=0x00C0&&c<=0x024F))latin++;}" +
        "return JSON.stringify({lang:lang,latin:latin,cyr:cyr});" +
        "}catch(e){return JSON.stringify({lang:'',latin:0,cyr:0});}})();";

    /// <summary>
    /// Решает, предложить ли перевод этой страницы.  В сеть/шелл ничего не
    /// шлёт; MainForm.ShowTranslateOfferAsync публикует мост-сообщение.
    /// Возвращает false при любой ошибке — лучше промолчать, чем мигать полосой.
    /// </summary>
    public static async Task<bool> MaybeOfferAsync(CoreWebView2 view, int tabId, string url, Action<string> log)
    {
        if (view == null) return false;
        if (!IsHttpUrl(url)) return false;
        if (IsDismissed(tabId, url)) return false;

        string json;
        try { json = await view.ExecuteScriptAsync(ProbeScript); }
        catch (Exception ex)
        {
            log?.Invoke("translate probe failed: " + ex.Message);
            return false;
        }

        // ExecuteScriptAsync JSON-кодирует результат: строка вида "\"{...}\"".
        if (string.IsNullOrEmpty(json)) return false;
        try
        {
            using var outer = JsonDocument.Parse(json);
            if (outer.RootElement.ValueKind != JsonValueKind.String) return false;
            var inner = outer.RootElement.GetString();
            if (string.IsNullOrWhiteSpace(inner)) return false;
            using var probe = JsonDocument.Parse(inner);
            var root = probe.RootElement;
            var lang = Prop(root, "lang") ?? "";
            int latin = IntProp(root, "latin");
            int cyr = IntProp(root, "cyr");

            // lang может прийти как "ru|ru" (lang + xml:lang).
            foreach (var part in lang.Split('|'))
            {
                var code = part.Trim().ToLowerInvariant();
                if (code.Length < 2) continue;
                if (code.StartsWith("ru")) return false;
                // Иностранный lang известен — предложение почти наверняка уместно,
                // но всё равно требуем осмысленный текст: пустые заставки/
                // галереи со lang="en" не должны открывать полосу.
                if (LatinAndCyrillic(latin, cyr) >= MinLetters) return true;
            }

            int total = LatinAndCyrillic(latin, cyr);
            if (total < MinLetters) return false;
            double share = (double)cyr / total;
            if (share > CyrillicShare) return false;
            log?.Invoke("translate offer: cyr=" + (share * 100).ToString("0") + "% latin=" + latin);
            return true;
        }
        catch (Exception ex)
        {
            log?.Invoke("translate probe parse failed: " + ex.Message);
            return false;
        }
    }

    /// <summary>
    /// Страница показана пользователю и он её закрыл («✕» или уже перевёл):
    /// больше по этому url в этой вкладке не предлагаем.
    /// </summary>
    public static void Dismiss(int tabId, string url)
    {
        var key = Key(tabId, url);
        if (key == null) return;
        lock (dismissedLock)
        {
            if (dismissed.Count >= MaxDismissed)
            {
                // Простая чистка: набор маленький, страницы живут недолго.
                dismissed.Clear();
            }
            dismissed.Add(key);
        }
    }

    private static bool IsDismissed(int tabId, string url)
    {
        var key = Key(tabId, url);
        if (key == null) return false;
        lock (dismissedLock) return dismissed.Contains(key);
    }

    private static string Key(int tabId, string url)
    {
        if (tabId == 0 || string.IsNullOrWhiteSpace(url)) return null;
        // Сравниваем без фрагмента: #якорь — та же страница.
        var u = url.Trim();
        int hash = u.IndexOf('#');
        if (hash >= 0) u = u.Substring(0, hash);
        return tabId + "|" + u.ToLowerInvariant();
    }

    private static int LatinAndCyrillic(int latin, int cyr) => latin + cyr;

    private static bool IsHttpUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
        // Наша страница-карточка ошибки и рабочий стол — не «иностранные сайты».
        return !uri.Host.Equals("livebrowser.shell", StringComparison.OrdinalIgnoreCase);
    }

    private static string Prop(JsonElement root, string name)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static int IntProp(JsonElement root, string name)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number &&
           v.TryGetInt32(out var n) ? n : 0;
}
