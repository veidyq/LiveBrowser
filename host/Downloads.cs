using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace LiveBrowser;

/// <summary>
/// One entry of the download list.  downloads.json persists exactly
/// id/url/name/path/total/received/state/endedAt; the bridge message adds
/// the live "speed" (bytes/s).
/// </summary>
internal sealed class DownloadItem
{
    public int Id;
    public string Url = "";
    public string Name = "";
    public string Path = "";
    public long Total;
    public long Received;
    public string State = "downloading"; // downloading | paused | done | canceled | error
    public long EndedAt;                 // unix ms, 0 = still active
    public long Speed;                   // bytes/s (not persisted)
}

/// <summary>
/// Own download manager.  The native WebView2 download is refused in
/// DownloadStarting (Handled = true) and the file is fetched with a plain
/// HttpClient instead, so the shell can pause (cancel current request, keep
/// the bytes), resume (Range: bytes=received-) and cancel (delete the file).
///
/// Bridge messages to every open shell window (via MainForm.PostJson):
///   {"type":"download","item":{id,url,name,path,received,total,state,speed}}
///   pushed on EVERY state change and on progress ticks (~5 Hz, well under
///   the 10 Hz cap), and
///   {"type":"toast","text":"Загрузка завершена: <name>"} on completion.
/// The last 50 items persist in downloads.json next to the exe; entries left
/// "downloading" by a crash come back as "paused" on the next start.
/// </summary>
internal static class DownloadManager
{
    // A running download: the token stops the loop, the flags say whether a
    // cancel from the UI turns into "paused" or "canceled".
    private sealed class Op
    {
        public DownloadItem Item;
        public CancellationTokenSource Cts = new();
        public volatile bool PauseRequested;
        public volatile bool CancelRequested;
    }

    private static readonly object Gate = new();
    private static readonly List<DownloadItem> items = new();
    private static readonly Dictionary<int, Op> ops = new();
    private static readonly List<MainForm> sinks = new(); // every open window
    private static bool loaded;
    private static int seq;

    // Downloads must outlive the api/favicon timeouts AND HttpClient's
    // default 100 s cap (large files), so the timeout is infinite and
    // stopping happens only through the per-download token.
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    static DownloadManager()
    {
        try
        {
            Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiveBrowser/1.0");
        }
        catch { /* headers are best-effort */ }
    }

    /* ---------------------------------------------------------- */
    /* Persistence                                                  */
    /* ---------------------------------------------------------- */

    public static void Load()
    {
        lock (Gate)
        {
            if (loaded) return;
            loaded = true;
            items.Clear();
            try
            {
                if (File.Exists(AppPaths.DownloadsFile))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(AppPaths.DownloadsFile));
                    if (doc.RootElement.ValueKind == JsonValueKind.Array)
                        foreach (var el in doc.RootElement.EnumerateArray())
                            items.Add(FromJson(el));
                }
            }
            catch { items.Clear(); }
            // A crash mid-download leaves "downloading" rows; they are
            // resumable, so present them as paused.
            foreach (var it in items)
                if (it.State == "downloading") it.State = "paused";
            seq = items.Count > 0 ? items.Max(x => x.Id) : 0;
        }
    }

    private static DownloadItem FromJson(JsonElement el)
    {
        var it = new DownloadItem
        {
            Id = el.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.Number && i.TryGetInt32(out var ii) ? ii : 0,
            Url = el.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "",
            Name = el.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "",
            Path = el.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "",
            Total = el.TryGetProperty("total", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt64() : 0,
            Received = el.TryGetProperty("received", out var r) && r.ValueKind == JsonValueKind.Number ? r.GetInt64() : 0,
            State = el.TryGetProperty("state", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() ?? "paused" : "paused",
            EndedAt = el.TryGetProperty("endedAt", out var e) && e.ValueKind == JsonValueKind.Number ? e.GetInt64() : 0,
        };
        if (it.State != "downloading" && it.State != "paused" && it.State != "done" &&
            it.State != "canceled" && it.State != "error") it.State = "paused";
        return it;
    }

    private static void Save()
    {
        DownloadItem[] snap;
        lock (Gate) snap = items.Skip(Math.Max(0, items.Count - 50)).ToArray();
        try
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms))
            {
                w.WriteStartArray();
                foreach (var it in snap)
                {
                    w.WriteStartObject();
                    w.WriteNumber("id", it.Id);
                    w.WriteString("url", it.Url);
                    w.WriteString("name", it.Name);
                    w.WriteString("path", it.Path);
                    w.WriteNumber("total", it.Total);
                    w.WriteNumber("received", it.Received);
                    w.WriteString("state", it.State);
                    w.WriteNumber("endedAt", it.EndedAt);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
            }
            var tmp = AppPaths.DownloadsFile + ".tmp";
            File.WriteAllBytes(tmp, ms.ToArray());
            File.Move(tmp, AppPaths.DownloadsFile, true);
        }
        catch { /* persistence is best-effort */ }
    }

    /* ---------------------------------------------------------- */
    /* Shell plumbing                                               */
    /* ---------------------------------------------------------- */

    public static void RegisterSink(MainForm form)
    {
        lock (Gate) { if (!sinks.Contains(form)) sinks.Add(form); }
    }

    // A window is closing: unsubscribe it; only when the LAST window goes
    // down are the running downloads paused (Shutdown) — closing a secondary
    // window must not interrupt them.
    public static void WindowClosing(MainForm form)
    {
        bool last;
        lock (Gate) { sinks.Remove(form); last = sinks.Count == 0; }
        if (last) Shutdown();
    }

    // WebView2 has thread affinity: PostWebMessageAsJson must run on the
    // window's UI thread, so every push hops over with BeginInvoke.
    private static void Broadcast(string json)
    {
        MainForm[] targets;
        lock (Gate) targets = sinks.ToArray();
        foreach (var f in targets)
        {
            if (f == null || f.IsDisposed || !f.IsHandleCreated) continue;
            try { f.BeginInvoke((Action)(() => f.PostJson(json))); }
            catch { /* window is closing */ }
        }
    }

    private static void Notify(DownloadItem it)
    {
        try
        {
            Broadcast(JsonSerializer.Serialize(new
            {
                type = "download",
                item = new
                {
                    id = it.Id,
                    url = it.Url,
                    name = it.Name,
                    path = it.Path,
                    received = it.Received,
                    total = it.Total,
                    state = it.State,
                    speed = it.Speed,
                },
            }));
        }
        catch { }
    }

    private static void Toast(string text)
    {
        try { Broadcast(JsonSerializer.Serialize(new { type = "toast", text })); } catch { }
    }

    // After a shell (re)load the page has no download state; replay the whole
    // list through the same {type:"download"} message so the panel rebuilds.
    public static void PushAll()
    {
        DownloadItem[] snap;
        lock (Gate) snap = items.Skip(Math.Max(0, items.Count - 50)).ToArray();
        foreach (var it in snap) Notify(it);
    }

    /* ---------------------------------------------------------- */
    /* Start                                                        */
    /* ---------------------------------------------------------- */

    // Called from DownloadStarting on the UI thread after the native download
    // was refused.  suggestedPath is e.DownloadOperation.ResultFilePath (the
    // browser's default save path + name) and totalBytes is its
    // TotalBytesToReceive when the server told it (ulong?), else null.
    public static void Start(string url, string suggestedPath, ulong? totalBytes, string explicitDir = null)
    {
        var it = new DownloadItem
        {
            Id = NextId(),
            Url = url ?? "",
            Name = SanitizeName(FirstNonEmpty(
                string.IsNullOrWhiteSpace(suggestedPath) ? "" : Path.GetFileName(suggestedPath),
                NameFromUrl(url),
                "download")),
        };
        it.Total = totalBytes.HasValue && totalBytes.Value > 0 && totalBytes.Value <= long.MaxValue
            ? (long)totalBytes.Value : 0;
        try
        {
            // explicitDir: папка, выбранная пользователем в «Сохранить как…»
            // (askEach).  Без неё —.ResolveDir() (стандартные «Загрузки»).
            var dir = string.IsNullOrWhiteSpace(explicitDir) ? ResolveDir() : explicitDir;
            it.Path = UniquePath(Path.Combine(dir, it.Name));
            it.Name = Path.GetFileName(it.Path);
        }
        catch (Exception ex)
        {
            MainForm.DebugLog("download dir failed: " + ex.Message);
            it.State = "error";
            it.EndedAt = Now();
            lock (Gate) items.Add(it);
            Notify(it);
            Save();
            return;
        }
        lock (Gate) items.Add(it);
        Notify(it);
        Save();
        var op = new Op { Item = it };
        lock (Gate) ops[it.Id] = op;
        _ = Task.Run(() => DownloadLoop(op));
    }

    // Для диалога «Сохранить как…»: предсказанное имя и стартовая папка.
    public static string SuggestName(string url) => SanitizeName(NameFromUrl(url));
    public static string DefaultDir() => ResolveDir();

    private static string ResolveDir()
    {
        var cfg = SettingsStore.DownloadsDir();
        if (!string.IsNullOrWhiteSpace(cfg))
        {
            try { Directory.CreateDirectory(cfg); return cfg; }
            catch { /* битый путь в настройках — падаем в системные «Загрузки» */ }
        }
        // Стандартные «Загрузки» Windows (настройки обещают именно их для
        // пустого поля).  Если система их не отдала — папка рядом с exe.
        var known = KnownDownloadsDir();
        if (known.Length > 0) return known;
        var dir = Path.Combine(AppPaths.Root, "Downloads");
        Directory.CreateDirectory(dir);
        return dir;
    }

    // FOLDERID_Downloads через SHGetKnownFolderPath: OneDrive-редиректы и
    // переименования учитываются самой системой.
    [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath(ref Guid folderId, uint flags, IntPtr token, out IntPtr path);

    private static string KnownDownloadsDir()
    {
        try
        {
            var id = new Guid("374DE290-123F-4565-9164-39C4925E467B"); // FOLDERID_Downloads
            if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out var p) == 0 && p != IntPtr.Zero)
            {
                var s = System.Runtime.InteropServices.Marshal.PtrToStringUni(p);
                System.Runtime.InteropServices.Marshal.FreeCoTaskMem(p);
                if (!string.IsNullOrWhiteSpace(s) && Directory.Exists(s)) return s;
            }
        }
        catch { /* best-effort */ }
        return "";
    }

    private static int NextId() { lock (Gate) return ++seq; }

    private static string NameFromUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return "";
        var segs = u.AbsolutePath.Split('/').Where(s => s.Length > 0).ToArray();
        string name = segs.Length > 0 ? Uri.UnescapeDataString(segs[segs.Length - 1]) : "";
        if (string.IsNullOrWhiteSpace(name)) name = u.Host;
        return name;
    }

    private static string SanitizeName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "download";
        var bad = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (var ch in name)
            sb.Append(ch >= 32 && Array.IndexOf(bad, ch) < 0 ? ch : '_');
        name = sb.ToString().Trim().TrimEnd('.');
        if (name.Length == 0) return "download";
        if (name.Length > 120)
        {
            var ext = Path.GetExtension(name);
            if (ext.Length > 16) ext = "";
            name = name.Substring(0, 120 - ext.Length) + ext;
        }
        return name;
    }

    private static string UniquePath(string path)
    {
        if (!File.Exists(path)) return path;
        var ext = Path.GetExtension(path);
        var stem = path.Substring(0, path.Length - ext.Length);
        for (int i = 1; i < 1000; i++)
        {
            var cand = stem + " (" + i + ")" + ext;
            if (!File.Exists(cand)) return cand;
        }
        return stem + "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ext;
    }

    private static string FirstNonEmpty(params string[] values)
        => values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v)) ?? "";

    private static long Now() => (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;

    /* ---------------------------------------------------------- */
    /* Bridge commands ({"type":"download-cmd","id":N,"cmd":"..."}) */
    /* ---------------------------------------------------------- */

    public static void Command(int id, string cmd)
    {
        switch (cmd)
        {
            case "pause": Pause(id); break;
            case "resume": Resume(id); break;
            case "cancel": Cancel(id); break;
            case "open": Open(id); break;
            case "show": Show(id); break;
        }
    }

    private static void Pause(int id)
    {
        Op op = null;
        DownloadItem it = null;
        bool direct = false;
        lock (Gate)
        {
            it = items.FirstOrDefault(x => x.Id == id);
            if (it == null) return;
            if (ops.TryGetValue(id, out var running))
            {
                op = running;
                running.PauseRequested = true; // the loop turns the cancel into state=paused
            }
            else if (it.State == "downloading")
            {
                it.State = "paused"; // no live op (defensive): pause in place
                direct = true;
            }
            else return;
        }
        if (op != null) { try { op.Cts.Cancel(); } catch { } }
        else if (direct)
        {
            it.Speed = 0;
            Notify(it);
            Save();
        }
    }

    private static void Cancel(int id)
    {
        Op op = null;
        DownloadItem it = null;
        bool direct = false;
        lock (Gate)
        {
            it = items.FirstOrDefault(x => x.Id == id);
            if (it == null) return;
            if (ops.TryGetValue(id, out var running))
            {
                op = running;
                op.CancelRequested = true; // the loop deletes the file on cancel
            }
            else
            {
                // Not running (paused / errored / done): drop it and the file.
                it.Speed = 0;
                it.State = "canceled";
                it.EndedAt = Now();
                DeleteFile(it.Path);
                direct = true;
            }
        }
        // Notify/Save take Gate themselves — never call them under the lock.
        if (op != null) { try { op.Cts.Cancel(); } catch { } }
        else if (direct)
        {
            Notify(it);
            Save();
        }
    }

    private static void Resume(int id)
    {
        Op op = null;
        lock (Gate)
        {
            var it = items.FirstOrDefault(x => x.Id == id);
            if (it == null || ops.ContainsKey(id)) return;
            if (it.State != "paused" && it.State != "error") return;
            if (string.IsNullOrEmpty(it.Url) || string.IsNullOrEmpty(it.Path)) return;
            it.State = "downloading";
            it.EndedAt = 0;
            op = new Op { Item = it };
            ops[id] = op;
        }
        if (op == null) return;
        Notify(op.Item);
        Save();
        _ = Task.Run(() => DownloadLoop(op));
    }

    private static void Open(int id)
    {
        var path = Find(id)?.Path;
        try { if (!string.IsNullOrEmpty(path) && File.Exists(path))
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
        catch { }
    }

    private static void Show(int id)
    {
        var path = Find(id)?.Path;
        try { if (!string.IsNullOrEmpty(path) && File.Exists(path)) Reveal(path); }
        catch { }
    }

    private static DownloadItem Find(int id)
    {
        lock (Gate) return items.FirstOrDefault(x => x.Id == id);
    }

    private static void DeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static void Reveal(string path)
    {
        try { if (File.Exists(path)) Process.Start("explorer.exe", "/select,\"" + path + "\""); } catch { }
    }

    /* ---------------------------------------------------------- */
    /* The download loop                                            */
    /* ---------------------------------------------------------- */

    private static async Task DownloadLoop(Op op)
    {
        var it = op.Item;
        var token = op.Cts.Token;
        long lastBytes = 0;
        var lastTick = DateTime.UtcNow;
        FileStream fs = null;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(it.Path));
            // Open first, THEN build the Range header from the real file
            // length: a crash can leave fewer bytes on disk than the last
            // saved "received" and appending would corrupt the file.
            bool resume = it.Received > 0 && File.Exists(it.Path);
            fs = new FileStream(it.Path, resume ? FileMode.Append : FileMode.Create,
                FileAccess.Write, FileShare.Read, 65536);
            it.Received = fs.Length;
            using var req = new HttpRequestMessage(HttpMethod.Get, it.Url);
            if (it.Received > 0) req.Headers.Range = new RangeHeaderValue(it.Received, null);
            using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, token);

            if (it.Received > 0 && resp.StatusCode != HttpStatusCode.PartialContent)
            {
                if ((int)resp.StatusCode == 416 && it.Total > 0 && it.Received >= it.Total)
                {
                    // The partial file is already whole (e.g. resume of a
                    // finished download): nothing left to fetch.
                    FinishDone(it);
                    return;
                }
                if (!resp.IsSuccessStatusCode)
                    throw new HttpRequestException("HTTP " + (int)resp.StatusCode);
                // The server ignored the Range header: start over from zero.
                fs.Dispose();
                fs = new FileStream(it.Path, FileMode.Create, FileAccess.Write, FileShare.Read, 65536);
                it.Received = 0;
            }
            else if (!resp.IsSuccessStatusCode)
            {
                throw new HttpRequestException("HTTP " + (int)resp.StatusCode);
            }

            long? len = resp.Content.Headers.ContentLength;
            long expectedEnd = len.HasValue && len.Value >= 0 ? it.Received + len.Value : -1;

            lastBytes = it.Received;
            lastTick = DateTime.UtcNow;
            using var src = await resp.Content.ReadAsStreamAsync(token);
            var buffer = new byte[65536];
            while (true)
            {
                int n = await src.ReadAsync(buffer, 0, buffer.Length, token);
                if (n <= 0) break;
                await fs.WriteAsync(buffer, 0, n, token);
                it.Received += n;
                // Progress ticks: at most one push per 200 ms (5 Hz), speed
                // = delta bytes over delta time.
                var now = DateTime.UtcNow;
                double ms = (now - lastTick).TotalMilliseconds;
                if (ms >= 200)
                {
                    it.Speed = ms > 0 ? (long)((it.Received - lastBytes) * 1000 / ms) : 0;
                    lastBytes = it.Received;
                    lastTick = now;
                    Notify(it);
                }
            }
            if (expectedEnd >= 0 && it.Received < expectedEnd)
                throw new IOException("connection closed early");
            FinishDone(it);
        }
        catch (OperationCanceledException)
        {
            Interrupt(op);
        }
        catch (Exception ex)
        {
            MainForm.DebugLog("download " + it.Id + " failed: " + ex.Message);
            if (op.CancelRequested)
            {
                // A cancel raced with a network error — honor the cancel.
                Interrupt(op);
            }
            else
            {
                it.Speed = 0;
                it.State = "error";
                it.EndedAt = Now();
                Notify(it);
            }
        }
        finally
        {
            try { fs?.Dispose(); } catch { }
            lock (Gate) ops.Remove(it.Id);
            Save();
        }
    }

    private static void FinishDone(DownloadItem it)
    {
        it.Speed = 0;
        it.State = "done";
        it.EndedAt = Now();
        Notify(it);
        Save();
        Toast("Загрузка завершена: " + it.Name);
        if (SettingsStore.DownloadsAutoOpen()) Reveal(it.Path);
    }

    // CTS fired from the bridge: pause keeps the file, cancel removes it.
    private static void Interrupt(Op op)
    {
        var it = op.Item;
        it.Speed = 0;
        if (op.CancelRequested)
        {
            it.State = "canceled";
            it.EndedAt = Now();
            DeleteFile(it.Path);
        }
        else
        {
            it.State = "paused";
        }
        Notify(it);
        Save();
    }

    // App is closing: stop everything as paused so the next start can resume.
    public static void Shutdown()
    {
        Op[] running;
        lock (Gate)
        {
            running = ops.Values.ToArray();
            foreach (var op in running) op.PauseRequested = true;
        }
        foreach (var op in running) try { op.Cts.Cancel(); } catch { }
        Save();
    }
}
