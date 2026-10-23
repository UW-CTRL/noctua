'use strict';
async function libraryRequest(path, method='GET', body) {
  const raw = body instanceof Blob;
  const r = await fetch(path, {method, headers: body === undefined ? {} : {'Content-Type':raw ? body.type || 'application/pdf' : 'application/json'}, body:body === undefined ? undefined : raw ? body : JSON.stringify(body)});
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
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
    if(disposition==='window' && settings?.desktop) return await api('/api/desktop/window',{url});
    window.open(url,'_blank','noopener');
  } catch(e){toast(e.message);}
}
async function readDiscoveredPaper(p,disposition) {
  try {const saved=await api('/api/library/add',{paper:p,target:lib.target || 'L1',attach_pdf:true});await loadCollections();await loadLibItems();if(saved.paper?.has_pdf)await openPaperView(saved.key,disposition);else toast(saved.warning || 'Paper saved. Attach a PDF from its library details.');}catch(e){toast(e.message);}
}
function libraryPaperActions(el,it) {
  const box=document.createElement('div');box.className='library-tools';el.append(box);
  const button=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.onclick=()=>Promise.resolve().then(fn).catch(e=>toast(e.message));box.append(b);};
  if(it.has_pdf){button('Read PDF',()=>openPaperView(it.key));button('New tab',()=>openPaperView(it.key,'tab'));button('New window',()=>openPaperView(it.key,'window'));}
  else {
    button('Attach PDF',async()=>{const [file]=await choosePDFs();if(!file)return;await libraryRequest(paperURL(it.key)+'/pdf','PUT',file);await loadLibItems();await openPaperView(it.key);});
    if(it.pdf_url)button('Download PDF',async()=>{await api(paperURL(it.key)+'/download',{});await loadLibItems();await openPaperView(it.key);});
  }
  button('Edit details',()=>editLibraryPaper(it.key));
  const select=document.createElement('select');select.innerHTML=collectionOptions(lib.target);box.append(select);
  button('Add to collection',async()=>{await api(paperURL(it.key)+'/membership',{target:select.value});await loadCollections();await loadLibItems();});
  if(lib.target!=='L1')button('Remove from collection',async()=>{await api(paperURL(it.key)+'/membership',{target:lib.target,remove:true});await loadCollections();await loadLibItems();});
}
async function editLibraryPaper(key){
  const p=await api(paperURL(key));const dialog=document.createElement('dialog');dialog.className='paper-editor';
  const fields=['title','creators','year','DOI','arxiv','venue','pdf_url','abstractNote'];
  dialog.innerHTML='<form method="dialog"><h2>Paper details</h2>'+fields.map(k=>`<label>${esc(k==='creators'?'Authors (one per line)':k)}<textarea name="${k}">${esc(k==='creators'?p[k].join('\n'):p[k])}</textarea></label>`).join('')+'<p class="error"></p><button type="button" data-cancel>Cancel</button> <button type="submit">Save</button></form>';
  document.body.append(dialog);dialog.showModal();dialog.onclose=()=>dialog.remove();dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
  dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const b={revision:p.revision};for(const k of fields)b[k]=dialog.querySelector(`[name="${k}"]`).value;b.creators=b.creators.split('\n').map(s=>s.trim()).filter(Boolean);b.year=b.year?Number(b.year):null;try{await libraryRequest(paperURL(key),'PUT',b);dialog.close();await loadLibItems();}catch(e){dialog.querySelector('.error').textContent=e.message;}};
}
$('#import-pdf').onclick=async()=>{try{const files=await choosePDFs(true);let last;for(const file of files){toast('Importing '+file.name);last=await libraryRequest('/api/library/import-pdf?target='+enc(lib.target || 'L1')+'&name='+enc(file.name),'POST',file);}await loadCollections();await loadLibItems();if(last)await openPaperView(last.key);}catch(e){toast(e.message);}};
$('#import-zotero').onclick=async()=>{const b=$('#import-zotero');b.disabled=true;try{toast('Copying Zotero collections and available PDFs…');const r=await api('/api/library/import-zotero',{copy_pdfs:true});await loadCollections();await loadLibItems();toast('Import complete. '+JSON.stringify(r));}catch(e){toast(e.message+' Configure the optional Zotero source in Settings.');}finally{b.disabled=false;}};
