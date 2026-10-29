'use strict';
const PDF={key:null,paper:null,page:1,scale:1.25,fit:store.get('noctua.pdfFit')==='width',mode:'select',color:'#ffd400',annotations:[],selection:null,selected:null,token:0,dark:true};
const pdfCategories={novelty:{label:'Novelty',color:'#ff6666'},method:{label:'Method',color:'#5fb236'},results:{label:'Results',color:'#a28ae5'},limitations:{label:'Limitations',color:'#ffd400'}};
const pdfDefaultCategoryColors=Object.freeze(Object.fromEntries(Object.entries(pdfCategories).map(([key,value])=>[key,value.color])));
const pdfDefaultColors=Object.freeze(['#ffd400','#5fb236','#2ea8e5','#e56eee','#a28ae5','#ff6666']);
const pdfColors=[...pdfDefaultColors];
function applyPDFHighlightColors(colors,palette=pdfColors){
  const oldIndex=pdfColors.indexOf(PDF.color);
  const valid=Array.isArray(palette)&&palette.length===6&&palette.every(color=>/^#[0-9a-f]{6}$/i.test(color));
  pdfColors.splice(0,6,...(valid?palette:pdfDefaultColors).map(color=>color.toLowerCase()));
  PDF.color=pdfColors[oldIndex<0?0:oldIndex];
  for(const [key,category] of Object.entries(pdfCategories)){
    const color=(colors?.[key]||'').toLowerCase();
    category.color=pdfColors.includes(color)?color:pdfColors[pdfDefaultColors.indexOf(pdfDefaultCategoryColors[key])];
  }
  document.querySelectorAll('.pdf-toolbar [data-color]').forEach((button,index)=>{
    const color=pdfColors[index];button.dataset.color=color;button.style.setProperty('--swatch',color);
    button.title=`Color ${index+1} · ${color}`;button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(PDF.color===color));
  });
  document.querySelector('.pdf-toolbar .pdf-color-dot')?.style.setProperty('--swatch',PDF.color);
  for(const annotation of PDF.annotations||[])if(annotation.author==='assistant'&&annotation.kind==='highlight'&&pdfCategories[annotation.category])annotation.color=pdfCategories[annotation.category].color;
  if(PDF.key){
    updatePDFAutoHighlightUI();
    if(typeof updatePDFAnnotationControls==='function')updatePDFAnnotationControls();
    if(typeof paintPDFAnnotations==='function')paintPDFAnnotations();
    for(const card of document.querySelectorAll('#pdf-annotation-list article')){const annotation=PDF.annotations.find(item=>item.id===card.dataset.id);if(annotation?.author==='assistant')card.querySelector('.pdf-category-badge')?.style.setProperty('--category-color',annotation.color);}
  }
}
const pdfAutoHighlights=new Map();
const pdfDocs=new Map(),pdfIndexes=new Map(),pdfSaves=new Set();
const pdfSystemTheme=window.matchMedia('(prefers-color-scheme: dark)');
function applyReaderTheme(){
  const dark=PDF.theme==='dark'||(PDF.theme==='system'&&pdfSystemTheme.matches);
  const changed=PDF.dark!==dark,anchor=changed&&PDF.key?pdfZoomAnchor():null;
  PDF.dark=dark;
  if($('#setup-reader-theme'))$('#setup-reader-theme').value=PDF.theme;
  if(changed&&PDF.key)return renderPDF(anchor);
}
function setReaderTheme(theme){
  PDF.theme=['dark','light','system'].includes(theme)?theme:'system';
  store.set('noctua.readerTheme',PDF.theme);
  return applyReaderTheme();
}
function setPDFPageTheme(theme){return setReaderTheme(theme==='light'?'light':'dark');}
let pdfEngine;
async function pdfjs(){
  if(!Promise.withResolvers)Promise.withResolvers=function(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
  if(!pdfEngine)pdfEngine=import('/vendor/pdfjs/build/pdf.mjs?noctua=2').then(m=>{m.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.mjs?noctua=2';return m;});return pdfEngine;
}
async function pdfDocument(key){
  if(!pdfDocs.has(key))pdfDocs.set(key,(async()=>{const m=await pdfjs();const task=m.getDocument({url:paperURL(key)+'/pdf',cMapUrl:'/vendor/pdfjs/web/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/web/standard_fonts/',wasmUrl:'/vendor/pdfjs/web/wasm/',isEvalSupported:false});task.onPassword=(update)=>{const password=prompt('Password for this PDF');if(password===null)task.destroy();else update(password);};return await task.promise;})().catch(e=>{pdfDocs.delete(key);throw e;}));
  return pdfDocs.get(key);
}
function pdfSave(promise){pdfSaves.add(promise);promise.finally(()=>pdfSaves.delete(promise)).catch(()=>{});return promise;}
window.flushPDF=async()=>{await Promise.all([...pdfCommentEdits.values()].map(edit=>savePDFComment(edit)));await Promise.all([...pdfSaves]);};
function normalizedRect(r,b){const x=Math.max(0,Math.min(1,(r.left-b.left)/b.width)),y=Math.max(0,Math.min(1,(r.top-b.top)/b.height));return [x,y,Math.max(0,Math.min(1-x,r.width/b.width)),Math.max(0,Math.min(1-y,r.height/b.height))];}
async function textLayer(page,container,viewport){const m=await pdfjs();container.style.setProperty('--total-scale-factor',viewport.scale);const layer=new m.TextLayer({textContentSource:await page.getTextContent(),container,viewport});// PDF.js sets dimensions using CSS round() and its scale-round variables.
  // Also pin the computed dimensions: an offscreen layer must never stretch to the window.
  container.style.width=viewport.width+'px';container.style.height=viewport.height+'px';
  await layer.render();return layer;}
async function indexPDF(key){
  if(pdfIndexes.has(key))return pdfIndexes.get(key);
  const work=(async()=>{const cached=await api(paperURL(key)+'/index');if(cached?.version===2)return cached;const paper=await api(paperURL(key)),doc=await pdfDocument(key),pages=[];
    for(let n=1;n<=doc.numPages;n++){
      const page=await doc.getPage(n),viewport=page.getViewport({scale:1}),container=document.createElement('div');container.className='textLayer pdf-index-layer';container.style.cssText=`position:fixed;left:-100000px;top:0;width:${viewport.width}px;height:${viewport.height}px;`;document.body.append(container);
      try{const layer=await textLayer(page,container,viewport),bounds=container.getBoundingClientRect();let text='';const words=[];
        for(const div of layer.textDivs){const str=div.textContent,base=text.length;text+=str+'\n';if(!div.firstChild)continue;for(const match of str.matchAll(/\S+/g)){const range=document.createRange();range.setStart(div.firstChild,match.index);range.setEnd(div.firstChild,match.index+match[0].length);const rect=normalizedRect(range.getBoundingClientRect(),bounds);if(rect[2]&&rect[3])words.push({start:base+match.index,end:base+match.index+match[0].length,rect});}}
        pages.push({page:n,width:viewport.width,height:viewport.height,text,words});
      }finally{container.remove();}
    }const result={version:2,hash:paper.pdf_hash,pages};await libraryRequest(paperURL(key)+'/index','PUT',result);return result;
  })();pdfIndexes.set(key,work);work.catch(()=>pdfIndexes.delete(key));return work;
}
async function pdfPageImage(key,n){const doc=await pdfDocument(key),page=await doc.getPage(n),base=page.getViewport({scale:1});let scale=Math.min(2,1500/base.width);for(let i=0;i<4;i++){const v=page.getViewport({scale}),c=document.createElement('canvas');c.width=Math.ceil(v.width);c.height=Math.ceil(v.height);await page.render({canvasContext:c.getContext('2d'),viewport:v}).promise;const blob=await new Promise(r=>c.toBlob(r,'image/png'));if(blob&&blob.size<=5*1024*1024)return libraryRequest(paperURL(key)+'/page-image/'+n,'POST',blob);scale*=.65;}throw new Error('Page preview is too large');}
async function openPDF(key,{page=1,annotation=null,push=true}={}){
  const token=++PDF.token;const paper=await api(paperURL(key));if(!paper.has_pdf)throw new Error('Attach a PDF to this paper in Library first.');const doc=await pdfDocument(key);if(token!==PDF.token)return;
  Object.assign(PDF,{annotationFilter:key===PDF.key?PDF.annotationFilter:null,annotations:key===PDF.key?PDF.annotations:[],key,paper,doc,page:Math.max(1,Math.min(doc.numPages,Number(page)||1)),selection:null,selected:annotation});$('#reader-mode').disabled=false;setMode('pdf');document.title=paper.title+' · Noctua';
  PDF.outlineSource='document';ensurePDFSidebar();renderPDFOutline();loadPDFOutline(key,doc);
  if(push)history.pushState({},'', '/#pdf='+enc(key)+'&page='+PDF.page);await renderPDF();await refreshPDFAnnotations();if(annotation)setPDFSidebarTab('annotations');if(annotation)$('#pdf-sidebar [data-id="'+annotation+'"]')?.scrollIntoView({block:'nearest'});indexPDF(key).then(()=>{if(PDF.key===key)return refreshPDFAnnotations();}).catch(e=>toast('PDF text: '+e.message));
}
const pdfOutlines=new Map();
function ensurePDFSidebar(){
  const side=$('#pdf-sidebar');if(side.querySelector('.pdf-sidebar-tabs'))return;
  side.innerHTML='<div class="tabs pdf-sidebar-tabs" role="tablist" aria-label="Reader navigation"><button id="pdf-outline-tab" role="tab" aria-controls="pdf-outline-panel" data-sidebar="outline" data-icon="book-open">Outline</button><button id="pdf-annotations-tab" role="tab" aria-controls="pdf-annotations-panel" data-sidebar="annotations" data-icon="highlighter">Annotations</button></div><section id="pdf-outline-panel" role="tabpanel" aria-labelledby="pdf-outline-tab"></section><section id="pdf-annotations-panel" role="tabpanel" aria-labelledby="pdf-annotations-tab"><div class="pdf-annotation-toolbar"><div class="pdf-highlight-counts" aria-label="Highlight counts"><span>User highlights <strong data-highlight-count="user">0</strong></span><span>AI highlights <strong data-highlight-count="assistant">0</strong></span></div><div class="pdf-annotation-filters" role="group" aria-label="Filter annotations"><button data-annotation-filter="user" aria-pressed="false">User</button><button data-annotation-filter="novelty" aria-pressed="false">Novelty</button><button data-annotation-filter="method" aria-pressed="false">Methods</button><button data-annotation-filter="results" aria-pressed="false">Results</button><button data-annotation-filter="limitations" aria-pressed="false">Limitations</button></div></div><div id="pdf-auto-highlight-status" role="status"></div><div id="pdf-annotation-list"></div></section>';
  for(const button of side.querySelectorAll('[data-sidebar]')){
    button.onclick=()=>setPDFSidebarTab(button.dataset.sidebar);
    button.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const tab=event.key==='Home'?'outline':event.key==='End'?'annotations':button.dataset.sidebar==='outline'?'annotations':'outline';
      setPDFSidebarTab(tab);side.querySelector(`[data-sidebar="${tab}"]`).focus();
    };
  }
  side.querySelector('.pdf-annotation-filters').onclick=event=>{const button=event.target.closest('[data-annotation-filter]');if(button)setPDFAnnotationFilter(button.dataset.annotationFilter,{toggle:true});};
  setPDFSidebarTab(PDF.sidebar||store.get('noctua.pdfSidebar')||'outline');renderPDFOutline();updatePDFAnnotationControls();
}
function setPDFSidebarTab(tab){
  PDF.sidebar=tab==='annotations'?'annotations':'outline';store.set('noctua.pdfSidebar',PDF.sidebar);
  for(const button of document.querySelectorAll('#pdf-sidebar [data-sidebar]')){
    const selected=button.dataset.sidebar===PDF.sidebar;button.setAttribute('aria-selected',String(selected));button.classList.toggle('active',selected);button.tabIndex=selected?0:-1;
    document.getElementById(button.getAttribute('aria-controls')).hidden=!selected;
  }
}
async function nativePDFOutline(doc){
  const entries=[];
  async function visit(items,level){
    for(const item of items||[]){
      if(entries.length>=300)return;
      let target=null;try{if(item.dest)target=await resolvePDFDestination(doc,{dest:item.dest});}catch{}
      if(item.title?.trim())entries.push({title:item.title.trim(),level:Math.min(level,6),page:target?.page??null,y:target?.y??0});
      if(item.items?.length)await visit(item.items,Math.min(level+1,6));
    }
  }
  await visit(await doc.getOutline(),1);
  return entries.some(e=>e.page)?{source:'document',entries}:null;
}
function pdfOutlineState(key){
  if(!pdfOutlines.has(key))pdfOutlines.set(key,{status:'idle',outline:null,error:null,documentStatus:'idle',documentOutline:null});
  return pdfOutlines.get(key);
}
function setPDFOutlineSource(source){
  PDF.outlineSource=source==='ai'?'ai':'document';renderPDFOutline();
  return loadPDFOutline(PDF.key,PDF.doc,{forceAI:PDF.outlineSource==='ai'});
}
function updatePDFOutlineProgress(key, state) {
  const status = ['loading','indexing','generating','deleting'].includes(state.status) ? state.status : state.documentStatus === 'loading' ? 'document' : null;
  const labels = { document: 'Loading document outline…', loading: 'Loading AI outline…', indexing: 'Preparing paper text…', generating: 'Generating outline…', deleting: 'Deleting AI outline…' };
  notifyProgress('pdf-outline:' + key, status ? labels[status] : null);
}
function loadPDFOutline(key,doc,{forceAI=false,regenerate=false}={}){
  const state=pdfOutlineState(key),update=()=>{updatePDFOutlineProgress(key,state);if(PDF.key===key)renderPDFOutline();};
  if(!forceAI&&!regenerate){
    if(state.documentPromise)return state.documentPromise;
    state.documentStatus='loading';update();
    state.documentPromise=nativePDFOutline(doc).then(outline=>{state.documentOutline=outline;state.documentStatus='ready';}).catch(error=>{
      state.documentStatus='error';if(PDF.key===key&&PDF.outlineSource!=='ai')toast(error.message,{error:true,duration:5000});
    }).finally(update);
    return state.documentPromise;
  }
  if(PDF.key===key)PDF.outlineSource='ai';
  if(['loading','indexing','generating','deleting'].includes(state.status))return state.deletePromise||state.promise;
  if(!regenerate&&state.status==='ready'&&state.outline?.entries?.length){update();return state.promise||Promise.resolve();}
  state.status='loading';state.error=null;update();
  state.promise=(async()=>{
    if(!regenerate){const saved=await api(paperURL(key)+'/outline');if(saved?.entries?.length){state.outline=saved;state.status='ready';return;}}
    state.status='indexing';update();await indexPDF(key);
    state.status='generating';update();
    state.outline=await api(paperURL(key)+'/outline',{regenerate});state.status='ready';
  })().catch(error=>{state.status='error';state.error=error.message;if(PDF.key===key&&PDF.outlineSource==='ai')toast(error.message,{error:true,duration:5000});}).finally(update);
  return state.promise;
}
async function deletePDFOutline(){
  const key=PDF.key,state=pdfOutlineState(key);
  if(!state.outline?.entries?.length||['loading','indexing','generating','deleting'].includes(state.status))return;
  const previousStatus=state.status;state.status='deleting';updatePDFOutlineProgress(key,state);renderPDFOutline();
  state.deletePromise=(async()=>{
    await libraryRequest(paperURL(key)+'/outline','DELETE');
    state.outline=null;state.status='deleted';state.error=null;state.promise=null;
  })().catch(error=>{
    state.status=previousStatus;state.error=error.message;
    if(PDF.key===key&&PDF.outlineSource==='ai')toast(error.message,{error:true,duration:5000});
  }).finally(()=>{state.deletePromise=null;updatePDFOutlineProgress(key,state);if(PDF.key===key)renderPDFOutline();});
  return state.deletePromise;
}
function renderPDFOutline(){
  const panel=$('#pdf-outline-panel');if(!panel)return;
  const state=pdfOutlines.get(PDF.key),ai=PDF.outlineSource==='ai',outline=ai?state?.outline:state?.documentOutline;
  const status=ai?state?.status:state?.documentStatus,busy=['loading','indexing','generating','deleting'].includes(status);
  const sourceId=ai?'ai':'document';
  let content=ai?`<div class="pdf-outline-head pdf-outline-actions"><button data-outline-retry ${busy?'disabled':''}>Regenerate</button><button data-outline-delete data-icon="trash-2" data-icon-only aria-label="Delete AI-generated outline" title="Delete AI-generated outline" ${busy||!outline?.entries?.length?'disabled':''}></button></div>`:'';
  if(outline?.entries?.length){
    const roots=[],stack=[];
    outline.entries.forEach((entry,index)=>{
      const node={...entry,index,children:[]};while(stack.length&&stack.at(-1).level>=node.level)stack.pop();
      (stack.length?stack.at(-1).children:roots).push(node);stack.push(node);
    });
    const list=nodes=>'<ol>'+nodes.map(node=>`<li>${node.page?`<button data-outline-entry="${node.index}" title="Page ${node.page}"><span>${esc(node.title)}</span><small>${node.page}</small></button>`:`<span class="pdf-outline-group">${esc(node.title)}</span>`}${node.children.length?list(node.children):''}</li>`).join('')+'</ol>';
    content+=`<nav class="pdf-outline-list" aria-label="Paper outline">${list(roots)}</nav>`;
  }else if(status==='error'&&!ai)content+='<div class="pdf-outline-empty"><button data-outline-retry>Try again</button></div>';
  else if(!busy)content+=`<p class="pdf-outline-empty">${ai?'No AI-generated outline.':'This PDF has no document outline.'}</p>`;
  panel.innerHTML=`<div class="pdf-outline-source-tabs" role="tablist" aria-label="Outline source"><button id="pdf-outline-source-document" role="tab" aria-controls="pdf-outline-content" data-outline-source="document" aria-selected="${!ai}" tabindex="${ai?-1:0}" class="${ai?'':'active'}" aria-label="Document outline" title="Document outline">Document</button><span class="pdf-outline-source-divider" aria-hidden="true">/</span><button id="pdf-outline-source-ai" role="tab" aria-controls="pdf-outline-content" data-outline-source="ai" aria-selected="${ai}" tabindex="${ai?0:-1}" class="${ai?'active':''}" aria-label="AI-generated outline" title="AI-generated outline">AI-generated</button></div><div id="pdf-outline-content" role="tabpanel" aria-labelledby="pdf-outline-source-${sourceId}" aria-busy="${busy}">${content}</div>`;
  for(const button of panel.querySelectorAll('[data-outline-source]')){
    button.onclick=()=>setPDFOutlineSource(button.dataset.outlineSource);
    button.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const source=event.key==='Home'?'document':event.key==='End'?'ai':button.dataset.outlineSource==='document'?'ai':'document';
      setPDFOutlineSource(source);panel.querySelector(`[data-outline-source="${source}"]`)?.focus();
    };
  }
  panel.querySelector('[data-outline-retry]')?.addEventListener('click',()=>{
    if(ai)return loadPDFOutline(PDF.key,PDF.doc,{forceAI:true,regenerate:!!state?.outline?.entries?.length});
    state.documentPromise=null;return loadPDFOutline(PDF.key,PDF.doc);
  });
  panel.querySelector('[data-outline-delete]')?.addEventListener('click',deletePDFOutline);
  panel.querySelectorAll('[data-outline-entry]').forEach(button=>button.onclick=()=>{
    const entry=outline.entries[Number(button.dataset.outlineEntry)];return pdfNavigate(entry.page,entry.y||0).catch(e=>toast(e.message));
  });
  updatePDFOutlineSelection();
}
function updatePDFOutlineSelection(){
  const state=pdfOutlines.get(PDF.key),entries=(PDF.outlineSource==='ai'?state?.outline:state?.documentOutline)?.entries;if(!entries)return;
  const box=pdfPageBox(PDF.page),scroll=$('#pdf-stage .pdf-scroll');
  const y=box&&scroll?Math.max(0,(scroll.getBoundingClientRect().top-box.getBoundingClientRect().top+24)/box.getBoundingClientRect().height):0;
  let active=-1;entries.forEach((entry,i)=>{if(entry.page&&(entry.page<PDF.page||(entry.page===PDF.page&&(entry.y||0)<=y)))active=i;});
  for(const button of document.querySelectorAll('#pdf-outline-panel [data-outline-entry]')){
    if(Number(button.dataset.outlineEntry)===active)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');
  }
}
async function autoHighlightPDF(){
  const key=PDF.key;if(!key)return;
  const previous=pdfAutoHighlights.get(key);if(previous&&['indexing','analyzing'].includes(previous.status))return previous.promise;
  ensurePDFSidebar();setPDFSidebarTab('annotations');setPDFAnnotationFilter(null);
  const job={status:'indexing',error:null};pdfAutoHighlights.set(key,job);
  const update=()=>{
    notifyProgress('pdf-highlights:'+key, ['indexing','analyzing'].includes(job.status) ? job.status==='indexing'?'Preparing paper text…':'Finding key passages…' : null);
    if(PDF.key===key)updatePDFAutoHighlightUI();
  };
  update();
  job.promise=(async()=>{
    await indexPDF(key);job.status='analyzing';update();
    job.result=await api(paperURL(key)+'/auto-highlight',{});job.status='ready';
    if(PDF.key===key){await refreshPDFAnnotations();if(job.result?.total===0)toast('No grounded key passages found.');}
  })().catch(error=>{job.status='error';job.error=error.message;if(PDF.key===key)toast(error.message,{error:true});}).finally(update);
  return job.promise;
}
function updatePDFAutoHighlightUI(){
  updatePDFAnnotationControls();
  const job=pdfAutoHighlights.get(PDF.key),busy=job&&['indexing','analyzing'].includes(job.status);
  const saved=PDF.annotations.filter(a=>a.source==='auto-highlight');
  const button=$('#pdf-stage [data-auto-highlight]');
  if(button){button.disabled=!!busy;button.setAttribute('aria-busy',String(!!busy));button.dataset.complete=String(!!saved.length);button.title=busy?'Auto-highlight agent is analyzing this paper…':'Auto-highlight paper';}
  const status=$('#pdf-auto-highlight-status');if(!status)return;
  status.innerHTML=job?.status==='error'?`<button data-auto-retry title="${esc(job.error)}">Retry auto-highlight</button>`:'';
  status.querySelector('[data-auto-retry]')?.addEventListener('click',autoHighlightPDF);
}
function updatePDFAnnotationControls(){
  for(const author of ['user','assistant']){
    const count=document.querySelector(`[data-highlight-count="${author}"]`);
    if(count)count.textContent=PDF.annotations.filter(a=>a.kind==='highlight'&&a.author===author).length;
  }
  for(const button of document.querySelectorAll('#pdf-sidebar [data-annotation-filter]')){
    const filter=button.dataset.annotationFilter;
    button.setAttribute('aria-pressed',String(PDF.annotationFilter===filter));
    const color=filter==='user'?'var(--accent)':pdfCategories[filter].color;
    button.style.setProperty('--filter-color',color);
  }
}
function setPDFAnnotationFilter(filter,{toggle=false}={}){
  if(filter!=='user'&&!pdfCategories[filter])filter=null;
  PDF.annotationFilter=toggle&&PDF.annotationFilter===filter?null:filter;
  const selected=PDF.annotations.find(a=>a.id===PDF.selected);
  if(selected&&!pdfAnnotationMatchesFilter(selected,PDF.annotationFilter))clearPDFAnnotationSelection();
  updatePDFAnnotationControls();applyPDFAnnotationFilter();
}
function applyPDFAnnotationFilter(){
  const list=$('#pdf-annotation-list');if(!list)return;
  const annotations=new Map(PDF.annotations.map(a=>[a.id,a]));let visible=0;
  for(const card of list.querySelectorAll('article')){
    const annotation=annotations.get(card.dataset.id);card.hidden=!annotation||!pdfAnnotationMatchesFilter(annotation,PDF.annotationFilter);if(!card.hidden)visible++;
  }
  let empty=list.querySelector('.pdf-annotation-empty');
  if(!empty){empty=document.createElement('p');empty.className='pdf-annotation-empty';list.append(empty);}
  empty.hidden=visible>0;empty.textContent=PDF.annotations.length?'No annotations match this filter.':'No annotations yet.';
}
function pdfCategoryBadge(a){
  const category=pdfCategories[a.category];return category?`<span class="pdf-category-badge" style="--category-color:${esc(a.color)}">${category.label}</span>`:'';
}
// Re-rasterize PDF vectors at the display's pixel density, rather than magnifying
// an existing bitmap. Render at least 2x, rounded up to a whole factor, so
// standard and fractionally scaled screens downsample a sharp page instead of
// stretching a soft one. Bound large pages to avoid exceeding WebKit canvas limits.
function pdfRasterSize(width,height,density){
  const ratio=Math.min(Math.max(2,Math.ceil((density || 1)-.01)),Math.sqrt(32*1024*1024/(width*height)),16384/width,16384/height);
  const w=Math.max(1,Math.floor(width*ratio)),h=Math.max(1,Math.floor(height*ratio));
  return {width:w,height:h,transform:[w/width,0,0,h/height,0,0]};
}
function pdfPixelDensity(){
  let magnification=window.visualViewport?.scale || 1;
  try {magnification=Math.max(magnification,window.parent.visualViewport?.scale || 1);} catch {}
  return (window.devicePixelRatio || 1)*magnification;
}
let pdfZoomTimer=null,pdfZoomTarget=null,pdfGestureStart=null,pdfRenderDensity=0;
function pdfZoomAnchor(clientX,clientY){
  const scroll=$('#pdf-stage .pdf-scroll');if(!scroll)return null;
  const pointY=Number.isFinite(clientY)?clientY:scroll.getBoundingClientRect().top+scroll.clientHeight/2;
  const box=pdfPageEntries.find(e=>{const b=e.box.getBoundingClientRect();return pointY>=b.top&&pointY<=b.bottom;})?.box || pdfPageBox(PDF.page);if(!box)return null;
  const outer=scroll.getBoundingClientRect(),page=box.getBoundingClientRect();
  const x=Number.isFinite(clientX)?clientX:outer.left+outer.width/2,y=Number.isFinite(clientY)?clientY:outer.top+outer.height/2;
  return {page:Number(box.dataset.page),x:(x-page.left)/page.width,y:(y-page.top)/page.height,screenX:x-outer.left,screenY:y-outer.top};
}
function restorePDFZoomAnchor(anchor){
  const scroll=$('#pdf-stage .pdf-scroll'),box=pdfPageBox(anchor?.page || PDF.page);if(!anchor||!scroll||!box)return;
  const outer=scroll.getBoundingClientRect(),page=box.getBoundingClientRect();
  scroll.scrollLeft+=page.left-outer.left+anchor.x*page.width-anchor.screenX;
  scroll.scrollTop+=page.top-outer.top+anchor.y*page.height-anchor.screenY;
}
async function zoomPDF(scale,anchor=pdfZoomAnchor(),{fit=false}={}){
  clearTimeout(pdfZoomTimer);pdfZoomTarget=null;pdfZoomPreview=null;
  if(!fit&&PDF.fit)setPDFFit(false,false);
  PDF.scale=Math.max(.4,Math.min(6,scale));await renderPDF(anchor);
}
// Scaled in place while zooming; see previewPDFZoom.
let pdfZoomPreview=null;
function schedulePDFZoom(scale,x,y){
  clearTimeout(pdfZoomTimer);pdfZoomTarget=Math.max(.4,Math.min(6,scale));
  if(typeof previewPDFZoom==='function')previewPDFZoom(pdfZoomTarget,x,y);
  const anchor=pdfZoomPreview?.anchor||pdfZoomAnchor(x,y),key=PDF.key,page=PDF.page;
  pdfZoomTimer=setTimeout(()=>{const target=pdfZoomTarget;pdfZoomTarget=null;pdfZoomPreview=null;if(key===PDF.key&&page===PDF.page&&target!==null)zoomPDF(target,anchor).catch(e=>toast(e.message));},180);
}
function pdfWheelZoom(event){
  if(!PDF.doc||!event.ctrlKey)return;
  event.preventDefault();if(pdfGestureStart!==null)return;
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?300:1);
  // About 12% per mouse-wheel notch; trackpads zoom continuously.
  schedulePDFZoom((pdfZoomTarget ?? PDF.scale)*Math.exp(-Math.max(-100,Math.min(100,delta))*.0012),event.clientX,event.clientY);
}

const pdfZoomStage=$('#pdf-stage');
pdfZoomStage.addEventListener('wheel',pdfWheelZoom,{passive:false});
pdfZoomStage.addEventListener('gesturestart',event=>{if(!PDF.doc)return;event.preventDefault();pdfGestureStart=PDF.scale;},{passive:false});
pdfZoomStage.addEventListener('gesturechange',event=>{if(pdfGestureStart===null)return;event.preventDefault();schedulePDFZoom(pdfGestureStart*event.scale,event.clientX,event.clientY);},{passive:false});
pdfZoomStage.addEventListener('gestureend',event=>{if(pdfGestureStart===null)return;event.preventDefault();pdfGestureStart=null;},{passive:false});
// While zooming, the rendered pages are scaled in place around the pointer
// (eased between wheel steps); pages re-render sharply once zooming pauses.
function previewPDFZoom(scale,x,y){
  const doc=$('#pdf-stage .pdf-document'),scroll=$('#pdf-stage .pdf-scroll');if(!doc||!scroll)return;
  if(!pdfZoomPreview){
    const box=doc.getBoundingClientRect(),outer=scroll.getBoundingClientRect();
    const px=Number.isFinite(x)?x:outer.left+outer.width/2,py=Number.isFinite(y)?y:outer.top+outer.height/2;
    pdfZoomPreview={anchor:pdfZoomAnchor(px,py)};
    doc.style.transformOrigin=`${px-box.left}px ${py-box.top}px`;
    doc.style.transition='transform 90ms ease-out';
  }
  doc.style.transform=`scale(${scale/PDF.scale})`;
  const level=$('#pdf-stage .pdf-zoom-level');if(level)level.textContent=Math.round(scale*100)+'%';
}
// Fit width: the widest page fills the reading area, following window, pane
// and split-view resizes. Zooming by hand turns it off.
function pdfFitScale(sizes){
  const scroll=$('#pdf-stage .pdf-scroll');if(!scroll||!sizes?.length)return null;
  const style=getComputedStyle(scroll),room=scroll.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
  const widest=Math.max(...sizes.map(s=>s.width));
  return room>50&&widest>0?Math.max(.4,Math.min(6,room/widest)):null;
}
function setPDFFit(on,apply=true){
  PDF.fit=on;store.set('noctua.pdfFit',on?'width':'');
  $('#pdf-stage [data-fit]')?.setAttribute('aria-pressed',String(on));
  if(on&&apply&&PDF.doc)refitPDF(true);
}
let pdfFitTimer=null;
function refitPDF(now=false){
  clearTimeout(pdfFitTimer);
  pdfFitTimer=setTimeout(async()=>{
    if(!PDF.fit||!PDF.doc||!document.body.classList.contains('pdf-mode'))return;
    const scale=pdfFitScale(await pdfPageLayout(PDF.doc));
    if(scale&&Math.abs(scale-PDF.scale)>.005)zoomPDF(scale,pdfZoomAnchor(),{fit:true}).catch(e=>toast(e.message));
  },now?0:120);
}
window.addEventListener('resize',()=>refitPDF());
document.addEventListener('noctua-split-change',()=>refitPDF());
let pdfDensityTimer=null;
function pdfDensityChanged(){
  clearTimeout(pdfDensityTimer);
  pdfDensityTimer=setTimeout(()=>{if(PDF.doc&&document.body.classList.contains('pdf-mode')&&Math.abs(pdfPixelDensity()-pdfRenderDensity)>.01)renderPDF(pdfZoomAnchor()).catch(e=>toast(e.message));},150);
}
function watchPDFDensity(){const query=window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);query.addEventListener('change',()=>{pdfDensityChanged();watchPDFDensity();},{once:true});}
watchPDFDensity();
window.addEventListener('resize',pdfDensityChanged);
window.visualViewport?.addEventListener('resize',pdfDensityChanged);
try {if(window.parent!==window)window.parent.visualViewport?.addEventListener('resize',pdfDensityChanged);} catch {}
window.addEventListener('pagehide',()=>{clearTimeout(pdfZoomTimer);clearTimeout(pdfDensityTimer);try{if(window.parent!==window)window.parent.visualViewport?.removeEventListener('resize',pdfDensityChanged);}catch{}});

// Page placeholders preserve document geometry; canvases exist only near the viewport.
const pdfLayouts=new WeakMap();
let pdfPageEntries=[],pdfScrollFrame=null;
async function pdfPageLayout(doc){
  if(!pdfLayouts.has(doc))pdfLayouts.set(doc,(async()=>{
    const sizes=[];
    for(let start=1;start<=doc.numPages;start+=12){
      const batch=await Promise.all(Array.from({length:Math.min(12,doc.numPages-start+1)},(_,i)=>doc.getPage(start+i)));
      for(const page of batch){const v=page.getViewport({scale:1});sizes.push({width:v.width,height:v.height});}
    }
    return sizes;
  })());
  return pdfLayouts.get(doc);
}
function sizePDFPageInput(input){input.style.width=`calc(${Math.max(1,input.value.length)}ch + 16px)`;}
function pdfPageBox(number){return pdfPageEntries.find(e=>e.number===number)?.box || null;}
function pdfSetCurrentPage(number){
  if(PDF.page===number)return;PDF.page=number;
  const input=$('#pdf-stage [data-page]');if(input&&document.activeElement!==input){input.value=number;sizePDFPageInput(input);}
  history.replaceState({},'','/#pdf='+enc(PDF.key)+'&page='+number);updateChatContext();
}
function pdfRenderWindow(metrics,top,bottom){
  if(!metrics.length)return [];
  const center=(top+bottom)/2;
  const distance=e=>e.bottom<top?top-e.bottom:e.top>bottom?e.top-bottom:0;
  const ordered=metrics.slice().sort((a,b)=>distance(a)-distance(b)||Math.abs((a.top+a.bottom)/2-center)-Math.abs((b.top+b.bottom)/2-center));
  const chosen=[];let pixels=0;
  for(const e of ordered){
    if(chosen.length>=5)break;
    if(distance(e)>Math.max(bottom-top,800)&&chosen.length)continue;
    if(chosen.length&&pixels+e.pixels>(distance(e)===0?64:48)*1024*1024)continue;
    chosen.push(e.number);pixels+=e.pixels;
  }
  return chosen;
}
function disposePDFPage(entry){
  entry.epoch++;entry.task?.cancel();entry.task=null;entry.text?.cancel();entry.text=null;
  const canvas=entry.box.querySelector('canvas');if(canvas)canvas.width=canvas.height=0;
  entry.objects=[];entry.box.classList.remove('over-pdf-object');entry.box.replaceChildren();entry.box.dataset.loaded='false';entry.loaded=false;entry.loading=null;
}
function updatePDFViewport(){
  pdfScrollFrame=null;
  const scroll=$('#pdf-stage .pdf-scroll');if(!scroll||!pdfPageEntries.length)return;
  const bounds=scroll.getBoundingClientRect();
  const metrics=pdfPageEntries.map(e=>{const b=e.box.getBoundingClientRect(),r=pdfRasterSize(e.viewport.width,e.viewport.height,pdfRenderDensity);return {number:e.number,top:b.top,bottom:b.bottom,pixels:r.width*r.height};});
  let current=metrics[0],overlap=-1;
  for(const e of metrics){const size=Math.max(0,Math.min(e.bottom,bounds.bottom)-Math.max(e.top,bounds.top));if(size>overlap){overlap=size;current=e;}}
  if(overlap>0)pdfSetCurrentPage(current.number);updatePDFOutlineSelection();
  const wanted=new Set(pdfRenderWindow(metrics,bounds.top,bounds.bottom));
  for(const e of pdfPageEntries){
    e.wanted=wanted.has(e.number)||e.drawing;
    if(!e.wanted&&(e.loaded||e.loading))disposePDFPage(e);
  }
  const ordered=[...wanted].map(n=>pdfPageEntries[n-1]);
  // Sequential page jobs avoid bursts of large canvas allocations during fast scrolling.
  const token=PDF.token;
  (async()=>{for(const e of ordered){if(token!==PDF.token)return;if(e.wanted)await ensurePDFPage(e);}})().catch(e=>toast(e.message));
}
function schedulePDFViewport(){if(pdfScrollFrame===null)pdfScrollFrame=requestAnimationFrame(updatePDFViewport);}
async function ensurePDFPage(entry){
  if(entry.loaded)return;if(entry.loading)return entry.loading;
  const epoch=entry.epoch,token=PDF.token,key=PDF.key,doc=PDF.doc;
  const active=()=>token===PDF.token&&entry.epoch===epoch&&entry.wanted;
  const work=(async()=>{
    const page=await doc.getPage(entry.number);if(!active())return;
    const box=entry.box,viewport=page.getViewport({scale:PDF.scale});entry.viewport=viewport;
    box.innerHTML='<canvas></canvas><div class="textLayer"></div><svg class="pdf-highlights" viewBox="0 0 1 1" preserveAspectRatio="none"></svg><svg class="pdf-text-selection" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"></svg><svg class="pdf-overlay" viewBox="0 0 1 1" preserveAspectRatio="none"></svg><div class="pdf-auto-labels"></div><div class="pdf-document-links"></div>';
    const canvas=box.querySelector('canvas'),raster=pdfRasterSize(viewport.width,viewport.height,pdfRenderDensity);
    canvas.width=raster.width;canvas.height=raster.height;canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
    const context=canvas.getContext('2d');context.noctuaTheme=PDF.dark?{background:'#202124',foreground:'#e8eaed',invertImages:false}:null;
    // Keep the page transparent so annotations sit behind its original text and graphics.
    entry.task=page.render({canvasContext:context,viewport,transform:raster.transform,background:'rgba(0,0,0,0)'});
    await entry.task.promise;if(!active())return;entry.task=null;
    entry.text=await textLayer(page,box.querySelector('.textLayer'),viewport);if(!active())return;
    entry.links=await pdfPageLinks(page,viewport).catch(()=>[]);if(!active())return;
    schedulePDFTextSelection();entry.loaded=true;box.dataset.loaded='true';paintPDFAnnotations();bindPDFPage(entry,key,token);renderPDFLinkTargets(entry);
    if(window.NoctuaPDFObjects)pdfjs().then(engine=>NoctuaPDFObjects.mount(entry,page,engine,active)).catch(()=>{});
  })().catch(error=>{if(error.name!=='RenderingCancelledException'&&error.name!=='AbortException'&&active()){entry.box.textContent='Could not render page '+entry.number+'. Use the page control to retry.';throw error;}})
    .finally(()=>{if(entry.epoch===epoch)entry.loading=null;});
  entry.loading=work;return work;
}
// Paint the native selection behind the PDF canvas, keeping its original glyphs opaque.
let pdfTextSelectionFrame=null;
function paintPDFTextSelection(){
  pdfTextSelectionFrame=null;
  const selection=getSelection(),range=selection?.rangeCount&&!selection.isCollapsed?selection.getRangeAt(0):null;
  for(const svg of document.querySelectorAll('#pdf-stage .pdf-text-selection')){
    const box=svg.parentElement,layer=box.querySelector('.textLayer');let markup='';
    if(range&&layer&&range.intersectsNode(layer)){
      const selected=range.cloneRange();
      if(!layer.contains(selected.startContainer))selected.setStart(layer,0);
      if(!layer.contains(selected.endContainer))selected.setEnd(layer,layer.childNodes.length);
      const bounds=box.getBoundingClientRect();
      if(bounds.width&&bounds.height){
        const rects=[...selected.getClientRects()].filter(rect=>rect.width>0&&rect.height>0&&rect.right>bounds.left&&rect.left<bounds.right&&rect.bottom>bounds.top&&rect.top<bounds.bottom).map(rect=>normalizedRect({left:Math.max(rect.left,bounds.left),top:Math.max(rect.top,bounds.top),width:Math.min(rect.right,bounds.right)-Math.max(rect.left,bounds.left),height:Math.min(rect.bottom,bounds.bottom)-Math.max(rect.top,bounds.top)},bounds));
        markup='<g fill="#5799ff" opacity="0.32">'+mergePDFHighlightRects(rects,bounds.height/bounds.width).map(([x,y,width,height])=>`<rect x="${x}" y="${y}" width="${width}" height="${height}"/>`).join('')+'</g>';
      }
    }
    if(svg.innerHTML!==markup)svg.innerHTML=markup;
  }
}
function schedulePDFTextSelection(){if(pdfTextSelectionFrame===null)pdfTextSelectionFrame=requestAnimationFrame(paintPDFTextSelection);}
document.addEventListener('selectionchange',schedulePDFTextSelection);
async function renderPDF(anchor=null){
  const token=++PDF.token,key=PDF.key;PDF.selection=null;closePDFLinkPreview();
  if(pdfScrollFrame!==null)cancelAnimationFrame(pdfScrollFrame);pdfScrollFrame=null;
  for(const entry of pdfPageEntries)disposePDFPage(entry);pdfPageEntries=[];
  $('#pdf-stage').innerHTML=`<div class="pdf-toolbar">
    <div class="pdf-document-heading">
      <span class="pdf-title" title="${esc(PDF.paper.title)}">${esc(PDF.paper.title)}</span>
      <div class="pdf-page-actions"><label class="pdf-page-position">Page <input data-page type="number" min="1" max="${PDF.doc.numPages}" value="${PDF.page}" aria-label="Page"> of ${PDF.doc.numPages}</label>${historyButtons('reader')}</div>
    </div>
    <div class="pdf-reader-tools">
      <div class="pdf-tool-group" role="group" aria-label="Zoom">
        <button data-zoom="-" title="Zoom out" data-icon="zoom-out" aria-label="Zoom out" data-icon-only></button>
        <span class="pdf-zoom-level" aria-label="PDF zoom">${Math.round(PDF.scale*100)}%</span>
        <button data-zoom="+" title="Zoom in" data-icon="zoom-in" aria-label="Zoom in" data-icon-only></button>
        <button data-fit title="Fit to width (follows the window and split view)" data-icon="move-horizontal" aria-label="Fit to width" aria-pressed="${PDF.fit}" data-icon-only></button>
      </div>
      <div class="pdf-tool-group" role="group" aria-label="Annotation tools">
        <button data-tool="select" title="Select text" data-icon="type" aria-label="Select text" aria-pressed="${PDF.mode==='select'}" data-icon-only></button>
        <button data-tool="draw" title="Draw" data-icon="pen-tool" aria-label="Draw" aria-pressed="${PDF.mode==='draw'}" data-icon-only></button>
        <span class="pdf-tool-divider" aria-hidden="true"></span>
        <button data-highlight title="Highlight selection" data-icon="highlighter" aria-label="Highlight selection" data-icon-only></button>
        <button data-comment title="Add comment" data-icon="message-square-plus" aria-label="Add comment" data-icon-only></button>
        <details class="pdf-color-menu">
          <summary title="Annotation color" aria-label="Annotation color"><span class="pdf-color-dot" style="--swatch:${PDF.color}" aria-hidden="true"></span></summary>
          <div class="pdf-color-options" role="group" aria-label="Annotation color">${pdfColors.map((c,i)=>`<button data-color="${c}" style="--swatch:${c}" title="${`Color ${i+1} · ${c}`}" aria-label="${`Color ${i+1} · ${c}`}" aria-pressed="${PDF.color===c}"></button>`).join('')}</div>
        </details>
      </div>
      <button class="pdf-standalone-tool" data-auto-highlight title="Auto-highlight paper" data-icon="sparkles" aria-label="Auto-highlight paper" data-icon-only></button>
      <button class="pdf-standalone-tool" data-split title="${document.body.classList.contains('split-view')?'Close':'Open'} notes beside the paper" data-icon="columns-2" aria-label="${document.body.classList.contains('split-view')?'Close':'Open'} notes beside the paper" aria-pressed="${document.body.classList.contains('split-view')}" data-icon-only></button>
      <details class="pdf-more-menu">
        <summary title="More document actions" aria-label="More document actions"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg></summary>
        <div class="pdf-more-options">
          <button data-new-note data-icon="file-plus">New note beside the paper</button>
          <button data-dark data-icon="${PDF.dark?'sun':'moon'}">${PDF.dark?'Light':'Dark'} pages</button>
          <button data-tab data-icon="external-link">Open in new tab</button>
          <button data-window data-icon="app-window">Open in new window</button>
        </div>
      </details>
    </div>
  </div><div class="pdf-scroll" tabindex="0" aria-label="PDF pages"><div class="pdf-document"></div></div>`;
  renderSplitPaperBar().catch(()=>{});
  const stage=$('#pdf-stage'),on=(s,fn)=>stage.querySelector(s).onclick=()=>Promise.resolve().then(fn).catch(e=>toast(e.message));
  const pageInput=stage.querySelector('[data-page]');sizePDFPageInput(pageInput);
  pageInput.oninput=()=>sizePDFPageInput(pageInput);pageInput.onchange=e=>pdfNavigate(+e.target.value);
  on('[data-new-note]',()=>{stage.querySelector('.pdf-more-menu').open=false;return createNoteIn(N.target,{beside:true});});
  on('[data-zoom="-"]',()=>zoomPDF(PDF.scale/1.2));on('[data-zoom="+"]',()=>zoomPDF(PDF.scale*1.2));on('[data-fit]',()=>setPDFFit(!PDF.fit));
  on('[data-auto-highlight]',autoHighlightPDF);on('[data-split]',()=>setSplitView(!document.body.classList.contains('split-view')));updatePDFAutoHighlightUI();
  on('[data-highlight]',()=>addPDFAnnotation('highlight'));on('[data-comment]',()=>addPDFAnnotation(PDF.selection?'highlight':'comment'));
  const closeMenus=()=>stage.querySelectorAll('.pdf-toolbar details[open]').forEach(menu=>menu.open=false);
  on('[data-dark]',()=>{closeMenus();return setPDFPageTheme(PDF.dark?'light':'dark');});
  on('[data-tab]',()=>{closeMenus();return openPaperView(key,'tab',{page:PDF.page});});
  on('[data-window]',()=>{closeMenus();return openPaperView(key,'window',{page:PDF.page});});
  stage.querySelectorAll('[data-color]').forEach(button=>button.onclick=()=>{
    PDF.color=button.dataset.color;
    stage.querySelector('.pdf-color-dot').style.setProperty('--swatch',PDF.color);
    stage.querySelectorAll('[data-color]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.color===PDF.color));
    closeMenus();stage.querySelector('.pdf-color-menu summary').focus();
  });
  stage.querySelectorAll('[data-tool]').forEach(button=>button.onclick=()=>{
    PDF.mode=button.dataset.tool;
    stage.querySelectorAll('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.tool===PDF.mode));
    pdfPageEntries.forEach(e=>e.box.classList.toggle('drawing',PDF.mode==='draw'));closePDFLinkPreview();
  });
  stage.querySelectorAll('.pdf-toolbar details').forEach(menu=>{
    menu.addEventListener('toggle',()=>{if(menu.open)stage.querySelectorAll('.pdf-toolbar details[open]').forEach(other=>{if(other!==menu)other.open=false;});});
    menu.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.open=false;menu.querySelector('summary').focus();}});
  });
  const doc=PDF.doc,sizes=await pdfPageLayout(doc);if(token!==PDF.token)return;
  if(PDF.fit){const fit=pdfFitScale(sizes);if(fit){PDF.scale=fit;const level=stage.querySelector('.pdf-zoom-level');if(level)level.textContent=Math.round(fit*100)+'%';}}
  const scale=PDF.scale;
  pdfRenderDensity=pdfPixelDensity();
  const container=stage.querySelector('.pdf-document');
  pdfPageEntries=sizes.map((size,i)=>{
    const box=document.createElement('div');box.className='pdf-page';box.dataset.page=i+1;box.dataset.loaded='false';box.setAttribute('aria-label','Page '+(i+1));
    box.style.width=size.width*scale+'px';box.style.height=size.height*scale+'px';box.classList.toggle('dark',PDF.dark);box.classList.toggle('drawing',PDF.mode==='draw');container.append(box);
    return {number:i+1,box,viewport:{width:size.width*scale,height:size.height*scale},epoch:0,loaded:false,loading:null,wanted:false,links:[]};
  });
  const scroll=stage.querySelector('.pdf-scroll');
  scroll.addEventListener('scroll',()=>{schedulePDFViewport();closePDFLinkPreview();},{passive:true});
  if(anchor)restorePDFZoomAnchor(anchor);else scrollPDFPage(PDF.page);
  // Replace lightweight dimensions with actual PDF.js viewports only when rendered.
  updatePDFViewport();await ensurePDFPage(pdfPageEntries[PDF.page-1]);
}
function scrollPDFPage(number,y=0){
  const scroll=$('#pdf-stage .pdf-scroll'),box=pdfPageBox(number);if(!scroll||!box)return;
  const outer=scroll.getBoundingClientRect(),b=box.getBoundingClientRect();scroll.scrollTop+=b.top-outer.top+y*b.height-20;
}
async function pdfNavigate(page,y=0){
  const number=Math.max(1,Math.min(PDF.doc.numPages,Math.floor(Number(page)||1)));
  closePDFLinkPreview();PDF.page=number;history.replaceState({},'','/#pdf='+enc(PDF.key)+'&page='+number);
  const input=$('#pdf-stage [data-page]');if(input){input.value=number;sizePDFPageInput(input);}
  if(!pdfPageEntries.length){await renderPDF();return;}
  scrollPDFPage(number,y);updatePDFViewport();
  const entry=pdfPageEntries[number-1];entry.wanted=true;await ensurePDFPage(entry);updateChatContext();
}
function bindPDFPage(entry,key,token){
  const box=entry.box,pageNumber=entry.number;
  box.onpointerdown=event=>{entry.objectPointerStart={x:event.clientX,y:event.clientY};window.NoctuaPDFObjects?.clear(entry);};
  box.onpointerup=event=>{
    if(PDF.mode==='draw'||event.button!==undefined&&event.button!==0||event.target.closest?.('.pdf-auto-labels,.pdf-document-link'))return;
    const clickedSelection=getSelection(),clickedBounds=box.getBoundingClientRect();
    if((event.button===undefined||event.button===0)&&(!clickedSelection.rangeCount||clickedSelection.isCollapsed)){
      const x=(event.clientX-clickedBounds.left)/clickedBounds.width,y=(event.clientY-clickedBounds.top)/clickedBounds.height;
      const link=entry.links.find(link=>pdfPointInRect(x,y,link.rect));
      if(link){followPDFLink(link).catch(error=>toast(error.message));return;}
      const object=window.NoctuaPDFObjects?.hit(entry,x,y),start=entry.objectPointerStart;
      if(object&&start&&Math.hypot(event.clientX-start.x,event.clientY-start.y)<=5&&NoctuaPDFObjects.attach(entry,object)){event.noctuaObjectSelection=true;return;}
    }
    setTimeout(()=>{
      if(token!==PDF.token)return;
      const selection=getSelection(),bounds=box.getBoundingClientRect(),x=(event.clientX-bounds.left)/bounds.width,y=(event.clientY-bounds.top)/bounds.height;
      if(!selection.rangeCount||selection.isCollapsed){
        const link=entry.links.find(a=>pdfPointInRect(x,y,a.rect));
        if(link){followPDFLink(link).catch(e=>toast(e.message));return;}
        const hit=[...PDF.annotations].reverse().find(a=>a.page===pageNumber&&mergePDFHighlightRects(a.rects||[],bounds.height/bounds.width).some(r=>pdfPointInRect(x,y,r)));
        if(hit)selectPDFAnnotation(hit.id,{scrollComment:true}).catch(e=>toast(e.message));return;
      }
      const range=selection.getRangeAt(0);if(!box.contains(range.commonAncestorContainer)){PDF.selection=null;toast('For a saved highlight, select text within one page at a time.');return;}
      PDF.selection={page:pageNumber,quote:selection.toString(),rects:[...range.getClientRects()].map(r=>normalizedRect(r,bounds)).filter(r=>r[2]>0&&r[3]>0)};updateChatContext();
    },0);
  };
  box.onpointermove=event=>{
    if(PDF.mode==='draw'||event.buttons){window.NoctuaPDFObjects?.clear(entry);return;}
    const b=box.getBoundingClientRect(),x=(event.clientX-b.left)/b.width,y=(event.clientY-b.top)/b.height;
    const link=entry.links.find(a=>pdfPointInRect(x,y,a.rect));box.classList.toggle('over-pdf-link',!!link);
    if(link){window.NoctuaPDFObjects?.clear(entry);schedulePDFLinkPreview(link,event.clientX,event.clientY);}else{schedulePDFLinkClose();window.NoctuaPDFObjects?.hover(entry,x,y);}
  };
  box.onpointerleave=()=>{schedulePDFLinkClose();window.NoctuaPDFObjects?.clear(entry);};
  const svg=box.querySelector('.pdf-overlay');let points=null;
  const point=e=>{const b=svg.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))];};
  svg.onpointerdown=e=>{if(PDF.mode!=='draw')return;e.preventDefault();entry.drawing=true;svg.setPointerCapture(e.pointerId);points=[point(e)];};
  svg.onpointermove=e=>{if(!points)return;points.push(point(e));paintPDFAnnotations();svg.insertAdjacentHTML('beforeend',inkSVG({points,color:PDF.color,width:.003}));};
  svg.onpointerup=async()=>{const drawn=points;points=null;entry.drawing=false;if(!drawn||drawn.length<2)return;try{await pdfSave(api(paperURL(key)+'/annotations',{kind:'ink',page:pageNumber,color:PDF.color,points:drawn,width:.003}));await refreshPDFAnnotations();}catch(e){toast(e.message);}};
  svg.onpointercancel=()=>{points=null;entry.drawing=false;paintPDFAnnotations();};
}
function pdfPointInRect(x,y,r){return x>=r[0]&&x<=r[0]+r[2]&&y>=r[1]&&y<=r[1]+r[3];}
function pdfRectsOverlap(a,b){return a[0]<b[0]+b[2]&&a[0]+a[2]>b[0]&&a[1]<b[1]+b[3]&&a[1]+a[3]>b[1];}
function safePDFLinkURL(value){try{const url=new URL(value);return ['http:','https:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}}
function openPDFExternalLink(value){
  const url=safePDFLinkURL(value);if(!url){toast('This link type cannot be opened from Noctua.');return;}
  closePDFLinkPreview();
  if(typeof settings!=='undefined'&&settings?.desktop)api('/api/desktop/open',{url}).catch(error=>toast(error.message));
  else window.open(url,'_blank','noopener,noreferrer');
}
async function followPDFLink(link){
  if(link.url){openPDFExternalLink(link.url);return;}
  const key=PDF.key,doc=PDF.doc;closePDFLinkPreview();
  const target=await resolvePDFDestination(doc,link);
  if(PDF.key===key&&PDF.doc===doc)await pdfNavigate(target.page,target.y);
}
async function pdfPageLinks(page,viewport){
  const annotations=await page.getAnnotations({intent:'display'});
  return annotations.filter(a=>a.subtype==='Link'&&a.rect&&(a.url||a.unsafeUrl||a.dest||a.action)).map(a=>{
    const [x1,y1,x2,y2]=viewport.convertToViewportRectangle(a.rect);
    const x=Math.max(0,Math.min(x1,x2)/viewport.width),y=Math.max(0,Math.min(y1,y2)/viewport.height);
    return {id:`${PDF.key}:${page.pageNumber}:${a.id}`,dest:a.dest,url:a.url||a.unsafeUrl,action:a.action,rect:[x,y,Math.max(0,Math.min(1-x,Math.abs(x2-x1)/viewport.width)),Math.max(0,Math.min(1-y,Math.abs(y2-y1)/viewport.height))],sourcePage:page.pageNumber};
  });
}
function renderPDFLinkTargets(entry){
  const layer=entry.box.querySelector('.pdf-document-links');
  layer.innerHTML=entry.links.map((link,i)=>`<button class="pdf-document-link" data-link="${i}" aria-label="${link.url?'Open external link in a new tab':'Go to reference or document passage'}" style="left:${link.rect[0]*100}%;top:${link.rect[1]*100}%;width:${link.rect[2]*100}%;height:${link.rect[3]*100}%"></button>`).join('');
  layer.querySelectorAll('button').forEach(button=>{
    button.onclick=event=>{event.preventDefault();const link=entry.links[+button.dataset.link];followPDFLink(link).catch(error=>toast(error.message));};
    button.onblur=schedulePDFLinkClose;
  });
}
async function resolvePDFDestination(doc,link){
  if(link.target)return link.target;
  if(link.action){const pages={NextPage:link.sourcePage+1,PrevPage:link.sourcePage-1,FirstPage:1,LastPage:doc.numPages};const number=pages[link.action];if(!number)throw Error('This PDF action is not supported.');return {page:Math.max(1,Math.min(doc.numPages,number)),x:0,y:0};}
  const dest=typeof link.dest==='string'?await doc.getDestination(link.dest):link.dest;
  if(!Array.isArray(dest)||!dest.length)throw Error('This PDF does not provide a usable destination for the link.');
  const index=Number.isInteger(dest[0])?dest[0]:await doc.getPageIndex(dest[0]);
  if(index<0||index>=doc.numPages)throw Error('The link points outside this PDF.');
  const page=await doc.getPage(index+1),viewport=page.getViewport({scale:1});
  let x=null,y=null;
  if(dest[1]?.name==='XYZ'){x=dest[2];y=dest[3];}
  else if(['FitH','FitBH'].includes(dest[1]?.name))y=dest[2];
  else if(dest[1]?.name==='FitR'){x=dest[2];y=dest[5];}
  const [left,top]=viewport.convertToViewportPoint(Number.isFinite(x)?x:page.view[0],Number.isFinite(y)?y:page.view[3]);
  return {page:index+1,x:Math.max(0,Math.min(1,left/viewport.width)),y:Math.max(0,Math.min(1,top/viewport.height))};
}
let pdfPreviewLink=null,pdfPreviewTask=null;
let pdfLinkTimer=null,pdfLinkCloseTimer=null,pdfLinkCurrent=null,pdfLinkPending=null,pdfLinkPinned=false,pdfLinkSerial=0;
function closePDFLinkPreview(){
  clearTimeout(pdfLinkTimer);clearTimeout(pdfLinkCloseTimer);pdfLinkCloseTimer=null;pdfLinkPending=null;pdfLinkCurrent=null;pdfLinkPinned=false;pdfLinkSerial++;
  pdfPreviewLink=null;pdfPreviewTask?.cancel();pdfPreviewTask=null;
  $('#pdf-link-preview')?.remove();
}
function schedulePDFLinkClose(){
  clearTimeout(pdfLinkTimer);pdfLinkPending=null;if(pdfLinkPinned||$('#pdf-link-preview')?.dataset.resizing)return;
  if(pdfLinkCloseTimer===null)pdfLinkCloseTimer=setTimeout(closePDFLinkPreview,250);
}
function schedulePDFLinkPreview(link,x,y){
  if(link.url){closePDFLinkPreview();return;}
  clearTimeout(pdfLinkCloseTimer);pdfLinkCloseTimer=null;
  if(pdfLinkCurrent===link.id||pdfLinkPending===link.id||pdfLinkPinned)return;
  clearTimeout(pdfLinkTimer);pdfLinkPending=link.id;
  pdfLinkTimer=setTimeout(()=>{pdfLinkPending=null;showPDFLinkPreview(link,x,y).catch(e=>toast(e.message));},300);
}
function pdfPreviewSizeKey(popup){return popup?.dataset.previewKind==='passage'?'noctua.pdfPreviewSize.passage.'+popup.dataset.previewLayout:'noctua.pdfPreviewSize.reference';}
function savedPDFPreviewSize(popup){
  try{const size=JSON.parse(store.get(pdfPreviewSizeKey(popup))||'null');if(Number.isFinite(size?.width)&&Number.isFinite(size?.height)&&size.width>0&&size.height>0)return size;}catch{}
  return null;
}
function applyPDFPreviewSize(popup,size){
  if(!Number.isFinite(size?.width)||!Number.isFinite(size?.height)||size.width<=0||size.height<=0)return;
  const width=Math.max(Math.min(260,innerWidth-24),Math.min(size.width,innerWidth-24));
  const height=Math.max(Math.min(120,innerHeight-24),Math.min(size.height,innerHeight-24));
  popup.classList.add('pdf-preview-sized');popup.style.width=width+'px';popup.style.height=height+'px';
}
function bindPDFPreviewResize(popup){
  const saved=savedPDFPreviewSize(popup);if(saved){applyPDFPreviewSize(popup,saved);popup.dataset.previewManual='true';}
  const grip=document.createElement('div');grip.className='pdf-preview-resize';grip.tabIndex=0;grip.setAttribute('role','separator');grip.setAttribute('aria-label','Resize preview');grip.title='Drag to resize preview; double-click to restore automatic size';popup.append(grip);
  let start=null;
  const save=()=>{if(!popup.isConnected)return;const rect=popup.getBoundingClientRect();popup.dataset.previewManual='true';store.set(pdfPreviewSizeKey(popup),JSON.stringify({width:rect.width,height:rect.height}));};
  const resize=(width,height)=>{
    const rect=popup.getBoundingClientRect();
    applyPDFPreviewSize(popup,{width:Math.min(width,innerWidth-rect.left-12),height:Math.min(height,innerHeight-rect.top-12)});
  };
  grip.onpointerdown=event=>{
    if(event.button!==0)return;event.preventDefault();event.stopPropagation();
    const rect=popup.getBoundingClientRect();start={x:event.clientX,y:event.clientY,width:rect.width,height:rect.height};
    popup.dataset.resizing='true';clearTimeout(pdfLinkCloseTimer);pdfLinkCloseTimer=null;grip.setPointerCapture(event.pointerId);
  };
  grip.onpointermove=event=>{if(!start)return;event.preventDefault();resize(start.width+event.clientX-start.x,start.height+event.clientY-start.y);};
  const finish=event=>{
    if(!start)return;start=null;delete popup.dataset.resizing;save();
    if(grip.hasPointerCapture(event.pointerId))grip.releasePointerCapture(event.pointerId);
    popup.noctuaRenderPreview?.();trackPDFReferencePreview(event);
  };
  grip.onpointerup=finish;grip.onpointercancel=finish;grip.onlostpointercapture=finish;
  const reset=()=>{
    store.remove(pdfPreviewSizeKey(popup));popup.dataset.previewManual='false';
    if(popup.pdfPreviewCrop){const size=pdfReferencePreviewSize(popup.pdfPreviewCrop,innerWidth,innerHeight);popup.dataset.previewAuto=JSON.stringify(size);applyPDFPreviewSize(popup,size);}
    else{popup.classList.remove('pdf-preview-sized');popup.style.width='';popup.style.height='';}
    const rect=popup.getBoundingClientRect();positionPDFPreview(popup,rect.left-12,rect.top-16);popup.noctuaRenderPreview?.();
  };
  grip.ondblclick=event=>{event.preventDefault();reset();};
  grip.onkeydown=event=>{
    if(event.key==='Home'){event.preventDefault();reset();return;}
    const dx={ArrowLeft:-20,ArrowRight:20}[event.key]||0,dy={ArrowUp:-20,ArrowDown:20}[event.key]||0;if(!dx&&!dy)return;
    event.preventDefault();const rect=popup.getBoundingClientRect();resize(rect.width+dx,rect.height+dy);save();popup.noctuaRenderPreview?.();
  };
}
function positionPDFPreview(popup,x,y){
  const gap=12,margin=12,width=popup.offsetWidth;
  const rightSpace=innerWidth-x-gap-margin,leftSpace=x-gap-margin;
  const onRight=rightSpace>=width || (leftSpace<width && rightSpace>=leftSpace);
  const left=onRight?x+gap:x-gap-width;
  popup.style.left=Math.max(margin,Math.min(left,innerWidth-width-margin))+'px';
  popup.style.top=Math.max(12,Math.min(y+16,innerHeight-popup.offsetHeight-12))+'px';
}
function pdfReferenceCrop(viewport,target,items,objects=[],destination=''){
  const {width:pw,height:ph}=viewport,texts=NoctuaPDFObjects.textRects(items,viewport),tx=target.x,ty=target.y;
  const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const fontHeight=median(texts.filter(t=>t.text.length>4&&t.rect[3]>.005&&t.rect[3]<.035).map(t=>t.rect[3]*ph))||10;
  let gutter=NoctuaPDFObjects.columnGutter(texts);
  if(gutter!==null&&texts.filter(t=>t.text.length>45&&t.rect[2]>.52&&t.rect[0]<gutter-.1&&t.rect[0]+t.rect[2]>gutter+.1&&t.rect[1]>ty-.22&&t.rect[1]<ty+.4).length>=3)gutter=null;
  const kind=typeof destination==='string'&&destination.match(/^(figure|table|algorithm|equation|section|subsection|subsubsection)[.:]/i)?.[1].toLowerCase();
  const bounds=(left,top,right,bottom,extra={})=>{
    const x=Math.max(0,left),y=Math.max(0,top);
    return {x,y,width:Math.max(1,Math.min(pw,right)-x),height:Math.max(1,Math.min(ph,bottom)-y),fontHeight,columns:gutter===null?1:2,kind:kind||'passage',...extra};
  };
  // Use the same detected objects (including their captions) as annotation hit boxes.
  if(!/^(?:equation|.*section)$/.test(kind||'')){
    const candidates=objects.map(object=>{
      const r=object.rect,dx=Math.max(0,r[0]-tx,tx-r[0]-r[2]),dy=Math.max(0,r[1]-ty,ty-r[1]-r[3]);
      return {object,dx,dy,distance:dy+dx*.25};
    }).filter(({distance,dx,dy})=>kind?distance<.045:dy<.008&&dx<.04).sort((a,b)=>a.distance-b.distance);
    const chosen=candidates.find(({object})=>object.kind===kind)||candidates[0];
    if(chosen){const {rect:r,kind:objectKind}=chosen.object;return bounds(r[0]*pw,r[1]*ph,(r[0]+r[2])*pw,(r[1]+r[3])*ph,{kind:objectKind,object:true});}
  }
  const lines=NoctuaPDFObjects.linesOf(texts,gutter).filter(line=>line.rect[3]<.08&&line.rect[1]>.025&&line.rect[1]+line.rect[3]<.97);
  const nearest=lines.slice().sort((a,b)=>(Math.abs(a.rect[1]-ty)+Math.abs(a.rect[0]-tx)*.12)-(Math.abs(b.rect[1]-ty)+Math.abs(b.rect[0]-tx)*.12))[0];
  if(!nearest)return bounds(pw*.06,Math.max(0,ty*ph-24),pw*.94,Math.min(ph,ty*ph+ph*.25));
  const side=gutter===null?null:nearest.rect[0]+nearest.rect[2]/2>=gutter?'right':'left';
  const lane=lines.filter(line=>side===null||side==='left'&&line.rect[0]+line.rect[2]<=gutter+.01||side==='right'&&line.rect[0]>=gutter-.01);
  const body=lane.filter(line=>line.text.length>20&&line.rect[2]>(gutter===null?.25:.14)&&line.fontHeight*ph<=fontHeight*1.4);
  const content=body.length?body:lane.length?lane:[nearest],pad=Math.max(6,fontHeight*.8);
  let left=Math.min(...content.map(line=>line.rect[0]))*pw-pad,right=Math.max(...content.map(line=>line.rect[0]+line.rect[2]))*pw+pad;
  if(side==='left')right=Math.min(right,gutter*pw-pad/2);if(side==='right')left=Math.max(left,gutter*pw+pad/2);
  let top=nearest.rect[1]*ph-fontHeight*.8,bottom=top+Math.max(fontHeight*10,(right-left)*.38);
  if(kind==='equation'){
    const paragraph=line=>{
      const words=line.text.match(/\b[a-zA-Z]{3,}\b/g)||[],letters=words.join('').length;
      return words.length>=3&&letters>=18||letters>10&&/^[a-zA-Z\s\d.:-]+$/.test(line.text);
    };
    const rows=lane.filter(line=>!paragraph(line)).sort((a,b)=>a.rect[1]-b.rect[1]);
    const equations=rows.filter(line=>/[=∑∫≤≥∈≔]/.test(line.text)||/^\(\d+(?:\.\d+)*[a-z]?\)$/.test(line.text.trim()));
    const anchor=equations.sort((a,b)=>(Math.abs(a.rect[1]-ty)+Math.abs(a.rect[0]-tx)*.06)-(Math.abs(b.rect[1]-ty)+Math.abs(b.rect[0]-tx)*.06)).find(line=>Math.abs(line.rect[1]-ty)<.08)||nearest;
    let lo=anchor.rect[1],hi=anchor.rect[1]+anchor.rect[3],changed=true;
    while(changed){changed=false;for(const line of rows){
      const r=line.rect,gap=Math.max(0,lo-r[1]-r[3],r[1]-hi);
      if(gap>fontHeight/ph*1.6||Math.max(hi,r[1]+r[3])-Math.min(lo,r[1])>.4)continue;
      if(lane.some(other=>paragraph(other)&&other.rect[1]<Math.max(hi,r[1]+r[3])-.002&&other.rect[1]+other.rect[3]>Math.min(lo,r[1])+.002))continue;
      if(r[1]<lo||r[1]+r[3]>hi){lo=Math.min(lo,r[1]);hi=Math.max(hi,r[1]+r[3]);changed=true;}
    }}
    top=lo*ph-pad;bottom=hi*ph+pad;
    const above=lane.filter(line=>paragraph(line)&&line.rect[1]+line.rect[3]<=lo),below=lane.filter(line=>paragraph(line)&&line.rect[1]>=hi);
    if(above.length)top=Math.max(top,Math.max(...above.map(line=>line.rect[1]+line.rect[3]))*ph+fontHeight*.25);
    if(below.length)bottom=Math.min(bottom,Math.min(...below.map(line=>line.rect[1]))*ph-fontHeight*.25);
  }
  return bounds(left,top,right,bottom);
}
function pdfReferencePreviewSize(crop,screenWidth,screenHeight){
  const maxWidth=Math.max(1,Math.min(960,screenWidth-24)),maxHeight=Math.max(1,Math.min(720,screenHeight-24));
  let scale=Math.min(16/(crop.fontHeight||10),Math.max(1,maxWidth-20)/crop.width);
  if(crop.object)scale=Math.min(scale,Math.max(1,maxHeight-70)/crop.height);
  const width=Math.min(maxWidth,Math.max(Math.min(280,maxWidth),crop.width*scale+20));
  return {width:Math.round(width),height:Math.round(Math.min(maxHeight,Math.max(Math.min(120,maxHeight),crop.height*(width-20)/crop.width+70)))};
}
function sizePDFReferencePreview(popup,crop){
  popup.pdfPreviewCrop=crop;popup.dataset.previewKind='passage';popup.dataset.previewLayout=`${crop.columns===2?'column':'page'}.${crop.kind}`;
  popup.dataset.previewAuto=JSON.stringify(pdfReferencePreviewSize(crop,innerWidth,innerHeight));
  const saved=savedPDFPreviewSize(popup);
  popup.dataset.previewManual=saved?'true':'false';applyPDFPreviewSize(popup,saved||JSON.parse(popup.dataset.previewAuto));
}
async function showPDFLinkPreview(link,x,y){
  if(link.url){closePDFLinkPreview();return;}
  if(pdfLinkCurrent===link.id)return;
  closePDFLinkPreview();pdfLinkCurrent=link.id;pdfPreviewLink=link;
  const serial=pdfLinkSerial,doc=PDF.doc,key=PDF.key;
  const popup=document.createElement('aside');popup.id='pdf-link-preview';popup.classList.add('pdf-reference-popover');popup.setAttribute('role','dialog');popup.setAttribute('aria-label','PDF link preview');
  popup.hidden=true;popup.innerHTML='<div class="pdf-preview-content"></div>';
  document.body.append(popup);bindPDFPreviewResize(popup);positionPDFPreview(popup,x,y);
  popup.onpointerenter=()=>{clearTimeout(pdfLinkCloseTimer);pdfLinkCloseTimer=null;};popup.onpointerleave=schedulePDFLinkClose;
  const body=popup.querySelector('.pdf-preview-content'),active=()=>serial===pdfLinkSerial&&key===PDF.key&&popup.isConnected;
  try{
    const index=await indexPDF(key);if(!active())return;
    const numbers=pdfLinkCitationNumbers(index,link);
    if(numbers.length){
      body.classList.add('pdf-citation-list');
      for(const number of numbers){
        const reference=findNumberedPDFReference(index,number),row=document.createElement('button');row.className='pdf-citation-row';
        const label=document.createElement('span');label.className='pdf-citation-number';label.textContent=`[${number}]`;
        const title=document.createElement('span');title.textContent=reference?.title||'Reference title unavailable';row.append(label,title);body.append(row);
        row.disabled=!reference;if(reference){row.title=reference.excerpt;row.onclick=()=>{closePDFLinkPreview();pdfNavigate(reference.page,reference.y).catch(error=>toast(error.message));};}
      }
    }else{
      const target=await resolvePDFDestination(doc,link);if(!active())return;
      const row=document.createElement('button');row.className='pdf-citation-row';row.textContent=`Page ${target.page}`;
      row.onclick=()=>{closePDFLinkPreview();pdfNavigate(target.page,target.y).catch(error=>toast(error.message));};body.append(row);
      if(pdfIsNamedCitation(link.dest)){
        const source=(index.pages||[]).find(page=>page.page===link.sourcePage);
        const links=source&&link.rect?(pdfPageEntries.find(entry=>entry.number===link.sourcePage)?.links||await pdfCitationPageLinks(doc,link.sourcePage)):[];if(!active())return;
        const names=pdfLinkCitationNames(index,link,links);
        const entries=await Promise.all(names.map(async name=>{
          const reference=await pdfNamedCitationReference(index,doc,name);let destination=reference;
          if(!destination){try{destination=name===link.dest?target:await resolvePDFDestination(doc,{dest:name});}catch{}}
          return {reference,destination};
        }));if(!active())return;
        body.classList.add('pdf-citation-list');body.replaceChildren();
        for(const {reference,destination} of entries){
          const entry=document.createElement('button');entry.className='pdf-citation-row';entry.textContent=reference?.title||'Reference title unavailable';entry.title=reference?.excerpt||'';entry.disabled=!destination;
          if(destination)entry.onclick=()=>{closePDFLinkPreview();pdfNavigate(destination.page,destination.y).catch(error=>toast(error.message));};
          body.append(entry);
        }
      }else{
        const page=await doc.getPage(target.page);if(!active())return;
        const viewport=page.getViewport({scale:1}),text=await page.getTextContent();if(!active())return;
        const mounted=pdfPageEntries.find(entry=>entry.number===target.page&&entry.loaded&&entry.objects);
        const objects=mounted?.objects||await NoctuaPDFObjects.regions(page,await pdfjs(),text.items);if(!active())return;
        const crop=pdfReferenceCrop(viewport,target,text.items,objects,link.dest),canvas=document.createElement('canvas');
        canvas.className='pdf-reference-preview';canvas.setAttribute('aria-label',`Preview of page ${target.page}`);body.append(canvas);
        sizePDFReferencePreview(popup,crop);popup.hidden=false;positionPDFPreview(popup,x,y);
        let revision=0;
        const render=async()=>{
          if(!active())return;const current=++revision,previous=pdfPreviewTask;
          previous?.cancel();if(previous)await previous.promise.catch(()=>{});if(!active()||revision!==current)return;
          const width=body.clientWidth||crop.width,raster=pdfRasterSize(width,width*crop.height/crop.width,pdfPixelDensity());
          canvas.width=raster.width;canvas.height=raster.height;
          const sx=raster.width/crop.width,sy=raster.height/crop.height,context=canvas.getContext('2d',{alpha:false});
          context.noctuaTheme=PDF.dark?{background:'#202124',foreground:'#e8eaed',invertImages:false}:null;
          const task=page.render({canvasContext:context,viewport,transform:[sx,0,0,sy,-crop.x*sx,-crop.y*sy]});pdfPreviewTask=task;
          try{await task.promise;}catch(error){if(error.name!=='RenderingCancelledException')throw error;}finally{if(pdfPreviewTask===task)pdfPreviewTask=null;}
        };
        popup.noctuaRenderPreview=()=>render().catch(error=>{if(active())toast(error.message);});await render();
      }
    }
    if(active()){popup.hidden=false;positionPDFPreview(popup,x,y);}
  }catch(e){if(active())closePDFLinkPreview();}
}
function trackPDFReferencePreview(event){
  const link=pdfPreviewLink;if(!link||pdfLinkPending&&pdfLinkPending!==pdfLinkCurrent)return;
  const popup=$('#pdf-link-preview'),box=pdfPageBox(link.sourcePage),margin=24;
  if(popup?.dataset.resizing){clearTimeout(pdfLinkCloseTimer);pdfLinkCloseTimer=null;return;}
  const within=r=>event.clientX>=r.left-margin&&event.clientX<=r.right+margin&&event.clientY>=r.top-margin&&event.clientY<=r.bottom+margin;
  let onLink=false;
  if(box&&link.rect){const r=box.getBoundingClientRect();onLink=within({left:r.left+link.rect[0]*r.width,right:r.left+(link.rect[0]+link.rect[2])*r.width,top:r.top+link.rect[1]*r.height,bottom:r.top+(link.rect[1]+link.rect[3])*r.height});}
  if(onLink||(popup&&!popup.hidden&&within(popup.getBoundingClientRect()))){clearTimeout(pdfLinkCloseTimer);pdfLinkCloseTimer=null;}
  else if(pdfLinkCloseTimer===null)pdfLinkCloseTimer=setTimeout(closePDFLinkPreview,250);
}
document.addEventListener('pointermove',trackPDFReferencePreview);
window.addEventListener('resize',()=>{
  const popup=$('#pdf-link-preview');if(!popup||popup.hidden)return;
  const rect=popup.getBoundingClientRect();if(popup.pdfPreviewCrop&&popup.dataset.previewManual!=='true')applyPDFPreviewSize(popup,pdfReferencePreviewSize(popup.pdfPreviewCrop,innerWidth,innerHeight));else if(popup.classList.contains('pdf-preview-sized'))applyPDFPreviewSize(popup,{width:rect.width,height:rect.height});
  popup.noctuaRenderPreview?.();
  popup.style.left=Math.max(12,Math.min(rect.left,innerWidth-popup.offsetWidth-12))+'px';popup.style.top=Math.max(12,Math.min(rect.top,innerHeight-popup.offsetHeight-12))+'px';
});

function findNumberedPDFReference(index,number){return pdfBibliography(index).get(number)||null;}
const pdfBibliographies=new WeakMap();
function pdfBibliography(index){
  if(pdfBibliographies.has(index))return pdfBibliographies.get(index);
  const references=new Map(),pages=index.pages||[];let started=false,current=null,bracketStyle=null;
  const finish=()=>{if(current){current.excerpt=current.text.trim();current.title=pdfReferenceTitle(current.excerpt);references.set(current.number,current);}};
  for(const page of pages){
    const text=page.text||'';let offset=0;
    if(!started){const heading=/(?:^|\n)\s*(?:\d+\.?\s+)?(?:references|bibliography)\s*(?:\n|$)/i.exec(text);if(!heading)continue;started=true;offset=heading.index+heading[0].length;}
    const tail=text.slice(offset),appendix=/^\s*(?:appendix|appendices)\b/im.exec(tail),content=appendix?tail.slice(0,appendix.index):tail;
    let markers=[...content.matchAll(/(?:^|\n)\s*(?:\[(\d{1,4})\]|(\d{1,4})\.)\s+/g)];
    if(bracketStyle===null&&markers.length)bracketStyle=!!markers[0][1];markers=markers.filter(marker=>!!marker[1]===bracketStyle);
    if(!markers.length){if(current&&!/^\s*(?:appendix|appendices|[A-Z]\s+[A-Z])/m.test(content))current.text+='\n'+content;else if(current)break;continue;}
    if(current)current.text+='\n'+content.slice(0,markers[0].index);
    for(let i=0;i<markers.length;i++){
      finish();const marker=markers[i],start=offset+marker.index+marker[0].length,end=i+1<markers.length?offset+markers[i+1].index:offset+content.length;
      const word=(page.words||[]).find(word=>word.end>start);
      current={number:Number(marker[1]||marker[2]),page:page.page,x:word?.rect[0]||0,y:word?.rect[1]||0,text:text.slice(start,end)};
    }
    if(appendix)break;
  }
  finish();pdfBibliographies.set(index,references);return references;
}
function pdfReferenceTitle(raw){
  const text=raw.replace(/-\s*\n\s*/g,'-').replace(/\s+/g,' ').trim();
  const quoted=/[“"]([^”"]{8,})[”"]/.exec(text);if(quoted)return quoted[1].trim().replace(/,\s*$/,'').trimEnd();
  const boundaries=[...text.matchAll(/\.\s+/g)].filter(match=>!/(?:\b[A-Z]|\b(?:Dr|Prof|Jr|Sr|St))$/.test(text.slice(0,match.index)));
  if(!boundaries.length)return text.replace(/,?\s*(?:19|20)\d{2}[a-z]?\.?$/,'').trim().replace(/,\s*$/,'').trimEnd();
  const start=boundaries[0].index+boundaries[0][0].length;
  const end=boundaries[1]?.index??text.length;
  return text.slice(start,end).replace(/,?\s*(?:19|20)\d{2}[a-z]?(?:[.,].*)?$/,'').trim().replace(/,\s*$/,'').trimEnd()||'Reference title unavailable';
}
function pdfIsNamedCitation(destination){return typeof destination==='string'&&/^(?:cite|citation|bibitem)[.:].+/i.test(destination);}
const pdfNamedBibliographies=new WeakMap();
async function pdfNamedCitationReference(index,doc,name){
  let cached=pdfNamedBibliographies.get(doc);
  if(cached?.index!==index){
    const work=(async()=>{
      const destinations=await doc.getDestinations();
      const anchors=await Promise.all(Object.entries(destinations).filter(([name])=>pdfIsNamedCitation(name)).map(async([name,dest])=>{
        try{return {name,...await resolvePDFDestination(doc,{dest})};}catch{return null;}
      }));
      return pdfCitationReferences(index,anchors.filter(Boolean));
    })();
    cached={index,work};pdfNamedBibliographies.set(doc,cached);
    work.catch(()=>{if(pdfNamedBibliographies.get(doc)===cached)pdfNamedBibliographies.delete(doc);});
  }
  try{return (await cached.work).get(name)||null;}catch{return null;}
}
function pdfCitationReferences(index,anchors){
  const pages=index.pages||[],byPage=new Map(pages.map(page=>[page.page,page]));
  const entries=anchors.flatMap(anchor=>{
    const page=byPage.get(anchor.page);if(!page)return [];
    // Citation destinations point just above the first line of their bibliography entry.
    const score=word=>Math.abs(word.rect[1]-anchor.y)+Math.abs(word.rect[0]-anchor.x)*.15;
    const word=(page.words||[]).reduce((best,word)=>!best||score(word)<score(best)?word:best,null);
    return word?[{...anchor,offset:word.start}]:[];
  }).sort((a,b)=>a.page-b.page||a.offset-b.offset);
  const references=new Map();
  for(let i=0;i<entries.length;i++){
    const entry=entries[i],next=entries.slice(i+1).find(next=>next.page!==entry.page||next.offset>entry.offset);
    const excerpt=pages.filter(page=>page.page>=entry.page&&page.page<=(next?.page||entry.page)).map(page=>{
      const start=page.page===entry.page?entry.offset:0,end=page.page===next?.page?next.offset:undefined;
      return (page.text||'').slice(start,end);
    }).join('\n').split(/\(\s*Cited on pages?\b/i)[0].trim().slice(0,6000);
    references.set(entry.name,{...entry,excerpt,title:excerpt?pdfReferenceTitle(excerpt):'Reference title unavailable'});
  }
  return references;
}
const pdfCitationSourcePages=new WeakMap();
async function pdfCitationPageLinks(doc,number){
  let pages=pdfCitationSourcePages.get(doc);if(!pages){pages=new Map();pdfCitationSourcePages.set(doc,pages);}
  if(!pages.has(number)){
    const work=(async()=>{const page=await doc.getPage(number);return pdfPageLinks(page,page.getViewport({scale:1}));})();
    pages.set(number,work);work.catch(()=>{if(pages.get(number)===work)pages.delete(number);});
  }
  return pages.get(number);
}
function pdfLinkCitationNames(index,link,links){
  if(!pdfIsNamedCitation(link.dest))return [];
  const fallback=[link.dest],page=(index.pages||[]).find(page=>page.page===link.sourcePage);
  if(!page||!link.rect)return fallback;
  const overlaps=(word,rect)=>{
    const r=word.rect,w=Math.min(r[0]+r[2],rect[0]+rect[2])-Math.max(r[0],rect[0]),h=Math.min(r[1]+r[3],rect[1]+rect[3])-Math.max(r[1],rect[1]);
    return w>=Math.min(r[2],rect[2])*.15&&h>=Math.min(r[3],rect[3])*.45;
  };
  const words=page.words||[],hovered=words.filter(word=>overlaps(word,link.rect)),ranges=[],stack=[];
  for(let i=0;i<(page.text||'').length;i++){
    if(page.text[i]==='(')stack.push(i);
    else if(page.text[i]===')'&&stack.length){const start=stack.pop();if(hovered.some(word=>word.start<i&&word.end>start))ranges.push({start,end:i+1});}
  }
  ranges.sort((a,b)=>(a.end-a.start)-(b.end-b.start));
  for(const range of ranges){
    const matches=links.filter(candidate=>candidate.sourcePage===link.sourcePage&&candidate.rect&&pdfIsNamedCitation(candidate.dest)).map(candidate=>{
      const inside=words.filter(word=>word.start<range.end&&word.end>range.start&&overlaps(word,candidate.rect));
      return {name:candidate.dest,start:inside.length?Math.min(...inside.map(word=>word.start)):Infinity};
    }).filter(match=>Number.isFinite(match.start)).sort((a,b)=>a.start-b.start);
    const names=[...new Set(matches.map(match=>match.name))];
    if(names.length>1&&names.includes(link.dest))return names;
  }
  return fallback;
}
function pdfCitationNumbers(value){
  const match=value.trim().match(/^\[\s*(\d[\d\s,;–—-]*)\s*\]$/);if(!match)return [];
  const numbers=new Set();
  for(const part of match[1].split(/[,;]/)){
    const range=part.trim().match(/^(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?$/);if(!range)return [];
    const first=Number(range[1]),last=Number(range[2]||range[1]);if(first<1||last<first||last-first>100)return [];
    for(let number=first;number<=last;number++)numbers.add(number);
  }
  return [...numbers].sort((a,b)=>a-b);
}
function pdfLinkCitationNumbers(index,link){
  if(link.citationNumbers)return [...new Set(link.citationNumbers)].sort((a,b)=>a-b);
  const page=(index.pages||[]).find(page=>page.page===link.sourcePage);
  if(page&&link.rect){
    const words=(page.words||[]).filter(word=>pdfRectsOverlap(word.rect,link.rect));
    for(const match of (page.text||'').matchAll(/\[\s*\d[\d\s,;–—-]*\]/g)){
      if(words.some(word=>word.start<match.index+match[0].length&&word.end>match.index))return pdfCitationNumbers(match[0]);
    }
  }
  const named=typeof link.dest==='string'&&link.dest.match(/^(?:cite|citation)[.:](\d+)$/i);return named?[Number(named[1])]:[];
}
function inkSVG(a){return (a.paths||[a.points||[]]).map(points=>`<polyline points="${points.map(p=>p[0]+','+p[1]).join(' ')}" fill="none" stroke="${esc(a.color)}" stroke-width="${a.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');}
function clearPDFAnnotationSelection(){
  if(!PDF.selected)return;PDF.selected=null;syncPDFAnnotationSelection();paintPDFAnnotations();updateChatContext();
}
function pdfOutsideComment(event){
  if(!event.target.closest?.('#pdf-sidebar article'))clearPDFAnnotationSelection();
  if(!event.target.closest?.('#pdf-link-preview'))closePDFLinkPreview();
}
document.addEventListener('pointerdown',pdfOutsideComment,true);
document.addEventListener('pointerdown',event=>{document.querySelectorAll('.pdf-toolbar details[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
document.addEventListener('focusin',event=>{if(!event.target.closest?.('#pdf-sidebar article'))clearPDFAnnotationSelection();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){clearPDFAnnotationSelection();closePDFLinkPreview();}});
function syncPDFAnnotationSelection(){
  document.querySelectorAll('#pdf-sidebar article').forEach(el=>{
    const selected=el.dataset.id===PDF.selected;
    el.classList.toggle('selected',selected);
    el.setAttribute('aria-current',String(selected));
  });
}
function pdfAnnotationMatchesFilter(annotation,filter){
  if(!filter)return true;
  return filter==='user'?annotation.author==='user':annotation.author==='assistant'&&annotation.category===filter;
}
async function selectPDFAnnotation(id,{scrollComment=false}={}){
  const a=PDF.annotations.find(a=>a.id===id);if(!a)return;
  if(!pdfAnnotationMatchesFilter(a,PDF.annotationFilter))setPDFAnnotationFilter(null);
  setPDFSidebarTab('annotations');PDF.selected=id;syncPDFAnnotationSelection();
  if(PDF.page!==a.page)await pdfNavigate(a.page);else {const entry=pdfPageEntries.find(e=>e.number===a.page);if(entry){entry.wanted=true;await ensurePDFPage(entry);}}
  paintPDFAnnotations();
  const mark=$('#pdf-stage .pdf-mark.selected');
  mark?.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'});
  if(scrollComment)document.querySelectorAll('#pdf-sidebar article').forEach(el=>{if(el.dataset.id===id)el.scrollIntoView({block:'nearest',behavior:'smooth'});});
  updateChatContext();
}
const pdfHighlightGeometry=new WeakMap();
function mergePDFHighlightRects(rects,aspect=1){
  const cached=pdfHighlightGeometry.get(rects);if(cached?.aspect===aspect)return cached.rects;
  const rows=[];
  const sorted=rects.filter(r=>r.length===4&&r.every(Number.isFinite)&&r[2]>0&&r[3]>0).map(r=>r.slice()).sort((a,b)=>a[1]+a[3]/2-b[1]-b[3]/2||a[0]-b[0]);
  for(const rect of sorted){
    const row=rows.find(({reference:r})=>Math.min(r[1]+r[3],rect[1]+rect[3])-Math.max(r[1],rect[1])>=Math.min(r[3],rect[3])*.5&&Math.abs(r[1]+r[3]/2-rect[1]-rect[3]/2)<=Math.max(r[3],rect[3])*.5);
    if(row){row.rects.push(rect);if(rect[3]>row.reference[3])row.reference=rect;}
    else rows.push({reference:rect,rects:[rect]});
  }
  const result=[];
  for(const row of rows){
    let previous=null;
    for(const rect of row.rects.sort((a,b)=>a[0]-b[0])){
      // Measure word gaps in page pixels; normalized x/y have different scales.
      const gap=rect[0]-(previous?previous[0]+previous[2]:0);
      if(previous&&gap<=row.reference[3]*aspect*.6){
        const right=Math.max(previous[0]+previous[2],rect[0]+rect[2]),bottom=Math.max(previous[1]+previous[3],rect[1]+rect[3]);
        previous[0]=Math.min(previous[0],rect[0]);previous[1]=Math.min(previous[1],rect[1]);previous[2]=right-previous[0];previous[3]=bottom-previous[1];
      }else{previous=rect.slice();result.push(previous);}
    }
  }
  result.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
  pdfHighlightGeometry.set(rects,{aspect,rects:result});return result;
}
function paintPDFAutoLabels(box){
  const layer=box.querySelector('.pdf-auto-labels');if(!layer)return;
  const marks=PDF.annotations.filter(a=>a.page===Number(box.dataset.page)&&a.kind==='highlight'&&pdfCategories[a.category]&&a.rects?.length).sort((a,b)=>a.rects[0][1]-b.rects[0][1]);
  const last={left:-24,right:-24},height=box.clientHeight,width=box.clientWidth;
  const markup=marks.map(a=>{
    const r=a.rects[0],side=r[0]+r[2]/2<.5?'left':'right',gutter=side==='left'?r[0]:1-r[0]-r[2];
    const top=Math.min(Math.max(0,height-22),Math.max(r[1]*height,last[side]+22));last[side]=top;
    const maxWidth=Math.max(16,Math.min(88,gutter*width-8)),compact=maxWidth<48,category=pdfCategories[a.category];
    return `<button class="pdf-auto-tag${compact?' compact':''}${a.id===PDF.selected?' selected':''}" data-annotation="${esc(a.id)}" style="--category-color:${esc(a.color)};top:${top}px;${side}:4px;max-width:${maxWidth}px" aria-label="${category.label}, page ${a.page}" title="${category.label}: ${esc(a.quote)}">${compact?'●':category.label}</button>`;
  }).join('');
  if(layer.noctuaMarkup===markup)return;layer.noctuaMarkup=markup;layer.innerHTML=markup;
  layer.querySelectorAll('button').forEach(button=>button.onclick=()=>selectPDFAnnotation(button.dataset.annotation,{scrollComment:true}).catch(e=>toast(e.message)));
}
function paintPDFAnnotations(){
  for(const svg of document.querySelectorAll('#pdf-stage .pdf-overlay, #pdf-stage .pdf-highlights')){
    const box=svg.closest('.pdf-page'),aspect=box.clientWidth?box.clientHeight/box.clientWidth:1;
    const page=Number(box.dataset.page),highlights=svg.classList.contains('pdf-highlights');
    const annotations=PDF.annotations.filter(a=>a.page===page&&(a.kind!=='ink')===highlights);
    if(!highlights){
      svg.innerHTML=annotations.map(a=>`<g class="pdf-mark${a.id===PDF.selected?' selected':''}" data-annotation="${esc(a.id)}">${inkSVG({...a,width:a.width*(a.id===PDF.selected?1.6:1)})}</g>`).join('');
      continue;
    }
    // Composite opaque fills first, then apply transparency once to the entire page.
    // Later annotations own overlaps; pending colors retain their subdued appearance.
    paintPDFAutoLabels(svg.closest('.pdf-page'));
    const opacity=PDF.dark?.2:.35,background=PDF.dark?'#202124':'#ffffff';
    const fills=annotations.map(a=>{
      const color=a.status==='pending'?`color-mix(in srgb, ${a.color} ${PDF.dark?60:100*5/7}%, ${background})`:a.color;
      const rects=mergePDFHighlightRects(a.rects||[],aspect).map(r=>`<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="${esc(color)}"/>`).join('');
      return `<g class="pdf-mark${a.id===PDF.selected?' selected':''}" data-annotation="${esc(a.id)}">${rects}</g>`;
    }).join('');
    const selected=annotations.find(a=>a.id===PDF.selected);
    const outline=selected?mergePDFHighlightRects(selected.rects||[],aspect).map(r=>`<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="none" stroke="${esc(selected.color)}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join(''):'';
    svg.innerHTML=`<g class="pdf-highlight-fills" opacity="${opacity}">${fills}</g>${outline}`;
  }
}
async function addPDFAnnotation(kind){if(kind==='highlight'&&!PDF.selection)throw new Error('Select some PDF text first.');const a=await pdfSave(api(paperURL(PDF.key)+'/annotations',{kind,page:PDF.page,color:PDF.color,...(PDF.selection || {}),comment:''}));PDF.selected=a.id;if(!pdfAnnotationMatchesFilter(a,PDF.annotationFilter))setPDFAnnotationFilter(null);PDF.selection=null;getSelection().removeAllRanges();await refreshPDFAnnotations();$('#pdf-sidebar [data-id="'+a.id+'"] textarea')?.focus();}
const pdfMath=src=>{try{return NoctuaLatex.renderDoc([src || ''])[0];}catch{return esc(src || '');}};
// Keep one writer per comment so an older response cannot erase a newer draft.
const pdfCommentEdits=new Map();
function pdfCommentEdit(key,a){
  const id=key+':'+a.id;let edit=pdfCommentEdits.get(id);
  if(!edit){const draft=store.get('pdf-draft:'+a.id),base=store.get('pdf-draft-base:'+a.id);edit={key,id:a.id,revision:a.revision,base:a.comment||'',value:draft??a.comment??'',timer:null,running:null,error:'',conflict:draft!=null&&base!=null&&base!==(a.comment||'')&&draft!==(a.comment||''),deleted:false};if(edit.conflict)edit.error='This comment changed in another window. Your draft is kept.';pdfCommentEdits.set(id,edit);}
  else if(!edit.running&&a.revision>edit.revision){
    if(edit.value===edit.base){edit.value=a.comment||'';edit.base=edit.value;}
    else if((a.comment||'')!==edit.base){edit.conflict=true;edit.error='This comment changed in another window. Your draft is kept.';}
    edit.revision=a.revision;
  }
  return edit;
}
function showPDFCommentState(edit){
  if(PDF.key!==edit.key)return;
  const card=[...document.querySelectorAll('#pdf-annotation-list article')].find(el=>el.dataset.id===edit.id);if(!card)return;
  const status=card.querySelector('[data-comment-status]');if(!status)return;
  status.textContent=edit.error||'';
  status.classList.toggle('error',!!edit.error);
  card.querySelector('[data-comment-conflict]').hidden=!edit.conflict;
}
function queuePDFComment(edit,value){
  edit.value=value;store.set('pdf-draft:'+edit.id,value);store.set('pdf-draft-base:'+edit.id,edit.base);clearTimeout(edit.timer);
  if(edit.conflict){showPDFCommentState(edit);return;}
  edit.error='';edit.timer=setTimeout(()=>savePDFComment(edit).catch(()=>{}),450);showPDFCommentState(edit);
}
async function savePDFComment(edit,retries=0){
  clearTimeout(edit.timer);edit.timer=null;
  if(edit.running){await edit.running;return savePDFComment(edit);}
  if(edit.deleted||edit.conflict||edit.value===edit.base){
    if(!edit.conflict&&edit.value===edit.base&&store.get('pdf-draft:'+edit.id)===edit.value){store.remove('pdf-draft:'+edit.id);store.remove('pdf-draft-base:'+edit.id);}
    showPDFCommentState(edit);return;
  }
  const value=edit.value,base=edit.base;
  const work=(async()=>{
    try{
      const body=JSON.stringify({revision:edit.revision,comment:value});
      const response=await fetch(paperURL(edit.key)+'/annotations/'+enc(edit.id),{method:'PUT',headers:{'Content-Type':'application/json'},body,keepalive:new TextEncoder().encode(body).length<60000});
      const saved=await response.json().catch(()=>({}));
      if(!response.ok){
        if(response.status===409){
          const list=await api(paperURL(edit.key)+'/annotations'),latest=list.find(a=>a.id===edit.id);
          if(latest){
            edit.revision=latest.revision;
            if((latest.comment||'')===value){edit.base=value;return;}
            if((latest.comment||'')===base&&retries<2)return; // A status/color change can safely be rebased.
            edit.conflict=true;
          }
        }
        throw new Error(edit.conflict?'This comment changed in another window. Your draft is kept.':saved.error||'Could not save comment. Your draft is kept; edit it to retry.');
      }
      edit.revision=saved.revision;edit.base=value;edit.error='';
      if(PDF.key===edit.key){const annotation=PDF.annotations.find(a=>a.id===edit.id);if(annotation&&!(annotation.revision>saved.revision))Object.assign(annotation,saved);}
    }catch(error){edit.error=error.message;throw error;}
    finally{if(edit.value===edit.base&&store.get('pdf-draft:'+edit.id)===edit.value){store.remove('pdf-draft:'+edit.id);store.remove('pdf-draft-base:'+edit.id);}else if(!edit.conflict)store.set('pdf-draft-base:'+edit.id,edit.base);}
  })();
  edit.running=pdfSave(work);showPDFCommentState(edit);
  try{await edit.running;}finally{edit.running=null;showPDFCommentState(edit);}
  if(edit.value!==edit.base&&!edit.conflict&&!edit.deleted)return savePDFComment(edit,retries+1);
}
async function changePDFAnnotation(edit,method,body){
  // Finish an in-flight comment before using the annotation's revision to delete or accept it.
  clearTimeout(edit.timer);edit.timer=null;
  await savePDFComment(edit);
  if(edit.conflict)throw new Error(edit.error);
  const url=paperURL(edit.key)+'/annotations/'+enc(edit.id);
  const result=await libraryRequest(url+(method==='DELETE'?'?revision='+edit.revision:''),method,body?{revision:edit.revision,...body}:undefined);
  if(method==='DELETE'){edit.deleted=true;store.remove('pdf-draft:'+edit.id);store.remove('pdf-draft-base:'+edit.id);pdfCommentEdits.delete(edit.key+':'+edit.id);}
  else {edit.revision=result.revision;}
  return result;
}
window.addEventListener('pagehide',()=>{for(const edit of pdfCommentEdits.values())savePDFComment(edit).catch(()=>{});});
// Zotero stores PDF coordinates. PDF.js accounts for crop boxes and page rotation.
function projectZoteroAnnotation(annotation,viewport){
  const position=annotation.zotero_position;if(!position)return annotation;
  const point=(x,y)=>{const p=viewport.convertToViewportPoint(x,y);return [Math.max(0,Math.min(1,p[0]/viewport.width)),Math.max(0,Math.min(1,p[1]/viewport.height))];};
  const rects=(position.rects||[]).map(([x1,y1,x2,y2])=>{const a=point(x1,y1),b=point(x2,y2);return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1])];});
  const paths=(position.paths||[]).map(path=>{const points=[];for(let i=0;i+1<path.length;i+=2)points.push(point(path[i],path[i+1]));return points;});
  return {...annotation,rects,paths,points:paths[0]||[],width:Math.max(.0002,Math.min(.03,(position.width||2)/Math.min(viewport.width,viewport.height)))};
}
async function refreshPDFAnnotations(){refreshReaderHistory();ensurePDFSidebar();const key=PDF.key,doc=PDF.doc;if(!key)return;let list=await api(paperURL(key)+'/annotations');if(key!==PDF.key)return;
  const viewports=new Map();
  for(const a of list)if(a.zotero_position&&a.page<=doc.numPages&&!viewports.has(a.page))viewports.set(a.page,(await doc.getPage(a.page)).getViewport({scale:1}));
  if(key!==PDF.key||doc!==PDF.doc)return;
  list=list.map(a=>a.zotero_position&&viewports.has(a.page)?projectZoteroAnnotation(a,viewports.get(a.page)):a);
  for(const a of list)showPDFCommentState(pdfCommentEdit(key,a));
  PDF.annotations=list;paintPDFAnnotations();syncPDFAnnotationSelection();updatePDFAutoHighlightUI();applyPDFAnnotationFilter();if($('#pdf-sidebar').contains(document.activeElement)&&document.activeElement.matches('textarea'))return;
  const side=$('#pdf-annotation-list');side.innerHTML=list.map(a=>{const edit=pdfCommentEdit(key,a);return `<article data-id="${a.id}" class="pdf-annotation ${a.status}${a.id===PDF.selected?' selected':''}" aria-current="${a.id===PDF.selected}"><div class="pdf-annotation-header"><button data-jump>Page ${a.page} · ${esc(a.author)}${a.status==='pending'?' · suggestion':''}</button><button data-delete data-icon="trash-2" data-icon-only aria-label="${a.status==='pending'?'Reject suggestion':'Delete annotation'}" title="${a.status==='pending'?'Reject suggestion':'Delete annotation'}"></button></div>${pdfCategoryBadge(a)}<blockquote>${esc(a.quote || (a.kind==='ink'?'Drawing':''))}</blockquote><textarea rows="1" aria-label="Comment with LaTeX" placeholder="Comment…">${esc(edit.value)}</textarea><div class="pdf-preview tex-view">${edit.value.includes('$')?pdfMath(edit.value):''}</div><small data-comment-status role="status"></small><div data-comment-conflict hidden><button data-use-saved>Use saved comment</button><button data-keep-draft>Keep my draft</button></div>${a.status==='pending'?'<button data-accept data-icon="check">Accept</button>':''}${(a.replies || []).map(r=>`<div class="pdf-comment-history" data-reply-id="${esc(r.id)}"><small>${esc(r.author)}${r.status==='pending'?' · suggestion':''}</small><div class="tex-view">${pdfMath(r.comment)}</div>${r.status==='pending'?`<button data-reply-id="${r.id}" data-resolve="true" data-icon="check">Accept</button><button data-reply-id="${r.id}" data-resolve="false" data-icon="x">Reject</button>`:''}</div>`).join('')}</article>`;}).join('');
  for(const el of side.querySelectorAll('article')){const a=list.find(a=>a.id===el.dataset.id),url=paperURL(key)+'/annotations/'+a.id,input=el.querySelector('textarea'),edit=pdfCommentEdit(key,a);
    input.oninput=()=>{queuePDFComment(edit,input.value);el.querySelector('.pdf-preview').innerHTML=input.value.includes('$')?pdfMath(input.value):'';};
    input.onblur=()=>savePDFComment(edit).catch(()=>{});
    const select=()=>{if(PDF.selected!==a.id||PDF.page!==a.page)selectPDFAnnotation(a.id).catch(e=>toast(e.message));};
    el.addEventListener('focusin',select);el.addEventListener('click',select);
    const bind=(selector,fn)=>{const b=el.querySelector(selector);if(b)b.onclick=async()=>{b.disabled=true;try{await pdfSave(Promise.resolve().then(fn));await refreshPDFAnnotations();}catch(e){toast(e.message);}finally{b.disabled=false;}};};
    bind('[data-jump]',()=>selectPDFAnnotation(a.id));
    for(const [selector,method,body] of [['[data-delete]','DELETE'],['[data-accept]','PUT',{status:'accepted'}]])bind(selector,async()=>{input.disabled=true;try{return await changePDFAnnotation(edit,method,body);}finally{input.disabled=false;}});
    for(const [selector,keep] of [['[data-use-saved]',false],['[data-keep-draft]',true]])bind(selector,async()=>{
      const latest=(await api(paperURL(key)+'/annotations')).find(item=>item.id===edit.id);if(!latest)throw new Error('This annotation was deleted. Your draft is kept.');
      edit.revision=latest.revision;edit.base=latest.comment||'';edit.conflict=false;edit.error='';
      if(keep)await savePDFComment(edit);else {edit.value=edit.base;input.value=edit.value;store.remove('pdf-draft:'+edit.id);store.remove('pdf-draft-base:'+edit.id);}
    });
    el.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=async()=>{try{await savePDFComment(edit);await pdfSave(api(url+'/resolve-reply',{reply_id:b.dataset.replyId,accept:b.dataset.resolve==='true'}));await refreshPDFAnnotations();}catch(e){toast(e.message);}});
    showPDFCommentState(edit);
    if(edit.value!==edit.base&&!edit.timer&&!edit.running&&!edit.error&&!edit.conflict)queuePDFComment(edit,edit.value);
  }
  applyPDFAnnotationFilter();
}
function pdfContext(){return {view:'pdf',paper_key:PDF.key,title:PDF.paper?.title,page:PDF.page,selected_text:PDF.selection?.quote,selected_text_page:PDF.selection?.page,selected_annotation:PDF.annotations.find(a=>a.id===PDF.selected),sidebar:PDF.sidebar,annotation_filter:PDF.annotationFilter||'all',instructions:'Use read_pdf/search_pdf/view_pdf_page to inspect this paper; annotate_pdf and comment_on_pdf_annotation save anchored highlights and LaTeX comments. The Reader Outline tab defaults to Document outline; choosing its AI-generated outline tab starts or loads a separate AI outline; the Auto-highlight toolbar button runs a separate analysis worker for novelty, method, results, and limitations; generating, regenerating, or deleting the AI outline are UI-only controls, with no MCP outline-editing tool.'};}
async function pdfAction(a){if(a.action==='pdf_index')return indexPDF(a.key);if(a.action==='pdf_page')return pdfPageImage(a.key,a.page);if(a.action==='pdf_show')return openPDF(a.key,{page:a.page});if(a.action==='pdf_annotations'){if(PDF.key!==a.key)await openPDF(a.key,{page:a.page,annotation:a.id});else {setMode('pdf');await refreshPDFAnnotations();await selectPDFAnnotation(a.id,{scrollComment:true});}}}
// Switch papers from the bar above the PDF while a note is open beside it.
const splitPaperBar=document.createElement('div');
Object.assign(splitPaperBar,{id:'split-paper-bar',className:'split-bar'});splitPaperBar.setAttribute('role','toolbar');splitPaperBar.setAttribute('aria-label','Paper beside the note');
splitPaperBar.innerHTML='<select data-split-folder aria-label="Papers folder" title="Papers folder"></select><select data-split-paper aria-label="Paper beside the note" title="Paper beside the note"></select>';
$('#pdf-stage').before(splitPaperBar);
const splitPapers={target:null,items:[]};
async function renderSplitPaperBar(reload=false){
  if(!splitViewActive())return;
  const target=splitPapers.target||store.get('noctua.pane.split.paperFolder')||collections.targets[0]?.id;if(!target)return;
  if(reload||target!==splitPapers.target){const items=await api(`/api/library/items?target=${enc(target)}`);Object.assign(splitPapers,{target,items:items.filter(i=>i.has_pdf)});}
  const folder=splitPaperBar.querySelector('[data-split-folder]'),paper=splitPaperBar.querySelector('[data-split-paper]'),list=splitPapers.items,open=list.some(i=>i.key===PDF.key);
  folder.innerHTML=collectionOptions(target);
  paper.innerHTML=(open?'':`<option value="" selected disabled>${list.length?'Choose a paper':'No PDFs in this folder'}</option>`)+list.map(i=>`<option value="${esc(i.key)}"${i.key===PDF.key?' selected':''}>${esc(i.title||'Untitled paper')}</option>`).join('');
  paper.disabled=!list.length;
}
splitPaperBar.querySelector('[data-split-folder]').addEventListener('change',e=>{splitPapers.target=e.target.value;store.set('noctua.pane.split.paperFolder',e.target.value);renderSplitPaperBar(true).catch(e=>toast(e.message));});
splitPaperBar.querySelector('[data-split-paper]').addEventListener('change',e=>{if(e.target.value&&e.target.value!==PDF.key)openPDF(e.target.value).catch(e=>toast(e.message));});
document.addEventListener('noctua-split-change',()=>{renderSplitPaperBar(true).catch(e=>toast(e.message));});
function pdfRoute(){if(!location.hash.startsWith('#pdf='))return;const q=new URLSearchParams(location.hash.slice(1));openPDF(q.get('pdf'),{page:q.get('page'),annotation:q.get('annotation'),push:false}).catch(e=>toast(e.message));}
setReaderTheme(store.get('noctua.readerTheme')||store.get('noctua.pdfPageTheme'));
pdfSystemTheme.addEventListener('change',()=>{if(PDF.theme==='system')Promise.resolve(applyReaderTheme()).catch(e=>toast(e.message));});
window.addEventListener('storage',e=>{if(e.key==='noctua.readerTheme'||e.key===null)Promise.resolve(setReaderTheme(store.get('noctua.readerTheme'))).catch(e=>toast(e.message));});
window.addEventListener('blur',clearPDFAnnotationSelection);
window.addEventListener('popstate',pdfRoute);pdfRoute();
setInterval(()=>{if(PDF.key&&document.body.classList.contains('pdf-mode')&&!document.hidden)refreshPDFAnnotations().catch(()=>{});},3000);
