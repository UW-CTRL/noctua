'use strict';
// Linked files use the same source editor and compiler as internal project files.
const Linked={links:new Map(),openRoots:new Set(),versions:new Map(),internal:new Map(),checking:false,refreshing:false,conflict:false,restoring:false,terminals:new Map(),dismissedVersion:null};
const linkedCollection=target=>target?.startsWith('linked~')?target.split('~')[1]:target;
const linkedTarget=target=>!!target?.startsWith('linked~');
function linkedServerLabel(){try{return window.noctuaServerAddress||window.top?.noctuaServerAddress||location.host;}catch{return location.host;}}
async function loadLinkedRoots(collection){
 const result=await api(`/api/workspaces/${enc(collection)}/links`);
 Linked.links.set(collection,result);if(linkedCollection(W.target)===collection)renderWorkspaceTree();
}
function linkedExpanded(target){
 if(target===W.target)return W.expanded;
 try{return new Set(JSON.parse(store.get('noctua.workspaceExpanded.'+target)||'[]'));}catch{return new Set();}
}
function linkedCachedTree(manifest,target,depth=0){
 const entries=(manifest?.entries||[]).filter(e=>!e.deleted),expanded=linkedExpanded(target);
 const groups=workspaceChildren(entries);
 const children=(parent,level)=>(groups.get(parent)||[]).map(e=>{
  const folder=e.kind==='folder',open=expanded.has(e.id);
  return `<div class="workspace-entry" style="--depth:${level}"><button data-cached-entry="${esc(e.id)}" data-cached-target="${esc(target)}" data-icon="${folder?(open?'folder-open':'folder'):e.kind==='note'?'notebook-pen':workspaceFileIcon(e)}" ${folder?`aria-expanded="${open}"`:''}><span class="workspace-name">${esc(e.name)}</span></button></div>${folder&&open?`<div class="workspace-children">${children(e.id,level+1)}</div>`:''}`;
 }).join('');
 return children('',depth);
}
function linkedTreeHeader(collection=linkedCollection(W.target),useActive=true){
 const result=Linked.links.get(collection),roots=result?.links||[];
 Linked.internal.set(W.target,W.manifest);
 const internal=useActive&&W.target===collection?'<div data-active-entries></div>':linkedCachedTree(Linked.internal.get(collection),collection);
 return `<div class="linked-roots"><div class="workspace-entry" style="--depth:0"><button data-project-papers data-icon="folder"><span class="workspace-name">Papers</span></button></div>${internal}${roots.map(r=>{
  const open=Linked.openRoots.has(r.target),active=useActive&&W.target===r.target;
  return `<div class="linked-root"><div class="workspace-entry" style="--depth:0"><button data-linked-root="${esc(r.target)}" data-icon="${open?'folder-open':'folder'}" aria-expanded="${open}" title="${esc(r.path)}" ${active?'aria-current="page"':''}><span class="workspace-name">${esc(r.name)}${r.available?'':' (unavailable)'}</span></button><button data-root-terminal="${esc(r.target)}" data-icon="terminal" title="Open terminal in ${esc(r.name)}">Terminal</button><button data-manage-link="${esc(r.id)}" data-icon="settings" data-icon-only aria-label="Manage ${esc(r.name)}"></button></div>${open?`<div class="linked-children">${active?'<div data-active-entries></div>':linkedCachedTree(Linked.internal.get(r.target),r.target,1)}</div>`:''}</div>`;
 }).join('')}${result?.supported?'<button data-link-directory data-icon="folder-plus">Link directory</button>':''}</div>`;
}
function bindLinkedTree(tree){
 const entries=tree.querySelector('.workspace-entries'),slot=tree.querySelector('[data-active-entries]');
 if(entries){if(slot){slot.replaceWith(entries);if(linkedTarget(W.target))entries.querySelectorAll('[data-entry]').forEach(row=>row.style.setProperty('--depth',Number(row.style.getPropertyValue('--depth'))+1));}else entries.hidden=true;}
 tree.querySelector('[data-project-papers]')?.addEventListener('click',()=>{if(tree.dataset.collection)showCollection(tree.dataset.collection);setMode('graph');setLayout('library');lib.kind='papers';store.set('noctua.collectionView.'+linkedCollection(W.target),'papers');loadLibItems();});
 tree.querySelectorAll('[data-cached-entry]').forEach(b=>b.onclick=async()=>{try{
  const target=b.dataset.cachedTarget,id=b.dataset.cachedEntry,m=Linked.internal.get(target),entry=m.entries.find(e=>e.id===id);
  if(entry.kind==='folder'){const expanded=linkedExpanded(target);if(!expanded.delete(id))expanded.add(id);store.set('noctua.workspaceExpanded.'+target,JSON.stringify([...expanded]));renderWorkspaceTree();await refreshProjectTrees();return;}
  if(typeof openProjectEntry==='function'){await openProjectEntry(target,id);return;}
 if(linkedTarget(target))await openLinkedRoot(target,{restore:false});else{await saveWorkspaceFile();await loadWorkspace(target);W.file=null;setMode('notes');}
  await openWorkspaceFile(id);
 }catch(e){toast(e.message,{error:true});}});
 tree.querySelectorAll('[data-linked-root]').forEach(b=>b.onclick=async()=>{try{
  const target=b.dataset.linkedRoot;
  if(Linked.openRoots.has(target)){Linked.openRoots.delete(target);renderWorkspaceTree();return;}
  if(typeof Explorer!=='undefined'){Linked.openRoots.add(target);Linked.internal.set(target,await api(`/api/workspaces/${enc(target)}`,undefined,{background:true}));renderWorkspaceTree();return;}
  if(W.target===target){Linked.openRoots.add(target);renderWorkspaceTree();await refreshProjectTrees();return;}
  await openLinkedRoot(target,{restore:false});
 }catch(e){toast(e.message,{error:true});}});
 tree.querySelectorAll('[data-root-terminal]').forEach(b=>b.onclick=async()=>{try{await openProjectTerminal(b.dataset.rootTerminal);}catch(e){toast(e.message,{error:true});}});
 tree.querySelectorAll('[data-manage-link]').forEach(b=>b.onclick=()=>linkDirectoryDialog(b.dataset.manageLink,tree.dataset.collection));
 tree.querySelector('[data-link-directory]')?.addEventListener('click',()=>linkDirectoryDialog(undefined,tree.dataset.collection));

}
async function linkDirectoryDialog(id,owner){
 const collection=owner||linkedCollection(W.target)||N.target,link=Linked.links.get(collection)?.links.find(l=>l.id===id);
 const d=workspaceDialog(link?'Linked directory':'Link directory',`<form><p>Files stay in this directory on the Noctua server. Unlinking never deletes them.</p><label>Server directory <input name="path" required placeholder="/Users/you/ctrl/papers/2027/L4DC.27" value="${esc(link?.path||'')}"></label>${link?'<label><input type="checkbox" data-linked-ignored disabled> Show ignored files</label><button type="button" data-linked-access>Agent access</button>':''}<button type="button" data-browse>Browse on this computer</button><p data-error class="workspace-error" role="alert"></p><footer>${link?'<button type="button" data-unlink>Unlink</button>':''}<button type="submit">${link?'Relink':'Link directory'}</button></footer></form>`);
 let picker;try{picker=window.top?.noctuaPickProjectDirectory;}catch{};d.querySelector('[data-browse]').hidden=!picker&&!(typeof settings!=='undefined'&&settings?.desktop);
 const fail=e=>d.querySelector('[data-error]').textContent=e.message;
 if(link){
  const checkbox=d.querySelector('[data-linked-ignored]'),target=link.target;
  try{const manifest=await api(`/api/workspaces/${enc(target)}`);checkbox.checked=!!manifest.show_ignored;checkbox.disabled=false;}catch(e){fail(e);}
  checkbox.onchange=async()=>{checkbox.disabled=true;try{
   if(W.target===target)await saveWorkspaceFile();
   const current=await api(`/api/workspaces/${enc(target)}`);
   const manifest=await api(`/api/workspaces/${enc(target)}`,{op:'config',revision:current.revision,show_ignored:checkbox.checked});
   Linked.internal.set(target,manifest);if(W.target===target){W.manifest=manifest;W.fileRevision=manifest.revision;}renderWorkspaceTree();
  }catch(e){checkbox.checked=!checkbox.checked;fail(e);}finally{checkbox.disabled=false;}};
  d.querySelector('[data-linked-access]').onclick=()=>showLinkedAccess(target).catch(fail);
 }

 d.querySelector('[data-browse]').onclick=async()=>{try{const r=picker?await picker():await api('/api/desktop/pick-folder',{});if(r.path)d.querySelector('[name=path]').value=r.path;}catch(e){fail(Error('A local desktop connection is required to browse. Enter the directory path on the server instead.'));}};
 d.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await saveWorkspaceFile();await api(`/api/workspaces/${enc(collection)}/links`,{op:link?'relink':'link',id,path:d.querySelector('[name=path]').value});await loadLinkedRoots(collection);if(link&&W.target===link.target){W.file=null;await openLinkedRoot(link.target);}d.close();}catch(e){fail(e);}};
 d.querySelector('[data-unlink]')?.addEventListener('click',async()=>{try{await saveWorkspaceFile();await api(`/api/workspaces/${enc(collection)}/links`,{op:'unlink',id});if(W.target===link.target){W.file=null;await loadWorkspace(collection);renderEditor();}await loadLinkedRoots(collection);d.close();}catch(e){fail(e);}});
}
async function openLinkedRoot(target,{restore=true}={}){
 await saveWorkspaceFile();await flushNoteEdits();
 const collection=linkedCollection(target);if(N.target!==collection)await loadNoteFolder(collection);
 const manifest=await api(`/api/workspaces/${enc(target)}`);
 if(N.target!==collection)return;
 const expanded=linkedExpanded(target);
 W.target=target;W.manifest=manifest;W.file=null;W.dirty=false;W.expanded=expanded;W.selected.clear();W.anchor=null;Linked.openRoots.add(target);
 setMode('notes');renderWorkspaceTree();applyBibliography();
 store.set('noctua.collectionView.'+collection,target);
 if(restore&&await restoreWorkspaceFile(target))return;
 $('#notes-stage').innerHTML='<div class="linked-welcome"><h2>Linked project</h2><p>Select a file to edit, or open a terminal for Git and project commands.</p><p>Choose the main TeX document in Project LaTeX settings before compiling.</p></div>';
 updateChatContext();
 if(typeof updateMainTitle==='function')updateMainTitle();
}
async function restoreCollectionView(){
 if(Linked.restoring||G.layout!=='library')return;Linked.restoring=true;
 try{const collection=lib.target;if(N.target!==collection)await loadNoteFolder(collection);if(lib.target!==collection)return;const last=store.get('noctua.collectionView.'+collection);if(linkedTarget(last)){await openLinkedRoot(last);return;}setMode('notes');if(last==='papers'){// Selecting the collection restores documents; Papers is an explicit action.
   if(!W.file&&!N.doc)$('#notes-stage').innerHTML='<div class="linked-welcome"><h2>Collection</h2><p>Select Papers to browse the paper list, or select a note or project file.</p></div>';
 }}catch(e){toast(e.message,{error:true});}finally{Linked.restoring=false;}
}
const linkedTyping=()=>typeof workspaceTyping==='function'&&workspaceTyping();
async function reconcileLinkedFiles(){
 if(linkedTyping()||Linked.checking||!linkedTarget(W.target)||document.hidden||W.saving||Linked.conflict)return;
 Linked.checking=true;const target=W.target,baseline=W.manifest;
 try{const m=await api(`/api/workspaces/${enc(target)}`,undefined,{background:true});if(linkedTyping()||W.target!==target||W.saving||W.manifest!==baseline)return;
 if(m.revision===W.manifest?.revision){if(JSON.stringify(m.git)!==JSON.stringify(W.manifest.git)){W.manifest.git=m.git;renderWorkspaceTree();}return;}
 const old=W.manifest.entries.find(e=>e.id===W.file),current=m.entries.find(e=>e.id===W.file);
 const changed=old&&(old.blob!==current?.blob);
 if(W.dirty&&changed){if(Linked.dismissedVersion!==target+':'+m.revision)await showLinkedConflict(m);return;}
 W.manifest=m;renderWorkspaceTree();applyBibliography();
 if(typeof Paper!=='undefined'&&Paper.target===target)paperPoll(Paper.generation);
 if(W.dirty){W.fileRevision=m.revision;return;}
 if(W.file&&current){if(changed)await openWorkspaceFile(W.file,{external:true});else W.fileRevision=m.revision;}
 else if(W.file){W.file=null;$('#notes-stage').innerHTML='<div class="linked-welcome"><p>This file was removed or renamed outside Noctua. Select its new location in the tree.</p></div>';}
 }catch(e){const status=$('#workspace-editor [data-file-status]');if(status)status.textContent=e.message;}finally{Linked.checking=false;}
}
async function showLinkedConflict(manifest){
 if(Linked.conflict)return;clearTimeout(W.timer);
 const target=W.target,id=W.file,current=manifest.entries.find(e=>e.id===id),disk=current?await api(`/api/workspaces/${enc(target)}/files/${enc(id)}`):null;
 Linked.conflict=true;
 const d=workspaceDialog('File changed on disk',`<p>Your draft is preserved. Compare it with the current disk version before choosing what to save.</p><div class="linked-compare"><label>Your draft<textarea data-local spellcheck="false"></textarea></label><label>Disk version<textarea data-disk readonly></textarea></label></div><p data-error role="alert"></p><footer><button data-later>Keep draft without saving</button><button data-reload>Reload disk version</button><button data-save ${current?'':'disabled'}>Save my draft over this version</button></footer>`);
 d.querySelector('[data-local]').value=W.text;d.querySelector('[data-disk]').value=disk?.text??'(File removed or renamed)';
 d.querySelector('[data-later]').onclick=()=>{Linked.dismissedVersion=target+':'+manifest.revision;d.close();const status=$('#workspace-editor [data-file-status]');if(status){status.textContent='Draft kept; disk changed. Click to compare.';status.onclick=()=>showLinkedConflict(manifest).catch(e=>toast(e.message,{error:true}));}};
 d.querySelector('[data-reload]').onclick=async()=>{W.dirty=false;W.manifest=manifest;d.close();if(current)await openWorkspaceFile(id);else{W.file=null;renderEditor();}};
 d.querySelector('[data-save]').onclick=async()=>{try{const text=d.querySelector('[data-local]').value;const m=await api(`/api/workspaces/${enc(target)}`,{op:'edit',id,text,revision:disk.revision});if(W.target===target&&W.file===id){W.text=text;W.saved=text;W.dirty=false;W.manifest=m;W.fileRevision=m.revision;}d.close();await openWorkspaceFile(id);}catch(e){d.querySelector('[data-error]').textContent=e.message;}};
 d.addEventListener('close',()=>{Linked.conflict=false;});
}
// Every visible root needs fresh contents, even when another root owns the editor.
// Keep requests bounded to one refresh batch; slow scans never pile up.
async function refreshProjectTrees({force=true}={}){
 if(document.body.classList.contains('resizing')||linkedTyping()||Linked.refreshing||document.hidden||!W.target)return;
 Linked.refreshing=true;const collection=linkedCollection(W.target),active=W.target;
 const targets=new Set([collection,...(Linked.links.get(collection)?.links||[]).filter(r=>Linked.openRoots.has(r.target)).map(r=>r.target)]);
 if(typeof Explorer!=='undefined')for(const owner of Explorer.open){targets.add(owner);for(const root of Linked.links.get(owner)?.links||[])if(Linked.openRoots.has(root.target))targets.add(root.target);}
 if(linkedTarget(active))targets.delete(active);
 try{
  if(linkedTarget(active))targets.add(active);
  const jobs=[...[...targets].map(async target=>{
   const previousToken=Linked.versions.get(target),now=Date.now();
   const token=await api(`/api/workspaces/${enc(target)}/changes`,undefined,{background:true});
   if(!force&&previousToken?.generation===token.generation&&now-previousToken.checked<30000)return;
   if(linkedTyping()||document.body.classList.contains('resizing')||W.target!==active)return;
   if(target===active&&linkedTarget(active)){await reconcileLinkedFiles();if(!W.saving&&!Linked.conflict&&!linkedTyping())Linked.versions.set(target,{generation:token.generation,checked:now});return;}

   const baseline=target===W.target?W.manifest:null;
   const m=await api(`/api/workspaces/${enc(target)}`,undefined,{background:true});
   if(linkedTyping()||W.target!==active||(baseline&&W.manifest!==baseline))return;
   Linked.versions.set(target,{generation:token.generation,checked:now});
   const previous=target===W.target?W.manifest:Linked.internal.get(target);
   if(previous?.revision===m.revision&&JSON.stringify(previous?.git)===JSON.stringify(m.git))return;
   if(target===W.target){
    if(W.saving)return;
    const old=W.manifest?.entries.find(e=>e.id===W.file),current=m.entries.find(e=>e.id===W.file);
    // Internal source conflicts retain the editor's existing stale-write protection.
    if(W.dirty&&old?.blob!==current?.blob)return;
    W.manifest=m;Linked.internal.set(target,m);renderWorkspaceTree();applyBibliography();
    if(typeof Paper!=='undefined'&&Paper.target===target)paperPoll(Paper.generation);
    if(W.file&&current&&!W.dirty&&old?.blob!==current.blob)await openWorkspaceFile(W.file,{external:true});
   }else{Linked.internal.set(target,m);renderWorkspaceTree();}
  })];
  const results=await Promise.allSettled(jobs);
  if(linkedCollection(W.target)===collection){
   const error=results.find(r=>r.status==='rejected');
   let status=W.treeEl?.querySelector('[data-tree-refresh-error]');
   if(error&&W.treeEl){if(!status){status=document.createElement('p');status.dataset.treeRefreshError='';status.className='workspace-error';status.setAttribute('role','status');W.treeEl.append(status);}status.textContent='Folder refresh failed: '+error.reason.message;}
   else status?.remove();
  }
 }finally{Linked.refreshing=false;}
}
setInterval(()=>refreshProjectTrees({force:false}),1000);
window.addEventListener('focus',refreshProjectTrees);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshProjectTrees();});
async function showLinkedTrash(){
 const target=W.target,r=await api(workspaceURL()+'/linked-trash');
 const d=workspaceDialog('Linked project trash',`<p>Restoring never overwrites an existing path.</p>${r.entries.map(e=>`<p>${esc(e.path)} <button data-restore="${esc(e.trash_id)}">Restore</button></p>`).join('')||'<p>Trash is empty.</p>'}<p data-error role="alert"></p>`);
 d.querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{try{if(W.target!==target)throw Error('Project changed');await workspaceChange({op:'restore',id:b.dataset.restore});d.close();}catch(e){d.querySelector('[data-error]').textContent=e.message;}});
}
async function openProjectTerminal(target=W.target){
 if(!linkedTarget(target))return;
 for(const session of Linked.terminals.values())session.panel.hidden=true;
 if(Linked.terminals.has(target)){const session=Linked.terminals.get(target);session.panel.hidden=false;session.term.focus();return;}
 const panel=document.createElement('section');panel.className='project-terminal';panel.innerHTML='<header><strong></strong><button data-hide>Hide</button><button data-close>Close session</button></header><div class="project-terminal-screen"></div><p data-status role="status"></p>';document.body.append(panel);
 const term=new Terminal({cursorBlink:true,scrollback:5000,fontSize:13,convertEol:false});term.open(panel.querySelector('.project-terminal-screen'));
 const url=`/api/workspaces/${enc(target)}/terminal`,key='noctua.terminal.'+target;
 let id=store.get(key),offset=0,closed=false,polling=false;
 const resize=()=>{const el=panel.querySelector('.project-terminal-screen'),cols=Math.max(20,Math.floor((el.clientWidth-16)/8)),rows=Math.max(4,Math.floor((el.clientHeight-8)/16));term.resize(cols,rows);if(id)api(url,{op:'resize',id,cols,rows}).catch(()=>{});};
 try{if(id){await api(url,{op:'poll',id});}else{const r=await api(url,{op:'create',cols:100,rows:20});id=r.id;store.set(key,id);}}catch(e){panel.remove();term.dispose();store.set(key,'');throw e;}
 panel.querySelector('strong').textContent=`Terminal · ${linkedServerLabel()} · ${Linked.internal.get(target)?.root||W.manifest.root}`;
 const status=panel.querySelector('[data-status]');status.textContent='Commands run on the server with your account permissions.';
 const poll=async()=>{if(closed||polling||panel.hidden||document.hidden)return;polling=true;try{const r=await api(url,{op:'poll',id,offset});if(r.truncated)term.write('\r\n[Earlier output expired]\r\n');term.write(Uint8Array.from(atob(r.output),c=>c.charCodeAt(0)));offset=r.offset;if(r.ended)status.textContent='Shell exited. Close this session to start another.';}catch(e){status.textContent=e.message;}finally{polling=false;}};
 let writes=Promise.resolve();term.onData(input=>{writes=writes.then(()=>api(url,{op:'write',id,input})).catch(e=>status.textContent=e.message);});
 const timer=setInterval(poll,250),observer=new ResizeObserver(resize);observer.observe(panel.querySelector('.project-terminal-screen'));resize();await poll();term.focus();
 Linked.terminals.set(target,{panel,term,target});panel.querySelector('[data-hide]').onclick=()=>panel.hidden=true;
 panel.querySelector('[data-close]').onclick=async()=>{try{await api(url,{op:'close',id});store.set(key,'');}catch(e){if(e.message.includes('ended'))store.set(key,'');else toast('Terminal disconnected; reconnect to close its server session.',{error:true});}finally{closed=true;clearInterval(timer);observer.disconnect();term.dispose();panel.remove();Linked.terminals.delete(target);}};
}
async function showLinkedAccess(target=W.target){
 const r=await api(`/api/workspaces/${enc(target)}/access`);
 const d=workspaceDialog('Project agent access',`<p>Direct edit grants persist until revoked. Review mode continues to propose edits.</p>${r.grants.map((g,i)=>`<p>${esc(g.label||g.key)} <button data-revoke="${i}">Revoke</button></p>`).join('')||'<p>No saved grants.</p>'}<p data-error role="alert"></p>`);
 d.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{try{await api(`/api/workspaces/${enc(target)}/access`,{op:'revoke',key:r.grants[Number(b.dataset.revoke)].key});d.close();}catch(e){d.querySelector('[data-error]').textContent=e.message;}});
}
const projectCommandCards=new Map();
function showProjectCommandApproval(request,host){
 if(projectCommandCards.has(request.id))return;
 const c=request.command,d=document.createElement('section');d.className='chat-edit-approval';projectCommandCards.set(request.id,d);
 d.innerHTML=`<p><strong>Run this project command?</strong></p><pre>${esc(c.executable)} ${(c.args||[]).map(a=>esc(JSON.stringify(a))).join(' ')}</pre><p>Directory: ${esc(c.root)}${c.cwd?'/'+esc(c.cwd):''}</p><p>${c.write?'May write inside the linked directory.':'Filesystem writes are limited to temporary storage.'} ${c.network?'Network access requested.':'Network access blocked.'}</p>${c.repository_scope?'<p><strong>Expanded access: this command may change the entire enclosing repository and its Git metadata.</strong></p>':''}${request.rememberable?'<label><input type="checkbox" data-remember> Remember this exact command and working directory</label>':''}<p data-error role="alert"></p><footer><button data-decline>Decline</button><button data-allow>Allow once</button></footer><button data-cancel hidden>Stop command</button><pre data-output></pre><p data-status role="status"></p>`;
 (host||document.querySelector('#chat-log .msg.assistant:last-child')||$('#chat-log')).append(d);
 const url='/api/project-commands/'+enc(request.id),status=d.querySelector('[data-status]');let timer;
 const poll=async()=>{try{const r=await api(url);status.textContent=r.result.state;d.querySelector('[data-output]').textContent=[r.result.stdout,r.result.stderr,r.result.error].filter(Boolean).join('\n');if(r.result.state!=='running'){clearInterval(timer);d.querySelector('[data-cancel]').hidden=true;reconcileLinkedFiles();}}catch(e){d.querySelector('[data-error]').textContent=e.message;clearInterval(timer);}};
 const decide=async approve=>{try{if(approve)await saveWorkspaceFile();await api(url,{approve,remember:!!d.querySelector('[data-remember]')?.checked});d.querySelector('footer').hidden=true;status.textContent=approve?'Running':'Declined';if(approve){d.querySelector('[data-cancel]').hidden=false;timer=setInterval(poll,750);poll();}}catch(e){d.querySelector('[data-error]').textContent=e.message;}};
 d.querySelector('[data-allow]').onclick=()=>decide(true);d.querySelector('[data-decline]').onclick=()=>decide(false);
 d.querySelector('[data-cancel]').onclick=async()=>{try{await api(url,{op:'cancel'});poll();}catch(e){d.querySelector('[data-error]').textContent=e.message;}};
}

// Migrate the old Library/Notes/Reader preference into document navigation.
if(typeof collectionsReady!=='undefined')collectionsReady.then(()=>{
 if(G.layout!=='library'||document.body.classList.contains('pdf-mode'))return;
 setMode('notes');let attempts=0;
 const restore=()=>{if(W.target===N.target&&W.manifest){restoreCollectionView();}else if(++attempts<100)setTimeout(restore,50);};restore();
});
