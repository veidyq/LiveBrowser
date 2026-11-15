using System;
using System.Collections.Generic;
using System.Net.Http;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LiveBrowser;

/// <summary>
/// Core layer: tab icon and page discovery.
///
/// Both jobs used to sit inline in WireSiteViewAsync — a ~470-line lambda in
/// the middle of the UI wiring.  Neither touches layout: they read a
/// document and raise results, so they live here and the UI only subscribes.
///
///   FaviconStore  host -> icon data-url, one LRU cache for the whole
///                 process (a second window must not lose the first one's
///                 icons), fetched through the shared ShellApi client.
///   PageAssets    tiny ExecuteScriptAsync probes: the page's own favicon
///                 links and whether it has a <video> (PiP menu item).
/// </summary>
internal static class FaviconStore
{
    // A site's icons rarely change: 300 hosts is far more than a session
    // touches, and the cap keeps a long browsing run from growing forever.
    private const int Cap = 300;

    private static readonly object Gate = new();
    private static readonly Dictionary<string, string> Data = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Queue<string> Order = new();

    public static bool TryGet(string host, out string dataUrl)
    {
        lock (Gate) return Data.TryGetValue(host, out dataUrl);
    }

    public static void Store(string host, string dataUrl)
    {
        if (string.IsNullOrEmpty(host) || string.IsNullOrEmpty(dataUrl)) return;
        lock (Gate)
        {
            if (!Data.ContainsKey(host)) Order.Enqueue(host);
            Data[host] = dataUrl;
            while (Data.Count > Cap && Order.Count > 0) Data.Remove(Order.Dequeue());
        }
    }

    public static int Count { get { lock (Gate) return Data.Count; } }
}

/// <summary>
/// Read-only probes into a live document.  Each returns an empty string on
/// any failure (page not ready, disposed view) so callers never throw.
/// </summary>
internal static class PageAssets
{
    // Links the page declares as its icon; the caller feeds these to
    // /api/favicon so the real (often SVG) icon wins over the root one.
    private const string FaviconScript =
        "(function(){try{var r=[];document.querySelectorAll(" +
        "'link[rel~=\"icon\"],link[rel=\"shortcut icon\"],link[rel=\"apple-touch-icon\"]," +
        "link[rel=\"apple-touch-icon-precomposed\"]')" +
        ".forEach(function(l){if(l.href)r.push(l.href);});return JSON.stringify(r.slice(0,4));}" +
        "catch(e){return '[]';}})()";

    public static async System.Threading.Tasks.Task<string> DeclaredIconsAsync(CoreWebView2 core)
    {
        if (core == null) return "[]";
        try { return await core.ExecuteScriptAsync(FaviconScript) ?? "[]"; }
        catch { return "[]"; }
    }

    // Does the document contain a <video> that is big enough to be the page's
    // own player?  Used to decide whether the context menu shows PiP.
    private const string VideoScript =
        "(function(){try{var v=document.querySelectorAll('video');" +
        "for(var i=0;i<v.length;i++){var r=v[i].getBoundingClientRect();" +
        "if(r.width>=120&&r.height>=68)return '1';}return '0';}catch(e){return '0';}})()";

    public static async System.Threading.Tasks.Task<bool> HasVideoAsync(CoreWebView2 core)
    {
        if (core == null) return false;
        try { return (await core.ExecuteScriptAsync(VideoScript))?.Trim('"') == "1"; }
        catch { return false; }
    }
}
