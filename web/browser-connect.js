'use strict';
// A target-origin window performs login; no proxy, cross-origin fetch or URL token.
window.NoctuaBrowserConnection = (() => {
  function address(value) {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw Error('Enter an HTTPS server address, or an HTTP localhost address, without a path or credentials.');
    }
    return url.origin;
  }
  async function connect(value, token, beforeConnect) {
    const origin = address(value);
    if (!token.trim()) throw Error('Enter the server authentication token.');
    const id = crypto.randomUUID();
    const url = new URL('/browser-connect', origin);
    url.searchParams.set('from', location.origin);url.searchParams.set('id', id);
    const popup = window.open(url.href, '_blank', 'popup,width=560,height=500');
    if (!popup) throw Error('Allow pop-ups for Noctua, then try again.');
    let listener, timeout, poll, finished=false;
    try {
      await new Promise((resolve, reject) => {
        let started = false;
        timeout = setTimeout(() => reject(Error('Connection timed out. Check the address and that the target server supports browser connection settings.')), 30000);
        poll = setInterval(() => { if (popup.closed) reject(Error('Connection window was closed.')); }, 300);
        listener = async event => {
          if (event.source !== popup || event.origin !== origin || event.data?.id !== id) return;
          if (event.data.type === 'noctua-connect-ready' && !started) {
            started = true;
            try {
              await beforeConnect();
              if (finished || popup.closed) throw Error('Connection window was closed or timed out.');
              popup.postMessage({type:'noctua-connect-login', id, token}, origin);
              token = '';
            } catch (error) { reject(error); }
          } else if (event.data.type === 'noctua-connect-result' && started) {
            if (!event.data.ok) reject(Error('Connection failed. Check the server token and that the server is ready.'));
            else if (![1,2].includes(event.data.server?.api_version) || !event.data.server?.ready || !event.data.server?.server_id) reject(Error('The target server is incompatible or unavailable.'));
            else resolve();
          }
        };
        window.addEventListener('message', listener);
      });
      return origin + '/shell';
    } finally {
      finished=true;token = '';clearTimeout(timeout);clearInterval(poll);
      window.removeEventListener('message', listener);popup.close();
    }
  }
  function receive() {
    const status = document.querySelector('[role=status]');
    const params = new URLSearchParams(location.search);
    let source;
    try { source = address(params.get('from')); } catch { status.textContent = 'Open connection settings in your current Noctua tab to connect.';return; }
    const id = params.get('id');
    if (!window.opener || !id) { status.textContent = 'Open connection settings in your current Noctua tab to connect.';return; }
    let used = false;
    window.addEventListener('message', async event => {
      if (used || event.source !== window.opener || event.origin !== source || event.data?.id !== id || event.data.type !== 'noctua-connect-login') return;
      used = true;
      let token = event.data.token;
      try {
        if (typeof token !== 'string' || !token) throw Error();
        status.textContent = 'Checking authentication…';
        const response = await fetch('/auth/login', {method:'POST',headers:{Authorization:'Bearer '+token,'X-Noctua-Client':'1'},signal:AbortSignal.timeout(15000)});
        token = '';
        if (!response.ok) throw Error();
        const identity = await fetch('/api/server', {signal:AbortSignal.timeout(10000)});
        if (!identity.ok) throw Error();
        const server = await identity.json();
        if (![1,2].includes(server.api_version) || !server.ready || !server.server_id) throw Error();
        window.opener.postMessage({type:'noctua-connect-result',id,ok:true,server:{api_version:server.api_version,ready:server.ready,server_id:server.server_id}},source);
        status.textContent = 'Connected. Returning to Noctua…';
      } catch {
        window.opener.postMessage({type:'noctua-connect-result',id,ok:false},source);
        status.textContent = 'Connection failed. Return to Settings and check your token.';
      } finally { token = ''; }
    });
    window.opener.postMessage({type:'noctua-connect-ready',id},source);
  }
  return {address,connect,receive};
})();
