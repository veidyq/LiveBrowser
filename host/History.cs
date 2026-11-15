using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace LiveBrowser;

/// <summary>One visit row, shared with the shell through /api/history.</summary>
internal sealed class HistoryEntry
{
    public long T;      // unix ms of the visit
    public string Url = "";
    public string Title = "";
    public int Visits = 1;
}

/// <summary>
/// Visit history in history.jsonl next to the exe (no SQLite package in this
/// build).  One JSON object per line:
///   {"t":&lt;unix ms&gt;,"url":"...","title":"...","visits":1}
///
/// The newest 20000 entries are kept.  Lines are appended straight away
/// (cheap, atomic enough for a single writer) and the whole file is rewritten
/// — deduplicated by url, newest first — when it grows more than 1000 lines
/// past the limit, on a 5 minute timer and on exit.
///
/// Every public member is thread-safe (one lock) and swallows all I/O and
/// parse errors: history is a convenience, never a reason to break a page.
/// </summary>
internal static class History
{
    private const int MaxEntries = 20000;
    // Rewrite threshold: the file may hold up to this many rows before a
    // compaction collapses the repeated urls back into single lines.
    private const int CompactAbove = MaxEntries + 1000;

    private static readonly object Gate = new();
    // In-memory view, newest first, at most MaxEntries rows, deduplicated.
    private static readonly List<HistoryEntry> rows = new();
    private static bool loaded;
    private static string lastAddedUrl = "";
    private static DateTime lastCompact = DateTime.MinValue;

    /* ---------------------------------------------------------- */
    /* Load / compaction                                            */
    /* ---------------------------------------------------------- */

    /// <summary>Reads history.jsonl into memory once (safe to call repeatedly).</summary>
    public static void Load()
    {
        lock (Gate)
        {
            if (loaded) return;
            loaded = true;
            try
            {
                rows.Clear();
                var file = AppPaths.HistoryFile;
                if (!File.Exists(file)) return;
                using var stream = new FileStream(file, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream, Encoding.UTF8);
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    var e = ParseLine(line);
                    if (e != null) Insert(e);
                }
                // rows are already deduplicated in memory; the file still holds
                // one line per visit, so collapse it once on boot.
                lastCompact = DateTime.UtcNow;
            }
            catch { /* broken file: start with what we managed to read */ }
        }
    }

    // Newest first; an existing url absorbs the visit counter instead of
    // taking a second row.  Rows past the limit are dropped (oldest first).
    private static void Insert(HistoryEntry e)
    {
        var hit = rows.FindIndex(r => string.Equals(r.Url, e.Url, StringComparison.Ordinal));
        if (hit >= 0)
        {
            var r = rows[hit];
            r.T = Math.Max(r.T, e.T);
            r.Visits += e.Visits;
            if (!string.IsNullOrWhiteSpace(e.Title)) r.Title = e.Title;
            // Move it forward if it is not already in the right place.
            if (hit > 0 && (hit == 0 || rows[hit - 1].T < r.T))
            {
                rows.RemoveAt(hit);
                rows.Insert(FindSlot(r.T), r);
            }
            return;
        }
        rows.Insert(FindSlot(e.T), e);
        if (rows.Count > MaxEntries) rows.RemoveRange(MaxEntries, rows.Count - MaxEntries);
    }

    // Index of the first row older than t (list is sorted newest first).
    private static int FindSlot(long t)
    {
        int i = 0;
        while (i < rows.Count && rows[i].T >= t) i++;
        return i;
    }

    private static HistoryEntry ParseLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return null;
            var url = r.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null;
            if (string.IsNullOrWhiteSpace(url)) return null;
            var e = new HistoryEntry
            {
                Url = url,
                T = r.TryGetProperty("t", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt64() : 0,
                Title = r.TryGetProperty("title", out var ti) && ti.ValueKind == JsonValueKind.String ? ti.GetString() : "",
                Visits = r.TryGetProperty("visits", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)
                    && n > 0 ? n : 1,
            };
            if (e.T <= 0) e.T = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return e;
        }
        catch { return null; }
    }

    /* ---------------------------------------------------------- */
    /* Public API                                                   */
    /* ---------------------------------------------------------- */

    /// <summary>
    /// Records a visit.  Only http(s) urls are kept, the same url twice in a
    /// row is ignored (reloads / same-page anchors are not new visits).
    /// </summary>
    public static void Add(string url, string title)
    {
        try
        {
            if (!IsHttp(url)) return;
            lock (Gate)
            {
                Load();
                var live = lastAddedUrl;
                if (string.Equals(live, url, StringComparison.Ordinal)) return;
                lastAddedUrl = url;
                var e = new HistoryEntry
                {
                    T = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    Url = url,
                    Title = title ?? "",
                    Visits = 1,
                };
                Insert(e);
                AppendLine(e);
                // Automatic compaction: file growth or the 5 minute timer.
                bool big;
                var file = AppPaths.HistoryFile;
                try { big = File.Exists(file) && new FileInfo(file).Length > 4L * 1024 * 1024; }
                catch { big = false; }
                if (big || rows.Count > CompactAbove || DateTime.UtcNow - lastCompact > TimeSpan.FromMinutes(5))
                    Compact();
            }
        }
        catch { /* history never throws into the browser */ }
    }

    /// <summary>Case-insensitive substring over url + title, newest first.</summary>
    public static List<HistoryEntry> Search(string q, int limit)
    {
        try
        {
            lock (Gate)
            {
                Load();
                q = (q ?? "").Trim();
                var src = q.Length == 0
                    ? rows
                    : rows.Where(r => r.Url.Contains(q, StringComparison.OrdinalIgnoreCase)
                                   || (r.Title ?? "").Contains(q, StringComparison.OrdinalIgnoreCase));
                return Take(src, limit);
            }
        }
        catch { return new List<HistoryEntry>(); }
    }

    /// <summary>The newest entries, newest first.</summary>
    public static List<HistoryEntry> Recent(int limit)
    {
        try
        {
            lock (Gate) { Load(); return Take(rows, limit); }
        }
        catch { return new List<HistoryEntry>(); }
    }

    /// <summary>Number of distinct urls kept (for /api/status).</summary>
    public static int Count()
    {
        try { lock (Gate) { Load(); return rows.Count; } }
        catch { return 0; }
    }

    /// <summary>Drops a single url from memory and from the file.</summary>
    public static void Remove(string url)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(url)) return;
            lock (Gate)
            {
                Load();
                rows.RemoveAll(r => string.Equals(r.Url, url, StringComparison.Ordinal));
                if (string.Equals(lastAddedUrl, url, StringComparison.Ordinal)) lastAddedUrl = "";
                Compact();
            }
        }
        catch { }
    }

    /// <summary>Forgets everything (page "clear history").</summary>
    public static void Clear()
    {
        try
        {
            lock (Gate)
            {
                Load();
                rows.Clear();
                lastAddedUrl = "";
                lastCompact = DateTime.UtcNow;
                try { if (File.Exists(AppPaths.HistoryFile)) File.Delete(AppPaths.HistoryFile); }
                catch { }
            }
        }
        catch { }
    }

    /// <summary>Called on exit and from the timer: rewrite the file compacted.</summary>
    public static void Flush()
    {
        try { lock (Gate) { Load(); Compact(); } }
        catch { }
    }

    /* ---------------------------------------------------------- */
    /* File I/O                                                     */
    /* ---------------------------------------------------------- */

    private static bool IsHttp(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        return u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps;
    }

    private static List<HistoryEntry> Take(IEnumerable<HistoryEntry> src, int limit)
    {
        if (limit <= 0) limit = 50;
        if (limit > MaxEntries) limit = MaxEntries;
        return src.Take(limit)
                  .Select(r => new HistoryEntry { T = r.T, Url = r.Url, Title = r.Title, Visits = r.Visits })
                  .ToList();
    }

    private static void AppendLine(HistoryEntry e)
    {
        try
        {
            var line = JsonSerializer.Serialize(new { t = e.T, url = e.Url, title = e.Title ?? "", visits = e.Visits });
            var file = AppPaths.HistoryFile;
            // Append is a single write under the lock; a torn last line from a
            // crash is simply skipped by ParseLine on the next load.
            File.AppendAllText(file, line + "\n", Encoding.UTF8);
        }
        catch { /* disk full / locked: memory copy still works */ }
    }

    // Rewrites the whole file from the deduplicated in-memory list (newest
    // first) through temp + move, so a crash never leaves half a history.
    private static void Compact()
    {
        lastCompact = DateTime.UtcNow;
        try
        {
            if (rows.Count == 0)
            {
                if (File.Exists(AppPaths.HistoryFile)) File.Delete(AppPaths.HistoryFile);
                return;
            }
            var sb = new StringBuilder(rows.Count * 96);
            using (var ms = new MemoryStream(rows.Count * 96))
            {
                foreach (var r in rows)
                {
                    ms.SetLength(0);
                    using (var w = new Utf8JsonWriter(ms))
                    {
                        w.WriteStartObject();
                        w.WriteNumber("t", r.T);
                        w.WriteString("url", r.Url);
                        w.WriteString("title", r.Title ?? "");
                        w.WriteNumber("visits", r.Visits);
                        w.WriteEndObject();
                    }
                    sb.Append(Encoding.UTF8.GetString(ms.ToArray())).Append('\n');
                }
            }
            var tmp = AppPaths.HistoryFile + ".tmp";
            File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
            File.Move(tmp, AppPaths.HistoryFile, true);
        }
        catch { /* keep the old file on any failure */ }
    }

    // The JSON-lines file grows on every visit; the timer keeps it compact
    // while the browser sits idle too (5 min, no-op when nothing changed
    // since the last compaction).
    public static void StartTimer()
    {
        var timer = new System.Windows.Forms.Timer { Interval = 5 * 60 * 1000 };
        timer.Tick += (_, _) => _ = Task.Run(Flush);
        timer.Start();
        _timer = timer; // keep the timer reachable: a collected Timer stops
    }

    private static System.Windows.Forms.Timer _timer;
}
