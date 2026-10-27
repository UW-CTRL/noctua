'use strict';
// First-run setup and tabbed Settings. Uses app.js and notes.js globals.

const S2_KEY_URL = 'https://www.semanticscholar.org/product/api#api-key-form';
let settings = null;

const keyNeeded = (s) => !s.key_source && !s.skipped;

function keySection(s, firstRun) {
  const intro = '<h2>Server Semantic Scholar API Key</h2><p>An optional API key for paper searches and citation lookups.</p>';
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
  const intro = '<h2>Import from Zotero on the server computer</h2><p>Import collections, papers, and available PDFs from your Zotero library.</p>';
  const pdfPreference=`<label for="setup-zotero-pdf">Default PDF storage</label><div class="setup-row"><select id="setup-zotero-pdf"><option value="link"${s.zotero_pdf_mode!=='copy'?' selected':''}>Link original</option><option value="copy"${s.zotero_pdf_mode==='copy'?' selected':''}>Copy to Noctua</option></select><button type="button" data-act="save-zotero-pdf" data-icon="save">Save default</button></div><p>Link original reads PDFs from this Zotero folder without copying them. Change the folder and import again to reconnect moved files. You can override the storage mode for each import.</p>`;
  const importAction = firstRun ? '' : '<button type="button" id="import-zotero" data-act="import-zotero" data-icon="import">Import from Zotero</button>';
  if (s.zotero_source === 'env') {
    return `<section data-step="zotero">${intro}
      <code class="settings-path">${esc(s.zotero_dir)}</code><p><code>ZOTERO_DATA_DIR</code></p>
      ${pdfPreference}
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
    ${pdfPreference}
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
  return `<section data-step="agent"><h2>Research Assistant</h2>
    <div class="settings-group" role="group" aria-labelledby="settings-provider-title">
    <div class="setting-field"><h3 id="settings-provider-title">Provider</h3>
    <select id="setup-agent" aria-labelledby="settings-provider-title" ${chat.switching ? 'disabled' : ''}>
      <option value="claude" ${provider === 'claude' ? 'selected' : ''}>Claude Code</option>
      <option value="codex" ${provider === 'codex' ? 'selected' : ''}>Codex</option>
    </select></div></div>
    <div class="settings-group" role="group" aria-labelledby="settings-model-title"><h3 id="settings-model-title">Model Settings</h3>
    <div id="assistant-options">${assistantOptions(s, provider)}</div>
    </div>
    ${threadSummarySettings()}
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
  ['appearance', 'Appearance'], ['server', 'Server & Connection'], ['agent', 'Research Assistant'], ['skills', 'Skills'],
  ['search', 'Search'], ['connections', 'Integrations'], ['data', 'Data & Storage'], ['about', 'About & Shortcuts'],
];

function isDesktopConnectionClient() {
  try { return !!(window.noctuaDesktopClient || window.top?.noctuaDesktopClient); }
  catch { return false; }
}
function openServerConnectionSettings() {
  if (!isDesktopConnectionClient()) return false;
  window.top.location.href = 'https://noctua.invalid/settings';
  return true;
}

function browserLocalTokenSection() {
  if (isDesktopConnectionClient() || !['localhost','127.0.0.1'].includes(location.hostname) || location.protocol !== 'http:') return '';
  return '<div class="settings-group"><h3>Current server token</h3><label class="setting-field">Authentication token<input class="setup-input" id="browser-local-token" type="password" readonly autocomplete="off" placeholder="Hidden until requested"></label><div class="setup-actions"><button data-act="show-browser-token" aria-controls="browser-local-token" aria-pressed="false">Show token</button><button data-act="copy-browser-token">Copy token</button></div><p class="hint">Anyone with this token can access this server. Copying replaces your clipboard.</p><p id="browser-token-status" role="status"></p></div>';
}
function clearBrowserLocalToken(root) {
  const input=root.querySelector('#browser-local-token');
  if(input){input.value='';input.type='password';}
  const button=root.querySelector('[data-act="show-browser-token"]');
  if(button){button.textContent='Show token';button.setAttribute('aria-pressed','false');}
  const status=root.querySelector('#browser-token-status');if(status)status.textContent='';
}
async function useBrowserLocalToken(section, copy=false) {
  const input=section.querySelector('#browser-local-token');
  if(!copy&&input.type==='text'){clearBrowserLocalToken(section);return;}
  const result=await api('/api/server/token',{});
  if(!section.isConnected)return;
  if(copy){
    try { await navigator.clipboard.writeText(result.token); }
    catch {
      const field=document.createElement('textarea');field.value=result.token;field.style.position='fixed';field.style.opacity='0';section.appendChild(field);
      try { field.select();if(!document.execCommand('copy'))throw Error('Copy was blocked. Show the token and copy it manually.'); }
      finally { field.value='';field.remove(); }
    }
    section.querySelector('#browser-token-status').textContent='Token copied.';
  }else{
    input.value=result.token;input.type='text';
    const button=section.querySelector('[data-act="show-browser-token"]');button.textContent='Hide token';button.setAttribute('aria-pressed','true');
  }
}

function browserServerStartHelp() {
  if(isDesktopConnectionClient())return '';
  return `<details class="settings-group" id="browser-server-start-help"><summary>How to start a server</summary><p>On the computer that will host your library, open a terminal with the Noctua server executable installed. Run these commands (or use the full path to the executable):</p><pre><code>noctua ensure
noctua token</code></pre><p><code>ensure</code> starts a background server or reuses one already running, and prints its address. <code>token</code> shows the authentication token. Enter that address and token above. Keep the token private.</p><p>A localhost address works only on the computer running the server. To connect from another computer, configure an HTTPS proxy and add its exact origin to the server’s <code>server-config.json</code>.</p><p>Check the running address with <code>noctua status</code>. To stop the server after saving your work, run <code>noctua stop</code>. Closing the browser leaves the server running.</p><p>The browser cannot start a stopped server. If this page will not load, start the server from its computer’s terminal or the desktop app’s connection settings.</p></details>`;
}

function searchSettingsSection() {
  return `<section data-step="search"><h2>Search Engines</h2>
    <p>Drag engines to change their order in the search menu and Tab switching. The first engine is your default and is selected when you reopen or reload the app.</p>
    <ol class="search-engine-order" aria-label="Search engine order"></ol>
    <p class="setup-msg ok" data-search-order-status role="status">Changes save automatically for this browser and server.</p></section>`;
}
function mountSearchEngineOrder(section) {
  const list = section.querySelector('.search-engine-order');
  let dragged = null;
  const grip = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
  const render = () => {
    list.innerHTML = searchEngines.map((engine, index) => `<li draggable="true" data-search-engine="${engine}">
      <span class="search-order-grip">${grip}</span><span class="search-order-name">${esc(searchEngineNames[engine])}${engine === 'google-scholar' ? ' ↗' : ''}${index === 0 ? '<span class="search-order-default">Default</span>' : ''}</span>
      </li>`).join('');
  };
  const clearDrag = () => {
    dragged = null;
    list.querySelectorAll('li').forEach(row => row.classList.remove('dragging', 'drop-before', 'drop-after'));
  };
  const save = order => {
    setSearchEngineOrder(order);
    clearDrag(); render();
    section.querySelector('[data-search-order-status]').textContent = 'Search engine order saved.';
  };
  list.addEventListener('dragstart', event => {
    const row = event.target.closest('[data-search-engine]');
    if (!row || event.target.closest('button')) { event.preventDefault(); return; }
    dragged = row.dataset.searchEngine;
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragged);
    row.classList.add('dragging');
  });
  list.addEventListener('dragover', event => {
    if (!dragged) return;
    const row = event.target.closest('[data-search-engine]');
    if (!row) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    list.querySelectorAll('li').forEach(item => item.classList.remove('drop-before', 'drop-after'));
    if (row.dataset.searchEngine !== dragged) row.classList.add(event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', event => {
    if (!dragged) return;
    const row = event.target.closest('[data-search-engine]');
    if (!row) return;
    event.preventDefault();
    if (row.dataset.searchEngine === dragged) { clearDrag(); return; }
    const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
    const before = after ? row.nextElementSibling?.dataset.searchEngine : row.dataset.searchEngine;
    // Dropping immediately before the dragged row leaves its order unchanged.
    if (before === dragged) { clearDrag(); return; }
    const engine = dragged, order = searchEngines.filter(item => item !== engine);
    const index = before ? order.indexOf(before) : order.length;
    order.splice(index, 0, engine); save(order);
  });
  list.addEventListener('dragend', clearDrag);
  render();
}

function serverSection() {
  const id=window.noctuaServerId || 'Unavailable';
  const desktop=isDesktopConnectionClient();
  return `<section><h2>Server &amp; Connection</h2>${desktop ? '<p>Change servers, manage this computer’s server, or view and copy its authentication token in the connection settings window.</p><button class="primary" data-act="open-server-connection" data-icon="plug">Open connection settings</button>' : '<p>Connect this browser to another Noctua server. Allow the connection pop-up; your open edits are saved before switching.</p><label class="setting-field">Server address<input class="setup-input" id="browser-server-address" type="url" placeholder="https://computer.example.com" autocomplete="url"></label><label class="setting-field">Authentication token<input class="setup-input" id="browser-server-token" type="password" autocomplete="off" spellcheck="false"></label><button class="primary" data-act="browser-connect" data-icon="plug">Save &amp; connect</button><p class="hint">Use HTTPS for remote servers or HTTP for localhost. The target server must support browser connections. Tokens are sent only to the address you enter and are not saved in browser storage. Local process controls remain in the desktop app.</p>'}${browserServerStartHelp()}${browserLocalTokenSection()}<p>Address: <code>${esc(location.origin)}</code><br>Server identifier: <code>${esc(id)}</code><br>Server version: ${esc(settings?.version || 'unknown')}</p><p>AI CLI, API credentials, Zotero and data paths belong to this server computer. File uploads choose files on this client. Closing this interface leaves server tasks running.</p><button data-act="reconnect-server">Test / reconnect this server</button><p class="setup-msg" role="status"></p></section>`;
}

function skillSettingsSection() {
  return `<section data-step="skills"><h2>Skills</h2><p>Use / in chat to select an available skill for one message.</p>
    <div class="settings-group"><h3>Global Agent Skills</h3>
      <p>Read global installations on this server computer. The default location is ~/.agents/skills.</p>
      <label class="setting-field">Location<input class="setup-input" data-skill-location placeholder="~/.agents/skills" spellcheck="false"></label>
      <div class="setup-actions"><button type="button" data-skill-location-save data-icon="save">Save location</button><button type="button" data-skill-location-reset>Use default</button><button type="button" data-skill-reload data-icon="refresh-cw">Refresh</button></div>
      <div data-global-skill-list></div>
    </div>
    <div class="settings-group"><h3>Project Skills</h3>
      <p>Import multiple skills from a project folder or its skills folder. Expand each project to see its available skills. Disconnect removes only Noctua copies; the original project stays unchanged.</p>
      <div class="setup-actions"><button type="button" data-skill-import="project" data-icon="folder-open">Import Skills from Project</button></div>
      <div data-skill-list></div>
      <details class="skill-individual-import"><summary>Import An Individual Skill</summary><div class="setup-actions">
        <button type="button" data-skill-import="folder" data-icon="folder-open">Import folder</button><button type="button" data-skill-import="zip" data-icon="file-up">Import ZIP</button><button type="button" data-skill-import="md" data-icon="file-up">Import SKILL.md</button>
      </div></details>
    </div>
    <div class="settings-group"><h3>Chat Project Defaults</h3>
      <p>Choose skills to make available on every message in a Noctua project. Slash commands add skills for one message.</p>
      <label class="setting-field">Project<select data-skill-project><option value="">Choose a project</option></select></label>
      <div data-skill-defaults></div><button type="button" data-skill-save data-icon="save" disabled>Save project defaults</button>
    </div><p data-skill-status role="status"></p></section>`;
}

function mountSkillSettings(host) {
  const project=host.querySelector('[data-skill-project]'),status=host.querySelector('[data-skill-status]'),save=host.querySelector('[data-skill-save]');
  let skills=[],manifest=null,request=0,loading=true,saving=false,importing=false;
  const active=chatProjectTarget();
  project.innerHTML='<option value="">Choose a project</option>'+collections.targets.map(t=>`<option value="${esc(t.id)}">${esc(t.name||t.id)}</option>`).join('');
  project.value=collections.targets.some(t=>t.id===active)?active:'';
  function controls(){
    save.disabled=loading||saving||importing||!manifest;project.disabled=saving||importing;
    host.querySelectorAll('[data-skill-default]').forEach(el=>el.disabled=loading||saving||importing);
    host.querySelectorAll('[data-skill-import],[data-skill-reload],[data-skill-disconnect],[data-skill-project-disconnect],[data-skill-location-save],[data-skill-location-reset],[data-skill-location]').forEach(el=>el.disabled=loading||importing||saving);
  }
  function defaults(ids=manifest?.skills||[]){
    host.querySelector('[data-skill-defaults]').innerHTML=!project.value?'<p>Choose a project to manage its default skills.</p>':!manifest?'<p>Project defaults are unavailable. Refresh to retry.</p>':skills.map(s=>`<label class="skill-default"><input type="checkbox" data-skill-default="${esc(s.id)}" ${ids.includes(s.id)?'checked':''}> ${esc(s.name||s.id)}</label>`).join('')||'<p>Import a skill to set project defaults.</p>';
    controls();
  }
  async function loadProject(){
    const ticket=++request,target=project.value;manifest=null;loading=true;defaults();
    if(!target){loading=false;defaults();return;}
    try{const m=await api(`/api/workspaces/${enc(target)}`);if(!host.isConnected||ticket!==request)return;manifest=m;status.textContent='';}
    catch(e){if(ticket===request)status.textContent='Could not load project defaults: '+e.message;}
    finally{if(ticket===request){loading=false;defaults();}}
  }
  async function reload(){
    loading=true;controls();status.textContent='Loading skills…';
    try{
      const [imported,config]=await Promise.all([api('/api/skills'),api('/api/skills/settings')]);if(!host.isConnected)return;skills=imported;
      host.querySelector('[data-skill-location]').value=config.location||'';
      const packageHTML=(s,individual=false)=>`<details class="settings-skill" data-skill-package="${esc(s.id)}"><summary>${esc(s.name||s.id)}</summary><p>${esc(s.description)}</p><small>${s.source==='local'?'Global installation':'Imported into Noctua'}</small>${individual?`<div class="setup-actions"><button type="button" data-skill-disconnect="${esc(s.id)}" data-icon="x" aria-label="Disconnect ${esc(s.name||s.id)} from Noctua">Disconnect</button></div>`:''}<div data-skill-resource></div></details>`;
      host.querySelector('[data-global-skill-list]').innerHTML=skills.filter(s=>s.source==='local').map(s=>packageHTML(s)).join('')||'<p>No global skills found at this location.</p>';
      const groups=config.projects||[],grouped=new Set(groups.flatMap(g=>g.skill_ids));
      const projects=groups.map(group=>{const entries=skills.filter(s=>group.skill_ids.includes(s.id));return `<details class="settings-skill-project" data-skill-group="${esc(group.id)}"><summary>${esc(group.name)} <small>(${entries.length} ${entries.length===1?'skill':'skills'})</small></summary><div class="setup-actions"><button type="button" data-skill-project-disconnect="${esc(group.id)}" data-icon="x" aria-label="Disconnect ${esc(group.name)} from Noctua">Disconnect</button></div>${entries.map(s=>packageHTML(s)).join('')||'<p>No available skills in this project.</p>'}</details>`;}).join('');
      const individual=skills.filter(s=>s.source!=='local'&&!grouped.has(s.id));
      host.querySelector('[data-skill-list]').innerHTML=projects+(individual.length?`<details class="settings-skill-project" data-skill-group="individual"><summary>Other Imported Skills (${individual.length})</summary>${individual.map(s=>packageHTML(s,true)).join('')}</details>`:'')||'<p>No project skills imported yet.</p>';
      host.querySelectorAll('[data-skill-package]').forEach(details=>details.addEventListener('toggle',()=>{if(details.open&&!details.querySelector('pre'))inspect(details);}));
      host.querySelectorAll('[data-skill-disconnect],[data-skill-project-disconnect]').forEach(button=>button.onclick=async()=>{
        if(importing||loading||saving)return;importing=true;controls();status.textContent='Disconnecting skill…';
        try{
          const path=button.dataset.skillProjectDisconnect?`/api/skills/projects/${enc(button.dataset.skillProjectDisconnect)}`:`/api/skills/${enc(button.dataset.skillDisconnect)}`;
          const response=await fetch(path,{method:'DELETE'}),result=await response.json();
          if(!response.ok)throw Error(result.error||'Could not disconnect skill');
          if(host.isConnected&&await reload())status.textContent='Disconnected from Noctua. The original folder is unchanged.';
        }catch(e){status.textContent='Could not disconnect skill: '+e.message;}
        finally{importing=false;controls();}
      });
      status.textContent='';await loadProject();return !project.value||!!manifest;
    }catch(e){loading=false;manifest=null;defaults();status.textContent='Could not load skills: '+e.message;return false;}
    finally{controls();}
  }
  async function inspect(details){
    const container=details.querySelector('[data-skill-resource]'),id=details.dataset.skillPackage;
    container.textContent='Loading instructions…';
    try{
      const resource=await api(`/api/skills/${enc(id)}/files/SKILL.md`);if(!details.isConnected)return;
      container.innerHTML=`<label>Resource<select aria-label="Skill resource">${resource.files.map(path=>`<option value="${esc(path)}" ${path==='SKILL.md'?'selected':''}>${esc(path)}</option>`).join('')}</select></label><pre></pre>`;
      const source=container.querySelector('pre'),select=container.querySelector('select');source.textContent=resource.text;
      let resourceRequest=0;
      select.onchange=async()=>{const ticket=++resourceRequest;source.textContent='Loading resource…';try{const r=await api(`/api/skills/${enc(id)}/files/${select.value.split('/').map(enc).join('/')}`);if(ticket===resourceRequest&&details.isConnected)source.textContent=r.text;}catch(e){if(ticket===resourceRequest)source.textContent=e.message;}};
    }catch(e){container.textContent='Could not read skill: '+e.message;}
  }
  const changeLocation=async(reset)=>{
    if(importing||loading||saving)return;importing=true;controls();status.textContent='Saving global skills location…';
    try{await api('/api/skills/settings',{location:reset?null:host.querySelector('[data-skill-location]').value});if(await reload())status.textContent='Global skills location saved.';}
    catch(e){status.textContent='Could not save global skills location: '+e.message;}
    finally{importing=false;controls();}
  };
  host.querySelector('[data-skill-location-save]').onclick=()=>changeLocation(false);
  host.querySelector('[data-skill-location-reset]').onclick=()=>changeLocation(true);
  project.onchange=loadProject;
  host.querySelector('[data-skill-reload]').onclick=reload;
  save.onclick=async()=>{
    if(!manifest||saving)return;const target=project.value,ids=[...host.querySelectorAll('[data-skill-default]:checked')].map(el=>el.dataset.skillDefault);saving=true;controls();status.textContent='Saving project defaults…';
    try{
      if(W.target===target)await saveWorkspaceFile();
      const current=await api(`/api/workspaces/${enc(target)}`);
      const updated=await api(`/api/workspaces/${enc(target)}`,{revision:current.revision,op:'config',skills:ids});
      if(W.target===target){W.manifest=updated;W.fileRevision=updated.revision;renderWorkspaceTree();}
      if(host.isConnected&&project.value===target){manifest=updated;status.textContent='Project defaults saved. They apply to the next chat turn.';}
    }catch(e){status.textContent='Could not save project defaults: '+e.message;}
    finally{saving=false;controls();}
  };
  host.querySelectorAll('[data-skill-import]').forEach(button=>button.onclick=()=>{
    const kind=button.dataset.skillImport,input=document.createElement('input');input.type='file';
    if(kind==='folder'||kind==='project'){input.multiple=true;input.setAttribute('webkitdirectory','');}else input.accept=kind==='zip'?'.zip':'.md';
    input.onchange=async()=>{
      if(!input.files.length)return;importing=true;controls();status.textContent='Importing skill…';
      try{
        if(kind==='project'){
          const entries=[...input.files].filter(f=>!(f.webkitRelativePath||f.name).split('/').some(p=>['.DS_Store','__MACOSX','.git','node_modules'].includes(p)));
          const path=f=>f.webkitRelativePath||f.name;
          let roots=entries.filter(f=>path(f).split('/').at(-1)==='SKILL.md').map(f=>path(f).slice(0,-'SKILL.md'.length));
          roots=roots.filter(root=>!roots.some(other=>other!==root&&root.startsWith(other)));
          if(!roots.length)throw Error('No SKILL.md packages found in the selected project.');
          if(roots.length>100)throw Error('Import at most 100 skills per project.');
          let total=0,count=0;const packages=[];
          for(const root of roots){const files=[];for(const f of entries.filter(f=>path(f).startsWith(root))){
            total+=f.size;if(total>32*1024*1024||++count>512)throw Error('Project skill imports support at most 512 files and 32 MB.');
            const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
            files.push({path:path(f).slice(root.length),data:btoa(binary)});
          }packages.push({files});}
          await api('/api/skills/import-project',{name:path(entries[0]).split('/')[0],packages});
        }else if(kind==='zip'){
          const response=await fetch('/api/skills/import-zip',{method:'POST',body:input.files[0]}),result=await response.json();if(!response.ok)throw Error(result.error||'Import failed');
        }else{
          const files=[];let total=0;
          for(const f of input.files){
            if((f.webkitRelativePath||f.name).split('/').some(p=>['.DS_Store','__MACOSX','.git'].includes(p)))continue;
            total+=f.size;if(total>32*1024*1024||files.length>=512)throw Error('Skill packages support at most 512 files and 32 MB.');
            const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
            files.push({path:kind==='md'?'SKILL.md':f.webkitRelativePath||f.name,data:btoa(binary)});
          }
          await api('/api/skills',{files});
        }
        if(host.isConnected&&await reload())status.textContent='Skill imported. Use / in chat or select it as a project default.';
      }catch(e){status.textContent='Could not import skill: '+e.message;}
      finally{importing=false;controls();}
    };input.click();
  });
  reload();
}

function fontSizeSetting(kind, label) {
  return `<select id="setup-${kind}-font-size" aria-label="${label}">${NoctuaFonts.sizeChoices(kind).map(value => `<option value="${value}" ${value === NoctuaFonts.getSize(kind) ? 'selected' : ''}>${value}px</option>`).join('')}</select>`;
}
function fontSetting(kind, label) {
  const preference = NoctuaFonts.get(kind);
  const choices = NoctuaFonts.choices(kind).map(option => `<option value="${option.id}" ${option.id === preference.id ? 'selected' : ''}>${esc(option.label)}</option>`).join('');
  const size = kind === 'note' ? '' : fontSizeSetting(kind, label + ' size');
  const noteSizes = kind === 'note' ? `<div class="note-size-settings"><label for="setup-noteTitle-font-size">Title size${fontSizeSetting('noteTitle', 'Note title size')}</label><label for="setup-note-font-size">Body size${fontSizeSetting('note', 'Note body size')}</label></div>` : '';
  return `<div class="setting-field"><label for="setup-${kind}-font">${label}</label><div class="font-setting-controls${kind === 'note' ? ' note-font-controls' : ''}"><select id="setup-${kind}-font">${choices}</select>${size}</div></div>
    <label class="setting-field" id="setup-${kind}-font-name-field" for="setup-${kind}-font-name" ${preference.id === 'custom' ? '' : 'hidden'}><span>Font name</span><input class="setup-input" id="setup-${kind}-font-name" value="${esc(preference.name)}" placeholder="e.g. Pretendard" autocomplete="off" spellcheck="false"></label>
    ${noteSizes}
    ${kind === 'note' ? '<p class="font-preview font-preview-note-title"><span>Note title</span></p>' : ''}
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
  return `<div class="settings-group highlight-settings" role="group" aria-labelledby="settings-highlight-colors-title"><h3 id="settings-highlight-colors-title">Highlight Colors</h3><div class="settings-highlight-rows">
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
function appIconSettings() {
  if (!settings?.desktop) return ''; // Native artwork is managed by the local connection screen.
  const selected = settings?.app_icon || 'light';
  const note = settings?.desktop ? 'Applies immediately and is restored when you reopen Noctua.' : 'Saved for the desktop app and applied on its next launch.';
  return `<div class="settings-group" role="group" aria-labelledby="settings-app-icon-title"><h3 id="settings-app-icon-title">App Icon</h3>
    <p class="hint">${note}</p>
    <div class="settings-app-icons">${['light','dark'].map(icon => `<label class="settings-app-icon"><input type="radio" name="app-icon" value="${icon}" ${icon === selected ? 'checked' : ''}><img src="/app-icons/${icon}.svg" width="80" height="80" alt=""><span>${icon === 'dark' ? 'Dark' : 'Light'}</span></label>`).join('')}</div>
    </div>`;
}
async function saveAppIcon(icon) {
  const result = await api('/api/settings/app-icon', {app_icon: icon});
  settings.app_icon = result.app_icon;
}
function appearanceSection() {
  const options = (value) => ['system', 'light', 'dark'].map((v) =>
    `<option value="${v}" ${v === value ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
  return `<section data-step="appearance"><h2>Appearance</h2>
    <div class="settings-group" role="group" aria-labelledby="settings-theme-title"><h3 id="settings-theme-title">Theme</h3>
    <label class="setting-field" for="setup-app-theme"><span>App theme</span>
      <select id="setup-app-theme">${options(document.documentElement.dataset.theme || 'system')}</select></label>
    <label class="setting-field" for="setup-notes-theme"><span>Notes theme</span>
      <select id="setup-notes-theme">${options($('#notes-stage').dataset.notesTheme || 'system')}</select></label>
    <label class="setting-field" for="setup-reader-theme"><span>Reader theme</span>
      <select id="setup-reader-theme">${options(PDF.theme || 'system')}</select></label>
    </div>
    ${appIconSettings()}
    ${highlightColorSettings()}
    <div class="settings-group" role="group" aria-labelledby="settings-fonts-title"><h3 id="settings-fonts-title">Fonts</h3>
      ${fontSetting('ui', 'System font')}
      ${fontSetting('note', 'Note font')}
      ${fontSetting('chat', 'Chat font')}
    </div>
    <p class="setup-msg ok" role="status"></p></section>`;
}

function threadSummarySettings() {
  return `<div class="settings-group" role="group" aria-labelledby="settings-lineage-title"><h3 id="settings-lineage-title">Lineage</h3>
    <label class="setting-field" for="setup-threads-auto"><span>Summarize threads automatically</span>
      <input id="setup-threads-auto" type="checkbox" ${store.get('noctua.threadsAuto') !== '0' ? 'checked' : ''}></label>
    <p class="hint">Use your research assistant to summarize new citation threads automatically. Results are cached. You can also summarize manually in Lineage. This preference is saved in this browser.</p>
    </div>`;
}

function scholarSection() {
  return `<section data-step="scholar"><h2 class="settings-section-heading">Google Scholar Inbox<button type="button" data-scholar-help data-icon="circle-help" data-icon-only aria-label="How to Set Up Google Scholar Inbox" title="Setup guide"></button></h2>
    <p class="hint">Read accessible Scholar papers and save those matching your research interests. Emails stay unchanged.</p>
    <label class="setting-field"><span>Poll automatically</span><input type="checkbox" data-scholar-enabled></label>
    <label class="setting-field"><span>Destination collection</span><select data-scholar-collection aria-label="Destination collection"><option value="scholar_inbox">scholar_inbox (create when saved)</option></select></label>
    <p class="hint">Choose a current folder, or scholar_inbox to create it when you save.</p>
    <label class="setting-field"><span>Polling interval (minutes)</span><input class="setup-input" data-scholar-interval type="number" min="15" max="1440" value="15"></label>
    <div class="setting-field"><span>Scholar Agent</span><span class="setup-actions"><button type="button" data-scholar-prompt data-icon="pencil">Edit prompt</button><button type="button" data-scholar-log data-icon="history">Log</button></span></div>
    <p class="hint" data-scholar-prompt-status>Set your Research Interest before collecting papers.</p>
    <details data-scholar-credentials><summary>Google Connection</summary>
    <p class="hint">Use a Google Desktop OAuth client with Gmail API enabled. <a href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noopener">Setup guide</a>. Sign in on this computer; credentials stay on the server.</p>
    <label class="setting-field"><span>Google OAuth client ID</span><input class="setup-input" data-scholar-client autocomplete="off" spellcheck="false"></label>
    <label class="setting-field"><span>Client secret</span><input class="setup-input" data-scholar-secret type="password" autocomplete="new-password" placeholder="Leave blank to keep the saved secret"></label>
    </details>
    <div class="setup-actions"><button class="primary" data-scholar-action="save" data-icon="save">Save changes</button><button data-scholar-action="check" data-icon="refresh-cw" hidden>Check now</button><button data-scholar-action="disconnect" data-icon="x" data-icon-only aria-label="Disconnect Gmail" title="Disconnect Gmail" hidden>Disconnect</button></div>
    <p data-scholar-login></p><p data-scholar-status role="status" aria-live="polite">Loading plugin…</p>
    <div data-scholar-outcomes></div></section>`;
}
function showScholarSetupHelp() {
  if (document.querySelector('#scholar-setup-help')) return;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.id = 'scholar-setup-help';
  dialog.className = 'workspace-dialog scholar-setup-help';
  dialog.setAttribute('aria-labelledby', 'scholar-help-title');
  dialog.innerHTML = `<header><strong id="scholar-help-title">Set Up Google Scholar Inbox</strong><button type="button" data-close data-icon="x" data-icon-only aria-label="Close setup guide" title="Close"></button></header>
    <ol class="scholar-setup-steps">
      <li><strong>Get Scholar Alerts</strong><p>In <a href="https://scholar.google.com/" target="_blank" rel="noopener">Google Scholar</a>, search a topic → Create alert → enter your Gmail address.</p></li>
      <li><strong>Set Up Google Cloud</strong><p>Create a project in <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a>, then configure:</p>
        <dl><dt>API Library</dt><dd>Enable Gmail API.</dd><dt>Auth Platform</dt><dd>Complete branding and audience; add your Gmail as a test user in Testing.</dd><dt>Data Access</dt><dd>Add the <code>gmail.readonly</code> scope.</dd></dl></li>
      <li><strong>Create OAuth Credentials</strong><p>Clients → Create client → <b>Desktop app</b>. Copy the client ID and client secret.</p></li>
      <li><strong>Connect &amp; Collect</strong><p>In Noctua, expand <b>Google Connection</b>, paste both values, choose a folder → <b>Save &amp; connect</b>. Sign in on the computer running Noctua.</p><p>Use <b>Edit prompt</b> and replace <code>&lt;Research Interest&gt;</code> first. Then use <b>Check now</b> or <b>Poll automatically</b> (15 min minimum).</p></li>
    </ol>
    <details class="scholar-setup-notes"><summary>Access &amp; Troubleshooting</summary><p>Full Gmail scope: <code>https://www.googleapis.com/auth/gmail.readonly</code></p><p>Emails stay unchanged; credentials stay on your Noctua server. If access expires, choose Save &amp; reconnect. Apps in Testing may require frequent reauthorization.</p><p>Choose scholar_inbox to create it when you save. An existing folder is reused.</p></details>
    <footer><a href="https://developers.google.com/workspace/gmail/api/quickstart/python#set-up-environment" target="_blank" rel="noopener">Gmail setup guide</a><a href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noopener">OAuth guide</a></footer>`;
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }, {once: true});
  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.querySelector('[data-close]').focus();
}
async function showScholarPromptEditor(host, onSaved) {
  if (document.querySelector('#scholar-prompt-editor')) return;
  const selected = host.querySelector('[data-scholar-collection]');
  const collection = selected.value, name = selected.selectedOptions[0]?.textContent.trim() || 'scholar_inbox';
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.id = 'scholar-prompt-editor'; dialog.className = 'workspace-dialog scholar-prompt-editor';
  dialog.setAttribute('aria-labelledby', 'scholar-prompt-title');
  dialog.innerHTML = `<header><strong id="scholar-prompt-title">Scholar Agent Prompt</strong><button type="button" data-close data-icon="x" data-icon-only aria-label="Close prompt editor" title="Close"></button></header>
    <p>Screening instructions for <strong>${esc(name)}</strong>. Replace <code>&lt;Research Interest&gt;</code> with your interests before the first sync.</p>
    <p>The agent reads accessible PDF text and saves matching papers only. It uses the provider and model in Research Assistant. This prompt does not run scripts or other skill tools.</p>
    <label for="scholar-prompt-text">System prompt</label><textarea id="scholar-prompt-text" rows="11" spellcheck="false" disabled></textarea>
    <p data-prompt-error role="alert"></p><footer><button type="button" data-prompt-reset disabled>Use default</button><button type="button" data-prompt-cancel>Cancel</button><button type="button" class="primary" data-prompt-save data-icon="save" disabled>Save prompt</button></footer>`;
  const textarea = dialog.querySelector('textarea'), error = dialog.querySelector('[data-prompt-error]');
  const close = () => dialog.close();
  dialog.querySelector('[data-close]').onclick = close; dialog.querySelector('[data-prompt-cancel]').onclick = close;
  dialog.addEventListener('close', () => {dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus();}, {once:true});
  document.body.appendChild(dialog); dialog.showModal();
  let original;
  try {
    const result = await api('/api/scholar/prompt?collection=' + encodeURIComponent(collection));
    if (!dialog.isConnected) return;
    original = result.prompt; textarea.value = original; textarea.disabled = false;
    dialog.querySelector('[data-prompt-reset]').disabled = false; dialog.querySelector('[data-prompt-save]').disabled = false;
    dialog.querySelector('[data-prompt-reset]').onclick = () => {textarea.value = result.default_prompt; textarea.focus();};
    textarea.focus();
  } catch (e) { error.textContent = e.message; }
  dialog.querySelector('[data-prompt-save]').onclick = async () => {
    const prompt = textarea.value;
    if (!prompt.trim()) {error.textContent = 'Enter your screening instructions.'; return;}
    const button = dialog.querySelector('[data-prompt-save]'); button.disabled = true; error.textContent = '';
    try {
      const result = await api('/api/scholar/prompt', {collection, prompt, previous:original});
      await onSaved(result); close();
    } catch (e) {error.textContent = e.message; button.disabled = false;}
  };
}

function scholarPhase(phase) {
  return ({checking:'Checking Gmail',verifying:'Verifying',reading:'Reading PDF',analyzing:'Analyzing',saving:'Saving',cached:'Cached',imported:'Saved',duplicate:'Linked',excluded:'Excluded',retry:'Retry',completed:'Completed',error:'Error',interrupted:'Interrupted'})[phase] || phase;
}
async function showScholarLogs() {
  if (document.querySelector('#scholar-agent-log')) return;
  const previousFocus = document.activeElement, dialog = document.createElement('dialog');
  dialog.id = 'scholar-agent-log'; dialog.className = 'workspace-dialog scholar-agent-log';
  dialog.setAttribute('aria-labelledby', 'scholar-log-title');
  dialog.innerHTML = `<header><strong id="scholar-log-title">Scholar Agent Log</strong><button type="button" data-close data-icon="x" data-icon-only aria-label="Close agent log" title="Close"></button></header>
    <div class="scholar-log-toolbar"><span data-log-live role="status">Loading…</span><select data-log-mode aria-label="Log detail"><option value="results">Results</option><option value="all">All steps</option></select></div>
    <p data-log-error role="alert"></p><div data-log-entries></div><footer><button type="button" data-log-older hidden>Older entries</button></footer>`;
  let timer, loading = false, resetPending = false, cursor = null;
  const entries = new Map(), mode = dialog.querySelector('[data-log-mode]');
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {clearInterval(timer); dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus();}, {once:true});
  document.body.appendChild(dialog); dialog.showModal(); dialog.querySelector('[data-close]').focus();
  const refresh = async (older = false) => {
    if (loading || !dialog.isConnected) return;
    loading = true;
    const selectedMode = mode.value;
    try {
      const result = await api('/api/scholar/logs?mode=' + selectedMode + (older && cursor ? '&before=' + cursor : ''));
      if (!dialog.isConnected || mode.value !== selectedMode) return;
      const live = result.activity;
      dialog.querySelector('[data-log-live]').textContent = live ? `${scholarPhase(live.phase)}${live.provider ? ' · ' + live.provider : ''}${live.title ? ' · ' + live.title : ''}` : 'Idle';
      const opened = new Set([...dialog.querySelectorAll('[data-log-entry][open]')].map(e => e.dataset.logEntry));
      const first = entries.size === 0;
      const priorNewest = Math.max(0, ...entries.keys());
      for (const entry of result.entries) entries.set(entry.id, entry);
      if (older || first || (result.next_before && result.next_before > priorNewest)) cursor = result.next_before;
      dialog.querySelector('[data-log-entries]').innerHTML = [...entries.values()].sort((a,b) => b.id-a.id).map(entry => {
        const date = new Date(entry.time * 1000), fullDate = date.toLocaleString();
        return `<details data-log-entry="${entry.id}" ${opened.has(String(entry.id)) ? 'open' : ''}><summary title="Show reason and details"><span class="scholar-log-row"><time title="${esc(fullDate)}" datetime="${date.toISOString()}">${esc(date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false}))}</time><span class="scholar-log-phase" data-phase="${esc(entry.phase)}">${esc(scholarPhase(entry.phase))}</span><span class="scholar-log-paper" title="${esc(entry.title)}">${esc(entry.title || 'Sync')}</span></span></summary><div class="scholar-log-detail"><p>${esc(entry.detail || 'No additional details.')}</p><small>${esc(fullDate)} · ${esc(entry.provider || 'Server')} · ${esc(entry.collection)}${entry.account ? ' · ' + esc(entry.account) : ''}</small></div></details>`;
      }).join('') || '<p class="hint">No activity yet. Logs appear after a manual or automatic sync.</p>';
      dialog.querySelector('[data-log-older]').hidden = !cursor;
      dialog.querySelector('[data-log-error]').textContent = '';
    } catch (e) {if (dialog.isConnected) dialog.querySelector('[data-log-error]').textContent = e.message;}
    finally {loading = false; if (resetPending) {resetPending = false; refresh();}}
  };
  mode.onchange = () => {entries.clear(); cursor = null; if (loading) resetPending = true; else refresh();};
  dialog.querySelector('[data-log-older]').onclick = () => refresh(true);
  await refresh(); timer = setInterval(() => {if (!dialog.isConnected) clearInterval(timer); else refresh();}, 3000);
}

function mountScholarSettings(host) {
  if (!host) return;
  host.querySelector('[data-scholar-help]').addEventListener('click', showScholarSetupHelp);
  host.querySelector('[data-scholar-log]').addEventListener('click', () => showScholarLogs());
  let initial = true, loading = false, working = false, libraryStamp = null, saved = null;
  const status = host.querySelector('[data-scholar-status]');
  const needsConnection = () => !!host.querySelector('[data-scholar-client]').value.trim() &&
    (!saved?.connected || saved.reauthorize || host.querySelector('[data-scholar-client]').value.trim() !== saved.client_id || !!host.querySelector('[data-scholar-secret]').value);
  const renderActions = () => {
    const save = host.querySelector('[data-scholar-action="save"]');
    const connect = needsConnection();
    save.textContent = working ? 'Working…' : connect ? saved?.connected ? 'Save & reconnect' : 'Save & connect' : 'Save changes';
    save.dataset.icon = connect ? 'log-in' : 'save';
    save.disabled = working || !saved || saved.running;
    for (const action of ['check', 'disconnect']) {
      const button = host.querySelector(`[data-scholar-action="${action}"]`);
      button.hidden = !saved?.connected;
      button.disabled = working || !saved?.connected || saved.running || (action === 'check' && (saved.reauthorize || !saved.prompt_ready));
    }
  };
  host.querySelector('[data-scholar-prompt]').onclick = () => showScholarPromptEditor(host, async result => {
    await refresh();
    const select = host.querySelector('[data-scholar-collection]');
    if (![...select.options].some(option => option.value === result.collection)) select.add(new Option('scholar_inbox', result.collection));
    select.value = result.collection;
    host.querySelector('[data-scholar-prompt-status]').textContent = result.ready ? 'Prompt saved for this collection. Save changes to use this destination.' : 'Replace <Research Interest> in the prompt before collecting papers.';
  }).catch(e => {status.textContent = e.message;});
  host.addEventListener('input', renderActions);
  renderActions();
  const refresh = async () => {
    if (loading || !host.isConnected) return;
    loading = true;
    try {
      const s = await api('/api/scholar');
      if (!host.isConnected) return;
      const destination = host.querySelector('[data-scholar-collection]');
      const selected = initial ? s.collection : destination.value;
      const folders = s.collections;
      const inbox = folders.find(f => f.parent === 'L1' && f.name === 'scholar_inbox');
      const options = folders.map(f => `<option value="${esc(f.id)}">${'　'.repeat(f.level || 0)}${esc(f.name)}</option>`).join('');
      const extra = inbox ? '' : '<option value="scholar_inbox">scholar_inbox (create when saved)</option>';
      const missing = selected !== 'scholar_inbox' && !folders.some(f => f.id === selected);
      const markup = extra + options + (missing ? `<option value="${esc(selected)}" disabled>Unavailable folder — choose another</option>` : '');
      if (destination.innerHTML !== markup) destination.innerHTML = markup;
      destination.value = selected === 'scholar_inbox' && inbox ? inbox.id : selected;
      if (initial) {
        host.querySelector('[data-scholar-enabled]').checked = s.enabled;
        host.querySelector('[data-scholar-interval]').value = s.interval_minutes;
        host.querySelector('[data-scholar-client]').value = s.client_id;
        host.querySelector('[data-scholar-credentials]').open = !s.connected;
        initial = false;
      }
      const ready = !!s.prompt_ready_by_collection?.[destination.value];
      host.querySelector('[data-scholar-prompt-status]').textContent = ready ? 'Papers are screened using this collection’s prompt.' : 'First setup: edit the prompt and replace <Research Interest> with your interests.';
      const stamp = JSON.stringify([s.last_sync, s.counts.imported, s.counts.duplicate]);
      if (libraryStamp !== null && libraryStamp !== stamp) loadCollections();
      libraryStamp = stamp;
      const date = value => value ? new Date(Number(value) * 1000).toLocaleString() : 'Never';
      status.textContent = `${s.activity ? scholarPhase(s.activity.phase) + (s.activity.title ? ': ' + s.activity.title : '') : s.running ? 'Syncing…' : s.connected ? 'Connected: ' + s.account : 'Gmail is disconnected.'} Last completed sync: ${date(s.last_sync)}. Imported: ${s.counts.imported || 0}; duplicates: ${s.counts.duplicate || 0}; excluded: ${s.counts.excluded || 0}; retry: ${s.counts.retry || 0}.${s.reauthorize ? ' Reconnect Gmail to renew access.' : ''}${s.error ? ' ' + s.error : ''}`;
      saved = s;
      renderActions();
      const outcomesOpen = !!host.querySelector('[data-scholar-outcomes] details')?.open;
      host.querySelector('[data-scholar-outcomes]').innerHTML = s.message_errors.map(e => `<p class="settings-warning">Alert ${esc(e.message)}: ${esc(e.error)}</p>`).join('') + (s.items.length ? `<details ${outcomesOpen ? 'open' : ''}><summary>Recent Paper Outcomes</summary><ul>${s.items.map(i => `<li>${esc(i.title || 'Untitled link')}: ${esc(i.status)}${i.error ? ' — ' + esc(i.error) : ''}</li>`).join('')}</ul></details>` : '');
    } catch (e) { status.textContent = e.message; }
    finally { loading = false; }
  };
  host.addEventListener('click', async e => {
    const button = e.target.closest('[data-scholar-action]');
    if (!button) return;
    e.preventDefault();
    if (working) return;
    working = true; renderActions();
    try {
      switch (button.dataset.scholarAction) {
        case 'save': {
          const interval = Number(host.querySelector('[data-scholar-interval]').value);
          if (!Number.isInteger(interval) || interval < 15 || interval > 1440) throw Error('Polling interval must be between 15 and 1440 whole minutes.');
          const connect = needsConnection();
          const secret = host.querySelector('[data-scholar-secret]').value;
          await api('/api/scholar', {enabled: host.querySelector('[data-scholar-enabled]').checked, collection: host.querySelector('[data-scholar-collection]').value, interval_minutes: interval, client_id: host.querySelector('[data-scholar-client]').value, ...(secret ? {client_secret: secret} : {})});
          await loadCollections();
          host.querySelector('[data-scholar-secret]').value = '';
          host.querySelector('[data-scholar-login]').replaceChildren();
          if (connect) {
            const result = await api('/api/scholar/connect', {});
            const link = document.createElement('a');
            link.href = result.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Continue Google sign-in';
            host.querySelector('[data-scholar-login]').replaceChildren(link);
            if (settings?.desktop) await api('/api/desktop/open', {url: result.url});
            else link.click();
          } else toast('Scholar plugin settings saved.');
          break;
        }
        case 'check': await api('/api/scholar/check', {}); break;
        case 'disconnect': {
          const r = await fetch('/api/scholar', {method: 'DELETE'});
          if (!r.ok) throw Error('Could not disconnect Gmail. Try again after sync finishes.');
          host.querySelector('[data-scholar-enabled]').checked = false;
          host.querySelector('[data-scholar-login]').replaceChildren(); break;
        }
      }
      await refresh();
    } catch (error) { status.textContent = error.message; }
    finally { working = false; renderActions(); }
  });
  refresh();
  const timer = setInterval(() => { if (!host.isConnected) clearInterval(timer); else refresh(); }, 3000);
}

function dataSection(s) {
  const temporary = /^(\/private)?\/(tmp|var\/folders)\//.test(s.data_dir);
  return `<section data-step="data"><h2>Data & Storage</h2>
    <div class="settings-group" role="group" aria-labelledby="settings-library-title"><h3 id="settings-library-title">Library</h3>
    <label class="setting-field" for="setup-include-subfolders"><span>Include papers from subfolders</span>
      <input id="setup-include-subfolders" type="checkbox" ${s.include_subfolders !== false ? 'checked' : ''}></label>
    <p class="hint">Show papers from nested folders in folder lists, counts, Graph, and Lineage. The library root always includes all papers.</p>
    </div>
    <div class="settings-group" role="group" aria-labelledby="settings-saving-title"><h3 id="settings-saving-title">Save Destination</h3>
    <label class="setting-field" for="setup-save-target"><span>Default save folder</span>
      <select id="setup-save-target">${collectionOptions(defaultSaveTarget())}</select></label>
    <p class="hint">New papers added from search or a graph are saved here. PDF imports use the selected folder.</p>
    </div>
    <div class="settings-group" role="group" aria-labelledby="settings-storage-title"><h3 id="settings-storage-title">Storage</h3>
    <p class="hint">Choose where Noctua saves your papers, notes, and chats. Location changes apply after restarting.</p>
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
    </div>
    <p class="setup-msg ok" role="status"></p></section>`;
}

function updateSummary(result) { return NoctuaUpdateDialogs.summary(result, settings?.version); }

function aboutSection(s) {
  return `<section data-step="about"><h2>About Noctua</h2>
    <p>Version ${esc(s.version || 'unknown')} · ${s.desktop ? 'Desktop app' : 'Browser app'}</p>
    ${s.desktop ? `<div class="settings-group" data-update>
      <h3>App Updates</h3>
      <p>Noctua checks for new releases at startup. You can also check here. Save your work before installing; installation may close and restart Noctua.</p>
      <div class="update-summary" hidden></div>
      <div class="setup-actions"><button data-act="update" data-update-action="check" data-icon="refresh-cw">Check for updates</button></div>
      <p class="setup-msg" role="status" aria-live="polite"></p>
    </div>` : ''}
    <h3>Keyboard Shortcuts</h3><dl class="settings-shortcuts">
      <dt>Save note</dt><dd>⌘ / Ctrl + S</dd>
      <dt>Add drawing</dt><dd>⌘ / Ctrl + Shift + D</dd>
      <dt>Finish editing a text block</dt><dd>Esc or ⌘ / Ctrl + Enter</dd>
      <dt>Change chat editing mode</dt><dd>Shift + Tab in chat</dd>
      <dt>Close Settings</dt><dd>Esc</dd></dl>
    </section>`;
}

// Browser confirm() is not reliable inside the desktop shell's tab webviews.
function confirmUpdateInstall(version) { return NoctuaUpdateDialogs.confirmInstall(version); }

// The native process retains the checked release and serializes operations across windows.
async function updateApp(button, section, msg, { confirmInstall = true } = {}) {
  const action = button.dataset.updateAction;
  if (action === 'install' && confirmInstall && !await confirmUpdateInstall(button.dataset.updateVersion)) return;
  msg(section, { check: 'Checking for updates…', install: 'Downloading, verifying, and installing the update…', restart: 'Restarting Noctua…' }[action], true);
  try {
    const result = await api('/api/desktop/update', { action, ...(action === 'install' ? { version: button.dataset.updateVersion } : {}) });
    if (result.status === 'available') button.dataset.updateVersion = result.version;
    const summary = section.querySelector('.update-summary');
    if (summary && result.status === 'available') { summary.innerHTML = updateSummary(result); summary.hidden = false; }
    else if (summary && result.status === 'current') { summary.innerHTML = ''; summary.hidden = true; }
    const next = {
      available: ['install', `Update to ${result.version}`, `Version ${result.version} is available.`],
      current: ['check', 'Check for updates', 'You are using the latest published version.'],
      installed: ['restart', 'Restart Noctua', 'Update installed. Restart Noctua to use the new version.'],
    }[result.status];
    if (!next) throw new Error('Unexpected response from the desktop updater.');
    button.dataset.updateAction = next[0];
    button.textContent = next[1];
    msg(section, next[2], true);
  } catch (err) {
    // Recheck after a failure, including when another window already installed an update.
    button.dataset.updateAction = 'check';
    button.textContent = 'Check for updates';
    throw err;
  }
}

function showUpdatePrompt(result) {
  if (document.querySelector('#app-update-dialog')) return;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.id = 'app-update-dialog';
  dialog.className = 'setup-card';
  dialog.setAttribute('aria-labelledby', 'app-update-title');
  dialog.innerHTML = `<h2 id="app-update-title">A new Noctua version is available</h2>
    <div class="update-summary" tabindex="0" role="region" aria-label="Release history">${updateSummary(result)}</div>
    <p>Save your work before updating. Installation may close and restart Noctua.</p>
    <p class="setup-msg ok" role="status" aria-live="polite"></p>
    <div class="setup-actions end"><button data-dismiss>Not now</button>
      <button class="primary" data-update-action="install" data-update-version="${esc(result.version)}">Update to ${esc(result.version)}</button></div>`;
  document.body.appendChild(dialog);
  let busy = false;
  const close = () => { dialog.close(); dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus(); };
  dialog.querySelector('[data-dismiss]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(); });
  const button = dialog.querySelector('[data-update-action]');
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll('button').forEach(node => { node.disabled = true; });
    const msg = (_, text, ok) => {
      const node = dialog.querySelector('.setup-msg');
      node.textContent = '';
      if (text) toast(text, { error: !ok });
    };
    // This dialog's Update button is the explicit confirmation of the warning above it.
    try { await updateApp(button, dialog, msg, { confirmInstall: false }); }
    catch (error) { msg(dialog, error.message, false); }
    finally { busy = false; dialog.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
  });
  dialog.showModal();
  dialog.querySelector('[data-dismiss]').focus();
}

async function checkStartupUpdate(s = settings) {
  if (!s?.desktop || keyNeeded(s)) return;
  try {
    // The native process grants this check once per launch, across all tabs/windows.
    const result = await api('/api/desktop/update', { action: 'startup_check' });
    if (result.status === 'available') showUpdatePrompt(result);
  } catch { /* Startup must stay usable offline; Settings provides an explicit retry. */ }
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
  const context = document.createElement('p'); context.className='hint'; context.textContent='Server & Connection: desktop Settings menu opens the local connection manager even while offline. AI CLI, credentials, Zotero and data paths below are on the server computer. Upload buttons choose files from this client.';
  el.prepend(context);
  let loginAbort = null;
  let assistantSaving = false;
  const close = () => {
    loginAbort?.abort(); clearBrowserLocalToken(card); el.remove();
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
    notifyProgress('sign-in', 'Waiting for sign-in…');
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
      notifyProgress('sign-in', null);
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
    clearBrowserLocalToken(card);
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
    const panels = { appearance: appearanceSection(), server: serverSection(), agent: agentSection(settings), skills: skillSettingsSection(),
      search: searchSettingsSection(), connections: keySection(settings, false) + zoteroSection(settings, false) + scholarSection(), data: dataSection(settings), about: aboutSection(settings) };
    card.innerHTML = `<div class="settings-header"><h1 id="settings-title">Settings</h1><button data-act="close" aria-label="Close Settings" data-icon="x" title="Close Settings" data-icon-only>✕</button></div>
      <div class="settings-body"><nav class="settings-nav" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
        ${SETTINGS_TABS.map(([id, label]) => `<button id="settings-tab-${id}" role="tab" data-icon="${{appearance:'palette',server:'server',agent:'bot',skills:'sparkles',search:'search',connections:'plug',data:'database',about:'info'}[id]}" aria-controls="settings-panel-${id}" data-settings-tab="${id}">${label}</button>`).join('')}
      </nav><div class="settings-content">${SETTINGS_TABS.map(([id]) => `<div id="settings-panel-${id}" data-settings-panel="${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" tabindex="0" hidden>${panels[id]}</div>`).join('')}</div></div>`;
    mountSkillSettings(card.querySelector('[data-step="skills"]'));
    mountScholarSettings(card.querySelector('[data-step="scholar"]'));
    mountSearchEngineOrder(card.querySelector('[data-step="search"]'));
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
    m.textContent = '';
    if (text) toast(text, { error: !ok });
  };
  card.addEventListener('click', async (e) => {
    card.querySelectorAll('.settings-ai-color-picker[open]').forEach(picker=>{if(!picker.contains(e.target))picker.open=false;});
    const colorChoice=e.target.closest('[data-highlight-color]');
    if(colorChoice){
      e.preventDefault();const picker=colorChoice.closest('details');picker.open=false;picker.querySelector('summary').focus();
      colorChoice.dispatchEvent(new Event('change',{bubbles:true}));return;
    }
    const nav = e.target.closest('[data-settings-tab]');
    if (nav) {
      selectTab(nav.dataset.settingsTab);
      if (nav.dataset.settingsTab === 'server') openServerConnectionSettings();
      return;
    }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.act === 'open-server-connection') { openServerConnectionSettings(); return; }
    const section = t.closest('[data-update], section');
    // Keep navigation and Close available during network requests.
    const busy = (on) => section?.querySelectorAll('button, input, select').forEach((b) => { b.disabled = on; });
    try {
      busy(true);
      switch (t.dataset.act) {
        case 'show-browser-token':
        case 'copy-browser-token': {
          try { await useBrowserLocalToken(section,t.dataset.act==='copy-browser-token'); }
          catch(error){clearBrowserLocalToken(section);throw error;}
          break;
        }
        case 'browser-connect': {
          const input=section.querySelector('#browser-server-token');
          const token=input.value;input.value='';
          const shell=window.top.noctuaShell;
          let paused=false;
          try {
            const target=await NoctuaBrowserConnection.connect(section.querySelector('#browser-server-address').value,token,async()=>{
              paused=true;
              if(shell){shell.beginSwitch();await shell.flush();}
              else {
                window.prepareEditorSwitch?.();document.body.inert=true;
                window.preserveChatDraft?.();await window.saveWorkspaceFile?.();await window.flushNoteEdits?.();await window.flushPDF?.();
              }
            });
            window.top.location.assign(target);
          } finally {
            if(paused){if(shell)shell.endSwitch();else document.body.inert=false;}
          }
          break;
        }
        case 'reconnect-server': {
          const current=await api('/api/server');
          if(current.api_version!==1||current.server_id!==window.noctuaServerId)throw Error('Server changed or is incompatible. Open the connection manager.');
          msg(section,`Connected to ${current.server_id}`,true);break;
        }
        case 'update': await updateApp(t, section, msg); break;
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
          await importZoteroLibrary();
          break;
        case 'save-zotero-pdf':
          await api('/api/settings/zotero-pdf',{pdf_mode:$('#setup-zotero-pdf').value});
          toast('Zotero PDF default saved.');await next('zotero');break;
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
    if (e.target.name === 'app-icon') {
      const section = e.target.closest('section'), controls = [...section.querySelectorAll('input[name="app-icon"]')];
      controls.forEach(control => control.disabled = true);
      try { await saveAppIcon(e.target.value); msg(section, settings.desktop ? 'App icon updated.' : 'Saved for the next desktop launch.', true); }
      catch (error) { msg(section, error.message); }
      finally { controls.forEach(control => { control.disabled = false; control.checked = control.value === (settings.app_icon || 'light'); }); }
      return;
    }
    const category=e.target.dataset?.highlightColor,paletteIndex=e.target.dataset?.highlightPalette;
    if(category||paletteIndex!==undefined){
      const section=e.target.closest('section'),group=e.target.closest('section'),controls=[...group.querySelectorAll('[data-highlight-color],[data-highlight-palette]')];
      controls.forEach(control=>control.disabled=true);
      try{if(category)await saveHighlightColors({[category]:e.target.value});else {const colors=[...pdfColors];colors[Number(paletteIndex)]=e.target.value;await saveHighlightPalette(colors);}msg(section,'',true);}
      catch(error){syncHighlightColorSettings();msg(section,error.message);}
      finally{controls.forEach(control=>control.disabled=false);}
      return;
    }
    const fontSize = e.target.id.match(/^setup-(ui|note|noteTitle|chat)-font-size$/);
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
    if (e.target.id === 'setup-threads-auto') {
      setThreadsAuto(e.target.checked);
      msg(e.target.closest('section'), 'Lineage summary preference saved.', true);
      return;
    }
    if (e.target.id === 'setup-include-subfolders') {
      const control = e.target;
      const previous = settings.include_subfolders !== false;
      control.disabled = true;
      try { control.checked = await setIncludeSubfolders(control.checked); msg(control.closest('section'), 'Folder view updated.', true); }
      catch (error) { control.checked = previous; msg(control.closest('section'), error.message); }
      finally { control.disabled = false; }
      return;
    }
    if (e.target.id === 'setup-save-target') {
      setDefaultSaveTarget(e.target.value);
      msg(e.target.closest('section'), 'Default save folder updated.', true);
      return;
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
  checkStartupUpdate();
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
  else { renderKeyBanner(); checkStartupUpdate(s); }
}).catch((e) => toast(e.message, { error: true }));
