using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace LiveBrowser;

/// <summary>Frameless window helpers: drag, resize, rounded corners, shadow.</summary>
internal static class Win
{
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);

    public const int WM_NCLBUTTONDOWN = 0xA1;
    public const int HTCAPTION = 2;

    /// <summary>
    /// Raises a child window to the top of the z-order WITHOUT activating it.
    /// Control.BringToFront() on a WebView2 steals the WinForms focus (the
    /// omnibox then blurs and the dropdown kills itself mid-typing); this
    /// keeps the keyboard focus exactly where the user left it.
    /// </summary>
    public static void RaiseNoActivate(IntPtr hwnd)
    {
        // HWND_TOP(0) | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040);
    }

    public static void Drag(IntPtr hwnd)
    {
        ReleaseCapture();
        SendMessage(hwnd, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
    }

    /// <summary>Dark title area + rounded corners so the window never flashes white.</summary>
    public static void Style(IntPtr hwnd, Color caption, bool darkTheme = true)
    {
        // The immersive flag also decides what native widgets inside WebView2
        // (context menu, scrollbars of the shell page) look like, so it has to
        // follow the shell's light/dark mode, not just the caption colour.
        int dark = darkTheme ? 1 : 0;
        DwmSetWindowAttribute(hwnd, 20, ref dark, sizeof(int)); // DWMWA_USE_IMMERSIVE_DARK_MODE (20H1+)
        DwmSetWindowAttribute(hwnd, 19, ref dark, sizeof(int)); // pre-20H1
        int color = caption.B | (caption.G << 8) | (caption.R << 16); // COLORREF
        DwmSetWindowAttribute(hwnd, 35, ref color, sizeof(int)); // DWMWA_CAPTION_COLOR
        int round = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(hwnd, 33, ref round, sizeof(int));
    }
    // Скруглённая область для вьюхи панели (меню/подсказки над сайтом).
    // Вне региона вьюха физически не существует: ни пикселей, ни кликов —
    // углы карточки всегда показывают сайт, независимо от прозрачности
    // вьюхи и её DefaultBackgroundColor.  Регион пересоздаётся на каждый
    // показ (bounds меняются), SetWindowRgn забирает владение регионом.
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int cx, int cy);

    [DllImport("user32.dll")]
    private static extern bool SetWindowRgn(IntPtr hwnd, IntPtr rgn, bool redraw);

    public static void RoundChild(IntPtr hwnd, int w, int h, int radiusPx)
    {
        try
        {
            if (hwnd == IntPtr.Zero || w <= 0 || h <= 0) return;
            // ellipse = 2 × радиус (CSS radius 12px → 24 в параметре)
            var rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, radiusPx * 2, radiusPx * 2);
            if (rgn == IntPtr.Zero) return;
            SetWindowRgn(hwnd, rgn, false);
        }
        catch { /* регион — украшение: без него просто прямые углы */ }
    }
}
