using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Windows.Forms;

namespace LiveBrowser;

/// <summary>
/// State layer: what survives the window.
///
/// Split out of MainForm so the persistence rules (crash marker, restore
/// list, window geometry) can be read without scrolling past 4k lines of UI.
/// These classes still run on the UI thread where the window owns them —
/// the point is ownership, not offloading: nothing here touches a WebView2,
/// and every method is a no-op when the portable folder is read-only.
/// </summary>

/// <summary>Remembers window size/position/state between runs.</summary>
internal static class WindowStateStore
{
    public sealed class State { public int X, Y, W, H; public bool Max; }

    public static State Load()
    {
        try
        {
            if (File.Exists(AppPaths.WindowFile))
                return JsonSerializer.Deserialize<State>(File.ReadAllText(AppPaths.WindowFile));
        }
        catch { }
        return null;
    }

    // A monitor can disappear between runs: a saved rectangle that no longer
    // touches any screen is pulled back to the primary one.
    public static Rectangle ClampToScreens(Rectangle r)
    {
        foreach (var s in Screen.AllScreens)
            if (Rectangle.Intersect(s.WorkingArea, r).Width >= 120)
                return r;
        var wa = Screen.PrimaryScreen.WorkingArea;
        r.Width = Math.Min(r.Width, wa.Width);
        r.Height = Math.Min(r.Height, wa.Height);
        r.X = wa.X + (wa.Width - r.Width) / 2;
        r.Y = wa.Y + (wa.Height - r.Height) / 2;
        return r;
    }

    public static void Save(Form f)
    {
        try
        {
            var r = f.WindowState == FormWindowState.Normal ? f.Bounds : f.RestoreBounds;
            var s = new State
            {
                X = r.X, Y = r.Y, W = r.Width, H = r.Height,
                Max = f.WindowState == FormWindowState.Maximized,
            };
            File.WriteAllText(AppPaths.WindowFile, JsonSerializer.Serialize(s));
        }
        catch { }
    }
}

/// <summary>Reopens the tabs that were open when the browser was closed.</summary>
internal static class SessionStore
{
    private const int MaxTabs = 20;

    // Маркер аварийного выхода: Program.Main ставит его ДО создания окна,
    // штатный FormClosing снимает.  Остался на старте = прошлый сеанс не
    // был закрыт нормально (убили процесс, падение, выдернули питание).
    private static string CrashFile => Path.Combine(AppPaths.Root, "crash.flag");

    public static void MarkRunning()
    {
        try { File.WriteAllText(CrashFile, DateTime.UtcNow.ToString("o")); } catch { }
    }

    public static bool CrashedLastTime()
    {
        try { return File.Exists(CrashFile); } catch { return false; }
    }

    public static void MarkCleanExit()
    {
        try { if (File.Exists(CrashFile)) File.Delete(CrashFile); } catch { }
    }

    public static void Save(System.Collections.Generic.IEnumerable<TabPage> tabs)
    {
        try
        {
            var urls = tabs.Where(t => t.Id != 0 && t.Alive)
                           .Select(t => t.Url)
                           .Reverse()
                           .Where(u => u.StartsWith("http"))
                           .Take(MaxTabs)
                           .Reverse()
                           .ToArray();
            File.WriteAllText(AppPaths.SessionFile, JsonSerializer.Serialize(urls));
        }
        catch { }
    }

    public static string[] Load()
    {
        try
        {
            if (!File.Exists(AppPaths.SessionFile)) return Array.Empty<string>();
            var urls = JsonSerializer.Deserialize<string[]>(File.ReadAllText(AppPaths.SessionFile));
            return urls ?? Array.Empty<string>();
        }
        catch { return Array.Empty<string>(); }
    }
}
