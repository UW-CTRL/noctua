'use strict';
// Every cookie-authenticated write carries a non-simple header; the server also checks Origin.
window.noctuaServerId = document.querySelector('meta[name=noctua-server-id]')?.content || null;
const noctuaFetch = window.fetch.bind(window);
window.fetch = (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin === location.origin) {
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Noctua-Client', '1');
    if (window.noctuaServerId) headers.set('X-Noctua-Server', window.noctuaServerId);
    options = { ...options, headers };
  }
  return noctuaFetch(input, options);
};
window.verifyNoctuaServer = async () => {
  const r = await fetch('/api/server');
  if (!r.ok) throw Error('Server disconnected; reconnect through Server & connection');
  const server = await r.json();
  if (server.api_version !== 1 || !server.ready || server.server_id !== window.noctuaServerId) throw Error('Server identity or version changed; open Server & connection');
  return server;
};
window.noctuaServer = window.verifyNoctuaServer();
window.noctuaServer.catch(() => {});

// An offline page keeps its current content and drafts; recovery controls are always visible.
window.addEventListener('DOMContentLoaded', () => {
  const banner = document.createElement('div');
  banner.style.cssText='position:fixed;bottom:12px;right:12px;padding:12px;background:#faf9f6;color:#292923;border:1px solid #ccc;border-radius:8px;z-index:99999;max-width:400px';
  banner.hidden=true; document.body.appendChild(banner);
  const check=async()=>{try{const attempt=window.verifyNoctuaServer(); window.noctuaServer=attempt; await attempt; banner.hidden=true;}catch{banner.textContent='Disconnected. Open Server & connection from the desktop Settings menu to retry or change servers. Browser: reload to sign in again. Local note drafts stay on this device.';banner.hidden=false;}};
  window.addEventListener('offline',check);window.addEventListener('online',check);check();setInterval(check,10000);
});
