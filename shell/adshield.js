/* Ad-block shield in the address bar.
 *
 * The host blocks the request itself (AdBlock.cs) and pushes the per-page
 * count here; this file only renders it.  A page with nothing blocked shows
 * nothing at all — a permanent "0 blocked" badge is noise on every site that
 * never had ads, which is most of them.
 */
(() => {
  const pill = document.getElementById('addr-pill');
  const badge = document.getElementById('addr-shield');
  if (!pill || !badge) return;

  let state = { blocked: 0, total: 0, enabled: true };

  function render() {
    const show = state.enabled && state.blocked > 0;
    badge.hidden = !show;
    if (!show) return;
    const n = state.blocked;
    badge.textContent = String(n > 99 ? '99+' : n);
    badge.title = `Заблокировано на этой странице: ${n}` +
      (state.total > n ? ` · всего за сеанс: ${state.total}` : '');
    badge.setAttribute('aria-label', badge.title);
  }

  function apply(d) {
    if (!d || d.type !== 'adblock') return;
    if (typeof d.blocked === 'number') state.blocked = d.blocked;
    if (typeof d.total === 'number') state.total = d.total;
    if (typeof d.enabled === 'boolean') state.enabled = d.enabled;
    render();
  }

  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (e) => {
      let d = e.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { return; }
      }
      apply(d);
    });
  }

  // The pill is repainted on every navigation (tabs.js updateAddressPill).
  // Watching the host text is enough: a new page means a new count, and the
  // host's own counter was reset on NavigationStarting.
  window.__lbAdShieldReset = () => { state.blocked = 0; render(); };

  window.__lbAdShield = () => ({ ...state, shown: !badge.hidden });
  render();
})();
