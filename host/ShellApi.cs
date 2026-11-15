using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LiveBrowser;

/// <summary>
/// Same-origin endpoints for the shell page, served by intercepting WebView2
/// requests on the virtual https://livebrowser.shell host:
///   /api/suggest?part=...   Yandex search suggestions (relay, no CORS issues)
///   /api/theme  GET/POST    palette + window settings next to the exe
///   /api/settings GET/POST  browser settings.json next to the exe
///   (GET returns the whole file; POST partial-merges the body into it —
///   deep merge for object properties like "downloads" — and persists it;
///   the host readers are lazy, so the new values apply on their next read)
///   quickLinks (плитки рабочего стола shell'а) пробрасывается насквозь
///   без разбора: shell шлёт массив ЦЕЛИКОМ, чистку делает SettingsStore
///   /api/history        GET ?q=&limit=   visit history {items:[{t,url,title}]}
///   /api/history/clear  POST            empty the history
///   /api/history/remove POST {url}      drop one url
///   /api/cookies        GET             {count} for the active site
///   /api/data/clear     POST {what}     cache | cookies | history | all
///   /api/engine?q=      GET             {url} of the search result page
///   /api/status         GET             history / cookies / cache / mem
    ///   /api/translate      GET ?text=&to=ru|en&sl=auto|xx   перевод: Google
    ///   gtx, при любой его ошибке — MyMemory (fallback внутри Translate);
    ///   {ok:true,text} / {ok:false,error}; кэш на (text,sl,to), бюджет ~15 с
/// </summary>
internal static class ShellApi
{
    // Один обработчик соединений на все исходящие запросы хоста.  Пул 8 на
    // сервер: погода, курс, переводы и иконки не выстраиваются в очередь из
    // пары keep-alive сокетов (у .NET по умолчанию их два).  Соединение
    // принудительно переживается заново раз в 5 минут: браузер живёт сутками,
    // и сокет, закрытый на той стороне, иначе даёт один «пустой» запрос.
    private static readonly SocketsHttpHandler Pool = new()
    {
        MaxConnectionsPerServer = 8,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        AutomaticDecompression = DecompressionMethods.All,
    };

    // Клиенты делят пул и различаются только таймаутом.
    private static HttpClient Client(TimeSpan timeout) =>
        new(Pool, disposeHandler: false) { Timeout = timeout };

    // Тот же пул для вызовов снаружи (загрузка списка блокировки): один
    // handler — один бюджет соединений, а не два.
    internal static HttpClient NewClient(TimeSpan timeout) => Client(timeout);

    private static readonly HttpClient Http = Client(TimeSpan.FromSeconds(6));

    // Курс ЦБ: страница XML_daily.asp ~60 КБ на чужом (иногда медленном)
    // сервере, а перевод на том же пуле получает 6 с.  Свой таймаут с
    // запасом, чтобы «курс» не превращался в ложное «не получено».
    private static readonly HttpClient RateHttp = Client(TimeSpan.FromSeconds(15));

    // Переводы ходят в сеть и повторяются (тултипы, меню), поэтому результат
    // кэшируется на время сеанса.  Порядок вставки — LRU-ish: при переполнении
    // выбрасывается самая старая запись, а попадание в кэш выносит ключ в
    // конец очереди.  Кап — 500 записей; всё под одним замком, а вызовы
    // редкие, поэтому Dictionary + Queue дешевле полноценного LRU.
    private const int TranslateCacheCap = 500;
    private static readonly object TranslateLock = new();
    private static readonly Dictionary<string, string> TranslateCache = new(StringComparer.Ordinal);
    private static readonly Queue<string> TranslateOrder = new();

    // Where the visitor is right now: /api/cookies and /api/status count the
    // cookies of the ACTIVE site, so the host hands over its address.  Set
    // by MainForm on every tab switch ("" = home desktop).
    public static volatile string ActiveUrl = "";

    // True while the shell asking is the private window's copy.  The virtual
    // host name is the same for every window, so the address is the only
    // thing the API can key on when it must withhold private data.
    public static volatile bool PrivateModeRequested = false;

    // Favicon-релей для плиток рабочего стола: /api/favicon?u=<page url> —
    // тянем иконку сайта (u + origin/favicon.ico), отдаём data-url JSON.
    // Кэш в памяти хоста: один сайт — один поход в сеть на сеанс.  Кап — 300
    // хостов, вытеснение FIFO по очереди вставки: за сеанс открывается куда
    // меньше сайтов, но панель ссылок не должна растить словарь бесконечно.
    private const int FaviconCacheCap = 300;
    private static readonly object FaviconLock = new();
    private static readonly Dictionary<string, string> FaviconCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Queue<string> FaviconOrder = new();

    private static bool FaviconTryGet(string host, out string dataUrl)
    {
        lock (FaviconLock) return FaviconCache.TryGetValue(host, out dataUrl);
    }

    private static void FaviconStore(string host, string dataUrl)
    {
        if (string.IsNullOrEmpty(host)) return;
        lock (FaviconLock)
        {
            if (!FaviconCache.ContainsKey(host))
            {
                FaviconOrder.Enqueue(host);
                while (FaviconOrder.Count > FaviconCacheCap)
                    FaviconCache.Remove(FaviconOrder.Dequeue());
            }
            FaviconCache[host] = dataUrl;
        }
    }

    // Общая точка загрузки иконки: и релей /api/favicon, и событие
    // FaviconChanged у вкладки (MainForm) ходят одним клиентом с общим пулом.
    private static readonly HttpClient FaviconHttp = Client(TimeSpan.FromSeconds(5));

    public static Task<byte[]> FetchFaviconAsync(string uri) => FaviconHttp.GetByteArrayAsync(uri);

    public static int FaviconCacheCount { get { lock (FaviconLock) return FaviconCache.Count; } }

    private static string ResponseHeaders(string cacheControl) =>
        "Cache-Control: " + cacheControl + "\r\nAccess-Control-Allow-Origin: *\r\n"
        + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        + "Access-Control-Allow-Headers: Content-Type\r\n";

    public static async Task Handle(WebView2 sender, CoreWebView2WebResourceRequestedEventArgs e, Action<string> log = null)
    {
        var uri = new Uri(e.Request.Uri);
        byte[] body;
        string type;
        int status = 200;
        // Остальные эндпоинты — «здесь и сейчас» (погода, курс, подсказки),
        // кэшировать их в Chromium нельзя.  Иконки — наоборот: data-url по
        // хосту не меняется часами, и повторный проход по плиткам не должен
        // снова ходить в сеть.
        string cacheControl = "no-store";
        var headers = ResponseHeaders(cacheControl);
        // The deferral must be completed AFTER e.Response is assigned: the
        // runtime treats the event as finished the moment Complete() runs, so
        // completing earlier made the page see "Failed to fetch" while the
        // host happily logged a 200 (this silently killed /api/suggest and
        // /api/where).
        CoreWebView2Deferral apiDeferral = null;

        log?.Invoke("api " + e.Request.Method + " " + uri.AbsolutePath);

        // CORS preflight (POST with a JSON body triggers one): answer it here.
        // Without this the browser aborts the real request and the page reports
        // "Не удалось сохранить настройки" while nothing was ever sent.
        if (e.Request.Method == "OPTIONS")
        {
            e.Response = sender.CoreWebView2.Environment.CreateWebResourceResponse(
                null, 204, "No Content", headers);
            return;
        }

        try
        {
            switch (uri.AbsolutePath)
            {
                case "/api/suggest":
                {
                    // Yandex needs a network round-trip before we can answer,
                    // so the event is held open with a deferral.
                    apiDeferral = e.GetDeferral();
                    try { body = await Suggest(uri); }
                    catch { body = Encoding.UTF8.GetBytes("[\"\",[]]"); }
                    type = "application/json; charset=utf-8";
                    break;
                }

                case "/api/theme" when e.Request.Method == "POST":
                {
                    using (var stream = e.Request.Content)
                    using (var ms = new MemoryStream())
                    {
                        stream?.CopyTo(ms);
                        // Themes are tiny; anything bigger is not ours.
                        if (ms.Length > 0 && ms.Length <= 64 * 1024)
                        {
                            var tmp = AppPaths.ThemeFile + ".tmp";
                            File.WriteAllBytes(tmp, ms.ToArray());
                            File.Move(tmp, AppPaths.ThemeFile, true);
                        }
                    }
                    body = Encoding.UTF8.GetBytes("{\"ok\":true}");
                    type = "application/json; charset=utf-8";
                    break;
                }

                case "/api/theme":
                    body = File.Exists(AppPaths.ThemeFile)
                        ? File.ReadAllBytes(AppPaths.ThemeFile)
                        : Encoding.UTF8.GetBytes("null");
                    type = "application/json; charset=utf-8";
                    break;

                // Browser-wide settings (animations, search engine, new-tab
                // page, default zoom, download options).  No deferral needed:
                // the request content is already buffered, so the fragile
                // Complete-after-Response order of the async endpoints above
                // is not involved here.
                //
                // quickLinks (пользовательские плитки рабочего стола) идёт
                // через этот же case насквозь: тело тут не разбирается —
                // слияние патча и чистку массива делает SettingsStore
                // (MergeAndSave -> SanitizeQuickLinks), а GET отдаёт поле
                // обратно как есть.
                case "/api/settings" when e.Request.Method == "POST":
                {
                    using (var stream = e.Request.Content)
                    using (var ms = new MemoryStream())
                    {
                        stream?.CopyTo(ms);
                        // Settings are tiny; anything bigger is not ours.
                        if (ms.Length > 0 && ms.Length <= 64 * 1024)
                        {
                            try
                            {
                                using var patch = JsonDocument.Parse(Encoding.UTF8.GetString(ms.ToArray()));
                                // hideWelcome — пункт «Показать приветствие
                                // снова» в настройках.  Флаг первого запуска
                                // это ФАЙЛ, и знание о нём принадлежит хосту;
                                // сам флаг первым делом пишет Program.Main.
                                //   true  -> снять флаг: интро покажется снова;
                                //   false -> поставить флаг: интро скрыто.
                                // Ключ — команда, а не настройка: флаг живёт в
                                // файле, поэтому в /api/settings он приходит
                                // рядом с патчем, но не внутри settings.json
                                // (здесь он только читается).
                                if (patch.RootElement.TryGetProperty("hideWelcome", out var hideWelcome)
                                    && hideWelcome.ValueKind == JsonValueKind.True)
                                {
                                    var flag = Path.Combine(AppPaths.Root, "firstrun.flag");
                                    if (hideWelcome.GetBoolean()) File.Delete(flag);
                                    else File.WriteAllText(flag, "1");
                                }
                                SettingsStore.MergeAndSave(patch.RootElement);
                            }
                            catch { /* malformed patch: current settings stay */ }
                        }
                    }
                    body = Encoding.UTF8.GetBytes("{\"ok\":true}");
                    type = "application/json; charset=utf-8";
                    break;
                }

                case "/api/settings":
                    body = Encoding.UTF8.GetBytes(SettingsStore.GetJson());
                    type = "application/json; charset=utf-8";
                    break;

                // Visit history (history.jsonl next to the exe).
                //   GET  ?q=...&limit=50  -> {"items":[{"t","url","title"}]}
                case "/api/history":
                {
                    var q = QueryArg(uri.Query, "q");
                    var limit = QueryInt(uri.Query, "limit", 50);
                    var items = History.Search(q, limit).Select(h => new { t = h.T, url = h.Url, title = h.Title }).ToArray();
                    body = JsonSerializer.SerializeToUtf8Bytes(new { items });
                    type = "application/json; charset=utf-8";
                    break;
                }

                case "/api/history/clear" when e.Request.Method == "POST":
                    History.Clear();
                    body = Encoding.UTF8.GetBytes("{}");
                    type = "application/json; charset=utf-8";
                    break;

                case "/api/history/remove" when e.Request.Method == "POST":
                {
                    string url = "";
                    try
                    {
                        using var stream = e.Request.Content;
                        using var ms = new MemoryStream();
                        stream?.CopyTo(ms);
                        if (ms.Length > 0 && ms.Length <= 64 * 1024)
                        {
                            using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(ms.ToArray()));
                            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                                doc.RootElement.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String)
                                url = u.GetString() ?? "";
                        }
                    }
                    catch { /* malformed body: nothing to remove */ }
                    History.Remove(url);
                    body = Encoding.UTF8.GetBytes("{}");
                    type = "application/json; charset=utf-8";
                    break;
                }

                // Cookies of the active site (the SDK has no profile-wide
                // enumeration): {"count":N}
                case "/api/cookies":
                {
                    apiDeferral = e.GetDeferral();
                    int count = 0;
                    try { count = await DataStore.CookieCountAsync(ActiveUrl); } catch { }
                    body = JsonSerializer.SerializeToUtf8Bytes(new { count });
                    type = "application/json; charset=utf-8";
                    break;
                }

                // {"what":"cache"|"cookies"|"history"|"all"} -> {"ok":true}
                case "/api/data/clear" when e.Request.Method == "POST":
                {
                    string what = "";
                    try
                    {
                        using var stream = e.Request.Content;
                        using var ms = new MemoryStream();
                        stream?.CopyTo(ms);
                        if (ms.Length > 0 && ms.Length <= 64 * 1024)
                        {
                            using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(ms.ToArray()));
                            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                                doc.RootElement.TryGetProperty("what", out var w) && w.ValueKind == JsonValueKind.String)
                                what = w.GetString() ?? "";
                        }
                    }
                    catch { /* malformed body: nothing to clear */ }
                    apiDeferral = e.GetDeferral();
                    bool ok = false;
                    try { ok = await DataStore.ClearAsync(what); } catch { ok = false; }
                    body = JsonSerializer.SerializeToUtf8Bytes(new { ok });
                    type = "application/json; charset=utf-8";
                    break;
                }

                // The search result page for the engine chosen in settings:
                // {"url":"https://..."} — the host only builds the address, the
                // shell navigates / shows it.  "engine" may override the
                // primary one, "q" is the (raw) query.
                case "/api/engine":
                {
                    var query = QueryArg(uri.Query, "q");
                    var engine = QueryArg(uri.Query, "engine");
                    if (string.IsNullOrWhiteSpace(engine)) engine = SettingsStore.PrimaryEngine();
                    body = JsonSerializer.SerializeToUtf8Bytes(new { url = EngineUrl(engine, query) });
                    type = "application/json; charset=utf-8";
                    break;
                }

                // Блокировка рекламы: GET — счётчики для щита и страницы
                // настроек; POST {action:"update"} — скачать публичный список
                // хостов (AdBlock.UpdateAsync) и ответить, сколько добавилось.
                case "/api/adblock":
                {
                    if (e.Request.Method == "POST")
                    {
                        apiDeferral = e.GetDeferral();
                        body = JsonSerializer.SerializeToUtf8Bytes(await AdBlock.UpdateAsync());
                    }
                    else
                    {
                        body = JsonSerializer.SerializeToUtf8Bytes(new
                        {
                            enabled = SettingsStore.AdBlock(),
                            blocked = AdBlock.SinceNavReset,
                            total = AdBlock.BlockedThisSession,
                            builtin = AdBlock.BuiltinCount,
                            extra = AdBlock.ExtraCount,
                        });
                    }
                    type = "application/json; charset=utf-8";
                    break;
                }

                // The shell has to know which window it is drawing for: a
                // private window shows its badge instead of the session UI.
                case "/api/private":
                    body = JsonSerializer.SerializeToUtf8Bytes(new { on = PrivateModeRequested });
                    type = "application/json; charset=utf-8";
                    break;

                // Data panel numbers for the "Оптимизация" page.
                case "/api/status":
                {
                    apiDeferral = e.GetDeferral();
                    int cookies = 0;
                    try { cookies = await DataStore.CookieCountAsync(ActiveUrl); } catch { }
                    body = JsonSerializer.SerializeToUtf8Bytes(new
                    {
                        // A private window never counts the normal profile's
                        // history or its cache: it does not write into them,
                        // and showing the number would imply it does.
                        history = PrivateModeRequested ? 0 : History.Count(),
                        cookies,
                        cacheMb = DataStore.ProfileSizeMb(),
                        memMb = DataStore.WorkingSetMb(),
                    });
                    type = "application/json; charset=utf-8";
                    break;
                }

                // Обновления: сервер раздачи версий у портативной сборки
                // пока не поднят — отвечаем «обновлений нет».  Когда появится
                // манифест, форма ответа {update:bool, version} уже готова.
                case "/api/update-check":
                    body = JsonSerializer.SerializeToUtf8Bytes(new { update = false, version = "1.0" });
                    type = "application/json; charset=utf-8";
                    break;

                // Онбординг: первый запуск (settings.json отсутствовала на
                // старте).  Welcome-экран шелла читает это один раз.
                case "/api/firstrun":
                    body = JsonSerializer.SerializeToUtf8Bytes(new { firstRun = File.Exists(Path.Combine(AppPaths.Root, "firstrun.flag")) });
                    type = "application/json; charset=utf-8";
                    break;

                // Квик-ответы омнибокса: погода и курсы валют.  Сеть нужна,
                // поэтому деферрал; при любой ошибке — {ok:false}, шелл
                // молча оставляет обычные подсказки.
                case "/api/quick":
                {
                    apiDeferral = e.GetDeferral();
                    try { body = JsonSerializer.SerializeToUtf8Bytes(await QuickAsync(uri)); }
                    catch (Exception ex) { MainForm.DebugLog("quick failed " + ex.GetType().Name + " " + ex.Message); body = Encoding.UTF8.GetBytes("{\"ok\":false}"); }
                    type = "application/json; charset=utf-8";
                    break;
                }

                // Weather location.  IP geolocation puts a VPN user in the wrong
                // country, so ask Windows first and fall back to the network.
                case "/api/where":
                {
                    apiDeferral = e.GetDeferral();
                    try { body = JsonSerializer.SerializeToUtf8Bytes(await WhereAsync()); }
                    catch { body = Encoding.UTF8.GetBytes("{}"); }
                    type = "application/json; charset=utf-8";
                    break;
                }

                // Перевод: Google gtx, при любой его ошибке — MyMemory
                // (оба похода в сеть внутри Translate).  Как и suggest,
                // ходит в сеть — держим событие деферралом; ответ пишется
                // ДО apiDeferral.Complete() (см. комментарий выше).
                case "/api/favicon":
                {
                    apiDeferral = e.GetDeferral();
                    try
                    {
                        var pageUrl = QueryArg(uri.Query, "u");
                        var host = "";
                        try { host = new Uri(pageUrl).Host; } catch { }
                        cacheControl = "private, max-age=86400";
                        if (!FaviconTryGet(host, out var dataUrl))
                        {
                            dataUrl = "";
                            if (!string.IsNullOrWhiteSpace(host))
                            {
                                foreach (var cand in new[] { pageUrl, "https://" + host + "/favicon.ico" })
                                {
                                    if (string.IsNullOrWhiteSpace(cand) || !cand.StartsWith("http", StringComparison.OrdinalIgnoreCase)) continue;
                                    try
                                    {
                                        var bytes = await FaviconHttp.GetByteArrayAsync(cand);
                                        if (bytes.Length == 0 || bytes.Length > 512 * 1024) continue;
                                        var mime = cand.EndsWith(".svg", StringComparison.OrdinalIgnoreCase) ? "image/svg+xml" : "image/png";
                                        // Не раздаём HTML-страницы, притворившиеся иконками.
                                        var head = Encoding.ASCII.GetString(bytes, 0, Math.Min(4, bytes.Length));
                                        if (head.StartsWith("<") || head.StartsWith("<!")) continue;
                                        dataUrl = "data:" + mime + ";base64," + Convert.ToBase64String(bytes);
                                        break;
                                    }
                                    catch { /* next candidate */ }
                                }
                            }
                            if (host.Length > 0) FaviconStore(host, dataUrl);
                        }
                        body = JsonSerializer.SerializeToUtf8Bytes(new { favicon = dataUrl });
                        type = "application/json; charset=utf-8";
                        log?.Invoke("api favicon host=" + host + " cc=" + cacheControl
                            + " cached=" + (dataUrl.Length > 0) + " size=" + FaviconCacheCount);
                    }
                    catch { body = Encoding.UTF8.GetBytes("{}"); type = "application/json; charset=utf-8"; }
                    break;
                }

                case "/api/translate":
                {
                    apiDeferral = e.GetDeferral();
                    var text = QueryArg(uri.Query, "text");
                    var to = QueryArg(uri.Query, "to");
                    var sl = QueryArg(uri.Query, "sl");
                    try { body = await Translate(text, to, sl, log); }
                    catch (HttpRequestException hx)
                    {
                        // Страховка: ошибки провайдеров Translate ловит сам
                        // (fallback на MyMemory внутри), сюда доходит только
                        // что-то совсем неожиданное вне самих походов в сеть.
                        log?.Invoke("translate fail " + hx.GetType().Name + ": " + hx.Message);
                        var code = (int?)hx.StatusCode ?? 0;
                        body = TranslateError(code == 429 ? "rate limited"
                            : code >= 500 ? "service down" : "network");
                    }
                    catch (OperationCanceledException)
                    {
                        log?.Invoke("translate fail timeout");
                        body = TranslateError("timeout");
                    }
                    catch (Exception ex)
                    {
                        log?.Invoke("translate fail " + ex.GetType().Name + ": " + ex.Message);
                        body = TranslateError("network");
                    }
                    type = "application/json; charset=utf-8";
                    break;
                }

                // Smoke test for the suggest relay: /api/debug?suggest=погода
                // (diagnostics builds only, see LIVEBROWSER_DEBUG)
                case "/api/debug" when Environment.GetEnvironmentVariable("LIVEBROWSER_DEBUG") == "1":
                {
                    var probe = Regex.Match(uri.Query, "[?&]suggest=([^&]*)");
                    var data = probe.Success
                        ? Encoding.UTF8.GetString(await Suggest(new Uri("https://x/?part=" + probe.Groups[1].Value)))
                        : "{}";
                    body = Encoding.UTF8.GetBytes(data);
                    type = "application/json; charset=utf-8";
                    break;
                }

                default:
                    status = 404;
                    body = Array.Empty<byte>();
                    type = "text/plain";
                    break;
            }
        }
        catch (Exception ex)
        {
            status = 502;
            body = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { error = ex.Message }));
            type = "application/json; charset=utf-8";
        }

        log?.Invoke("api done " + status + " " + body.Length + "b");
        e.Response = sender.CoreWebView2.Environment.CreateWebResourceResponse(
            new MemoryStream(body), status, "OK",
            ResponseHeaders(cacheControl) + "Content-Type: " + type + "\r\n");
        // Only now is the event finished; completing earlier dropped the
        // response on the floor (the page saw "Failed to fetch").
        apiDeferral?.Complete();
    }

    // Windows reports legacy ids ("Russian Standard Time"), so the zone is
    // resolved through ICU's map (HasIanaId is false on .NET 8 for these).
    // A city name alone is not enough for the forecast, so it is resolved to
    // coordinates once per run (Open-Meteo geocoding) and cached; no network
    // keeps the city only.
    private static readonly Dictionary<string, string> ZoneCities = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Russian Standard Time"] = "Moscow",
        ["E. Europe Standard Time"] = "Chisinau",
        ["FLE Standard Time"] = "Kiev",
        ["GTB Standard Time"] = "Bucharest",
        ["W. Europe Standard Time"] = "Berlin",
        ["Central Europe Standard Time"] = "Budapest",
        ["Romance Standard Time"] = "Paris",
        ["GMT Standard Time"] = "London",
        ["Turkey Standard Time"] = "Istanbul",
        ["West Asia Standard Time"] = "Tashkent",
        ["Ekaterinburg Standard Time"] = "Yekaterinburg",
        ["Novosibirsk Standard Time"] = "Novosibirsk",
        ["Vladivostok Standard Time"] = "Vladivostok",
        ["Kazakhstan Standard Time"] = "Astana",
        ["Belarus Standard Time"] = "Minsk",
        ["Kaliningrad Standard Time"] = "Kaliningrad",
    };

    private static (string city, double? lat, double? lon) geoCache;
    private static readonly SemaphoreSlim GeoLock = new(1, 1);

    private static string ZoneCity()
    {
        var tz = TimeZoneInfo.Local;
        string iana = null;
        try { iana = tz.HasIanaId ? tz.Id : TimeZoneInfo.TryConvertWindowsIdToIanaId(tz.Id, out var converted) ? converted : null; }
        catch { /* older ICU */ }
        if (!string.IsNullOrEmpty(iana))
        {
            var parts = iana.Split('/');
            if (parts.Length > 1) return parts[parts.Length - 1].Replace('_', ' ');
        }
        return ZoneCities.TryGetValue(tz.Id, out var city) ? city : null;
    }

    private static async Task<object> WhereAsync()
    {
        var city = ZoneCity();
        if (string.IsNullOrEmpty(city)) return new { city = (string)null, lat = (double?)null, lon = (double?)null };

        await GeoLock.WaitAsync();
        try
        {
            if (geoCache.city != city)
            {
                double? lat = null, lon = null;
                try
                {
                    var url = "https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&name=" +
                              Uri.EscapeDataString(city);
                    // Геокодер — только для подписи города и координат по
                    // умолчанию; 4 с, иначе «погода» ждала его 6 с на медленном
                    // DNS и падала по общему таймауту, хотя город и так известен.
                    using var quickGeo = new CancellationTokenSource(TimeSpan.FromSeconds(4));
                    using var doc = JsonDocument.Parse(await Http.GetStringAsync(url, quickGeo.Token));
                    if (doc.RootElement.TryGetProperty("results", out var results) && results.GetArrayLength() > 0)
                    {
                        var first = results[0];
                        lat = first.GetProperty("latitude").GetDouble();
                        lon = first.GetProperty("longitude").GetDouble();
                        city = first.TryGetProperty("name", out var nm) && nm.ValueKind == JsonValueKind.String
                            ? nm.GetString() : city;
                    }
                }
                catch { /* offline: the shell falls back to its default city */ }
                geoCache = (city, lat, lon);
            }
            return new { city = geoCache.city, lat = geoCache.lat, lon = geoCache.lon };
        }
        finally { GeoLock.Release(); }
    }

    /* ---------------------------------------------------------- */
    /* Квик-ответы (/api/quick)                                     */
    /* ---------------------------------------------------------- */

    // where=pogoda|weather  → текущая погода по городу из /api/where
    // where=rate&code=USD   → курс валюты к рублю (ЦБ РФ, без ключа)
    // Ответы всегда {ok:true, ...}; ошибка — {ok:false}, шелл молча
    // прячет карточку и оставляет обычные подсказки.
    private static async Task<object> QuickAsync(Uri uri)
    {
        var m = Regex.Match(uri.Query, "[?&]where=([a-z]+)");
        var what = m.Success ? m.Groups[1].Value : "";
        if (what == "pogoda") what = "weather";

        if (what == "weather")
        {
            var place = await WhereAsync();
            double lat = 55.7558, lon = 37.6173;
            string city = "Москва";
            try
            {
                var pt = place.GetType();
                var latV = pt.GetProperty("lat")?.GetValue(place) as double?;
                var lonV = pt.GetProperty("lon")?.GetValue(place) as double?;
                var cityV = pt.GetProperty("city")?.GetValue(place) as string;
                if (latV.HasValue) lat = latV.Value;
                if (lonV.HasValue) lon = lonV.Value;
                if (!string.IsNullOrWhiteSpace(cityV)) city = cityV;
            }
            catch { /* дефолтный город */ }
            var url = "https://api.open-meteo.com/v1/forecast?latitude=" +
                      lat.ToString(System.Globalization.CultureInfo.InvariantCulture) + "&longitude=" +
                      lon.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                      "&current=temperature_2m,weather_code&timezone=auto";
            using var doc = JsonDocument.Parse(await Http.GetStringAsync(url));
            var cur = doc.RootElement.GetProperty("current");
            var temp = (int)Math.Round(cur.GetProperty("temperature_2m").GetDouble());
            var code = cur.GetProperty("weather_code").GetInt32();
            return new
            {
                ok = true,
                kind = "weather",
                title = city,
                value = temp + "°",
                note = WeatherNote(code),
                icon = WeatherIcon(code),
                url = $"https://yandex.ru/pogoda/?lat={lat.ToString(System.Globalization.CultureInfo.InvariantCulture)}&lon={lon.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            };
        }

        if (what == "rate")
        {
            var code = Regex.Match(uri.Query, "[?&]code=([A-Za-z]{3})");
            var cur = code.Success ? code.Groups[1].Value.ToUpperInvariant() : "USD";
            // ЦБ РФ отдаёт XML; валютные курсы меняются раз в день — берём
            // свежую страницу без кэша HttpClient (кэш у ЦБ и так минутный).
            // ЦБ отдаёт файл в windows-1251 и с таким Content-Type, который
            // GetStringAsync отказывается читать («invalid character set»):
            // забираем байты и декодируем сами.
            var raw = await RateHttp.GetByteArrayAsync("https://www.cbr.ru/scripts/XML_daily.asp");
            var xml = System.Text.Encoding.Latin1.GetString(raw);
            // Разбор по элементам, а не одним мега-regex: теги стоят
            // вплотную, а \s* перед </Valute> в .NET жадный — соседний
            // <Valute> съедался и совпадение срывалось.
            // [0-9], а не \d: класс \d в .NET зависит от CurrentCulture, а на
            // этой машине рантайм поднимается с азербайджанской локалью —
            // её цифры не совпадали с латинскими в XML.  Явный класс от
            // культуры не зависит.
            var hit = Regex.Match(xml,
                "<CharCode>" + cur + @"</CharCode>\s*<Nominal>([0-9]+)</Nominal>\s*<Name>([^<]*)</Name>\s*<Value>([0-9,.]+)</Value>");
            if (!hit.Success) return new { ok = false };
            var nominal = int.Parse(hit.Groups[1].Value);
            // Файл ЦБ — windows-1251, а .NET без CodePages не умеет 1251.
            // Latin1 один-к-одному сохраняет байты, а Cp1251 ниже переводит
            // их в UTF-16 по таблице.
            var name = WebUtility.HtmlDecode(Cp1251(hit.Groups[2].Value));
            var value = double.Parse(hit.Groups[3].Value.Replace(',', '.'),
                System.Globalization.CultureInfo.InvariantCulture);
            var per = value / nominal;
            return new
            {
                ok = true,
                kind = "rate",
                title = name,
                value = per.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + " ₽",
                note = nominal == 1 ? "за 1 " + cur + " · курс ЦБ" : "за " + nominal + " " + cur + " · курс ЦБ",
                icon = "₽",
                url = "https://www.cbr.ru/currency_base/daily/",
            };
        }

        return new { ok = false };
    }

    // Мини-декодер windows-1251: в self-contained .NET 8 без пакета
    // System.Text.Encoding.CodePages кодовой страницы 1251 нет, а везти
    // лишние 1.5 МБ ради названия валюты не стоит.  0x80–0xBF — точечная
    // таблица, 0xC0–0xFF — непрерывный блок А..я.
    private static string Cp1251(string s)
    {
        var sb = new System.Text.StringBuilder(s.Length);
        foreach (var ch in s)
        {
            if (ch < 0x80) { sb.Append(ch); continue; }
            if (ch >= 0xC0) { sb.Append((char)(0x0410 + (int)ch - 0xC0)); continue; }
            sb.Append((int)ch switch
            {
                0xA8 => 'Ё', 0xB8 => 'ё',
                0xAB => '«', 0xBB => '»',
                0x96 => '–', 0x97 => '—', 0x85 => '…',
                _ => '?',
            });
        }
        return sb.ToString();
    }

    private static string WeatherIcon(int code)
    {
        if (code == 0) return "☀️";
        if (code <= 3) return code == 3 ? "☁️" : "🌤️";
        if (code == 45 || code == 48) return "🌫️";
        if (code >= 71 && code <= 77) return "❄️";
        if (code >= 95) return "⛈️";
        return "🌧️";
    }

    private static string WeatherNote(int code)
    {
        if (code == 0) return "ясно";
        if (code == 1) return "в основном ясно";
        if (code == 2) return "переменная облачность";
        if (code == 3) return "пасмурно";
        if (code == 45 || code == 48) return "туман";
        if (code >= 51 && code <= 57) return "морось";
        if (code >= 61 && code <= 67) return "дождь";
        if (code >= 71 && code <= 77) return "снег";
        if (code >= 80 && code <= 82) return "ливень";
        if (code >= 85 && code <= 86) return "снегопад";
        if (code >= 95) return "гроза";
        return "погода";
    }

    // Yandex's suggest endpoint answers ["query", ["s1","s2",...], ...].
    private static async Task<byte[]> Suggest(Uri uri)    {        var query = uri.Query;
        var m = Regex.Match(query, "[?&]part=([^&]*)");
        var part = m.Success ? Uri.UnescapeDataString(m.Groups[1].Value) : "";
        if (string.IsNullOrWhiteSpace(part))
            return Encoding.UTF8.GetBytes("[\"\",[]]");

        var url = "https://suggest.yandex.ru/suggest-ff.cgi?uil=ru&v=4&n=10&srv=browser&part=" +
                  Uri.EscapeDataString(part);
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiveBrowser/1.0");
        var bytes = await Http.GetByteArrayAsync(url);
        return bytes;
    }

    /* ---------------------------------------------------------- */
    /* Перевод (/api/translate)                                     */
    /* ---------------------------------------------------------- */

    // Запрос: text (обязателен), to = ru|en (по умолчанию ru — язык интерфейса),
    // sl = auto|xx (любой код, по умолчанию auto).  Отвечаем {"ok":true,"text"}
    // или {"ok":false,"error"}; пустой текст и неизвестный to — ошибка сразу,
    // без похода в сеть.
    /// <summary>
    /// Батч-перевод для замены текста на странице (in-place): до 3 запросов
    /// параллельно, каждый узел отдельно (лимит 900 символов — узлы длиннее
    /// остаются непереведёнными).  Провал узла = пустая строка (узел не трогаем).
    /// </summary>
    public static async Task<string[]> TranslateBatch(string[] texts, string to, string sl, Action<string> log = null)
    {
        var result = new string[texts.Length];
        using var gate = new System.Threading.SemaphoreSlim(3);
        var tasks = Enumerable.Range(0, texts.Length).Select(async (i) =>
        {
            var t = texts[i];
            if (string.IsNullOrWhiteSpace(t) || t.Length > 900) return;
            await gate.WaitAsync();
            try
            {
                // Translate возвращает готовый JSON {ok,text} (с кэшем и
                // цепочкой gtx→MyMemory внутри) — достаём текст.
                var body = await Translate(t, to, sl, log);
                using var jd = JsonDocument.Parse(body);
                if (jd.RootElement.TryGetProperty("ok", out var okEl) && okEl.GetBoolean()
                    && jd.RootElement.TryGetProperty("text", out var tx)
                    && tx.ValueKind == JsonValueKind.String)
                {
                    result[i] = tx.GetString() ?? "";
                }
                else result[i] = "";
            }
            catch { result[i] = ""; }
            finally { gate.Release(); }
        });
        await Task.WhenAll(tasks);
        return result;
    }

    private static async Task<byte[]> Translate(string text, string to, string sl, Action<string> log)
    {
        text = (text ?? "").Trim();
        if (text.Length == 0) return TranslateError("empty");
        if (text.Length > 4000) text = text.Substring(0, 4000); // провайдеры режут длинные куски

        to = (to ?? "").Trim().ToLowerInvariant();
        if (to.Length == 0) to = "ru";
        if (to != "ru" && to != "en") return TranslateError("bad target language");

        sl = (sl ?? "").Trim().ToLowerInvariant();
        if (sl.Length == 0) sl = "auto";

        var key = sl + "|" + to + "|" + text;
        lock (TranslateLock)
        {
            if (TranslateCache.TryGetValue(key, out var hit))
            {
                // Попадание — ключ в конец очереди (LRU-ish).
                if (TranslateOrder.Count > 1)
                {
                    var tmp = new Queue<string>(TranslateOrder.Count);
                    foreach (var k in TranslateOrder) if (k != key) tmp.Enqueue(k);
                    tmp.Enqueue(key);
                    TranslateOrder.Clear();
                    foreach (var k in tmp) TranslateOrder.Enqueue(k);
                }
                return JsonSerializer.SerializeToUtf8Bytes(new { ok = true, text = hit });
            }
        }

        // Бюджет всей цепочки (gtx + fallback): страница ждёт под деферралом,
        // дольше ~15 с держать событие нельзя.
        using var chain = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        // Провайдер 1 — Google gtx.  ЛЮБАЯ его ошибка (сеть, 429, таймаут,
        // неожиданный/пустой ответ) — не беда: уводим цепочку на MyMemory.
        string translated = null;
        string gtxFail = "";
        try { translated = await TranslateGtx(text, to, sl, chain.Token); }
        catch (Exception ex) { gtxFail = ex.GetType().Name + ": " + ex.Message; }

        // Провайдер 2 — MyMemory, резервный: без ключа, но с лимитом ~500
        // символов на запрос.  Свои ошибки наружу не отдаём: при провале
        // обоих провайдеров снаружи один generic-ответ ({ok:false,...}).
        if (translated == null && !chain.IsCancellationRequested)
        {
            try
            {
                translated = await TranslateMyMemory(text, to, sl, chain.Token);
                log?.Invoke("translate gtx failed (" + gtxFail + ") → mymemory ok");
            }
            catch (Exception ex)
            {
                log?.Invoke("translate gtx failed (" + gtxFail + ") → mymemory failed "
                            + ex.GetType().Name + ": " + ex.Message);
            }
        }

        if (string.IsNullOrEmpty(translated))
        {
            log?.Invoke("translate: both providers failed"
                        + (chain.IsCancellationRequested ? " (chain budget 15s gone)" : ""));
            return TranslateError("unavailable");
        }

        lock (TranslateLock)
        {
            if (!TranslateCache.ContainsKey(key))
            {
                while (TranslateCache.Count >= TranslateCacheCap && TranslateOrder.Count > 0)
                {
                    var old = TranslateOrder.Dequeue();
                    TranslateCache.Remove(old);
                }
                TranslateCache[key] = translated;
                TranslateOrder.Enqueue(key);
            }
        }
        return JsonSerializer.SerializeToUtf8Bytes(new { ok = true, text = translated });
    }

    // Провайдер 1 — Google gtx (без ключа).  Вынесен отдельно, чтобы Translate
    // мог поймать ЛЮБУЮ его ошибку и уйти на fallback.
    private static async Task<string> TranslateGtx(string text, string to, string sl, CancellationToken cancel)
    {
        var url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" +
                  Uri.EscapeDataString(sl) + "&tl=" + Uri.EscapeDataString(to) +
                  "&dt=t&q=" + Uri.EscapeDataString(text);
        // Таймаут уже 6 с у HttpClient; отменяем ещё раз явно, чтобы зависший
        // ответ не держал деферрал дольше (страница ждёт).
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        cts.CancelAfter(TimeSpan.FromSeconds(6));
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiveBrowser/1.0");
        using var resp = await Http.SendAsync(req, cts.Token);
        // 429/5xx кидают HttpRequestException со StatusCode — это и есть
        // сигнал для fallback; пустой ответ считаем тем же провалом.
        resp.EnsureSuccessStatusCode();
        var translated = ParseGtx(await resp.Content.ReadAsStringAsync(cts.Token));
        if (string.IsNullOrEmpty(translated))
            throw new InvalidOperationException("gtx: unexpected payload");
        return translated;
    }

    // Провайдер 2 — MyMemory (api.mymemory.translated.net).  Принимает ~500
    // символов за запрос, поэтому текст режется на куски ≤450 по границам
    // предложений (где предложений в окне нет — по словам) и переводится
    // ПОСЛЕДОВАТЕЛЬНО: параллельные запросы с одного IP быстро ловят 429.
    private static async Task<string> TranslateMyMemory(string text, string to, string sl, CancellationToken cancel)
    {
        // "auto" MyMemory не умеет; целевые языки здесь только ru/en, поэтому
        // эвристики достаточно: есть кириллица — исходник ru, иначе en.
        if (sl == "auto")
            sl = HasCyrillic(text) ? "ru" : "en";

        var parts = new List<string>();
        foreach (var chunk in SplitChunks(text, 450))
            parts.Add(await MyMemoryChunk(chunk, sl, to, cancel));
        return string.Join(" ", parts);
    }

    // Один запрос к MyMemory.  Ответ — JSON
    // {"responseData":{"translatedText":"..."},"responseStatus":200};
    // успех = статус 200 и непустой перевод, HTML-сущности декодируем
    // (API отдаёт &quot; и т.п. прямо в тексте).  Иначе — исключение:
    // наверху это трактуется как провал провайдера.
    private static async Task<string> MyMemoryChunk(string chunk, string sl, string to, CancellationToken cancel)
    {
        var url = "https://api.mymemory.translated.net/get?q=" + Uri.EscapeDataString(chunk) +
                  "&langpair=" + Uri.EscapeDataString(sl + "|" + to);
        // Своё ограничение на чанк поверх общего бюджета цепочки (реальный
        // потолок — 6 c HttpClient.Timeout, он общий с suggest/where).
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        cts.CancelAfter(TimeSpan.FromSeconds(8));
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiveBrowser/1.0");
        using var resp = await Http.SendAsync(req, cts.Token);
        resp.EnsureSuccessStatusCode();
        var json = await resp.Content.ReadAsStringAsync(cts.Token);

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("responseData", out var data) ||
            data.ValueKind != JsonValueKind.Object ||
            !data.TryGetProperty("translatedText", out var tt) ||
            tt.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("mymemory: unexpected payload");

        // responseStatus приходит числом, строку принимаем на всякий случай.
        var status = -1;
        if (root.TryGetProperty("responseStatus", out var st))
        {
            if (st.ValueKind == JsonValueKind.Number) status = st.GetInt32();
            else if (st.ValueKind == JsonValueKind.String &&
                     int.TryParse(st.GetString(), out var n)) status = n;
        }

        var translated = WebUtility.HtmlDecode(tt.GetString());
        if (status != 200 || string.IsNullOrWhiteSpace(translated))
            throw new InvalidOperationException("mymemory: status " + status + ", empty text");
        return translated;
    }

    // Есть ли в строке кириллица (U+0400..U+04FF — тот же диапазон, что
    // считает проба Translator.cs).
    private static bool HasCyrillic(string s)
    {
        foreach (var ch in s)
            if (ch >= '\u0400' && ch <= '\u04FF') return true;
        return false;
    }

    // Режет текст на куски ≤ max: по границам предложений (. ! ? \n), а где
    // предложений в окне нет — по последнему пробелу; одиночное длинное
    // «слово» рвётся принудительно.
    private static List<string> SplitChunks(string text, int max)
    {
        var chunks = new List<string>();
        int pos = 0;
        while (pos < text.Length)
        {
            if (text.Length - pos <= max) { chunks.Add(text.Substring(pos)); break; }
            // Последняя граница предложения внутри окна; кусок вместе со
            // знаком остаётся ≤ max, поэтому сканируем от pos+max-1.
            int cut = -1;
            for (int i = pos + max - 1; i > pos; i--)
            {
                char c = text[i];
                if (c == '.' || c == '!' || c == '?' || c == '\n') { cut = i + 1; break; }
            }
            if (cut <= pos)
                cut = text.LastIndexOf(' ', pos + max, max); // по словам
            if (cut <= pos)
                cut = pos + max; // одно длинное «слово» — рвём жёстко
            chunks.Add(text.Substring(pos, cut - pos));
            pos = cut;
        }
        return chunks;
    }

    // Ответ gtx: [[["перевод","исходник",...],["второй кусок","...",...],...],
    // null, "en", ...] — строки перевода собираются из первой колонки кусков.
    // Форма не документирована, поэтому всё через TryGetProperty/ValueKind.
    private static string ParseGtx(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() == 0)
                return null;
            var chunks = doc.RootElement[0];
            if (chunks.ValueKind != JsonValueKind.Array) return null;
            var sb = new StringBuilder();
            foreach (var chunk in chunks.EnumerateArray())
            {
                if (chunk.ValueKind != JsonValueKind.Array || chunk.GetArrayLength() == 0) continue;
                var piece = chunk[0];
                if (piece.ValueKind == JsonValueKind.String) sb.Append(piece.GetString());
            }
            return sb.ToString();
        }
        catch { return null; }
    }

    private static byte[] TranslateError(string error) =>
        JsonSerializer.SerializeToUtf8Bytes(new { ok = false, error });

    /* ---------------------------------------------------------- */
    /* Helpers for the new endpoints                                */
    /* ---------------------------------------------------------- */

    // One query parameter, URL-decoded, "" when absent.
    private static string QueryArg(string query, string name)
    {
        var m = Regex.Match(query ?? "", "[?&]" + Regex.Escape(name) + "=([^&]*)");
        return m.Success ? Uri.UnescapeDataString(m.Groups[1].Value) : "";
    }

    // A positive integer query parameter, clamped to [1, 1000].
    private static int QueryInt(string query, string name, int fallback)
    {
        var s = QueryArg(query, name);
        return int.TryParse(s, out var n) && n > 0 ? Math.Min(n, 1000) : fallback;
    }

    // Builds the engine's result page. DuckDuckGo's html endpoint accepts a
    // plain form GET; Google needs its normal search url. Anything other than
    // "google" is treated as yandex (the shell's default engine).
    private static string EngineUrl(string engine, string query)
    {
        var q = Uri.EscapeDataString(query ?? "");
        return (engine ?? "").Trim().ToLowerInvariant() switch
        {
            "google" => "https://www.google.com/search?q=" + q,
            "duckduckgo" => "https://html.duckduckgo.com/html/?q=" + q,
            _ => "https://yandex.ru/search/?text=" + q,
        };
    }
}
