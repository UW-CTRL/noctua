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
function libraryPaperActions(el,it) {
  const box=el.querySelector('.paper-primary-actions'), graph=box.querySelector('#act-lib-graph');
  graph.remove();
  const actionIcons={'Read PDF':'file-text','New tab':'external-link','New window':'app-window','Attach PDF':'paperclip','Download PDF':'download','Edit details':'pencil','Add to collection':'folder-plus','Remove from collection':'folder-minus'};
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
  const membership=el.querySelector('.paper-collection-tools');
  const label=document.createElement('label');label.className='paper-collection-label';label.htmlFor='paper-collection-target';label.textContent='Collection';
  const row=document.createElement('div');row.className='paper-collection-row';
  const select=document.createElement('select');select.id='paper-collection-target';select.setAttribute('aria-label','Collection');select.innerHTML=collectionOptions(lib.target);
  row.append(select);membership.append(label,row);
  button('Add to collection',async()=>{await api(paperURL(it.key)+'/membership',{target:select.value});await loadCollections();await loadLibItems();},{iconOnly:true,parent:row});
  if(lib.target!=='L1')button('Remove from collection',async()=>{await api(paperURL(it.key)+'/membership',{target:lib.target,remove:true});await loadCollections();await loadLibItems();},{iconOnly:true,parent:row}).className='paper-remove-action';
}
async function editLibraryPaper(key){
  const p=await api(paperURL(key));const dialog=document.createElement('dialog');dialog.className='paper-editor';
  const fields=['title','creators','year','DOI','arxiv','venue','pdf_url','abstractNote'];
  dialog.innerHTML='<form method="dialog"><h2>Paper details</h2>'+fields.map(k=>`<label>${esc(k==='creators'?'Authors (one per line)':k)}<textarea name="${k}">${esc(k==='creators'?p[k].join('\n'):p[k])}</textarea></label>`).join('')+'<p class="error"></p><button type="button" data-cancel data-icon="x">Cancel</button> <button type="submit" data-icon="save">Save</button></form>';
  document.body.append(dialog);dialog.showModal();dialog.onclose=()=>dialog.remove();dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
  dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const b={revision:p.revision};for(const k of fields)b[k]=dialog.querySelector(`[name="${k}"]`).value;b.creators=b.creators.split('\n').map(s=>s.trim()).filter(Boolean);b.year=b.year?Number(b.year):null;try{await libraryRequest(paperURL(key),'PUT',b);dialog.close();await loadLibItems();}catch(e){dialog.querySelector('.error').textContent=e.message;}};
}
async function importLibraryPDF(target = lib.target || 'L1') {
  try {
    const files = await choosePDFs(true); if (!files.length) return;
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
  dialog.innerHTML='<form><h2 id="zotero-import-title">Import from Zotero</h2><p>Collections and basic paper information are always imported. Choose what else to import.</p>'+choices.map(([name,label])=>`<label><input type="checkbox" name="${name}" checked> ${label}</label>`).join('')+`<label>PDF storage <select name="pdf_mode"><option value="link"${pdfMode==='link'?' selected':''}>Link original</option><option value="copy"${pdfMode==='copy'?' selected':''}>Copy to Noctua</option></select></label>`+'<p>Link original reads PDFs from your configured Zotero folder without copying. Keep that folder available. Copy to Noctua stores independent PDF files.</p><p>Notes become text notes. PDF annotations require the matching local PDF; only one PDF per paper is imported.</p><p>Close Zotero first for the freshest snapshot.</p><p class="error" role="alert"></p><button type="button" data-cancel>Cancel</button> <button type="submit">Import</button></form>';
  const mode=document.createElement('div');
  mode.innerHTML='<label>Existing items <select name="import_mode"><option value="sync">Sync changes</option><option value="overwrite">Overwrite from Zotero</option></select></label><p>Sync updates untouched imported fields and keeps local edits; conflicts are reported. Overwrite replaces selected paper fields, note content, and imported annotation fields with Zotero values. Neither mode deletes Noctua-only items or replaces a different PDF.</p>';
  dialog.querySelector('form').insertBefore(mode,dialog.querySelector('.error'));
  document.body.append(dialog);dialog.showModal();dialog.onclose=()=>dialog.remove();
  const form=dialog.querySelector('form'),submit=form.querySelector('[type="submit"]');let busy=false;
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
      await loadCollections();await loadLibItems();
      dialog.close();toast(`Import complete: ${result.papers} papers, ${result.linked_pdfs||0} linked PDFs, ${result.pdfs} copied PDFs, ${result.notes} notes, ${result.annotations} annotations, ${result.conflicts||0} conflicts kept locally.`);
      if(result.warnings?.length)toast(result.warnings.join('\n'));
    }catch(error){form.querySelector('.error').textContent=error.message;}
    finally{busy=false;form.querySelectorAll('input,select,button').forEach(el=>el.disabled=false);form.elements.pdf_mode.disabled=!form.elements.copy_pdfs.checked;submit.textContent='Import';}
  };
}
