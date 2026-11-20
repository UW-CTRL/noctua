'use strict';
// Browsing a directory is independent of the document currently being edited.
let explorerSaved=[];try{explorerSaved=JSON.parse(store.get('noctua.explorerOpen')||'[]');}catch{}
const Explorer={open:new Set(Array.isArray(explorerSaved)?explorerSaved:[]),loading:new Map()};
const Documents={items:[],active:null,queue:Promise.resolve()};
function documentKey(doc){return [doc.kind,doc.target||'',doc.id].join(':');}
function documentOpened(doc){
 const key=documentKey(doc),existing=Documents.items.find(item=>item.key===key);
 if(existing)Object.assign(existing,doc);else Documents.items.push({...doc,key});
 Documents.active=key;renderDocumentTabs();
}
function renderDocumentTabs(){
 let bar=$('#document-tabs');if(!bar){bar=document.createElement('div');bar.id='document-tabs';bar.setAttribute('role','tablist');bar.setAttribute('aria-label','Open documents');$('main').append(bar);}
 $('main').classList.toggle('has-document-tabs',!!Documents.items.length);bar.hidden=!Documents.items.length;
 bar.innerHTML=Documents.items.map(doc=>`<div class="document-tab ${doc.key===Documents.active?'active':''}"><button role="tab" aria-selected="${doc.key===Documents.active}" tabindex="${doc.key===Documents.active?0:-1}" data-document="${esc(doc.key)}" title="${esc(doc.target?((collections.targets.find(t=>t.id===linkedCollection(doc.target))?.name||doc.target)+' · '):'')}${esc(doc.title)}">${esc(doc.title)}</button><button data-close-document="${esc(doc.key)}" data-icon="x" data-icon-only aria-label="Close ${esc(doc.title)}"></button></div>`).join('');
 bar.querySelectorAll('[data-document]').forEach(button=>{button.onclick=()=>switchDocument(button.dataset.document);button.onkeydown=event=>{const keys=['ArrowLeft','ArrowRight','Home','End'];if(!keys.includes(event.key))return;event.preventDefault();const index=Documents.items.findIndex(d=>d.key===button.dataset.document),next=event.key==='Home'?0:event.key==='End'?Documents.items.length-1:(index+(event.key==='ArrowLeft'?-1:1)+Documents.items.length)%Documents.items.length;switchDocument(Documents.items[next].key);};});
 bar.querySelectorAll('[data-close-document]').forEach(button=>button.onclick=()=>closeDocument(button.dataset.closeDocument));
}
async function flushDocument(){const current=Documents.items.find(doc=>doc.key===Documents.active);if(current&&document.body.classList.contains('pdf-mode'))current.page=PDF.page;rememberWorkspaceView();rememberNoteView();await saveWorkspaceFile();await flushNoteEdits();await window.flushPDF?.();}
function documentTask(task){const result=Documents.queue.then(task);Documents.queue=result.catch(error=>toast(error.message,{error:true}));return result;}
async function activateProject(target){
 await flushDocument();const collection=linkedCollection(target);Explorer.open.add(collection);lib.target=collection;
 if(N.target!==collection)await loadNoteFolder(collection,{restore:false});
 if(linkedTarget(target)){if(W.target!==target)await openLinkedRoot(target,{restore:false});}
 else if(W.target!==target)await loadWorkspace(target);
 if(W.target!==target)throw Error('Could not open the selected project.');
}
function openProjectEntry(target,id){return documentTask(async()=>{await activateProject(target);setMode('notes');await openWorkspaceFile(id);});}
async function activateDocument(doc){
 await flushDocument();
 if(doc.kind==='paper')await openPDF(doc.id,{page:doc.page||1});
 else {await activateProject(doc.target);setMode('notes');if(doc.kind==='note')await openNote(doc.id);else {await openWorkspaceFile(doc.id);if(doc.page&&document.body.classList.contains('pdf-mode'))scrollPDFPage(doc.page);}}
}
function switchDocument(key){return documentTask(async()=>{if(key===Documents.active)return;const doc=Documents.items.find(d=>d.key===key);if(!doc)return;const old=Documents.items.find(d=>d.key===Documents.active);if(old&&document.body.classList.contains('pdf-mode'))old.page=PDF.page;await activateDocument(doc);});}
function closeDocument(key){return documentTask(async()=>{
 const index=Documents.items.findIndex(doc=>doc.key===key);if(index<0)return;
 if(key===Documents.active){await flushDocument();const next=Documents.items[index+1]||Documents.items[index-1];if(next)await activateDocument(next);else{paperUnmount();W.file=null;N.doc=null;Documents.active=null;setMode('notes');renderEditor();}}
 Documents.items=Documents.items.filter(doc=>doc.key!==key);renderDocumentTabs();
});}
async function browseCollection(target){
 lib.target=target;store.set('noctua.libTarget',target);
 if(Explorer.open.has(target)){Explorer.open.delete(target);lib.expanded.delete(target);}
 else{Explorer.open.add(target);lib.expanded.add(target);await loadExplorerCollection(target);}
 store.set('noctua.explorerOpen',JSON.stringify([...Explorer.open]));store.set('noctua.expandedFolders',JSON.stringify([...lib.expanded]));renderLibTree();
}
function loadExplorerCollection(target){
 if(Explorer.loading.has(target))return Explorer.loading.get(target);
 const work=Promise.all([api(`/api/workspaces/${enc(target)}`,undefined,{background:true}),api(`/api/workspaces/${enc(target)}/links`,undefined,{background:true})]).then(([manifest,links])=>{Linked.internal.set(target,manifest);Linked.links.set(target,links);}).finally(()=>Explorer.loading.delete(target));Explorer.loading.set(target,work);return work;
}
function renderExplorer(){
 const restore=preserveDirectoryScroll(),list=$('#lib-tree');if(!list)return;
 list.querySelectorAll(':scope > .tree-files').forEach(host=>{if(host.contains(W.treeEl))host.removeChild(W.treeEl);host.remove();});
 const activeCollection=linkedCollection(W.target);
 for(const row of list.querySelectorAll(':scope > li[data-id]:not([data-library-trash])')){
  const target=row.dataset.id;if(!Explorer.open.has(target))continue;
  let anchor=row;const byId=new Map(collections.targets.map(t=>[t.id,t]));
  for(let next=row.nextElementSibling;next;next=next.nextElementSibling){if(next.classList.contains('tree-files')){anchor=next;continue;}let parent=byId.get(next.dataset.id)?.parent;const seen=new Set();while(parent&&parent!==target&&!seen.has(parent)){seen.add(parent);parent=byId.get(parent)?.parent;}if(parent!==target)break;anchor=next;}
  const host=document.createElement('li');host.className='tree-files';host.setAttribute('role','none');host.style.setProperty('--tree-indent',row.style.paddingLeft||'8px');anchor.after(host);
  if(target===activeCollection&&W.treeEl){W.treeEl.hidden=false;host.append(W.treeEl);}
  else{const tree=document.createElement('div');tree.className='explorer-tree';tree.dataset.collection=target;tree.innerHTML=linkedTreeHeader(target,false);host.append(tree);bindLinkedTree(tree);}
 }
 if(W.treeEl&&!W.treeEl.isConnected){W.treeEl.hidden=true;$('#notes-side').append(W.treeEl);}
 if(typeof bindProjectRows==='function')bindProjectRows();restore();
}
// Restore directory expansion without replacing the initial editor selection.
for(const target of Explorer.open)loadExplorerCollection(target).then(renderExplorer).catch(()=>{});
