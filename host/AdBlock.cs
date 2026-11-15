using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace LiveBrowser;

/// <summary>
/// Host-level ad and tracker blocking.
///
/// Two things are deliberately NOT here.  First, no full ABP engine: the
/// browser needs to stop the obvious ad/tracker hosts, not to reproduce
/// cosmetic filtering and $replace rules, and an untested rule interpreter
/// breaks sites in ways nobody can debug.  Second, no network on start: the
/// built-in list is compiled in and always present, so a fresh portable build
/// blocks the big networks offline.  "Update list" is an explicit button that
/// fetches host-only entries and merges them into a cache file; the built-in
/// entries are never removed by an update.
///
/// Matching is by host suffix (an entry "doubleclick.net" covers
/// "ad.doubleclick.net") and never by path or query: a host entry is the only
/// thing that cannot misfire on an ordinary site.
/// </summary>
internal static class AdBlock
{
    // Big ad exchanges, trackers and telemetry that pages embed.  Kept short
    // on purpose: a wrong entry here shows up as a broken page and costs more
    // than the ad it saved.  Entries match their subdomains too.
    private static readonly string[] BuiltIn =
    {
        // Ad exchanges / SSPs
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "adservice.google.com", "pagead2.googlesyndication.com",
        "amazon-adsystem.com", "adnxs.com", "rubiconproject.com", "pubmatic.com",
        "openx.net", "casalemedia.com", "criteo.com", "criteo.net",
        "taboola.com", "outbrain.com", "adfox.ru", "an.yandex.ru",
        "ads.yandex.ru", "yandexadexchange.net", "adriver.ru", "luxup.ru",
        "relap.io", "smi2.ru", "directadvert.ru", "mytarget.ru",
        "ad.mail.ru", "weborama.fr", "smartadserver.com", "adform.net",
        // Trackers / analytics
        "google-analytics.com", "googletagmanager.com", "mc.yandex.ru",
        "metrika.yandex.ru", "top-fwz1.mail.ru", "scorecardresearch.com",
        "quantserve.com", "hotjar.com", "fullstory.com", "mixpanel.com",
        "amplitude.com", "segment.io", "segment.com", "heapanalytics.com",
        "branch.io", "adjust.com", "appsflyer.com", "crashlytics.com",
        "bugsnag.com", "sentry-cdn.com", "newrelic.com", "nr-data.net",
        // Session replay / fingerprinting
        "clarity.ms", "mouseflow.com", "luckyorange.com", "inspectlet.com",
        "crazyegg.com", "sessioncam.com", "smartlook.com",
    };

    private static HashSet<string> builtin;
    private static HashSet<string> extra;
    private static readonly object gate = new();

    // The fetched list lives next to settings.json so a portable copy keeps
    // its blocklist.  Rebuilt only when the file changes on disk.
    private static string CacheFile => Path.Combine(AppPaths.Root, "adblock-cache.txt");
    private static DateTime cacheStamp = DateTime.MinValue;

    public static int BlockedThisSession { get; private set; }
    public static int SinceNavReset { get; private set; }

    /// <summary>Called on every navigation start: the shield shows per-page numbers.</summary>
    public static void ResetPageCounter() => SinceNavReset = 0;

    private static HashSet<string> Builtin
    {
        get
        {
            lock (gate)
                return builtin ??= new HashSet<string>(BuiltIn, StringComparer.OrdinalIgnoreCase);
        }
    }

    // Cache file format: one host per line, "#" starts a comment.  Anything
    // else (an ABP line with options, a cosmetic rule, an url path) is skipped
    // rather than guessed at — a wrong interpretation is a broken page.
    private static HashSet<string> Extra
    {
        get
        {
            lock (gate)
            {
                DateTime stamp;
                try { stamp = File.Exists(CacheFile) ? File.GetLastWriteTimeUtc(CacheFile) : DateTime.MinValue; }
                catch { stamp = DateTime.MinValue; }
                if (extra != null && stamp == cacheStamp) return extra;

                var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                try
                {
                    if (File.Exists(CacheFile))
                        foreach (var raw in File.ReadAllLines(CacheFile))
                        {
                            var host = ParseHostLine(raw);
                            if (host != null) set.Add(host);
                        }
                }
                catch { /* an unreadable cache just means the built-in list */ }
                extra = set;
                cacheStamp = stamp;
                return extra;
            }
        }
    }

    // One line → host, or null when the line is not a plain host entry.
    //   ||doubleclick.net^        EasyList style
    //   doubleclick.net           plain
    //   0.0.0.0 doubleclick.net   hosts-file style
    // Rejected: "! comment", "# comment", "@@ exceptions" (the user might want
    // the site back, and honouring exceptions needs rule ordering, which this
    // list does not model), anything with "/" or "$" in it.
    private static string ParseHostLine(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var line = raw.Trim();
        if (line.Length == 0 || line[0] == '!' || line[0] == '#' || line.StartsWith("@@")) return null;

        // hosts file: "0.0.0.0  host" / "127.0.0.1 host"
        var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 2 && (parts[0] == "0.0.0.0" || parts[0] == "127.0.0.1" || parts[0] == "::1"))
            line = parts[1];

        if (line.StartsWith("||")) line = line.Substring(2);
        if (line.EndsWith("^")) line = line.Substring(0, line.Length - 1);
        if (line.IndexOf('/') >= 0 || line.IndexOf('$') >= 0 || line.IndexOf('*') >= 0) return null;
        line = line.Trim().ToLowerInvariant();
        if (line.Length < 4 || line.IndexOf('.') < 0) return null;
        foreach (var ch in line)
            if (!(char.IsLetterOrDigit(ch) || ch == '.' || ch == '-' || ch == '_')) return null;
        return line;
    }

    /// <summary>
    /// True when the request should be stopped.  Only hosts are consulted:
    /// "example.com" and every subdomain of it.
    /// </summary>
    public static bool ShouldBlock(string requestUri)
    {
        if (string.IsNullOrEmpty(requestUri)) return false;
        if (!Uri.TryCreate(requestUri, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return false;
        return IsBlockedHost(u.Host);
    }

    public static bool IsBlockedHost(string host)
    {
        if (string.IsNullOrEmpty(host)) return false;
        host = host.ToLowerInvariant();
        // Try the full host and every parent domain: "ad.doubleclick.net"
        // matches the "doubleclick.net" entry, "doubleclick.net" itself too.
        for (var h = host; h.Length > 0; h = Parent(h))
        {
            if (Builtin.Contains(h) || Extra.Contains(h)) return true;
            if (h.IndexOf('.') < 0) break;
        }
        return false;
    }

    private static string Parent(string host)
    {
        var dot = host.IndexOf('.');
        return dot < 0 ? string.Empty : host.Substring(dot + 1);
    }

    public static void CountBlocked()
    {
        lock (gate) { BlockedThisSession++; SinceNavReset++; }
    }

    public static int BuiltinCount => Builtin.Count;
    public static int ExtraCount => Extra.Count;

    public static object Stats() => new
    {
        type = "adblock",
        blocked = SinceNavReset,
        total = BlockedThisSession,
        builtin = Builtin.Count,
        extra = Extra.Count,
    };

    // Sources tried in order.  Both are host-list formats that ParseHostLine
    // understands; a failure in one falls through to the next.
    private static readonly string[] Sources =
    {
        "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
        "https://raw.githubusercontent.com/AdguardTeam/cname-trackers/master/data/combined_disguised_trackers_justdomains.txt",
    };

    /// <summary>
    /// "Update list" button.  Downloads a public host list, keeps only the
    /// host entries this browser can use, and writes the cache file.  Returns
    /// a JSON-able result for the shell.
    /// </summary>
    public static async Task<object> UpdateAsync()
    {
        var errors = new StringBuilder();
        foreach (var url in Sources)
        {
            try
            {
                using var http = ShellApi.NewClient(TimeSpan.FromSeconds(25));
                var text = await http.GetStringAsync(url);
                var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in text.Split('\n'))
                {
                    var host = ParseHostLine(line);
                    if (host != null) hosts.Add(host);
                }
                if (hosts.Count < 100)
                {
                    errors.Append(url).Append(": only ").Append(hosts.Count).Append(" hosts; ");
                    continue;
                }
                var sb = new StringBuilder();
                sb.Append("# LiveBrowser ad/tracker hosts, fetched ").Append(DateTime.Now.ToString("u")).Append('\n');
                sb.Append("# source: ").Append(url).Append('\n');
                sb.Append("# host-only entries; built-in list stays in effect regardless\n");
                foreach (var h in hosts.OrderBy(x => x, StringComparer.Ordinal))
                    sb.Append(h).Append('\n');
                var tmp = CacheFile + ".tmp";
                File.WriteAllText(tmp, sb.ToString());
                if (File.Exists(CacheFile)) File.Delete(CacheFile);
                File.Move(tmp, CacheFile);
                lock (gate) { extra = null; cacheStamp = DateTime.MinValue; }   // re-read on next use
                DebugLog($"adblock update ok hosts={hosts.Count} source={url}");
                return new { ok = true, count = hosts.Count, total = Builtin.Count + hosts.Count, error = "" };
            }
            catch (Exception ex)
            {
                errors.Append(url).Append(": ").Append(ex.Message).Append("; ");
            }
        }
        DebugLog("adblock update failed " + errors);
        return new { ok = false, count = 0, total = Builtin.Count + Extra.Count, error = errors.ToString() };
    }

    // The probe's fixture lives under dist/_sc, so it is the one place where a
    // local http page may embed a blocked url and prove the filter works.
    private static void DebugLog(string line)
    {
        try
        {
            File.AppendAllText(Path.Combine(AppPaths.Root, "debug.log"),
                $"{DateTime.Now:HH:mm:ss.fff} {line}\r\n");
        }
        catch { }
    }
}
