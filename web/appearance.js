'use strict';
// Works before authentication and without a running data server.
(() => {
  function sync() {
    let theme = 'system';
    try { theme = localStorage.getItem('noctua.theme') || theme; } catch { /* system appearance */ }
    document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system';
  }
  sync();
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === 'noctua.theme') sync();
  });
})();
