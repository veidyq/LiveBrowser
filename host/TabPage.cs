using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LiveBrowser;

/// <summary>
/// A single browser tab.  Its WebView2 lives in the main form as a child
/// control and only the active one is sized to the content area; all of them
/// stay alive so switching is instant and page state is never lost.
/// </summary>
internal sealed class TabPage : IDisposable
{
    public int Id;
    public WebView2 View;
    public string Url = "";
    public string Title = "Новая вкладка";
    public string Favicon = "";
    public int Accent = 0x7c5cff;
    public bool Loading;
    public bool Ready;
    // Звук вкладки: IsDocumentPlayingAudio из WebView2 и наш mute-переключатель.
    // Оба флага идут в push "tabs"; шелл рисует динамик на таблетке.
    public bool Audible;
    public bool Muted;
    // Гибернация: вкладка выгружена, вьюхи нет, адрес и снимок состояния
    // лежат в MainForm.sleptTabs.  Шелл рисует «спящий» значок на таблетке.
    public bool Slept;
    // Set when the tab is closed: late async callbacks (navigation, favicon,
    // the open sequence) check it so they never touch a disposed view.
    public bool Alive = true;
    // The address this tab is really on.  Set whenever a navigation starts, so
    // a failed load reports the target instead of the about:blank that
    // NavigateToString leaves in Source after a second error in the same tab.
    public string PendingUrl = "";
    // Every NavigationStarting bumps it.  A failed NavigationCompleted can
    // only be judged "final" if no newer attempt started meanwhile — a redirect
    // chain (fixup) and a user retry must cancel the pending error card.
    public int NavSeq;
    public int FailedNavSeq = -1;

    public string Host
    {
        get
        {
            try { return new Uri(Url).Host.Replace("www.", ""); }
            catch { return ""; }
        }
    }

    public void Dispose()
    {
        Alive = false;
        try { View?.Dispose(); } catch { /* teardown during shutdown */ }
        View = null;
    }
}
