'use strict';
// Paper files use real TeX. Note cells continue to use the lightweight renderer.
const Paper={generation:0,pollSerial:0,loadSerial:0,editVersion:0,target:null,timer:null,poll:null,doc:null,observer:null,tasks:new Set(),scale:1,fit:true,views:new Map(),loaded:null,requested:null,current:null,busy:false};
const projectPaperURL=target=>`/api/workspaces/${enc(target)}/paper`;
const paperAuto=()=>W.manifest?.paper?.auto_compile??(store.get('noctua.paper.auto')!=='false');
const paperCompiler=()=>W.manifest?.paper?.compiler||'tectonic';
const paperCompilerLabel=()=>paperCompiler()==='pdflatex'?'pdfLaTeX':'Tectonic';
async function showPaperSettings(){
 const target=W.target;if(!target)return;
 const main=paperMain(),files=(W.manifest?.entries||[]).filter(e=>e.kind==='file'&&!e.deleted&&/\.tex$/i.test(e.name));
 const d=workspaceDialog('Project LaTeX settings',`<form><p>These settings apply only to this collection/project.</p><label>Compiler <select data-latex-compiler><option value="tectonic">Tectonic (XeLaTeX)</option><option value="pdflatex">pdfLaTeX</option></select></label><p data-compiler-info role="status">Checking bundled compilers…</p><label>Main document <select data-latex-main><option value="">Choose a .tex file</option>${files.map(e=>`<option value="${esc(e.id)}">${esc(paperPath(e))}</option>`).join('')}</select></label><label><input type="checkbox" data-latex-auto ${paperAuto()?'checked':''}> Compile automatically after edits</label><p>Both compilers are included with Noctua. Choose pdfLaTeX for templates designed for Overleaf’s default compiler. Output also depends on package versions and fonts.</p><p class="workspace-error" data-error role="alert"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit">Save</button></footer></form>`);
 const select=d.querySelector('[data-latex-compiler]');select.value=paperCompiler();d.querySelector('[data-latex-main]').value=main?.id||'';
 d.querySelector('[data-cancel]').onclick=()=>d.close();
 let available=[];const info=()=>{const engine=available.find(e=>e.id===select.value);d.querySelector('[data-compiler-info]').textContent=engine?(engine.available?`Bundled ${engine.version}`:engine.error):'Compiler information unavailable';};select.onchange=info;
 api('/api/paper-compilers').then(r=>{available=r.compilers||[];if(d.isConnected)info();}).catch(e=>{if(d.isConnected)d.querySelector('[data-compiler-info]').textContent=e.message;});
 d.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=d.querySelector('[type="submit"]');button.disabled=true;
  try{
   if(W.target!==target)throw Error('Project changed. Reopen settings for the current project.');
   const paper={compiler:select.value,auto_compile:d.querySelector('[data-latex-auto]').checked},id=d.querySelector('[data-latex-main]').value;
   if(id)paper.main_file=id;
   await workspaceChange({op:'config',paper});
   await api(projectPaperURL(target)+'/cancel',{});
   if(W.target===target)await refreshWorkspaceView(target);
   d.close();
  }catch(err){d.querySelector('[data-error]').textContent=err.message;button.disabled=false;}
 };
}
function paperMain(){return W.manifest?.entries.find(e=>e.id===W.manifest?.paper?.main_file&&!e.deleted);}
function paperPath(entry){const parts=[entry.name],seen=new Set();let parent=entry.parent;while(parent&&!seen.has(parent)){seen.add(parent);const folder=W.manifest.entries.find(e=>e.id===parent);if(!folder)break;parts.unshift(folder.name);parent=folder.parent;}return parts.join('/');}
function paperUnmount(){
 const pane=$('#paper-pages');if(pane&&Paper.target)Paper.views.set(Paper.target,{scroll:pane.scrollTop,scale:Paper.scale,fit:Paper.fit,width:$('#paper-split')?.style.getPropertyValue('--paper-source-width')||'50%'});
 Paper.resizeObserver?.disconnect();clearTimeout(Paper.resizeTimer);
 Paper.generation++;clearTimeout(Paper.timer);clearTimeout(Paper.poll);Paper.observer?.disconnect();Paper.observer=null;
 for(const task of Paper.tasks)task.cancel();Paper.tasks.clear();Paper.doc?.destroy();Paper.doc=null;Paper.target=null;Paper.loaded=null;Paper.displayed=null;Paper.requested=null;Paper.current=null;Paper.busy=false;
}
async function newPaper(){
 const target=W.target;const names=new Set(W.manifest.entries.filter(e=>!e.deleted&&!e.parent).map(e=>e.name));let name='main.tex';for(let i=2;names.has(name);i++)name=`paper${i}.tex`;
 const d=workspaceDialog('New paper',`<form><p>Edit standard LaTeX beside a live PDF preview. The first build may download TeX support files.</p><label>Name <input data-name required value="${esc(name)}"></label><p class="workspace-error" data-error></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" data-icon="file-plus">Create paper</button></footer></form>`);
 d.querySelector('[data-cancel]').onclick=()=>d.close();d.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=d.querySelector('[type=submit]');button.disabled=true;try{
  if(W.target!==target)throw Error('Project changed. Reopen this dialog.');const name=d.querySelector('[data-name]').value.trim();if(!name.toLowerCase().endsWith('.tex'))throw Error('Use a .tex filename.');
  const m=await workspaceChange({op:'create',name,parent:'',text:String.raw`\documentclass{article}
\usepackage{amsmath,graphicx,hyperref}
\title{Untitled paper}
\author{}
\date{}
\begin{document}
\maketitle
\section{Introduction}
Write your paper here. For example, $E=mc^2$.
% Import references.bib, then uncomment these lines:
% \bibliographystyle{plain}
% \bibliography{references}
\end{document}
`});const entry=m.entries.find(e=>!e.deleted&&!e.parent&&e.name===name);await workspaceChange({op:'config',paper:{main_file:entry.id}});d.close();await openWorkspaceFile(entry.id);
 }catch(e){d.querySelector('[data-error]').textContent=e.message;}finally{button.disabled=false;}};
}
async function setPaperMain(id){await workspaceChange({op:'config',paper:{main_file:id}});await openWorkspaceFile(id);}
function paperMount(entry){
 const source=$('#workspace-editor textarea');if(!source||!(/\.(tex|cls|sty|bst|bib)$/i.test(entry.name)))return;
 const main=paperMain();if(!main&&!/\.tex$/i.test(entry.name))return;
 Paper.target=W.target;const generation=Paper.generation,target=Paper.target,view=Paper.views.get(target);Paper.scale=view?.scale||1;Paper.fit=view?.fit??true;
 const host=$('#workspace-editor'),toolbar=document.createElement('div');toolbar.className='paper-toolbar';toolbar.innerHTML=`<span data-paper-main>${main?'Main: '+esc(paperPath(main)):'No main document selected'}</span><button data-paper-compile data-icon="play">Compile</button><button data-paper-stop data-icon="square" disabled>Stop</button><label><input type="checkbox" data-paper-auto ${paperAuto()?'checked':''}> Auto</label><span data-paper-status role="status">${main?'Loading preview…':'Choose a main .tex document'}</span><button data-paper-minus data-icon="zoom-out" aria-label="Zoom out" data-icon-only></button><span data-paper-zoom></span><button data-paper-plus data-icon="zoom-in" aria-label="Zoom in" data-icon-only></button><button data-paper-fit>Fit</button><a data-paper-download hidden download="paper.pdf">Download PDF</a><button data-paper-settings data-icon="settings" aria-label="Project LaTeX settings" title="Project LaTeX settings" data-icon-only></button><button data-paper-help data-icon="circle-help" aria-label="Paper guide" data-icon-only></button>`;
 host.appendChild(toolbar);
 if(/\.tex$/i.test(entry.name)&&main?.id!==entry.id){const button=document.createElement('button');button.textContent='Set as main document';button.dataset.icon='file-text';button.onclick=()=>setPaperMain(entry.id).catch(e=>toast(e.message,{error:true}));toolbar.prepend(button);}
 const split=document.createElement('div');split.id='paper-split';split.style.setProperty('--paper-source-width',view?.width||store.get('noctua.paper.source-width')||'50%');
 const editor=document.createElement('div');editor.className='paper-source';editor.appendChild(source);
 const divider=document.createElement('div');divider.className='paper-divider';divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-label','Resize source and PDF');divider.setAttribute('aria-orientation','vertical');divider.setAttribute('aria-valuemin','20');divider.setAttribute('aria-valuemax','80');divider.setAttribute('aria-valuenow',String(parseFloat(view?.width||store.get('noctua.paper.source-width')||'50%')));
 const preview=document.createElement('div');preview.id='paper-pages';preview.innerHTML='<p class="paper-empty">The compiled PDF appears here. First-time builds can take longer while TeX support files download.</p>';
 split.append(editor,divider,preview);host.appendChild(split);
 const sourceToggle=document.createElement('button'),previewToggle=document.createElement('button');
 for(const [button,side] of [[sourceToggle,'source'],[previewToggle,'preview']]){button.className='pane-toggle paper-pane-toggle';button.dataset.paperPane=side;button.dataset.iconOnly='';button.setAttribute('aria-controls',side==='source'?'paper-source':'paper-pages');divider.appendChild(button);}
 editor.id='paper-source';
 const collapse=(side,save=true)=>{
  const hidden=split.dataset.hiddenPane===side?'':side;
  if(hidden==='preview')Paper.views.set(target,{...Paper.views.get(target),scroll:preview.scrollTop,scale:Paper.scale,fit:Paper.fit,width:split.style.getPropertyValue('--paper-source-width')});
  split.dataset.hiddenPane=hidden;editor.hidden=hidden==='source';preview.hidden=hidden==='preview';
  // Keep at least one working pane visible; switches never discard source or PDF state.
  for(const [button,name,label] of [[sourceToggle,'source','source editor'],[previewToggle,'preview','PDF preview']]){
   const closed=hidden===name;button.setAttribute('aria-expanded',String(!closed));button.title=button.ariaLabel=`${closed?'Show':'Hide'} ${label}`;button.dataset.icon=(name==='source')!==closed?'chevron-left':'chevron-right';
  }
  if(hidden==='preview')editor.style.flex='1';else editor.style.flex='';
  if(save)store.set('noctua.paper.hidden-pane',hidden);
  if(hidden!=='preview'&&Paper.doc)paperDraw(generation).catch(e=>paperMessage(e.message));
 };
 sourceToggle.onclick=()=>collapse('source');previewToggle.onclick=()=>collapse('preview');
 collapse(['source','preview'].includes(store.get('noctua.paper.hidden-pane'))?store.get('noctua.paper.hidden-pane'):'',false);
 let previewWidth=preview.clientWidth;
 Paper.resizeObserver=new ResizeObserver(()=>{const width=preview.clientWidth;if(width===previewWidth)return;previewWidth=width;clearTimeout(Paper.resizeTimer);if(width>0&&Paper.fit)Paper.resizeTimer=setTimeout(()=>{if(generation===Paper.generation)paperDraw(generation).catch(e=>paperMessage(e.message));},120);});
 Paper.resizeObserver.observe(preview);
 const logs=document.createElement('details');logs.className='paper-logs';logs.innerHTML='<summary>Compiler log</summary><div data-paper-errors></div><pre data-paper-log></pre>';host.appendChild(logs);
 const resize=pct=>{pct=Math.min(80,Math.max(20,pct));split.style.setProperty('--paper-source-width',pct+'%');store.set('noctua.paper.source-width',pct+'%');divider.setAttribute('aria-valuenow',String(Math.round(pct)));};
 divider.onpointerdown=e=>{if(e.target.closest('button')||split.dataset.hiddenPane)return;divider.setPointerCapture(e.pointerId);};divider.onpointermove=e=>{if(divider.hasPointerCapture(e.pointerId)){const r=split.getBoundingClientRect();resize((e.clientX-r.left)/r.width*100);}};
 divider.onpointerup=()=>{if(Paper.fit)paperDraw(generation).catch(e=>paperMessage(e.message));};
 divider.onkeydown=e=>{if(e.target.closest('button')||split.dataset.hiddenPane)return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize(parseFloat(split.style.getPropertyValue('--paper-source-width'))+(e.key==='ArrowLeft'?-2:2));if(Paper.fit)paperDraw(generation).catch(e=>paperMessage(e.message));}};
 toolbar.querySelector('[data-paper-compile]').onclick=()=>paperCompile(true);
 toolbar.querySelector('[data-paper-stop]').onclick=async()=>{clearTimeout(Paper.timer);Paper.requested='stopped';try{await api(projectPaperURL(target)+'/cancel',{});await paperPoll(generation);}catch(e){paperMessage(e.message);}};
 toolbar.querySelector('[data-paper-settings]').onclick=()=>showPaperSettings().catch(e=>toast(e.message,{error:true}));
 toolbar.querySelector('[data-paper-auto]').onchange=async e=>{const value=e.target.checked;e.target.disabled=true;clearTimeout(Paper.timer);try{await workspaceChange({op:'config',paper:{auto_compile:value}});if(generation!==Paper.generation)return;if(value){Paper.requested=null;paperEdited();}}catch(err){paperMessage(err.message);e.target.checked=paperAuto();}finally{e.target.disabled=false;}};
 const zoom=delta=>{Paper.fit=false;Paper.scale=Math.max(.35,Math.min(3,Paper.scale+delta));paperDraw(generation).catch(e=>paperMessage(e.message));};
 toolbar.querySelector('[data-paper-fit]').onclick=()=>{Paper.fit=true;paperDraw(generation).catch(e=>paperMessage(e.message));};
 toolbar.querySelector('[data-paper-minus]').onclick=()=>zoom(-.15);toolbar.querySelector('[data-paper-plus]').onclick=()=>zoom(.15);toolbar.querySelector('[data-paper-zoom]').textContent=Math.round(Paper.scale*100)+'%';
 toolbar.querySelector('[data-paper-help]').onclick=()=>workspaceDialog('Paper editor',`<p>The left pane edits standard LaTeX. The right pane shows the actual compiled PDF, including your document class and bibliography style.</p><p>Import .cls, .sty, .bst, .bib, images, and additional .tex files through Project files. Use their sidebar folder paths in LaTeX, relative to the project root. Choose the main .tex file using its actions menu.</p><p>Use the thin divider arrows to hide or reopen the source or PDF pane. The outer arrows hide navigation and chat. Widths and visibility are remembered without closing your document.</p><p>Auto compiles after a typing pause. Compile forces a rebuild; Stop cancels queued work too. A failed build keeps the last successful PDF visible. Click a reported file/line to edit it. Double-click PDF text to open and center its source line, including text from included files. Recompile older PDFs or edited sources first. Generated bibliography text may not have an editable source location.</p><p>Use the settings gear to choose bundled Tectonic (XeLaTeX) or pdfLaTeX per project, select the main document, and set automatic compilation. Both support BibTeX. Biber, shell-escape packages, and Noctua note commands (such as videos) are not supported. First-time builds require internet for support files; cached resources work offline. Only compile templates you trust: this is not a complete security sandbox.</p>`);
 source.addEventListener('input',paperEdited);paperPoll(generation);
}
function paperMessage(message){const node=$('[data-paper-status]');if(node)node.textContent=message;}
function paperEdited(){
 if(!Paper.target||Paper.target!==W.target)return;Paper.editVersion++;Paper.requested=null;paperMessage('Preview out of date');clearTimeout(Paper.timer);
 if(paperAuto())Paper.timer=setTimeout(()=>paperCompile(false),1000);
}
async function paperCompile(force=false){
 const target=Paper.target,generation=Paper.generation,editVersion=Paper.editVersion;if(!target||Paper.busy||!paperMain())return;
 Paper.busy=true;clearTimeout(Paper.timer);
 try{await saveWorkspaceFile();if(generation!==Paper.generation||W.target!==target)return;
  const result=await api(projectPaperURL(target),{revision:W.manifest.revision,force});if(generation!==Paper.generation)return;
  Paper.requested=result.fingerprint||'queued';paperMessage('Compiling…');await paperPoll(generation);
 }catch(e){if(generation===Paper.generation){Paper.requested='failed';paperMessage(e.message);}}finally{if(generation===Paper.generation){Paper.busy=false;if(editVersion!==Paper.editVersion&&paperAuto())paperEdited();}}
}
async function paperPoll(generation){
 if(generation!==Paper.generation||!Paper.target)return;clearTimeout(Paper.poll);
 const target=Paper.target,poll=++Paper.pollSerial;
 try{
  const s=await api(projectPaperURL(target));if(generation!==Paper.generation||poll!==Paper.pollSerial)return;
  if(s.current_revision!==undefined&&s.current_revision!==W.manifest.revision&&!W.dirty){await refreshWorkspaceView(target);return;}
  if(Paper.current&&Paper.current!==s.current_fingerprint)Paper.requested=null;Paper.current=s.current_fingerprint;
  const building=['queued','building','cancelling'].includes(s.state);
  const main=paperMain();$('[data-paper-main]').textContent=main?paperCompilerLabel()+' · '+paperPath(main):'No main document selected';
  $('[data-paper-auto]').checked=paperAuto();
  $('[data-paper-stop]').disabled=!building;$('[data-paper-compile]').disabled=!paperMain();
  const stale=s.stale||W.dirty;
  if(!building&&Paper.requested==='queued')Paper.requested=s.fingerprint||s.current_fingerprint||'done';
  paperMessage(s.configuration_error||(building?(s.queued?'Compiling; newer changes queued…':'Compiling…') : s.state==='error'?`Build failed${s.last_success?' — showing last successful PDF':''}`:s.state==='cancelled'?'Compilation stopped':stale?'Preview out of date':`PDF up to date${s.last_success?.elapsed_ms!=null?' · '+(s.last_success.elapsed_ms/1000).toFixed(1)+' s':''}`));
  $('[data-paper-log]').textContent=s.message?[s.message,s.log].filter(Boolean).join('\n'):s.log||'';
  paperDiagnostics(s.log||'');if(s.state==='error')$('.paper-logs').open=true;
  const last=s.last_success;if(last&&last.main_file===W.manifest?.paper?.main_file){
   const artifact=last.artifact||last.fingerprint,url=projectPaperURL(target)+'/pdf/'+artifact;const link=$('[data-paper-download]');link.href=url;link.hidden=false;link.title=stale?'Download last successful build':'Download PDF';
   if(Paper.loaded!==artifact){Paper.loaded=artifact;await paperLoadPDF(url,generation);}
   if(generation===Paper.generation&&Paper.loaded===artifact&&Paper.doc)Paper.displayed=last;
  }
  if(generation!==Paper.generation||poll!==Paper.pollSerial)return;
  // Retry only after another edit or an explicit request, not on every failed poll.
  if(paperAuto()&&!building&&!s.configuration_error&&stale&&!W.dirty&&!Paper.busy&&Paper.requested===null){Paper.requested=s.current_fingerprint;await paperCompile(false);}
 }catch(e){if(generation===Paper.generation&&poll===Paper.pollSerial)paperMessage(e.message);}
 finally{if(generation===Paper.generation&&poll===Paper.pollSerial){clearTimeout(Paper.poll);Paper.poll=setTimeout(()=>paperPoll(generation),1500);}}
}
function paperDiagnostics(log){
 const container=$('[data-paper-errors]');if(!container)return;container.replaceChildren();const seen=new Set();
 for(const line of log.split('\n')){const m=/(?:^|\s)(?:\.\/)?([^\s:]+\.(?:tex|cls|sty|bib|bst)):(\d+):/.exec(line);if(!m)continue;
  const path=m[1],number=Number(m[2]);const entry=W.manifest.entries.find(e=>!e.deleted&&e.kind==='file'&&paperPath(e)===path);if(!entry||seen.has(path+':'+number))continue;seen.add(path+':'+number);
  const button=document.createElement('button');button.textContent=path+':'+number;button.onclick=async()=>{try{await openWorkspaceFile(entry.id);const ta=$('#workspace-editor textarea');if(!ta)return;const pos=ta.value.split('\n').slice(0,number-1).join('\n').length+(number>1?1:0);ta.focus();ta.setSelectionRange(pos,pos);ta.scrollTop=(number-3)*parseFloat(getComputedStyle(ta).lineHeight);}catch(e){toast(e.message,{error:true});}};container.appendChild(button);
 }
}
async function paperLoadPDF(url,generation){
 const serial=++Paper.loadSerial,engine=await pdfjs();if(generation!==Paper.generation||serial!==Paper.loadSerial)return;
 const task=engine.getDocument({url,cMapUrl:'/vendor/pdfjs/web/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/web/standard_fonts/',wasmUrl:'/vendor/pdfjs/web/wasm/',isEvalSupported:false});
 let doc;try{doc=await task.promise;}catch(e){if(generation!==Paper.generation||serial!==Paper.loadSerial)return;Paper.loaded=null;throw e;}
 if(generation!==Paper.generation||serial!==Paper.loadSerial){await doc.destroy();return;}
 const old=Paper.doc;Paper.doc=doc;await paperDraw(generation);await old?.destroy();
}
async function paperDraw(generation){
 const doc=Paper.doc,pane=$('#paper-pages');if(!doc||!pane||pane.hidden)return;
 const scroll=pane.scrollTop||Paper.views.get(Paper.target)?.scroll||0;Paper.observer?.disconnect();for(const task of Paper.tasks)task.cancel();Paper.tasks.clear();
 const draw=Symbol();Paper.draw=draw;const active=()=>generation===Paper.generation&&Paper.draw===draw;
 const engine=await pdfjs();if(!active())return;
 const first=await doc.getPage(1);if(!active())return;if(Paper.fit)Paper.scale=Math.max(.1,(pane.clientWidth-40)/first.getViewport({scale:1}).width);const scale=Paper.scale,base=first.getViewport({scale});pane.replaceChildren();
 $('[data-paper-zoom]').textContent=Math.round(scale*100)+'%';
 const render=async node=>{if(node.dataset.rendered||!active())return;node.dataset.rendered='true';
  try{const page=await doc.getPage(Number(node.dataset.page));if(!active())return;const viewport=page.getViewport({scale}),ratio=Math.min(devicePixelRatio||1,3);
   node.style.width=viewport.width+'px';node.style.height=viewport.height+'px';const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';node.appendChild(canvas);
   const task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});Paper.tasks.add(task);try{await task.promise;}finally{Paper.tasks.delete(task);}if(!active())return;
   const layer=document.createElement('div');layer.className='textLayer';layer.style.setProperty('--total-scale-factor',scale);node.appendChild(layer);await new engine.TextLayer({textContentSource:await page.getTextContent(),container:layer,viewport}).render();
   layer.addEventListener('dblclick',event=>{if(active()){event.preventDefault();paperSourceAt(event,page,viewport,node,generation);}});
  }catch(e){if(active()&&e.name!=='RenderingCancelledException')paperMessage('PDF preview: '+e.message);}
 };
 Paper.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)render(entry.target);},{root:pane,rootMargin:'600px'});
 for(let i=1;i<=doc.numPages;i++){const node=document.createElement('div');node.className='paper-page';node.dataset.page=i;node.style.width=base.width+'px';node.style.height=base.height+'px';pane.appendChild(node);Paper.observer.observe(node);}
 pane.scrollTop=scroll;
}

// Coordinates come from PDF.js's viewport transform, not device pixels. This
// keeps reverse lookup accurate at any zoom, Retina scale, or page rotation.
async function paperSourceAt(event,page,viewport,node,generation){
 const displayed=Paper.displayed,target=Paper.target;
 if(!displayed||generation!==Paper.generation)return;
 if(W.dirty){toast('Recompile after saving your changes before navigating to source.',{error:true});return;}
 const rect=node.getBoundingClientRect();
 const [px,py]=viewport.convertToPdfPoint((event.clientX-rect.left)*viewport.width/rect.width,(event.clientY-rect.top)*viewport.height/rect.height);
 const unit=page.userUnit||1;
 try{
  const found=await api(projectPaperURL(target)+'/source',{fingerprint:displayed.fingerprint,page:page.pageNumber,x:(px-page.view[0])*unit,y:(page.view[3]-py)*unit});
  if(generation!==Paper.generation||target!==W.target||Paper.displayed?.fingerprint!==displayed.fingerprint||W.dirty)return;
  const entry=W.manifest.entries.find(e=>e.id===found.file_id&&!e.deleted);
  if(!entry||entry.blob!==found.blob){toast('Source changed; recompile before navigating.',{error:true});return;}
  if(W.file!==entry.id)await openWorkspaceFile(entry.id);
  if(target!==W.target||W.file!==entry.id||W.dirty)return;
  if($('#paper-split')?.dataset.hiddenPane==='source')$('[data-paper-pane="source"]').click();
  const ta=$('#workspace-editor textarea');if(!ta)return;
  paperCenterLine(ta,found.line);
 }catch(e){if(generation===Paper.generation)toast(e.message,{error:true});}
}
function paperCenterLine(ta,line){
 const lines=ta.value.split('\n'),index=Math.max(0,Math.min(lines.length-1,line-1));
 const start=lines.slice(0,index).reduce((n,s)=>n+s.length+1,0),end=start+lines[index].length;
 ta.focus({preventScroll:true});ta.setSelectionRange(start,end);
 // A mirror accounts for wrapped source lines, tabs, font size, and padding.
 // Counting newline characters alone fails when a paragraph wraps in the editor.
 const mirror=document.createElement('div'),style=getComputedStyle(ta);
 for(const property of ['font','lineHeight','letterSpacing','padding','tabSize','wordBreak','overflowWrap'])mirror.style[property]=style[property];
 Object.assign(mirror.style,{position:'absolute',visibility:'hidden',pointerEvents:'none',whiteSpace:'pre-wrap',overflowWrap:'break-word',boxSizing:'border-box',width:ta.clientWidth+'px'});
 mirror.append(document.createTextNode(ta.value.slice(0,start)));const marker=document.createElement('span');marker.textContent=lines[index]||'\u200b';mirror.append(marker);document.body.append(mirror);
 const top=marker.getBoundingClientRect().top-mirror.getBoundingClientRect().top;
 ta.scrollTop=Math.max(0,top-ta.clientHeight/2+(parseFloat(style.lineHeight)||20)/2);ta.scrollLeft=0;mirror.remove();
}
