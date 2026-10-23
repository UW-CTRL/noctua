'use strict';
const PDF={key:null,paper:null,page:1,scale:1.25,mode:'select',color:'#ffd400',annotations:[],selection:null,selected:null,token:0,dark:true};
const pdfColors=['#ffd400','#5fb236','#2ea8e5','#e56eee','#a28ae5','#ff6666'];
const pdfDocs=new Map(),pdfIndexes=new Map(),pdfSaves=new Set();
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
window.flushPDF=()=>Promise.all([...pdfSaves]);
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
  Object.assign(PDF,{key,paper,doc,page:Math.max(1,Math.min(doc.numPages,Number(page)||1)),selection:null,selected:annotation});$('#reader-mode').disabled=false;setMode('pdf');document.title=paper.title+' · Noctua';
  if(push)history.pushState({},'', '/#pdf='+enc(key)+'&page='+PDF.page);await renderPDF();await refreshPDFAnnotations();if(annotation)$('#pdf-sidebar [data-id="'+annotation+'"]')?.scrollIntoView({block:'nearest'});indexPDF(key).then(()=>{if(PDF.key===key)return refreshPDFAnnotations();}).catch(e=>toast('PDF text: '+e.message));
}
// Re-rasterize PDF vectors at the display's pixel density, rather than magnifying
// an existing bitmap. Bound large pages to avoid exceeding WebKit canvas limits.
function pdfRasterSize(width,height,density){
  const ratio=Math.min(Math.max(1,density || 1),Math.sqrt(32*1024*1024/(width*height)),16384/width,16384/height);
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
async function zoomPDF(scale,anchor=pdfZoomAnchor()){
  clearTimeout(pdfZoomTimer);pdfZoomTarget=null;
  PDF.scale=Math.max(.4,Math.min(6,scale));await renderPDF(anchor);
}
function schedulePDFZoom(scale,x,y){
  clearTimeout(pdfZoomTimer);pdfZoomTarget=Math.max(.4,Math.min(6,scale));
  const anchor=pdfZoomAnchor(x,y),key=PDF.key,page=PDF.page;
  pdfZoomTimer=setTimeout(()=>{const target=pdfZoomTarget;pdfZoomTarget=null;if(key===PDF.key&&page===PDF.page&&target!==null)zoomPDF(target,anchor).catch(e=>toast(e.message));},100);
}
function pdfWheelZoom(event){
  if(!PDF.doc||!event.ctrlKey)return;
  event.preventDefault();if(pdfGestureStart!==null)return;
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?300:1);
  schedulePDFZoom((pdfZoomTarget ?? PDF.scale)*Math.exp(-Math.max(-100,Math.min(100,delta))*.005),event.clientX,event.clientY);
}
const pdfZoomStage=$('#pdf-stage');
pdfZoomStage.addEventListener('wheel',pdfWheelZoom,{passive:false});
pdfZoomStage.addEventListener('gesturestart',event=>{if(!PDF.doc)return;event.preventDefault();pdfGestureStart=PDF.scale;},{passive:false});
pdfZoomStage.addEventListener('gesturechange',event=>{if(pdfGestureStart===null)return;event.preventDefault();schedulePDFZoom(pdfGestureStart*event.scale,event.clientX,event.clientY);},{passive:false});
pdfZoomStage.addEventListener('gestureend',event=>{if(pdfGestureStart===null)return;event.preventDefault();pdfGestureStart=null;},{passive:false});
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
function pdfPageBox(number){return pdfPageEntries.find(e=>e.number===number)?.box || null;}
function pdfSetCurrentPage(number){
  if(PDF.page===number)return;PDF.page=number;
  const input=$('#pdf-stage [data-page]');if(input&&document.activeElement!==input)input.value=number;
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
  entry.box.replaceChildren();entry.box.dataset.loaded='false';entry.loaded=false;entry.loading=null;
}
function updatePDFViewport(){
  pdfScrollFrame=null;
  const scroll=$('#pdf-stage .pdf-scroll');if(!scroll||!pdfPageEntries.length)return;
  const bounds=scroll.getBoundingClientRect();
  const metrics=pdfPageEntries.map(e=>{const b=e.box.getBoundingClientRect(),r=pdfRasterSize(e.viewport.width,e.viewport.height,pdfRenderDensity);return {number:e.number,top:b.top,bottom:b.bottom,pixels:r.width*r.height};});
  let current=metrics[0],overlap=-1;
  for(const e of metrics){const size=Math.max(0,Math.min(e.bottom,bounds.bottom)-Math.max(e.top,bounds.top));if(size>overlap){overlap=size;current=e;}}
  if(overlap>0)pdfSetCurrentPage(current.number);
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
    box.innerHTML='<canvas></canvas><div class="textLayer"></div><svg class="pdf-overlay" viewBox="0 0 1 1" preserveAspectRatio="none"></svg><div class="pdf-document-links"></div>';
    const canvas=box.querySelector('canvas'),raster=pdfRasterSize(viewport.width,viewport.height,pdfRenderDensity);
    canvas.width=raster.width;canvas.height=raster.height;canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
    const context=canvas.getContext('2d',{alpha:false});context.noctuaTheme=PDF.dark?{background:'#202124',foreground:'#e8eaed',invertImages:false}:null;
    entry.task=page.render({canvasContext:context,viewport,transform:raster.transform});
    await entry.task.promise;if(!active())return;entry.task=null;
    entry.text=await textLayer(page,box.querySelector('.textLayer'),viewport);if(!active())return;
    entry.links=await pdfPageLinks(page,viewport).catch(()=>[]);if(!active())return;
    entry.loaded=true;box.dataset.loaded='true';paintPDFAnnotations();bindPDFPage(entry,key,token);renderPDFLinkTargets(entry);
  })().catch(error=>{if(error.name!=='RenderingCancelledException'&&error.name!=='AbortException'&&active()){entry.box.textContent='Could not render page '+entry.number+'. Use the page control to retry.';throw error;}})
    .finally(()=>{if(entry.epoch===epoch)entry.loading=null;});
  entry.loading=work;return work;
}
async function renderPDF(anchor=null){
  const token=++PDF.token,key=PDF.key;PDF.selection=null;closePDFLinkPreview();
  if(pdfScrollFrame!==null)cancelAnimationFrame(pdfScrollFrame);pdfScrollFrame=null;
  for(const entry of pdfPageEntries)disposePDFPage(entry);pdfPageEntries=[];
  $('#pdf-stage').innerHTML=`<div class="pdf-toolbar"><button data-prev>‹</button><input data-page type="number" min="1" max="${PDF.doc.numPages}" value="${PDF.page}" aria-label="Page"> / ${PDF.doc.numPages}<button data-next>›</button><button data-zoom="-">−</button><button data-zoom="+">+</button><span class="pdf-zoom-level" aria-label="PDF zoom">${Math.round(PDF.scale*100)}%</span><select data-tool><option value="select">Select text</option><option value="draw">Draw</option></select><button data-highlight>Highlight</button><button data-comment>Comment</button><select data-color aria-label="Annotation color">${pdfColors.map((c,i)=>`<option value="${c}">${['Yellow','Green','Blue','Pink','Purple','Red'][i]}</option>`).join('')}</select><button data-dark>${PDF.dark?'Light':'Dark'} pages</button><button data-tab>New tab</button><button data-window>New window</button><span class="pdf-title">${esc(PDF.paper.title)}</span></div><div class="pdf-scroll" tabindex="0" aria-label="PDF pages"><div class="pdf-document"></div></div>`;
  const stage=$('#pdf-stage'),on=(s,fn)=>stage.querySelector(s).onclick=()=>Promise.resolve().then(fn).catch(e=>toast(e.message));
  on('[data-prev]',()=>pdfNavigate(PDF.page-1));on('[data-next]',()=>pdfNavigate(PDF.page+1));stage.querySelector('[data-page]').onchange=e=>pdfNavigate(+e.target.value);
  on('[data-zoom="-"]',()=>zoomPDF(PDF.scale/1.2));on('[data-zoom="+"]',()=>zoomPDF(PDF.scale*1.2));
  on('[data-highlight]',()=>addPDFAnnotation('highlight'));on('[data-comment]',()=>addPDFAnnotation(PDF.selection?'highlight':'comment'));
  on('[data-dark]',()=>{PDF.dark=!PDF.dark;return renderPDF(pdfZoomAnchor());});on('[data-tab]',()=>openPaperView(key,'tab',{page:PDF.page}));on('[data-window]',()=>openPaperView(key,'window',{page:PDF.page}));
  stage.querySelector('[data-color]').value=PDF.color;stage.querySelector('[data-color]').onchange=e=>PDF.color=e.target.value;
  const tool=stage.querySelector('[data-tool]');tool.value=PDF.mode;tool.onchange=e=>{PDF.mode=e.target.value;pdfPageEntries.forEach(e=>e.box.classList.toggle('drawing',PDF.mode==='draw'));closePDFLinkPreview();};
  const doc=PDF.doc,scale=PDF.scale,sizes=await pdfPageLayout(doc);if(token!==PDF.token)return;
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
  const input=$('#pdf-stage [data-page]');if(input)input.value=number;
  if(!pdfPageEntries.length){await renderPDF();return;}
  scrollPDFPage(number,y);updatePDFViewport();
  const entry=pdfPageEntries[number-1];entry.wanted=true;await ensurePDFPage(entry);updateChatContext();
}
function bindPDFPage(entry,key,token){
  const box=entry.box,pageNumber=entry.number;
  box.onpointerup=event=>{
    if(PDF.mode==='draw')return;
    setTimeout(()=>{
      if(token!==PDF.token)return;
      const selection=getSelection(),bounds=box.getBoundingClientRect(),x=(event.clientX-bounds.left)/bounds.width,y=(event.clientY-bounds.top)/bounds.height;
      if(!selection.rangeCount||selection.isCollapsed){
        const link=entry.links.find(a=>pdfPointInRect(x,y,a.rect));
        if(link){showPDFLinkPreview(link,event.clientX,event.clientY,true).catch(e=>toast(e.message));return;}
        const hit=[...PDF.annotations].reverse().find(a=>a.page===pageNumber&&(a.rects||[]).some(r=>pdfPointInRect(x,y,r)));
        if(hit)selectPDFAnnotation(hit.id,{scrollComment:true}).catch(e=>toast(e.message));return;
      }
      const range=selection.getRangeAt(0);if(!box.contains(range.commonAncestorContainer)){PDF.selection=null;toast('For a saved highlight, select text within one page at a time.');return;}
      PDF.selection={page:pageNumber,quote:selection.toString(),rects:[...range.getClientRects()].map(r=>normalizedRect(r,bounds)).filter(r=>r[2]>0&&r[3]>0)};updateChatContext();
      const link=entry.links.find(a=>PDF.selection.rects.some(r=>pdfRectsOverlap(r,a.rect)));
      if(link)showPDFLinkPreview(link,event.clientX,event.clientY,true).catch(e=>toast(e.message));
      else previewNumberedCitation(PDF.selection.quote,event.clientX,event.clientY).catch(()=>{});
    },0);
  };
  box.onpointermove=event=>{
    if(PDF.mode==='draw'||event.buttons)return;
    const b=box.getBoundingClientRect(),x=(event.clientX-b.left)/b.width,y=(event.clientY-b.top)/b.height;
    const link=entry.links.find(a=>pdfPointInRect(x,y,a.rect));box.classList.toggle('over-pdf-link',!!link);
    if(link)schedulePDFLinkPreview(link,event.clientX,event.clientY);else schedulePDFLinkClose();
  };
  box.onpointerleave=schedulePDFLinkClose;
  const svg=box.querySelector('svg');let points=null;
  const point=e=>{const b=svg.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))];};
  svg.onpointerdown=e=>{if(PDF.mode!=='draw')return;e.preventDefault();entry.drawing=true;svg.setPointerCapture(e.pointerId);points=[point(e)];};
  svg.onpointermove=e=>{if(!points)return;points.push(point(e));paintPDFAnnotations();svg.insertAdjacentHTML('beforeend',inkSVG({points,color:PDF.color,width:.003}));};
  svg.onpointerup=async()=>{const drawn=points;points=null;entry.drawing=false;if(!drawn||drawn.length<2)return;try{await pdfSave(api(paperURL(key)+'/annotations',{kind:'ink',page:pageNumber,color:PDF.color,points:drawn,width:.003}));await refreshPDFAnnotations();}catch(e){toast(e.message);}};
  svg.onpointercancel=()=>{points=null;entry.drawing=false;paintPDFAnnotations();};
}
function pdfPointInRect(x,y,r){return x>=r[0]&&x<=r[0]+r[2]&&y>=r[1]&&y<=r[1]+r[3];}
function pdfRectsOverlap(a,b){return a[0]<b[0]+b[2]&&a[0]+a[2]>b[0]&&a[1]<b[1]+b[3]&&a[1]+a[3]>b[1];}
function safePDFLinkURL(value){try{const url=new URL(value);return ['http:','https:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}}
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
  layer.innerHTML=entry.links.map((link,i)=>`<button class="pdf-document-link" data-link="${i}" aria-label="${link.url?'Preview external link':'Preview reference or document link'}" style="left:${link.rect[0]*100}%;top:${link.rect[1]*100}%;width:${link.rect[2]*100}%;height:${link.rect[3]*100}%"></button>`).join('');
  layer.querySelectorAll('button').forEach(button=>{
    button.onfocus=()=>{const b=button.getBoundingClientRect();showPDFLinkPreview(entry.links[+button.dataset.link],b.left,b.bottom,true).catch(e=>toast(e.message));};
    button.onclick=event=>{event.preventDefault();button.onfocus();};
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
let pdfLinkTimer=null,pdfLinkCloseTimer=null,pdfLinkCurrent=null,pdfLinkPending=null,pdfLinkPinned=false,pdfLinkSerial=0,pdfPreviewTask=null;
function closePDFLinkPreview(){
  clearTimeout(pdfLinkTimer);clearTimeout(pdfLinkCloseTimer);pdfLinkPending=null;pdfLinkCurrent=null;pdfLinkPinned=false;pdfLinkSerial++;
  pdfPreviewTask?.cancel();pdfPreviewTask=null;$('#pdf-link-preview')?.remove();
}
function schedulePDFLinkClose(){
  clearTimeout(pdfLinkTimer);pdfLinkPending=null;if(pdfLinkPinned)return;
  clearTimeout(pdfLinkCloseTimer);pdfLinkCloseTimer=setTimeout(closePDFLinkPreview,250);
}
function schedulePDFLinkPreview(link,x,y){
  clearTimeout(pdfLinkCloseTimer);
  if(pdfLinkCurrent===link.id||pdfLinkPending===link.id||pdfLinkPinned)return;
  clearTimeout(pdfLinkTimer);pdfLinkPending=link.id;
  pdfLinkTimer=setTimeout(()=>{pdfLinkPending=null;showPDFLinkPreview(link,x,y).catch(e=>toast(e.message));},300);
}
function positionPDFPreview(popup,x,y){
  popup.style.left=Math.max(12,Math.min(x+12,innerWidth-popup.offsetWidth-12))+'px';
  popup.style.top=Math.max(12,Math.min(y+16,innerHeight-popup.offsetHeight-12))+'px';
}
function pdfReferenceCrop(viewport,target,items){
  const tx=target.x*viewport.width,ty=target.y*viewport.height;
  const boxes=items.filter(item=>item.str?.trim()&&item.transform).map(item=>{
    const [x,y]=[item.transform[4],item.transform[5]],h=item.height || Math.hypot(item.transform[2],item.transform[3]);
    const r=viewport.convertToViewportRectangle([x,y,x+item.width,y+h]);
    return {left:Math.min(r[0],r[2]),right:Math.max(r[0],r[2]),top:Math.min(r[1],r[3]),bottom:Math.max(r[1],r[3])};
  });
  const nearest=boxes.slice().sort((a,b)=>(Math.abs(a.top-ty)+Math.abs(a.left-tx)*.15)-(Math.abs(b.top-ty)+Math.abs(b.left-tx)*.15))[0];
  let left=tx,right=tx+360,centerY=ty+24;
  if(nearest){
    // Follow the destination's text line, stopping at the gutter between columns.
    const row=boxes.filter(b=>Math.abs(b.top-nearest.top)<Math.max(5,(nearest.bottom-nearest.top)*.7)).sort((a,b)=>a.left-b.left);
    const index=row.indexOf(nearest);left=nearest.left;right=nearest.right;
    for(let i=index-1;i>=0&&left-row[i].right<24;i--)left=Math.min(left,row[i].left);
    for(let i=index+1;i<row.length&&row[i].left-right<24;i++)right=Math.max(right,row[i].right);
    centerY=nearest.top+Math.max(24,(nearest.bottom-nearest.top)*2);
  }
  const width=Math.min(viewport.width,Math.max(400,right-left+32)),height=Math.min(190,viewport.height);
  return {width,height,x:Math.max(0,Math.min(viewport.width-width,(left+right)/2-width/2)),y:Math.max(0,Math.min(viewport.height-height,centerY-height/2))};
}
async function showPDFLinkPreview(link,x,y,pinned=false){
  if(pdfLinkCurrent===link.id){pdfLinkPinned ||= pinned;return;}
  closePDFLinkPreview();pdfLinkCurrent=link.id;pdfLinkPinned=pinned;
  const serial=pdfLinkSerial,doc=PDF.doc,key=PDF.key;
  const popup=document.createElement('aside');popup.id='pdf-link-preview';popup.classList.toggle('pdf-reference-popover',!link.url);popup.setAttribute('role','dialog');popup.setAttribute('aria-label','PDF link preview');
  popup.innerHTML='<button class="pdf-preview-close" aria-label="Close preview">×</button><div class="pdf-preview-content">Loading reference…</div>';
  document.body.append(popup);positionPDFPreview(popup,x,y);
  popup.querySelector('button').onclick=closePDFLinkPreview;popup.onpointerenter=()=>clearTimeout(pdfLinkCloseTimer);popup.onpointerleave=schedulePDFLinkClose;
  const body=popup.querySelector('.pdf-preview-content'),active=()=>serial===pdfLinkSerial&&key===PDF.key&&popup.isConnected;
  if(link.url){
    const url=safePDFLinkURL(link.url);
    body.innerHTML=`<strong>External link</strong><p class="pdf-link-url">${esc(link.url)}</p>${url?`<a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Follow link ↗</a>`:'<p>This link type cannot be opened from Noctua.</p>'}`;
    positionPDFPreview(popup,x,y);return;
  }
  try{
    const target=await resolvePDFDestination(doc,link);if(!active())return;
    body.innerHTML=`<strong>${link.label?esc(link.label):'Reference / document link'}</strong><div class="hint">Page ${target.page}</div>${link.excerpt?`<p class="pdf-reference-text">${esc(link.excerpt)}</p>`:'<canvas class="pdf-reference-preview"></canvas>'}<button data-follow-reference>Go to passage</button>`;
    body.querySelector('[data-follow-reference]').onclick=()=>{closePDFLinkPreview();pdfNavigate(target.page,target.y).catch(e=>toast(e.message));};
    positionPDFPreview(popup,x,y);
    const canvas=body.querySelector('canvas');if(!canvas)return;
    const page=await doc.getPage(target.page);if(!active())return;
    const viewport=page.getViewport({scale:1}),text=await page.getTextContent();if(!active())return;
    const {width,height,x:cropX,y:cropY}=pdfReferenceCrop(viewport,target,text.items);
    const displayWidth=body.clientWidth || width,raster=pdfRasterSize(displayWidth,displayWidth*height/width,pdfPixelDensity());
    const sx=raster.width/width,sy=raster.height/height;canvas.width=raster.width;canvas.height=raster.height;canvas.style.aspectRatio=String(width/height);
    const context=canvas.getContext('2d',{alpha:false});context.noctuaTheme=PDF.dark?{background:'#202124',foreground:'#e8eaed',invertImages:false}:null;
    const task=page.render({canvasContext:context,viewport,transform:[sx,0,0,sy,-cropX*sx,-cropY*sy]});pdfPreviewTask=task;
    try{await task.promise;}finally{if(pdfPreviewTask===task)pdfPreviewTask=null;}
    if(active())positionPDFPreview(popup,x,y);
  }catch(e){if(active()&&e.name!=='RenderingCancelledException'){body.textContent=e.message;positionPDFPreview(popup,x,y);}}
}
function findNumberedPDFReference(index,number){
  const pages=index.pages || [];let start=-1,startOffset=0;
  for(let i=Math.floor(pages.length*.4);i<pages.length;i++){const heading=/(?:^|\n)\s*(?:\d+\.?\s+)?(?:references|bibliography)\s*(?:\n|$)/i.exec(pages[i].text);if(heading){start=i;startOffset=heading.index+heading[0].length;break;}}
  if(start<0)return null;
  const pattern=new RegExp('(?:^|\\n)\\s*(?:\\['+number+'\\]|'+number+'\\.)\\s+','g');
  for(let i=start;i<pages.length;i++){
    const page=pages[i],text=page.text || '';pattern.lastIndex=0;
    for(const match of text.matchAll(pattern)){
      if(i===start&&match.index+match[0].length<startOffset)continue;
      const offset=match.index+match[0].length,word=(page.words||[]).find(w=>w.end>offset);if(!word)continue;
      let excerpt=text.slice(match.index,match.index+1200).trim();const next=excerpt.slice(1).search(/\n\s*(?:\[\d+\]|\d+\.)\s+/);if(next>=0)excerpt=excerpt.slice(0,next+1);
      return {page:page.page,x:word.rect[0],y:word.rect[1],excerpt};
    }
  }
  return null;
}
async function previewNumberedCitation(quote,x,y){
  const url=safePDFLinkURL(quote.trim());if(url)return showPDFLinkPreview({id:PDF.key+':url:'+url,url},x,y,true);
  const match=quote.trim().match(/^\[(\d{1,4})\]$/);if(!match)return;
  const key=PDF.key,selected=PDF.selection;
  const index=await indexPDF(key);if(PDF.key!==key||PDF.selection!==selected)return;
  const target=findNumberedPDFReference(index,Number(match[1]));if(!target)return;
  return showPDFLinkPreview({id:`${key}:reference:${match[1]}`,label:`Reference [${match[1]}]`,target,excerpt:target.excerpt},x,y,true);
}
function inkSVG(a){return `<polyline points="${a.points.map(p=>p[0]+','+p[1]).join(' ')}" fill="none" stroke="${esc(a.color)}" stroke-width="${a.width}" stroke-linecap="round" stroke-linejoin="round"/>`;}
function clearPDFAnnotationSelection(){
  if(!PDF.selected)return;PDF.selected=null;syncPDFAnnotationSelection();paintPDFAnnotations();updateChatContext();
}
function pdfOutsideComment(event){
  if(!event.target.closest?.('#pdf-sidebar article'))clearPDFAnnotationSelection();
  if(!event.target.closest?.('#pdf-link-preview,.pdf-document-link'))closePDFLinkPreview();
}
document.addEventListener('pointerdown',pdfOutsideComment,true);
document.addEventListener('focusin',event=>{if(!event.target.closest?.('#pdf-sidebar article'))clearPDFAnnotationSelection();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){clearPDFAnnotationSelection();closePDFLinkPreview();}});
function syncPDFAnnotationSelection(){
  document.querySelectorAll('#pdf-sidebar article').forEach(el=>{
    const selected=el.dataset.id===PDF.selected;
    el.classList.toggle('selected',selected);
    el.setAttribute('aria-current',String(selected));
  });
}
async function selectPDFAnnotation(id,{scrollComment=false}={}){
  const a=PDF.annotations.find(a=>a.id===id);if(!a)return;
  PDF.selected=id;syncPDFAnnotationSelection();
  if(PDF.page!==a.page)await pdfNavigate(a.page);else {const entry=pdfPageEntries.find(e=>e.number===a.page);if(entry){entry.wanted=true;await ensurePDFPage(entry);}paintPDFAnnotations();}
  const mark=$('#pdf-stage .pdf-mark.selected');
  mark?.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'});
  if(scrollComment)document.querySelectorAll('#pdf-sidebar article').forEach(el=>{if(el.dataset.id===id)el.scrollIntoView({block:'nearest',behavior:'smooth'});});
  updateChatContext();
}
function paintPDFAnnotations(){
  for(const svg of document.querySelectorAll('#pdf-stage .pdf-overlay')){
  const page=Number(svg.closest('.pdf-page').dataset.page);
  svg.innerHTML=PDF.annotations.filter(a=>a.page===page).map(a=>{
    const selected=a.id===PDF.selected;
    const geometry=a.kind==='ink'?inkSVG({...a,width:a.width*(selected?1.6:1)}):(a.rects || []).map(r=>`<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="${esc(a.color)}" fill-opacity="${selected?.6:a.status==='pending'?.25:.35}" ${selected?`stroke="${esc(a.color)}" stroke-opacity="1" stroke-width="2" vector-effect="non-scaling-stroke"`:''}/>`).join('');
    return `<g class="pdf-mark${selected?' selected':''}" data-annotation="${esc(a.id)}">${geometry}</g>`;
  }).join('');
  }
}
async function addPDFAnnotation(kind){if(kind==='highlight'&&!PDF.selection)throw new Error('Select some PDF text first.');const a=await pdfSave(api(paperURL(PDF.key)+'/annotations',{kind,page:PDF.page,color:PDF.color,...(PDF.selection || {}),comment:''}));PDF.selected=a.id;PDF.selection=null;getSelection().removeAllRanges();await refreshPDFAnnotations();$('#pdf-sidebar [data-id="'+a.id+'"] textarea')?.focus();}
const pdfMath=src=>{try{return NoctuaLatex.renderDoc([src || ''])[0];}catch{return esc(src || '');}};
async function refreshPDFAnnotations(){const key=PDF.key;if(!key)return;const list=await api(paperURL(key)+'/annotations');if(key!==PDF.key)return;PDF.annotations=list;paintPDFAnnotations();syncPDFAnnotationSelection();if($('#pdf-sidebar').contains(document.activeElement)&&document.activeElement.matches('textarea'))return;
  const side=$('#pdf-sidebar');side.innerHTML='<h3>Annotations</h3><p class="hint">Select text to highlight it. Comments support $inline$ and $$display$$ math.</p>'+list.map(a=>`<article data-id="${a.id}" class="pdf-annotation ${a.status}${a.id===PDF.selected?' selected':''}" aria-current="${a.id===PDF.selected}"><button data-jump>Page ${a.page} · ${esc(a.author)}${a.status==='pending'?' · suggestion':''}</button><blockquote>${esc(a.quote || (a.kind==='ink'?'Drawing':''))}</blockquote><div class="tex-view">${pdfMath(a.comment)}</div><textarea aria-label="Comment with LaTeX" placeholder="Comment with $math$">${esc(store.get('pdf-draft:'+a.id) ?? a.comment ?? '')}</textarea><div class="pdf-preview tex-view"></div><button data-save>Save comment</button>${a.status==='pending'?'<button data-accept>Accept</button>':''}<button data-delete>${a.status==='pending'?'Reject':'Delete'}</button>${(a.replies || []).map(r=>`<div class="pdf-reply"><small>${esc(r.author)}${r.status==='pending'?' · suggestion':''}</small><div class="tex-view">${pdfMath(r.comment)}</div>${r.status==='pending'?`<button data-reply-id="${r.id}" data-resolve="true">Accept</button><button data-reply-id="${r.id}" data-resolve="false">Reject</button>`:''}</div>`).join('')}<textarea data-reply placeholder="Reply with $math$" aria-label="Reply">${esc(store.get('pdf-reply:'+a.id)||'')}</textarea><button data-send>Reply</button></article>`).join('');
  for(const el of side.querySelectorAll('article')){const a=list.find(a=>a.id===el.dataset.id),url=paperURL(key)+'/annotations/'+a.id,input=el.querySelector('textarea');input.oninput=()=>{store.set('pdf-draft:'+a.id,input.value);el.querySelector('.pdf-preview').innerHTML=pdfMath(input.value);};const reply=el.querySelector('[data-reply]');reply.oninput=()=>store.set('pdf-reply:'+a.id,reply.value);
    const select=()=>{if(PDF.selected!==a.id||PDF.page!==a.page)selectPDFAnnotation(a.id).catch(e=>toast(e.message));};
    el.addEventListener('focusin',select);el.addEventListener('click',select);
    const bind=(selector,fn)=>{const b=el.querySelector(selector);if(b)b.onclick=async()=>{try{await pdfSave(Promise.resolve().then(fn));await refreshPDFAnnotations();}catch(e){toast(e.message);}};};
    bind('[data-jump]',()=>selectPDFAnnotation(a.id));bind('[data-save]',async()=>{await libraryRequest(url,'PUT',{revision:a.revision,comment:input.value});localStorage.removeItem('pdf-draft:'+a.id);});bind('[data-delete]',()=>libraryRequest(url+'?revision='+a.revision,'DELETE'));bind('[data-accept]',()=>libraryRequest(url,'PUT',{revision:a.revision,status:'accepted'}));bind('[data-send]',async()=>{await api(url+'/reply',{comment:reply.value});localStorage.removeItem('pdf-reply:'+a.id);});
    el.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=async()=>{try{await pdfSave(api(url+'/resolve-reply',{reply_id:b.dataset.replyId,accept:b.dataset.resolve==='true'}));await refreshPDFAnnotations();}catch(e){toast(e.message);}});
  }
}
function pdfContext(){return {view:'pdf',paper_key:PDF.key,title:PDF.paper?.title,page:PDF.page,selected_text:PDF.selection?.quote,selected_text_page:PDF.selection?.page,selected_annotation:PDF.annotations.find(a=>a.id===PDF.selected),instructions:'Use read_pdf/search_pdf/view_pdf_page to inspect this paper; annotate_pdf and comment_on_pdf_annotation save anchored highlights and LaTeX comments.'};}
async function pdfAction(a){if(a.action==='pdf_index')return indexPDF(a.key);if(a.action==='pdf_page')return pdfPageImage(a.key,a.page);if(a.action==='pdf_show')return openPDF(a.key,{page:a.page});if(a.action==='pdf_annotations'){if(PDF.key!==a.key)await openPDF(a.key,{page:a.page,annotation:a.id});else {setMode('pdf');await refreshPDFAnnotations();await selectPDFAnnotation(a.id,{scrollComment:true});}}}
function pdfRoute(){if(!location.hash.startsWith('#pdf='))return;const q=new URLSearchParams(location.hash.slice(1));openPDF(q.get('pdf'),{page:q.get('page'),annotation:q.get('annotation'),push:false}).catch(e=>toast(e.message));}
window.addEventListener('blur',clearPDFAnnotationSelection);
window.addEventListener('popstate',pdfRoute);pdfRoute();
setInterval(()=>{if(PDF.key&&document.body.classList.contains('pdf-mode')&&!document.hidden)refreshPDFAnnotations().catch(()=>{});},3000);
