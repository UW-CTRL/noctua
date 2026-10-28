'use strict';
// View-local Find. Search never edits notes or creates PDF annotations.
const DocFind={options:{matchCase:false,regex:false,wholeWord:false},scope:null,hits:[],index:-1,sequence:0,timer:null,range:null,textHit:null,observers:[]};
function findOccurrences(text,query,limit=1000,options={}){
 const boundary=(start,end)=>!options.wholeWord||(!/[\p{L}\p{N}\p{M}_]$/u.test(text.slice(Math.max(0,start-2),start))&&!/^[\p{L}\p{N}\p{M}_]/u.test(text.slice(end,end+2)));
 if(options.regex){
  let expression;try{expression=new RegExp(query,options.matchCase?'gu':'giu');}catch{throw Error('Invalid regular expression');}
  const hits=[];let match;while(hits.length<limit&&(match=expression.exec(text))){if(!match[0].length){expression.lastIndex=match.index+(text.codePointAt(match.index)>0xffff?2:1);continue;}if(boundary(match.index,match.index+match[0].length))hits.push({start:match.index,end:match.index+match[0].length});}return hits;
 }
 const normalize=value=>{let result='',starts=[],ends=[],space=false;for(let i=0;i<value.length;i++){const c=value[i],white=/\s/.test(c);if(white&&space){ends[ends.length-1]=i+1;continue;}const lowered=white?' ':options.matchCase?c:c.toLowerCase();for(const char of lowered){result+=char;starts.push(i);ends.push(i+1);}space=white;}return {text:result,starts,ends};};
 const input=normalize(text),needle=normalize(query).text.trim(),hits=[];if(!needle)return hits;
 let offset=0;while(hits.length<limit){const at=input.text.indexOf(needle,offset);if(at<0)break;const start=input.starts[at],end=input.ends[at+needle.length-1];if(boundary(start,end))hits.push({start,end});offset=at+needle.length;}return hits;
}
function findCurrentScope(){
 if(document.body.classList.contains('pdf-mode')&&PDF.key&&lastSplitSide()!=='notes')return {kind:'reader',id:PDF.key,label:'PDF + user comments'};
 if(!isNotesMode())return null;
 const source=$('#workspace-editor textarea');if(W.file&&source)return {kind:'source',id:W.target+':'+W.file,ta:source,label:'File source'};
 if(!N.doc)return null;
 const ta=N.editing?document.querySelector(`#notes-stage .nb[data-id="${CSS.escape(N.editing)}"] textarea`):null;
 return ta?{kind:'cell',id:N.doc.id+':'+N.editing,ta,label:'Selected cell'}:{kind:'note',id:N.doc.id,label:'Rendered note'};
}
function findScopeValid(){const current=findCurrentScope(),scope=DocFind.scope;return !!scope&&current?.kind===scope.kind&&current.id===scope.id&&(!scope.ta||scope.ta.isConnected);}
function closeDocumentFind(restore=true){
 const scope=DocFind.scope;DocFind.sequence++;clearTimeout(DocFind.timer);DocFind.observers.forEach(o=>o.disconnect());DocFind.observers=[];DocFind.scope=null;DocFind.range=null;DocFind.textHit=null;DocFind.hits=[];
 $('#document-find')?.remove();$('#document-find-overlay')?.remove();document.querySelectorAll('.document-find-pdf').forEach(e=>e.remove());
 if(restore&&scope?.ta?.isConnected)scope.ta.focus();
}
function openDocumentFind(){
 if($('#document-find')&&findScopeValid()){$('#document-find input').focus();$('#document-find input').select();return;}
 closeDocumentFind(false);const scope=findCurrentScope();if(!scope)return;DocFind.scope=scope;
 const bar=document.createElement('div');bar.id='document-find';bar.setAttribute('role','search');bar.innerHTML=`<span>${esc(scope.label)}</span><input type="search" aria-label="Find in ${esc(scope.label)}" placeholder="Find…" autocomplete="off">${[['matchCase','Aa','Match case'],['regex','.*','Regular expression'],['wholeWord','W','Whole word']].map(([key,text,label])=>`<button data-find-option="${key}" aria-label="${label}" title="${label}" aria-pressed="${DocFind.options[key]}">${text}</button>`).join('')}<span data-find-count role="status">0 / 0</span><button data-find-prev data-icon="arrow-up" data-icon-only aria-label="Previous match"></button><button data-find-next data-icon="arrow-down" data-icon-only aria-label="Next match"></button><button data-find-close data-icon="x" data-icon-only aria-label="Close find"></button>`;
 document.body.appendChild(bar);const input=bar.querySelector('input');
 bar.querySelectorAll('[data-find-option]').forEach(button=>button.onclick=()=>{const key=button.dataset.findOption;DocFind.options[key]=!DocFind.options[key];button.setAttribute('aria-pressed',String(DocFind.options[key]));clearTimeout(DocFind.timer);refreshDocumentFind();});
 input.oninput=()=>{clearTimeout(DocFind.timer);DocFind.timer=setTimeout(()=>refreshDocumentFind(),100);};
 input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();moveDocumentFind(e.shiftKey?-1:1);}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeDocumentFind();}};
 bar.querySelector('[data-find-prev]').onclick=()=>moveDocumentFind(-1);bar.querySelector('[data-find-next]').onclick=()=>moveDocumentFind(1);bar.querySelector('[data-find-close]').onclick=()=>closeDocumentFind();
 const observer=new MutationObserver(records=>{
  const changed=records.some(r=>!r.target.closest?.('.document-find-pdf')&&(r.type==='characterData'||[...r.addedNodes,...r.removedNodes].some(n=>!n.classList?.contains('document-find-pdf'))));
  if(!changed)return;if(!findScopeValid()){closeDocumentFind(false);return;}paintDocumentFind();
  if(DocFind.scope.kind==='note'||records.some(r=>r.target.closest?.('#pdf-sidebar'))){clearTimeout(DocFind.timer);DocFind.timer=setTimeout(()=>refreshDocumentFind(),180);}
 });
 for(const node of [$('#notes-stage'),$('#pdf-stage'),$('#pdf-sidebar')].filter(Boolean))observer.observe(node,{childList:true,subtree:true,characterData:true});
 const modeObserver=new MutationObserver(()=>{if(!findScopeValid())closeDocumentFind(false);});modeObserver.observe(document.body,{attributes:true,attributeFilter:['class']});DocFind.observers=[observer,modeObserver];
 if(scope.ta){const selected=scope.ta.value.slice(scope.ta.selectionStart,scope.ta.selectionEnd);if(selected&&!selected.includes('\n'))input.value=selected;}
 input.focus();input.select();refreshDocumentFind();
}
function findRenderedText(root){
 const nodes=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(node){
  const p=node.parentElement;if(!node.textContent||p.closest('.katex-mathml,.nb-tools,button,textarea,script,style,[hidden],.tex-video,.tex-youtube'))return NodeFilter.FILTER_REJECT;
  if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return NodeFilter.FILTER_REJECT;return NodeFilter.FILTER_ACCEPT;
 }});let text='',node,previousBlock=null;
 while((node=walker.nextNode())){const block=node.parentElement.closest('p,li,div,h1,h2,h3,h4,h5,h6,blockquote,td');if(previousBlock&&previousBlock!==block)text+='\n';previousBlock=block;nodes.push({node,start:text.length,end:text.length+node.textContent.length});text+=node.textContent;}
 return {text,nodes,root};
}
function readerCommentSources(){
 const result=[];for(const a of PDF.annotations||[]){const edit=typeof pdfCommentEdits!=='undefined'?pdfCommentEdits.get(a.id):null;
  const changed=edit&&edit.value!==edit.base;if(changed||(a.comment_author||a.author)==='user')result.push({text:edit?.value??a.comment??'',annotation:a.id,page:a.page,reply:null});
  for(const reply of a.replies||[])if(reply.author==='user')result.push({text:reply.comment||'',annotation:a.id,page:a.page,reply:reply.id});
 }return result;
}
async function refreshDocumentFind(){
 if(!findScopeValid()){closeDocumentFind(false);return;}
 const sequence=++DocFind.sequence,scope=DocFind.scope,query=$('#document-find input').value;DocFind.hits=[];DocFind.index=-1;DocFind.range=null;DocFind.textHit=null;paintDocumentFind();
 if(!query.trim()){findCount();return;}const hits=[];const add=(text,details)=>{for(const match of findOccurrences(text,query,1000-hits.length,DocFind.options))hits.push({...details,...match});};
 try{
  if(scope.ta)add(scope.ta.value,{kind:'textarea',ta:scope.ta,label:scope.label});
  else if(scope.kind==='note')for(const root of document.querySelectorAll('#notes-stage .nb-view')){const rendered=findRenderedText(root);add(rendered.text,{kind:'dom',rendered,label:'Rendered note'});}
  else if(scope.kind==='reader'){
   $('[data-find-count]').textContent='Searching…';const index=await indexPDF(scope.id);if(sequence!==DocFind.sequence||!findScopeValid())return;
   for(const page of index.pages||[])add(page.text||'',{kind:'pdf',page:page.page,words:page.words||[],label:`PDF · page ${page.page}`});
   for(const source of readerCommentSources())add(source.text,{kind:'comment',...source,label:`User comment · page ${source.page}`});
  }
  if(sequence!==DocFind.sequence||!findScopeValid())return;DocFind.hits=hits;DocFind.index=hits.length?0:-1;await showDocumentFind(sequence);
 }catch(e){if(sequence===DocFind.sequence&&$('#document-find'))$('[data-find-count]').textContent=e.message;}
}
function findCount(){const label=$('[data-find-count]');if(!label)return;const hit=DocFind.hits[DocFind.index];label.textContent=`${DocFind.index+1} / ${DocFind.hits.length}${DocFind.hits.length===1000?'+':''}${hit?' · '+hit.label:''}`;for(const b of document.querySelectorAll('[data-find-prev],[data-find-next]'))b.disabled=!DocFind.hits.length;}
function moveDocumentFind(delta){if(!findScopeValid()){closeDocumentFind(false);return;}if(!DocFind.hits.length)return;DocFind.index=(DocFind.index+delta+DocFind.hits.length)%DocFind.hits.length;showDocumentFind(++DocFind.sequence).catch(e=>{if($('[data-find-count]'))$('[data-find-count]').textContent=e.message;});}
function selectFindText(ta,start,end){
 ta.setSelectionRange(start,end);const line=ta.value.slice(0,start).split('\n').length-1,height=parseFloat(getComputedStyle(ta).lineHeight)||20;ta.scrollTop=Math.max(0,line*height-ta.clientHeight/2);
 if(typeof caretXY==='function'){let point=caretXY(ta),bounds=ta.getBoundingClientRect();ta.scrollTop+=point.y-bounds.top-ta.clientHeight/2;
  for(let parent=ta.parentElement;parent;parent=parent.parentElement)if(/auto|scroll/.test(getComputedStyle(parent).overflow)&&parent.scrollHeight>parent.clientHeight){point=caretXY(ta);bounds=parent.getBoundingClientRect();parent.scrollTop+=point.y-bounds.top-parent.clientHeight/2;}
 }
}
async function showDocumentFind(sequence){
 const hit=DocFind.hits[DocFind.index];DocFind.range=null;DocFind.textHit=null;findCount();paintDocumentFind();if(!hit)return;
 if(hit.kind==='textarea'){DocFind.textHit={ta:hit.ta,start:hit.start,end:hit.end};selectFindText(hit.ta,hit.start,hit.end);}
 if(hit.kind==='dom'){
  const start=hit.rendered.nodes.find(n=>n.end>hit.start),end=hit.rendered.nodes.find(n=>n.end>=hit.end);if(!start||!end)return;
  const range=document.createRange();range.setStart(start.node,hit.start-start.start);range.setEnd(end.node,hit.end-end.start);DocFind.range=range;
  start.node.parentElement.scrollIntoView({block:'center',inline:'nearest'});
 }
 if(hit.kind==='pdf'){
  const word=hit.words.find(w=>w.end>hit.start&&w.start<hit.end);await pdfNavigate(hit.page,word?.rect?.[1]||0);
 }
 if(hit.kind==='comment'){
  await selectPDFAnnotation(hit.annotation,{scrollComment:true});if(sequence!==DocFind.sequence||!findScopeValid())return;
  const card=document.querySelector(`#pdf-sidebar article[data-id="${CSS.escape(hit.annotation)}"]`);
  if(hit.reply){const node=card?.querySelector(`.pdf-comment-history[data-reply-id="${CSS.escape(hit.reply)}"] .tex-view`);node?.scrollIntoView({block:'center'});if(node){const range=document.createRange();range.selectNodeContents(node);DocFind.range=range;}}
  else{const ta=card?.querySelector('textarea');if(ta){DocFind.textHit={ta,start:hit.start,end:hit.end};selectFindText(ta,hit.start,hit.end);}}
 }
 if(sequence===DocFind.sequence&&findScopeValid())paintDocumentFind();
}
function paintDocumentFind(){
 // Replace only our own overlay; never wrap text inside a KaTeX or PDF.js layer.
 $('#document-find-overlay')?.remove();document.querySelectorAll('.document-find-pdf').forEach(e=>e.remove());
 if(!DocFind.scope)return;const hit=DocFind.hits[DocFind.index];
 if(hit?.kind==='pdf'){
  const entry=typeof pdfPageEntries!=='undefined'?pdfPageEntries.find(e=>e.number===hit.page):null;if(!entry?.box)return;
  const layer=document.createElement('div');layer.className='document-find-pdf';
  for(const word of hit.words.filter(w=>w.end>hit.start&&w.start<hit.end)){const rect=word.rect,mark=document.createElement('i');mark.style.cssText=`left:${rect[0]*100}%;top:${rect[1]*100}%;width:${rect[2]*100}%;height:${rect[3]*100}%`;layer.appendChild(mark);}entry.box.appendChild(layer);
 }
 let rectangles=[],anchor=null;
 if(DocFind.range?.startContainer.isConnected){rectangles=[...DocFind.range.getClientRects()];anchor=DocFind.range.startContainer.parentElement;}
 if(DocFind.textHit?.ta.isConnected){const {ta,start,end}=DocFind.textHit;anchor=ta;const cs=getComputedStyle(ta),r=ta.getBoundingClientRect(),mirror=document.createElement('div');
  for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','boxSizing','tabSize'])mirror.style[key]=cs[key];
  Object.assign(mirror.style,{position:'fixed',visibility:'hidden',whiteSpace:'pre-wrap',overflowWrap:'break-word',borderStyle:'solid',width:ta.offsetWidth+'px',left:(r.left-ta.scrollLeft)+'px',top:(r.top-ta.scrollTop)+'px'});
  mirror.textContent=ta.value;document.body.appendChild(mirror);if(mirror.firstChild){const range=document.createRange();range.setStart(mirror.firstChild,Math.min(start,ta.value.length));range.setEnd(mirror.firstChild,Math.min(end,ta.value.length));rectangles=[...range.getClientRects()];}mirror.remove();
 }
 if(anchor){const layer=document.createElement('div');layer.id='document-find-overlay';let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
  for(let el=anchor;el;el=el.parentElement){if(el===DocFind.textHit?.ta||/auto|scroll|hidden|clip/.test(getComputedStyle(el).overflow)){const r=el.getBoundingClientRect();clip={left:Math.max(clip.left,r.left),top:Math.max(clip.top,r.top),right:Math.min(clip.right,r.right),bottom:Math.min(clip.bottom,r.bottom)};}}
  for(const r of rectangles){const left=Math.max(r.left,clip.left),top=Math.max(r.top,clip.top),right=Math.min(r.right,clip.right),bottom=Math.min(r.bottom,clip.bottom);if(right<=left||bottom<=top)continue;const mark=document.createElement('i');mark.style.cssText=`left:${left}px;top:${top}px;width:${right-left}px;height:${bottom-top}px`;layer.appendChild(mark);}document.body.appendChild(layer);
 }
}
function toggleTexComments(ta){
 const value=ta.value,start=ta.selectionStart,end=ta.selectionEnd,first=start===0?0:value.lastIndexOf('\n',start-1)+1;
 const boundary=end>start&&value[end-1]==='\n'?end-1:end;let last=value.indexOf('\n',boundary);if(last<0)last=value.length;
 const lines=value.slice(first,last).split('\n'),uncomment=lines.some(line=>/^[\t ]*%/.test(line))&&lines.every(line=>/^[\t ]*%/.test(line)||!line.trim());
 const edits=lines.map(line=>{const indentation=/^[\t ]*/.exec(line)[0].length;if(uncomment){const match=/^([\t ]*)% ?/.exec(line);return match?{line:match[1]+line.slice(match[0].length),at:indentation,delta:-(match[0].length-indentation)}:{line,at:0,delta:0};}return {line:line.slice(0,indentation)+'% '+line.slice(indentation),at:indentation,delta:2};});
 let offset=first;const changes=edits.map((edit,i)=>{const result={at:offset+edit.at,delta:edit.delta};offset+=lines[i].length+1;return result;});
 const map=position=>position+changes.reduce((sum,c)=>sum+(position>=c.at?(c.delta<0?-Math.min(-c.delta,position-c.at):c.delta):0),0);
 ta.setRangeText(edits.map(e=>e.line).join('\n'),first,last,'preserve');ta.setSelectionRange(map(start),map(end));ta.dispatchEvent(new Event('input',{bubbles:true}));
}
document.addEventListener('keydown',e=>{
 if((e.metaKey||e.ctrlKey)&&!e.altKey&&e.key.toLowerCase()==='f'&&!e.target.closest?.('dialog,#setup')){if(findCurrentScope()){e.preventDefault();e.stopImmediatePropagation();openDocumentFind();}return;}
 if(e.key==='Escape'&&DocFind.scope){e.preventDefault();e.stopImmediatePropagation();closeDocumentFind();return;}
 if((e.metaKey||e.ctrlKey)&&!e.altKey&&(e.key==='/'||e.code==='Slash')&&e.target.matches?.('#workspace-editor textarea')&&/\.(tex|cls|sty|bst)$/i.test(W.manifest?.entries.find(entry=>entry.id===W.file)?.name||'')){e.preventDefault();e.stopImmediatePropagation();toggleTexComments(e.target);}
},true);
document.addEventListener('input',e=>{if(DocFind.scope&&!e.target.closest('#document-find')){clearTimeout(DocFind.timer);DocFind.timer=setTimeout(()=>refreshDocumentFind(),180);}});
window.addEventListener('scroll',()=>{if(DocFind.scope)paintDocumentFind();},true);
window.addEventListener('resize',()=>{if(DocFind.scope)paintDocumentFind();});
