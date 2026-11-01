// Runs a tests/*.html WebKit check page in headless Chrome by shimming
// window.webkit.messageHandlers.result, for hosts without the macOS Swift runner.
// Usage: node run-webkit-page.mjs <repo root> tests/<page>.html
// Exit code: 0 PASS, 1 FAIL, 2 timeout. Set CHROME to override the browser binary.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [root, page] = process.argv.slice(2);
if (!root || !page) { console.error('Usage: node run-webkit-page.mjs <repo root> tests/<page>.html'); process.exit(2); }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'noctua-chrome-'));
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--remote-debugging-port=0', '--no-first-run', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buffer = ''; chrome.stderr.on('data', (d) => { buffer += d; const m = buffer.match(/ws:\/\/\S+/); if (m) resolve(m[0]); }); });
const targets = await (await fetch(wsUrl.replace('ws://', 'http://').replace(/\/devtools.*/, '/json'))).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const done = (code, message) => { console.log(message); chrome.kill(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); process.exit(code); };
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.bindingCalled') done(m.params.payload.startsWith('PASS') ? 0 : 1, m.params.payload);
  if (m.method === 'Runtime.exceptionThrown') console.error('exception:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
await send('Runtime.enable'); await send('Page.enable'); await send('Runtime.addBinding', { name: '__result' });
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.webkit={messageHandlers:{result:{postMessage:m=>__result(String(m))}}};' });
await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${page}` });
setTimeout(() => done(2, 'TIMEOUT'), 20000);
