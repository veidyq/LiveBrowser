using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace LiveBrowser;

/// <summary>
/// Кадры иконки из app.ico, которые вшиты в exe (csproj ApplicationIcon).
///
/// Зачем свой парсер вместо Icon.ExtractAssociatedIcon: тот отдаёт кадр
/// 32x32, и при DPI 150/200 % заголовок окна и панель задач показывают его
/// растянутым.  Explorer сам выбирает кадр под масштаб, приложение — нет.
///
/// Ещё одна причина: кадры в .ico у нас несжатые DIB (см. build-logo/draw.py),
/// поэтому Icon.FromHandle(SystemIcons) и подобные обходные пути не нужны —
/// кадр 256x256 читается напрямую.
/// </summary>
static class AppIcon
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadImage(IntPtr hinst, string name, uint type,
                                           int cx, int cy, uint load);

    private const uint IMAGE_ICON = 1;
    private const uint LR_DEFAULTCOLOR = 0x0000;
    private static readonly IntPtr IDI_APPLICATION = new IntPtr(32512);

    /// <summary>
    /// Иконка окна: кадр, ближайший к wanted px (обычно 16/24/32 по DPI).
    /// Любая ошибка — системная иконка, окно без иконки не оставляем.
    /// </summary>
    public static Icon Load(string exePath)
    {
        int want = 32;
        try { want = (int)(16 * CurrentDpi() / 96.0); } catch { }
        // 16/24/32/48/64: в .ico ровно эти кадры, поэтому берём ближайший
        // вверх, чтобы мелкий кадр не растягивался.
        int pick = want <= 16 ? 16 : want <= 24 ? 24 : want <= 32 ? 32 : want <= 48 ? 48 : 64;

        var h = LoadImage(IntPtr.Zero, exePath, IMAGE_ICON, pick, pick, LR_DEFAULTCOLOR);
        if (h != IntPtr.Zero)
        {
            try
            {
                // FromHandle не владеет хэндлом; Clone даёт независимую копию,
                // которую WinForms применит к окну и отпустит сама.
                using var shared = Icon.FromHandle(h);
                return (Icon)shared.Clone();
            }
            catch { /* падаем на системную */ }
        }
        try { return (Icon)SystemIcons.Application.Clone(); }
        catch { return null; }
    }

    private static uint CurrentDpi()
    {
        try
        {
            using var g = Graphics.FromHwnd(IntPtr.Zero);
            return (uint)g.DpiX;
        }
        catch { return 96; }
    }
}
