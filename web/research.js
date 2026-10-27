'use strict';
// Research data belongs to a stable collection ID, never the currently selected tab.
async function openCollectionResearch(target) {
  if (document.querySelector('.collection-research')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'workspace-dialog workspace-compact collection-research';
  dialog.setAttribute('aria-labelledby', 'collection-research-title');
  const name = collections.targets.find(item => item.id === target)?.name || 'Collection';
  dialog.innerHTML = `<header><strong id="collection-research-title">Research details · ${esc(name)}</strong><button type="button" data-close data-icon="x" data-icon-only aria-label="Close" title="Close"></button></header><p data-loading role="status">Loading research details…</p><p data-error class="workspace-error" role="alert"></p><form class="workspace-create" hidden><label>Name<input name="name" required></label><label>Folder type<select name="is_project"><option value="false">Folder</option><option value="true">Research project</option></select></label><label>Goal<textarea name="goal" rows="5" maxlength="20000"></textarea></label><label>Progress (%)<input name="progress" type="text" inputmode="numeric" pattern="[0-9]{1,3}" maxlength="3" required></label><fieldset><legend>Personal target dates</legend><p class="hint">Calendar dates for your own plan, not official submission deadlines.</p><div data-dates></div><button type="button" data-add>Add target date</button></fieldset><p class="hint">Research details are saved separately from notes and files.</p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Save</button></footer></form>`;
  document.body.appendChild(dialog);
  const form = dialog.querySelector('form'), error = dialog.querySelector('[data-error]');
  const closeButton = dialog.querySelector('[data-close]');
  const progressInput = form.elements.progress;
  let acceptedProgress = '0';
  const validProgress = value => /^[0-9]{1,3}$/.test(value) && Number(value) <= 100;
  progressInput.addEventListener('input', () => {
    if (progressInput.value === '' || validProgress(progressInput.value)) {
      acceptedProgress = progressInput.value;
      error.textContent = '';
    } else {
      progressInput.value = acceptedProgress;
      error.textContent = 'Enter a whole number from 0 to 100.';
    }
  });

  let busy = false, baseline = '', revision, savedName = name;
  const values = () => ({name: form.elements.name.value.trim(), is_project: form.elements.is_project.value === 'true', goal: form.elements.goal.value, progress: Number(form.elements.progress.value), dates: [...form.querySelectorAll('[data-date-row]')].map(row => ({title: row.querySelector('[data-title]').value.trim(), date: row.querySelector('[data-date]').value}))});
  const dirty = () => baseline && JSON.stringify(values()) !== baseline;
  const close = () => { if (!busy && (!dirty() || confirm('Discard unsaved research details?'))) dialog.close(); };
  closeButton.onclick = close;
  dialog.querySelector('[data-cancel]').onclick = close;
  dialog.oncancel = event => { event.preventDefault(); close(); };
  const flushResearch = () => { if (busy || dirty()) throw Error('Save or discard the open research details before closing this tab.'); };
  window.flushCollectionResearch = flushResearch;
  const protectReload = event => { if (busy || dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', protectReload);
  dialog.addEventListener('close', () => { window.removeEventListener('beforeunload', protectReload); if (window.flushCollectionResearch === flushResearch) delete window.flushCollectionResearch; dialog.remove(); });
  dialog.showModal();
  const addDate = (date = {title: '', date: ''}) => {
    const row = document.createElement('div'); row.dataset.dateRow = '';
    row.innerHTML = `<label>Target<input data-title maxlength="300" required></label><label>Date<input data-date type="date" min="0001-01-01" max="9999-12-31" required></label><button type="button" data-remove aria-label="Remove target date">Remove</button>`;
    row.querySelector('[data-title]').value = date.title;
    row.querySelector('[data-date]').value = date.date;
    row.querySelector('[data-remove]').onclick = () => { row.remove(); updateAdd(); };
    form.querySelector('[data-dates]').appendChild(row); updateAdd();
  };
  const updateAdd = () => { form.querySelector('[data-add]').disabled = form.querySelectorAll('[data-date-row]').length >= 50; };
  form.querySelector('[data-add]').onclick = () => { addDate(); form.querySelector('[data-date-row]:last-child [data-title]').focus(); };
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || revision === undefined) return;
    if (!validProgress(progressInput.value)) { error.textContent = 'Enter a whole number from 0 to 100.'; progressInput.focus(); return; }
    if (!form.reportValidity()) return;
    const {name: nextName, ...details} = values();
    if (!nextName) { form.elements.name.focus(); return; }
    const payload = {revision, ...details};
    busy = true; error.textContent = '';
    const controls = [...dialog.querySelectorAll('button,input,textarea,select')];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try {
      const saved = await api(`/api/collections/${enc(target)}/research`, payload);
      if (!Number.isSafeInteger(saved.revision) || saved.revision <= revision) throw Error('The server did not confirm a saved revision. Your edits are still here; reopen Research details to check the saved version.');
      revision = saved.revision;
      if (nextName !== savedName) {
        try { await api('/api/library/rename', {target, name: nextName}); }
        catch (failure) { throw Error(`Research details saved, but rename failed: ${failure.message}`); }
        savedName = nextName;
      }
      baseline = ''; dialog.close(); await loadCollections(); toast('Research details saved');
    } catch (failure) { error.textContent = failure.message; }
    finally { busy = false; controls.forEach((control, i) => { control.disabled = disabled[i]; }); }
  };
  try {
    const state = await api(`/api/collections/${enc(target)}/research`);
    if (!dialog.isConnected) return;
    if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.dates)) throw Error('Unsupported research details response.');
    revision = state.revision;
    form.elements.name.value = name;
    form.elements.is_project.value = String(state.is_project ?? true);
    form.elements.goal.value = state.goal;
    form.elements.progress.value = state.progress;
    acceptedProgress = String(state.progress);
    state.dates.forEach(addDate);
    baseline = JSON.stringify(values());
    form.hidden = false; form.elements.goal.focus();
  } catch (failure) { error.textContent = failure.message; }
  finally { dialog.querySelector('[data-loading]')?.remove(); }
}

function openCollectionCreate(parent) {
  if (document.querySelector('.collection-create')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'workspace-dialog workspace-compact collection-create';
  dialog.setAttribute('aria-label', 'New folder or research project');
  dialog.innerHTML = `<header><strong>New folder</strong><button type="button" data-close data-icon="x" data-icon-only aria-label="Close"></button></header><form class="workspace-create"><label>Name<input name="name" maxlength="200" required autocomplete="off"></label><label>Type<select name="kind"><option value="folder">Folder</option><option value="project">Research project</option></select></label><p class="hint">Research projects track a goal, progress, and target dates.</p><p data-error class="workspace-error" role="alert"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Create</button></footer></form>`;
  let busy = false;
  const form = dialog.querySelector('form');
  const close = () => { if (!busy) dialog.close(); };
  dialog.querySelector('[data-close]').onclick = close;
  dialog.querySelector('[data-cancel]').onclick = close;
  dialog.oncancel = event => {event.preventDefault(); close();};
  dialog.addEventListener('close', () => dialog.remove());
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const name = form.elements.name.value.trim();
    if (!name) { form.elements.name.focus(); return; }
    const is_project = form.elements.kind.value === 'project';
    busy = true;
    dialog.querySelectorAll('button,input,select').forEach(control => control.disabled = true);
    try {
      const {id} = await api('/api/library/folder', {parent, name, is_project});
      lib.target = id; store.set('noctua.libTarget', id);
      lib.expanded.add(parent); store.set('noctua.expandedFolders', JSON.stringify([...lib.expanded]));
      dialog.close(); await loadCollections(); await loadLibItems();
      if (is_project) await openCollectionResearch(id);
    } catch (error) { dialog.querySelector('[data-error]').textContent = error.message; }
    finally { busy = false; dialog.querySelectorAll('button,input,select').forEach(control => control.disabled = false); }
  };
  document.body.appendChild(dialog); dialog.showModal(); form.elements.name.focus();
}
