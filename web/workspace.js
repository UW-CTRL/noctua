'use strict';
const W={selected:new Set(),anchor:null,expanded:new Set(),drag:null,target:null,manifest:null,file:null,text:'',saved:'',timer:null,saving:null,dirty:false,fileRevision:null,fileHistory:{}};
const workspaceURL=()=>`/api/workspaces/${enc(W.target)}`;
function rememberWorkspaceView(){
 const ta=$('#workspace-editor textarea');if(!W.target||!W.file||!ta)return;
 store.set('noctua.fileView.'+W.target+'.'+W.file,JSON.stringify({start:ta.selectionStart,end:ta.selectionEnd,top:ta.scrollTop,left:ta.scrollLeft}));
}
async function restoreWorkspaceFile(target){
 const id=store.get('noctua.openFile.'+target);
 if(!id||!W.manifest?.entries.some(e=>e.id===id&&e.kind==='file'&&!e.deleted))return false;
 await openWorkspaceFile(id);return W.target===target&&W.file===id;
}
window.addEventListener('pagehide',rememberWorkspaceView);
window.addEventListener('beforeunload',rememberWorkspaceView);
function workspaceDialog(title,html){const d=document.createElement('dialog');d.className='workspace-dialog';d.setAttribute('aria-label',title);d.innerHTML=`<header><strong>${esc(title)}</strong><button data-close data-icon="x" data-icon-only title="Close" aria-label="Close"></button></header>${html}`;document.body.appendChild(d);d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());d.showModal();return d;}
async function loadWorkspace(target){
 try{const m=await api(`/api/workspaces/${enc(target)}`);if(N.target!==target)return;if(W.target!==target){W.selected.clear();W.anchor=null;try{W.expanded=new Set(JSON.parse(store.get('noctua.workspaceExpanded.'+target)||'[]'));}catch{W.expanded=new Set();}}W.target=target;W.manifest=m;renderWorkspaceTree();applyBibliography();}catch(e){toast(e.message,{error:true});}
}
function applyBibliography(){
 if(!W.manifest||W.target!==N.target)return;
 for(const [key,it]of N.items)if(it.bib)N.items.delete(key);
 for(const it of W.manifest.bib_index||[])if(!N.items.has(it.key))N.items.set(it.key,it);
 typeset();
}
function updateWorkspaceHistory(){document.querySelectorAll('[data-history="workspace"],[data-history="file"]').forEach(el=>{const history=el.dataset.history==='file'?W.fileHistory:W.manifest?.history;for(const action of ['undo','redo']){const b=el.querySelector(`[data-${action}]`);b.disabled=action==='redo'&&W.dirty||!(history?.[action]||(action==='undo'&&W.dirty));b.title=(history?.[action]?`${action}: ${history[action]}`:action)+(action==='undo'?' (⌘Z / Ctrl+Z)':' (⇧⌘Z / Ctrl+Shift+Z)');b.setAttribute('aria-keyshortcuts',action==='undo'?'Meta+Z Control+Z':'Meta+Shift+Z Control+Shift+Z');}});}
function workspaceFileIcon(entry) {
 const ext=(entry.source_name||entry.name||'').split('.').pop().toLowerCase();
 if(['png','jpg','jpeg','gif','webp','svg','avif','bmp','tif','tiff','ico','heic','heif'].includes(ext))return 'image';
 if(['mp4','m4v','mov','webm','avi','mkv','mpeg','mpg'].includes(ext))return 'video';
 return ext==='bib'?'library':'file-text';
}
function renderWorkspaceTree(){
 let tree=W.treeEl;if(!tree){tree=W.treeEl=document.createElement('div');tree.id='workspace-tree';}
 placeWorkspaceTree();
 $('#note-list').hidden=true;
 const m=W.manifest;if(!m)return;
 const entries=m.entries.filter(e=>!e.deleted);
 W.selected=new Set([...W.selected].filter(id=>entries.some(e=>e.id===id)));
 const children=(parent,depth=0)=>entries.filter(e=>(e.parent||'')===parent).sort((a,b)=>(a.kind==='folder'?-1:0)-(b.kind==='folder'?-1:0)||a.name.localeCompare(b.name)).map(e=>{
  const title=e.kind==='note'&&!e.renamed?(N.list.find(n=>n.id===e.note)?.title||e.name):e.name;
  const active=e.kind==='note'?(!W.file&&N.doc?.id===e.note):W.file===e.id;
  const icon=e.kind==='folder'?(W.expanded.has(e.id)?'folder-open':'folder'):e.kind==='note'?'notebook-pen':workspaceFileIcon(e);
  return `<div class="workspace-entry ${active?'active':''} ${W.selected.has(e.id)?'selected':''}" draggable="true" data-entry="${esc(e.id)}" ${e.kind==='folder'?`data-drop-folder="${esc(e.id)}"`:''} style="--depth:${depth}"><button data-file="${esc(e.id)}" aria-pressed="${W.selected.has(e.id)}" data-icon="${icon}" title="${esc(title)}" ${active?'aria-current="page"':''} ${e.kind==='folder'?`aria-expanded="${W.expanded.has(e.id)}"`: ''}><span class="workspace-name">${esc(title)}</span></button><button data-file-rename="${esc(e.id)}" data-icon="pencil" data-icon-only title="Rename ${esc(title)}" aria-label="Rename ${esc(title)}"></button><button data-file-trash="${esc(e.id)}" data-icon="trash-2" data-icon-only title="Move ${esc(title)} to trash" aria-label="Move ${esc(title)} to trash"></button></div>${e.kind==='folder'&&W.expanded.has(e.id)?children(e.id,depth+1):''}`;
 }).join('');
 const action=(attr,icon,label)=>`<button ${attr} data-icon="${icon}" data-icon-only title="${label}" aria-label="${label}"></button>`;
 tree.innerHTML=`${m.bib_error?`<p class="workspace-error" role="alert">Bibliography out of date: ${esc(m.bib_error)}</p>`:''}<div class="workspace-root-drop" data-drop-folder="" title="Drop an entry here to move it out of its folder">Project root</div><div class="workspace-entries">${children('')||'<p class="hint">No files yet. Create a note or import a file.</p>'}</div><div class="workspace-footer"><div role="group" aria-label="Project settings">${action('data-latex-settings','settings','Project LaTeX settings')}${action('data-trash','trash-2','Project trash')}${action('data-agent-edits','list-checks','Assistant changes')}</div>${historyButtons('workspace')}</div>`;
 updateWorkspaceHistory();
 tree.querySelector('[data-trash]').onclick=showWorkspaceTrash;tree.querySelector('[data-agent-edits]').onclick=()=>showAgentEdits().catch(e=>toast(e.message,{error:true}));
 tree.querySelector('[data-latex-settings]').onclick=()=>showPaperSettings().catch(e=>toast(e.message,{error:true}));
 tree.querySelectorAll('[data-file]').forEach(b=>b.onclick=event=>{const modified=event.ctrlKey||event.metaKey||event.shiftKey;selectWorkspaceEntry(b.dataset.file,event);tree.focus({preventScroll:true});if(modified)return;const entry=W.manifest.entries.find(e=>e.id===b.dataset.file);if(entry?.kind!=='folder'&&typeof isNotesMode==='function'&&!isNotesMode())setMode('notes');openWorkspaceFile(b.dataset.file).catch(e=>toast(e.message,{error:true}));});
 tree.querySelectorAll('[data-file-rename]').forEach(b=>b.onclick=()=>workspaceRename(b.dataset.fileRename));
 tree.querySelectorAll('[data-file-trash]').forEach(b=>b.onclick=()=>confirmWorkspaceTrash(b.dataset.fileTrash));
 tree.tabIndex=0;tree.setAttribute('aria-label','Project files');
 tree.onkeydown=event=>{
  if(event.defaultPrevented||event.isComposing||event.repeat||event.target.matches('input,textarea')||event.target.isContentEditable||document.querySelector('dialog[open]'))return;
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='a'){
   event.preventDefault();const rows=[...tree.querySelectorAll('[data-entry]')];W.selected=new Set(rows.map(row=>row.dataset.entry));W.anchor=rows[0]?.dataset.entry||null;
   rows.forEach(row=>{row.classList.add('selected');row.querySelector('[data-file]').setAttribute('aria-pressed','true');});return;
  }
  if(!event.metaKey&&!event.ctrlKey&&!event.altKey&&!event.shiftKey&&['Delete','Backspace'].includes(event.key)&&W.selected.size){
   event.preventDefault();confirmWorkspaceTrash(workspaceDragIds({ids:[...W.selected]}));
  }
 };
 bindWorkspaceDrag(tree);
 // Project-wide actions stay at the bottom of the sidebar, below the whole tree.
 const footer=tree.querySelector('.workspace-footer'),footerHost=document.getElementById('workspace-footer-host');
 if(footer&&footerHost){footerHost.replaceChildren(footer);bindWorkspaceDrag(footerHost);}
}
// The open collection's notes and files sit under its row in the shared
// collection tree, in Library and Notes alike. Without a visible row (for
// example in a fixture without the tree) they stay in the notes side panel.
function placeWorkspaceTree(){
 const tree=W.treeEl;if(!tree)return;
 const row=W.target&&document.querySelector(`#lib-tree > li[data-id="${CSS.escape(W.target)}"]`);
 let host=document.querySelector('#lib-tree > li.tree-files');
 if(!row){host?.remove();if(tree.parentElement?.id!=='notes-side')$('#note-list')?.before(tree);return;}
 if(host&&host.previousElementSibling!==row){host.remove();host=null;}
 if(!host){host=document.createElement('li');host.className='tree-files';host.setAttribute('role','none');row.after(host);}
 host.style.setProperty('--tree-indent',row.style.paddingLeft||'8px');
 if(tree.parentElement!==host)host.append(tree);
 bindProjectRows();
}
// Drop project entries on another collection's row to move them there.
function bindProjectRows(){
 document.querySelectorAll('#lib-tree > li[data-id]:not([data-library-trash])').forEach(row=>{
  if(row.dataset.projectDrop)return;row.dataset.projectDrop='1';
  const accepts=e=>W.drag&&row.dataset.id!==W.target&&Array.from(e.dataTransfer?.types||[]).includes(workspaceDragType);
  row.addEventListener('dragover',e=>{if(!accepts(e))return;e.preventDefault();e.dataTransfer.dropEffect='move';row.classList.add('workspace-project-target');});
  row.addEventListener('dragleave',e=>{if(!row.contains(e.relatedTarget))row.classList.remove('workspace-project-target');});
  row.addEventListener('drop',e=>{if(!accepts(e))return;e.preventDefault();e.stopPropagation();closeProjectDrop();let item;try{item=JSON.parse(e.dataTransfer.getData(workspaceDragType));}catch{}W.drag=null;if(item)transferWorkspaceEntries(item,row.dataset.id);});
 });
}
document.querySelector('#collection-tools [data-new-file]')?.addEventListener('click',()=>{if(typeof isNotesMode==='function'&&!isNotesMode())setMode('notes');workspaceCreate(false);});
document.querySelector('#collection-tools [data-new-folder]')?.addEventListener('click',()=>workspaceCreate(true));
document.querySelector('#collection-tools [data-import-file]')?.addEventListener('click',()=>workspaceImport());
function selectWorkspaceEntry(id,event={}){
 const rows=[...document.querySelectorAll('#workspace-tree [data-entry]')],ids=rows.map(row=>row.dataset.entry);
 if(event.shiftKey&&ids.includes(W.anchor)){
  if(!event.ctrlKey&&!event.metaKey)W.selected.clear();
  const a=ids.indexOf(W.anchor),b=ids.indexOf(id);ids.slice(Math.min(a,b),Math.max(a,b)+1).forEach(key=>W.selected.add(key));
 }else if(event.ctrlKey||event.metaKey){if(W.selected.has(id))W.selected.delete(id);else W.selected.add(id);W.anchor=id;}
 else{W.selected=new Set([id]);W.anchor=id;}
 rows.forEach(row=>{const selected=W.selected.has(row.dataset.entry);row.classList.toggle('selected',selected);row.querySelector('[data-file]').setAttribute('aria-pressed',String(selected));});
}
function workspaceDragIds(item){
 const ids=item.ids||[item.id],entries=W.manifest.entries;
 return ids.filter(id=>{const seen=new Set();let parent=entries.find(e=>e.id===id)?.parent;while(parent&&!seen.has(parent)){if(ids.includes(parent))return false;seen.add(parent);parent=entries.find(e=>e.id===parent)?.parent;}return true;});
}
function closeProjectDrop(){document.querySelectorAll('.workspace-project-target').forEach(n=>n.classList.remove('workspace-project-target'));}
async function transferWorkspaceEntries(item,destination){
 try{if(item.target!==W.target)throw Error('Project changed. Try again.');await saveWorkspaceFile();await flushNoteEdits();
  const target=W.target;let moved=false;for(const id of workspaceDragIds(item)){
  const dest=await api(`/api/workspaces/${enc(destination)}`),entry=W.manifest.entries.find(n=>n.id===id&&!n.deleted);if(!entry)throw Error('Entry not found.');
  const conflict=await chooseMoveConflict(entry,dest.entries);if(conflict==='skip')continue;
  if(W.target!==target)throw Error('Project changed. Try again.');
  const m=await workspaceChange({op:'transfer',id,destination,destination_revision:dest.revision,conflict});moved=true;
  if(W.file&&m.entries.some(n=>n.id===W.file&&n.deleted)){W.file=null;renderEditor();}
  if(N.doc&&m.entries.some(n=>n.note===N.doc.id&&n.deleted)){N.doc=null;renderEditor();}
  }if(moved)await loadNoteFolder(destination);
 }catch(err){toast(err.message,{error:true});}
}
document.addEventListener('dragend',closeProjectDrop);
document.addEventListener('drop',closeProjectDrop);
const workspaceDragType='application/x-noctua-project-entry';
function workspaceDropError(item,parent){
 if(!item||item.target!==W.target)return 'Move entries within the same project.';
 const entries=W.manifest?.entries||[],entry=entries.find(e=>e.id===item.id&&!e.deleted);
 if(!entry)return 'This entry is no longer available.';
 if(parent===null)return null;
 if(parent&&!entries.some(e=>e.id===parent&&e.kind==='folder'&&!e.deleted))return 'The destination folder is no longer available.';
 let next=parent;const seen=new Set();
 while(next){if(next===entry.id||seen.has(next))return 'A folder cannot be moved into itself or one of its children.';seen.add(next);next=entries.find(e=>e.id===next)?.parent||'';}
 return null;
}
function chooseMoveConflict(entry,entries,parent=''){
 if(!entries.some(e=>!e.deleted&&e.id!==entry.id&&e.name===entry.name&&(e.parent||'')===parent))return Promise.resolve(null);
 return new Promise(resolve=>{
  const d=workspaceDialog('Name already exists',`<p><strong>${esc(entry.name)}</strong> already exists in this location.</p><p>Overwrite moves the existing entry and its contents to Trash. Add number keeps both entries, for example draft (2).tex.</p><footer><button data-choice="skip">Skip</button><button data-choice="number">Add number</button><button data-choice="overwrite">Overwrite</button></footer>`);
  d.classList.add('workspace-compact');let choice='skip';d.querySelectorAll('[data-choice]').forEach(button=>button.onclick=()=>{choice=button.dataset.choice;d.close();});d.addEventListener('close',()=>resolve(choice));
  d.querySelector('[data-choice="skip"]').focus();
 });
}
async function moveWorkspaceEntry(item,parent){
 const error=workspaceDropError(item,parent);if(error)throw Error(error);
 const entry=W.manifest.entries.find(e=>e.id===item.id);if((entry.parent||'')===parent)return;
 const target=W.target,conflict=await chooseMoveConflict(entry,W.manifest.entries,parent);if(conflict==='skip')return;
 if(W.target!==target)throw Error('Project changed. Try again.');
 await workspaceChange({op:'move',id:item.id,parent,conflict});
 if(parent)W.expanded.add(parent);
 store.set('noctua.workspaceExpanded.'+W.target,JSON.stringify([...W.expanded]));renderWorkspaceTree();
}
function bindWorkspaceDrag(tree){
 const clear=()=>{tree.querySelectorAll('.workspace-drop-active').forEach(el=>el.classList.remove('workspace-drop-active'));};
 tree.ondragstart=e=>{
  const row=e.target.closest('[data-entry]');if(!row||e.target.closest('[data-file-rename],[data-file-trash]')){e.preventDefault();return;}
  if(!W.selected.has(row.dataset.entry))selectWorkspaceEntry(row.dataset.entry);
  W.drag={target:W.target,id:row.dataset.entry,ids:[...W.selected]};e.dataTransfer.setData(workspaceDragType,JSON.stringify(W.drag));e.dataTransfer.effectAllowed='move';tree.classList.add('workspace-dragging');
 };
 tree.ondragend=()=>{clear();W.drag=null;tree.classList.remove('workspace-dragging');};
 tree.ondragover=e=>{
  if(!Array.from(e.dataTransfer?.types||[]).includes(workspaceDragType))return;
  tree.classList.add('workspace-dragging');
  const destination=e.target.closest('[data-drop-folder],[data-trash]');clear();e.preventDefault();
  if(!destination){e.dataTransfer.dropEffect='none';return;}
  const parent=destination.hasAttribute('data-trash')?null:destination.dataset.dropFolder;
  if(W.drag&&workspaceDragIds(W.drag).some(id=>workspaceDropError({...W.drag,id},parent))){e.dataTransfer.dropEffect='none';return;}
  e.dataTransfer.dropEffect='move';destination.classList.add('workspace-drop-active');tree.classList.add('workspace-dragging');
 };
 tree.ondragleave=e=>{if(!tree.contains(e.relatedTarget)){clear();tree.classList.remove('workspace-dragging');}};
 tree.ondrop=async e=>{
  if(!Array.from(e.dataTransfer?.types||[]).includes(workspaceDragType))return;
  e.preventDefault();e.stopPropagation();clear();tree.classList.remove('workspace-dragging');W.drag=null;
  const destination=e.target.closest('[data-drop-folder],[data-trash]');if(!destination)return;
  try{
   const item=JSON.parse(e.dataTransfer.getData(workspaceDragType)),parent=destination.hasAttribute('data-trash')?null:destination.dataset.dropFolder;
   const ids=workspaceDragIds(item);for(const id of ids){const error=workspaceDropError({...item,id},parent);if(error)throw Error(error);}
   if(parent===null)confirmWorkspaceTrash(ids);else for(const id of ids)await moveWorkspaceEntry({...item,id},parent);
  }catch(error){toast(error.message,{error:true});}
 };
}
async function workspaceChange(body){const target=W.target;await saveWorkspaceFile();if(target!==W.target)throw Error('Project changed. Please try again.');const m=await api(workspaceURL(),{revision:W.manifest.revision,...body});W.manifest=m;W.fileRevision=m.revision;renderWorkspaceTree();applyBibliography();return m;}
function defaultPaperTemplate(){return String.raw`\documentclass[11pt,notitlepage]{article}

% Layout and paragraphs
\usepackage[margin=1in]{geometry}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.5em}

% Korean, mathematics, figures, and tables
\usepackage{kotex}
\usepackage{amsmath,amssymb,amsthm,mathtools}
\usepackage{graphicx,booktabs}
\usepackage[numbers]{natbib}
\usepackage[colorlinks=true,allcolors=blue]{hyperref}
\allowdisplaybreaks

\title{Untitled document}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Write your content here.

\begin{equation}
  E = mc^2
  \label{eq:energy}
\end{equation}
Refer to Equation~\eqref{eq:energy}.

% Add refs.bib to the project and cite a real key with \cite{key}.
% Then uncomment the following lines:
% \bibliographystyle{plainnat}
% \bibliography{refs}

\end{document}
`;}
function workspaceCreate(folder){
 const target=W.target,folders=W.manifest.entries.filter(e=>e.kind==='folder'&&!e.deleted);
 const d=workspaceDialog(folder?'New folder':'New note or file',`<form class="workspace-create">${folder?'':'<label>Type <select data-kind><option value="note">Note</option><option value="tex">LaTeX (.tex)</option><option value="file">File</option></select></label>'}<label>Name <input data-name required maxlength="200" placeholder="${folder?'Folder name':''}" autocomplete="off"></label><label>Folder <select data-parent><option value="">Project root</option>${folders.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label><p class="workspace-error" role="alert" data-error></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Create</button></footer></form>`);
 d.classList.add('workspace-compact');
 d.querySelector('[data-cancel]').onclick=()=>d.close();
 d.querySelector('form').onsubmit=async event=>{
  event.preventDefault();const button=d.querySelector('[type="submit"]');button.disabled=true;
  try{
   if(W.target!==target)throw Error('The selected project changed. Close this dialog and try again.');
   let name=d.querySelector('[data-name]').value.trim();if(!name)throw Error('Enter a name.');
   const tex=!folder&&d.querySelector('[data-kind]').value==='tex';
   if(tex&&!/\.tex$/i.test(name))name+='.tex';
   if(!folder&&d.querySelector('[data-kind]').value==='note'){
    const doc=await createNote(name);if(!doc)throw Error('Could not create the note.');
    const parent=d.querySelector('[data-parent]').value,entry=W.manifest.entries.find(e=>e.note===doc.id&&!e.deleted);
    if(parent&&entry){await workspaceChange({op:'move',id:entry.id,parent});W.expanded.add(parent);store.set('noctua.workspaceExpanded.'+target,JSON.stringify([...W.expanded]));renderWorkspaceTree();}
    d.close();$('.note-title')?.focus();return;
   }
   const ids=new Set(W.manifest.entries.map(e=>e.id));
   const m=await workspaceChange({op:folder?'folder':'create',name,text:tex?defaultPaperTemplate():'',parent:d.querySelector('[data-parent]').value});
   const entry=m.entries.find(e=>!ids.has(e.id)&&e.kind===(folder?'folder':'file'));
   if(tex&&entry&&!m.entries.some(e=>e.id===m.paper?.main_file&&!e.deleted))await workspaceChange({op:'config',paper:{main_file:entry.id}});
   if(entry?.parent){W.expanded.add(entry.parent);store.set('noctua.workspaceExpanded.'+target,JSON.stringify([...W.expanded]));renderWorkspaceTree();}
   d.close();if(entry&&!folder)await openWorkspaceFile(entry.id);
  }catch(e){d.querySelector('[data-error]').textContent=e.message;}finally{button.disabled=false;}
 };
 d.querySelector('[data-name]').focus();
}
function workspaceImport(){
 const target=W.target,files=[];let busy=false;
 const d=workspaceDialog('Import files',`<form class="workspace-create workspace-import"><div class="workspace-upload-zone"><button type="button" data-pick data-icon="file-up">Choose files</button><small>or drop them here · up to 32 MB each</small><input type="file" data-files multiple hidden></div><ul class="workspace-upload-list" aria-label="Files to import"></ul><p class="workspace-error" role="alert" data-error></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary" disabled>Import</button></footer></form>`);
 d.classList.add('workspace-compact');
 const input=d.querySelector('[data-files]'),zone=d.querySelector('.workspace-upload-zone'),submit=d.querySelector('[type="submit"]'),error=d.querySelector('[data-error]');
 const render=()=>{d.querySelector('ul').innerHTML=files.map((file,index)=>`<li><span title="${esc(file.name)}">${esc(file.name)}</span><small>${file.size<1024*1024?Math.ceil(file.size/1024)+' KB':(file.size/1024/1024).toFixed(1)+' MB'}</small><button type="button" data-remove="${index}" data-icon="x" data-icon-only title="Remove ${esc(file.name)}" aria-label="Remove ${esc(file.name)}"></button></li>`).join('');submit.disabled=busy||!files.length;d.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{if(!busy){files.splice(Number(button.dataset.remove),1);render();}});};
 const add=selected=>{if(busy)return;error.textContent='';for(const file of selected){if(file.size>32*1024*1024){error.textContent='Files can be up to 32 MB each. Use Image / Video in a note for larger videos.';continue;}if(!files.some(f=>f.name===file.name&&f.size===file.size&&f.lastModified===file.lastModified))files.push(file);}render();};
 d.querySelector('[data-pick]').onclick=()=>input.click();input.onchange=()=>{add([...input.files]);input.value='';};
 zone.ondragover=event=>{event.preventDefault();if(!busy)zone.classList.add('drag-over');};zone.ondragleave=()=>zone.classList.remove('drag-over');zone.ondrop=event=>{event.preventDefault();zone.classList.remove('drag-over');add([...event.dataTransfer.files]);};
 d.querySelector('[data-cancel]').onclick=()=>d.close();d.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 d.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(busy||!files.length)return;busy=true;error.textContent='';d.querySelectorAll('button').forEach(button=>button.disabled=true);
  try{
   if(W.target!==target)throw Error('The selected project changed. Close this dialog and try again.');
   await saveWorkspaceFile();let manifest=W.manifest;
   while(files.length){const file=files[0];submit.textContent='Importing…';const response=await fetch(`/api/workspaces/${enc(target)}/upload?name=${enc(file.name)}&revision=${manifest.revision}`,{method:'POST',body:file});const result=await response.json();if(!response.ok)throw Error(result.error||'Import failed');manifest=result;files.shift();if(W.target===target){W.manifest=manifest;W.fileRevision=manifest.revision;renderWorkspaceTree();applyBibliography();}}
   d.close();
  }catch(e){error.textContent=e.message;}finally{busy=false;d.querySelectorAll('button').forEach(button=>button.disabled=false);submit.textContent='Import';render();}
 };
}

function workspaceRename(id){
 const target=W.target,e=W.manifest.entries.find(e=>e.id===id&&!e.deleted);if(!e)return;
 const d=workspaceDialog('Rename',`<form class="workspace-create"><label>Name <input data-name required maxlength="200" value="${esc(e.name)}"></label><p class="workspace-error" data-error role="alert"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Rename</button></footer></form>`);
 d.classList.add('workspace-compact');d.querySelector('[data-cancel]').onclick=()=>d.close();
 d.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=d.querySelector('[type="submit"]');button.disabled=true;try{
  if(W.target!==target)throw Error('Project changed. Reopen this dialog.');
  await workspaceChange({op:'rename',id,name:d.querySelector('[data-name]').value.trim()});d.close();
 }catch(err){d.querySelector('[data-error]').textContent=err.message;}finally{button.disabled=false;}};
 d.querySelector('[data-name]').focus();d.querySelector('[data-name]').select();
}
function confirmWorkspaceTrash(id){
 const ids=Array.isArray(id)?id:[id],target=W.target,entry=W.manifest.entries.find(e=>e.id===ids[0]&&!e.deleted);if(!entry)return;
 const d=workspaceDialog('Move to trash',`<p>Move <strong>${esc(ids.length>1?ids.length+' selected entries':entry.name)}</strong>${ids.length===1&&entry.kind==='folder'?' and everything inside it':''} to the project trash?</p><p>References to these files may stop working. Undo or Trash can restore them.</p><p class="workspace-error" role="alert" data-error></p><footer><button data-cancel>Cancel</button><button data-confirm-trash data-icon="trash-2">Move to trash</button></footer>`);
 d.querySelector('[data-cancel]').onclick=()=>d.close();
 d.querySelector('[data-confirm-trash]').onclick=async()=>{
  const button=d.querySelector('[data-confirm-trash]');button.disabled=true;
  try{
   if(W.target!==target)throw Error('The selected project changed. Close this dialog and try again.');
   await flushNoteEdits();
   if(W.target!==target)throw Error('The selected project changed. Close this dialog and try again.');
   let m;for(const key of ids)m=await workspaceChange({op:'delete',id:key});
   const removed=new Set(m.entries.filter(e=>e.deleted).map(e=>e.id));
   const removedNotes=new Set(m.entries.filter(e=>e.deleted&&e.note).map(e=>e.note));
   const closeFile=W.file&&removed.has(W.file),closeNote=N.doc&&removedNotes.has(N.doc.id);
   if(closeFile)W.file=null;
   if(closeNote){N.doc=null;N.editing=null;resetNoteHistory();}
   N.list=N.list.filter(n=>!removedNotes.has(n.id));
   if(closeFile||(closeNote&&!W.file))renderEditor();
   renderWorkspaceTree();if(typeof updateChatContext==='function')updateChatContext();d.close();
  }catch(e){d.querySelector('[data-error]').textContent=e.message;}finally{button.disabled=false;}
 };
 d.querySelector('[data-cancel]').focus();
}
async function openWorkspaceFile(id){
 const target=W.target,e=W.manifest.entries.find(e=>e.id===id&&!e.deleted);if(!e)return;if(e.kind==='folder'){if(W.expanded.has(id))W.expanded.delete(id);else W.expanded.add(id);store.set('noctua.workspaceExpanded.'+target,JSON.stringify([...W.expanded]));renderWorkspaceTree();return;}
 rememberWorkspaceView();await saveWorkspaceFile();await flushNoteEdits();if(W.target!==target)return;stopEdit();
 if(typeof paperUnmount==='function')paperUnmount();
 if(e.kind==='note'){W.file=null;await openNote(e.note);return;}
 const r=await api(workspaceURL()+'/files/'+enc(id));if(target!==W.target)return;
 W.file=id;W.text=r.text??'';W.saved=W.text;W.dirty=false;W.manifest.revision=r.revision;W.fileRevision=r.revision;W.fileHistory=r.history||{};
 const url=workspaceURL()+'/files/'+enc(id)+'/content',ext=(e.source_name||e.name).split('.').pop().toLowerCase();
 const preview=r.text!=null?`<textarea class="workspace-source" aria-label="File source" spellcheck="false"></textarea>`:['png','jpg','jpeg','gif','webp'].includes(ext)?`<img src="${url}" alt="${esc(e.name)}">`:['mp4','m4v','mov','webm'].includes(ext)?`<video src="${url}" controls></video>`:ext==='pdf'?`<iframe title="PDF preview" src="${url}"></iframe>`:`<p>This file can be downloaded below.</p>`;
 $('#notes-stage').innerHTML=`<div id="workspace-editor"><header><strong title="${esc(e.name)}">${esc(e.name)}</strong><span data-file-status role="status">Saved</span>${historyButtons('file')}<button data-reload-file data-icon="refresh-cw" data-icon-only title="Reload saved file" aria-label="Reload saved file"></button><a class="workspace-download" href="${url}" download="${esc(e.name)}">Download</a></header>${preview}</div>`;
 $('#workspace-editor [data-reload-file]').onclick=()=>{if(W.dirty&&!confirm('Discard unsaved changes and reload this file?'))return;W.dirty=false;openWorkspaceFile(id).catch(e=>toast(e.message,{error:true}));};
 const ta=$('#workspace-editor textarea');if(ta){ta.value=W.text;ta.oninput=()=>{W.text=ta.value;W.dirty=true;updateWorkspaceHistory();$('#workspace-editor [data-file-status]').textContent='Unsaved';clearTimeout(W.timer);W.timer=setTimeout(()=>saveWorkspaceFile().catch(err=>toast(err.message,{error:true})),800);};ta.onblur=()=>saveWorkspaceFile().catch(err=>toast(err.message,{error:true}));}
 store.set('noctua.openFile.'+target,id);
 renderWorkspaceTree();if(typeof paperMount==='function')paperMount(e);
 if(ta){try{const view=JSON.parse(store.get('noctua.fileView.'+target+'.'+id)||'null');if(view){ta.setSelectionRange(view.start||0,view.end||0);ta.scrollTop=view.top||0;ta.scrollLeft=view.left||0;}}catch{}}
}
async function saveWorkspaceFile(){
 clearTimeout(W.timer);if(W.saving){await W.saving;if(W.dirty)return saveWorkspaceFile();return;}
 if(!W.dirty||!W.file)return;const target=W.target,id=W.file,text=W.text,revision=W.fileRevision;
 W.saving=(async()=>{const m=await api(`/api/workspaces/${enc(target)}`,{op:'edit',id,text,revision});if(W.target!==target||W.file!==id)return;W.manifest=m;W.fileRevision=m.revision;W.saved=text;W.dirty=W.text!==text;const info=await api(`/api/workspaces/${enc(target)}/files/${enc(id)}`);if(W.target===target&&W.file===id)W.fileHistory=info.history||{};const status=$('#workspace-editor [data-file-status]');if(status)status.textContent=W.dirty?'Unsaved':'Saved';renderWorkspaceTree();applyBibliography();})();
 try{await W.saving;}catch(e){const status=$('#workspace-editor [data-file-status]');if(status)status.textContent='Save failed: '+e.message;throw e;}finally{W.saving=null;}
}
async function workspaceUndo(redo=false,fileOnly=false){try{const target=W.target;const caret=$('#workspace-editor textarea')?.selectionStart;await saveWorkspaceFile();if(W.target!==target)return;const id=W.file;W.manifest=await api(workspaceURL()+(fileOnly&&id?'/files/'+enc(id)+'/history':'/history'),{revision:fileOnly?W.fileRevision:W.manifest.revision,redo});renderWorkspaceTree();applyBibliography();if(id&&W.manifest.entries.some(e=>e.id===id&&!e.deleted)){await openWorkspaceFile(id);if(caret!=null){const ta=$('#workspace-editor textarea');ta?.focus();ta?.setSelectionRange(Math.min(caret,ta.value.length),Math.min(caret,ta.value.length));}}else if(id){W.file=null;renderEditor();}}catch(e){toast(e.message,{error:true});}}
function showBibReference(key){const it=N.items.get(key);if(!it?.bib)return false;const safe=u=>{try{const url=new URL(u);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}};const url=safe(it.url)||(it.doi?safe('https://doi.org/'+it.doi):null);const d=workspaceDialog(it.title||key,`<p>${esc(it.creators.join('; '))} · ${esc(it.year||'n.d.')}</p><p>Key: ${esc(key)} · ${esc(it.file_name)}</p>${url?`<a href="${esc(url)}" target="_blank" rel="noopener">Open reference</a>`:''}${it.library_key?'<button data-paper>Open library paper</button>':''}<button data-bib>Edit bibliography</button>`);d.querySelector('[data-bib]').onclick=()=>{d.close();openWorkspaceFile(it.file_id).catch(e=>toast(e.message));};if(it.library_key)d.querySelector('[data-paper]').onclick=()=>{d.close();const paper=N.items.get(it.library_key);if(paper){lib.detail=paper;renderLibDetails(paper);showRightTab('paper');}};return true;}
window.addEventListener('beforeunload',e=>{if(W.dirty){e.preventDefault();e.returnValue='';}});

function chatProjectTarget(){return isNotesMode()?N.target:(G.project?.target||lib.target||N.target||null);}
async function showSkillRun(id){
 const d=workspaceDialog('Skill script request','<div data-run>Loading…</div>');let timer;
 const update=async()=>{if(!d.isConnected)return;try{const r=await api('/api/skill-runs/'+enc(id));const pending=r.status==='approval_required',review=r.status==='review_required';
  d.querySelector('[data-run]').innerHTML=`<p>Status: <strong>${esc(r.status)}</strong></p><p>${esc(r.interpreter)} ${esc(r.script)} ${(r.args||[]).map(esc).join(' ')}</p><p>Project: ${esc(r.target)}. Inputs: ${esc((r.input_paths||r.files||[]).join(', ')||'none')}. Working directory: temporary project copy.</p>${pending?`<p>This runs local code with your user permissions. The temporary directory is not an OS security sandbox. Only approve skills you trust.</p><details><summary>Script source</summary><pre>${esc(r.script_text)}</pre></details><button data-action="approve">Approve this run</button><button data-action="reject">Reject</button>`:''}${r.status==='running'?'<button data-action="cancel">Cancel run</button>':''}${r.error?`<p class="workspace-error">${esc(r.error)}</p>`:''}${r.stdout||r.stderr?`<details open><summary>Execution log</summary><pre>${esc(r.stdout||'')}\n${esc(r.stderr||'')}</pre></details>`:''}${review?`<p>Review output before applying it. Nothing below has changed the live project.</p>${(r.changes||[]).map(c=>`<details><summary>${c.deleted?'Delete':c.id?'Update':'Create'} ${esc(c.path)}</summary><h4>Before</h4><pre>${esc((c.before||'(binary or new file)').slice(0,20000))}</pre><h4>After</h4><pre>${esc((c.deleted?'(deleted)':c.text??'(binary file)').slice(0,20000))}</pre></details>`).join('')||'<p>No project files changed.</p>'}<button data-action="apply">Apply reviewed changes</button><button data-action="reject">Discard changes</button>`:''}`;
  d.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{if(b.dataset.action==='apply')await saveWorkspaceFile();if(b.dataset.action==='approve'&&chat.mode==='plan')throw Error('Switch out of Plan mode before approving a script.');const result=await api('/api/skill-runs/'+enc(id),{action:b.dataset.action});if(b.dataset.action==='apply'&&W.target===r.target){W.manifest=result;await refreshWorkspaceView(r.target);}await update();}catch(e){toast(e.message,{error:true});b.disabled=false;}});
  clearTimeout(timer);if(r.status==='running')timer=setTimeout(update,1000);
 }catch(e){d.querySelector('[data-run]').textContent=e.message;}};
 d.addEventListener('close',()=>clearTimeout(timer));await update();
}
// Inline requests are keyed by file approval, never by chat-wide permission.
const fileEditApprovals = new Map();
function editDiffLines(before, after) {
 const a=String(before??'').split('\n'),b=String(after??'').split('\n');
 let first=0,last=0;
 while(first<a.length&&first<b.length&&a[first]===b[first])first++;
 while(last<a.length-first&&last<b.length-first&&a[a.length-1-last]===b[b.length-1-last])last++;
 const rows=[];
 if(first)rows.push(...a.slice(Math.max(0,first-3),first).map(text=>({kind:'context',text})));
 const x=a.slice(first,a.length-last),y=b.slice(first,b.length-last);
 // Bounded LCS gives useful separate hunks for ordinary edits without freezing
 // the desktop for a rewritten 2 MB source file. Large rewrites use block diffs.
 if(x.length+y.length<=4000&&x.length*y.length<=250000){
  const table=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));
  for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i][j]=x[i]===y[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
  let i=0,j=0;while(i<x.length||j<y.length){if(i<x.length&&j<y.length&&x[i]===y[j]){rows.push({kind:'context',text:x[i++]});j++;}else if(i<x.length&&(j===y.length||table[i+1][j]>=table[i][j+1]))rows.push({kind:'removed',text:x[i++]});else rows.push({kind:'added',text:y[j++]});}
 }else{for(const text of x)rows.push({kind:'removed',text});for(const text of y)rows.push({kind:'added',text});}
 if(last)rows.push(...a.slice(a.length-last,a.length-last+3).map(text=>({kind:'context',text})));
 const compact=[];for(let i=0;i<rows.length;){if(rows[i].kind!=='context'){compact.push(rows[i++]);continue;}let end=i;while(end<rows.length&&rows[end].kind==='context')end++;if(end-i>6){compact.push(...rows.slice(i,i+3),{kind:'gap',text:`… ${end-i-6} unchanged lines …`},...rows.slice(end-3,end));}else compact.push(...rows.slice(i,end));i=end;}
 return compact;
}
function fileEditDiffHTML(changes) {
 return changes.map(c=>{
  const label={create:'Create',edit:'Edit',rename:'Rename',move:'Move',folder:'New folder'}[c.op]||'Change';
  let body;
  if(c.op==='edit'||c.op==='create'){
   const rows=editDiffLines(c.before,c.after),shown=rows.slice(0,500);
   body=`<pre class="edit-diff">${shown.map(r=>`<span class="diff-${r.kind}">${r.kind==='added'?'+':r.kind==='removed'?'-':' '} ${esc(r.text.slice(0,2000))}${r.text.length>2000?' … [line shortened]':''}</span>`).join('')}</pre>${rows.length>500?'<p class="hint">Snapshot limited to 500 lines.</p>':''}`;
  }else body=`<p>${c.op==='rename'?`→ ${esc(c.new_name)}`:c.op==='move'?`Destination: ${esc(c.parent||'Project root')}`:'Create folder'}</p>`;
  return `<section class="edit-diff-file"><h4>${esc(label)} · ${esc(c.name||'Untitled')} <small>${esc(c.target||'')}</small></h4>${body}</section>`;
 }).join('');
}
function showFileEditApproval(a, host) {
 const key=a.approval_id;
 if(fileEditApprovals.has(key)){const previous=fileEditApprovals.get(key);if(!previous.card.isConnected)(host||document.querySelector('#chat-log .msg.assistant:last-child')||$('#chat-log')).appendChild(previous.card);if(!previous.deciding&&!previous.settled)previous.card.querySelector('[data-diffs]').innerHTML=fileEditDiffHTML(a.changes);return;}
 const d=document.createElement('section');d.className='chat-edit-approval';
 d.innerHTML=`<p><strong>Allow edits to ${esc(a.changes[0]?.name||'this file')} for this prompt?</strong></p><details><summary>View proposed changes</summary><div class="edit-diff-scroll" data-diffs>${fileEditDiffHTML(a.changes)}</div></details><p class="workspace-error" role="alert" data-error></p><footer><button data-reject>Decline</button><button class="primary" data-approve>Allow this file</button></footer><p data-status role="status"></p>`;
 (host||document.querySelector('#chat-log .msg.assistant:last-child')||$('#chat-log')).appendChild(d);
 const state={card:d,deciding:false,settled:false};fileEditApprovals.set(key,state);
 const decide=async approve=>{
  if(state.deciding||state.settled)return;state.deciding=true;
  d.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
   if(approve)await saveWorkspaceFile();
   if(state.settled)return;
   await api('/api/chat-edit-approvals/'+enc(a.turn_id),{chat_id:a.chat_id,approval_id:key,approve});
   if(state.settled)return;
   state.settled=true;d.querySelector('footer').hidden=true;
   d.querySelector('[data-status]').textContent=approve?'Allowed for this prompt.':'Declined for this prompt.';
   d.querySelector('details').open=false;
  }catch(e){if(!state.settled)d.querySelector('[data-error]').textContent=e.message;}
  finally{state.deciding=false;if(!state.settled)d.querySelectorAll('button').forEach(b=>b.disabled=false);}
 };
 d.querySelector('[data-approve]').onclick=()=>decide(true);
 d.querySelector('[data-reject]').onclick=()=>decide(false);
}
function closeFileEditApprovals(){for(const s of fileEditApprovals.values()){if(!s.settled){s.card.querySelector('[data-status]').textContent='Request ended without approval.';s.card.querySelector('footer').hidden=true;}s.settled=true;s.card.querySelectorAll('button').forEach(b=>b.disabled=true);}fileEditApprovals.clear();}


async function refreshWorkspaceView(target){
 if(N.target!==target)return;
 const notes=await api(`/api/notes?target=${enc(target)}`);
 if(N.target!==target)return;
 N.list=notes;if(typeof REF!=='undefined')REF.at=0;
 const file=W.target===target?W.file:null;
 await loadWorkspace(target);
 if(file&&W.file===file&&!W.dirty){if(W.manifest?.entries.some(e=>e.id===file&&!e.deleted))await openWorkspaceFile(file);else{W.file=null;renderEditor();}}
}

function showWorkspaceTrash(){
 const target=W.target,entries=(W.manifest?.entries||[]).filter(e=>e.deleted&&!e.purged).sort((a,b)=>(b.deleted_at||0)-(a.deleted_at||0)),selected=new Set();let busy=false;
 const d=workspaceDialog('Project trash',`<ul class="workspace-trash-list" aria-label="Deleted entries" role="listbox" aria-multiselectable="true">${entries.map(e=>`<li data-trash-select="${esc(e.id)}" role="option" aria-selected="false" tabindex="0"><span class="workspace-trash-name" title="${esc(e.name)}">${esc(e.name)}</span></li>`).join('')||'<li class="hint">Trash is empty.</li>'}</ul><p class="workspace-error" data-error role="alert"></p><footer><span data-selected-count>0 selected</span><button data-restore-selected data-icon="undo-2" disabled>Restore</button><button data-purge data-icon="trash-2" disabled>Delete permanently</button></footer>`);
 d.classList.add('workspace-compact','workspace-trash');
 const update=()=>{d.querySelector('[data-selected-count]').textContent=selected.size+' selected';d.querySelector('[data-restore-selected]').disabled=busy||!selected.size;d.querySelector('[data-purge]').disabled=busy||!selected.size;d.querySelectorAll('[data-trash-select]').forEach(input=>{const chosen=selected.has(input.dataset.trashSelect);input.setAttribute('aria-selected',String(chosen));input.classList.toggle('selected',chosen);});};
 d.querySelectorAll('[data-trash-select]').forEach(row=>{const toggle=()=>{if(busy)return;if(selected.has(row.dataset.trashSelect))selected.delete(row.dataset.trashSelect);else selected.add(row.dataset.trashSelect);update();};row.onclick=toggle;row.onkeydown=event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();toggle();}};});
 d.addEventListener('keydown',event=>{if(!busy&&!event.isComposing&&(event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='a'){event.preventDefault();d.querySelectorAll('[data-trash-select]').forEach(input=>selected.add(input.dataset.trashSelect));update();}});
 const restore=async ids=>{
  if(busy)return;busy=true;d.querySelectorAll('button,input').forEach(control=>control.disabled=true);
  const depth=id=>{let entry=entries.find(e=>e.id===id),n=0;const seen=new Set();while(entry?.parent&&!seen.has(entry.parent)){seen.add(entry.parent);n++;entry=entries.find(e=>e.id===entry.parent);}return n;};
  try{for(const id of ids.sort((a,b)=>depth(a)-depth(b))){
   if(W.target!==target)throw Error('Project changed. Reopen Trash.');
   await workspaceChange({op:'restore',id});selected.delete(id);d.querySelector(`[data-trash-select="${CSS.escape(id)}"]`)?.remove();
  }d.close();showWorkspaceTrash();
  }catch(e){d.querySelector('[data-error]').textContent=e.message;}
  finally{busy=false;d.querySelectorAll('button,input').forEach(control=>control.disabled=false);update();}
 };
 d.querySelector('[data-purge]').onclick=()=>{
  const ids=[...selected],confirm=workspaceDialog('Delete permanently?',`<p>Delete ${ids.length} selected entries? Folders include their contents. This cannot be undone and clears project undo history.</p><p data-error class="workspace-error" role="alert"></p><footer><button data-cancel>Cancel</button><button data-confirm-purge>Delete permanently</button></footer>`);confirm.classList.add('workspace-compact');
  confirm.querySelector('[data-cancel]').onclick=()=>confirm.close();confirm.querySelector('[data-confirm-purge]').onclick=async()=>{const button=confirm.querySelector('[data-confirm-purge]');button.disabled=true;try{if(W.target!==target)throw Error('Project changed. Reopen Trash.');await workspaceChange({op:'purge',ids});confirm.close();d.close();showWorkspaceTrash();}catch(error){confirm.querySelector('[data-error]').textContent=error.message;button.disabled=false;}};
 };
 d.querySelector('[data-restore-selected]').onclick=()=>restore([...selected]);
 d.querySelector('[data-trash-select]')?.focus();
}

// Slash commands select available skills for one message, without changing defaults.
window.NoctuaSkillPicker=(()=>{
 const input=$('#chat-input'),popup=$('#skill-picker');
 let results=[],index=0,version=0,active=null;
 const token=s=>'/'+(s.name||s.id).trim().replace(/\s+/g,'-');
 function commands(skills){
  const counts=new Map();for(const s of skills)counts.set(token(s),(counts.get(token(s))||0)+1);
  return skills.map(s=>({...s,command:token(s)+(counts.get(token(s))>1?'-'+s.id:'')}));
 }
 function query(){
  if(!input||input.selectionStart!==input.selectionEnd)return null;
  const before=input.value.slice(0,input.selectionEnd),m=/(?:^|\s)\/([^\s/]{0,100})$/.exec(before);
  return m?{text:before,start:before.length-m[1].length-1,q:m[1].toLowerCase()}:null;
 }
 function close(){version++;active=null;results=[];if(popup)popup.hidden=true;if(input){input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}}
 function render(message){
  popup.innerHTML=results.length?results.map((s,i)=>`<div role="option" id="skill-option-${i}" aria-selected="${i===index}" data-skill-index="${i}" class="skill-option${i===index?' active':''}"><strong>${esc(s.command)}</strong><small>${esc([s.project_name,s.description].filter(Boolean).join(' · ')||'Skill')}</small></div>`).join(''):`<div class="skill-empty" role="status">${esc(message)}</div>`;
  popup.hidden=false;input.setAttribute('aria-expanded','true');
  if(results.length)input.setAttribute('aria-activedescendant','skill-option-'+index);else input.removeAttribute('aria-activedescendant');
  popup.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});
 }
 async function update(){
  const q=query();if(!q||chat.busy||chat.switching)return close();
  const request=++version;active=q;results=[];index=0;render('Loading skills…');
  try{
   const skills=commands(await api('/api/skills'));
   if(request!==version||query()?.text!==q.text||document.activeElement!==input)return;
   results=skills.filter(s=>`${s.command} ${s.description||''} ${s.project_name||''}`.toLowerCase().includes(q.q)).sort((a,b)=>a.command.localeCompare(b.command));
   render(skills.length?'No matching skills.':'No skills found. Install a global skill with the Skills CLI or import one in Settings → Skills.');
  }catch(e){if(request===version)render('Could not load skills: '+e.message);}
 }
 function pick(i){
  const s=results[i],q=query();if(!s||!q||q.text!==active?.text)return close();
  const end=input.selectionEnd;input.setRangeText(s.command+' ',q.start,end,'end');close();input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));
 }
 function key(e){
  if(!popup||popup.hidden||e.isComposing||e.shiftKey||e.ctrlKey||e.metaKey||e.altKey)return false;
  if(!['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key))return false;
  e.preventDefault();
  if(e.key==='Escape')close();
  else if(e.key==='Enter'||e.key==='Tab'){if(results.length)pick(index);else if(e.key==='Tab')close();}
  else if(results.length){index=(index+(e.key==='ArrowDown'?1:results.length-1))%results.length;render();}
  return true;
 }
 async function prepare(text){
  const tokens=new Set(text.split(/\s+/));
  if(![...tokens].some(t=>t.startsWith('/')))return {ids:[],instructions:''};
  const selected=commands(await api('/api/skills')).filter(s=>tokens.has(s.command));
  if(!selected.length)return {ids:[],instructions:''};
  return {ids:selected.map(s=>s.id),instructions:'The user explicitly selected these skills for this message. Read each SKILL.md with read_skill and follow its instructions within the current mode and tool permissions:\n'+selected.map(s=>`${s.command}: skill_id=${JSON.stringify(s.id)}, path="SKILL.md"`).join('\n')};
 }
 if(input&&popup){
  input.addEventListener('input',update);input.addEventListener('click',update);
  input.addEventListener('blur',close);
  input.addEventListener('keyup',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key))update();});
  popup.addEventListener('mousedown',e=>{e.preventDefault();const item=e.target.closest('[data-skill-index]');if(item)pick(Number(item.dataset.skillIndex));});
  document.addEventListener('pointerdown',e=>{if(e.target!==input&&!popup.contains(e.target))close();});
 }
 return {key,close,prepare};
})();

// Server-backed assistant edits preserve optimistic versions and local drafts.
async function refreshAgentNote(a){
 if(typeof REF!=='undefined')REF.at=0;
 if(N.target!==a.target)return;
 const target=N.target,id=a.note_id;
 const doc=await api(`/api/notes/${enc(target)}/${enc(id)}`);
 if(N.target!==target)return;
 const active=!W.file&&N.doc?.id===id;
 if(active&&(N.dirty||N.saving)){
  // An in-flight save meets the newer copy as a 409 and merges there.
  if(doc.updated>N.doc.updated&&!N.saving&&!N.conflict&&!mergeServerNote(doc)){N.conflict=true;showConflict();}
  return;
 }
 const entry=N.list.find(n=>n.id===id);if(entry){entry.title=doc.title;entry.updated=doc.updated;}
 if(W.target===target)renderWorkspaceTree();
 if(!active||doc.updated<=N.doc.updated)return;
 await showNote(doc);
}
async function showAgentEdits(){
 const list=await api('/api/agent-edits');
 const d=workspaceDialog('Assistant changes',list.length?list.map(p=>`<p><button data-proposal="${esc(p.proposal_id)}">${esc(agentEditLabel(p.tool))} · ${esc(agentProjectName(p.folder_id))}</button></p>`).join(''):'<p>No pending assistant changes.</p>');
 d.querySelectorAll('[data-proposal]').forEach(b=>b.onclick=()=>{d.close();showAgentEdit(b.dataset.proposal).catch(e=>toast(e.message,{error:true}));});
}
function agentEditLabel(tool){return {edit_note:'Edit note',create_note:'Create note',edit_project_file:'Edit project files'}[tool]||'Assistant change';}
function agentProjectName(target){return typeof collections!=='undefined'?(collections.targets.find(t=>t.id===target)?.name||'Project'):'Project';}
function agentEditPreview(p){
 const a=p.args,source=(label,text)=>`<details open><summary>${esc(label)}</summary><pre>${esc(text||'')}</pre></details>`;
 if(p.tool==='edit_note'){
  let html='';
  if(Object.hasOwn(a,'title'))html+=source('Title',`${p.before?.title||''} → ${a.title}`);
  if(Object.hasOwn(a,'preamble'))html+=source('Current preamble',p.before?.preamble)+source('Proposed preamble',a.preamble);
  for(const e of a.edits||[]){const i=p.before?.blocks.findIndex(b=>b.id===e.block_id)??-1,b=p.before?.blocks[i];
   const label=i>=0?`Block ${i+1}`:'Beginning of note';
   if(e.op==='replace')html+=source(`${label}: current ${b?.type==='ink'?'drawing (preserved)':'text'}`,b?.type==='ink'?'Drawing':b?.src)+source('Proposed text',e.latex);
   else if(e.op==='delete')html+=source(`${label}: remove`,b?.type==='ink'?'Drawing':b?.src);
   else if(e.op==='move'){const after=p.before?.blocks.findIndex(b=>b.id===e.after_block_id)??-1;html+=`<p>Move ${esc(label.toLowerCase())} ${after<0?'to the beginning':`after block ${after+1}`}.</p>`;}
   else html+=source(`Insert text after ${label.toLowerCase()}`,e.latex);
  }
  return html;
 }
 if(p.tool==='create_note')return source('New note title',a.title)+source('Destination',p.destination_name||'Project root')+source('Initial text',a.latex);
 const op={create:'Create text file',edit:'Edit text file',rename:'Rename entry',move:'Move entry',folder:'Create folder'}[a.op]||'Update entry';
 let html=`<p>${esc(op)}${p.before_entry?.name?`: ${esc(p.before_entry.name)}`:''}${a.name?` → ${esc(a.name)}`:''}</p>`;
 if(Object.hasOwn(a,'parent')){const parent=W.target===a.folder_id?W.manifest?.entries.find(e=>e.id===a.parent):null;html+=`<p>Destination: ${esc(p.destination_name||(a.parent?(parent?.name||'Selected folder'):'Project root'))}</p>`;}
 if(a.op==='edit')html+=source('Current source',p.before_text);
 if(Object.hasOwn(a,'text'))html+=source('Proposed source',a.text);
 return html;
}
async function showAgentEdit(id){
 const p=await api('/api/agent-edits/'+enc(id));
 const d=workspaceDialog('Review assistant changes',`<p>${esc(agentEditLabel(p.tool))} · ${esc(agentProjectName(p.args.folder_id))} · ${esc(p.status)}</p>${p.args.summary?`<p>${esc(p.args.summary)}</p>`:''}${agentEditPreview(p)}<p role="alert" data-error></p>${p.status==='proposed'?'<button data-accept>Accept all changes</button><button data-reject>Reject</button>':''}`);
 for(const action of ['accept','reject']){const button=d.querySelector('[data-'+action+']');if(!button)continue;button.onclick=async()=>{
  d.querySelectorAll('[data-accept],[data-reject]').forEach(b=>b.disabled=true);
  try{
   if(action==='accept'){stopEdit();await saveWorkspaceFile();await flushNoteEdits();}
   const r=await api('/api/agent-edits/'+enc(id),{action});
   if(r.status==='applied'){
    if(p.tool==='edit_note')await refreshAgentNote({target:p.args.folder_id,note_id:p.args.note_id});
    else if(W.target===p.args.folder_id)await refreshWorkspaceView(p.args.folder_id);
   }
   d.close();
  }catch(e){d.querySelector('[data-error]').textContent=e.message;d.querySelectorAll('[data-accept],[data-reject]').forEach(b=>b.disabled=false);}
 };}
}
async function prepareNoteDrawing(a){
 const doc=await api(`/api/notes/${enc(a.folder_id)}/${enc(a.note_id)}`);
 if(doc.updated!==a.updated)throw Error('Drawing changed. Read the note again.');
 const block=doc.blocks.find(b=>b.id===a.block_id&&b.type==='ink');if(!block)throw Error('Drawing block not found.');
 const png=Ink.preview(block);if(!png)throw Error('Drawing is empty.');
 const bytes=await (await fetch(png)).blob();
 const r=await fetch(`/api/note-drawings/${enc(a.folder_id)}/${enc(a.note_id)}/${enc(a.block_id)}/${a.updated}`,{method:'POST',headers:{'Content-Type':'image/png'},body:bytes});
 if(!r.ok)throw Error('Could not cache the drawing preview.');
}
