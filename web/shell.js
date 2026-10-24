'use strict';
// The desktop app's window: a tab strip, each tab a full Noctua page in an
// iframe (same origin, so the shell can read each tab's title and location).
// The app's menu calls noctuaShell.cmd(…) for New Tab, Close Tab, etc.

function syncShellTheme() {
  try { document.documentElement.dataset.theme = localStorage.getItem('noctua.theme') || 'system'; } catch { /* system appearance */ }
}
syncShellTheme();
window.addEventListener('storage', (e) => { if (e.key === 'noctua.theme' || e.key === null) syncShellTheme(); });

const params = new URLSearchParams(location.search);
const WIN = params.get('w') || 'w1';
const STORE = `noctua.shell.${WIN}`;
const tabsEl = document.getElementById('tabs');
const framesEl = document.getElementById('frames');
const newBtn = document.getElementById('new');
let tabs = [];      // { id, el, frame }
let active = null;
let seq = 0;

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// A tab's current app location (path + #hash), to restore or move it.
function tabUrl(t) {
  try {
    const l = t.frame.contentWindow.location;
    return l.pathname + l.search + l.hash;
  } catch { return t.frame.getAttribute('src'); }
}

function addTab(url = '/', { activate = true, after = null } = {}) {
  const id = `t${++seq}`;
  const el = document.createElement('div');
  el.className = 'tab';
  el.draggable = true;
  el.innerHTML = '<span class="t">Noctua</span><button class="x" title="Close tab (⌘W / Ctrl+W)" data-icon="x" aria-label="Close tab (⌘W / Ctrl+W)" data-icon-only>×</button>';
  const frame = document.createElement('iframe');
  frame.src = url.startsWith('/') && !url.startsWith('/shell') ? url : '/';
  const t = { id, el, frame };
  const at = after ? tabs.indexOf(after) + 1 : tabs.length;
  tabs.splice(at, 0, t);
  tabsEl.insertBefore(el, tabs[at + 1]?.el || newBtn);
  framesEl.appendChild(frame);
  frame.addEventListener('load', () => watchFrame(t));
  el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('.x')) activateTab(t); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
  el.querySelector('.x').addEventListener('click', () => closeTab(t));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); });
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-noctua-tab', id); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-noctua-tab')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop');
    const from = tabs.find((x) => x.id === e.dataTransfer.getData('text/x-noctua-tab'));
    if (!from || from === t) return;
    tabs.splice(tabs.indexOf(from), 1);
    tabs.splice(tabs.indexOf(t), 0, from);
    tabsEl.insertBefore(from.el, t.el);
    save();
  });
  if (activate) activateTab(t);
  save();
  return t;
}

// Keeps the tab's title in sync and forwards the shell's shortcuts from inside it.
function watchFrame(t) {
  let doc;
  try { doc = t.frame.contentDocument; } catch { return; }
  const update = () => {
    const title = (doc.title || 'Noctua').replace(/ · Noctua$/, '');
    t.el.querySelector('.t').textContent = title;
    t.el.title = title;
    if (t === active) document.title = doc.title || 'Noctua';
  };
  update();
  const titleEl = doc.querySelector('title');
  if (titleEl) new MutationObserver(update).observe(titleEl, { childList: true, characterData: true, subtree: true });
  t.frame.contentWindow.addEventListener('keydown', shortcut);
  t.frame.contentWindow.addEventListener('hashchange', save);
  t.frame.contentWindow.addEventListener('popstate', save);
}

function activateTab(t) {
  active = t;
  for (const x of tabs) {
    x.el.classList.toggle('active', x === t);
    x.frame.classList.toggle('active', x === t);
  }
  try { document.title = t.frame.contentDocument?.title || 'Noctua'; } catch { /* not loaded yet */ }
  t.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  t.frame.focus();
  save();
}
const activate = activateTab;

async function closeTab(t) {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  t.el.remove();
  // Removing an iframe skips its beforeunload, so save its open note first.
  try { await t.frame.contentWindow.saveNow?.(); await t.frame.contentWindow.flushPDF?.(); } catch { /* page not loaded */ }
  t.frame.remove();
  if (!tabs.length) {
    save();
    post('/api/desktop/close', { window: WIN });
    return;
  }
  if (active === t) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  save();
}

function moveToNewWindow(t) {
  const url = tabUrl(t);
  post('/api/desktop/window', { url }).then(() => closeTab(t));  // closeTab saves the note first
}

function tabMenu(t, x, y) {
  document.getElementById('menu')?.remove();
  const m = document.createElement('div');
  m.id = 'menu';
  m.innerHTML = '<button data-a="new" data-icon="plus">New tab to the right</button><button data-a="move" data-icon="app-window">Move to new window</button><button data-a="close" data-icon="x">Close tab</button>';
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  document.body.appendChild(m);
  const done = () => m.remove();
  m.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    done();
    if (a === 'new') addTab('/', { after: t });
    if (a === 'move') moveToNewWindow(t);
    if (a === 'close') closeTab(t);
  });
  setTimeout(() => document.addEventListener('mousedown', (e) => { if (!m.contains(e.target)) done(); }, { once: true }));
}

function step(d) {
  if (tabs.length < 2) return;
  activateTab(tabs[(tabs.indexOf(active) + d + tabs.length) % tabs.length]);
}

// ⌘1–9 / Ctrl+1–9 (the rest come from the app menu, which works everywhere).
function shortcut(e) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const n = Number(e.key);
    activateTab(n === 9 ? tabs[tabs.length - 1] : tabs[n - 1] || active);
  }
}

// Only the first window restores its tabs at launch; others start fresh.
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ tabs: tabs.map(tabUrl), active: tabs.indexOf(active) }));
  } catch { /* storage unavailable */ }
}

window.noctuaShell = {
  openTab(url) { return addTab(url, { after: active }); },
  cmd(name) {
    if (name === 'newTab') addTab('/', { after: active });
    else if (name === 'closeTab') active && closeTab(active);
    else if (name === 'nextTab') step(1);
    else if (name === 'prevTab') step(-1);
    else if (name === 'reload') active?.frame.contentWindow.location.reload();
    else if (name === 'settings') active?.frame.contentWindow.openSetup?.({ firstRun: false });
  },
};

newBtn.addEventListener('click', () => addTab('/'));
document.addEventListener('keydown', shortcut);
tabsEl.addEventListener('dblclick', (e) => { if (e.target === tabsEl) addTab('/'); });
window.addEventListener('beforeunload', save);
setInterval(save, 5000);  // tab locations change as you browse

{
  let saved = null;
  try { saved = WIN === 'w1' && !params.get('open') ? JSON.parse(localStorage.getItem(STORE) || 'null') : null; } catch { /* ignore */ }
  if (params.get('open')) addTab(params.get('open'));
  else if (saved?.tabs?.length) {
    saved.tabs.forEach((u) => addTab(u, { activate: false }));
    activateTab(tabs[Math.max(0, Math.min(saved.active, tabs.length - 1))]);
  } else addTab('/');
}
