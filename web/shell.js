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
const STORE = `noctua.shell.${window.noctuaServerId || location.origin}.${WIN}`;
const tabsEl = document.getElementById('tabs');
const framesEl = document.getElementById('frames');
const newBtn = document.getElementById('new');
let tabs = [];      // { id, el, frame }
let active = null;
let seq = 0;
let switching = false;

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// A tab's current app location (path + #hash), to restore or move it.
function tabUrl(t) {
  try {
    const l = t.frame.contentWindow.location;
    return l.pathname + l.search + l.hash;
  } catch { return t.frame.getAttribute('src'); }
}

function safeTabPath(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') && !url.startsWith('/shell') ? url : '/';
}

function addTab(url = '/', { activate = true, after = null } = {}) {
  if (switching) return null;
  const id = `t${++seq}`;
  const el = document.createElement('div');
  el.className = 'tab';
  el.draggable = true;
  el.innerHTML = '<span class="t">Noctua</span><button class="x" title="Close tab (⌘W / Ctrl+W)" data-icon="x" aria-label="Close tab (⌘W / Ctrl+W)" data-icon-only>×</button>';
  const frame = document.createElement('iframe');
  frame.name = `noctua:${window.noctuaServerId || location.origin}:${WIN}:${id}`;
  frame.src = safeTabPath(url);
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
  try { await flushFrame(t); } catch (e) { alert('Tab remains open: ' + e.message); return; }
  tabs.splice(i, 1);
  t.el.remove();
  // Removing an iframe skips its beforeunload, so save its open note first.
  try { await t.frame.contentWindow.saveNow?.(); await t.frame.contentWindow.flushPDF?.(); } catch { /* page not loaded */ }
  t.frame.remove();
  if (!tabs.length) {
    save();
    addTab('/');
    return;
  }
  if (active === t) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  save();
}

async function moveToNewWindow(t) {
  try { await flushFrame(t); window.open(tabUrl(t), '_blank', 'noopener'); }
  catch (error) { alert('Save before opening another window: ' + error.message); }
}

function tabMenu(t, x, y) {
  document.getElementById('menu')?.remove();
  const m = document.createElement('div');
  m.id = 'menu';
  m.innerHTML = '<button data-a="new" data-icon="plus">New tab to the right</button><button data-a="move" data-icon="app-window">Open in new window</button><button data-a="close" data-icon="x">Close tab</button>';
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

// Window keys survive reconnection; explicitly new windows start fresh.
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ tabs: tabs.map(tabUrl), active: tabs.indexOf(active) }));
  } catch { /* storage unavailable */ }
}

async function flushFrame(t) {
  const w=t.frame.contentWindow;
  if (!w?.flushNoteEdits) throw Error('A tab has not finished loading. Retry shortly.');
  w.flushCollectionResearch?.();
  w.preserveChatDraft?.();
  await w.saveWorkspaceFile?.(); await w.flushNoteEdits(); await w.flushPDF?.();
}
const switchOwners = new Set();
window.noctuaShell = {
  beginSwitch(owner = 'connection') {
    switchOwners.add(owner);
    switching = true;
    document.body.inert = true;
    for (const tab of tabs) {
      const w = tab.frame.contentWindow;
      if (w.document?.querySelector('dialog[open]')) throw Error('Close open editor dialogs before switching servers.');
      w.prepareEditorSwitch?.();
      if (w.document?.body) w.document.body.inert = true;
    }
  },
  endSwitch(owner = 'connection') {
    switchOwners.delete(owner);
    if (switchOwners.size) return;
    for (const tab of tabs) {
      const w = tab.frame.contentWindow;
      if (w.document?.body) w.document.body.inert = false;
    }
    document.body.inert = false;
    switching = false;
  },
  async flush() { for (const t of tabs) await flushFrame(t); },
  openTab(url) { return addTab(url, { after: active }); },
  cmd(name) {
    if (switching) return;
    if (name === 'newTab') addTab('/', { after: active });
    else if (name === 'closeTab') active && closeTab(active);
    else if (name === 'nextTab') step(1);
    else if (name === 'prevTab') step(-1);
    else if (name === 'reload') active?.frame.contentWindow.location.reload();
    else if (name === 'settings') {
      const open=active?.frame.contentWindow.openSetup;
      if(open)open({firstRun:false});
      else if(window.noctuaDesktopClient)location.href='https://noctua.invalid/settings?section=local';
    }
  },
};

newBtn.addEventListener('click', () => addTab('/'));
document.addEventListener('keydown', shortcut);
tabsEl.addEventListener('dblclick', (e) => { if (e.target === tabsEl) addTab('/'); });
window.addEventListener('beforeunload', save);
setInterval(save, 5000);  // tab locations change as you browse

{
  let saved = null;
  try { saved = !params.has('fresh') && !params.get('open') ? JSON.parse(localStorage.getItem(STORE) || 'null') : null; } catch { /* ignore */ }
  if (params.get('open')) addTab(params.get('open'));
  else if (saved?.tabs?.length) {
    saved.tabs.forEach((u) => addTab(u, { activate: false }));
    activateTab(tabs[Math.max(0, Math.min(saved.active, tabs.length - 1))]);
  } else addTab('/');
}
