'use strict';
// First-run setup and the Settings dialog: the user's Semantic Scholar API key
// and their Zotero data folder. Also: in the desktop app, web links open in
// the system browser. Uses app.js globals ($, esc, api, toast, loadCollections).

const S2_KEY_URL = 'https://www.semanticscholar.org/product/api#api-key-form';
let settings = null;

const keyNeeded = (s) => !s.key_source && !s.skipped;
const zoteroNeeded = () => false;

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
    return `<section data-step="zotero"><h2>Import from Zotero (optional)</h2>
      <p>Set by the <code>ZOTERO_DATA_DIR</code> environment variable: <code>${esc(s.zotero_dir)}</code>.</p></section>`;
  }
  const value = s.zotero_dir || s.zotero_suggested || '';
  return `<section data-step="zotero">
    <h2>Import from Zotero (optional)</h2>
    <p>Noctua stores papers independently. To copy an existing Zotero library, configure its source here, then use Library → Import from Zotero. Choose the folder that contains
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

function agentSection(s) {
  const provider = chat.provider;
  return `<section data-step="agent"><h2>Research assistant</h2>
    <p>Use the same assistant for chat and drawing-to-LaTeX. Each assistant keeps its own conversations, so switching brings back its last chat.</p>
    <div class="setup-row"><select id="setup-agent" aria-label="Research assistant">
      <option value="claude" ${provider === 'claude' ? 'selected' : ''}>Claude Code</option>
      <option value="codex" ${provider === 'codex' ? 'selected' : ''}>Codex</option>
    </select><span id="agent-status" role="status">Checking sign-in…</span></div>
    <p>Sign in with your existing account in your browser. Already signed in through the CLI? Noctua uses that login automatically.</p>
    <p class="setup-msg"></p>
    <div class="setup-actions"><button data-act="agent-login">Sign in</button>
      <button data-act="agent-check">Check connection</button><button data-act="agent-cancel" class="hidden">Cancel sign-in</button></div>
    <div id="agent-login-output" class="agent-login-output" aria-live="polite"></div>
    <p class="hint">Install <a href="https://developers.openai.com/codex/cli" target="_blank" rel="noopener">Codex CLI</a> or
      <a href="https://code.claude.com/docs/en/overview" target="_blank" rel="noopener">Claude Code</a> if needed.</p>
    </section>`;
}

// First run: one step at a time, blocking the app. Settings: both, closable.
function openSetup({ firstRun }) {
  $('#setup')?.noctuaClose?.();
  $('#setup')?.remove();
  const el = document.createElement('div');
  el.id = 'setup';
  el.innerHTML = `<div class="setup-card"></div>`;
  document.body.appendChild(el);
  const card = el.querySelector('.setup-card');
  let loginAbort = null;
  const close = () => { loginAbort?.abort(); el.remove(); };
  el.noctuaClose = close;
  const checkAgent = async () => {
    const provider = $('#setup-agent')?.value;
    if (!provider) return;
    const status = await api('/api/agents/' + provider);
    if (!el.isConnected || $('#setup-agent')?.value !== provider) return;
    $('#agent-status').textContent = status.signed_in ? 'Signed in' : status.installed ? 'Not signed in' : 'CLI not found';
    const m = card.querySelector('[data-step="agent"] .setup-msg');
    m.textContent = status.message || '';
    refreshAgentBadge();
  };
  const signIn = async () => {
    if (loginAbort) return;
    const provider = $('#setup-agent').value;
    const ctrl = new AbortController(); loginAbort = ctrl;
    const output = $('#agent-login-output');
    output.textContent = 'Opening your browser to sign in…\n';
    $('#agent-status').textContent = 'Signing in…';
    card.querySelector('[data-act="agent-login"]').disabled = true;
    card.querySelector('[data-act="agent-cancel"]').classList.remove('hidden');
    let text = '', completed = false;
    try {
      const r = await fetch(`/api/agents/${provider}/login`, { method: 'POST', signal: ctrl.signal });
      if (!r.ok) throw new Error('Could not start sign-in.');
      await readEvents(r, (e) => {
        if (e.type === 'error') throw new Error(e.message);
        if (e.type === 'done') { completed = true; return; }
        if (e.type !== 'text') return;
        text += e.text;
        // Strip terminal colour codes, escape all text, and make the CLI's
        // browser login URL available if automatic browser opening fails.
        const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        output.innerHTML = clean.split(/(https?:\/\/[^\s<>"']+)/g).map((part, i) => i % 2
          ? `<a href="${esc(part)}" target="_blank" rel="noopener">${esc(part)}</a>` : esc(part)).join('');
      });
      if (!completed) throw new Error('Sign-in ended before completing. Please try again.');
      output.textContent = `${agentLabel(provider)} sign-in completed.`;
    } catch (e) {
      output.textContent = e.name === 'AbortError' ? 'Sign-in cancelled.' : e.message;
    } finally {
      ctrl.abort();
      loginAbort = null;
      if (el.isConnected) {
        card.querySelector('[data-act="agent-login"]').disabled = false;
        card.querySelector('[data-act="agent-cancel"]').classList.add('hidden');
        checkAgent().catch((e) => { output.textContent += '\n' + e.message; });
      }
    }
  };
  const steps = firstRun ? [keyNeeded(settings) && 'key', zoteroNeeded(settings) && 'zotero'].filter(Boolean) : ['agent', 'key', 'zotero'];
  const render = () => {
    const parts = firstRun ? [steps[0]] : steps;
    card.innerHTML = (firstRun ? '<div class="setup-brand">🦉 Welcome to Noctua</div>' : '<div class="setup-brand">Settings</div>')
      + parts.map((p) => p === 'agent' ? agentSection(settings) : p === 'key' ? keySection(settings, firstRun) : zoteroSection(settings, firstRun)).join('')
      + (firstRun ? '' : `<p class="setup-foot">Your data folder: <code>${esc(settings.data_dir)}</code></p><div class="setup-actions end"><button data-act="close">Done</button></div>`);
    card.querySelector('.setup-input')?.focus();
    checkAgent().catch((err) => toast(err.message, { error: true }));
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
        case 'agent-login': signIn(); break;
        case 'agent-check': await checkAgent(); break;
        case 'agent-cancel': loginAbort?.abort(); break;
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
        case 'close': close(); break;
      }
    } catch (err) {
      if (section) msg(section, err.message);
      else toast(err.message, { error: true });
    } finally {
      busy(false);
      if (loginAbort) card.querySelector('[data-act="agent-login"]').disabled = true;
    }
  });
  card.addEventListener('change', async (e) => {
    if (e.target.id !== 'setup-agent') return;
    loginAbort?.abort();
    e.target.disabled = true;
    try { await activateAgent(e.target.value); await checkAgent(); }
    catch (err) { toast(err.message, { error: true }); e.target.value = chat.provider; }
    finally { e.target.disabled = false; }
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.setup-input')) e.target.closest('section').querySelector('button.primary')?.click();
    if (e.key === 'Escape' && !firstRun) close();
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

loadSettings().then(async (s) => {
  await activateAgent(s.agent || 'claude', { persist: false });
  if (keyNeeded(s) || zoteroNeeded(s)) openSetup({ firstRun: true });
  else renderKeyBanner();
}).catch((e) => toast(e.message, { error: true }));
