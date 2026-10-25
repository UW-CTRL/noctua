'use strict';
const W={expanded:new Set(),drag:null,target:null,manifest:null,file:null,text:'',saved:'',timer:null,saving:null,dirty:false,fileRevision:null,fileHistory:{}};
const workspaceURL=()=>`/api/workspaces/${enc(W.target)}`;
function workspaceDialog(title,html){const d=document.createElement('dialog');d.className='workspace-dialog';d.setAttribute('aria-label',title);d.innerHTML=`<header><strong>${esc(title)}</strong><button data-close data-icon="x" data-icon-only title="Close" aria-label="Close"></button></header>${html}`;document.body.appendChild(d);d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());d.showModal();return d;}
async function loadWorkspace(target){
 try{const m=await api(`/api/workspaces/${enc(target)}`);if(N.target!==target)return;if(W.target!==target){try{W.expanded=new Set(JSON.parse(store.get('noctua.workspaceExpanded.'+target)||'[]'));}catch{W.expanded=new Set();}}W.target=target;W.manifest=m;renderWorkspaceTree();applyBibliography();}catch(e){toast(e.message,{error:true});}
}
function applyBibliography(){
 if(!W.manifest||W.target!==N.target)return;
 for(const [key,it]of N.items)if(it.bib)N.items.delete(key);
 for(const it of W.manifest.bib_index||[])if(!N.items.has(it.key))N.items.set(it.key,it);
 typeset();
}
function updateWorkspaceHistory(){document.querySelectorAll('[data-history="workspace"],[data-history="file"]').forEach(el=>{const history=el.dataset.history==='file'?W.fileHistory:W.manifest?.history;for(const action of ['undo','redo']){const b=el.querySelector(`[data-${action}]`);b.disabled=action==='redo'&&W.dirty||!(history?.[action]||(action==='undo'&&W.dirty));b.title=history?.[action]?`${action}: ${history[action]}`:action;}});}
function renderWorkspaceTree(){
 let tree=document.getElementById('workspace-tree');if(!tree){tree=document.createElement('div');tree.id='workspace-tree';$('#note-list').before(tree);}
 $('#note-list').hidden=true;
 const m=W.manifest;if(!m)return;
 const entries=m.entries.filter(e=>!e.deleted);
 const children=(parent,depth=0)=>entries.filter(e=>(e.parent||'')===parent).sort((a,b)=>(a.kind==='folder'?-1:0)-(b.kind==='folder'?-1:0)||a.name.localeCompare(b.name)).map(e=>{
  const title=e.kind==='note'&&!e.renamed?(N.list.find(n=>n.id===e.note)?.title||e.name):e.name;
  const active=e.kind==='note'?(!W.file&&N.doc?.id===e.note):W.file===e.id;
  const icon=e.kind==='folder'?(W.expanded.has(e.id)?'folder-open':'folder'):e.kind==='note'?'notebook-pen':/\.bib$/i.test(e.name)?'library':'file-text';
  return `<div class="workspace-entry ${active?'active':''}" draggable="true" data-entry="${esc(e.id)}" ${e.kind==='folder'?`data-drop-folder="${esc(e.id)}"`:''} style="--depth:${depth}"><button data-file="${esc(e.id)}" data-icon="${icon}" title="${esc(title)}" ${active?'aria-current="page"':''} ${e.kind==='folder'?`aria-expanded="${W.expanded.has(e.id)}"`: ''}><span class="workspace-name">${esc(title)}</span></button><button data-file-menu="${esc(e.id)}" data-icon="ellipsis" data-icon-only title="Actions for ${esc(title)}" aria-label="Actions for ${esc(title)}"></button></div>${e.kind==='folder'&&W.expanded.has(e.id)?children(e.id,depth+1):''}`;
 }).join('');
 const action=(attr,icon,label)=>`<button ${attr} data-icon="${icon}" data-icon-only title="${label}" aria-label="${label}"></button>`;
 tree.innerHTML=`${m.bib_error?`<p class="workspace-error" role="alert">Bibliography out of date: ${esc(m.bib_error)}</p>`:''}<div class="workspace-root-drop" data-drop-folder="" title="Drop an entry here to move it out of its folder">Project root</div><div class="workspace-entries">${children('')||'<p class="hint">No files yet. Create a note or import a file.</p>'}</div><div class="workspace-footer"><div role="group" aria-label="Project settings">${action('data-bibliographies','library','Bibliographies')}${action('data-skills','sparkles','Agent skills')}${action('data-trash','trash-2','Project trash')}${action('data-agent-edits','list-checks','Assistant changes')}</div>${historyButtons('workspace')}</div>`;
 updateWorkspaceHistory();
 $('#notes-side [data-new-file]').onclick=()=>workspaceCreate(false);$('#notes-side [data-new-folder]').onclick=()=>workspaceCreate(true);$('#notes-side [data-import-file]').onclick=workspaceImport;tree.querySelector('[data-bibliographies]').onclick=workspaceBibliographies;tree.querySelector('[data-skills]').onclick=showSkills;tree.querySelector('[data-trash]').onclick=showWorkspaceTrash;tree.querySelector('[data-agent-edits]').onclick=()=>showAgentEdits().catch(e=>toast(e.message,{error:true}));
 tree.querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>openWorkspaceFile(b.dataset.file).catch(e=>toast(e.message,{error:true})));
 tree.querySelectorAll('[data-file-menu]').forEach(b=>b.onclick=()=>workspaceFileMenu(b.dataset.fileMenu));
 bindWorkspaceDrag(tree);
}
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
async function moveWorkspaceEntry(item,parent){
 const error=workspaceDropError(item,parent);if(error)throw Error(error);
 const entry=W.manifest.entries.find(e=>e.id===item.id);if((entry.parent||'')===parent)return;
 await workspaceChange({op:'move',id:item.id,parent});
 if(parent)W.expanded.add(parent);
 store.set('noctua.workspaceExpanded.'+W.target,JSON.stringify([...W.expanded]));renderWorkspaceTree();
}
function bindWorkspaceDrag(tree){
 const clear=()=>{tree.querySelectorAll('.workspace-drop-active').forEach(el=>el.classList.remove('workspace-drop-active'));};
 tree.ondragstart=e=>{
  const row=e.target.closest('[data-entry]');if(!row||e.target.closest('[data-file-menu]')){e.preventDefault();return;}
  W.drag={target:W.target,id:row.dataset.entry};e.dataTransfer.setData(workspaceDragType,JSON.stringify(W.drag));e.dataTransfer.effectAllowed='move';tree.classList.add('workspace-dragging');
 };
 tree.ondragend=()=>{clear();W.drag=null;tree.classList.remove('workspace-dragging');};
 tree.ondragover=e=>{
  if(!Array.from(e.dataTransfer?.types||[]).includes(workspaceDragType))return;
  tree.classList.add('workspace-dragging');
  const destination=e.target.closest('[data-drop-folder],[data-trash]');clear();e.preventDefault();
  if(!destination){e.dataTransfer.dropEffect='none';return;}
  const parent=destination.hasAttribute('data-trash')?null:destination.dataset.dropFolder;
  if(W.drag&&workspaceDropError(W.drag,parent)){e.dataTransfer.dropEffect='none';return;}
  e.dataTransfer.dropEffect='move';destination.classList.add('workspace-drop-active');tree.classList.add('workspace-dragging');
 };
 tree.ondragleave=e=>{if(!tree.contains(e.relatedTarget)){clear();tree.classList.remove('workspace-dragging');}};
 tree.ondrop=async e=>{
  if(!Array.from(e.dataTransfer?.types||[]).includes(workspaceDragType))return;
  e.preventDefault();e.stopPropagation();clear();tree.classList.remove('workspace-dragging');W.drag=null;
  const destination=e.target.closest('[data-drop-folder],[data-trash]');if(!destination)return;
  try{
   const item=JSON.parse(e.dataTransfer.getData(workspaceDragType)),parent=destination.hasAttribute('data-trash')?null:destination.dataset.dropFolder;
   const error=workspaceDropError(item,parent);if(error)throw Error(error);
   if(parent===null)confirmWorkspaceTrash(item.id);else await moveWorkspaceEntry(item,parent);
  }catch(error){toast(error.message,{error:true});}
 };
}
async function workspaceChange(body){const target=W.target;await saveWorkspaceFile();if(target!==W.target)throw Error('Project changed. Please try again.');const m=await api(workspaceURL(),{revision:W.manifest.revision,...body});W.manifest=m;W.fileRevision=m.revision;renderWorkspaceTree();applyBibliography();return m;}
function workspaceCreate(folder){
 const target=W.target,folders=W.manifest.entries.filter(e=>e.kind==='folder'&&!e.deleted);
 const d=workspaceDialog(folder?'New folder':'New note or file',`<form class="workspace-create">${folder?'':'<label>Type <select data-kind><option value="file">Text file</option><option value="note">Note</option></select></label>'}<label>Name <input data-name required maxlength="200" placeholder="${folder?'Folder name':'references.bib'}" autocomplete="off"></label><label>Folder <select data-parent><option value="">Project root</option>${folders.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label><p class="workspace-error" role="alert" data-error></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Create</button></footer></form>`);
 d.classList.add('workspace-compact');
 d.querySelector('[data-cancel]').onclick=()=>d.close();
 d.querySelector('form').onsubmit=async event=>{
  event.preventDefault();const button=d.querySelector('[type="submit"]');button.disabled=true;
  try{
   if(W.target!==target)throw Error('The selected project changed. Close this dialog and try again.');
   const name=d.querySelector('[data-name]').value.trim();if(!name)throw Error('Enter a name.');
   if(!folder&&d.querySelector('[data-kind]').value==='note'){
    const doc=await createNote(name);if(!doc)throw Error('Could not create the note.');
    const parent=d.querySelector('[data-parent]').value,entry=W.manifest.entries.find(e=>e.note===doc.id&&!e.deleted);
    if(parent&&entry){await workspaceChange({op:'move',id:entry.id,parent});W.expanded.add(parent);store.set('noctua.workspaceExpanded.'+target,JSON.stringify([...W.expanded]));renderWorkspaceTree();}
    d.close();$('.note-title')?.focus();return;
   }
   const ids=new Set(W.manifest.entries.map(e=>e.id));
   const m=await workspaceChange({op:folder?'folder':'create',name,text:'',parent:d.querySelector('[data-parent]').value});
   const entry=m.entries.find(e=>!ids.has(e.id)&&e.kind===(folder?'folder':'file'));
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

function workspaceFileMenu(id){
 const e=W.manifest.entries.find(e=>e.id===id);const folders=W.manifest.entries.filter(f=>f.kind==='folder'&&!f.deleted&&f.id!==id);
 const d=workspaceDialog(e.name,`${e.references?.length?`<p>Used in: ${e.references.map(n=>esc(n.title)).join(', ')}</p>`:''}<label>Name <input data-name value="${esc(e.name)}"></label><button data-rename data-icon="pencil">Rename</button><label>Folder <select data-parent><option value="">Project root</option>${folders.map(f=>`<option value="${f.id}" ${f.id===e.parent?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label><button data-move data-icon="folder">Move</button><button data-delete data-icon="trash-2">Move to trash</button>${e.kind==='file'&&/\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i.test(e.name)?'<button data-insert>Insert in current note</button>':''}${e.kind==='file'?`<a href="${workspaceURL()}/files/${e.id}/content" download="${esc(e.name)}">Download</a>`:''}`);
 const insert=d.querySelector('[data-insert]');if(insert)insert.onclick=async()=>{try{if(!N.doc)throw Error('Open a note first.');await saveWorkspaceFile();W.file=null;const video=/\.(mp4|m4v|mov|webm)$/i.test(e.name);const src=figureSrc(newFigure([{path:e.legacy||`files/${e.id}`,command:video?'includevideo':'includegraphics',caption:'Caption.'}]));N.doc.blocks.push({id:newId('b'),type:'text',src});markDirty();renderEditor();d.close();}catch(err){toast(err.message,{error:true});}};
 d.querySelector('[data-delete]').onclick=()=>{d.close();confirmWorkspaceTrash(id);};
 for(const op of ['rename','move'])d.querySelector(`[data-${op}]`).onclick=async()=>{try{
  await workspaceChange({op,id,name:d.querySelector('[data-name]').value,parent:d.querySelector('[data-parent]').value});d.close();
 }catch(err){toast(err.message,{error:true});}};
}
function confirmWorkspaceTrash(id){
 const target=W.target,entry=W.manifest.entries.find(e=>e.id===id&&!e.deleted);if(!entry)return;
 const d=workspaceDialog('Move to trash',`<p>Move <strong>${esc(entry.name)}</strong>${entry.kind==='folder'?' and everything inside it':''} to the project trash?</p><p>References to these files may stop working. Undo or Trash can restore them.</p><p class="workspace-error" role="alert" data-error></p><footer><button data-cancel>Cancel</button><button data-confirm-trash data-icon="trash-2">Move to trash</button></footer>`);
 d.querySelector('[data-cancel]').onclick=()=>d.close();
 d.querySelector('[data-confirm-trash]').onclick=async()=>{
  const button=d.querySelector('[data-confirm-trash]');button.disabled=true;
  try{
   if(W.target!==target)throw Error('The selected project changed. Close this dialog and try again.');
   await flushNoteEdits();
   if(W.target!==target)throw Error('The selected project changed. Close this dialog and try again.');
   const m=await workspaceChange({op:'delete',id});
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
 await saveWorkspaceFile();await flushNoteEdits();if(W.target!==target)return;stopEdit();
 if(e.kind==='note'){W.file=null;await openNote(e.note);return;}
 const r=await api(workspaceURL()+'/files/'+enc(id));if(target!==W.target)return;
 W.file=id;W.text=r.text??'';W.saved=W.text;W.dirty=false;W.manifest.revision=r.revision;W.fileRevision=r.revision;W.fileHistory=r.history||{};
 const url=workspaceURL()+'/files/'+enc(id)+'/content',ext=(e.source_name||e.name).split('.').pop().toLowerCase();
 const preview=r.text!=null?`<textarea class="workspace-source" aria-label="File source" spellcheck="false"></textarea>`:['png','jpg','jpeg','gif','webp'].includes(ext)?`<img src="${url}" alt="${esc(e.name)}">`:['mp4','m4v','mov','webm'].includes(ext)?`<video src="${url}" controls></video>`:ext==='pdf'?`<iframe title="PDF preview" src="${url}"></iframe>`:`<p>This file can be downloaded below.</p>`;
 $('#notes-stage').innerHTML=`<div id="workspace-editor"><header><strong title="${esc(e.name)}">${esc(e.name)}</strong><span data-file-status role="status">Saved</span>${historyButtons('file')}<button data-reload-file data-icon="refresh-cw" data-icon-only title="Reload saved file" aria-label="Reload saved file"></button><a class="workspace-download" href="${url}" download="${esc(e.name)}">Download</a></header>${preview}</div>`;
 $('#workspace-editor [data-reload-file]').onclick=()=>{if(W.dirty&&!confirm('Discard unsaved changes and reload this file?'))return;W.dirty=false;openWorkspaceFile(id).catch(e=>toast(e.message,{error:true}));};
 const ta=$('#workspace-editor textarea');if(ta){ta.value=W.text;ta.oninput=()=>{W.text=ta.value;W.dirty=true;updateWorkspaceHistory();$('#workspace-editor [data-file-status]').textContent='Unsaved';clearTimeout(W.timer);W.timer=setTimeout(()=>saveWorkspaceFile().catch(err=>toast(err.message,{error:true})),800);};ta.onblur=()=>saveWorkspaceFile().catch(err=>toast(err.message,{error:true}));}
 renderWorkspaceTree();
}
async function saveWorkspaceFile(){
 clearTimeout(W.timer);if(W.saving){await W.saving;if(W.dirty)return saveWorkspaceFile();return;}
 if(!W.dirty||!W.file)return;const target=W.target,id=W.file,text=W.text,revision=W.fileRevision;
 W.saving=(async()=>{const m=await api(`/api/workspaces/${enc(target)}`,{op:'edit',id,text,revision});if(W.target!==target||W.file!==id)return;W.manifest=m;W.fileRevision=m.revision;W.saved=text;W.dirty=W.text!==text;const info=await api(`/api/workspaces/${enc(target)}/files/${enc(id)}`);if(W.target===target&&W.file===id)W.fileHistory=info.history||{};const status=$('#workspace-editor [data-file-status]');if(status)status.textContent=W.dirty?'Unsaved':'Saved';renderWorkspaceTree();applyBibliography();})();
 try{await W.saving;}catch(e){const status=$('#workspace-editor [data-file-status]');if(status)status.textContent='Save failed: '+e.message;throw e;}finally{W.saving=null;}
}
async function workspaceUndo(redo=false,fileOnly=false){try{const target=W.target;const caret=$('#workspace-editor textarea')?.selectionStart;await saveWorkspaceFile();if(W.target!==target)return;const id=W.file;W.manifest=await api(workspaceURL()+(fileOnly&&id?'/files/'+enc(id)+'/history':'/history'),{revision:fileOnly?W.fileRevision:W.manifest.revision,redo});renderWorkspaceTree();applyBibliography();if(id&&W.manifest.entries.some(e=>e.id===id&&!e.deleted)){await openWorkspaceFile(id);if(caret!=null){const ta=$('#workspace-editor textarea');ta?.focus();ta?.setSelectionRange(Math.min(caret,ta.value.length),Math.min(caret,ta.value.length));}}else if(id){W.file=null;renderEditor();}}catch(e){toast(e.message,{error:true});}}
function workspaceBibliographies(){
 const files=W.manifest.entries.filter(e=>!e.deleted&&e.kind==='file'&&/\.bib$/i.test(e.name));
 const d=workspaceDialog('Project bibliographies',`<p>Library citations always remain available. Enable imported .bib files to add their keys. Duplicate keys must be renamed.</p>${files.length?files.map(f=>`<label><input type="checkbox" value="${f.id}" ${(W.manifest.bibliographies||[]).includes(f.id)?'checked':''}> ${esc(f.name)}</label>`).join(''):'<p>Import or create a .bib file first.</p>'}<button data-save>Save selection</button>`);
 d.querySelector('[data-save]').onclick=async()=>{try{await workspaceChange({op:'config',bibliographies:[...d.querySelectorAll('input:checked')].map(i=>i.value)});d.close();}catch(e){toast(e.message,{error:true});}};
}
function showBibReference(key){const it=N.items.get(key);if(!it?.bib)return false;const safe=u=>{try{const url=new URL(u);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}};const url=safe(it.url)||(it.doi?safe('https://doi.org/'+it.doi):null);const d=workspaceDialog(it.title||key,`<p>${esc(it.creators.join('; '))} · ${esc(it.year||'n.d.')}</p><p>Key: ${esc(key)} · ${esc(it.file_name)}</p>${url?`<a href="${esc(url)}" target="_blank" rel="noopener">Open reference</a>`:''}${it.library_key?'<button data-paper>Open library paper</button>':''}<button data-bib>Edit bibliography</button>`);d.querySelector('[data-bib]').onclick=()=>{d.close();openWorkspaceFile(it.file_id).catch(e=>toast(e.message));};if(it.library_key)d.querySelector('[data-paper]').onclick=()=>{d.close();const paper=N.items.get(it.library_key);if(paper){lib.detail=paper;renderLibDetails(paper);showRightTab('paper');}};return true;}
window.addEventListener('beforeunload',e=>{if(W.dirty){e.preventDefault();e.returnValue='';}});

function chatProjectTarget(){return isNotesMode()?N.target:(G.project?.target||lib.target||N.target||null);}
function getChatSkillOverride(){const value=store.get('noctua.chatSkills.'+chat.id);if(value==null)return null;try{return JSON.parse(value);}catch{return null;}}
async function showSkills(){
 try{const skills=await api('/api/skills');const target=chatProjectTarget();let manifest=target?await api(`/api/workspaces/${enc(target)}`):null;const selected=getChatSkillOverride();const enabled=manifest?.skills||[];
 const d=workspaceDialog('Agent skills',`<p>Project: ${esc(target||'none')}. Skills are stored inside Noctua and shared by Claude and Codex. Importing never runs scripts. Enable instructions for this project, or override the selection for this chat.</p><button data-folder>Import folder</button><button data-zip>Import ZIP</button><button data-md>Import SKILL.md</button><label><input type="checkbox" data-override ${selected!==null?'checked':''}> Override skills for this chat</label><div data-skill-list>${skills.map(s=>`<section><label><input type="checkbox" data-skill="${s.id}" ${(selected??enabled).includes(s.id)?'checked':''}> ${esc(s.name||s.id)}</label><p>${esc(s.description)}</p><button data-inspect="${s.id}">Read instructions and files</button></section>`).join('')||'<p>No imported skills yet.</p>'}</div><button data-enable>Save selection</button>`);
 const importFiles=(kind)=>{const input=document.createElement('input');input.type='file';if(kind==='folder'){input.multiple=true;input.setAttribute('webkitdirectory','');}else input.accept=kind==='zip'?'.zip':'.md';input.onchange=async()=>{try{
  let response;if(kind==='zip'){response=await fetch('/api/skills/import-zip',{method:'POST',body:input.files[0]});const r=await response.json();if(!response.ok)throw Error(r.error||'Import failed');}
  else {const files=[];let total=0;for(const f of input.files){if((f.webkitRelativePath||f.name).split('/').some(p=>['.DS_Store','__MACOSX','.git'].includes(p)))continue;total+=f.size;if(total>32*1024*1024||files.length>=512)throw Error('Skill packages support at most 512 files and 32 MB.');const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));files.push({path:kind==='md'?'SKILL.md':f.webkitRelativePath||f.name,data:btoa(binary)});}await api('/api/skills',{files});}
  d.close();await showSkills();
 }catch(e){toast(e.message,{error:true});}};input.click();};
 for(const kind of ['folder','zip','md'])d.querySelector(`[data-${kind}]`).onclick=()=>importFiles(kind);
 d.querySelectorAll('[data-inspect]').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.inspect,r=await api(`/api/skills/${id}/files/SKILL.md`);const view=workspaceDialog('Skill package',`<select data-resource>${r.files.map(p=>`<option ${p==='SKILL.md'?'selected':''}>${esc(p)}</option>`).join('')}</select><pre>${esc(r.text)}</pre>`);view.querySelector('select').onchange=async(e)=>{try{const f=await api(`/api/skills/${id}/files/${e.target.value.split('/').map(enc).join('/')}`);view.querySelector('pre').textContent=f.text;}catch(err){toast(err.message,{error:true});}};}catch(e){toast(e.message,{error:true});}});
 d.querySelector('[data-enable]').onclick=async()=>{try{const ids=[...d.querySelectorAll('[data-skill]:checked')].map(e=>e.dataset.skill);if(d.querySelector('[data-override]').checked)store.set('noctua.chatSkills.'+chat.id,JSON.stringify(ids));else{store.remove('noctua.chatSkills.'+chat.id);if(!manifest)throw Error('Select a project before saving project skills.');if(W.target===target)await saveWorkspaceFile();const updated=await api(`/api/workspaces/${enc(target)}`,{revision:manifest.revision,op:'config',skills:ids});if(W.target===target){W.manifest=updated;W.fileRevision=updated.revision;renderWorkspaceTree();}}d.close();toast('Skill selection saved. It applies to the next chat turn.');}catch(e){toast(e.message,{error:true});}};
 }catch(e){toast(e.message,{error:true});}
}
async function showSkillRun(id){
 const d=workspaceDialog('Skill script request','<div data-run>Loading…</div>');let timer;
 const update=async()=>{if(!d.isConnected)return;try{const r=await api('/api/skill-runs/'+enc(id));const pending=r.status==='approval_required',review=r.status==='review_required';
  d.querySelector('[data-run]').innerHTML=`<p>Status: <strong>${esc(r.status)}</strong></p><p>${esc(r.interpreter)} ${esc(r.script)} ${(r.args||[]).map(esc).join(' ')}</p><p>Project: ${esc(r.target)}. Inputs: ${esc((r.input_paths||r.files||[]).join(', ')||'none')}. Working directory: temporary project copy.</p>${pending?`<p>This runs local code with your user permissions. The temporary directory is not an OS security sandbox. Only approve skills you trust.</p><details><summary>Script source</summary><pre>${esc(r.script_text)}</pre></details><button data-action="approve">Approve this run</button><button data-action="reject">Reject</button>`:''}${r.status==='running'?'<button data-action="cancel">Cancel run</button>':''}${r.error?`<p class="workspace-error">${esc(r.error)}</p>`:''}${r.stdout||r.stderr?`<details open><summary>Execution log</summary><pre>${esc(r.stdout||'')}\n${esc(r.stderr||'')}</pre></details>`:''}${review?`<p>Review output before applying it. Nothing below has changed the live project.</p>${(r.changes||[]).map(c=>`<details><summary>${c.deleted?'Delete':c.id?'Update':'Create'} ${esc(c.path)}</summary><h4>Before</h4><pre>${esc((c.before||'(binary or new file)').slice(0,20000))}</pre><h4>After</h4><pre>${esc((c.deleted?'(deleted)':c.text??'(binary file)').slice(0,20000))}</pre></details>`).join('')||'<p>No project files changed.</p>'}<button data-action="apply">Apply reviewed changes</button><button data-action="reject">Discard changes</button>`:''}`;
  d.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{if(b.dataset.action==='apply')await saveWorkspaceFile();if(b.dataset.action==='approve'&&chat.mode==='plan')throw Error('Switch out of Plan mode before approving a script.');const result=await api('/api/skill-runs/'+enc(id),{action:b.dataset.action});if(b.dataset.action==='apply'&&W.target===r.target){W.manifest=result;await refreshWorkspaceView(r.target);}await update();}catch(e){toast(e.message,{error:true});b.disabled=false;}});
  clearTimeout(timer);if(r.status==='running')timer=setTimeout(update,1000);
 }catch(e){d.querySelector('[data-run]').textContent=e.message;}};
 d.addEventListener('close',()=>clearTimeout(timer));await update();
}

document.getElementById('chat-skills-btn')?.addEventListener('click',showSkills);

async function refreshWorkspaceView(target){
 if(N.target!==target)return;
 const notes=await api(`/api/notes?target=${enc(target)}`);
 if(N.target!==target)return;
 N.list=notes;if(typeof REF!=='undefined')REF.at=0;
 const file=W.target===target?W.file:null;
 await loadWorkspace(target);
 if(file&&W.file===file&&!W.dirty){if(W.manifest?.entries.some(e=>e.id===file&&!e.deleted))await openWorkspaceFile(file);else{W.file=null;renderEditor();}}
}

function showWorkspaceTrash(){const entries=(W.manifest?.entries||[]).filter(e=>e.deleted);const d=workspaceDialog('Project trash',`<p>Restore individual entries here, including after restarting Noctua. Restore a folder before its children to keep their original placement; otherwise entries return to the root.</p>${entries.map(e=>`<p>${esc(e.name)} <button data-restore="${e.id}" data-icon="undo-2">Restore</button></p>`).join('')||'<p>Trash is empty.</p>'}`);d.querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{try{await workspaceChange({op:'restore',id:b.dataset.restore});d.close();showWorkspaceTrash();}catch(e){toast(e.message,{error:true});}});}

// Server-backed assistant edits preserve optimistic versions and local drafts.
async function refreshAgentNote(a){
 if(typeof REF!=='undefined')REF.at=0;
 if(N.target!==a.target)return;
 const target=N.target,id=a.note_id;
 const doc=await api(`/api/notes/${enc(target)}/${enc(id)}`);
 if(N.target!==target)return;
 const active=!W.file&&N.doc?.id===id;
 if(active&&(N.dirty||N.saving)){
  if(doc.updated>N.doc.updated){N.conflict=true;showConflict();}
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
