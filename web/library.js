'use strict';
async function libraryRequest(path, method='GET', body) {
  const task = Symbol('library-request');
  const timer = setTimeout(() => notifyProgress(task, method === 'GET' ? 'Loading paper…' : 'Updating library…'), 250);
  try {
    const raw = body instanceof Blob;
    const r = await fetch(path, {method, headers: body === undefined ? {} : {'Content-Type':raw ? body.type || 'application/pdf' : 'application/json'}, body:body === undefined ? undefined : raw ? body : JSON.stringify(body)});
    const data = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } finally { clearTimeout(timer); notifyProgress(task, null); }
}
const paperURL = key => '/api/library/papers/' + enc(key);
function choosePDFs(multiple=false) {
  return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept='application/pdf,.pdf';input.multiple=multiple;input.onchange=()=>resolve([...input.files]);input.oncancel=()=>resolve([]);input.click();});
}
async function openPaperView(key, disposition='here', options={}) {
  const url = '/#pdf='+enc(key)+'&page='+(options.page || 1);
  try {
    if(disposition==='here') return await openPDF(key,options);
    if(disposition==='tab' && window.parent!==window && window.parent.noctuaShell) return window.parent.noctuaShell.openTab(url);
    if(disposition==='window') {
      if(settings?.desktop) return await api('/api/desktop/window',{url});
      const width=Math.min(1280,window.screen?.availWidth || 1280);
      const height=Math.min(900,window.screen?.availHeight || 900);
      window.open(url,'_blank',`popup=yes,width=${width},height=${height},noopener`);
      return;
    }
    window.open(url,'_blank','noopener');
  } catch(e){toast(e.message);}
}
async function readDiscoveredPaper(p,disposition) {
  try {const saved=await api('/api/library/add',{paper:p,target:lib.target || 'L1',attach_pdf:true});await loadCollections();await loadLibItems();if(saved.paper?.has_pdf)await openPaperView(saved.key,disposition);else toast(saved.warning || 'Paper saved. Attach a PDF from its library details.');}catch(e){toast(e.message);}
}
function paperInfoIcon(kind){
  const paths={library:'<path d="m16 6 4 14M12 6v14M8 8v12M4 4v16"/>',folder:'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',tag:'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',chevron:'<path d="m18 15-6-6-6 6"/>'};
  return `<svg class="paper-info-icon ${kind==='chevron'?'paper-info-chevron':''}" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
}
function libraryPaperActions(el,it) {
  const box=el.querySelector('.paper-primary-actions'), graph=box.querySelector('#act-lib-graph');
  graph.remove();
  const actionIcons={'Read PDF':'file-text','New tab':'external-link','New window':'app-window','Attach PDF':'paperclip','Download PDF':'download','Edit details':'pencil','Delete paper':'trash-2','Add to collection':'folder-plus','Remove from collection':'folder-minus'};
  const button=(label,fn,{iconOnly=false,parent=box}={})=>{
    const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.icon=actionIcons[label];b.setAttribute('aria-label',label);
    if(parent===box)b.dataset.label=label==='Edit details'?'Edit':label;
    if(iconOnly){b.setAttribute('data-icon-only','');b.setAttribute('aria-label',label);if(parent!==box)b.title=label;}
    b.onclick=()=>Promise.resolve().then(fn).catch(e=>toast(e.message));parent.append(b);return b;
  };
  if(it.has_pdf){
    button('Read PDF',()=>openPaperView(it.key)).className='paper-read-button';
    button('New tab',()=>openPaperView(it.key,'tab'),{iconOnly:true});
    button('New window',()=>openPaperView(it.key,'window'),{iconOnly:true});
  } else {
    button('Attach PDF',async()=>{const [file]=await choosePDFs();if(!file)return;await libraryRequest(paperURL(it.key)+'/pdf','PUT',file);await loadLibItems();await openPaperView(it.key);}).className='paper-read-button';
    if(it.pdf_url)button('Download PDF',async()=>{await api(paperURL(it.key)+'/download',{});await loadLibItems();await openPaperView(it.key);},{iconOnly:true});
  }
  box.append(graph);
  button('Edit details',()=>editLibraryPaper(it.key),{iconOnly:true});
  button('Delete paper',()=>confirmDeleteLibraryPaper(it),{iconOnly:true}).className='paper-delete-action';
  const membership=el.querySelector('.paper-collection-tools');
  const libraries=document.createElement('details');libraries.open=true;libraries.className='paper-info-section paper-info-libraries';
  libraries.innerHTML=`<summary>${paperInfoIcon('library')}<span>Libraries and Collections</span>${paperInfoIcon('chevron')}</summary>`;membership.append(libraries);
  const assigned=document.createElement('div');assigned.className='paper-assigned-collections';assigned.setAttribute('aria-label','Libraries and Collections');assigned.setAttribute('aria-live','polite');libraries.append(assigned);
  renderPaperCollections(assigned,it.key);
  const tags=document.createElement('details');tags.open=true;tags.className='paper-info-section paper-info-tags';tags.setAttribute('aria-label','Paper tags');
  const values=[...new Set((it.tags||[]).filter(tag=>typeof tag==='string'&&tag.trim()))];
  tags.innerHTML=`<summary>${paperInfoIcon('tag')}<span>${values.length} Tags</span>${paperInfoIcon('chevron')}</summary>`+(values.length?'<ul>'+values.map(tag=>`<li>${paperInfoIcon('tag')}<span>${esc(tag)}</span></li>`).join('')+'</ul>':'<p class="hint">No tags</p>');membership.after(tags);
  addPaperTagEditor(tags,it,values);

  const label=document.createElement('label');label.className='paper-collection-label';label.htmlFor='paper-collection-target';label.textContent='Collection';
  const row=document.createElement('div');row.className='paper-collection-row';
  const select=document.createElement('select');select.id='paper-collection-target';select.setAttribute('aria-label','Collection');select.innerHTML=collectionOptions(lib.target);
  row.append(select);libraries.append(label,row);
  button('Add to collection',async()=>{await api(paperURL(it.key)+'/membership',{target:select.value});await loadCollections();await loadLibItems();await renderPaperCollections(assigned,it.key);},{iconOnly:true,parent:row});
  const remove=button('Remove from collection',async()=>{const target=select.value;if(target==='L1')return;await api(paperURL(it.key)+'/membership',{target,remove:true});await loadCollections();await loadLibItems();await renderPaperCollections(assigned,it.key);},{iconOnly:true,parent:row});remove.className='paper-remove-action';
  const syncRemove=()=>{remove.disabled=select.value==='L1';remove.title=remove.disabled?'Library always contains every paper':`Remove from ${targetName(select.value)||'selected collection'}`;};select.addEventListener('change',syncRemove);syncRemove();
}
function addPaperTagEditor(section,paper,assigned){
  const form=document.createElement('form');form.className='paper-tag-editor';
  form.innerHTML='<div class="paper-tag-input-row"><input type="text" aria-label="Add tag" placeholder="Add a tag" autocomplete="off"><button type="submit" data-icon="plus" aria-label="Add tag" title="Add tag" data-icon-only> Add </button></div><div class="paper-tag-suggestions" aria-label="Existing tags" hidden></div><p class="paper-tag-error" role="alert"></p>';
  section.append(form);
  const input=form.querySelector('input'),list=form.querySelector('.paper-tag-suggestions'),button=form.querySelector('button'),error=form.querySelector('.paper-tag-error');
  let existing=[],loaded=false,loading=null;
  const render=()=>{
    const q=input.value.trim().toLocaleLowerCase();
    const matches=existing.filter(tag=>!assigned.includes(tag)&&tag.toLocaleLowerCase().includes(q));
    list.replaceChildren();
    for(const tag of matches){const choice=document.createElement('button');choice.type='button';choice.textContent=tag;choice.addEventListener('click',()=>save(tag));list.append(choice);}
    list.hidden=!matches.length||document.activeElement!==input;
  };
  input.addEventListener('focus',async()=>{
    if(!loaded){
      if(!loading)loading=api('/api/library/items?target=L1').then(items=>{existing=[...libraryTagCounts(items).keys()].sort((a,b)=>a.localeCompare(b));loaded=true;}).catch(e=>{error.textContent=e.message;}).finally(()=>{loading=null;});
      await loading;
    }
    render();
  });
  input.addEventListener('input',()=>{error.textContent='';render();});
  input.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!list.hidden){e.preventDefault();e.stopPropagation();list.hidden=true;}
    else if(e.key==='ArrowDown'&&!list.hidden){e.preventDefault();list.querySelector('button')?.focus();}
  });
  list.addEventListener('keydown',e=>{
    const choices=[...list.querySelectorAll('button')],index=choices.indexOf(document.activeElement);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();(choices[index+(e.key==='ArrowDown'?1:-1)]||input).focus();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();input.focus();list.hidden=true;}
  });
  form.addEventListener('focusout',()=>setTimeout(()=>{if(!form.contains(document.activeElement))list.hidden=true;},0));
  async function save(value){
    const tag=value.trim();if(!tag||button.disabled)return;
    button.disabled=true;error.textContent='';
    try{
      const current=await api(paperURL(paper.key));
      const tags=[...new Set([...(current.tags||[]),tag])];
      const saved=tags.length===(current.tags||[]).length?current:await libraryRequest(paperURL(paper.key),'PUT',{revision:current.revision,tags});
      if(lib.detail?.key===paper.key)lib.detail=saved;
      if(typeof PDF!=='undefined'&&PDF.paper?.key===paper.key)PDF.paper=saved;
      await loadLibItems();
      if(lib.detail?.key===paper.key||(typeof PDF!=='undefined'&&PDF.paper?.key===paper.key))renderDetails();
    }catch(e){error.textContent=e.message;button.disabled=false;}
  }
  form.addEventListener('submit',e=>{e.preventDefault();save(input.value);});
}
async function editLibraryPaper(key){
  const p=await api(paperURL(key));const dialog=document.createElement('dialog');dialog.className='paper-editor';
  const fields=['title','creators','year','DOI','arxiv','venue','pdf_url','abstractNote','tags'];
  dialog.innerHTML='<form method="dialog"><h2>Paper details</h2>'+fields.map(k=>`<label>${esc(k==='creators'?'Authors (one per line)':k)}<textarea name="${k}">${esc(k==='creators'||k==='tags'?(p[k]||[]).join('\n'):p[k])}</textarea></label>`).join('')+'<p class="error"></p><button type="button" data-cancel data-icon="x">Cancel</button> <button type="submit" data-icon="save">Save</button></form>';
  document.body.append(dialog);dialog.showModal();dialog.onclose=()=>dialog.remove();dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
  dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const b={revision:p.revision};for(const k of fields)b[k]=dialog.querySelector(`[name="${k}"]`).value;b.creators=b.creators.split('\n').map(s=>s.trim()).filter(Boolean);b.tags=[...new Set(b.tags.split('\n').map(s=>s.trim()).filter(Boolean))];b.year=b.year?Number(b.year):null;try{const saved=await libraryRequest(paperURL(key),'PUT',b);if(lib.detail?.key===key)lib.detail=saved;if(typeof PDF!=='undefined'&&PDF.paper?.key===key)PDF.paper=saved;renderDetails();dialog.close();await loadLibItems();}catch(e){dialog.querySelector('.error').textContent=e.message;}};
}
async function importLibraryPDF(target = lib.target || 'L1', pastedFiles) {
  try {
    const files = pastedFiles || await choosePDFs(true); if (!files.length) return;
    let last;
    for (const file of files) {
      toast('Importing ' + file.name);
      last = await libraryRequest('/api/library/import-pdf?target=' + enc(target) + '&name=' + enc(file.name), 'POST', file);
    }
    await loadCollections(); await loadLibItems();
    if (last) await openPaperView(last.key);
  } catch (e) { toast(e.message); }
}
async function importZoteroLibrary() {
  if(document.querySelector('#zotero-import-dialog'))return;
  const dialog=document.createElement('dialog');dialog.id='zotero-import-dialog';dialog.className='paper-editor zotero-import';
  dialog.setAttribute('aria-labelledby','zotero-import-title');
  const choices=[['bibliography','Detailed bibliography'],['tags','Tags'],['copy_pdfs','Local PDFs'],['copy_notes','Notes'],['copy_annotations','PDF annotations']];
  const pdfMode=typeof settings!=='undefined'&&settings?.zotero_pdf_mode==='copy'?'copy':'link';
  dialog.innerHTML=`<form><h2 id="zotero-import-title">Import from Zotero</h2>
    <p class="zotero-intro">Collections and basic paper information are always included.</p>
    <fieldset class="zotero-choices"><legend>Include</legend>${choices.map(([name,label])=>`<label><input type="checkbox" name="${name}" checked> ${label}</label>`).join('')}</fieldset>
    <div class="zotero-settings">
      <label>PDF storage <select name="pdf_mode"><option value="link"${pdfMode==='link'?' selected':''}>Link original</option><option value="copy"${pdfMode==='copy'?' selected':''}>Copy to Noctua</option></select></label>
      <label>Existing items <select name="import_mode"><option value="sync">Sync changes</option><option value="overwrite">Overwrite from Zotero</option></select></label>
    </div>
    <p class="zotero-mode-hint" aria-live="polite"></p>
    <p class="zotero-hint">Close Zotero first for the freshest snapshot.</p>
    <details class="zotero-help"><summary>About these options</summary>
      <p>Link original reads PDFs from their existing paths; keep those files available. Copy to Noctua stores independent files.</p>
      <p>Notes become text notes. PDF annotations require the matching local PDF; only one PDF per paper is imported.</p>
      <p>Sync keeps local edits and reports conflicts. Overwrite replaces selected paper fields, note content, and imported annotation fields with Zotero values. Neither mode deletes Noctua-only items or replaces a different PDF.</p>
    </details>
    <p class="error" role="alert"></p><div class="zotero-actions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Import</button></div></form>`;
  document.body.append(dialog);dialog.showModal();dialog.onclose=()=>dialog.remove();
  const form=dialog.querySelector('form'),submit=form.querySelector('[type="submit"]');let busy=false;
  const modeHint=()=>{form.querySelector('.zotero-mode-hint').textContent=form.elements.import_mode.value==='overwrite'?'Overwrite replaces selected imported content with Zotero values.':'Sync keeps local edits and reports conflicts.';};
  form.elements.import_mode.onchange=modeHint;modeHint();
  dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  form.elements.copy_annotations.onchange=()=>{if(form.elements.copy_annotations.checked)form.elements.copy_pdfs.checked=true;form.elements.pdf_mode.disabled=!form.elements.copy_pdfs.checked;};
  form.elements.copy_pdfs.onchange=()=>{if(!form.elements.copy_pdfs.checked)form.elements.copy_annotations.checked=false;form.elements.pdf_mode.disabled=!form.elements.copy_pdfs.checked;};
  form.onsubmit=async e=>{
    e.preventDefault();if(busy)return;busy=true;
    const body=Object.fromEntries(choices.map(([name])=>[name,form.elements[name].checked]));
    body.pdf_mode=form.elements.pdf_mode.value;
    body.import_mode=form.elements.import_mode.value;
    form.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);submit.textContent='Importing…';
    form.querySelector('.error').textContent='';
    try{
      const result=await api('/api/library/import-zotero',body);
      let preferenceError=null;
      if(body.copy_pdfs) {
        try { await api('/api/settings/zotero-pdf',{pdf_mode:body.pdf_mode}); if(typeof settings!=='undefined' && settings) settings.zotero_pdf_mode=body.pdf_mode; }
        catch(error) { preferenceError=error; }
      }
      await loadCollections();await loadLibItems();
      dialog.close();toast(`Import complete: ${result.papers} papers, ${result.linked_pdfs||0} linked PDFs, ${result.pdfs} copied PDFs, ${result.notes} notes, ${result.annotations} annotations, ${result.conflicts||0} conflicts kept locally.`);
      if(result.warnings?.length)toast(result.warnings.join('\n'));
      if(preferenceError)toast('Import completed, but the PDF storage choice could not be saved: '+preferenceError.message);
    }catch(error){form.querySelector('.error').textContent=error.message;}
    finally{busy=false;form.querySelectorAll('input,select,button').forEach(el=>el.disabled=false);form.elements.pdf_mode.disabled=!form.elements.copy_pdfs.checked;submit.textContent='Import';}
  };
}

// Preserve the selected destination throughout a mixed clipboard import.
let clipboardImportBusy = false;
async function importClipboardFiles(target, files) {
  if (clipboardImportBusy) { toast('A clipboard import is already running.'); return; }
  clipboardImportBusy = true;
  let completed = 0, projectFiles = 0;
  try {
    for (const file of files) {
      toast('Importing ' + file.name);
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        await libraryRequest('/api/library/import-pdf?target=' + enc(target) + '&name=' + enc(file.name), 'POST', file);
      } else {
        if (file.size > 32 * 1024 * 1024) throw Error(`${file.name} exceeds the 32 MB project-file limit.`);
        const manifest = await api('/api/workspaces/' + enc(target));
        await libraryRequest('/api/workspaces/' + enc(target) + '/upload?name=' + enc(file.name) + '&revision=' + manifest.revision, 'POST', file);
        projectFiles++;
      }
      completed++;
    }
    await loadCollections(); await loadLibItems();
    if (projectFiles) toast(`Imported ${completed} file(s). General files are in Notes → Project files.`);
    else toast(`Imported ${completed} PDF file(s).`);
  } catch (error) {
    toast(`Imported ${completed} of ${files.length} files. ${error.message} Remaining files were not imported.`, {error:true});
    if (completed) { await loadCollections(); await loadLibItems(); }
  } finally { clipboardImportBusy = false; }
}
// Let the native clipboard shortcut deliver files; preserve text editing and chat paste.
document.addEventListener('paste', event => {
  if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest('input,textarea,[contenteditable="true"],dialog')) return;
  if (!event.target.closest('#lib-tree,#library-view,#tab-library,#tab-nodes')) return;
  if(lib.trash||event.target.closest('[data-library-trash]'))return;
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  importClipboardFiles(lib.target || 'L1', files);
});

async function confirmDeleteLibraryPaper(item) {
  const items=Array.isArray(item)?item:[item];
  item=items[0];
  if(!item)return;
  if (document.querySelector('.library-delete-dialog')) return;
  const dialog=document.createElement('dialog');
  dialog.className='workspace-dialog workspace-compact library-delete-dialog';
  dialog.setAttribute('aria-labelledby','library-delete-title');
  dialog.innerHTML=`<header><strong id="library-delete-title">Delete paper?</strong></header><form class="workspace-create"><p>Move ${items.length>1?items.length+' papers':'“'+esc(item.title || '(untitled)')+'”'} to Library trash? Papers, annotations, and collection memberships can be restored.</p><p class="workspace-error" role="alert"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Delete</button></footer></form>`;
  document.body.append(dialog);dialog.onclose=()=>dialog.remove();let busy=false;
  const cancel=()=>{if(!busy)dialog.close();};dialog.querySelector('[data-cancel]').onclick=cancel;
  dialog.oncancel=e=>{e.preventDefault();cancel();};
  dialog.querySelector('form').onsubmit=async e=>{
    e.preventDefault();if(busy)return;busy=true;
    const buttons=[...dialog.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try {
      if(items.length===1)await libraryRequest(paperURL(item.key),'DELETE',{revision:item.revision});
      else await libraryManage({op:'trash',papers:paperVersions(items)});
      if(items.some(p=>p.key===lib.detail?.key)){lib.detail=null;renderDetails();}
      if(items.some(p=>p.key===G.libKey))G.libKey=null;
      await loadCollections();await loadLibItems();dialog.close();toast('Moved to Library trash. Use Undo delete or Trash to restore.');
    }catch(error){dialog.querySelector('[role="alert"]').textContent=error.message;}
    finally{busy=false;buttons.forEach(b=>b.disabled=false);}
  };
  dialog.showModal();dialog.querySelector('[type="submit"]').focus();
}
document.addEventListener('keydown',event=>{
  if(event.isComposing||event.repeat||!['Delete','Backspace'].includes(event.key)||event.metaKey||event.ctrlKey||event.altKey)return;
  if(!(event.target instanceof Element)||event.target.closest('input,textarea,[contenteditable="true"],dialog'))return;
  const row=event.target.closest('#library-rows [data-key],#lib-items [data-key]');
  if(!row)return;
  const item=lib.items.find(item=>item.key===row.dataset.key);if(!item)return;
  event.preventDefault();confirmDeleteLibraryPaper(lib.selected?.has(item.key)?selectedLibraryPapers():item);
});

const libraryClipboardType='application/x-noctua-library';
let libraryUndo=null;
const paperVersions=items=>items.map(({key,revision})=>({key,revision}));
const selectedLibraryPapers=()=> (lib.items||[]).filter(item=>lib.selected?.has(item.key));
async function libraryManage(body){
  const state=await api('/api/library/manage');
  const result=await api('/api/library/manage',{revision:state.revision,...body});
  if(result.undo)libraryUndo=result.undo;
  return result;
}
async function refreshLibraryManagement(){
  if(lib.detail){try{lib.detail=await api(paperURL(lib.detail.key));}catch{lib.detail=null;}renderDetails();}
  if(typeof PDF!=='undefined'&&PDF.paper){try{PDF.paper=await api(paperURL(PDF.paper.key));}catch{}if(document.body.classList.contains('pdf-mode'))renderDetails();}
  await loadCollections();await loadLibItems();updateLibrarySelection();
}
function selectLibraryPaper(event,item,row){
  const rows=[...row.parentElement.querySelectorAll('[data-key]')],ids=rows.map(row=>row.dataset.key);
  if(event.shiftKey&&ids.includes(lib.anchor)){
    if(!event.ctrlKey&&!event.metaKey)lib.selected.clear();
    const a=ids.indexOf(lib.anchor),b=ids.indexOf(item.key);ids.slice(Math.min(a,b),Math.max(a,b)+1).forEach(key=>lib.selected.add(key));
  }else if(event.ctrlKey||event.metaKey){if(!lib.selected.delete(item.key))lib.selected.add(item.key);lib.anchor=item.key;}
  else{lib.selected=new Set([item.key]);lib.anchor=item.key;}
  const selection=new Set(lib.selected);showLibItem(item);lib.selected=selection;updateLibrarySelection();
}
function updateLibrarySelection(){
  document.querySelectorAll('#library-rows [data-key],#lib-items [data-key]').forEach(row=>{const selected=!!lib.selected?.has(row.dataset.key);row.classList.toggle('selected',selected);row.setAttribute('aria-selected',String(selected));});

}
function managementDialog(title,body){
  const d=document.createElement('dialog');d.className='workspace-dialog workspace-compact library-management-dialog';d.setAttribute('aria-label',title);
  d.innerHTML=`<header><strong>${esc(title)}</strong><button type="button" data-close data-icon="x" data-icon-only aria-label="Close"></button></header>${body}`;
  document.body.append(d);d.onclose=()=>d.remove();d.querySelector('[data-close]').onclick=()=>d.close();d.showModal();return d;
}
function managementForm(title,body,submit,action){
  const d=managementDialog(title,`<form class="workspace-create">${body}<p class="workspace-error" role="alert"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">${esc(submit)}</button></footer></form>`);
  d.querySelector('[data-cancel]').onclick=()=>d.close();let busy=false;
  d.oncancel=event=>{if(busy)event.preventDefault();};
  d.querySelector('form').onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;const controls=[...d.querySelectorAll('button,input,select,textarea')];controls.forEach(c=>c.disabled=true);
    try{await action(d.querySelector('form'));await refreshLibraryManagement();d.close();}catch(error){d.querySelector('[role="alert"]').textContent=error.message;}finally{busy=false;controls.forEach(c=>c.disabled=false);}};
  return d;
}
function renderLibraryManagement(){
  document.getElementById('library-management')?.remove();
  renderLibraryTagPanel();
  updateLibrarySelection();
}
function openLibrarySelectionMenu(items){
  if(!items.length)return;
  const d=managementDialog('Selected papers',`<p>${items.length} selected</p><div class="library-selection-actions"><button type="button" data-batch-tags data-icon="pencil">Edit tags</button><button type="button" data-batch-remove data-icon="folder-minus" ${lib.target==='L1'?'disabled':''}>Remove from this collection</button></div>`);
  d.querySelector('[data-batch-tags]').onclick=()=>{d.close();openLibraryTags(items);};
  const target=lib.target;
  d.querySelector('[data-batch-remove]').onclick=()=>{d.close();managementForm('Remove from collection',`<p>Remove ${items.length} papers from ${esc(targetName(target))}? Papers remain in Library.</p>`,'Remove',()=>libraryManage({op:'membership',mode:'remove',target,papers:paperVersions(items)}));};
}
document.addEventListener('contextmenu',event=>{
  if(!(event.target instanceof Element)||event.target.closest('input,textarea,[contenteditable="true"],dialog'))return;
  const row=event.target.closest('#library-rows [data-key],#lib-items [data-key]');if(!row)return;
  event.preventDefault();
  if(!lib.selected.has(row.dataset.key)){lib.selected=new Set([row.dataset.key]);updateLibrarySelection();}
  openLibrarySelectionMenu(selectedLibraryPapers());
});

function openLibraryTags(items){
  managementForm('Edit tags',`<label>Action<select name="mode"><option value="add">Add tags</option><option value="remove">Remove tags</option></select></label><label>Tags<textarea name="tags" required placeholder="One tag per line"></textarea></label><p>Apply to ${items.length} selected papers. Existing tags: ${esc([...new Set(items.flatMap(item=>item.tags||[]))].join(', ')||'none')}</p>`,'Apply',form=>libraryManage({op:'tags',papers:paperVersions(items),mode:form.elements.mode.value,tags:[...new Set(form.elements.tags.value.split('\n').map(t=>t.trim()).filter(Boolean))]}));
}
async function undoLibraryDelete(){
  const state=await api('/api/library/manage');const id=libraryUndo||state.undo;if(!id){toast('Nothing to undo');return;}
  await libraryManage({op:'undo',id});libraryUndo=null;await refreshLibraryManagement();toast('Deletion undone');
}
let libraryTrashLoad=0;
async function openLibraryTrash(){
  if(typeof setLayout==='function'&&G.layout!=='library')setLayout('library');
  lib.trash=true;lib.selected?.clear();document.body.classList.add('library-trash-view');
  if(typeof renderLibTree==='function')renderLibTree();
  const token=++libraryTrashLoad;
  let view=document.getElementById('library-trash-view');if(!view){view=document.createElement('section');view.id='library-trash-view';view.setAttribute('aria-label','Library trash');document.getElementById('library-view').append(view);}
  const title=document.getElementById('library-title'),count=document.getElementById('library-count');if(title)title.textContent='Trash';if(count)count.textContent='';
  view.innerHTML='<p class="hint">Loading trash…</p>';
  try{
    const state=await api('/api/library/manage');if(!lib.trash||token!==libraryTrashLoad)return;
    if(count)count.textContent=`${state.trash.length} items`;
    const selected=new Set();let anchor=null;
    view.innerHTML=`<div class="trash-actions"><button type="button" data-restore data-icon="undo-2" disabled>Restore</button></div><table class="library-trash-table"><thead><tr><th>Title</th><th>Authors</th><th>Year</th><th>Publication / Type</th></tr></thead><tbody>${state.trash.map((entry,index)=>`<tr tabindex="0" data-trash-index="${index}" aria-selected="false"><td><button type="button" class="library-paper-title">${esc(entry.data.title||entry.data.name)}</button></td><td>${esc((entry.data.creators||[]).join(', ')||'—')}</td><td>${esc(entry.data.year||'—')}</td><td>${esc(entry.data.venue||entry.kind)}${entry.merged_into?' · merged':''}</td></tr>`).join('')}</tbody></table>${state.trash.length?'':'<p class="hint">Trash is empty.</p>'}<p role="alert" class="workspace-error"></p>`;
    const chosen=()=>[...selected].map(index=>state.trash[index]);
    const update=()=>{view.querySelectorAll('[data-trash-index]').forEach(row=>{const active=selected.has(Number(row.dataset.trashIndex));row.classList.toggle('selected',active);row.setAttribute('aria-selected',String(active));});view.querySelector('[data-restore]').disabled=!selected.size||chosen().some(entry=>entry.merged_into);};
    const purge=()=>{const entries=chosen();if(!entries.length)return;const d=managementForm('Permanently delete?',`<p>Permanently delete ${entries.length===1?'“'+esc(entries[0].data.title||entries[0].data.name)+'”':entries.length+' items'}?</p><p>This cannot be undone. Paper annotations and folder project files will be removed. External original PDFs are preserved.</p>`,'Delete permanently',async()=>{const result=await libraryManage({op:'purge',entries:entries.map(({id,kind})=>({id,kind}))});if(result.warnings?.length)toast(result.warnings.join(' '),{error:true});});d.querySelector('[type="submit"]').focus();};
    view.querySelectorAll('[data-trash-index]').forEach(row=>{
      row.onclick=event=>{const index=Number(row.dataset.trashIndex);if(event.shiftKey&&anchor!==null){if(!event.metaKey&&!event.ctrlKey)selected.clear();for(let i=Math.min(anchor,index);i<=Math.max(anchor,index);i++)selected.add(i);}else if(event.metaKey||event.ctrlKey){if(!selected.delete(index))selected.add(index);anchor=index;}else{selected.clear();selected.add(index);anchor=index;}update();row.focus();};
      row.onkeydown=event=>{if(event.isComposing)return;if(['Delete','Backspace'].includes(event.key)&&!event.metaKey&&!event.ctrlKey){event.preventDefault();if(!selected.has(Number(row.dataset.trashIndex))){selected.clear();selected.add(Number(row.dataset.trashIndex));update();}purge();}else if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a'){event.preventDefault();state.trash.forEach((_,index)=>selected.add(index));update();}else if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click();}};
      row.oncontextmenu=event=>{event.preventDefault();if(!selected.has(Number(row.dataset.trashIndex))){selected.clear();selected.add(Number(row.dataset.trashIndex));update();}const d=managementDialog('Trash actions','<div class="library-selection-actions"><button type="button" data-trash-menu-restore data-icon="undo-2">Restore</button><button type="button" data-trash-menu-delete data-icon="trash-2">Delete permanently</button></div>');d.querySelector('[data-trash-menu-restore]').disabled=chosen().some(entry=>entry.merged_into);d.querySelector('[data-trash-menu-restore]').onclick=()=>{d.close();view.querySelector('[data-restore]').click();};d.querySelector('[data-trash-menu-delete]').onclick=()=>{d.close();purge();};};
    });
    let busy=false;view.querySelector('[data-restore]').onclick=async()=>{if(busy)return;busy=true;try{const entries=chosen();if(!entries.length)return;for(const kind of ['collection','paper']){const ids=entries.filter(entry=>entry.kind===kind).map(entry=>entry.id);if(ids.length)await libraryManage({op:'restore',kind,ids});}await refreshLibraryManagement();}catch(error){view.querySelector('[role="alert"]').textContent=error.message;}finally{busy=false;}};

  }catch(error){if(lib.trash&&token===libraryTrashLoad)view.textContent=error.message;}
}

let closeLibraryFolderMenu=null;
function confirmDeleteLibraryFolder(target){
  const entry=collections.targets.find(entry=>entry.id===target);if(!entry||target==='L1')return;
  const d=managementForm('Delete folder?',`<p>Move “${esc(entry.name)}” and its subfolders to Library trash? Papers remain in Library. Files are preserved.</p>`,'Delete',async()=>{
    await libraryManage({op:'folder_trash',target});
    const descendants=new Set([target]);for(let changed=true;changed;){changed=false;for(const entry of collections.targets)if(descendants.has(entry.parent)&&!descendants.has(entry.id)){descendants.add(entry.id);changed=true;}}
    if(descendants.has(lib.target))lib.target='L1';
  });d.querySelector('[type="submit"]').focus();
}
// Notes appear beside papers in the Library table. Notes have no tags, so a
// tag filter lists papers only; the text filter matches note titles.
function libraryTableRows(papers,notes,{kind='all',tag='',filter=''}={}){
  const query=filter.trim().toLowerCase();
  const noteRows=kind==='papers'||tag||!Array.isArray(notes)?[]:notes.map(n=>({kind:'note',key:'note:'+n.id,id:n.id,title:n.title||'Untitled note',creators:[],year:n.updated?new Date(n.updated).getFullYear():'',dateAdded:n.updated?new Date(n.updated).toISOString():'',updated:n.updated}))
    .filter(n=>!query||n.title.toLowerCase().includes(query));
  return [...(kind==='notes'?[]:papers),...noteRows];
}
function setLibraryKind(kind){
  lib.kind=['papers','notes'].includes(kind)?kind:'all';store.set('noctua.libKind',lib.kind);
  document.querySelectorAll('#library-kind [data-kind]').forEach(b=>{b.classList.toggle('active',b.dataset.kind===lib.kind);b.setAttribute('aria-pressed',String(b.dataset.kind===lib.kind));});
  if(typeof renderLibItems==='function')renderLibItems();
}
document.querySelectorAll('#library-kind [data-kind]').forEach(b=>b.addEventListener('click',()=>setLibraryKind(b.dataset.kind)));
if(typeof lib!=='undefined'&&document.querySelector('#library-kind'))setLibraryKind(lib.kind);
document.querySelector('#library-new-note')?.addEventListener('click',()=>createNoteIn(lib.target));

function openLibraryFolderMenu(target,anchor,event={}){
  closeLibraryFolderMenu?.(false);
  if(!collections.targets.some(entry=>entry.id===target))return;
  const menu=document.createElement('div');menu.className='library-folder-menu';menu.setAttribute('popover','manual');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Collection actions');
  menu.innerHTML=`<button type="button" role="menuitem" data-folder-action="edit" data-icon="pencil" ${target==='L1'?'disabled':''}>Edit collection</button><button type="button" role="menuitem" data-folder-action="note" data-icon="file-plus">New note</button><button type="button" role="menuitem" data-folder-action="new" data-icon="folder-plus">New folder</button><button type="button" role="menuitem" data-folder-action="delete" data-icon="trash-2" ${target==='L1'?'disabled':''}>Delete folder</button>`;
  const controller=new AbortController();
  const close=(restoreFocus=true)=>{if(!menu.isConnected)return;controller.abort();if(menu.matches(':popover-open'))menu.hidePopover();menu.remove();if(closeLibraryFolderMenu===close)closeLibraryFolderMenu=null;if(restoreFocus&&anchor?.isConnected)anchor.focus();};
  closeLibraryFolderMenu=close;
  document.body.append(menu);if(menu.showPopover)menu.showPopover();else menu.removeAttribute('popover');
  const rect=anchor?.getBoundingClientRect()||{left:8,bottom:8};
  const x=event.clientX||rect.left,y=event.clientY||rect.bottom,box=menu.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(x,window.innerWidth-box.width-8))+'px';menu.style.top=Math.max(8,Math.min(y,window.innerHeight-box.height-8))+'px';
  const buttons=[...menu.querySelectorAll('button:not(:disabled)')];buttons[0]?.focus();
  menu.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key==='Tab'){close(false);return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const i=buttons.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();
  },{signal:controller.signal});
  menu.querySelectorAll('[data-folder-action]').forEach(button=>button.onclick=()=>{const action=button.dataset.folderAction;close(false);if(action==='edit')openCollectionResearch(target);else if(action==='note')createNoteIn(target);else if(action==='new')openCollectionCreate(target);else confirmDeleteLibraryFolder(target);});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))close(false);},{signal:controller.signal,capture:true});
  menu.addEventListener('toggle',event=>{if(event.newState==='closed')close(false);},{signal:controller.signal});
}

function duplicateLibraryPairs(items){
  const normalize=value=>(value||'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const pairs=[],indexes=new Map(),seen=new Set();
  for(const paper of items){const title=normalize(paper.title);const tokens=[paper.DOI&&'doi:'+paper.DOI.trim().toLowerCase(),paper.arxiv&&'arxiv:'+paper.arxiv.toLowerCase(),paper.pdf_hash&&'pdf:'+paper.pdf_hash,title.length>12&&'title:'+title].filter(Boolean);
    for(const token of tokens){for(const other of indexes.get(token)||[]){const id=[other.key,paper.key].sort().join(':');if(!seen.has(id)){seen.add(id);pairs.push([other,paper]);}}const list=indexes.get(token)||[];list.push(paper);indexes.set(token,list);}}
  return pairs;
}
async function openLibraryDuplicates(){
  const papers=await api('/api/library/items?target=L1'),pairs=duplicateLibraryPairs(papers);
  const d=managementDialog('Review duplicate papers',`<p>Matches use DOI, arXiv, identical PDF, or normalized title. Review each pair; the retained paper keeps its existing metadata, fills empty fields, and combines tags, citation aliases, memberships and annotations. Different PDFs cannot be merged.</p><div class="library-duplicate-list">${pairs.map(([a,b],i)=>`<section><p>${esc(a.title)} <small>${esc(a.key)}</small><br>${esc(b.title)} <small>${esc(b.key)}</small></p><label>Keep<select data-keep="${i}"><option value="${esc(a.key)}">${esc(a.title)} · ${esc(a.key)}</option><option value="${esc(b.key)}">${esc(b.title)} · ${esc(b.key)}</option></select></label><button data-review="${i}">Review merge</button></section>`).join('')||'<p>No duplicate candidates found.</p>'}</div>`);
  d.querySelectorAll('[data-review]').forEach(button=>button.onclick=()=>{
    const index=Number(button.dataset.review),pair=pairs[index],target=pair.find(p=>p.key===d.querySelector(`[data-keep="${index}"]`).value),source=pair.find(p=>p.key!==target.key);
    const confirm=managementForm('Merge duplicate papers?',`<p>Keep “${esc(target.title)}” (${esc(target.key)}) and merge “${esc(source.title)}” (${esc(source.key)}) into it?</p><p>The source record is archived in trash. Its annotations move to the retained paper. This merge cannot be undone from Trash.</p>`,'Merge',async()=>{await libraryManage({op:'merge',target:target.key,source:source.key,target_revision:target.revision,source_revision:source.revision});d.close();});
    confirm.querySelector('[type="submit"]').focus();
  });
}
function libraryClipboardPayload(kind,extra){return {version:1,token:crypto.randomUUID(),server:window.noctuaServerId||location.origin,kind,...extra};}
function validLibraryClipboard(data){return data?.version===1&&data.server===(window.noctuaServerId||location.origin)&&['papers','folder'].includes(data.kind);}
async function pasteLibraryEntries(data,target){
  if(data.kind==='folder'&&data.cut&&store.get('noctua.libraryCutConsumed.'+data.token))throw Error('This cut selection was already moved. Cut it again to move it elsewhere.');
  if(!validLibraryClipboard(data))throw Error('This clipboard belongs to another Noctua server.');
  if(data.kind==='folder'){if(!data.cut)throw Error('Copying folders is not supported; use Cut to move the folder with its files.');await libraryManage({op:'folder_move',target:data.id,parent:target});}
  else{const items=await Promise.all(data.papers.map(item=>api(paperURL(item.key))));await libraryManage({op:'membership',mode:'add',source:data.source,target,papers:paperVersions(items)});}
  if(data.kind==='folder'&&data.cut){store.remove('noctua.libraryClipboard');store.set('noctua.libraryCutConsumed.'+data.token,'1');}await refreshLibraryManagement();toast(data.kind==='folder'?'Moved folder':'Linked selection to collection');
}
for(const type of ['copy','cut'])document.addEventListener(type,event=>{
  if(!(event.target instanceof Element)||event.target.closest('input,textarea,[contenteditable="true"],dialog')||!event.target.closest('#library-rows,#lib-items,#lib-tree'))return;
  const folder=event.target.closest('#lib-tree [data-id]');
  if(folder?.hasAttribute('data-library-trash'))return;
  if(folder&&type==='copy'){toast('Use Cut to move a folder with its project files.');return;}
  const items=selectedLibraryPapers();if(!folder&&!items.length)return;
  const data=libraryClipboardPayload(folder?'folder':'papers',folder?{id:folder.dataset.id,cut:true}:{papers:paperVersions(items),source:lib.target,cut:false});
  event.clipboardData?.setData(libraryClipboardType,JSON.stringify(data));event.clipboardData?.setData('text/plain',JSON.stringify(data));store.set('noctua.libraryClipboard',JSON.stringify(data));event.preventDefault();toast(folder?'Folder ready to move':'Selection copied as links');
});
document.addEventListener('paste',event=>{
  if(!(event.target instanceof Element)||event.target.closest('input,textarea,[contenteditable="true"],dialog')||!event.target.closest('#library-rows,#lib-items,#lib-tree,#library-view'))return;
  if(event.clipboardData?.files?.length)return;
  const raw=event.clipboardData?.getData(libraryClipboardType)||event.clipboardData?.getData('text/plain');if(!raw)return;let data;try{data=JSON.parse(raw);}catch{return;}if(!validLibraryClipboard(data))return;
  event.preventDefault();(event.target.closest('[data-library-trash]')?dropLibraryEntries(data,event.target.closest('[data-library-trash]'),{}):pasteLibraryEntries(data,event.target.closest('#lib-tree [data-id]')?.dataset.id||lib.target)).catch(error=>toast(error.message,{error:true}));
},true);
document.addEventListener('keydown',event=>{
  if(event.isComposing||event.repeat||!event.target.closest?.('#library-rows,#lib-items')||event.target.closest('input,textarea,select,dialog'))return;
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a'){event.preventDefault();const host=event.target.closest('#library-rows,#lib-items')||document.getElementById('library-rows');lib.selected=new Set([...host.querySelectorAll('[data-key]')].map(row=>row.dataset.key));updateLibrarySelection();}
  if((event.metaKey||event.ctrlKey)&&!event.shiftKey&&event.key.toLowerCase()==='z'){event.preventDefault();undoLibraryDelete().catch(error=>toast(error.message,{error:true}));}
});
let libraryDragKind=null;
function clearLibraryDrop(){
  document.querySelectorAll('.library-drop-target,[data-library-drop]').forEach(row=>{row.classList.remove('library-drop-target');delete row.dataset.libraryDrop;delete row.dataset.dropLabel;});
}
function endLibraryDrag(){libraryDragKind=null;document.body.classList.remove('library-dragging');clearLibraryDrop();}
function libraryFolderDropPosition(row,event,kind=libraryDragKind){
  if(kind!=='folder'||row.dataset.id==='L1'||row.hasAttribute('data-library-trash'))return 'inside';
  const rect=row.getBoundingClientRect(),offset=event.clientY-rect.top,edge=Math.max(9,rect.height*.28);
  return offset<edge?'before':offset>rect.height-edge?'after':'inside';
}
async function dropLibraryEntries(data,row,event){
  if(!validLibraryClipboard(data))throw Error('This drag belongs to another Noctua server.');
  if(row.hasAttribute('data-library-trash')){
    if(data.kind==='folder')confirmDeleteLibraryFolder(data.id);
    else confirmDeleteLibraryPaper(await Promise.all(data.papers.map(item=>api(paperURL(item.key)))));
    return;
  }
  const target=row.dataset.id,position=libraryFolderDropPosition(row,event,data.kind);
  if(data.kind==='folder'&&data.id===target)return;
  if(data.kind==='folder'&&position!=='inside'){
    const anchor=collections.targets.find(entry=>entry.id===target);if(!anchor?.parent)throw Error('Choose a folder below Library.');
    await libraryManage({op:'folder_move',target:data.id,parent:anchor.parent,anchor:target,position});
    lib.expanded.add(anchor.parent);await refreshLibraryManagement();toast('Folder moved');
  }else{
    if(data.kind==='papers'&&event.altKey)data.cut=false;
    await pasteLibraryEntries(data,target);
    if(data.kind==='folder'){lib.expanded.add(target);renderLibTree();}
  }
}
function bindLibraryPaperDrag(row,item){
  row.draggable=true;row.ondragstart=event=>{if(!lib.selected.has(item.key)){lib.selected=new Set([item.key]);updateLibrarySelection();}libraryDragKind='papers';document.body.classList.add('library-dragging');event.dataTransfer.setData(libraryClipboardType,JSON.stringify(libraryClipboardPayload('papers',{papers:paperVersions(selectedLibraryPapers()),source:lib.target,cut:false})));event.dataTransfer.effectAllowed='all';};
  row.ondragend=endLibraryDrag;
}
function bindLibraryFolderDrag(row){
  row.draggable=row.dataset.id!=='L1';row.ondragstart=event=>{if(event.target.closest('button,input')){event.preventDefault();return;}libraryDragKind='folder';document.body.classList.add('library-dragging');event.dataTransfer.setData(libraryClipboardType,JSON.stringify(libraryClipboardPayload('folder',{id:row.dataset.id,cut:true})));event.dataTransfer.effectAllowed='move';};
  row.ondragend=endLibraryDrag;
  row.ondragover=event=>{
    if(![...event.dataTransfer.types].includes(libraryClipboardType))return;
    event.preventDefault();event.stopPropagation();clearLibraryDrop();
    const position=libraryFolderDropPosition(row,event);row.dataset.libraryDrop=position;
    row.dataset.dropLabel=row.hasAttribute('data-library-trash')?'Move to Trash':position==='inside'?(row.dataset.id==='L1'?'Move to Library root':'Move inside'):(position==='before'?'Insert before':'Insert after');
    if(position==='inside')row.classList.add('library-drop-target');
    event.dataTransfer.dropEffect=libraryDragKind==='papers'&&!row.hasAttribute('data-library-trash')?'link':'move';
    const tree=document.getElementById('lib-tree');if(tree){const rect=tree.getBoundingClientRect();if(event.clientY<rect.top+24)tree.scrollTop-=12;else if(event.clientY>rect.bottom-24)tree.scrollTop+=12;}
  };
  row.ondragleave=event=>{if(!row.contains(event.relatedTarget))clearLibraryDrop();};
  row.ondrop=event=>{const raw=event.dataTransfer.getData(libraryClipboardType);if(!raw)return;event.preventDefault();event.stopPropagation();try{const data=JSON.parse(raw);endLibraryDrag();dropLibraryEntries(data,row,event).catch(error=>toast(error.message,{error:true}));}catch(error){toast(error.message,{error:true});}};
}
function bindLibraryRootDrop(tree){
  let root=document.getElementById('library-root-drop');
  if(!root){root=document.createElement('div');root.id='library-root-drop';root.dataset.id='L1';root.textContent='Drop here to move to Library root';root.setAttribute('aria-label','Move to Library root');tree.after(root);bindLibraryFolderDrag(root);}
}
document.addEventListener('dragend',endLibraryDrag);

window.addEventListener('DOMContentLoaded',()=>{if(typeof renderLibTree==='function')renderLibTree();if(typeof renderLibItems==='function'&&lib.items)renderLibItems();});

async function renderPaperCollections(host,key){
  if(!host.isConnected)return;
  host.textContent='Loading assigned collections…';
  try{
    const result=await api(paperURL(key)+'/membership');
    if(!host.isConnected)return;
    if(!Array.isArray(result.targets))throw Error('Could not load assigned collections.');
    const byId=new Map(collections.targets.map(target=>[target.id,target]));
    const path=target=>{const names=[target.name],seen=new Set([target.id]);let parent=target.parent;while(parent&&parent!=='L1'&&!seen.has(parent)){seen.add(parent);const ancestor=byId.get(parent);if(!ancestor)break;names.unshift(ancestor.name);parent=ancestor.parent;}return names.join(' / ');};
    const assigned=result.targets.filter(target=>target.id!=='L1');
    const root=result.targets.find(target=>target.id==='L1')||byId.get('L1');
    host.innerHTML=`<div class="paper-info-library-row">${paperInfoIcon('library')}<strong>${esc(root?.name||'Noctua Library')}</strong></div>`+(assigned.length?'<ul>'+assigned.map(target=>`<li>${paperInfoIcon('folder')}<span>${esc(path(target))}</span></li>`).join('')+'</ul>':'<p class="hint">No collection assigned.</p>');
  }catch(error){if(host.isConnected)host.textContent=error.message;}
}

function libraryTagCounts(items){
  const counts=new Map();
  for(const item of items||[])for(const tag of new Set(item.tags||[]))if(typeof tag==='string'&&tag.trim())counts.set(tag,(counts.get(tag)||0)+1);
  return counts;
}
function renderLibraryTagPanel(){
  const panel=document.getElementById('library-tags');if(!panel)return;
  const input=panel.querySelector('[data-search-tags]'),clear=panel.querySelector('[data-clear-tag]');
  if(!panel.dataset.bound){panel.dataset.bound='true';
    input.addEventListener('input',()=>renderLibraryTagPanel());
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();input.value='';renderLibraryTagPanel();}});
    clear.onclick=()=>{lib.tag='';renderLibItems();};
  }
  const counts=libraryTagCounts(lib.items),query=input.value.trim().toLocaleLowerCase();
  const tags=[...counts.keys()].sort((a,b)=>a.localeCompare(b)).filter(tag=>tag.toLocaleLowerCase().includes(query));
  panel.querySelector('[data-tag-count]').textContent=String(counts.size);
  clear.disabled=!lib.tag;
  const list=panel.querySelector('[data-library-tag-list]');
  list.innerHTML=tags.length?tags.map(tag=>`<button type="button" data-library-tag="${esc(tag)}" aria-pressed="${lib.tag===tag}" title="${esc(tag)}"><span>${esc(tag)}</span><small>${counts.get(tag)}</small></button>`).join(''):`<p class="hint">${lib.items===null?'Loading tags…':query?'No matching tags.':'No tags in this collection.'}</p>`;
  list.querySelectorAll('[data-library-tag]').forEach(button=>button.onclick=()=>{
    const tag=button.dataset.libraryTag;lib.tag=lib.tag===tag?'':tag;renderLibItems();
    [...list.querySelectorAll('[data-library-tag]')].find(button=>button.dataset.libraryTag===tag)?.focus();
  });
}

// Bind the tag search even if collection loading finished before this script arrived.
if(typeof lib!=='undefined')renderLibraryManagement();
