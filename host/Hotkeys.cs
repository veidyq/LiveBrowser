using System;

namespace LiveBrowser;

/// <summary>
/// Core layer: one table of every browser shortcut.
///
/// There used to be three independent copies of this list — ProcessCmdKey
/// (window), HandleSiteKey (WinForms KeyDown on the site view) and
/// HandleSiteHotkey (the listener injected into every page) — and they had
/// already drifted: Ctrl+F and Ctrl+P worked from the window but not from a
/// site, zoom from the site skipped RememberZoom, Ctrl+Tab was shell-only.
/// Now each of the three just asks this table what a key means; if the
/// answer is not None, MainForm.Execute runs it.
///
/// Keys are physical (e.code / Keys enum), never characters: on a Russian
/// layout Ctrl+L reports 'л', so a character table would kill every shortcut.
/// </summary>
internal static class Hotkeys
{
    internal enum Cmd
    {
        None,
        // Ctrl+<key>
        NewTab,        // Ctrl+T        — home (the desktop) with the omnibox
        CloseTab,      // Ctrl+W
        ReopenTab,     // Ctrl+Shift+T
        NewWindow,     // Ctrl+N
        NewPrivate,    // Ctrl+Shift+N — a window with its own, wiped profile
        Omni,          // Ctrl+L, F6    — focus the shell omnibox
        Palette,       // Ctrl+K
        Find,          // Ctrl+F
        Print,         // Ctrl+P
        Reload,        // Ctrl+R, F5
        NextTab,       // Ctrl+Tab
        PrevTab,       // Ctrl+Shift+Tab
        ZoomIn,        // Ctrl+= / Ctrl+Num+
        ZoomOut,       // Ctrl+- / Ctrl+Num-
        ZoomReset,     // Ctrl+0 / Ctrl+Num0
        // Alt+<key>
        Back,          // Alt+Left
        Forward,       // Alt+Right
        // bare
        FocusMode,     // F11
        ExitFocus,     // Esc (only while focusMode is on)
        VerticalTabs,  // no key bound: kept reachable from the host side only
    }

    /// <summary>
    /// Map one key press to a command.  <paramref name="code"/> is the
    /// physical key: an e.code string ("KeyL", "Digit0", "ArrowLeft") from
    /// the injected listener, or Keys.ToString() ("L", "D0", "Left") from
    /// WinForms.  <paramref name="focusMode"/> gates Esc: outside focus mode
    /// Esc belongs to whatever is on screen.
    /// </summary>
    public static Cmd Map(string code, bool ctrl, bool shift, bool alt, bool focusMode)
    {
        if (code == null) return Cmd.None;

        // Bare keys first: a stray modifier must not turn F11 into nothing.
        if (!ctrl && !alt && !shift)
        {
            switch (code)
            {
                case "F11": return Cmd.FocusMode;
                case "Escape": return focusMode ? Cmd.ExitFocus : Cmd.None;
                case "F6": return Cmd.Omni;
                case "F5": return Cmd.Reload;
            }
            return Cmd.None;
        }

        // Alt+arrows: history, no Ctrl/Shift involved.
        if (alt && !ctrl && !shift)
        {
            if (code == "ArrowLeft" || code == "Left") return Cmd.Back;
            if (code == "ArrowRight" || code == "Right") return Cmd.Forward;
            return Cmd.None;
        }

        if (!ctrl || alt) return Cmd.None;

        if (shift)
        {
            switch (code)
            {
                case "KeyT": case "T": return Cmd.ReopenTab;
                case "KeyN": case "N": return Cmd.NewPrivate;
                case "Tab": return Cmd.PrevTab;
            }
            return Cmd.None;
        }

        switch (code)
        {
            case "KeyL": case "L": return Cmd.Omni;
            case "KeyK": case "K": return Cmd.Palette;
            case "KeyF": case "F": return Cmd.Find;
            case "KeyP": case "P": return Cmd.Print;
            case "KeyW": case "W": return Cmd.CloseTab;
            case "KeyT": case "T": return Cmd.NewTab;
            case "KeyN": case "N": return Cmd.NewWindow;
            case "KeyR": case "R": return Cmd.Reload;
            case "Tab": return Cmd.NextTab;
            case "Equal": case "Add": case "Oemplus": return Cmd.ZoomIn;
            case "Minus": case "Subtract": case "OemMinus": return Cmd.ZoomOut;
            case "Digit0": case "Numpad0": case "D0": return Cmd.ZoomReset;
        }
        return Cmd.None;
    }

    /// <summary>
    /// The command a shortcut has when nothing else is going on.  Used by
    /// the probe to compare the three keyboard entry points; declared here
    /// so the probe can never disagree with the table above.
    /// </summary>
    public static Cmd Reference(string code, bool ctrl, bool shift, bool alt)
        => Map(code, ctrl, shift, alt, focusMode: false);
}
