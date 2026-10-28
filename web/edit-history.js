'use strict';
// Pending note transactions are transferred to the backend journal only after a successful save.
const NoteUndo = {frames:[], last:null, group:null, time:0, input:null, caret:null, gesture:null, batch:0, busy:false, running:false, status:{}};
function noteSnapshot(){const d=JSON.parse(JSON.stringify(N.doc));delete d.updated;delete d._history;return d;}
function resetNoteHistory(){NoteUndo.frames=[];NoteUndo.last=N.doc?noteSnapshot():null;NoteUndo.group=null;refreshNoteHistory();}
function recordNoteChange(){
 if(!N.doc||NoteUndo.busy||NoteUndo.batch)return;
 const doc=noteSnapshot(), serial=JSON.stringify(doc);if(serial===JSON.stringify(NoteUndo.last))return;
 const input=NoteUndo.input, group=input?`${input.block}:${input.field}`:NoteUndo.gesture, now=Date.now();
 const frame={doc,label:group?'Type in note':'Edit note',selection:input?{...input}:null};
 if(group&&group===NoteUndo.group&&(NoteUndo.gesture||now-NoteUndo.time<800)&&NoteUndo.frames.length)NoteUndo.frames[NoteUndo.frames.length-1]=frame;
 else NoteUndo.frames.push(frame);
 while(NoteUndo.frames.length>200||(NoteUndo.frames.length>1&&JSON.stringify(NoteUndo.frames).length>8*1024*1024))NoteUndo.frames.shift();
 NoteUndo.last=doc;NoteUndo.group=group;NoteUndo.time=now;updateHistoryButtons();
}
function historyButtons(kind){return `<span class="edit-history" data-history="${kind}"><button data-undo title="Undo (⌘/Ctrl+Z)" aria-label="Undo" data-icon="undo-2" data-icon-only></button><button data-redo title="Redo (⌘/Ctrl+Shift+Z)" aria-label="Redo" data-icon="redo-2" data-icon-only></button></span>`;}
function updateHistoryButtons(){
 document.querySelectorAll('[data-history="note"]').forEach(el=>{for(const [action,pending]of [['undo',NoteUndo.frames.length],['redo',0]]){const b=el.querySelector(`[data-${action}]`);b.disabled=NoteUndo.busy||(action==='redo'&&NoteUndo.frames.length>0)||!(pending||NoteUndo.status[action]);b.title=`${action==='undo'?'Undo':'Redo'}${NoteUndo.status[action]?': '+NoteUndo.status[action]:''}`;}});
}
async function refreshNoteHistory(){if(!N.doc)return;const id=N.doc.id;try{const s=await api(`/api/notes/${enc(N.target)}/${enc(id)}/history`);if(N.doc?.id===id){NoteUndo.status=s;updateHistoryButtons();}}catch(e){console.error(e);}}
async function flushNoteEdits(){await saveNow();while(N.saving)await new Promise(r=>setTimeout(r,20));if(N.dirty&&!N.conflict)await saveNow();if(N.dirty||N.conflict)throw Error('Save or resolve the note conflict before undoing.');}
async function undoNote(redo=false){
 if(!N.doc||NoteUndo.busy||NoteUndo.running)return;NoteUndo.running=true;const stage=document.getElementById('notes-stage');const id=N.doc.id,target=N.target;
 const active=document.activeElement, block=active?.closest('.nb')?.dataset.id;
 const caret=NoteUndo.caret||(active?.matches('textarea,input')?{block,field:active.className,start:active.selectionStart,end:active.selectionEnd}:null);NoteUndo.caret=null;if(stage)stage.inert=true;
 try{await flushNoteEdits();if(N.doc?.id!==id||N.target!==target)return;NoteUndo.busy=true;updateHistoryButtons();
  const r=await api(`/api/notes/${enc(target)}/${enc(id)}/history`,{redo,updated:N.doc.updated});
  N.doc=r.doc;N.editing=null;N.imgSel=null;NoteUndo.frames=[];NoteUndo.last=noteSnapshot();NoteUndo.status=r.history;renderEditor();renderNoteList();if(stage)stage.inert=false;
  if(caret&&!caret.block){const field=caret.field.includes('note-title')?'.note-title':'.note-preamble textarea';if(field.includes('preamble')){N.preambleOpen=true;renderEditor();}const input=document.querySelector(field);input?.focus();input?.setSelectionRange(Math.min(caret.start,input.value.length),Math.min(caret.end,input.value.length));}
  if(caret?.block&&N.doc.blocks.some(b=>b.id===caret.block&&b.type==='text')){startEdit(caret.block);const ta=document.querySelector(`.nb[data-id="${caret.block}"] textarea`);ta?.setSelectionRange(Math.min(caret.start,ta.value.length),Math.min(caret.end,ta.value.length));}
 }catch(e){toast(e.message,{error:true});}finally{NoteUndo.busy=false;NoteUndo.running=false;if(stage)stage.inert=false;updateHistoryButtons();}
}
let readerHistoryBusy=false;
async function refreshReaderHistory(){if(!PDF.key)return;const key=PDF.key;try{const h=await api(paperURL(key)+'/annotation-history');if(PDF.key!==key)return;document.querySelectorAll('[data-history="reader"]').forEach(el=>{for(const action of ['undo','redo']){const b=el.querySelector(`[data-${action}]`);b.disabled=readerHistoryBusy||!h[action];b.title=h[action]?`${action}: ${h[action]}`:action;}});}catch(e){console.error(e);}}
async function undoReader(redo=false){
 if(readerHistoryBusy||!PDF.key)return;readerHistoryBusy=true;const key=PDF.key;const stage=document.getElementById('pdf-stage');const active=document.activeElement;const caret=active?.matches('textarea')?{id:active.closest('[data-id]')?.dataset.id,start:active.selectionStart,end:active.selectionEnd}:null;if(stage)stage.inert=true;
 try{
  for(const e of pdfCommentEdits.values())if(e.key===key&&!e.deleted){await savePDFComment(e);if(e.conflict||e.error)throw Error(e.error||'Resolve comment conflict first.');}
  await Promise.all([...pdfSaves]);if(PDF.key!==key)return;
  const expected=await api(paperURL(key)+'/annotations');
  const known=new Map(PDF.annotations.map(a=>[a.id,pdfCommentEdits.get(key+':'+a.id)?.revision??a.revision]));
  if(expected.length!==known.size||expected.some(a=>known.get(a.id)!==a.revision))throw Error('Annotations changed in another window. Reload the paper before undoing.');
  await api(paperURL(key)+'/annotation-history',{redo,expected});
  for(const [id,e]of pdfCommentEdits)if(e.key===key){clearTimeout(e.timer);localStorage.removeItem('pdf-draft:'+e.id);localStorage.removeItem('pdf-draft-base:'+e.id);pdfCommentEdits.delete(id);}
  document.activeElement?.blur();await refreshPDFAnnotations();if(caret?.id){const input=document.querySelector(`#pdf-sidebar [data-id="${caret.id}"] textarea`);if(stage)stage.inert=false;input?.focus();input?.setSelectionRange(Math.min(caret.start,input.value.length),Math.min(caret.end,input.value.length));}
 }catch(e){toast(e.message,{error:true});}finally{readerHistoryBusy=false;if(stage)stage.inert=false;refreshReaderHistory();}
}
document.addEventListener('beforeinput',e=>{
 if(!e.target.closest('#notes-stage')||!e.target.matches('.nb-src,.note-title,.note-preamble textarea'))return;
 if(e.inputType==='historyUndo'||e.inputType==='historyRedo'){e.preventDefault();undoNote(e.inputType==='historyRedo');return;}
 NoteUndo.input={block:e.target.closest('.nb')?.dataset.id||'',field:e.target.className,start:e.target.selectionStart,end:e.target.selectionEnd};
 if(e.inputType?.includes('Paste'))NoteUndo.group=null;
},true);
document.addEventListener('pointerdown',e=>{NoteUndo.gesture=e.target.closest('.ink canvas')?'ink:'+Date.now():null;if(e.target.closest('[data-history="note"]')){const a=document.activeElement;if(a?.matches('textarea,input'))NoteUndo.caret={block:a.closest('.nb')?.dataset.id,field:a.className,start:a.selectionStart,end:a.selectionEnd};}else NoteUndo.caret=null;if(!e.target.matches('textarea,input')){NoteUndo.input=null;NoteUndo.group=null;}},true);
document.addEventListener('focusin',()=>{NoteUndo.group=null;},true);
document.addEventListener('click',e=>{const b=e.target.closest('[data-history] button');if(!b)return;const redo=b.hasAttribute('data-redo'),kind=b.closest('[data-history]').dataset.history;if(kind==='note')undoNote(redo);else if(kind==='reader')undoReader(redo);else if(typeof workspaceUndo==='function')workspaceUndo(redo,kind==='file');});
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented||e.isComposing||e.repeat||!(e.metaKey||e.ctrlKey)||e.altKey||e.key.toLowerCase()!=='z')return;
 const el=e.target;if(el.closest('#chat, #chat-box, #setup')||el.matches('input[type="search"]'))return;
 if(el.closest('#workspace-editor,#workspace-tree')){e.preventDefault();e.stopImmediatePropagation();workspaceUndo(e.shiftKey,!!el.closest('#workspace-editor'));}
 // Beside the Reader, the note owns its own stage and keys after it was last used.
 else if(lastSplitSide()?el.closest('#notes-stage')||(lastSplitSide()==='notes'&&!el.closest('#pdf-stage')&&!el.matches('input,textarea,[contenteditable]')):document.body.classList.contains('notes-mode')&&(el.closest('#notes-stage')||!el.matches('input,textarea,[contenteditable]'))){e.preventDefault();e.stopImmediatePropagation();undoNote(e.shiftKey);}
 else if(document.body.classList.contains('pdf-mode')&&(el.closest('#pdf-stage')||!el.matches('input,textarea,[contenteditable]'))){e.preventDefault();e.stopImmediatePropagation();undoReader(e.shiftKey);}
},true);

for(const event of ['pointerup','pointercancel'])document.addEventListener(event,()=>setTimeout(()=>{NoteUndo.gesture=null;},0),true);
