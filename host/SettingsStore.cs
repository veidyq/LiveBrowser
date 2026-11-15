using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;

namespace LiveBrowser;

/// <summary>
/// settings.json next to the exe: browser-wide options edited by the shell's
/// settings page, a few of which the host also consumes (defaultZoom for new
/// site views, the download folder / autoOpen).  The palette stays in
/// theme.json and is deliberately NOT mirrored here.
///
/// quickLinks (пользовательские плитки рабочего стола shell'а) идёт через
/// тот же GET/POST как непрозрачное поле: POST шлёт массив ЦЕЛИКОМ (shell
/// всегда отправляет актуальный список), Merge заменяет его как единое
/// целое, а SanitizeQuickLinks после слияния вычищает битые записи и режет
/// хвост по лимиту 12.  Хост сам это поле не читает — только хранит.
///
/// The file is tiny, so it is re-parsed on every access — no cache that could
/// go stale after a POST.  A missing, broken or older file falls back to the
/// defaults; the "version" field is ignored (forward compatibility: unknown
/// keys survive merges untouched).
/// </summary>
internal static class SettingsStore
{
    // The canonical shape; also what a fresh install gets on disk.
    public const string Defaults =
        "{\"version\":1,\"animations\":true,\"tactile\":true,\"search\":\"yandex\",\"newTab\":\"desktop\"," +
        "\"defaultZoom\":1.0,\"backgroundSuspend\":true,\"backgroundBlur\":true," +
        "\"hardwareAccel\":true,\"useCache\":true,\"verticalTabs\":false," +
        // adBlock — host-level blocking of known ad/tracker hosts (AdBlock.cs).
        "\"adBlock\":true," +
        // quickLinks — пользовательские плитки рабочего стола ([{name,url}]):
        // пишет и читает только shell, хост лишь хранит массив как есть.
        "\"quickLinks\":[]," +
        "\"downloads\":{\"dir\":\"\",\"askEach\":false,\"autoOpen\":false}}";

    /// <summary>Current settings as raw JSON (creates the file on first read).</summary>
    /// <summary>True, если на момент старта сеанса settings.json не было:
    /// профиль пустой, шелл показывает welcome-экран.  Фиксируется один раз
    /// в статическом инициализаторе — ДО того, как GetJson создаст файл.</summary>
    public static bool IsFirstRun => firstRun;
    private static readonly bool firstRun = InitFirstRun();

    private static bool InitFirstRun()
    {
        var absent = !File.Exists(AppPaths.SettingsFile);
        try
        {
            var fi = new FileInfo(AppPaths.SettingsFile);
            var times = fi.Exists
                ? $"created={fi.CreationTime:HH:mm:ss.fff} written={fi.LastWriteTime:HH:mm:ss.fff} len={fi.Length}"
                : "no-file";
            File.AppendAllText(Path.Combine(AppPaths.Root, "debug.log"),
                $"{DateTime.Now:HH:mm:ss.fff} firstrun-init absent={absent} {times}\r\n");
        }
        catch { }
        return absent;
    }

    public static string GetJson()
    {
        try
        {
            if (!File.Exists(AppPaths.SettingsFile))
            {
                var fresh = Pretty(Defaults);
                Write(fresh);
                return fresh;
            }
            // Broken / hand-mangled file: answer with defaults, leave the
            // file alone until a successful POST rewrites it.
            using var doc = JsonDocument.Parse(File.ReadAllText(AppPaths.SettingsFile));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return Defaults;
            return Pretty(doc.RootElement.GetRawText());
        }
        catch { return Defaults; }
    }

    /// <summary>
    /// Partial merge of <paramref name="patch"/> into the current settings,
    /// persisted to disk.  Objects merge key-by-key (so a patch of
    /// {"downloads":{"autoOpen":true}} keeps dir / askEach), scalars are
    /// replaced, unknown keys on either side survive.
    /// </summary>
    public static void MergeAndSave(JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object) return;
        try
        {
            using var cur = JsonDocument.Parse(GetJson());
            string merged;
            using (var ms = new MemoryStream())
            {
                using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true }))
                    Merge(cur.RootElement, patch, w);
                merged = Encoding.UTF8.GetString(ms.ToArray());
            }
            Write(SanitizeQuickLinks(merged));
        }
        catch { /* keep the previous settings on any failure */ }
    }

    // Patch keys first (patch wins), then current-only keys — recursion makes
    // every object-valued property a deep merge, downloads included.
    private static void Merge(JsonElement cur, JsonElement patch, Utf8JsonWriter w)
    {
        w.WriteStartObject();
        foreach (var p in patch.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.Object &&
                cur.ValueKind == JsonValueKind.Object &&
                cur.TryGetProperty(p.Name, out var c) && c.ValueKind == JsonValueKind.Object)
            {
                w.WritePropertyName(p.Name);
                Merge(c, p.Value, w);
            }
            else
            {
                p.WriteTo(w);
            }
        }
        if (cur.ValueKind == JsonValueKind.Object)
            foreach (var c in cur.EnumerateObject())
                if (!patch.TryGetProperty(c.Name, out _))
                    c.WriteTo(w);
        w.WriteEndObject();
    }

    // Пользовательские быстрые вкладки (плитки на рабочем столе shell'а):
    // массив объектов {"name","url"}.  Хост сам их не читает — только
    // держит; POST от shell'а всегда несёт список ЦЕЛИКОМ, поэтому Merge
    // заменяет массив как единое целое, а здесь, после слияния, из него
    // выбрасываются битые записи (не-объекты, пустые или не-строковые
    // name/url) и обрезается хвост по лимиту — кривой POST или ручная
    // правка файла не ломают settings.json и не раздувают его.
    private const int QuickLinksMax = 12;

    private static string SanitizeQuickLinks(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            // Поля нет (или оно не массив) — файл отдаётся как есть.
            if (!doc.RootElement.TryGetProperty("quickLinks", out var ql) ||
                ql.ValueKind != JsonValueKind.Array)
                return json;

            var items = new List<(string Name, string Url)>();
            foreach (var it in ql.EnumerateArray())
            {
                if (items.Count >= QuickLinksMax) break;
                if (it.ValueKind != JsonValueKind.Object) continue;
                string name = null, url = null;
                if (it.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String)
                    name = (n.GetString() ?? "").Trim();
                if (it.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String)
                    url = (u.GetString() ?? "").Trim();
                if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(url)) continue;
                items.Add((name, url));
            }

            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true }))
            {
                w.WriteStartObject();
                foreach (var p in doc.RootElement.EnumerateObject())
                {
                    if (p.Name != "quickLinks") { p.WriteTo(w); continue; }
                    w.WritePropertyName("quickLinks");
                    w.WriteStartArray();
                    foreach (var (name, url) in items)
                    {
                        w.WriteStartObject();
                        w.WriteString("name", name);
                        w.WriteString("url", url);
                        w.WriteEndObject();
                    }
                    w.WriteEndArray();
                }
                w.WriteEndObject();
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }
        catch { return json; } // не распарсили — оставляем как пришло
    }

    /// <summary>ZoomFactor for NEW site views; clamped to the host zoom range.</summary>
    public static bool Animations()
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(AppPaths.SettingsFile));
            if (doc.RootElement.TryGetProperty("animations", out var a))
                return a.ValueKind == System.Text.Json.JsonValueKind.True
                    || (a.ValueKind == System.Text.Json.JsonValueKind.String && a.GetString() == "true");
        }
        catch { /* missing/broken file: animations default on */ }
        return true;
    }

    /// <summary>
    /// «Тактильный отклик» (feel.js в шелле, мягкий скролл-якорь на сайтах).
    /// Битый/старый файл: включено, как и Animations.
    /// </summary>
    public static bool Tactile()
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(AppPaths.SettingsFile));
            if (doc.RootElement.TryGetProperty("tactile", out var t))
                return t.ValueKind == System.Text.Json.JsonValueKind.True
                    || (t.ValueKind == System.Text.Json.JsonValueKind.String && t.GetString() == "true");
        }
        catch { /* missing/broken file: tactile default on */ }
        return true;
    }

    public static double DefaultZoom()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("defaultZoom", out var z) && z.ValueKind == JsonValueKind.Number)
                return Math.Clamp(z.GetDouble(), 0.3, 3.0);
        }
        catch { }
        return 1.0;
    }

    /// <summary>Configured download folder; "" = standard Windows Downloads.  Relative paths resolve against the exe folder.</summary>
    public static string DownloadsDir()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("downloads", out var d) &&
                d.ValueKind == JsonValueKind.Object &&
                d.TryGetProperty("dir", out var dir) && dir.ValueKind == JsonValueKind.String)
            {
                var v = dir.GetString() ?? "";
                if (v.Length > 0 && !Path.IsPathRooted(v)) v = Path.Combine(AppPaths.Root, v);
                return v;
            }
        }
        catch { }
        return "";
    }

    public static bool DownloadsAskEach() => DownloadFlag("askEach", false);
    public static bool DownloadsAutoOpen() => DownloadFlag("autoOpen", false);

    /// <summary>Per-site zoom: сохранённый масштаб для хоста (siteZoom в
    /// settings.json).  Нет записи — null (браузерный дефолт 1.0).</summary>
    public static double? GetSiteZoom(string host)
    {
        if (string.IsNullOrWhiteSpace(host)) return null;
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("siteZoom", out var z)
                && z.ValueKind == JsonValueKind.Object
                && z.TryGetProperty(host, out var v)
                && v.ValueKind == JsonValueKind.Number)
            {
                var d = v.GetDouble();
                return d is >= 0.3 and <= 3.0 ? d : null;
            }
        }
        catch { /* broken file: default zoom */ }
        return null;
    }

    /// <summary>Запомнить масштаб сайта (host → factor) в settings.json.</summary>
    public static void SetSiteZoom(string host, double factor)
    {
        if (string.IsNullOrWhiteSpace(host) || factor is < 0.3 or > 3.0) return;
        try
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms))
            {
                w.WriteStartObject();
                w.WriteStartObject("siteZoom");
                w.WriteNumber(host, Math.Round(factor, 2));
                w.WriteEndObject();
                w.WriteEndObject();
            }
            using var patch = JsonDocument.Parse(ms.ToArray());
            MergeAndSave(patch.RootElement);
        }
        catch { /* persistence is best-effort */ }
    }

    // Suspend inactive site views after a few minutes (the "Оптимизация"
    // page toggle).  Unknown / broken file keeps the default ON.
    public static bool BackgroundSuspend()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("backgroundSuspend", out var v) &&
                (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False))
                return v.GetBoolean();
        }
        catch { }
        return true;
    }

    // Тумблеры "Оптимизации" (страница настроек shell'а).  Читаются из того же
    // settings.json, что пишет shell; неизвестное/битое значение — дефолт.
    // animations: motion в UI (его же читает Animations()); backgroundBlur:
    // тяжёлый backdrop-filter (false — shell рисует без размытия);
    // hardwareAccel: GPU у WebView2 (false — хост добавляет --disable-gpu).
    public static bool BackgroundBlur()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("backgroundBlur", out var v) &&
                (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False))
                return v.GetBoolean();
        }
        catch { }
        return true;
    }

    public static bool HardwareAccel()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("hardwareAccel", out var v) &&
                (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False))
                return v.GetBoolean();
        }
        catch { }
        return true;
    }

    // Блокировка рекламных/трекерных хостов (AdBlock.cs).  Выключенный
    // флаг должен действовать сразу, поэтому значение читается на каждый
    // запрос ресурса, а не кешируется при создании вьюхи.
    public static bool AdBlock()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("adBlock", out var v) &&
                (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False))
                return v.GetBoolean();
        }
        catch { }
        return true;
    }

    // Вертикальные вкладки: сбоку колонка вместо полосы поверх сайта.
    // Отсутствие ключа — обычная горизонтальная полоса.  Ключ остаётся
    // читаемым, но задать его из UI больше нечем: тумблер в настройках и
    // Ctrl+Shift+E убраны, так что колонку включает только ручная правка
    // settings.json.
    public static bool VerticalTabs()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("verticalTabs", out var v) &&
                (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False))
                return v.GetBoolean();
        }
        catch { }
        return false;
    }

    // Запись того же ключа.  Вызовов из UI не осталось (Ctrl+Shift+E снят),
    // но SetVerticalTabs держит инвариант «настройка пишется минимальным
    // патчем» и пригодится, если колонка вернётся в настройки.
    public static void SetVerticalTabs(bool on)
        => MergeAndSave(JsonSerializer.SerializeToElement(new { verticalTabs = on }));

    // «Использовать кеш»: true — обычный профиль с кешем страниц, false —
    // эфемерный (MainForm выбирает папку профиля).
    public static bool UseCache()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("useCache", out var v) &&
                (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False))
                return v.GetBoolean();
        }
        catch { }
        return true;
    }

    // Search engine the shell should offer first: "yandex" (default) or
    // "google".  Anything else falls back to yandex, the shell's default.
    public static string PrimaryEngine()
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("search", out var v) && v.ValueKind == JsonValueKind.String)
            {
                var s = (v.GetString() ?? "").Trim().ToLowerInvariant();
                if (s == "google" || s == "yandex") return s;
            }
        }
        catch { }
        return "yandex";
    }

    private static bool DownloadFlag(string name, bool fallback)
    {
        try
        {
            using var doc = JsonDocument.Parse(GetJson());
            if (doc.RootElement.TryGetProperty("downloads", out var d) &&
                d.ValueKind == JsonValueKind.Object &&
                d.TryGetProperty(name, out var v) &&
                (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False))
                return v.GetBoolean();
        }
        catch { }
        return fallback;
    }

    private static string Pretty(string json)
    {
        using var doc = JsonDocument.Parse(json);
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true }))
            doc.RootElement.WriteTo(w);
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    private static void Write(string json)
    {
        var tmp = AppPaths.SettingsFile + ".tmp";
        File.WriteAllText(tmp, json);
        File.Move(tmp, AppPaths.SettingsFile, true);
    }
}
