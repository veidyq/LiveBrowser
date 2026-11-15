using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace LiveBrowser;

/// <summary>
/// Privacy / data panel helpers for the shell: cookies, profile size, memory
/// and the "clear browsing data" actions.  WebView2 keeps everything itself in
/// profile\ — this class only asks the running controller (CoreWebView2Profile /
/// CookieManager) and measures the folder on disk.
///
/// Every method is best-effort: WebView2's own calls can throw when the
/// runtime is older than the SDK, so the failures surface as a smaller number
/// or a no-op instead of an exception in the page.
/// </summary>
internal static class DataStore
{
    /* ---------------------------------------------------------- */
    /* Cookies                                                      */
    /* ---------------------------------------------------------- */

    /// <summary>
    /// Cookie count for the active tab's site: GetCookiesAsync(uri) returns
    /// exactly the cookies a navigation to that uri would send.  There is no
    /// GetAllCookiesAsync in the 1.0.4314 SDK (only DeleteAllCookies), so a
    /// profile-wide number cannot be produced — the count is per active site
    /// (0 on the home tab, i.e. no site = no site cookies to show).
    /// </summary>
    public static async Task<int> CookieCountAsync(string url)
    {
        try
        {
            if (!Uri.TryCreate(url ?? "", UriKind.Absolute, out var uri)) return 0;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return 0;
            var cm = CookieManager;
            if (cm == null) return 0;
            var list = await cm.GetCookiesAsync(uri.GetLeftPart(UriPartial.Authority) + "/");
            return list?.Count ?? 0;
        }
        catch { return 0; }
    }

    // The controller that owns the running profile.  Set by MainForm once a
    // view exists (all views share the same profile), null during shutdown.
    private static CoreWebView2 _controller;

    public static void AttachController(CoreWebView2 controller)
    {
        if (controller != null) _controller = controller;
    }

    private static CoreWebView2CookieManager CookieManager
    {
        get
        {
            try { return _controller?.CookieManager; }
            catch { return null; }
        }
    }

    /* ---------------------------------------------------------- */
    /* Clearing                                                     */
    /* ---------------------------------------------------------- */

    /// <summary>
    /// {"what":"cache"|"cookies"|"history"|"all"} — cache and cookies go
    /// through CoreWebView2Profile.ClearBrowsingDataAsync, history through
    /// the host's own History store.  Returns true when the request was
    /// accepted (failure of the WebView2 call is reported as false).
    /// </summary>
    public static async Task<bool> ClearAsync(string what)
    {
        try
        {
            switch ((what ?? "").Trim().ToLowerInvariant())
            {
                case "history":
                    History.Clear();
                    return true;

                // Disk cache + the storage blobs that refill it (cache storage,
                // service workers).  The HTTP cache entries themselves are the
                // first two kinds; "all" below covers everything WebView2 keeps.
                case "cache":
                    return await ClearProfileAsync(CoreWebView2BrowsingDataKinds.DiskCache
                        | CoreWebView2BrowsingDataKinds.CacheStorage
                        | CoreWebView2BrowsingDataKinds.ServiceWorkers);

                // Cookies alone would leave localStorage sessions ("stay
                // signed in" flags live there too), so the DOM storage goes.
                case "cookies":
                    return await ClearProfileAsync(CoreWebView2BrowsingDataKinds.Cookies
                        | CoreWebView2BrowsingDataKinds.AllDomStorage);

                case "all":
                    // History lives in the host file; drop it first so the
                    // report is honest even if the runtime call fails.
                    History.Clear();
                    return await ClearProfileAsync(CoreWebView2BrowsingDataKinds.AllProfile);

                default:
                    return false;
            }
        }
        catch { return false; }
    }

    private static async Task<bool> ClearProfileAsync(CoreWebView2BrowsingDataKinds kinds)
    {
        try
        {
            var profile = _controller?.Profile;
            if (profile == null) return false;
            await profile.ClearBrowsingDataAsync(kinds);
            return true;
        }
        catch { return false; }
    }

    /* ---------------------------------------------------------- */
    /* Status numbers                                               */
    /* ---------------------------------------------------------- */

    /// <summary>Size of profile\ in megabytes (rounded), 0 when not created yet.</summary>
    public static double ProfileSizeMb()
    {
        try
        {
            if (!Directory.Exists(AppPaths.ProfileDir)) return 0;
            long total = 0;
            foreach (var f in Directory.EnumerateFiles(AppPaths.ProfileDir, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(f).Length; }
                catch { /* file vanished mid-scan (WebView2 churn) */ }
            }
            return Math.Round(total / (1024.0 * 1024.0), 1);
        }
        catch { return 0; }
    }

    /// <summary>Working set of the whole host process, MB.</summary>
    public static double WorkingSetMb()
    {
        try
        {
            using var p = Process.GetCurrentProcess();
            return Math.Round(p.WorkingSet64 / (1024.0 * 1024.0), 1);
        }
        catch { return 0; }
    }

}
