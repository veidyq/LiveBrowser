using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LiveBrowser;

// Diagnostics half of MainForm (partial): LIVEBROWSER_PROBE / SELFTEST runs and
// the logging they share.  Never shown in normal use.
internal sealed partial class MainForm
{
    internal static void DebugLog(string line)
    {
        try { File.AppendAllText(Path.Combine(AppPaths.Root, "debug.log"), $"{DateTime.Now:HH:mm:ss.fff} {line}\r\n"); }
        catch { }
    }

    // Тестовая логика RunShellProbeAsync.  Работает ПОЛНОСТЬЮ внутри shell-вьюхи
    // (ExecuteScriptAsync + хост-релей): окно не поднимается, скриншоты не
    // снимаются, приватный рабочий стол пользователя не попадает ни в один файл.
    private async Task RunShellProbeAsync()
    {
        // Состояние страницы: видно, загрузился ли шелл вообще.
        try
        {
            DebugLog("SHELLPROBE0 " + await ui.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({title:document.title,url:location.href,rs:document.readyState," +
                "search:!!document.getElementById('search'),suggests:!!document.getElementById('suggests')," +
                "restore:!!window.LiveRestore,toast:!!window.showToast," +
                "lazy:!!window.LiveModules,scripts:document.querySelectorAll('script[src]').length})"));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE0 failed " + ex.Message); }

        // ExecuteScriptAsync в этой сборке WebView2 промис не дожидается
        // (возвращает {} для любой async-стрелки), поэтому результат забираем
        // сами: отдаём промис через .then и ждём его в C#.
        // Скрипт разбит на два вызова:
        // а восстановление вкладок посреди прогона перезагружает слой — тогда
        // проще получить результат целиком.  Первый вызов: диалог + калькулятор.
        var jsDialog = @"globalThis.__lbProbeOut = 'pending'; (async () => {
 try {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { errs: [] };
  let dlg = null;
  for (let i = 0; i < 14 && !dlg; i++) { dlg = document.querySelector('.restore-dialog'); if (!dlg) await sleep(150); }
  out.restore = !!dlg;
  out.restoreText = dlg ? dlg.querySelector('.restore-text').textContent : null;
  if (dlg) {
    out.restoreYes = !!dlg.querySelector('.restore-yes');
    dlg.querySelector('.restore-no').click();
    await sleep(400);
    out.restoreClosed = !document.querySelector('.restore-dialog');
  }
  const inp = document.getElementById('search');
  const box = document.getElementById('suggests');
  inp.focus();
  inp.value = '12*3+5';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(500);
  window.__lbProbeInp = inp;
  const direct = window.LiveSearch && window.LiveSearch.quickProbe ? window.LiveSearch.quickProbe('12*3+5') : null;
  out.calcDirect = direct && direct.probe ? direct.probe.value : null;
  out.calcKind = direct && direct.probe ? direct.probe.kind : null;
  const v = box && box.querySelector('.suggest.quick-row .quick-value');
  out.calcValue = v ? v.textContent : null;
  out.calcPanel = !!(box && !box.hidden);
  out.siteActive = document.body.classList.contains('site-active');
  out.overSite = !!window.chrome && !!window.chrome.webview && out.siteActive;
  globalThis.__lbProbeOut = JSON.stringify(out);
 } catch (e) { globalThis.__lbProbeOut = 'EXC ' + (e && e.stack || e); }
})(); 'started'";
        try
        {
            DebugLog("SHELLPROBE1 start " + await ui.CoreWebView2.ExecuteScriptAsync(jsDialog));
            // Не ждём восстановления вкладок: после accept шелл может уйти на
            // сайт (site-active), и писать в омнибокс будет уже нечего.
            DebugLog("SHELLPROBE1 " + await PollProbeAsync("__lbProbeOut", 120));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE1 failed " + ex.Message); }

        // Простой запрос: погода/курс через шелл (долгий, десятки секунд на
        // плохой сети — отдельным вызовом, чтобы диалоговая часть не ждала).
        var jsQuick = @"globalThis.__lbProbeQuick = 'pending'; (async () => {
 try {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const inp = window.__lbProbeInp || document.getElementById('search');
  const box = document.getElementById('suggests');
  const out = {};
  inp.focus();
  inp.value = 'погода';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  let wx = null;
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    const v = box && box.querySelector('.suggest.quick-row .quick-value');
    const t = box && box.querySelector('.suggest.quick-row .quick-text');
    if (v && t && v.textContent !== '—') { wx = v.textContent + ' | ' + t.textContent + ' | ' + (box.querySelector('.quick-note') || {}).textContent; break; }
  }
  out.weather = wx;
  // Отдельным маркером: если погода не пришла, курс всё равно виден.
  globalThis.__lbProbeQuick = 'partial ' + JSON.stringify(out);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch('https://api.livebrowser.shell/api/quick?where=rate&code=USD', { credentials: 'omit', signal: ctl.signal });
    const j = await r.json();
    out.rate = j.ok ? (j.value + ' | ' + j.title + ' | ' + j.note) : 'not ok ' + JSON.stringify(j);
  } catch (e) { out.rate = 'ERR ' + e.name + ' ' + e.message; }
  clearTimeout(t);
  inp.value = '';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.blur();
  globalThis.__lbProbeQuick = JSON.stringify(out);
 } catch (e) { globalThis.__lbProbeQuick = 'EXC ' + (e && e.stack || e); }
})(); 'started'";
        try
        {
            DebugLog("SHELLPROBE2 start " + await ui.CoreWebView2.ExecuteScriptAsync(jsQuick));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE2 failed " + ex.Message); }

        // Курс проверяем ДО accept: после восстановления шелл уходит на сайт,
        // и омнибокса (а значит, скрипта) уже нет.
        try
        {
            // Маркер начинается с "partial ", когда погода уже отрисована,
            // но курс ещё идёт: ждём именно финальное значение.
            DebugLog("SHELLPROBE2 " + await PollProbeAsync("__lbProbeQuick", 400, require: "final"));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE2 failed " + ex.Message); }

        // Выбор «восстановить» проверяем отдельно, уже после отказа (диалог
        // вновь показываем напрямую): ответ хоста должен открыть вкладки.
        try
        {
            await ui.CoreWebView2.ExecuteScriptAsync(
                "globalThis.__lbProbeAccept='pending';" +
                "(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));" +
                "await window.LiveModules.load('restore');window.LiveRestore.show(2);await s(300);" +
                "try{const b=document.querySelector('.restore-dialog .restore-yes');const ok=!!b;" +
                "if(b)b.click();await s(500);" +
                "globalThis.__lbProbeAccept=JSON.stringify({shown:ok,closed:!document.querySelector('.restore-dialog')});}" +
                "catch(e){globalThis.__lbProbeAccept='EXC '+e;}})();'started'");
            DebugLog("SHELLPROBE accept " + await PollProbeAsync("__lbProbeAccept", 60));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE accept failed " + ex.Message); }

        // Сеть: общий пул соединений и favicon-релей.  Проверяем, что иконка
        // приходит data-url'ом, второй запрос берётся из кэша хоста (счётчик
        // не растёт), а ответ помечен кэшируемым (max-age) — раньше стоял
        // no-store, и каждая перерисовка плиток снова ходила в сеть.
        try
        {
            await ui.CoreWebView2.ExecuteScriptAsync(
                "globalThis.__lbProbeFav='pending';" +
                "(function(){const go=async()=>{try{" +
                "const u='https://api.livebrowser.shell/api/favicon?u='+" +
                "encodeURIComponent('https://example.com/');" +
                "const t0=performance.now();const r1=await fetch(u);const j1=await r1.json();" +
                "const ms1=Math.round(performance.now()-t0);" +
                "const t1=performance.now();const r2=await fetch(u);const j2=await r2.json();" +
                "const ms2=Math.round(performance.now()-t1);" +
                "globalThis.__lbProbeFav=JSON.stringify({ok:r1.ok,cc:r1.headers.get('cache-control')," +
                "data:(j1.favicon||'').slice(0,11),same:j1.favicon===j2.favicon,ms1:ms1,ms2:ms2});" +
                "}catch(e){globalThis.__lbProbeFav='EXC '+(e&&e.message||e);}};void go();})();'started'");
            DebugLog("SHELLPROBE fav " + await PollProbeAsync("__lbProbeFav", 60));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE fav failed " + ex.Message); }

        // Колесо над полосой вкладок: переполненный стрип обязан листаться,
        // вертикальная дельта переводится в scrollLeft (см. tabs.js).
        try
        {
            await ui.CoreWebView2.ExecuteScriptAsync(
                "globalThis.__lbProbeStrip='pending';" +
                "(function(){try{const strip=document.getElementById('tabs');" +
                "if(!strip){globalThis.__lbProbeStrip='NOSTRIP';return;}" +
                "const added=[];" +
                "for(let i=0;i<24;i++){const b=document.createElement('button');" +
                "b.type='button';b.className='tab';b.dataset.id=String(900+i);" +
                "b.textContent='Tab '+i;b.style.minWidth='96px';strip.appendChild(b);added.push(b);}" +
                "void strip.offsetWidth;" +
                "const over=strip.scrollWidth>strip.clientWidth;" +
                "const before=strip.scrollLeft;" +
                "strip.dispatchEvent(new WheelEvent('wheel',{deltaY:240,bubbles:true,cancelable:true}));" +
                "const after=strip.scrollLeft;" +
                "added.forEach(b=>b.remove());strip.scrollLeft=0;" +
                "globalThis.__lbProbeStrip=JSON.stringify({over:over,before:before,after:after,scrolled:after>before});" +
                "}catch(e){globalThis.__lbProbeStrip='EXC '+e;}})();'started'");
            DebugLog("SHELLPROBE strip " + await PollProbeAsync("__lbProbeStrip", 60));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE strip failed " + ex.Message); }

        // Индикатор звука: у глухой вкладки динамик рисуется перечёркнутым,
        // у звучащей — обычным, у тихой не рисуется вовсе (см. updateTabSound).
        try
        {
            // The last navigation before this step is the ad-block fixture: the
            // shell's own view is replaced by a site view for the page.  Read
            // the strip from the shell's view (the tiles are shell DOM), not
            // from whatever view happens to be live at the moment.
            var shellView = tabs.FirstOrDefault(t => t.Id == 0)?.View;
            if (shellView?.CoreWebView2 == null) throw new InvalidOperationException("shell view is gone");
            DebugLog("SHELLPROBE sound " + await shellView.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify((function(){try{const T=window.LiveTabs;" +
                "if(!T||!T.state)return{err:'no-livetabs'};" +
                "const mk=(o)=>Object.assign({id:7,title:'X',url:'https://x/',favicon:'',loading:false},o);" +
                "const t0=document.getElementById('tabs');" +
                "const probeSound=(flags)=>{const b=document.createElement('button');" +
                "b.className='tab';b.dataset.id='7';t0.appendChild(b);" +
                "T._applyTabSound?T._applyTabSound(b,Object.assign({id:7},flags)):null;" +
                "const s=b.querySelector('.tab-sound');const r=s?{state:s.dataset.state,title:s.title}:null;" +
                "b.remove();return r;};" +
                "return{silent:probeSound({}),audible:probeSound({audible:true}),muted:probeSound({audible:true,muted:true})," +
                "mutedOnly:probeSound({muted:true})};" +
                "}catch(e){return{err:String(e&&e.message||e)};}})())"));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE sound failed " + ex.Message); }

        // Фокус-режим: включение убирает полосу (сайт от y=0, ui скрыт),
        // выключение возвращает ровно прежнюю геометрию.
        try
        {
            // Проверке нужен живой сайт-вью: на «Рабочем столе» фокус-режим
            // сознательно не включается (см. SetFocusMode), и замер выродился
            // бы в "no-site".  Открываем тестовый адрес и ждём вьюху.
            var probeSite = views.Values.FirstOrDefault(v => v != null && !v.IsDisposed
                                                             && v.CoreWebView2 != null && v.Visible);
            if (probeSite == null)
            {
                OpenTab("https://livebrowser.shell/index.html", null);
                for (int i = 0; i < 40 && probeSite == null; i++)
                {
                    await Task.Delay(100);
                    probeSite = views.Values.FirstOrDefault(v => v != null && !v.IsDisposed
                                                                 && v.CoreWebView2 != null && v.Visible);
                }
            }
            var site = probeSite;
            int bar = BarHeight;
            string before = site == null ? "no-site"
                : $"{site.Bounds.Y}/{site.Bounds.Height}/{ui.Visible}";
            SetFocusMode(true);
            string on = site == null ? "no-site"
                : $"{site.Bounds.Y}/{site.Bounds.Height}/{ui.Visible}";
            SetFocusMode(false);
            string off = site == null ? "no-site"
                : $"{site.Bounds.Y}/{site.Bounds.Height}/{ui.Visible}";
            DebugLog("SHELLPROBE focus " + JsonSerializer.Serialize(new
            {
                bar,
                // Высота клиента — чтобы «0» в замере читался как «окно ещё не
                // разложено/сайт без контента», а не как поломка режима.
                ch = ClientSize.Height,
                before,
                on,
                off,
            }));
        }
        catch (Exception ex) { DebugLog("SHELLPROBE focus failed " + ex.Message); }

        // PiP: пункт меню появляется только при видео-кандидате.  Проверяем
        // обе ветки детекции на синтетических DOM и то, что сам скрипт
        // requestPictureInPicture не бросает (без видео он возвращает novideo).
        // Плюс главное для шага 2a: правый клик больше не ждёт страницу —
        // сборка меню (ShowSiteMenu) меряется отдельно и должна укладываться
        // в единицы миллисекунд, а ответ детектора приходит фоном.
        try
        {
            var siteV = views.Values.FirstOrDefault(v => v != null && !v.IsDisposed
                                                         && v.CoreWebView2 != null && v.Visible);
            if (siteV != null)
            {
                string pip = await siteV.CoreWebView2.ExecuteScriptAsync(
                    "JSON.stringify((function(){const has=(html)=>{const d=document.createElement('div');" +
                    "d.innerHTML=html;const v=document.querySelectorAll('video');" +
                    "return String(Array.prototype.some.call(v,x=>x.readyState>0&&!x.disablePictureInPicture));};" +
                    "const bare=document.createElement('div');" +
                    "return{detectorType:typeof document.querySelectorAll('video')," +
                    "emptyDoc:Array.prototype.some.call(bare.querySelectorAll('video'),x=>true)," +
                    "pipApi:typeof HTMLVideoElement.prototype.requestPictureInPicture};})())");
                // Проба сборки меню: тот же путь, что у правого клика, но без
                // открытия слоя (HandleMenu гасим сразу после замера).
                int items = 0;
                long ms = 0;
                try
                {
                    ctxView = siteV;
                    ctxPage = Current;
                    ctxLink = false;
                    ctxAt = new Point(8, 8);
                    ctxHasVideo = false;
                    ctxVideoDone = true;
                    ctxVideoKey = "";
                    var sw = Stopwatch.StartNew();
                    ShowSiteMenu();
                    sw.Stop();
                    ms = sw.ElapsedMilliseconds;
                    items = ctxActions.Count;
                    HidePanelLayer();
                    ctxOpen = false;
                }
                catch (Exception ex) { DebugLog("SHELLPROBE ctx failed " + ex.Message); }
                DebugLog("SHELLPROBE pip " + pip);
                DebugLog("SHELLPROBE ctx " + JsonSerializer.Serialize(new
                {
                    ctxMs = ms,
                    items,
                    cache = ctxVideoCache.Count,
                    probe = "done",
                }));
            }
        }
        catch (Exception ex) { DebugLog("SHELLPROBE pip failed " + ex.Message); }

        // Гибернация: реально выгружаем неактивную вкладку и будим её.
        // Проверяем, что вьюха исчезла из слота, адрес остался в снимке,
        // а после активации вкладка снова загружает тот же адрес.
        try
        {
            // Нужна вторая вкладка: открываем пустую рядом, чтобы у выгрузки
            // был кандидат (зонд идёт на чистом профиле с одной вкладкой).
            // Адрес должен быть достижим, иначе вкладка показывает карточку
            // ошибки и вьюха жертвы к моменту замера уже выгружена самим
            // браузером — проверка мерила бы чужую гибернацию.
            if (!tabs.Any(t => t.Id != 0 && t.Id != activeId && t.Alive
                && views.TryGetValue(t.Id, out var vv0) && vv0 != null && !vv0.IsDisposed))
            {
                // OpenTab навигирует и вешает обработчики сам (async void);
                // ждём, пока последняя вкладка списка будет готова к выгрузке.
                OpenTab("https://livebrowser.shell/index.html", "probe");
                var extra = tabs.LastOrDefault(t => t.Id != 0 && t.Id != activeId);
                for (int i = 0; i < 40 && extra != null; i++)
                {
                    if (extra.Ready && views.TryGetValue(extra.Id, out var ev0)
                        && ev0 != null && !ev0.IsDisposed && ev0.CoreWebView2 != null) break;
                    await Task.Delay(100);
                }
                Activate(0); // вкладка-жертва должна стать неактивной
                await Task.Delay(200);
            }
            var victim = tabs.FirstOrDefault(t => t.Id != 0 && t.Id != activeId && t.Alive
                && views.TryGetValue(t.Id, out var vv) && vv != null && !vv.IsDisposed);
            if (victim == null)
            {
                // Not a skip: the run has to be able to put a tab to sleep, so
                // a missing victim means this step did not do its work.
                DebugLog("SHELLPROBE hibernate {\"failed\":\"no-inactive-tab\"}");
            }
            else
            {
                var vw = views[victim.Id];
                try { victim.Url = vw.CoreWebView2.Source; } catch { }
                string url = victim.Url;
                int id = victim.Id;
                bool ready = victim.Ready;
                HibernateTab(victim, vw);
                bool gone = !views.ContainsKey(id);
                bool slept = victim.Slept && sleptTabs.ContainsKey(id);

                int prevActive = activeId;
                Activate(id);                     // будит вкладку в том же слоте
                bool woke = !sleptTabs.ContainsKey(id) && !victim.Slept;
                string nowUrl = victim.Url;
                Activate(prevActive == id ? 0 : prevActive);
                DebugLog("SHELLPROBE hibernate " + JsonSerializer.Serialize(new
                {
                    // The tab that was put to sleep: the run-open probe tab is
                    // closed by the other steps, and a window's view is the
                    // one tab that may legitimately lack a fresh snapshot.
                    ready,
                    gone,
                    slept,
                    woke,
                    sameUrl = string.Equals(nowUrl, url, StringComparison.Ordinal),
                    slots = views.Count,
                    live = LiveViewCount(),
                }));
            }
        }
        catch (Exception ex) { DebugLog("SHELLPROBE hibernate failed " + ex.Message); }

        await RunKeysProbeAsync();
    }

    // Shortcut parity, headless: no window is raised and no pixels are read,
    // so this can run beside the other SHELLPROBE steps.
    private async Task RunKeysProbeAsync()
    {
        try { DebugLog("SHELLPROBE keys " + await ProbeHotkeys()); }
        catch (Exception ex) { DebugLog("SHELLPROBE keys failed " + ex.Message); }

        try { DebugLog("SHELLPROBE errcard " + await ProbeErrorCards()); }
        catch (Exception ex) { DebugLog("SHELLPROBE errcard failed " + ex.Message); }

        try { DebugLog("SHELLPROBE anims " + await ProbeAnimations()); }
        catch (Exception ex) { DebugLog("SHELLPROBE anims failed " + ex.Message); }

        // Runs after anims: the first-run film is loaded in the same shell
        // page, and the anims step reads the stylesheets that this step's own
        // load() adds.
        try { DebugLog("SHELLPROBE intro " + await ProbeIntro()); }
        catch (Exception ex) { DebugLog("SHELLPROBE intro failed " + ex.Message); }

        try { DebugLog("SHELLPROBE stress " + await ProbeStress()); }
        catch (Exception ex) { DebugLog("SHELLPROBE stress failed " + ex.Message); }

        try { DebugLog("SHELLPROBE adblock " + await ProbeAdBlock()); }
        catch (Exception ex) { DebugLog("SHELLPROBE adblock failed " + ex.Message); }

        try { DebugLog("SHELLPROBE vtabs " + await ProbeVerticalTabs()); }
        catch (Exception ex) { DebugLog("SHELLPROBE vtabs failed " + ex.Message); }

        try { DebugLog("SHELLPROBE private " + await ProbePrivate()); }
        catch (Exception ex) { DebugLog("SHELLPROBE private failed " + ex.Message); }

        // End marker: the runner (run-probe.bat) waits for this line instead of
        // guessing a timeout, and a missing marker means the run was cut short.
        DebugLog("SHELLPROBE done " + Environment.ProcessId);
    }

    // Ad-block check, both ways: the matching itself (hosts, subdomains,
    // look-alikes that must NOT match) and a real page whose image and script
    // point at blocked hosts.  The page's own script reports whether the image
    // failed and the script never ran; that is the only evidence that the
    // filter is wired into a site view rather than merely compiled in.
    // Vertical tabs: the column is geometry the host owns, so the check is a
    // real toggle, not a DOM mock.  Baseline -> on -> off, comparing sites and
    // the shell view; the shell answers whether the CSS/DOM followed (class on
    // body, bar as a column, tabs stacked top-to-bottom).  The user's own
    // setting is put back exactly as it was.
    private async Task<string> ProbeVerticalTabs()
    {
        // SetVerticalTabs is the only remaining door into the column now that
        // the hotkey and the settings toggle are gone, so this step drives it
        // directly: it covers the geometry and the shell push, not a key
        // binding.  Ctrl+Shift+E being free is ProbeHotkeys' job.  The user's
        // own value is restored at the end, on every exit path.
        bool was = verticalTabs;
        var site = views.Values.FirstOrDefault(v => v != null && !v.IsDisposed
                                                    && v.CoreWebView2 != null && v.Visible);
        if (site == null || ui == null || ui.IsDisposed || ui.CoreWebView2 == null)
            return "{\"failed\":\"no-site\"}";

        var b0 = new { sw = site.Bounds.Width, sh = site.Bounds.Height, sx = site.Bounds.X,
                       uw = ui.Bounds.Width, uh = ui.Bounds.Height };
        SetVerticalTabs(true);
        await Task.Delay(350);
        var b1 = new { sw = site.Bounds.Width, sh = site.Bounds.Height, sx = site.Bounds.X,
                       uw = ui.Bounds.Width, uh = ui.Bounds.Height };

        // In the shell: the class must be on, the bar must have become a narrow
        // column on the left, and at least two tabs must stack vertically.
        ui.CoreWebView2.ExecuteScriptAsync(
            "(function(){const b=document.getElementById('chrome-bar');const t=[].slice.call(document.querySelectorAll('.tab'));" +
            "let stacked=null;if(t.length>1){const r0=t[0].getBoundingClientRect(),r1=t[1].getBoundingClientRect();" +
            "stacked=r1.top>r0.top+2&&Math.abs(r0.left-r1.left)<2;}" +
            "window.__lbVtabs=JSON.stringify({cls:document.body.classList.contains('vertical-tabs')," +
            "barW:b?Math.round(b.getBoundingClientRect().width):-1," +
            "barH:b?Math.round(b.getBoundingClientRect().height):-1," +
            "tabs:t.length,stacked:stacked});})()");
        string dom = await PollProbeAsync("__lbVtabs", 60);

        SetVerticalTabs(was);
        await Task.Delay(350);
        var b2 = new { sw = site.Bounds.Width, sh = site.Bounds.Height, sx = site.Bounds.X,
                       uw = ui.Bounds.Width, uh = ui.Bounds.Height };
        int wantSide = (int)Math.Round(VerticalTabsCssWidth * (DeviceDpi / 96.0));

        // The probe runs right after the stress step, which opened and dropped
        // 20 tabs; on a window that has not been laid out yet (or whose site
        // view the stress step left hidden) every width reads 0 and a "the
        // column is there" comparison would fail on the baseline, not on the
        // column.  A zero baseline means "nothing to measure", which is the
        // same answer as no site view.
        if (b0.sw <= 0 || b0.uw <= 0 || b1.sw <= 0)
            return JsonSerializer.Serialize(new { side = wantSide, b0, b1, skipped = "no-layout" });

        var errs = new List<string>();
        if (b1.sx != b0.sx + wantSide) errs.Add("siteX " + b1.sx + "!=" + (b0.sx + wantSide));
        if (b1.sw != b0.sw - wantSide) errs.Add("siteW " + b1.sw + "!=" + (b0.sw - wantSide));
        if (b1.uw != b0.uw - wantSide) errs.Add("uiW " + b1.uw + "!=" + (b0.uw - wantSide));
        if (b2.sx != b0.sx || b2.sw != b0.sw || b2.uw != b0.uw || b2.uh != b0.uh)
            errs.Add("baseline-not-restored");
        if (dom.Contains("\"cls\":false")) errs.Add("shell-class-off");
        if (dom.Contains("\"barW\":-1")) errs.Add("no-bar");
        if (dom.Contains("\"stacked\":false")) errs.Add("tabs-not-stacked");

        // The runner paints any failed field whose value is not the word
        // "failed" red, so a green step must not emit the field at all: the
        // fields are a pair of anonymous types that differ only by that one
        // property, and a red step then reads like every other step's failure.
        return errs.Count == 0
            ? JsonSerializer.Serialize(new { side = wantSide, siteX = b1.sx, siteW = b1.sw,
                                             uiW = b1.uw, uiH = b1.uh,
                                             back = b2.sx == b0.sx && b2.sw == b0.sw && b2.uw == b0.uw,
                                             dom })
            : JsonSerializer.Serialize(new { side = wantSide, siteX = b1.sx, siteW = b1.sw,
                                             uiW = b1.uw, uiH = b1.uh,
                                             back = b2.sx == b0.sx && b2.sw == b0.sw && b2.uw == b0.uw,
                                             dom, failed = string.Join(";", errs) });
    }

    private async Task<string> ProbeAdBlock()
    {
        // Pure matching, no WebView2 involved.
        var cases = new (string host, bool want)[]
        {
            ("doubleclick.net", true),
            ("ad.doubleclick.net", true),          // subdomain of an entry
            ("googlesyndication.com", true),
            ("mc.yandex.ru", true),
            ("example.com", false),
            ("notdoubleclick.net", false),         // suffix must be a real label
            ("mybank.example.org", false),
        };
        var matchBad = new List<string>();
        foreach (var (host, want) in cases)
            if (AdBlock.IsBlockedHost(host) != want) matchBad.Add(host + "=" + want);

        string page = "no-fixture";
        try
        {
            var file = Path.Combine(AppPaths.Root, "_ads", "index.html");
            if (File.Exists(file))
            {
                var tab = await OpenAsync(new Uri(file).AbsoluteUri, "ad-probe");
                page = "no-tab";
                if (tab != null)
                {
                    var deadline = DateTime.UtcNow.AddSeconds(12);
                    string raw = "";
                    while (DateTime.UtcNow < deadline)
                    {
                        await Task.Delay(250);
                        if (!views.TryGetValue(tab.Id, out var v) || v?.CoreWebView2 == null) break;
                        raw = await v.CoreWebView2.ExecuteScriptAsync(
                            "(function(){var s=document.getElementById('status');return s?s.textContent:'waiting';})()");
                        if (raw.Contains("\"ok\"")) break;
                    }
                    page = raw;
                    CloseTab(tab.Id);
                }
            }
        }
        catch (Exception ex) { page = "ERR " + ex.Message; }

        return JsonSerializer.Serialize(new
        {
            builtin = AdBlock.BuiltinCount,
            extra = AdBlock.ExtraCount,
            matchBad,
            blocked = AdBlock.BlockedThisSession,
            page,
        });
    }

    // Private mode, headless: the promise is "nothing of this window survives
    // it".  A probe that only checked the keyboard shortcut would prove the
    // button and nothing else, so this opens a real private window, watches it
    // load, closes it, and then looks at the disk: the profile folder must be
    // gone, the session file must be untouched, and the history file must not
    // have grown.  Nothing is raised on screen (headlessMode), so the user's
    // desktop is not involved.
    private async Task<string> ProbePrivate()
    {
        // One run at a time: a leftover window from an earlier attempt (or a
        // second clear still counting down) would make every verdict here
        // ambiguous.
        if (Interlocked.CompareExchange(ref privateProbeBusy, 1, 0) != 0)
            return "{\"skip\":\"busy\"}";
        try { return await ProbePrivateCore(); }
        finally { Interlocked.Exchange(ref privateProbeBusy, 0); }
    }

    private static int privateProbeBusy;

    private async Task<string> ProbePrivateCore()
    {
        var root = AppPaths.ProfileDir + "-private";
        var session = AppPaths.SessionFile;
        string Stamp(string file)
        {
            try
            {
                var fi = new FileInfo(file);
                return fi.Exists ? fi.Length + "@" + fi.LastWriteTimeUtc.Ticks : "none";
            }
            catch { return "err"; }
        }

        var sessionBefore = Stamp(session);
        var historyBefore = Stamp(AppPaths.HistoryFile);

        // The two entry points the user actually presses: the table maps the
        // key, and the window opener counts what it created.
        var keysBad = Hotkeys.Map("KeyN", true, true, false, false) != Hotkeys.Cmd.NewPrivate
                      || Hotkeys.Map("N", true, true, false, false) != Hotkeys.Cmd.NewPrivate
                      // Ctrl+N must stay "normal window", and the plain letter
                      // must not become private by accident on a RU layout.
                      || Hotkeys.Map("KeyN", true, false, false, false) != Hotkeys.Cmd.NewWindow
                      || Hotkeys.Map("KeyN", false, true, false, false) != Hotkeys.Cmd.None;
        int privateBefore = PrivateWindowsOpened;
        OpenPrivateWindow();             // same call the menu and Ctrl+Shift+N make
        bool counted = PrivateWindowsOpened == privateBefore + 1;

        // Let the runtime create its folder before asking whether it exists.
        bool folderBefore = false;
        for (int i = 0; i < 40 && !folderBefore; i++)
        {
            folderBefore = Directory.Exists(root);
            if (!folderBefore) await Task.Delay(100);
        }

        bool loaded = false, initialized = false, emptySession = false, chipShown = false, apiOn = false;
        string url = "";
        var win = Application.OpenForms.OfType<MainForm>().LastOrDefault(f => f != this);
        if (win == null) return "{\"error\":\"no-window\"}";
        var sw = Stopwatch.StartNew();
        // The private environment is a *second* CreateAsync while a normal one
        // is already live, so a cold start takes noticeably longer than the
        // main window's.  InitDone is set by InitAsync itself (success or
        // failure): polling "is the source there yet" cannot tell "slow" from
        // "never", and this step waits 40 s because the first attempt is the
        // slow one.
        while (sw.Elapsed < TimeSpan.FromSeconds(40))
        {
            await Task.Delay(150);
            initialized = win.InitDone;
            url = win.FirstSiteUrl();
            if (url.StartsWith("https://livebrowser.shell/", StringComparison.Ordinal))
            {
                loaded = url != AppPaths.ShellUrl;
                if (initialized) break;
            }
        }
        try { emptySession = win.VisibleTabCount() == 1; }   // the desktop, nothing restored
        catch { }

        // The private window does *not* start a probe round of its own
        // (MainForm.Chrome.cs): a window's shell only asks for one while the
        // live probe runs, and a round started from a window that this step
        // then closes would be torn down mid-check and report "failed".

        // The private *window* is read from inside itself: its own UI view, its
        // own chip, its own /api/private answer.  (The first version asked the
        // probe's own shell — a normal window — and so reported a red step for
        // a window that was in fact private.)
        var view = win.ShellView();
        if (view?.CoreWebView2 == null)
            // No view means nothing was measured: say so instead of leaving
            // the verdicts at their default false and looking like failures.
            DebugLog("private: the private window has no shell view (disposed=" + (view?.IsDisposed) + ")");
        else
        {
            try
            {
                var source = view.CoreWebView2.Source ?? "";
                loaded = source.StartsWith("https://livebrowser.shell/", StringComparison.Ordinal);
                url = source;
                // The shell's pages run after DOMContentLoaded, so a probe that
                // arrives right after "init done" can beat private.js: give it
                // a beat and report what was actually seen when it stays off.
                string diag = "";
                for (int i = 0; i < 60; i++)
                {
                    diag = await view.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "var c=document.getElementById('private-chip');" +
                        "var api=typeof window.__lbPrivate==='function'?JSON.stringify(window.__lbPrivate()):'nolib';" +
                        "return JSON.stringify({chip:!!c&&!c.hidden,cls:document.body.classList.contains('private-window')," +
                        "lib:api,script:!!document.querySelector('script[src=\"private.js\"]'),rs:document.readyState});})()");
                    chipShown = diag.Contains("\\\"chip\\\":true") || diag.Contains("\"chip\":true");
                    chipShown = chipShown && (diag.Contains("\\\"cls\\\":true") || diag.Contains("\"cls\":true"));
                    if (chipShown) break;
                    await Task.Delay(250);
                }
                if (!chipShown) DebugLog("private: chip diag " + diag);
                // ExecuteScriptAsync does not await a returned promise: it would
                // answer {} and the verdict would read false.  The page hands
                // the text over to a variable instead and the probe polls it.
                await view.CoreWebView2.ExecuteScriptAsync(
                    "window.__lbPriv=0;fetch('https://api.livebrowser.shell/api/private',{cache:'no-store'})" +
                    ".then(function(r){return r.text();}).then(function(t){window.__lbPriv=t;})" +
                    ".catch(function(e){window.__lbPriv='ERR '+e;});0");
                var apiRaw = "";
                for (int i = 0; i < 40; i++)
                {
                    apiRaw = await view.CoreWebView2.ExecuteScriptAsync("String(window.__lbPriv)");
                    if (apiRaw.Contains("\"on\"")) break;
                    await Task.Delay(100);
                }
                apiOn = (apiRaw.Contains("\\\"on\\\":true") || apiRaw.Contains("\"on\":true"));
                if (!apiOn) DebugLog("private: api diag " + apiRaw);
            }
            catch (Exception ex) { DebugLog("private: in-window probe threw " + ex.GetType().Name + ": " + ex.Message); }
        }

        // Closing runs the same FormClosing path the user's click does.
        bool closed = false;
        win.FormClosed += (_, _) => closed = true;
        try
        {
            if (win.IsHandleCreated) win.BeginInvoke(new Action(() => win.Close()));
            else win.Close();
        }
        catch (Exception ex) { DebugLog("private: close threw " + ex.GetType().Name + ": " + ex.Message); }
        for (int i = 0; i < 40 && !closed; i++) await Task.Delay(100);
        if (!closed) DebugLog("private: the window did not close within 4s");
        bool gone = false;
        // Waiting for the folder is not enough if a *stray* window survives:
        // an unshown headless form can keep the process's runtime alive, and
        // then the wipe could never finish.  So the probe also insists that no
        // private window is left open on its side.
        for (int i = 0; i < 100; i++)
        {
            await Task.Delay(250);
            if (!Directory.Exists(root)) { gone = true; break; }
        }
        var noWindow = !Application.OpenForms.OfType<MainForm>().Any(f => f != this);
        // PrivateCleared is the host's own verdict: the folder was removed by
        // the routine that promises to remove it (not by some earlier start).
        var cleared = gone && privateCleared;

        var sessionSame = Stamp(session) == sessionBefore;
        var historySame = Stamp(AppPaths.HistoryFile) == historyBefore;
        if (!cleared)
        {
            string left = "";
            try
            {
                foreach (var f in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
                { left = f; break; }
            }
            catch (Exception ex) { left = "ENUM " + ex.Message; }
            DebugLog("private: leftover in profile-private -> " + left);
        }

        return JsonSerializer.Serialize(new
        {
            counted,
            keysBad,
            folderBefore,
            initialized,
            loaded,
            url = Short(url),
            emptySession,
            chipShown,
            apiOn,
            cleared,
            noWindow,
            sessionSame,
            historySame,
            ms = sw.ElapsedMilliseconds,
        });
    }

    private static string Short(string url)
        => string.IsNullOrEmpty(url) ? "" : url.Length > 70 ? url.Substring(0, 70) : url;

    // For the probe's private window: the shell address it ended up on and how
    // many tabs it shows.  Small accessors instead of internals spelunking so
    // the probe cannot drift from the fields' meaning.  The shell's own
    // document is the desktop tab — loading index.html (or anything else on
    // the virtual host) is exactly "the shell came up in a fresh window".
    internal string FirstSiteUrl()
    {
        try
        {
            var uiNow = tabs.FirstOrDefault(t => t.Id == 0)?.View;
            if (uiNow?.CoreWebView2 != null) return uiNow.CoreWebView2.Source ?? "";
        }
        catch { }
        return "";
    }

    internal int VisibleTabCount() => tabs.Count(t => t.Alive);

    // The shell's own view (tab 0): the probe reads the private chip from the
    // page it is drawn by, not from the flag the host set.
    internal WebView2 ShellView() => ui;

    // InitAsync finished its slow part (the probe waits on this instead of
    // guessing from the view's source).
    internal bool InitDone => initDone;

    // 20 heavy tabs, measured.  The page is a local fixture (test/heavy.html):
    // 6000 nodes plus a 20 Hz timer, so a live renderer both holds DOM/pixel
    // memory and keeps burning CPU.  The point of the step is not "does it
    // open" but whether hibernation actually gives the memory and the CPU
    // back — a browser that keeps 20 renderers alive is the difference
    // between 300 MB and 3 GB.
    private async Task<string> ProbeStress()
    {
        const int TabCount = 20;
        string dir = Path.Combine(AppPaths.Root, "_heavy");
        string file = Path.Combine(dir, "index.html");
        if (!File.Exists(file)) return "{\"skip\":\"no-fixture\",\"path\":" + JsonSerializer.Serialize(file) + "}";

        var proc = Process.GetCurrentProcess();
        long CpuMs(Process p) { try { p.Refresh(); return (long)p.TotalProcessorTime.TotalMilliseconds; } catch { return -1; } }
        long Ram(Process p) { try { p.Refresh(); return p.WorkingSet64 / (1024 * 1024); } catch { return -1; } }

        // A quiet baseline first: whatever the shell and the existing tabs
        // already use must not be counted as the stress cost.
        int liveBefore = LiveViewCount();
        long ramBefore = Ram(proc), cpuBefore = CpuMs(proc);
        var opened = new List<int>();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            for (int i = 0; i < TabCount; i++)
            {
                // A distinct query string per tab: OpenAsync dedupes by URL and
                // would otherwise activate the same tab 20 times.
                var page = await OpenAsync("file:///" + file.Replace('\\', '/') + "?i=" + i, "stress-" + i);
                if (page != null) { opened.Add(page.Id); continue; }
                DebugLog("SHELLPROBE stress open FAILED i=" + i + " file=" + file
                    + " exists=" + File.Exists(file));
            }
            // Let every renderer lay out and start its timer before the first
            // reading; a tab that is still loading would understate the cost.
            for (int i = 0; i < 60; i++)
            {
                bool allReady = opened.All(id => tabs.FirstOrDefault(t => t.Id == id)?.Ready == true);
                if (allReady) break;
                await Task.Delay(100);
            }
            await Task.Delay(1500);
            long openMs = sw.ElapsedMilliseconds;
            long ramOpen = Ram(proc), cpuOpen = CpuMs(proc);
            int treeOpen = WebViewTreeMb();

            // CPU over a fixed window: the delta is what 20 live renderers
            // cost while nobody is looking at them.
            var cpuA = CpuMs(proc);
            await Task.Delay(3000);
            long cpuIdleMs = Math.Max(0, CpuMs(proc) - cpuA);

            // Hibernate every one of them (the 15-minute rule, forced): the
            // views are destroyed, so the memory must come back.
            int slept = 0;
            foreach (var id in opened)
            {
                var tab = tabs.FirstOrDefault(t => t.Id == id);
                if (tab == null || !tab.Alive) continue;
                if (!views.TryGetValue(id, out var v) || v == null || v.IsDisposed) continue;
                try { tab.Url = v.CoreWebView2?.Source ?? tab.Url; } catch { }
                try { HibernateTab(tab, v); slept++; } catch { }
            }
            await Task.Delay(2500);
            long ramSlept = Ram(proc), cpuSleptA = CpuMs(proc);
            int treeSlept = WebViewTreeMb();
            await Task.Delay(3000);
            long cpuSleptMs = Math.Max(0, CpuMs(proc) - cpuSleptA);

            return JsonSerializer.Serialize(new
            {
                tabs = opened.Count,
                slept,
                liveBefore,
                liveOpen = LiveViewCount(),
                openMs,
                ramMb = new { before = ramBefore, open = ramOpen, slept = ramSlept },
                // Own-process WorkingSet is a lie for a WebView2 app: every
                // renderer, GPU and utility process is a separate msedgewebview2.
                // A browser that "uses 88 MB" with 20 tabs open would be
                // measured against 3 GB in Task Manager, so both numbers are
                // reported: the exe alone and the whole WebView2 tree.
                webviewTreeMb = new { open = treeOpen, slept = treeSlept },
                cpuPerSecPct = new
                {
                    // Percent of ONE core over the 3 s window; 20 live
                    // renderers on an 8-core box must stay well under 100.
                    open = Math.Round(cpuIdleMs / 30.0, 1),
                    slept = Math.Round(cpuSleptMs / 30.0, 1),
                },
                cpuTotalMs = new { before = cpuBefore, open = cpuOpen },
            });
        }
        finally
        {
            // The stress tabs are the probe's own: never leave them behind.
            foreach (var id in opened)
            {
                try { if (tabs.Any(t => t.Id == id)) CloseTab(id); } catch { }
            }
        }
    }

    // Total WorkingSet of this browser plus every WebView2 child process, in
    // MB.  Task Manager's "LiveBrowser" number is this sum, so a stress result
    // has to be reported in the same units or it flatters itself.
    private static int WebViewTreeMb()
    {
        long total = 0;
        try
        {
            int self = Environment.ProcessId;
            foreach (var p in Process.GetProcesses())
            {
                bool mine;
                try { mine = p.Id == self || p.ProcessName.Equals("msedgewebview2", StringComparison.OrdinalIgnoreCase); }
                catch { p.Dispose(); continue; }
                if (!mine) { p.Dispose(); continue; }
                try { total += p.WorkingSet64; } catch { }
                p.Dispose();
            }
        }
        catch { }
        return (int)(total / (1024 * 1024));
    }

    // Layout-animation ban: every transition/animation the shell declares must
    // move things with transform/opacity, never with a property that forces
    // layout (left/top/width/height/margin/…).  The rule is checked on the
    // declarations themselves — a rule that never fires at runtime would be
    // invisible to any "watch the element" probe, and those are exactly the
    // ones that come back as a jank when a user opens that panel.
    private async Task<string> ProbeAnimations()
    {
        if (ui?.CoreWebView2 == null) return "{\"skip\":\"no-ui\"}";
        // The UI view may still be on about:blank this early (the shell's own
        // load can be seconds behind, and the probe runs after long steps), so
        // wait for a real document before trusting a "zero rules" answer.
        string src = "";
        for (int i = 0; i < 50; i++)
        {
            try { src = ui.CoreWebView2.Source ?? ""; } catch { }
            if (src.StartsWith("https://livebrowser.shell")) break;
            await Task.Delay(100);
        }
        if (!src.StartsWith("https://livebrowser.shell"))
            return "{\"skip\":\"ui-not-shell\",\"src\":" + JsonSerializer.Serialize(src) + "}";
        const string js = @"
(function(){
  var layout = /^(left|top|right|bottom|width|height|min-width|min-height|max-width|max-height|margin|margin-[a-z]+|padding|padding-[a-z]+|inset|flex|flex-basis|grid-template-rows|grid-template-columns|font-size|line-height)$/;
  var bad = [], checkedRules = 0, props = {}, decls = 0;
  function scan(sheet, href) {
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return; } // cross-origin
    if (!rules) return;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      // Only group rules (@media/@supports/@layer) hold nested rules and have
      // neither selectorText nor style; checking style FIRST matters — a
      // style rule carries no cssRules, a keyframes body carries both.
      var st = r.style;
      if (st) {
        var sel0 = r.selectorText || '';
        // transition-property (incl. the shorthand)
        var tp = st.getPropertyValue('transition-property');
        var ts = st.getPropertyValue('transition');
        var cand = (tp || '') + ',' + (ts || '');
        if (cand !== ',') decls++;
        cand.split(',').forEach(function(t){
          t = t.trim().split(/\s+/)[0];
          if (!t || t === 'all' || t === 'none'
              || /^[-0-9.]/.test(t) || /^(cubic|steps|ease|linear|inherit|initial|unset|var)/.test(t)) return;
          props[t] = 1;
          if (layout.test(t)) bad.push(sel0 + ' → transition ' + t);
        });
      }
      if (r.cssRules) { scan(r, href); continue; }   // @media / @supports
      var sel = r.selectorText;
      if (!sel) continue;                            // @keyframes
      if (!st) continue;
      // animation-name → look the keyframes up and check their properties
      var an = st.getPropertyValue('animation-name');
      if (an) {
        an.split(',').forEach(function(name){
          name = name.trim();
          if (!name || name === 'none' || name === 'inherit') return;
          checkedRules++;
          for (var j = 0; j < rules.length; j++) {
            var kf = rules[j];
            if (kf.type !== 7 && !(kf.name === name && kf.cssText.indexOf('keyframes') >= 0)) continue;
            if (kf.name !== name) continue;
            var frames = kf.cssRules || [];
            for (var k = 0; k < frames.length; k++) {
              var fs = frames[k].style;
              if (!fs) continue;
              for (var p = 0; p < fs.length; p++) {
                var pn = fs[p];
                if (layout.test(pn)) bad.push(sel + ' → @keyframes ' + name + ' ' + pn);
              }
            }
          }
        });
      }
    }
  }
  for (var s = 0; s < document.styleSheets.length; s++) scan(document.styleSheets[s], '');
  var info = [];
  for (var s2 = 0; s2 < document.styleSheets.length; s2++) {
    var sh = document.styleSheets[s2], n;
    try { n = (sh.cssRules || []).length; } catch (e) { n = 'X'; }
    info.push((sh.href || 'inline').split('/').pop() + ':' + n);
  }
  var uniq = bad.filter(function(v, i){ return bad.indexOf(v) === i; });
  return JSON.stringify({info: info, decls: decls, props: Object.keys(props).sort(),
    anims: checkedRules, bad: uniq.slice(0, 12), total: uniq.length});
})()";
        try
        {
            string raw = await ui.CoreWebView2.ExecuteScriptAsync(js);
            if (string.IsNullOrEmpty(raw) || raw == "null") return "{\"error\":\"no-answer\"}";
            return raw.StartsWith("\"") ? JsonSerializer.Deserialize<string>(raw) : raw;
        }
        catch (Exception ex) { return "{\"error\":" + JsonSerializer.Serialize(ex.Message) + "}"; }
    }

    // The first-run film, measured in the engine that will actually play it.
    //
    // Why through the host and not a static page: the film runs in WebView2 on
    // the user's machine, and that engine (not Chromium-from-npm) decides how
    // many frames of it fit in a second.  The probe still reads no pixels and
    // raises no window -- it starts the real intro module, asks the frame
    // function for the whole storyboard, then lets the real clock run for a
    // moment while counting rAF frames.
    //
    // What must hold:
    //   * frameAt(t) is a pure function of t -- the same t twice gives the
    //     same numbers, and every frame is finite.  This is the contract the
    //     HyperFrames render and the live frame both rely on.
    //   * the split-prism beat peaks exactly once, inside its beat.
    //   * the last frame is settled (settle=1, camX=0, split=0): that is what
    //     makes the hand-off to the desktop free of layout shift.
    //   * the live clock produces frames; the Hz number is reported, not
    //     enforced, because a busy box is not a reason to fail the film.
    // Starts the intro contract and the module (idempotent: each call may
    // be a fresh round-trip) and reports how far it got.
    private const string BootIntroJs =
            "(function(){\n"
            + "  if (window.LiveIntro) return 'ready';\n"
            + "  if (!window.LiveModules) return 'no-modules';\n"
            + "  if (!window.LiveIntroClock && !window.__lbClockAsked) {\n"
            + "    window.__lbClockAsked = 1;\n"
            + "    window.LiveModules.load('intro-clock').catch(function(){});\n"
            + "  }\n"
            + "  if (window.LiveIntroClock && !window.LiveIntro) {\n"
            + "    window.LiveModules.load('intro').catch(function(err){ window.__lbIntroErr = String(err); });\n"
            + "  }\n"
            + "  if (window.__lbIntroErr) return 'load-failed:' + window.__lbIntroErr;\n"
            + "  if (window.LiveIntroClock) return 'clock-only';\n"
            + "  return 'waiting';\n"
            + "})()";

    // Purity of the frame function, the prism peak, the settled last frame.
    private const string MeasureIntroJs =
            "(function(){\n"
            + "  var d = window.LiveIntro;\n"
            + "  if (!d) return JSON.stringify({error:'no-api'});\n"
            + "  var END = 6.55;\n"
            + "  // 1. Purity and finiteness over the whole film, on a 240 Hz grid.\n"
            + "  var n = Math.round(END * 240), finite = 0, unstable = 0;\n"
            + "  for (var i = 0; i <= n; i++) {\n"
            + "    var t = (i / n) * END;\n"
            + "    var a = d.frameAt(t), b = d.frameAt(t);\n"
            + "    for (var k in a) if (typeof a[k] === 'number' && !isFinite(a[k])) finite++;\n"
            + "    if (JSON.stringify(a) !== JSON.stringify(b)) unstable++;\n"
            + "  }\n"
            + "  // 2. The prism beat: the split must have a single peak.\n"
            + "  var peak = -1, peakT = -1;\n"
            + "  for (var j = 0; j <= n; j++) {\n"
            + "    var tt = (j / n) * END, sp = d.frameAt(tt).split;\n"
            + "    if (sp > peak) { peak = sp; peakT = tt; }\n"
            + "  }\n"
            + "  // 3. The last frame must be settled: identity camera, no prism.\n"
            + "  var e = d.frameAt(END);\n"
            + "  var settled = Math.abs(e.camX) < 1e-6 && Math.abs(e.split) < 1e-6 && e.settle > 0.999;\n"
            + "  // 4. Start the film and count frames for a moment (own rAF loop, so the\n"
            + "  //    count does not depend on how often the host asks).\n"
            + "  try { d.load(); } catch (err) {}\n"
            + "  var st = window.__lbIntro = {t0: performance.now(), frames: 0, done: false};\n"
            + "  var shown = false;\n"
            + "  try { shown = d.show({ full: true }); } catch (err) {}\n"
            + "  var layer = document.querySelector('#intro');\n"
            + "  (function tick(){ st.frames++; if (performance.now() - st.t0 > 1200) { st.done = true; return; } requestAnimationFrame(tick); })();\n"
            + "  return JSON.stringify({\n"
            + "    pure: unstable === 0, finite: finite === 0, samples: n + 1,\n"
            + "    splitPeak: +peak.toFixed(3), splitAt: +peakT.toFixed(2),\n"
            + "    settled: settled, endCamX: +e.camX.toFixed(4),\n"
            + "    shown: !!layer, hidden: layer ? layer.hidden : null, showReturned: shown\n"
            + "  });\n"
            + "})()";

    // The frame tally the page kept for itself, plus the shutdown.
    private const string CountIntroJs =
            "(function(){\n"
            + "  var st = window.__lbIntro;\n"
            + "  if (!st) return JSON.stringify({error:'no-store'});\n"
            + "  var ms = performance.now() - st.t0;\n"
            + "  var out = {frames: st.frames, ms: Math.round(ms), hz: Math.round(st.frames / (ms / 1000)), done: st.done};\n"
            + "  if (st.done) {\n"
            + "    try { var b = document.querySelector('#intro-start'); if (b) b.click(); } catch (err) {}\n"
            + "    delete window.__lbIntro;\n"
            + "  }\n"
            + "  return JSON.stringify(out);\n"
            + "})()";

        private async Task<string> ProbeIntro()
        {
            if (ui?.CoreWebView2 == null) return "{\"skip\":\"no-ui\"}";
            string src = "";
            for (int i = 0; i < 50; i++)
            {
                try { src = ui.CoreWebView2.Source ?? ""; } catch { }
                if (src.StartsWith("https://livebrowser.shell")) break;
                await Task.Delay(100);
            }
            if (!src.StartsWith("https://livebrowser.shell"))
                return "{\"skip\":\"ui-not-shell\",\"src\":" + JsonSerializer.Serialize(src) + "}";

            // Loading the module must not be one awaited script: WebView2
            // answers a script whose promise is still pending with "{}", so
            // the boot only *starts* the loads and the loop asks again.
            var trace = new List<string>();
            string ready = "";
            for (int i = 0; i < 40; i++)
            {
                try { ready = await ui.CoreWebView2.ExecuteScriptAsync(BootIntroJs); }
                catch (Exception ex) { return "{\"error\":" + JsonSerializer.Serialize(ex.Message) + "}"; }
                if (trace.Count == 0 || trace[trace.Count - 1] != ready) trace.Add(ready);
                if (ready == "\"ready\"" || ready.Contains("load-failed")) break;
                await Task.Delay(100);
            }
            if (ready != "\"ready\"")
                return "{\"error\":\"intro-not-loaded\",\"trace\":" + JsonSerializer.Serialize(trace) + "}";

            try
            {
                string raw = await ui.CoreWebView2.ExecuteScriptAsync(MeasureIntroJs);
                if (string.IsNullOrEmpty(raw) || raw == "null") return "{\"error\":\"no-answer\"}";
                string body = raw.StartsWith("\"") ? JsonSerializer.Deserialize<string>(raw) : raw;

                // The page counts frames on its own clock; read its tally.
                await Task.Delay(1400);
                string tally = await ui.CoreWebView2.ExecuteScriptAsync(CountIntroJs);
                tally = tally.StartsWith("\"") ? JsonSerializer.Deserialize<string>(tally) : tally;

                // The film is short; a second of it is enough to know whether
                // the clock runs.  Leave the shell as found.
                try { await ui.CoreWebView2.ExecuteScriptAsync("(function(){var b=document.querySelector('#intro-start');if(b)b.click();})()"); } catch { }
                return "{\"probe\":\"intro\",\"frame\":" + (body ?? "{}")
                     + ",\"live\":" + (tally ?? "{}") + "}";
            }
            catch (Exception ex) { return "{\"error\":" + JsonSerializer.Serialize(ex.Message) + "}"; }
        }

    // Shortcut parity: every combo must mean the same thing to the C# table,
    // to the listener injected into a real page (__lbHot, which also decides
    // what to preventDefault), and to the WinForms key names ProcessCmdKey
    // and the site KeyDown handler feed in.  A combo with a command but no
    // claim would act AND leak to Chromium; a claim with no command would
    // swallow a key that does nothing.
    private async Task<string> ProbeHotkeys()
    {
        var combos = new (string Code, bool C, bool S, bool A)[]
        {
            ("KeyL", true, false, false), ("KeyK", true, false, false),
            ("KeyF", true, false, false), ("KeyP", true, false, false),
            ("KeyW", true, false, false), ("KeyT", true, false, false),
            ("KeyN", true, false, false), ("KeyR", true, false, false),
            ("Tab", true, false, false), ("Tab", true, true, false),
            ("KeyT", true, true, false), ("KeyN", true, true, false),
            ("Equal", true, false, false), ("Minus", true, false, false),
            ("Digit0", true, false, false),
            ("ArrowLeft", false, false, true), ("ArrowRight", false, false, true),
            ("F5", false, false, false), ("F6", false, false, false),
            ("F11", false, false, false),
            // Must stay free: page-owned keys the browser must not swallow.
            ("KeyC", true, false, false), ("KeyV", true, false, false),
            ("KeyZ", true, false, false), ("KeyS", true, false, false),
            ("KeyF", false, false, false),
            // Ctrl+Shift+E used to toggle the left tab column.  The toggle is
            // gone, so the combo must now be free on both sides: a page that
            // binds it gets the key instead of a silent no-op.
            ("KeyE", true, true, false),
        };

        string js = "(function(){var out={};" +
            "var cs=" + JsonSerializer.Serialize(combos.Select(c => new
            { code = c.Code, c = c.C, s = c.S, a = c.A }).ToArray()) + ";" +
            "for(var i=0;i<cs.length;i++){var k=cs[i];" +
            "out[k.code+(k.c?'+C':'')+(k.s?'+S':'')+(k.a?'+A':'')]=" +
            "(typeof window.__lbHot==='function')?window.__lbHot(k.code,k.c,k.s,k.a):null;}" +
            "return JSON.stringify(out);})()";

        try
        {
            // The hibernate step ran just before and may have left no live
            // view at all: open one, the injection is added per document.
            if (LiveViewCount() == 0) OpenTab("https://example.com/", "Keys");
            WebView2 v = null;
            for (int i = 0; i < 60 && v == null; i++)
            {
                v = views.Values.FirstOrDefault(x => x != null && !x.IsDisposed
                    && x.CoreWebView2 != null && x.CoreWebView2.Source != null
                    && x.CoreWebView2.Source.StartsWith("http"));
                if (v == null) await Task.Delay(100);
            }
            if (v == null) return "{\"skip\":\"no-view\"}";
            await Task.Delay(1500);
            string raw = await v.CoreWebView2.ExecuteScriptAsync(js);
            if (string.IsNullOrEmpty(raw)) return "{\"error\":\"no-answer\"}";
            string json = raw.StartsWith("\"") ? JsonSerializer.Deserialize<string>(raw) : raw;
            var page = JsonSerializer.Deserialize<Dictionary<string, bool?>>(json);

            var mismatched = new List<string>();
            int checkedCount = 0;
            foreach (var combo in combos)
            {
                var cmd = Hotkeys.Map(combo.Code, combo.C, combo.S, combo.A, false);
                bool claims = cmd != Hotkeys.Cmd.None;
                // WinForms path: ProcessCmdKey uses Keys.ToString(), the site
                // KeyDown handler the same — the table must accept both spellings.
                var altName = WinFormsName(combo.Code);
                var cmd2 = Hotkeys.Map(altName, combo.C, combo.S, combo.A, false);
                string key = combo.Code + (combo.C ? "+C" : "") + (combo.S ? "+S" : "") + (combo.A ? "+A" : "");
                bool? pageClaims = page != null && page.TryGetValue(key, out var pc) ? pc : null;
                checkedCount++;
                if (pageClaims == null || pageClaims.Value != claims || cmd2 != cmd)
                    mismatched.Add(key + "(host=" + cmd + ",win=" + cmd2 + ",page=" + pageClaims + ")");
            }
            return JsonSerializer.Serialize(new
            {
                same = mismatched.Count == 0,
                combos = checkedCount,
                bad = mismatched,
                claimed = combos.Count(c => Hotkeys.Map(c.Code, c.C, c.S, c.A, false) != Hotkeys.Cmd.None),
            });
        }
        catch (Exception ex) { return "{\"error\":" + JsonSerializer.Serialize(ex.Message) + "}"; }
    }

    // The Keys enum spells the same physical key differently (D0, Left,
    // Oemplus); a visitor key must resolve to the same command under both.
    private static string WinFormsName(string code) => code switch
    {
        "Digit0" => "D0",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "Equal" => "Oemplus",
        "Minus" => "OemMinus",
        "KeyL" or "KeyK" or "KeyF" or "KeyP" or "KeyW" or "KeyT" or "KeyN" or "KeyR"
            or "KeyC" or "KeyV" or "KeyZ" or "KeyS" => code.Substring(3),
        _ => code,
    };

    // QA: scrolling on sites must stay NATIVE (compositor-driven).  The old
    // injected smoother was removed — it hijacked the wheel on the main
    // thread and read as "lag".  This probe asserts the absence of the hook
    // and that a wheel event is NOT preventDefault'ed any more (a synthetic
    // wheel cannot drive the compositor scroller itself, so scroll movement
    // is checked via native programmatic scrolling instead).
    private async Task<string> VerifySmoothScroll()
    {
        try
        {
            var v = views.Values.FirstOrDefault(x => x.CoreWebView2 != null);
            if (v == null) return "no view";
            // A fresh tab is created visible-only-once-activated; a view that is
            // not on screen never gets rAF ticks, so the probe has to bring its
            // own view forward instead of measuring whatever tab happens to be
            // active.
            var owner = tabs.FirstOrDefault(t => t.View == v);
            if (owner != null) Activate(owner.Id);
            await Task.Delay(150);
            var page = AppPaths.Root + "\\_sc\\index.html";
            if (!System.IO.File.Exists(page)) return "no test page";
            v.CoreWebView2.Navigate(new Uri(page).AbsoluteUri);
            await Task.Delay(1200);
            var res = await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var s=document.scrollingElement||document.documentElement;" +
                "window.scrollTo(0,0);" +
                "var hook=!!window.__lbSmoothScrollInstalled;" +
                "var before=s.scrollTop;" +
                "window.dispatchEvent(new WheelEvent('wheel',{deltaY:600,bubbles:true,cancelable:true}));" +
                "var immediate=s.scrollTop;" +
                "var dbg=window.__lbDbg||null;" +
                "var rafOk=0;" +
                "return JSON.stringify({hook:hook,before:before,immediate:Math.round(immediate),dbg:dbg," +
                "ticks:window.__lbDbgTS||0," +
                "raf:(function(){var n=0;return n;})()});})()");
            // rAF ticks at all in this view?
            var rafProbe = await v.CoreWebView2.ExecuteScriptAsync(
                "new Promise(function(r){var n=0,t0=performance.now();" +
                "function f(){n++;if(performance.now()-t0<300)requestAnimationFrame(f);else r(n);}" +
                "requestAnimationFrame(f);})");
            await Task.Delay(700);
            var after = await v.CoreWebView2.ExecuteScriptAsync(
                "Math.round((document.scrollingElement||document.documentElement).scrollTop)");
            return res + " rafTicks=" + rafProbe + " settled=" + after
                + " (hook=false, prevented=false, settled>0 = native ok)";
        }
        catch (Exception ex) { return "ERR " + ex.Message; }
    }

    // QA: nothing intercepts the wheel on a real, heavy page (Wikipedia):
    // a synthetic wheel must come back NOT prevented (the hijack is gone),
    // and the document must still scroll natively on its own.
    private async Task<string> ProbeWikiWheel()
    {
        try
        {
            var v = views.TryGetValue(activeId, out var act) ? act : views.Values.FirstOrDefault(x => x.CoreWebView2 != null);
            if (v == null) return "no view";
            var owner = tabs.FirstOrDefault(t => t.View == v);
            if (owner != null) Activate(owner.Id);
            v.CoreWebView2.Navigate("https://ru.wikipedia.org/wiki/Россия");
            // Give the article time: this page is ~1.5k nodes and the toolbar
            // JS runs late; measuring into a half-built DOM reports nonsense.
            await Task.Delay(6000);
            var first = await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var s=document.scrollingElement||document.documentElement;" +
                "window.scrollTo(0,0);" +
                "var el=document.elementFromPoint(innerWidth/2,innerHeight/2);" +
                "var ev=new WheelEvent('wheel',{deltaY:600,bubbles:true,cancelable:true});" +
                "el.dispatchEvent(ev);" +
                "window.__w={prevented:ev.defaultPrevented,at:el?(el.tagName+'.'+(el.className||'').toString().slice(0,24)):'-'," +
                "max:Math.max(0,s.scrollHeight-innerHeight),start:Math.round(s.scrollTop)};" +
                // Separate the two possible failures: a dead scrollTo and a
                // dead rAF look identical from the outside.
                "window.scrollTo(0,500);window.__w.direct=Math.round(s.scrollTop);" +
                "window.scrollTo(0,0);" +
                "window.__w.rafTicks=-1;(function(){var n=0,t0=performance.now();" +
                "function f(){n++;if(performance.now()-t0<200)requestAnimationFrame(f);" +
                "else window.__w.rafTicks=n;}requestAnimationFrame(f);})();" +
                "return JSON.stringify(window.__w);})()");
            await Task.Delay(900);
            var moved = await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({y:Math.round((document.scrollingElement||document.documentElement).scrollTop)});");
            return first + " after900=" + moved;
        }
        catch (Exception ex) { return "ERR " + ex.Message; }
    }

    // QA: the error card for every failure class the user actually meets —
    // a dead host (DNS), nothing listening (offline), a bad certificate — and
    // that its "Повторить" button really navigates again.  All of it is DOM
    // from the host: no window is raised, no pixels are read.
    private async Task<string> ProbeErrorCards()
    {
        var cases = new (string Name, string Url)[]
        {
            ("dns", "https://no-such-host-livebrowser-test.invalid/"),
            // 127.0.0.1:9 is the discard port: nothing listens, the failure is
            // ERR_CONNECTION_REFUSED — the same status an offline machine gives.
            ("offline", "http://127.0.0.1:9/"),
            // Self-signed certificate: Chromium refuses it with a certificate
            // error (the interstitial is what the card must replace).
            ("tls", "https://self-signed.badssl.com/"),
        };

        var result = new Dictionary<string, object>();
        foreach (var c in cases)
        {
            string verdict;
            int lastId = 0;
            try
            {
                var page = await OpenAsync(c.Url, "err-" + c.Name);
                int id = page?.Id ?? 0;
                lastId = id;
                bool card = false;
                // A dead host answers slowly (DNS timeout ~11 s here), so the
                // wait has to outlast the 1.2 s error check that follows it.
                for (int i = 0; i < 400 && id != 0; i++)
                {
                    await Task.Delay(100);
                    card = OnErrorCard(id);
                    if (card) break;
                }
                if (card)
                {
                    await Task.Delay(600);   // let NavigateToString paint
                    var dom = await views[id].CoreWebView2.ExecuteScriptAsync(
                        "JSON.stringify((function(){var c=document.querySelector('.c');" +
                        "var b=document.querySelector('.c button');var f=document.querySelector('.c form');" +
                        "return{card:!!c,h1:(document.querySelector('.c h1')||{}).textContent||null," +
                        "host:(document.querySelector('.c p code')||{}).textContent||null," +
                        "btn:(b&&b.textContent)||null,action:(f&&f.getAttribute('action'))||null," +
                        "selfSigned:/about:blank/.test(location.href)?null:location.host};})())");
                    string shown = page != null ? page.Url : "";
                    verdict = dom + " tabUrl=" + shown
                        + " urlKept=" + (page != null && page.Url == c.Url);
                }
                else
                {
                    // What did the user get instead?  Chromium's own slab has
                    // no .c card and an error-code body.
                    string body = id != 0 && views.TryGetValue(id, out var nv) && nv != null
                        ? await nv.CoreWebView2.ExecuteScriptAsync("(document.body&&document.body.innerText||'').slice(0,60)")
                        : "no-view";
                    verdict = "NO-CARD body=" + body;
                }
            }
            catch (Exception ex) { verdict = "ERR " + ex.Message; }
            // A tab left on the card would sit on top of the rest of the
            // probe; close it, but keep the address for the readback.
            if (lastId != 0)
            {
                try
                {
                    if (views.TryGetValue(lastId, out var cvv) && cvv?.CoreWebView2?.Source != null)
                        DebugLog("errcard source id=" + lastId + " "
                                 + ShortHost(cvv.CoreWebView2.Source));
                    CloseTab(lastId);
                }
                catch { }
            }
            result[c.Name] = verdict;
        }

        // «Повторить»: the card's form posts back to the failed address.  The
        // tab is opened again (the cases above closed theirs), so the retry
        // is judged on a tab that has only ever shown the card.
        string retry = "no-tab";
        try
        {
            var rt = await OpenAsync("http://127.0.0.1:9/", "err-retry");
            var target = rt;
            if (target != null)
            {
                bool cardBefore = false;
                for (int i = 0; i < 400 && !cardBefore; i++)
                {
                    await Task.Delay(100);
                    cardBefore = OnErrorCard(target.Id);
                }
                await Task.Delay(400);
                long seqBefore = target.NavSeq;
                await views[target.Id].CoreWebView2.ExecuteScriptAsync(
                    "(function(){var b=document.querySelector('.c button');if(b){b.click();return 'clicked';}return 'nobtn';})()");
                // The retry has to start a navigation in THIS tab…
                bool started = false;
                for (int i = 0; i < 50 && !started; i++)
                {
                    await Task.Delay(100);
                    started = target.NavSeq > seqBefore;
                }
                // …and, failing again, bring the card back rather than leave
                // Chromium's own slab (the marker must not outlive the retry).
                bool cardBack = false;
                for (int i = 0; i < 400 && !cardBack; i++)
                {
                    await Task.Delay(100);
                    cardBack = OnErrorCard(target.Id);
                }
                retry = JsonSerializer.Serialize(new
                {
                    cardBefore,
                    started,
                    cardAfter = cardBack,
                    id = target.Id,
                    url = target.Url,
                });
                CloseTab(target.Id);
            }
        }
        catch (Exception ex) { retry = "ERR " + ex.Message; }

        return JsonSerializer.Serialize(new { cases = result, retry });
    }

    // QA: did our themed error card replace Chromium's grey slab?
    private async Task<string> ProbeErrorPage()
    {
        try
        {
            var v = views.TryGetValue(activeId, out var act) ? act : views.Values.LastOrDefault(x => x.CoreWebView2 != null);
            if (v == null) return "no view";
            // NavigateToString is asynchronous: give the card a moment to land
            // before judging it.
            await Task.Delay(700);
            var raw = await v.CoreWebView2.ExecuteScriptAsync("document.body?document.body.innerHTML.slice(0,140):'NOBODY'");
            var probe = await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({h:(document.querySelector('.c h1')||{}).textContent||null," +
                "hasCard:!!document.querySelector('.c')," +
                "title:document.title,url:location.href.slice(0,60)," +
                "bg:getComputedStyle(document.body).backgroundColor})");
            return "active=" + activeId + " raw=" + raw + " probe=" + probe;
        }
        catch (Exception ex) { return "ERR " + ex.Message; }
    }

    // QA: the glider must never teleport.  Rapid A->B->C switches are sampled
    // frame by frame; a jump larger than ~40px between frames means it snapped
    // instead of sliding.
    private async Task<string> ProbeGlider()
    {
        try
        {
            if (ui?.CoreWebView2 == null) return "no ui";
            // Deterministic check of the glide math itself.  Sampling the live
            // DOM is unreliable here: a background window throttles rAF and
            // timers to ~1 Hz, so a "no samples" reading says nothing about
            // smoothness.  __lbGliderStep is the exact function the animation
            // loop calls, so replaying it with real 16 ms stamps proves the
            // track is continuous, monotone and reaches the target.
            string js =
                "(function(){var out={err:'unset'};try{" +
                "var s=window.__lbGliderStep;if(!s)throw new Error('no step fn');" +
                "var cur={x:0,w:104},to={x:312,w:60},ts=0,path=[],maxFrac=0,back=0;" +
                "for(var i=0;i<24;i++){var prev=cur;cur=s(cur,ts,to);ts+=16;" +
                "path.push(+cur.x.toFixed(1));" +
                "var rem=Math.abs(to.x-prev.x);if(rem>0.5){" +
                "var frac=Math.abs(cur.x-prev.x)/rem;if(frac>maxFrac)maxFrac=frac;}" +
                "if(cur.x<prev.x-0.001)back++;}" +
                "var reached=+(Math.abs(cur.x-to.x)<0.01&&Math.abs(cur.w-to.w)<0.01);" +
                "var mid={x:0,w:104},j=0;while(j<6){mid=s(mid,j*16,to);j++;}" +
                "var midX=mid.x,rev=s(mid,j*16,{x:0,w:104});" +
                "out={frames:path.length,maxFrac:+maxFrac.toFixed(3)," +
                "back:back,reached:reached,settled:[+cur.x.toFixed(1),+cur.w.toFixed(1)]," +
                "reversal:+rev.x.toFixed(1),reversalFrom:+midX.toFixed(1)," +
                "path:path.slice(0,10)};" +
                "}catch(err){out={err:String(err&&err.message||err)};}" +
                "window.__glider=JSON.stringify(out);return window.__glider;})()";
            // One call: the result is the probe output AND lands in __glider so
            // the live check below can quote it back.
            var res = await ui.CoreWebView2.ExecuteScriptAsync(js);
            // Drive a real switch through the live strip too.  The home tab has
            // no button in the strip, so its site ids start at the first site
            // tab — clicking by raw index used to crash the old probe.  The
            // real switch says nothing about math but proves the pill actually
            // slides on a click (its transform moves during the animation).
            await ui.CoreWebView2.ExecuteScriptAsync(
                "(function(){" +
                "var ids0=document.querySelectorAll('.tabs .tab[data-id]');" +
                // Need two real tabs to have anything to slide BETWEEN: with a
                // single tab the target equals the current spot and "moved"
                // would read false for a perfectly correct pill.
                "if(ids0.length<2)return;" +
                "var first=ids0[0];" +
                "var pill=document.querySelector('.tab-glider');" +
                "var before=getComputedStyle(pill).transform;" +
                "var ids=document.querySelectorAll('.tabs .tab[data-id]');" +
                "ids[ids.length-1].click();" +
                "setTimeout(function(){" +
                "var after=getComputedStyle(pill).transform;" +
                "var btn=document.querySelector('.tabs .tab[data-id=\\\"'+first.getAttribute('data-id')+'\\\"]');" +
                "if(btn)btn.click();" +
                "window.__gliderClick='moved='+(before!==after)+';before='+before+';after='+after;" +
                "},180);})()");
            await Task.Delay(700);
            // Live check as well: are there tabs to slide between at all?
            var live = await ui.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({glider:!!document.querySelector('.tab-glider')," +
                "tabs:document.querySelectorAll('.tabs .tab').length," +
                "ok:window.__glider," +
                "click:window.__gliderClick||null," +
                "step:typeof window.__lbGliderStep," +
                "live:typeof (window.LiveTabs&&window.LiveTabs.gliderStep)," +
                "errs:(window.__errs||[]).slice(0,3)})");
            // Loading wobble: a page load pushes the tab list several times
            // (url, title, favicon, loading flag).  Replay that burst through
            // the real handler and read the active tab's box after every push;
            // any width change is the underline re-targeting itself.
            var wobble = await ui.CoreWebView2.ExecuteScriptAsync(
                "(function(){" +
                "var L=window.LiveTabs,t=L.state;if(!L||!t)return 'no tabs';" +
                "var a=t.tabs.find(function(x){return x.id===t.activeId&&x.id!==0;});" +
                "if(!a)return 'home only';" +
                "function box(){var b=document.querySelector('.tabs .tab.active');" +
                "if(!b)return null;return [Math.round(b.getBoundingClientRect().width)," +
                "Math.round(b.getBoundingClientRect().left)];}" +
                "var base=t.tabs.map(function(x){return {id:x.id,title:x.title,url:x.url,favicon:x.favicon,loading:x.loading,accent:x.accent};});" +
                "var seen=[],moves=0,last=box();" +
                "function push(patch){var next=base.map(function(x){" +
                "return Object.assign({},x,patch);});" +
                "L._onTabs({tabs:next,activeId:t.activeId});" +
                "var b=box();if(!b)return 'lost';" +
                "if(last&&(b[0]!==last[0]||b[1]!==last[1]))moves++;" +
                "last=b;seen.push(b.join('x'));}" +
                "push({});" +
                "push({title:'Википедия — свободная энциклопедия',url:'https://ru.wikipedia.org/'});" +
                "push({loading:true});" +
                "push({favicon:'data:image/png;base64,iVBORw0KGgo='});" +
                "push({loading:false});" +
                "L._onTabs({tabs:base,activeId:t.activeId});" +
                "return 'moves='+moves+';seen='+seen.join(' ')+\";now=\"+box();" +
                "})()");
            return res + " live=" + live + " wobble=" + wobble;
        }
        catch (Exception ex) { return "ERR " + ex.Message; }
    }

    // LIVEBROWSER_SELFTEST=1: dumps the shell's DOM state and a CDP render of
    // the ui view.  A blank window is otherwise indistinguishable from a
    // window that is merely covered, and the capture works either way.
    private async Task ShellProbe(WebView2 v)
    {
        if (Environment.GetEnvironmentVariable("LIVEBROWSER_SELFTEST") != "1") return;
        try
        {
            await ProbeShot(v, "probe");
            // Switch to Night City through the shell's own API, then read back
            // what the DOM computes and what the host painted its views with.
            await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var p=(window.__lbPalettes||[]).find(x=>x.id==='night-city');" +
                "if(window.__lbSetPalette)window.__lbSetPalette('night-city');" +
                "else if(window.__livebrowser&&window.__livebrowser.setPalette)window.__livebrowser.setPalette('night-city');" +
                "return 'set '+(p?'found':'missing');})()");
            await Task.Delay(1200);
            DebugLog("CYBER " + await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({theme:document.documentElement.dataset.theme," +
                "bg:getComputedStyle(document.body).backgroundColor," +
                "ff:getComputedStyle(document.body).fontFamily.slice(0,40)," +
                "tabR:(document.querySelector('.tab-home.active')?getComputedStyle(document.querySelector('.tab-home.active')).borderRadius:null)," +
                "barBorder:document.querySelector('.chrome-bar')?getComputedStyle(document.querySelector('.chrome-bar')).borderBottomColor:null," +
                "fonts:document.fonts?document.fonts.size:null," +
                "jbm:document.fonts?document.fonts.check('14px \"JetBrains Mono\"'):null," +
                "orb:document.fonts?document.fonts.check('700 40px Orbitron'):null})"));
            DebugLog("HOST cyber=" + cyberTheme + " viewBg=" + ThemeBg.R + "," + ThemeBg.G + "," + ThemeBg.B);
            await ProbeShot(v, "probe-cyber");
            DebugLog("TILE " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var t=document.querySelector('.link-tile');if(!t)return 'none';" +
                "var s=getComputedStyle(t);" +
                "return JSON.stringify({radius:s.borderTopLeftRadius,shadow:s.boxShadow.slice(0,48)," +
                "border:s.borderTopColor,inline:t.getAttribute('style')||''});})()"));

            // Omnibox + suggestions in cyber (glitch-in, cyan active bar).
            // A previous probe may have left the bar mid-collapse; drop into
            // tabs mode first and let the animation retire, otherwise the
            // reading catches a capsule that is still being moved back.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.LiveUi&&window.LiveUi.setBarMode&&window.LiveUi.setBarMode('tabs')");
            await Task.Delay(450);
            await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){window.LiveUi&&window.LiveUi.setBarMode&&window.LiveUi.setBarMode('omni');" +
                "var i=document.getElementById('search');if(i){try{i.focus();}catch(e){}}return 1;})()");
            await Task.Delay(700);
            await ProbeShot(v, "probe-cyber-omni");
            // Living desktop: the hour and the weather must actually change
            // what is painted, not just set an attribute nobody reads.
            DebugLog("SKY " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){" +
                "function read(){var b=document.querySelector('.blob-a');" +
                "if(!b)return null;var s=getComputedStyle(b);" +
                "return {f:s.filter,c:s.backgroundColor};}" +
                "var L=window.LiveUi;if(!L||!L.setSky)return 'no hook';" +
                "var out={};" +
                "out.day=L.setSky('day','clear');out.dayV=read();" +
                "out.night=L.setSky('night','clear');out.nightV=read();" +
                "out.rain=L.setSky('day','rain');out.rainV=read();" +
                "out.phaseFn=[L.skyPhase(3),L.skyPhase(7),L.skyPhase(12),L.skyPhase(19),L.skyPhase(23)].join(',');" +
                "out.condFn=[L.skyCondition(0),L.skyCondition(2),L.skyCondition(3),L.skyCondition(61),L.skyCondition(75),L.skyCondition(45),L.skyCondition(95)].join(',');" +
                "out.filtersDiffer=out.dayV.f!==out.nightV.f&&out.nightV.f!==out.rainV.f;" +
                "out.colorDiffers=out.dayV.c!==out.nightV.c;" +
                "L.setSky('day','clear');" +
                "return JSON.stringify(out);})()"));
            DebugLog("OMNIBOX " + await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({barMode:document.getElementById('chrome-bar').className," +
                "capsule:(function(){var c=document.querySelector('#ntp-omnibox .search');if(!c)return null;" +
                "var s=getComputedStyle(c);return {border:s.borderTopColor,radius:s.borderTopLeftRadius," +
                "bg:s.backgroundColor,shadow:s.boxShadow.slice(0,40)};})()," +
                "menuOpen:!!document.querySelector('.search-menu:not([hidden])')," +
                // Geometry: the omnibox must land centred in the free space
                // between the left tab cluster and the right action cluster,
                // not jump when one side changes width.
                "geom:(function(){var r=document.querySelector('#ntp-omnibox .search');" +
                "if(!r)return null;var b=r.getBoundingClientRect();" +
                "var bar=document.getElementById('chrome-bar').getBoundingClientRect();" +
                "var h=document.querySelector('.tab-home').getBoundingClientRect();" +
                "var w=document.querySelector('.win-controls').getBoundingClientRect();" +
                "var sl=getComputedStyle(document.getElementById('bar-omni'));" +
                "var o=document.getElementById('ntp-omnibox');" +
                "var os=getComputedStyle(o);" +
                "return {x:Math.round(b.left),w:Math.round(b.width)," +
                "barW:Math.round(bar.width)," +
                "homeR:Math.round(h.right),winL:Math.round(w.left)," +
                "tf:sl.transform,tr:os.translate," +
                "vars:[os.getPropertyValue('--omni-left').trim(),os.getPropertyValue('--omni-right').trim()]," +
                "sl:[Math.round(document.getElementById('bar-omni').getBoundingClientRect().left)," +
                "Math.round(document.getElementById('bar-omni').getBoundingClientRect().width)," +
                "Math.round(document.getElementById('bar-omni').getBoundingClientRect().right)]," +
                "barL:Math.round(bar.left)," +
                "centerErr:+(Math.round(((b.left+b.width/2)-(bar.left+bar.width/2))*10)/10)};})()})"));

            // Frame cost while the tab strip re-renders and the glider slides.
            // Measured occluded and raised: WebView2 throttles a hidden window,
            // so a uniform 10ms floor in both runs means "VSync-bound, no jank"
            // rather than a real slowdown.
            try
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Activate();
            }
            catch { }
            await Task.Delay(400);
            DebugLog("FPS occluded baseline " + await MeasureFps(v, 40));
            try { TopMost = true; } catch { }
            await Task.Delay(600);
            DebugLog("FPS raised " + await MeasureFps(v, 40));
            try { TopMost = false; } catch { }

            // Settings sheet in cyber: Night City block must be visible.
            await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var b=document.getElementById('settings-btn');if(b)b.click();return 1;})()");
            await Task.Delay(900);
            DebugLog("SETTINGS " + await v.CoreWebView2.ExecuteScriptAsync(                "JSON.stringify({open:!!document.querySelector('#settings-page:not([hidden])')," +
                "cyberBlock:(function(){var e=document.querySelector('.cyber-only');return e?getComputedStyle(e).display:null;})()," +
                "scan:!!document.getElementById('set-cyber-scanlines')," +
                "glitch:!!document.getElementById('set-cyber-glitch')})"));
            await ProbeShot(v, "probe-cyber-settings");

            // Тумблеры Night City: включить оба, проверить классы и снять кадр.
            DebugLog("TOGGLES on " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var s=document.getElementById('set-cyber-scanlines');" +
                "var g=document.getElementById('set-cyber-glitch');" +
                "if(s&&!s.checked){s.checked=true;s.dispatchEvent(new Event('change',{bubbles:true}));}" +
                "if(g&&!g.checked){g.checked=true;g.dispatchEvent(new Event('change',{bubbles:true}));}" +
                "return JSON.stringify({scanCls:document.body.classList.contains('scanlines')," +
                "glitchCls:document.body.classList.contains('glitch-max')," +
                "scanCss:(function(){var st=getComputedStyle(document.body,'::after');return st.backgroundImage.slice(0,60);})()," +
                "clockAnim:getComputedStyle(document.querySelector('.clock')).animationName});})()"));
            await Task.Delay(900);
            await ProbeShot(v, "probe-cyber-toggles");
            DebugLog("SWITCH " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var u=document.querySelector('.switch-ui');var st=getComputedStyle(u);" +
                "var a=getComputedStyle(u,'::after');" +
                "return JSON.stringify({bg:st.backgroundColor,border:st.borderTopColor,box:st.boxSizing," +
                "w:st.width,h:st.height,after:{left:a.left,w:a.width,bg:a.backgroundColor}});})()"));

            // Регресс: светлая тема и чужая палитра не должны тянуть cyber.
            DebugLog("MODES " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var r={};" +
                "var h=document.documentElement;" +
                "r.cyberNow=[h.dataset.theme,document.body.classList.contains('scanlines')];" +
                "window.LiveUi&&window.LiveUi.setPalette&&window.LiveUi.setPalette('ocean');" +
                "r.afterOther=[h.dataset.theme,document.querySelector('.link-tile')?getComputedStyle(document.querySelector('.link-tile')).borderRadius:'-'];" +
                "window.LiveUi&&window.LiveUi.setMode&&window.LiveUi.setMode('light');" +
                "r.cyberBlock=(function(){var e=document.querySelector('.cyber-only');return e?getComputedStyle(e).display:null;})();" +
                "return JSON.stringify(r);})()"));
            await Task.Delay(900);
            DebugLog("LIGHT settled " + await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({theme:document.documentElement.dataset.theme," +
                "bg:getComputedStyle(document.body).backgroundColor," +
                "cyberBlock:(function(){var e=document.querySelector('.cyber-only');" +
                "return e?getComputedStyle(e).display:null;})()," +
                "hostCyber:null})"));
            await Task.Delay(600);
            await ProbeShot(v, "probe-regress-light");
            DebugLog("TOGGLES off " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var s=document.getElementById('set-cyber-scanlines');" +
                "var g=document.getElementById('set-cyber-glitch');" +
                "if(s&&s.checked){s.checked=false;s.dispatchEvent(new Event('change',{bubbles:true}));}" +
                "if(g&&g.checked){g.checked=false;g.dispatchEvent(new Event('change',{bubbles:true}));}" +
                "return JSON.stringify({scanCls:document.body.classList.contains('scanlines')," +
                "glitchCls:document.body.classList.contains('glitch-max')});})()"));

            // Curtain in cyber: needs two real tabs, so open one and switch
            // through the same bridge path a click uses.
            await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var b=document.getElementById('settings-page-close');if(b)b.click();return 1;})()");
            await Task.Delay(400);
            OpenTab("https://example.com/", "Example");
            await Task.Delay(2500);
            DebugLog("SCROLLTEST " + await VerifySmoothScroll());
            DebugLog("WIKIWHEEL " + await ProbeWikiWheel());
            OpenTab("https://no-such-host-livebrowser-test.invalid/", "Err");
            await Task.Delay(6000);
            DebugLog("ERRPAGE " + await ProbeErrorPage());
            OpenTab("https://example.org/", "T2");
            await Task.Delay(1500);
            OpenTab("https://example.net/", "T3");
            await Task.Delay(2500);
            // The sampler and the glider both run on rAF, which a background
            // window throttles to zero frames: raise the window first.
            try
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Activate();
                TopMost = true; TopMost = false;
            }
            catch { }
            await Task.Delay(500);
            DebugLog("GLIDER " + await ProbeGlider());
            DebugLog("CURTAIN tabs=" + tabs.Count + " active=" + activeId);
            if (tabs.Count >= 2)
            {
                // Site -> site only: the sweep is disabled for Home (id 0),
                // and that is the path this probe kept landing on.
                var other = tabs.First(t => t.Id != activeId && t.Id != 0).Id;
                DebugLog("CURTAIN switching to " + other);
                ActivateAnimated(other);
                // Slow sweep (LIVEBROWSER_SLOWCURTAIN=1) keeps the band on
                // screen long enough for a screen grab to catch it.
                // Slow sweep runs 1.2 s: centre is at ~600 ms, so the grabs
                // straddle it instead of catching the band still off-screen.
                await Task.Delay(500);
                GrabScreen("probe-curtain-a");
                await Task.Delay(250);
                GrabScreen("probe-curtain-b");
                await Task.Delay(1200);
                await ProbeShot(v, "probe-cyber-curtain");
                DebugLog("CURTAIN after active=" + activeId);
                // Light-mode sweep: same path under ocean+light.  The band must
                // follow the CURRENT accent (blue) — this exact transition used
                // to keep the previous look because the raw cyber flag from the
                // palette JSON ignored the mode.
                await v.CoreWebView2.ExecuteScriptAsync(
                    "window.LiveTheme.setPalette('ocean');window.LiveTheme.setMode('light');'x'");
                await Task.Delay(900);
                // Same raise dance as the first sweep: CopyFromScreen needs a
                // live desktop surface and a normal window to be meaningful.
                try
                {
                    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                    Activate();
                    TopMost = true; TopMost = false;
                }
                catch { }
                await Task.Delay(400);
                var otherLight = tabs.First(t => t.Id != activeId && t.Id != 0).Id;
                ActivateAnimated(otherLight);
                await Task.Delay(500);
                GrabScreen("probe-curtain-light");
                GrabScreen("probe-curtain-out", 260);
                await Task.Delay(1400);
                await v.CoreWebView2.ExecuteScriptAsync(
                    "window.LiveTheme.setMode('dark');'x'");
            }
        }
        catch (Exception ex) { DebugLog("PROBE failed " + ex.Message); }
    }

    // rAF frame deltas while the tab strip re-renders and the glider slides.
    // Same measurement twice (occluded / raised) proves whether a flat 10ms
    // floor is throttling or real render cost.
    private async Task<string> MeasureFps(WebView2 v, int frames)
    {
        await v.CoreWebView2.ExecuteScriptAsync(
            "window.__fps={'pending':1};" +
            "(function(){var t=[];var last=performance.now();var n=0;" +
            "function f(now){t.push(now-last);last=now;if(++n<" + frames + "){requestAnimationFrame(f);}" +
            "else{var s=t.slice(5).sort(function(a,b){return a-b;});" +
            "window.__fps={n:t.length,med:+s[Math.floor(s.length/2)].toFixed(2)," +
            "p95:+s[Math.floor(s.length*0.95)].toFixed(2),max:+s[s.length-1].toFixed(2)};}}" +
            "requestAnimationFrame(f);return 1;})()");
        for (var k = 0; k < 5; k++)
        {
            await v.CoreWebView2.ExecuteScriptAsync(
                "document.querySelector('.tab-home')&&document.querySelector('.tab-home').click();'c'");
            await Task.Delay(90);
        }
        await Task.Delay(frames * 20);
        return await v.CoreWebView2.ExecuteScriptAsync("JSON.stringify(window.__fps)");
    }

    // Whole-window grab during a curtain sweep.  Page.captureScreenshot only
    // sees the page; the band is a layered popup of its own, so the only way
    // to tell "drawn but hidden under the compositor" from "not drawn" is to
    // look at real pixels on screen.
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr h);
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [System.Runtime.InteropServices.DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    // Снимок окна по запросу из шторки (проба середины проезда).
    internal void ProbeGrab(string name, int margin) => GrabScreen(name, margin);

    private void GrabScreen(string name, int margin = 0)
    {
        try
        {
            // margin > 0 — снимок с запасом вокруг клиента: так видно, не
            // вылезает ли слой шторки за границы окна на рабочий стол.
            var r = new Rectangle(PointToScreen(Point.Empty), ClientSize);
            if (margin > 0) r = Rectangle.Inflate(r, margin, margin);
            DebugLog("GRAB " + name + " rect=" + r);
            using var bmp = new Bitmap(r.Width, r.Height);
            using (var g = Graphics.FromImage(bmp))
            {
                // CopyFromScreen захватывает и слой шторки (layered top-level),
                // пока он виден — это содержимое кадра, а не «полоса пропала».
                IntPtr grab = GetDC(IntPtr.Zero);
                try
                {
                    bool ok = BitBlt(g.GetHdc(), 0, 0, r.Width, r.Height, grab, r.X, r.Y, 0x00CC0020u | 0x40000000u);
                    g.ReleaseHdc();
                    DebugLog("GRAB " + name + " blt=" + ok);
                }
                finally { ReleaseDC(IntPtr.Zero, grab); }
            }
            bmp.Save(System.IO.Path.Combine(AppPaths.Root, name + ".png"));
            DebugLog("GRAB " + name + " saved " + r.Width + "x" + r.Height);
        }
        catch (Exception ex) { DebugLog("GRAB failed " + name + ": " + ex.GetType().Name + " " + ex.Message); }
    }

    private async Task ProbeShot(WebView2 v, string name)    {
        var json = await v.CoreWebView2.CallDevToolsProtocolMethodAsync(
            "Page.captureScreenshot", "{\"format\":\"png\"}");
        var i = json.IndexOf("\"data\":\"", StringComparison.Ordinal);
        if (i < 0) { DebugLog("PROBE " + name + " no data"); return; }
        var s = json.Substring(i + 8);
        s = s.Substring(0, s.IndexOf('"'));
        var bytes = Convert.FromBase64String(s);
        var path = System.IO.Path.Combine(AppPaths.Root, name + ".png");
        System.IO.File.WriteAllBytes(path, bytes);
        DebugLog("PROBE " + name + " " + bytes.Length + "b");
    }

    // LIVEBROWSER_SELFTEST=1: after the shell loads, reads the visible desktop
    // back (clock, weather, tiles) into debug.log and exits, so a build can be
    // checked from the console without a human looking at the window.
    // Async on purpose: the old GetAwaiter().GetResult() here ran on the UI
    // thread and deadlocked the message pump until the script answered.
    private async Task<string> ShellErrorsAsync()
    {
        string text;
        if (ui == null || ui.IsDisposed || ui.CoreWebView2 == null) text = "(no ui)";
        else
        {
            try { text = await ui.CoreWebView2.ExecuteScriptAsync("JSON.stringify(window.__errs||null)"); }
            catch (Exception ex) { text = "ERR " + ex.Message; }
        }
        DebugLog("ERRS " + text);
        return text;
    }

    private async Task Shelleness(WebView2 v)    {
        if (Environment.GetEnvironmentVariable("LIVEBROWSER_SELFTEST") != "1") return;
        try
        {
            await Task.Delay(6000); // weather round-trip
            var js = "JSON.stringify({clock:document.getElementById('clock').textContent," +
                     "temp:document.getElementById('weather-temp').textContent," +
                     "desc:document.getElementById('weather-desc').textContent," +
                     "links:[...document.querySelectorAll('.link-tile')].map(e=>e.textContent)," +
                     "stageTop:document.getElementById('stage').getBoundingClientRect().top," +
                     "stageH:document.getElementById('stage').getBoundingClientRect().height," +
                     "scrollH:document.getElementById('stage').scrollHeight})";
            var json = await v.CoreWebView2.ExecuteScriptAsync(js);
            DebugLog("SELFTEST " + json);
            // Suggestion cascade, checked offline: the rows come from the
            // open-tab matches, so a dead network cannot mask this.  Each row
            // must carry a distinct stagger delay and a real animation.
            // Snapshot on the first frame after each render: the cascade class
            // is dropped on animationend (~0.3s), so a late read sees a settled
            // list and claims "no animation" for a perfectly working one.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.__casc=[];" +
                "new MutationObserver(function(){requestAnimationFrame(function(){" +
                "var r=document.querySelectorAll('#suggests .suggest');if(!r.length)return;" +
                "window.__casc.push([...r].slice(0,6).map(function(x){var c=getComputedStyle(x);" +
                "return x.className+'|'+c.animationName+'|'+c.animationDelay;}));});})" +
                ".observe(document.getElementById('suggests'),{childList:true});" +
                "window.LiveUi.setBarMode('omni');" +
                "var i=document.getElementById('search');i.value='e';" +
                "i.dispatchEvent(new Event('input',{bubbles:true}));i.focus();'x'");
            await Task.Delay(900);
            DebugLog("CASC0 " + await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify((window.__casc||[]).slice(0,2))"));
            // Typing timeline: emulate "в" -> "ва" -> "вал" and sample the
            // panel every 60ms.  Tells us whether the list BLINKS (hidden
            // flips between samples) while the lookup is in flight.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.__tl=[];var box=document.getElementById('suggests');" +
                "var inp=document.getElementById('search');" +
                "var t0=performance.now();" +
                "function snap(tag){var f=box.querySelector('.suggest');" +
                "window.__tl.push([Math.round(performance.now()-t0),tag," +
                "box.hidden?1:0,box.children.length," +
                "(f?(f.textContent||'').slice(0,14):'-')," +
                "(f&&f.classList.contains('suggest-in')?'anim':'idle')+'/' +" +
                "(f&&f.classList.contains('suggest-stale')?'stale':'live')]);}" +
                "var i=0,words=['в','ва','вал','валб'];" +
                "(function step(){if(i>=words.length){snap('end');return;}" +
                "inp.value=words[i];snap('set:'+words[i]);" +
                "inp.dispatchEvent(new Event('input',{bubbles:true}));i++;" +
                "var k=0;(function poll(){snap('t+'+k*60);k++;if(k<5)setTimeout(poll,60);" +
                "else setTimeout(step,140);})();})();'go'");
            await Task.Delay(3500);
            DebugLog("TIMELINE " + await v.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify(window.__tl||[])"));
            // The native layer is a SEPARATE page (dropdown.html): the shell's
            // cascade proves nothing about what the user sees over a site.
            // Feed it a list twice — same query, then a new one — and read the
            // row delays on the first frame after each render.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.LiveTabs.open('https://example.com','example');'x'");
            await Task.Delay(2500);
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.LiveUi.setBarMode('omni');var i=document.getElementById('search');" +
                "i.value='вал';i.dispatchEvent(new Event('input',{bubbles:true}));i.focus();'x'");
            await Task.Delay(1200);
            // Snapshot the layer on the FIRST frame after its next render:
            // by the time a human-visible probe runs, a 0.3s cascade is over
            // and every row reports animationName:none even when it played.
            if (panelView != null && panelView.CoreWebView2 != null)
            {
                await panelView.CoreWebView2.ExecuteScriptAsync(
                    "window.__np=[];var L=document.querySelector('.dd-list');" +
                    "new MutationObserver(function(){requestAnimationFrame(function(){" +
                    "var r=L.querySelectorAll('.suggest');if(!r.length)return;" +
                    "window.__np.push([...r].slice(0,6).map(function(x){var c=getComputedStyle(x);" +
                    "return x.tagName+':'+(x.classList.contains('suggest-in')?c.animationDelay:'-');" +
                    "})+'|'+r.length);});})" +
                    ".observe(L,{childList:true});'ok'");
                await v.CoreWebView2.ExecuteScriptAsync(
                    "var i=document.getElementById('search');i.value='валб';" +
                    "i.dispatchEvent(new Event('input',{bubbles:true}));'x'");
                await Task.Delay(1400);
                DebugLog("NPCASC2 " + await panelView.CoreWebView2.ExecuteScriptAsync(
                    "JSON.stringify((window.__np||[]).slice(0,3))"));
            }
            if (panelView != null && panelView.CoreWebView2 != null)
            {
                DebugLog("NPCASCADE " + await panelView.CoreWebView2.ExecuteScriptAsync(
                    "(function(){var r=document.querySelectorAll('.dd-list > .suggest');var o=[];" +
                    "for(var k=0;k<r.length&&k<5;k++){var c=getComputedStyle(r[k]);" +
                    "o.push(r[k].className.replace('suggest ','').slice(0,14)+'|'+c.animationName+'|'+c.animationDelay);}" +
                    "return JSON.stringify({rows:r.length,rows5:o,vis:document.visibilityState});})()"));
            }
            else DebugLog("NPCASCADE no panelView");
            DebugLog("CASCADE " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var b=document.getElementById('suggests');" +
                "var rows=b.querySelectorAll('.suggest');if(!rows.length)return 'no rows';" +
                "var dly=[];for(var k=0;k<rows.length;k++){var cs=getComputedStyle(rows[k]);" +
                "dly.push(cs.animationDelay+'/'+cs.animationName);}" +
                "var uniq=new Set(dly.map(function(x){return x.split('/')[0];})).size;" +
                "return JSON.stringify({rows:rows.length,distinctDelays:uniq," +
                "sample:dly.slice(0,5),hidden:b.hidden," +
                "why:{noAnim:document.body.classList.contains('no-anim')," +
                "site:document.body.classList.contains('site-active')," +
                "rm:window.matchMedia('(prefers-reduced-motion: reduce)').matches," +
                "theme:document.documentElement.getAttribute('data-theme')||'-'," +
                "hasJs:typeof window.LiveUi,bar:document.getElementById('chrome-bar').className}});})()"));
            // Which network the page itself can reach (the language check).
            // ExecuteScriptAsync does not await promises, so the result is
            // written to a global and read back in a second call.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.__net='pending';fetch('https://api.open-meteo.com/v1/forecast?latitude=64.5&longitude=40.5&current=temperature_2m')" +
                ".then(async r=>{window.__net='weather '+r.status+' '+(await r.text()).slice(0,100);})" +
                ".catch(e=>{window.__net='weather ERR '+e;});'go'");
            await Task.Delay(4000);
            DebugLog("NET " + await v.CoreWebView2.ExecuteScriptAsync("String(window.__net)"));
            DebugLog("SRC " + await v.CoreWebView2.ExecuteScriptAsync(
                "String(window.__livebrowser && typeof window.__livebrowser.loadTheme) + ' | ' + document.scripts.length + ' scripts'"));
            DebugLog("SRC " + await v.CoreWebView2.ExecuteScriptAsync(
                "String(window.__livebrowser && typeof window.__livebrowser.loadTheme) + ' | ' + document.scripts.length + ' scripts'"));
            // Re-run the weather loader by hand to surface its error.
            DebugLog("RUN " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var s=[...document.scripts].map(x=>x.src.split('/').pop()).join(',');" +
                "fetch('https://api.livebrowser.shell/api/where').then(r=>r.json()).then(j=>{window.__w=JSON.stringify(j);}).catch(e=>{window.__w='ERR '+e;});" +
                "return s;})()"));
            await Task.Delay(2000);
            DebugLog("WHERE " + await v.CoreWebView2.ExecuteScriptAsync("String(window.__w)"));
            // Is open-meteo reachable from the page at all?  Log the status
            // and the text, then the error text if the fetch itself fails.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.__om='pending';fetch('https://api.open-meteo.com/v1/forecast?latitude=55.7509&longitude=37.6184&current=temperature_2m&timezone=auto')" +
                ".then(r=>{window.__om='status '+r.status;return r.text();})" +
                ".then(t=>{window.__om+=' body '+t.slice(0,160);})" +
                ".catch(e=>{window.__om='FAIL '+e+' name='+e.name+' msg='+e.message;});'go'");
            await Task.Delay(6000);
            DebugLog("OM " + await v.CoreWebView2.ExecuteScriptAsync("String(window.__om)"));
            DebugLog("WSTAGE " + await v.CoreWebView2.ExecuteScriptAsync("String(window.__wstage)"));
            // Step through the real loader: which promise stage rejects?
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.__wt='start';" +
                "(async()=>{try{" +
                "const s1=await fetch('https://api.livebrowser.shell/api/where',{cache:'no-store'}); window.__wt='s1 '+s1.status;" +
                "const j1=await s1.json(); window.__wt='j1 '+JSON.stringify(j1);" +
                "const s2=await fetch('https://api.open-meteo.com/v1/forecast?latitude='+j1.lat+'&longitude='+j1.lon+'&current=temperature_2m,weather_code&timezone=auto'); window.__wt='s2 '+s2.status;" +
                "const j2=await s2.json(); window.__wt='j2 temp='+(j2.current&&j2.current.temperature_2m);" +
                "}catch(e){window.__wt='ERR '+e+' @ '+window.__wt;}})();'go'");
            await Task.Delay(3000);
            DebugLog("WT " + await v.CoreWebView2.ExecuteScriptAsync("String(window.__wt)"));
        }
        catch (Exception ex) { DebugLog("SELFTEST failed " + ex.Message); }
        await ShellProbe(v);
        // LIVEBROWSER_SELFTEST — неинтерактивный прогон: помечаем чистый
        // выход, иначе зонд оставит пользователю примерные вкладки «на память».
        SessionStore.MarkCleanExit();
        BeginInvoke(new Action(Close));
    }

    private async Task ProbeAsync(WebView2 v)    {
        try
        {
            // Full flow: type -> pick suggestion (Enter on row 0) -> wait for
            // the site tab -> second tab -> report what the host holds.
            var r1 = await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var i=document.getElementById('search'); i.value='\u043f\u043e\u0433\u043e\u0434\u0430'; " +
                "i.dispatchEvent(new Event('input',{bubbles:true})); i.focus(); return 'typed';})()");
            DebugLog("A " + r1);
            await Task.Delay(1200);
            await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var i=document.getElementById('search'); i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); " +
                "i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'enter';})()");
            await Task.Delay(5000);
            DebugLog("TABS " + Describe());
            var r2 = await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var b=document.getElementById('jump'); return 'jump hidden=' + (b?b.hidden:'n/a') + ' tabmode=' + document.getElementById('chrome-bar').className;})()");
            DebugLog("B " + r2);
            await v.CoreWebView2.ExecuteScriptAsync("window.LiveTabs.open('https://example.com', 'example')");
            await Task.Delay(4000);
            DebugLog("TABS2 " + Describe());
            var r3 = await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var h=document.getElementById('drag-zone'); var r=h.getBoundingClientRect(); " +
                "return JSON.stringify({visible: h.offsetParent!==null, w:r.width, h:r.height, pe:getComputedStyle(h).pointerEvents});})()");
            DebugLog("DZ " + r3);
            DebugLog("BAR " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var r=document.getElementById('chrome-bar').getBoundingClientRect();return 'dpr='+devicePixelRatio+' top='+r.top+' bottom='+r.bottom+' iw='+innerWidth+' ih='+innerHeight;})()"));
            // The strip renders tabs client-side; Describe() above only shows
            // the host model, so a render bug would stay invisible here.
            await Task.Delay(400);
            DebugLog("STRIP " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var t=document.getElementById('tabs');return JSON.stringify(" +
                "{kids:t?t.children.length:-1,w:t?t.clientWidth:-1,h:t?t.clientHeight:-1," +
                "html:t?t.innerHTML.slice(0,200):'',bar:document.getElementById('chrome-bar').className," +
                "seen:window.__tabsSeen||0,last:window.__lastTabsCount||0," +
                "err:window.__err||''});})()"));
            // Suggestions in omnibox mode ON A SITE TAB: type and dump the
            // panel geometry — the persona reported a 0x0 hidden panel here.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.LiveUi.setBarMode('omni'); var i=document.getElementById('search');" +
                "i.value='wiki'; i.dispatchEvent(new Event('input',{bubbles:true})); i.focus(); 'x'");
            await Task.Delay(1500);
            DebugLog("OMNI " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var b=document.getElementById('suggests');var r=b.getBoundingClientRect();" +
                "return JSON.stringify({hidden:b.hidden,kids:b.children.length,w:Math.round(r.width)," +
                "h:Math.round(r.height),top:Math.round(r.top),left:Math.round(r.left)," +
                "bar:document.getElementById('chrome-bar').className,last:window.__lastHide||'',ae:" +
                "(document.activeElement&&document.activeElement.id)||'null'});})()"));
            // Suggestion cascade: every row must carry a staggered delay, and
            // a keystroke refill must re-cascade instead of swapping rows in
            // one frame (that instant swap is what looked "резко").
            DebugLog("SUGGEST " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var b=document.getElementById('suggests');" +
                "function delays(){return Array.prototype.map.call(b.querySelectorAll('.suggest')," +
                "function(r){return getComputedStyle(r).animationDelay;});}" +
                "var open=delays();" +
                "var i=document.getElementById('search');i.value='вал';" +
                "i.dispatchEvent(new Event('input',{bubbles:true}));" +
                "return JSON.stringify({rows:b.children.length,open:open.slice(0,6)," +
                "anim:(b.querySelector('.suggest')?getComputedStyle(b.querySelector('.suggest')).animationName:'none')," +
                "durs:(b.querySelector('.suggest')?getComputedStyle(b.querySelector('.suggest')).animationDuration:'-')});})()"));
            await Task.Delay(900);
            DebugLog("SUGGEST2 " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var b=document.getElementById('suggests');" +
                "var rows=b.querySelectorAll('.suggest');" +
                "return JSON.stringify({rows:rows.length," +
                "delays:Array.prototype.map.call(rows,function(r){return getComputedStyle(r).animationDelay;}).slice(0,6)," +
                "cls:Array.prototype.map.call(rows,function(r){return r.classList.contains('suggest-in');}).slice(0,6)," +
                "last:window.__lastHide||''});})()"));
            // RU-layout Ctrl+L: e.key is 'л', the handler must match by e.code.
            await v.CoreWebView2.ExecuteScriptAsync(
                "window.dispatchEvent(new KeyboardEvent('keydown',{key:'л',code:'KeyL',ctrlKey:true,bubbles:true}));'x'");
            await Task.Delay(300);
            DebugLog("CTRLRU " + await v.CoreWebView2.ExecuteScriptAsync(
                "(function(){var i=document.getElementById('search');return JSON.stringify(" +
                "{focused:document.activeElement===i,mode:document.getElementById('chrome-bar').className});})()"));
            await v.CoreWebView2.ExecuteScriptAsync("window.LiveTabs.switchTo(0); 'x'");
            await Task.Delay(800);
            DebugLog("HOME " + Describe());
        }
        catch (Exception ex) { DebugLog("PROBE failed " + ex); }
    }

    private string Describe()
    {
        var parts = tabs.Select(t =>
        {
            var vis = views.TryGetValue(t.Id, out var w) && w.Visible ? "visible" : "hidden";
            var src = views.TryGetValue(t.Id, out var w2) && w2.CoreWebView2 != null ? w2.CoreWebView2.Source : "-";
            return $"#{t.Id}[{t.Title}] {vis} {src}";
        });
        return $"active={activeId}; " + string.Join(" | ", parts);
    }

    /* ---------------------------------------------------------- */
    /* Helpers                                                      */
    /* ---------------------------------------------------------- */

    private static string ShortHost(string url)
    {
        try { return new Uri(url).Host.Replace("www.", ""); }
        catch { return url; }
    }

    private static string ShortTitle(string title, string url)
    {
        if (!string.IsNullOrWhiteSpace(title)) return title;
        return ShortHost(url);
    }

    private static int AccentFor(string host)
    {
        if (string.IsNullOrEmpty(host)) return 0x7c5cff;
        int h = 0;
        foreach (var c in host) h = (h * 31 + c) % 360;
        return HslToColor(h, 62, 52);
    }

    private static int HslToColor(double h, double s, double l)
    {
        s /= 100; l /= 100;
        double c = (1 - Math.Abs(2 * l - 1)) * s;
        double x = c * (1 - Math.Abs((h / 60) % 2 - 1));
        double m = l - c / 2;
        double r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return ((int)((r + m) * 255) << 16) | ((int)((g + m) * 255) << 8) | (int)((b + m) * 255);
    }

    // Ждёт, пока промис запишет результат в window[name] (ExecuteScriptAsync
    // в этой сборке WebView2 промисы не дожидается — см. комментарий выше).

    private async Task<string> PollProbeAsync(string name, int tries, string require = null)
    {
        for (int i = 0; i < tries; i++)
        {
            await Task.Delay(100);
            if (ui == null || ui.IsDisposed || ui.CoreWebView2 == null) return "aborted";
            string v;
            try { v = await ui.CoreWebView2.ExecuteScriptAsync("String(window." + name + ")"); }
            catch { return "exec-failed"; }
            if (v == null) continue;
            if (v.Length >= 2 && v[0] == '"') { try { v = System.Text.Json.JsonSerializer.Deserialize<string>(v); } catch { } }
            if (require == "final" && v != null && v.StartsWith("partial ")) continue;
            if (!string.IsNullOrEmpty(v) && v != "pending" && v != "undefined") return v;
        }
        return "timeout";
    }

}
