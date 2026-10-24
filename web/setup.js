'use strict';
// First-run setup and tabbed Settings. Uses app.js and notes.js globals.

const S2_KEY_URL = 'https://www.semanticscholar.org/product/api#api-key-form';
let settings = null;

const keyNeeded = (s) => !s.key_source && !s.skipped;

function keySection(s, firstRun) {
  const intro = '<h2>Semantic Scholar API key</h2><p>An optional API key for paper searches and citation lookups.</p>';
  if (s.key_source === 'env') {
    return `<section data-step="key">${intro}
      <p class="setup-current"><code>${esc(s.key_hint || '')}</code> · <code>NOCTUA_S2_KEY</code></p></section>`;
  }
  if (s.key_source === 'file') {
    return `<section data-step="key">${intro}
      <div class="setup-key-row"><p class="setup-current">Current key: <code>${esc(s.key_hint || '')}</code></p>
        <button data-act="remove-key" data-icon="key-round">Remove key</button></div>
      <p class="setup-msg" role="status"></p></section>`;
  }
  return `<section data-step="key">
    ${intro}
    <input class="setup-input" id="setup-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your API key">
    <p class="setup-msg"></p>
    <div class="setup-actions">
      <button class="primary" data-act="save-key" data-icon="${firstRun ? 'arrow-right' : 'save'}">${firstRun ? 'Save & continue' : 'Save key'}</button>
      <a href="${S2_KEY_URL}" target="_blank" rel="noopener">Request API key</a>
      ${firstRun ? '<a href="#" data-act="skip-key">Continue without a key (slow, shared and rate-limited)</a>' : ''}
    </div></section>`;
}

function zoteroSection(s, firstRun) {
  const intro = '<h2>Import from Zotero</h2><p>Import collections, papers, and available PDFs from your Zotero library.</p>';
  const importAction = firstRun ? '' : '<button type="button" id="import-zotero" data-act="import-zotero" data-icon="import">Import from Zotero</button>';
  if (s.zotero_source === 'env') {
    return `<section data-step="zotero">${intro}
      <code class="settings-path">${esc(s.zotero_dir)}</code><p><code>ZOTERO_DATA_DIR</code></p>
      <p class="setup-msg" role="status"></p><div class="setup-actions">${importAction}</div></section>`;
  }
  const value = s.zotero_dir || s.zotero_suggested || '';
  return `<section data-step="zotero">
    ${intro}
    ${s.zotero_disabled ? '<p class="setup-current">Zotero is turned off.</p>' : ''}
    <div class="setup-row">
      <input class="setup-input" id="setup-zotero" spellcheck="false" placeholder="e.g. ~/Zotero" value="${esc(value)}">
      ${s.desktop ? '<button data-act="browse" data-icon="folder-open">Browse…</button>' : ''}
    </div>
    <p class="setup-msg"></p>
    <div class="setup-actions">
      <button class="primary" data-act="save-zotero" data-icon="${firstRun ? 'folder-open' : 'save'}">${firstRun ? 'Use this folder' : 'Save folder'}</button>
      ${importAction}
      <a href="#" data-act="no-zotero">I don't use Zotero</a>
    </div></section>`;
}

const ASSISTANT_MODELS = {
  claude: [],
  codex: [],
};
const modelCatalogs = { claude: null, codex: null };

function assistantEfforts(provider, model) {
  const entry = modelCatalogs[provider]?.find((m) => model ? m.id === model : m.is_default);
  if (entry) return entry.reasoning_efforts;
  if (provider === 'codex') {
    return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  }
  return ['low', 'medium', 'high', 'xhigh', 'max'];
}

function reasoningOptions(provider, model, value) {
  const efforts = assistantEfforts(provider, model);
  const label = (id) => ({xhigh: 'Extra high'})[id] || id[0].toUpperCase() + id.slice(1);
  return '<option value="">Provider default</option>' +
    (value && !efforts.includes(value) ? `<option value="${esc(value)}" selected disabled>${esc(label(value))} (saved)</option>` : '') +
    efforts.map((id) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(label(id))}</option>`).join('');
}

function modelOptions(provider, model) {
  const models = ASSISTANT_MODELS[provider];
  const custom = !!model && !models.some(([id]) => id === model);
  return `<option value="">${modelCatalogs[provider] === null ? 'Loading models…' : 'Provider default'}</option>` +
    models.map(([id, label]) => `<option value="${esc(id)}" ${model === id ? 'selected' : ''}>${esc(label)}</option>`).join('') +
    `<option value="custom" ${custom ? 'selected' : ''}>Custom model…</option>`;
}

// Claude fast mode is limited to Opus; custom IDs are checked by the CLI.
function assistantFastAllowed(provider, model) {
  const entry = modelCatalogs[provider]?.find((m) => model ? m.id === model : m.is_default);
  if (typeof entry?.supports_fast === 'boolean') return entry.supports_fast;
  return provider !== 'claude' || !['sonnet', 'haiku'].includes(model);
}

function updateFastMode(provider, model, busy = false) {
  const allowed = assistantFastAllowed(provider, model);
  $('#setup-fast-field').hidden = !allowed;
  $('#setup-fast').disabled = busy || !allowed;
  if (!allowed) $('#setup-fast').checked = false;
}

function assistantOptions(s, provider) {
  const o = s.assistant?.[provider] || { model: '', reasoning: '', fast: false };
  const models = ASSISTANT_MODELS[provider];
  const custom = !!o.model && !models.some(([id]) => id === o.model);
  return `<label class="setting-field" for="setup-model"><span>Model</span>
    <select id="setup-model" ${modelCatalogs[provider] === null ? 'disabled' : ''}>${modelOptions(provider, o.model)}</select></label>
    <label class="setting-field" id="setup-custom-model-field" for="setup-custom-model" ${custom ? '' : 'hidden'}><span>Model ID</span>
      <input id="setup-custom-model" class="setup-input" maxlength="200" spellcheck="false" placeholder="Enter model ID" value="${esc(custom ? o.model : '')}"></label>
    <label class="setting-field" for="setup-reasoning"><span>Reasoning effort</span>
      <select id="setup-reasoning">${reasoningOptions(provider, o.model, o.reasoning)}</select></label>
    <label class="setting-field" id="setup-fast-field" for="setup-fast" ${assistantFastAllowed(provider, o.model) ? '' : 'hidden'}><span>Fast mode</span>
      <input id="setup-fast" type="checkbox" ${o.fast && assistantFastAllowed(provider, o.model) ? 'checked' : ''} ${assistantFastAllowed(provider, o.model) ? '' : 'disabled'}></label>`;
}

function agentSection(s) {
  const provider = chat.provider;
  return `<section data-step="agent"><h2>Research assistant</h2>
    <div class="settings-group" role="group" aria-labelledby="settings-provider-title">
    <div class="setting-field"><h3 id="settings-provider-title">Provider</h3>
    <select id="setup-agent" aria-labelledby="settings-provider-title" ${chat.switching ? 'disabled' : ''}>
      <option value="claude" ${provider === 'claude' ? 'selected' : ''}>Claude Code</option>
      <option value="codex" ${provider === 'codex' ? 'selected' : ''}>Codex</option>
    </select></div></div>
    <div class="settings-group" role="group" aria-labelledby="settings-model-title"><h3 id="settings-model-title">Model settings</h3>
    <div id="assistant-options">${assistantOptions(s, provider)}</div>
    </div>
    <div class="settings-group" role="group" aria-labelledby="settings-connection-title"><h3 id="settings-connection-title">Connection</h3>
    <div class="agent-connection-row">
    <p id="agent-status" class="setup-current" role="status">Checking sign-in…</p>
    <div class="setup-actions"><button data-act="agent-login" data-icon="log-in">Sign in</button>
      <button data-act="agent-check" data-icon="refresh-cw">Check connection</button><button data-act="agent-cancel" class="hidden" data-icon="x">Cancel sign-in</button></div>
    </div>
    <p class="setup-msg"></p>
    <div id="agent-login-output" class="agent-login-output" aria-live="polite"></div>
    </div>
    </section>`;
}

const SETTINGS_TABS = [
  ['appearance', 'Appearance'], ['agent', 'Research assistant'],
  ['connections', 'Connections'], ['data', 'Data & storage'], ['about', 'About & shortcuts'],
];

function fontSetting(kind, label) {
  const preference = NoctuaFonts.get(kind);
  const choices = NoctuaFonts.choices(kind).map(option => `<option value="${option.id}" ${option.id === preference.id ? 'selected' : ''}>${esc(option.label)}</option>`).join('');
  const size = `<select id="setup-${kind}-font-size" aria-label="${label} size">${NoctuaFonts.sizeChoices(kind).map(value => `<option value="${value}" ${value === NoctuaFonts.getSize(kind) ? 'selected' : ''}>${value}px</option>`).join('')}</select>`;
  return `<div class="setting-field"><label for="setup-${kind}-font">${label}</label><div class="font-setting-controls"><select id="setup-${kind}-font">${choices}</select>${size}</div></div>
    <label class="setting-field" id="setup-${kind}-font-name-field" for="setup-${kind}-font-name" ${preference.id === 'custom' ? '' : 'hidden'}><span>Font name</span><input class="setup-input" id="setup-${kind}-font-name" value="${esc(preference.name)}" placeholder="e.g. Pretendard" autocomplete="off" spellcheck="false"></label>
    <p class="font-preview font-preview-${kind}"><span title="The quick brown fox jumps over the lazy dog. 0123456789">The quick brown fox jumps over the lazy dog. 0123456789</span></p>`;
}
function syncFontSetting(kind) {
  const select = $(`#setup-${kind}-font`); if (!select) return;
  const preference = NoctuaFonts.get(kind); select.value = preference.id;
  $(`#setup-${kind}-font-name-field`).hidden = preference.id !== 'custom';
  $(`#setup-${kind}-font-name`).value = preference.name;
}
document.addEventListener('noctua-font-change', event => syncFontSetting(event.detail.kind));
document.addEventListener('noctua-font-size-change', event => {
  const kind = event.detail.kind, select = $(`#setup-${kind}-font-size`);
  if (select) select.value = String(NoctuaFonts.getSize(kind));
});

function highlightColorOptions(selected,category){
  return pdfColors.map((color,index)=>`<button type="button" data-highlight-color="${category}" value="${color}" style="--swatch:${color}" aria-label="${pdfCategories[category].label}: color ${index+1}" aria-pressed="${color===selected}"></button>`).join('');
}
function highlightColorSettings(){
  return `<div class="settings-group highlight-settings" role="group" aria-labelledby="settings-highlight-colors-title"><h3 id="settings-highlight-colors-title">Highlight colors</h3><div class="settings-highlight-rows">
    <div class="settings-highlight-palette" role="group" aria-label="Reader highlight palette">${pdfColors.map((color,index)=>`<input type="color" id="setup-palette-${index}" data-highlight-palette="${index}" value="${color}" aria-label="Highlight color ${index+1}">`).join('')}</div>
    <div class="settings-ai-highlights" role="group" aria-label="AI highlight colors">${Object.entries(pdfCategories).map(([key,category])=>`<div class="settings-ai-highlight"><span id="setup-highlight-label-${key}">${category.label}</span><details class="settings-ai-color-picker"><summary data-category-swatch="${key}" style="--swatch:${category.color}" aria-label="Choose ${category.label} highlight color" title="Choose ${category.label} highlight color"></summary><div class="settings-ai-color-options" id="setup-highlight-${key}" role="group" aria-labelledby="setup-highlight-label-${key}">${highlightColorOptions(category.color,key)}</div></details></div>`).join('')}</div>
  </div></div>`;
}
function syncHighlightColorSettings(){
  pdfColors.forEach((color,index)=>{
    const input=$(`#setup-palette-${index}`);if(input)input.value=color;
  });
  for(const [key,category] of Object.entries(pdfCategories)){
    const input=$(`#setup-highlight-${key}`);if(input){input.innerHTML=highlightColorOptions(category.color,key);input.value=category.color;}
    document.querySelector(`[data-category-swatch="${key}"]`)?.style.setProperty('--swatch',category.color);
  }
}
async function saveHighlightColors(patch){
  const result=await api('/api/settings/highlight-colors',patch);
  settings.highlight_colors=result.highlight_colors;settings.highlight_palette=result.highlight_palette;
  applyPDFHighlightColors(result.highlight_colors,result.highlight_palette);syncHighlightColorSettings();
  if(PDF.key&&typeof refreshPDFAnnotations==='function')await refreshPDFAnnotations();
}
async function saveHighlightPalette(colors){
  const result=await api('/api/settings/highlight-palette',{colors});
  settings.highlight_palette=result.highlight_palette;settings.highlight_colors=result.highlight_colors;
  applyPDFHighlightColors(result.highlight_colors,result.highlight_palette);syncHighlightColorSettings();
  if(PDF.key&&typeof refreshPDFAnnotations==='function')await refreshPDFAnnotations();
}
function appearanceSection() {
  const options = (value) => ['system', 'light', 'dark'].map((v) =>
    `<option value="${v}" ${v === value ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
  return `<section data-step="appearance"><h2>Appearance</h2>
    <div class="settings-group" role="group" aria-labelledby="settings-theme-title"><h3 id="settings-theme-title">Theme</h3>
    <label class="setting-field" for="setup-app-theme"><span>App theme</span>
      <select id="setup-app-theme">${options(document.documentElement.dataset.theme || 'system')}</select></label>
    <label class="setting-field" for="setup-notes-theme"><span>Notes theme</span>
      <select id="setup-notes-theme">${options($('#notes-stage').dataset.notesTheme || 'dark')}</select></label>
    <label class="setting-field" for="setup-reader-theme"><span>Reader theme</span>
      <select id="setup-reader-theme">${options(PDF.theme || 'dark')}</select></label>
    </div>
    ${highlightColorSettings()}
    <div class="settings-group" role="group" aria-labelledby="settings-fonts-title"><h3 id="settings-fonts-title">Fonts</h3>
      ${fontSetting('ui', 'System font')}
      ${fontSetting('note', 'Note font')}
      ${fontSetting('chat', 'Chat font')}
    </div>
    <p class="setup-msg ok" role="status"></p></section>`;
}

function dataSection(s) {
  const temporary = /^(\/private)?\/(tmp|var\/folders)\//.test(s.data_dir);
  return `<section data-step="data"><h2>Data & storage</h2>
    <p>Choose where Noctua saves your papers, notes, and chats. Location changes apply after restarting.</p>
    ${s.storage_override || s.storage_pending ? `<p>Current folder:</p><code class="settings-path">${esc(s.data_dir)}</code>` : ''}
    ${temporary ? '<p class="settings-warning">This session uses temporary storage. The system may remove these files.</p>' : ''}
    ${s.storage_override ? '<p class="setup-current">Environment override: <code>NOCTUA_HOME</code> / <code>NOCTUA_NOTES</code></p>' : `
    <label for="setup-storage">Storage location</label>
    <div class="setup-row"><input class="setup-input" id="setup-storage" spellcheck="false" placeholder="Enter an absolute folder path" value="${esc(s.storage_pending || s.data_dir)}">
      ${s.desktop ? '<button data-act="browse-storage" data-icon="folder-open">Browse…</button>' : ''}</div>
    ${s.storage_pending ? '<p class="setup-current">The saved location takes effect after restart.</p>' : ''}
    ${s.storage_error ? `<p class="settings-warning">${esc(s.storage_error)}</p>` : ''}
    <div class="setup-actions"><button class="primary" data-act="save-storage" data-icon="save">Save location</button>
      ${s.storage_pending ? '<button data-act="cancel-storage" data-icon="x">Cancel change</button>' : ''}</div>`}
    <p class="setup-msg ok" role="status"></p></section>`;
}

function aboutSection(s) {
  return `<section data-step="about"><h2>About Noctua</h2>
    <p>Version ${esc(s.version || 'unknown')} · ${s.desktop ? 'Desktop app' : 'Browser app'}</p>
    <h3>Keyboard shortcuts</h3><dl class="settings-shortcuts">
      <dt>Save note</dt><dd>⌘ / Ctrl + S</dd>
      <dt>Add drawing</dt><dd>⌘ / Ctrl + Shift + D</dd>
      <dt>Finish editing a text block</dt><dd>Esc or ⌘ / Ctrl + Enter</dd>
      <dt>Change chat editing mode</dt><dd>Shift + Tab in chat</dd>
      <dt>Close Settings</dt><dd>Esc</dd></dl>
    </section>`;
}

// First run stays short and skippable. Settings keeps every panel mounted so
// switching tabs preserves unsaved fields and any sign-in in progress.
function openSetup({ firstRun = false, tab } = {}) {
  $('#setup')?.noctuaClose?.();
  const previousFocus = document.activeElement;
  const el = document.createElement('div');
  el.id = 'setup';
  el.innerHTML = `<div class="setup-card ${firstRun ? '' : 'settings-card'}" role="dialog" aria-modal="true" aria-labelledby="settings-title"></div>`;
  document.body.appendChild(el);
  const card = el.querySelector('.setup-card');
  let loginAbort = null;
  let assistantSaving = false;
  const close = () => {
    loginAbort?.abort(); el.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  el.noctuaClose = close;
  let agentCheck = 0;
  const checkAgent = async () => {
    const provider = $('#setup-agent')?.value;
    if (!provider || loginAbort) return;
    const request = ++agentCheck;
    const [status, catalog] = await Promise.all([
      api('/api/agents/' + provider),
      api('/api/agents/' + provider + '/models').catch((error) => ({ error })),
    ]);
    if (!el.isConnected || $('#setup-agent')?.value !== provider || loginAbort || request !== agentCheck) return;
    $('#agent-status').textContent = status.signed_in ? 'Signed in' : status.installed ? 'Not signed in' : 'CLI not found';
    card.querySelector('[data-step="agent"] .setup-msg').textContent = status.message || '';
    if (catalog) {
      // Preserve edits made while discovery was in flight, including custom model drafts.
      const selected = $('#setup-model').value;
      const model = selected === 'custom' ? $('#setup-custom-model').value : selected;
      const effort = $('#setup-reasoning').value;
      if (!catalog.error) {
        modelCatalogs[provider] = catalog.models;
        ASSISTANT_MODELS[provider] = catalog.models.map((m) => [m.id, m.label || m.id]);
      } else if (modelCatalogs[provider] === null) {
        modelCatalogs[provider] = [];
      }
      const custom = selected === 'custom' && !model || !!model && !ASSISTANT_MODELS[provider].some(([id]) => id === model);
      $('#setup-model').innerHTML = modelOptions(provider, model);
      $('#setup-model').value = custom ? 'custom' : model;
      $('#setup-model').disabled = assistantSaving;
      $('#setup-custom-model-field').hidden = !custom;
      $('#setup-reasoning').innerHTML = reasoningOptions(provider, model, effort);
      $('#setup-reasoning').value = effort;
      updateFastMode(provider, model, assistantSaving);
      const label = provider === 'claude' ? 'Claude' : 'Codex';
      if (catalog.error) msg(card.querySelector('[data-step="agent"]'), `Could not load ${label} models: ` + catalog.error.message);
      else if (!catalog.models.length) msg(card.querySelector('[data-step="agent"]'), `${label} returned no models. Check your sign-in.`);
    }
  };
  const signIn = async () => {
    if (loginAbort) return;
    const provider = $('#setup-agent').value;
    const ctrl = new AbortController(); loginAbort = ctrl;
    const output = $('#agent-login-output');
    output.textContent = 'Opening your browser to sign in…\n';
    $('#agent-status').textContent = 'Signing in…';
    $('#setup-agent').disabled = true;
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
        $('#setup-agent').disabled = chat.switching;
        card.querySelector('[data-act="agent-login"]').disabled = false;
        card.querySelector('[data-act="agent-cancel"]').classList.add('hidden');
        checkAgent().catch((e) => { output.textContent += '\n' + e.message; });
      }
    }
  };
  const selectTab = (id, focus = false) => {
    if (!SETTINGS_TABS.some(([key]) => key === id)) id = 'appearance';
    for (const button of card.querySelectorAll('[data-settings-tab]')) {
      const active = button.dataset.settingsTab === id;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    for (const panel of card.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== id;
    store.set('noctua.settingsTab', id);
  };
  const render = () => {
    if (firstRun) {
      card.innerHTML = '<h1 id="settings-title" class="setup-brand">🦉 Welcome to Noctua</h1>' + keySection(settings, true);
      card.querySelector('.setup-input')?.focus();
      return;
    }
    const panels = { appearance: appearanceSection(), agent: agentSection(settings),
      connections: keySection(settings, false) + zoteroSection(settings, false), data: dataSection(settings), about: aboutSection(settings) };
    card.innerHTML = `<div class="settings-header"><h1 id="settings-title">Settings</h1><button data-act="close" aria-label="Close Settings" data-icon="x" title="Close Settings" data-icon-only>✕</button></div>
      <div class="settings-body"><nav class="settings-nav" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
        ${SETTINGS_TABS.map(([id, label]) => `<button id="settings-tab-${id}" role="tab" data-icon="${{appearance:'palette',agent:'bot',connections:'plug',data:'database',about:'info'}[id]}" aria-controls="settings-panel-${id}" data-settings-tab="${id}">${label}</button>`).join('')}
      </nav><div class="settings-content">${SETTINGS_TABS.map(([id]) => `<div id="settings-panel-${id}" data-settings-panel="${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" tabindex="0" hidden>${panels[id]}</div>`).join('')}</div></div>`;
    selectTab(tab || store.get('noctua.settingsTab'), true);
    checkAgent().catch((err) => toast(err.message, { error: true }));
  };
  const next = async (step) => {
    await loadSettings();
    if (!el.isConnected) return;
    if (firstRun) { close(); afterSetup(); return; }
    // Refresh only the saved section; drafts in other panels stay intact.
    const section = card.querySelector(`[data-step="${step}"]`);
    if (section) {
      const hadFocus = section.contains(document.activeElement);
      section.outerHTML = step === 'key' ? keySection(settings, false) : zoteroSection(settings, false);
      if (hadFocus) card.querySelector(`[data-step="${step}"] input, [data-step="${step}"] button`)?.focus();
    }
    afterSetup();
  };
  const msg = (section, text, ok) => {
    const m = section.querySelector('.setup-msg');
    m.textContent = text; m.classList.toggle('ok', !!ok);
  };
  card.addEventListener('click', async (e) => {
    card.querySelectorAll('.settings-ai-color-picker[open]').forEach(picker=>{if(!picker.contains(e.target))picker.open=false;});
    const colorChoice=e.target.closest('[data-highlight-color]');
    if(colorChoice){
      e.preventDefault();const picker=colorChoice.closest('details');picker.open=false;picker.querySelector('summary').focus();
      colorChoice.dispatchEvent(new Event('change',{bubbles:true}));return;
    }
    const nav = e.target.closest('[data-settings-tab]');
    if (nav) { selectTab(nav.dataset.settingsTab); return; }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    e.preventDefault();
    const section = t.closest('section');
    // Keep navigation and Close available during network requests.
    const busy = (on) => section?.querySelectorAll('button, input').forEach((b) => { b.disabled = on; });
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
          toast('Semantic Scholar key saved.'); await next('key'); break;
        }
        case 'skip-key': await api('/api/settings/skip', {}); await next('key'); break;
        case 'remove-key':
          if (!confirm('Remove your Semantic Scholar key from this computer?')) break;
          { const r = await fetch('/api/settings/key', { method: 'DELETE' }); if (!r.ok) throw new Error('Could not remove the key.'); }
          await next('key'); break;
        case 'browse': {
          const { path } = await api('/api/desktop/pick-folder', {});
          if (path && el.isConnected) $('#setup-zotero').value = path;
          break;
        }
        case 'browse-storage': {
          const { path } = await api('/api/desktop/pick-folder', {});
          if (path && el.isConnected) $('#setup-storage').value = path;
          break;
        }
        case 'save-storage':
        case 'cancel-storage': {
          const cancel = t.dataset.act === 'cancel-storage';
          const dir = cancel ? null : $('#setup-storage').value.trim();
          if (!cancel && !dir) { msg(section, 'Enter a folder path.'); break; }
          await api('/api/settings/storage', { dir });
          await loadSettings();
          if (el.isConnected) {
            section.outerHTML = dataSection(settings);
            const updated = card.querySelector('[data-step="data"]');
            msg(updated, settings.storage_pending ? 'Location saved. Quit all Noctua apps and servers, then start Noctua again to copy your data.' : 'Current storage location kept.', true);
            updated.querySelector('[data-act="save-storage"]')?.focus();
          }
          break;
        }
        case 'import-zotero':
          msg(section, 'Importing Zotero collections and available PDFs…', true);
          await importZoteroLibrary();
          msg(section, 'Import complete.', true);
          break;
        case 'save-zotero': {
          const dir = $('#setup-zotero').value.trim();
          if (!dir) { msg(section, 'Enter the folder, or choose “I don’t use Zotero”.'); break; }
          await api('/api/settings/zotero', { dir });
          toast('Zotero folder saved.'); await next('zotero'); break;
        }
        case 'no-zotero': await api('/api/settings/zotero', { dir: null }); await next('zotero'); break;
        case 'close': close(); break;
      }
    } catch (err) {
      if (section) msg(section, err.message); else toast(err.message, { error: true });
    } finally {
      busy(false);
      if (loginAbort && el.isConnected) card.querySelector('[data-act="agent-login"]').disabled = true;
    }
  });
  card.addEventListener('change', async (e) => {
    const category=e.target.dataset?.highlightColor,paletteIndex=e.target.dataset?.highlightPalette;
    if(category||paletteIndex!==undefined){
      const section=e.target.closest('section'),group=e.target.closest('section'),controls=[...group.querySelectorAll('[data-highlight-color],[data-highlight-palette]')];
      controls.forEach(control=>control.disabled=true);
      try{if(category)await saveHighlightColors({[category]:e.target.value});else {const colors=[...pdfColors];colors[Number(paletteIndex)]=e.target.value;await saveHighlightPalette(colors);}msg(section,'',true);}
      catch(error){syncHighlightColorSettings();msg(section,error.message);}
      finally{controls.forEach(control=>control.disabled=false);}
      return;
    }
    const fontSize = e.target.id.match(/^setup-(ui|note|chat)-font-size$/);
    if (fontSize) {
      NoctuaFonts.setSize(fontSize[1], e.target.value); msg(e.target.closest('section'), 'Saved.', true); return;
    }
    const font = e.target.id.match(/^setup-(ui|note|chat)-font(?:-name)?$/);
    if (font) {
      const kind = font[1], id = $(`#setup-${kind}-font`).value;
      const input = $(`#setup-${kind}-font-name`);
      $(`#setup-${kind}-font-name-field`).hidden = id !== 'custom';
      if (id === 'custom' && !input.value.trim()) { input.focus(); msg(e.target.closest('section'), 'Enter an installed font name.'); return; }
      NoctuaFonts.set(kind, id, input.value);
      msg(e.target.closest('section'), 'Saved.', true); return;
    }
    if (['setup-app-theme', 'setup-notes-theme', 'setup-reader-theme'].includes(e.target.id)) {
      if (e.target.id === 'setup-app-theme') setAppTheme(e.target.value);
      else if (e.target.id === 'setup-notes-theme') setNotesTheme(e.target.value);
      else await setReaderTheme(e.target.value);
      msg(e.target.closest('section'), 'Saved.', true); return;
    }
    if (['setup-model', 'setup-custom-model', 'setup-reasoning', 'setup-fast'].includes(e.target.id)) {
      const custom = $('#setup-model').value === 'custom';
      $('#setup-custom-model-field').hidden = !custom;
      if (e.target.id === 'setup-model' && custom) {
        updateFastMode(chat.provider, $('#setup-custom-model').value.trim());
        $('#setup-custom-model').focus(); return;
      }
      const section = e.target.closest('section');
      const model = custom ? $('#setup-custom-model').value.trim() : $('#setup-model').value;
      if (e.target.id === 'setup-model' || e.target.id === 'setup-custom-model') {
        let effort = $('#setup-reasoning').value;
        if (!assistantEfforts(chat.provider, model).includes(effort)) effort = '';
        $('#setup-reasoning').innerHTML = reasoningOptions(chat.provider, model, effort);
        $('#setup-reasoning').value = effort;
      }
      updateFastMode(chat.provider, model);
      const options = { model, reasoning: $('#setup-reasoning').value, fast: $('#setup-fast').checked };
      if (custom && !options.model) { msg(section, 'Enter a custom model ID.'); return; }
      const controls = [...section.querySelectorAll('input, select, button')];
      const disabled = controls.map((control) => control.disabled);
      assistantSaving = true;
      controls.forEach((control) => { control.disabled = true; });
      try {
        const provider = chat.provider;
        await api('/api/settings/agent', { provider, options });
        settings.assistant ||= {};
        settings.assistant[provider] = options;
        msg(section, 'Saved. Applies to the next request.', true);
      } catch (err) { msg(section, err.message); }
      finally {
        assistantSaving = false;
        controls.forEach((control, i) => {
          control.disabled = control.id === 'setup-model' ? modelCatalogs[chat.provider] === null :
            control.id === 'setup-fast' ? !assistantFastAllowed(chat.provider, options.model) : disabled[i];
        });
      }
      return;
    }
    if (e.target.id !== 'setup-agent') return;
    e.target.disabled = true;
    try {
      await activateAgent(e.target.value);
      $('#assistant-options').innerHTML = assistantOptions(settings, chat.provider);
      await checkAgent();
    }
    catch (err) { toast(err.message, { error: true }); e.target.value = chat.provider; }
    finally { e.target.disabled = false; }
  });
  card.addEventListener('keydown', (e) => {
    if(e.key==='Escape'){
      const picker=card.querySelector('.settings-ai-color-picker[open]');
      if(picker){e.preventDefault();e.stopPropagation();picker.open=false;picker.querySelector('summary').focus();return;}
    }
    if (e.key === 'Enter' && /^setup-(ui|note|chat)-font-name$/.test(e.target.id)) {
      e.preventDefault(); e.target.dispatchEvent(new Event('change', {bubbles:true})); return;
    }
    if (e.key === 'Enter' && e.target.matches('.setup-input')) e.target.closest('section').querySelector('button.primary')?.click();
    if (e.key === 'Escape' && !firstRun) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.target.matches('[data-settings-tab]') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const ids = SETTINGS_TABS.map(([id]) => id), i = ids.indexOf(e.target.dataset.settingsTab);
      const at = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length;
      selectTab(ids[at], true);
    }
    if (e.key === 'Tab') {
      const items = [...card.querySelectorAll('button, input, select, a[href], [tabindex]')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
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
  b.innerHTML = 'Using Semantic Scholar’s shared pool, which is slow and often rate-limited. <a href="#" class="open-settings" data-settings-open="connections">Add your API key</a><button class="icon" title="Hide for now" data-icon="x" aria-label="Hide for now" data-icon-only>✕</button>';
  b.querySelector('button').addEventListener('click', () => {
    try { sessionStorage.setItem('noctua.bannerClosed', '1'); } catch { /* storage unavailable */ }
    b.remove();
  });
  $('header').after(b);
}

async function loadSettings() {
  settings = await api('/api/settings');
  applyPDFHighlightColors(settings.highlight_colors,settings.highlight_palette);
  return settings;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.open-settings, #open-settings')) {
    e.preventDefault();
    const tab = e.target.closest('[data-settings-open]')?.dataset.settingsOpen;
    if (settings) openSetup({ tab });
    else loadSettings().then(() => openSetup({ tab })).catch((err) => toast(err.message, { error: true }));
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
  if (keyNeeded(s)) openSetup({ firstRun: true });
  else renderKeyBanner();
}).catch((e) => toast(e.message, { error: true }));
