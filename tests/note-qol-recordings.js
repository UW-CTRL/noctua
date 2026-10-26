// Real production UI handlers and persistence APIs; no mocked history or AI replies.
const demoWait=ms=>new Promise(r=>setTimeout(r,ms));
const demoAssert=(ok,message)=>{if(!ok)throw Error(message);};
const demoInput=(selector,value)=>{const el=$(selector);demoAssert(el,'Missing '+selector);el.focus();el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));return el;};
const demoBib=String.raw`@article{rivera2025latent,
  author = {Rivera, Alex and Chen, Morgan},
  title = {Learning Compact Latent Dynamics},
  journal = {Fictional Research Notes},
  year = {2025}
}`;
window.captureStep=async(scene,step)=>{
 if(step===0){
  demoAssert(settings.storage_override&&settings.data_dir.endsWith('/target/note-qol-recording/data'),'Recording requires the isolated demo backend');
  document.documentElement.dataset.theme='dark';store.set('noctua.notesTheme','dark');
  $('#setup')?.noctuaClose?.();$('#s2-banner button')?.click();
  await loadCollections();setMode('notes');await loadNoteFolder('L1');await demoWait(300);
  await openNote(N.list[0].id);
 }
 const file=name=>W.manifest.entries.find(e=>e.name===name&&!e.deleted);
 const finish=async()=>{await demoWait(350);return {duration:1800};};
 if(scene==='workspace'){
  if(step===1){$('[data-new-folder]').click();demoInput('dialog [data-name]','Sources');}
  if(step===2){$('dialog form').requestSubmit();await demoWait(400);demoAssert(file('Sources'),'Folder was not created');}
  if(step===3){$('[data-new-file]').click();demoInput('dialog [data-name]','reading-plan.md');$('dialog [data-parent]').value=file('Sources').id;}
  if(step===4){$('dialog form').requestSubmit();await demoWait(400);demoAssert(W.file===file('reading-plan.md').id,'New file did not open');demoInput('.workspace-source','# Reading plan\n\n- Compare short and long prediction horizons.\n- Collect citations in a project bibliography.');await saveWorkspaceFile();}
  if(step===5){await openWorkspaceFile(file('Media').id);}
  if(step===6){await openWorkspaceFile(file('latent-model.png').id);}
  if(step===7){await openWorkspaceFile(file('Media').id);await openNote(N.list[0].id);}
  if(step>7)return {done:true};
 }
 if(scene==='note-history'){
  if(step===1){$('.note-title').focus();demoInput('.note-title','Latent dynamics: a revised hypothesis');await flushNoteEdits();}
  if(step===2){document.activeElement.blur();$('.note-toolbar [data-undo]').click();await demoWait(450);demoAssert(N.doc.title==='Understanding latent dynamics','Undo did not restore title');}
  if(step===3){$('.note-toolbar [data-redo]').click();await demoWait(450);demoAssert(N.doc.title.includes('revised hypothesis'),'Redo did not restore edit');}
  if(step===4){startEdit('method');const ta=$('.nb[data-id="method"] .nb-src');demoInput('.nb[data-id="method"] .nb-src',ta.value+'\n\nNext: test whether a smaller latent state preserves the same predictive accuracy.');await flushNoteEdits();stopEdit();}
  if(step===5){$('.note-toolbar [data-undo]').click();await demoWait(450);demoAssert(!N.doc.blocks.find(b=>b.id==='method').src.includes('Next:'),'Undo did not remove paragraph');}
  if(step===6){$('.note-toolbar [data-redo]').click();await demoWait(450);demoAssert(N.doc.blocks.find(b=>b.id==='method').src.includes('Next:'),'Redo did not restore paragraph');}
  if(step>6)return {done:true};
 }
 if(scene==='bibliography'){
  if(step===1){
   // Feed a real File through the production Import input, avoiding native dialog automation.
   const create=document.createElement.bind(document);let input;document.createElement=(tag,...args)=>{const el=create(tag,...args);if(tag==='input'){input=el;el.click=()=>{};}return el;};
   try{workspaceImport();}finally{document.createElement=create;}
   const dt=new DataTransfer();dt.items.add(new File([demoBib],'references.bib',{type:'text/plain'}));input.files=dt.files;await input.onchange();
   await openWorkspaceFile(file('references.bib').id);
  }
  if(step===2){$('[data-bibliographies]').click();$('dialog input[type="checkbox"]').checked=true;}
  if(step===3){$('dialog [data-save]').click();await demoWait(350);await openNote(N.list[0].id);startEdit('intro');const ta=$('.nb[data-id="intro"] .nb-src');demoInput('.nb[data-id="intro"] .nb-src',ta.value+'\n\nSee \\cite{rivera');ta.setSelectionRange(ta.value.length,ta.value.length);updatePicker(ta);demoAssert(picker.matches.length,'Imported key missing from citation picker');}
  if(step===4){pickCite($('#cite-picker')._ta,picker.matches[0]);await flushNoteEdits();stopEdit();closePicker();}
  if(step===5){demoAssert(showBibReference('rivera2025latent'),'Imported reference missing');}
  if(step>5)return {done:true};
 }
 if(scene==='skills'){
  if(step===1){openSetup({tab:'skills'});await demoWait(350);}
  if(step===2){
   const text='---\nname: bibliography-review\ndescription: Review project BibTeX entries while preserving citation keys.\n---\n\n# Bibliography review\n\nRead the project bibliography. Check titles, authors, and years.\nPreserve existing keys and report missing metadata without inventing it.\nUse the project file tools to propose corrections for review.\n';
   const script='import pathlib\n\nfor path in pathlib.Path(".").rglob("*.bib"):\n    print(path, "—", len(path.read_text().splitlines()), "lines")\n';
   await api('/api/skills',{files:[{path:'SKILL.md',data:btoa(text)},{path:'scripts/inspect.py',data:btoa(unescape(encodeURIComponent(script)))}]});
   $('#setup').noctuaClose();openSetup({tab:'skills'});await demoWait(350);
  }
  if(step===3){$('[data-skill-package]').open=true;await demoWait(300);}
  if(step===4){const select=$('[data-skill-resource] select');select.value='scripts/inspect.py';await select.onchange();}
  if(step===5){$('[data-skill-package]').open=false;$('[data-skill-default]').checked=true;}
  if(step===6){$('[data-skill-save]').click();await demoWait(300);$('#setup').noctuaClose();openSetup({tab:'skills'});await demoWait(350);demoAssert($('[data-skill-default]').checked,'Project skill was not enabled');}
  if(step>6)return {done:true};
 }
 if(scene==='reader-history'){
  if(step===0){const papers=await api('/api/library/items?target=L1');await openPDF(papers[0].key);setPDFSidebarTab('annotations');await demoWait(500);}
  if(step===1){
   const entry=pdfPageEntries[0];await ensurePDFPage(entry);const span=[...entry.box.querySelectorAll('.textLayer span')].find(el=>el.textContent.startsWith('A compact latent'));
   demoAssert(span,'PDF text layer missing');const range=document.createRange();range.selectNodeContents(span);getSelection().removeAllRanges();getSelection().addRange(range);
   PDF.selection={page:1,quote:span.textContent,rects:[normalizedRect(span.getBoundingClientRect(),entry.box.getBoundingClientRect())]};
  }
  if(step===2){await addPDFAnnotation('highlight');demoAssert(PDF.annotations.length===1,'Highlight was not saved');}
  if(step===3){const ta=$('#pdf-sidebar textarea');demoInput('#pdf-sidebar textarea',String.raw`Interpret this as a compressed state $z_t$: what information must the encoder retain?`);ta.blur();await demoWait(900);for(const e of pdfCommentEdits.values())await savePDFComment(e);}
  if(step===4){await undoReader();demoAssert(!PDF.annotations[0].comment,'Undo did not remove comment');}
  if(step===5){await undoReader();demoAssert(PDF.annotations.length===0,'Undo did not remove highlight');}
  if(step===6){await undoReader(true);demoAssert(PDF.annotations.length===1,'Redo did not restore highlight');}
  if(step===7){await undoReader(true);demoAssert(PDF.annotations[0].comment.includes('compressed'),'Redo did not restore comment');}
  if(step>7)return {done:true};
 }
 return finish();
};
void 0;
