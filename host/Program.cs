using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace LiveBrowser;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // One copy per folder, for real as well as for the probe: a second
        // instance started while the first is running shares its session and
        // history files (and, in probe mode, answers the same dialog and
        // writes the same debug.log, so neither run can ever finish its own
        // checklist).  A named mutex is released by the OS even on a kill, so
        // a crash never blocks the next start.
        using var single = new System.Threading.Mutex(true, SingleInstanceName, out var firstCopy);
        if (!firstCopy) return;

        // Онбординг: маркер первого запуска ставится САМЫМ ПЕРВЫМ делом —
        // раньше любых читателей/писателей settings.json (наблюдаемый
        // создатель файла срабатывает до стат-инициализации SettingsStore,
        // поэтому доверять «файла нет на момент класс-инита» нельзя).
        // Флаг снимается POST /api/settings (welcome-экран закончил).
        try
        {
            if (!File.Exists(Path.Combine(AppPaths.Root, "settings.json")))
                File.WriteAllText(Path.Combine(AppPaths.Root, "firstrun.flag"), "1");
        }
        catch { }

        // A profile left locked by a crash or a killed process makes every
        // later start fail with 0x800700AA ("resource is busy") and the dialog
        // blames the WebView2 runtime, which is not the problem.  The runtime
        // keeps a lock file at profile\EBWebView\Default\LOCK; if no LiveBrowser
        // is running, it is stale by definition and removing it is the fix.
        ClearStaleProfileLock();
        // A private profile that survived a hard kill is from a window that
        // is gone: its data is supposed to be wiped on close, so a leftover is
        // deleted here instead of being handed to the next private window.
        try
        {
            var leftover = AppPaths.ProfileDir + "-private";
            if (Directory.Exists(leftover)) Directory.Delete(leftover, true);
        }
        catch { /* a live private window of another copy owns it */ }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => ShowFatal(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => ShowFatal(e.ExceptionObject as Exception);

        // The persisted download list must be in memory before any window
        // (and therefore any shell page) can ask for it.
        DownloadManager.Load();

        // Маркер «сеанс идёт»: если процесс упадёт или его убьют, файл
        // останется и следующий старт спросит «Восстановить вкладки?»
        // (штатный выход снимает его в FormClosing).
        SessionStore.MarkRunning();

        Application.Run(new MainForm());
    }

    // Session-scoped and per folder: two portable copies in different folders
    // are two browsers and may both run.  Only letters, digits and '-' go into
    // the name — a Mutex name may not contain ':' or '\' beyond the "Local\"
    // prefix, and CreateMutex treats them as a path.
    private static string SingleInstanceName
    {
        get
        {
            var folder = (AppPaths.Root ?? "").ToLowerInvariant();
            var name = new System.Text.StringBuilder("Local\\LiveBrowser_");
            ulong hash = 1469598103934665603UL;               // FNV-1a, stable per folder
            foreach (var ch in folder)
            {
                if (char.IsLetterOrDigit(ch)) name.Append(ch);
                else if (name.Length < 64) name.Append('_');
                hash = (hash ^ ch) * 1099511628211UL;
            }
            return name + "_" + hash.ToString("x16");
        }
    }

    // 0x800700AA = ERROR_BUSY.  The runtime refuses to open a profile whose
    // previous owner did not release it; a window closed by force (taskkill,
    // Task Manager, a crash) always leaves that state behind.
    private static void ClearStaleProfileLock()    {
        try
        {
            var locks = new[]
            {
                Path.Combine(AppPaths.ProfileDir, "EBWebView", "Default", "LOCK"),
                Path.Combine(AppPaths.ProfileDir, "-ephemeral", "EBWebView", "Default", "LOCK"),
                // The private window's folder.  A private window killed by
                // force leaves this behind, and the *next* private window
                // would then fail to start.
                Path.Combine(AppPaths.ProfileDir + "-private", "EBWebView", "Default", "LOCK"),
            };
            foreach (var path in locks)
            {
                if (!File.Exists(path)) continue;
                // Another LiveBrowser (second window, or the old instance still
                // shutting down) legitimately owns the profile: then the lock is
                // live and the runtime itself decides who may enter.  Only our
                // own single-instance check can tell — try to take the file.
                try { using (var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { } }
                catch (IOException) { continue; }   // held by a live process
                catch (UnauthorizedAccessException) { continue; }
                try { File.Delete(path); } catch { }
            }
        }
        catch { /* best-effort: the runtime's own error is reported below */ }
    }

    private static void ShowFatal(Exception ex)
    {
        try
        {
            var log = Path.Combine(AppPaths.Root, "livebrowser-error.log");
            File.AppendAllText(log, $"[{DateTime.Now:u}] {ex}\r\n");
        }
        catch { /* logging is best-effort */ }
        MessageBox.Show(ex?.Message ?? "Неизвестная ошибка", "LiveBrowser", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

internal static class AppPaths
{
    // Everything portable: the exe reads its shell next to itself, so the
    // same folder works from C:, from the flash drive, or from a copy.
    public static string Root => AppContext.BaseDirectory;
    public static string ShellDir => Path.Combine(Root, "shell");
    public static string ProfileDir => Path.Combine(Root, "profile");
    public static string ThemeFile => Path.Combine(Root, "theme.json");
    public static string WindowFile => Path.Combine(Root, "window.json");
    public static string SessionFile => Path.Combine(Root, "session.json");
    public static string SettingsFile => Path.Combine(Root, "settings.json");
    public static string DownloadsFile => Path.Combine(Root, "downloads.json");
    public static string HistoryFile => Path.Combine(Root, "history.jsonl");
    public static string ShellUrl => "https://livebrowser.shell/index.html";
}
