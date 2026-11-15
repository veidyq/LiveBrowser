/* Private-window marker.
 *
 * The host decides (it owns the wiped profile); this file only shows it.  The
 * mode comes from two independent sources on purpose — the {type:"private"}
 * push and /api/private — because a single missed message would leave a
 * private window looking exactly like a normal one, which is the one thing
 * the user must never have to guess.
 */
(() => {
  const chip = document.getElementById('private-chip');
  if (!chip) return;

  let on = false;

  function render() {
    chip.hidden = !on;
    document.body.classList.toggle('private-window', on);
    try { document.title = on ? 'Приватно · LiveBrowser' : 'LiveBrowser'; } catch { /* frame gone */ }
  }

  function set(value) {
    if (typeof value !== 'boolean' || value === on) return;
    on = value;
    render();
  }

  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (e) => {
      let d = e.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { return; }
      }
      if (d && d.type === 'private') set(d.on !== false);
    });
  }

  // The push can land before this script runs (the host pushes right after
  // the shell loads); asking the host is the one path that cannot be missed.
  function ask() {
    fetch('https://api.livebrowser.shell/api/private', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => set(!!(d && d.on)))
      .catch(() => { /* host gone: leave the chip as it is */ });
  }
  ask();
  addEventListener('DOMContentLoaded', ask);

  window.__lbPrivate = () => ({ on, shown: !chip.hidden });
})();
