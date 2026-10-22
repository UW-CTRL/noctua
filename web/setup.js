'use strict';
// First-run setup and the Settings dialog: the user's Semantic Scholar API key
// and their Zotero data folder. Also: in the desktop app, web links open in
// the system browser. Uses app.js globals ($, esc, api, toast, loadCollections).

const S2_KEY_URL = 'https://www.semanticscholar.org/product/api#api-key-form';
let settings = null;

const keyNeeded = (s) => !s.key_source && !s.skipped;
const zoteroNeeded = (s) => !s.zotero_source && !s.zotero_disabled;

function keySection(s, firstRun) {
  if (s.key_source === 'env') {
    return `<section data-step="key"><h2>Semantic Scholar API key</h2>
      <p>Set by the <code>NOCTUA_S2_KEY</code> environment variable (${esc(s.key_hint || '')}), which takes precedence.</p></section>`;
  }
  return `<section data-step="key">
    <h2>Semantic Scholar API key</h2>
    <p>Noctua looks papers up on Semantic Scholar, and each user needs their own free API key.
      <a href="${S2_KEY_URL}" target="_blank" rel="noopener">Request one here</a> (approval can take a little while).</p>
    ${s.key_source ? `<p class="setup-current">Current key: <code>${esc(s.key_hint)}</code></p>` : ''}
    <input class="setup-input" id="setup-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your API key">
    <p class="setup-msg"></p>
    <div class="setup-actions">
      <button class="primary" data-act="save-key">${firstRun ? 'Save & continue' : 'Save key'}</button>
      ${firstRun ? '<a href="#" data-act="skip-key">Continue without a key (slow, shared and rate-limited)</a>'
        : s.key_source === 'file' ? '<button data-act="remove-key">Remove key</button>' : ''}
    </div></section>`;
}

function zoteroSection(s, firstRun) {
  if (s.zotero_source === 'env') {
    return `<section data-step="zotero"><h2>Zotero data folder</h2>
      <p>Set by the <code>ZOTERO_DATA_DIR</code> environment variable: <code>${esc(s.zotero_dir)}</code>.</p></section>`;
  }
  const value = s.zotero_dir || s.zotero_suggested || '';
  return `<section data-step="zotero">
    <h2>Zotero data folder</h2>
    <p>Noctua reads your Zotero library and saves papers into it. Choose the folder that contains
      <code>zotero.sqlite</code> (in Zotero: Settings → Advanced → Files and Folders → Data Directory Location).
      ${s.zotero_suggested && !s.zotero_dir ? 'Found one in the usual place:' : ''}</p>
    ${s.zotero_disabled ? '<p class="setup-current">Zotero is turned off.</p>' : ''}
    <div class="setup-row">
      <input class="setup-input" id="setup-zotero" spellcheck="false" placeholder="e.g. ~/Zotero" value="${esc(value)}">
      ${s.desktop ? '<button data-act="browse">Browse…</button>' : ''}
    </div>
    <p class="setup-msg"></p>
    <div class="setup-actions">
      <button class="primary" data-act="save-zotero">${firstRun ? 'Use this folder' : 'Save folder'}</button>
      <a href="#" data-act="no-zotero">I don't use Zotero</a>
    </div></section>`;
}

// First run: one step at a time, blocking the app. Settings: both, closable.
function openSetup({ firstRun }) {
  $('#setup')?.remove();
  const el = document.createElement('div');
  el.id = 'setup';
  el.innerHTML = `<div class="setup-card"></div>`;
  document.body.appendChild(el);
  const card = el.querySelector('.setup-card');
  const steps = firstRun ? [keyNeeded(settings) && 'key', zoteroNeeded(settings) && 'zotero'].filter(Boolean) : ['key', 'zotero'];
  const render = () => {
    const parts = firstRun ? [steps[0]] : steps;
    card.innerHTML = (firstRun ? '<div class="setup-brand">🦉 Welcome to Noctua</div>' : '<div class="setup-brand">Settings</div>')
      + parts.map((p) => p === 'key' ? keySection(settings, firstRun) : zoteroSection(settings, firstRun)).join('')
      + (firstRun ? '' : `<p class="setup-foot">Your data folder: <code>${esc(settings.data_dir)}</code></p><div class="setup-actions end"><button data-act="close">Done</button></div>`);
    card.querySelector('.setup-input')?.focus();
  };
  const next = async () => {
    await loadSettings();
    if (firstRun) {
      steps.shift();
      if (!steps.length) { el.remove(); afterSetup(); return; }
    }
    render();
    if (!firstRun) afterSetup();
  };
  const msg = (section, text, ok) => {
    const m = section.querySelector('.setup-msg');
    m.textContent = text;
    m.classList.toggle('ok', !!ok);
  };
  card.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    e.preventDefault();
    const section = t.closest('section');
    const busy = (on) => card.querySelectorAll('button').forEach((b) => { b.disabled = on; });
    try {
      busy(true);
      switch (t.dataset.act) {
        case 'save-key': {
          const key = $('#setup-key').value.trim();
          if (!key) { msg(section, 'Paste your API key first.'); break; }
          msg(section, 'Checking the key with Semantic Scholar…', true);
          await api('/api/settings/key', { key });
          toast('Semantic Scholar key saved.');
          await next();
          break;
        }
        case 'skip-key': await api('/api/settings/skip', {}); await next(); break;
        case 'remove-key':
          if (!confirm('Remove your Semantic Scholar key from this computer?')) break;
          await fetch('/api/settings/key', { method: 'DELETE' });
          await next();
          break;
        case 'browse': {
          const { path } = await api('/api/desktop/pick-folder', {});
          if (path) $('#setup-zotero').value = path;
          break;
        }
        case 'save-zotero': {
          const dir = $('#setup-zotero').value.trim();
          if (!dir) { msg(section, 'Enter the folder, or choose “I don’t use Zotero”.'); break; }
          await api('/api/settings/zotero', { dir });
          toast('Zotero folder saved.');
          await next();
          break;
        }
        case 'no-zotero': await api('/api/settings/zotero', { dir: null }); await next(); break;
        case 'close': el.remove(); break;
      }
    } catch (err) {
      if (section) msg(section, err.message);
      else toast(err.message, { error: true });
    } finally {
      busy(false);
    }
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.setup-input')) e.target.closest('section').querySelector('button.primary')?.click();
    if (e.key === 'Escape' && !firstRun) el.remove();
  });
  render();
}

function afterSetup() {
  renderKeyBanner();
  loadCollections();
}

// Reminder while running without a key.
function renderKeyBanner() {
  $('#s2-banner')?.remove();
  if (settings.key_source || !settings.skipped || sessionStorage.getItem('noctua.bannerClosed')) return;
  const b = document.createElement('div');
  b.id = 's2-banner';
  b.innerHTML = 'Using Semantic Scholar’s shared pool, which is slow and often rate-limited. <a href="#" class="open-settings">Add your API key</a><button class="icon" title="Hide for now">✕</button>';
  b.querySelector('button').addEventListener('click', () => {
    try { sessionStorage.setItem('noctua.bannerClosed', '1'); } catch { /* storage unavailable */ }
    b.remove();
  });
  $('header').after(b);
}

async function loadSettings() {
  settings = await api('/api/settings');
  return settings;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.open-settings, #open-settings')) {
    e.preventDefault();
    openSetup({ firstRun: false });
    return;
  }
  // Desktop app: web links open in the system browser, not inside the app.
  const a = e.target.closest('a[href]');
  if (settings?.desktop && a && /^(https?:|mailto:)/i.test(a.getAttribute('href'))) {
    e.preventDefault();
    api('/api/desktop/open', { url: a.href }).catch((err) => toast(err.message, { error: true }));
  }
});

loadSettings().then((s) => {
  if (keyNeeded(s) || zoteroNeeded(s)) openSetup({ firstRun: true });
  else renderKeyBanner();
}).catch((e) => toast(e.message, { error: true }));
