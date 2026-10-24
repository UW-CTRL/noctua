'use strict';
// Selected passages are composer attachments, independent of saved PDF annotations.
window.NoctuaChatSelections=(()=>{
  const host=document.getElementById('chat-selections'),ranges=new Map();let markerFrame=null;let items=[],pending=null,closeTimer=null,frame=null,highlighting=false;
  const key=()=>`noctua.chatSelections.${chat.provider}:${chat.id||'new'}`;
  const read=storageKey=>{try{const value=JSON.parse(store.get(storageKey)||'[]');return Array.isArray(value)?value.filter(item=>typeof item.text==='string'&&item.text.trim()&&item.text.length<=12000&&item.source&&typeof item.source.label==='string').slice(0,20):[];}catch{return [];}};
  const persist=()=>store.set(key(),JSON.stringify(items));
  const sourceLabel=item=>item.source.label+(item.source.page?` · Page ${item.source.page}${item.source.page_end&&item.source.page_end!==item.source.page?'–'+item.source.page_end:''}`:'');
  const entries=(passages,editable)=>passages.map((item,index)=>`<article class="chat-selection-entry" data-quote-id="${esc(item.id||'')}"><div><small>${index+1}. ${esc(sourceLabel(item))}</small>${editable?`<button type="button" data-quote-remove="${esc(item.id)}" data-icon="trash-2" data-icon-only aria-label="Remove selection ${index+1}" title="Remove selection"></button>`:''}</div><blockquote>${esc(item.text)}</blockquote></article>`).join('');
  const showPreview=show=>{const panel=host.querySelector('.chat-selection-preview'),button=host.querySelector('[data-quote-preview]');if(panel){panel.hidden=!show;button.setAttribute('aria-expanded',String(show));if(show){const anchor=host.getBoundingClientRect();panel.style.left=Math.max(12,Math.min(anchor.left,innerWidth-panel.offsetWidth-12))+'px';panel.style.top=Math.max(12,anchor.top-panel.offsetHeight-8)+'px';}}};
  function render(){
    const open=host.querySelector('.chat-selection-preview')?.hidden===false;host.hidden=!items.length;
    host.innerHTML=items.length?`<div class="chat-selection-chip"><button type="button" data-quote-preview data-icon="message-square" aria-expanded="${open}" aria-controls="chat-selection-preview">${items.length} ${items.length===1?'annotation':'annotations'}</button><button type="button" data-quote-clear data-icon="x" data-icon-only aria-label="Remove all selections" title="Remove all selections"></button></div><div id="chat-selection-preview" class="chat-selection-preview" ${open?'':'hidden'}>${entries(items,true)}</div>`:'';
    if(open)showPreview(true);scheduleMarkers();
  }
  function restore(){items=read(key());ranges.clear();render();}
  function add(passage){
    if(items.length>=20||passage.text.length>12000||items.reduce((sum,item)=>sum+item.text.length,0)+passage.text.length>40000){toast('Attach up to 20 passages, with at most 12,000 characters each and 40,000 in total.',{error:true});return;}
    if(!items.some(item=>item.text===passage.text&&JSON.stringify(item.source)===JSON.stringify(passage.source)&&JSON.stringify(item.anchor)===JSON.stringify(passage.anchor))){const item={text:passage.text,source:passage.source,id:crypto.randomUUID(),...(passage.anchor?{anchor:passage.anchor}:{})};items.push(item);if(passage.range)ranges.set(item.id,passage.range.cloneRange());persist();render();}
    if(passage.source.kind==='pdf'&&typeof PDF!=='undefined'&&PDF.key===passage.source.paper_key){PDF.selection=null;updateChatContext();}
    hideAction();getSelection().removeAllRanges();showRightTab('chat');document.getElementById('chat-input').focus();
  }
  const markers=document.createElement('div');markers.id='chat-selection-markers';document.body.append(markers);
  function captureAnchor(range,start,end,source){
    if(source.kind==='pdf'){
      const pages=[];
      for(const box of document.querySelectorAll('#pdf-stage .pdf-page')){
        const layer=box.querySelector('.textLayer');if(!layer||!range.intersectsNode(layer))continue;
        const selected=range.cloneRange();if(!layer.contains(selected.startContainer))selected.setStart(layer,0);if(!layer.contains(selected.endContainer))selected.setEnd(layer,layer.childNodes.length);
        const bounds=box.getBoundingClientRect();if(!bounds.width||!bounds.height)continue;
        const rects=[...selected.getClientRects()].filter(rect=>rect.width&&rect.height).map(rect=>normalizedRect(rect,bounds));
        if(rects.length)pages.push({page:Number(box.dataset.page),rects});
      }
      const last=pages[pages.length-1];return last?{kind:'pdf',page:last.page,rect:last.rects[last.rects.length-1],pages}:null;
    }
    let root=null,anchor={kind:'text',scope:source.kind};
    if(source.kind==='note'){
      const block=start.closest('.nb'),last=end.closest('.nb');
      if(block&&block===last){anchor.block=block.dataset.id;root=block.querySelector('.nb-view');}else root=document.querySelector('#notes-stage .note-blocks');
    }else if(source.kind==='chat'){
      const first=start.closest('.msg'),last=end.closest('.msg');if(first!==last)return null;
      anchor.message=[...document.querySelectorAll('#chat-log .msg')].indexOf(first);root=first;
    }else if(source.kind==='paper'){root=document.getElementById('details');anchor.view=typeof lib!=='undefined'&&lib.detail?.key||null;}
    if(!root||!root.contains(range.startContainer)||!root.contains(range.endContainer))return null;
    const prefix=range.cloneRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset);
    anchor.start=prefix.toString().length;anchor.selected=range.toString();anchor.end=anchor.start+anchor.selected.length;return anchor;
  }
  function textRoot(item){
    const anchor=item.anchor;
    if(anchor.scope==='note'){
      if(typeof N==='undefined'||N.doc?.id!==item.source.note_id||N.target!==item.source.folder_id)return null;
      return anchor.block?[...document.querySelectorAll('#notes-stage .nb')].find(block=>block.dataset.id===anchor.block)?.querySelector('.nb-view'):document.querySelector('#notes-stage .note-blocks');
    }
    if(anchor.scope==='chat'){
      if(item.source.chat_id&&item.source.chat_id!==chat.id)return null;
      return document.querySelectorAll('#chat-log .msg')[anchor.message];
    }
    if(anchor.scope==='paper'){
      if(anchor.view&&(typeof lib==='undefined'||lib.detail?.key!==anchor.view))return null;
      return document.getElementById('details');
    }
    return null;
  }
  function restoreRange(item){
    const root=textRoot(item);if(!root)return null;const anchor=item.anchor,text=root.textContent;
    let start=anchor.start,end=anchor.end;
    if(text.slice(start,end)!==anchor.selected){start=text.indexOf(anchor.selected);if(start<0||text.indexOf(anchor.selected,start+1)>=0)return null;end=start+anchor.selected.length;}
    const range=rangeForOffsets(root,start,end);if(range)ranges.set(item.id,range);return range;
  }
  function rangeForOffsets(root,start,end){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),range=document.createRange();let node,offset=0,found=false;
    while((node=walker.nextNode())){const next=offset+node.textContent.length;if(!found&&start>=offset&&start<next){range.setStart(node,start-offset);found=true;}if(found&&end<=next){range.setEnd(node,end-offset);return range;}offset=next;}
    return null;
  }
  function recoverAnchor(item){
    let roots=[];const source=item.source;
    if(source.kind==='pdf'&&typeof PDF!=='undefined'&&PDF.key===source.paper_key){const root=pdfPageBox(source.page)?.querySelector('.textLayer');if(root)roots=[root];}
    else if(source.kind==='chat'&&(!source.chat_id||source.chat_id===chat.id))roots=[...document.querySelectorAll('#chat-log .msg')];
    else if(source.kind==='note'&&typeof N!=='undefined'&&N.doc?.id===source.note_id&&N.target===source.folder_id)roots=[...document.querySelectorAll('#notes-stage .nb-view')];
    else if(source.kind==='paper'){const root=document.getElementById('details');if(root?.textContent.includes(source.label))roots=[root];}
    const matches=roots.map(root=>({root,start:root.textContent.indexOf(item.text)})).filter(match=>match.start>=0);
    if(matches.length!==1)return null;const {root,start}=matches[0];if(root.textContent.indexOf(item.text,start+1)>=0)return null;
    const range=rangeForOffsets(root,start,start+item.text.length);if(!range)return null;
    const anchor=captureAnchor(range,range.startContainer.parentElement,range.endContainer.parentElement,source);if(anchor)ranges.set(item.id,range);return anchor;
  }
  function markerLocation(item){
    if(!item.anchor){const recovered=recoverAnchor(item);if(!recovered)return null;item.anchor=recovered;persist();}
    const anchor=item.anchor;
    if(anchor.kind==='pdf'){
      if(typeof PDF==='undefined'||PDF.key!==item.source.paper_key)return null;
      if(!Array.isArray(anchor.rect)||anchor.rect.length!==4||anchor.rect.some(value=>!Number.isFinite(value)))return null;
      const box=pdfPageBox(anchor.page);if(!box?.querySelector('.textLayer'))return null;
      const bounds=box.getBoundingClientRect(),rects=anchor.pages?.find(page=>page.page===anchor.page)?.rects||[anchor.rect],right=Math.max(...rects.map(rect=>rect[0]+rect[2]));
      const side=right<=.52?'left':'right',left=Math.min(...rects.map(rect=>rect[0])),top=Math.min(...rects.map(rect=>rect[1])),bottom=Math.max(...rects.map(rect=>rect[1]+rect[3]));
      return {left:side==='left'?bounds.left+4:bounds.right-28,top:bounds.top+top*bounds.height,bottom:bounds.top+bottom*bounds.height,root:box,margin:true,marginCandidates:side==='left'?[bounds.left+4,bounds.left+left*bounds.width-32,bounds.right-28,bounds.left+right*bounds.width+8]:[bounds.right-28,bounds.left+right*bounds.width+8,bounds.left+4,bounds.left+left*bounds.width-32]};
    }
    if(!textRoot(item))return null;
    let range=ranges.get(item.id);
    if(!range?.startContainer.isConnected||range.toString()!==anchor.selected)range=restoreRange(item);
    const rect=range&&[...range.getClientRects()].filter(rect=>rect.width&&rect.height).pop();
    return rect?{left:rect.right,top:rect.top,bottom:rect.bottom,root:range.startContainer.parentElement}:null;
  }
  function paintSourceHighlights(){
    const pdfRects=new Map(),textRanges=[];
    for(const item of items){
      const anchor=item.anchor;if(!anchor)continue;
      if(anchor.kind==='pdf'){
        if(typeof PDF==='undefined'||PDF.key!==item.source.paper_key)continue;
        if(!anchor.pages){const recovered=recoverAnchor(item);if(recovered){item.anchor=recovered;persist();}}
        for(const page of item.anchor.pages||[{page:anchor.page,rects:[anchor.rect]}]){
          const rects=(page.rects||[]).filter(rect=>Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite));
          const groups=pdfRects.get(page.page)||{text:[],region:[]};groups[item.source.region_kind?'region':'text'].push(...rects);pdfRects.set(page.page,groups);
        }
      }else{
        const root=textRoot(item);if(!root||!root.getClientRects().length)continue;
        let range=ranges.get(item.id);if(!range?.startContainer.isConnected||range.toString()!==anchor.selected)range=restoreRange(item);
        if(range)textRanges.push(range);
      }
    }
    if(globalThis.CSS?.highlights&&globalThis.Highlight){if(textRanges.length)CSS.highlights.set('chat-attachments',new Highlight(...textRanges));else CSS.highlights.delete('chat-attachments');}
    for(const box of document.querySelectorAll('#pdf-stage .pdf-page')){
      const groups=pdfRects.get(Number(box.dataset.page));let svg=box.querySelector('.chat-source-highlights');
      if(!groups||!box.querySelector('.textLayer')){svg?.remove();continue;}
      if(!svg){svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('chat-source-highlights');svg.setAttribute('viewBox','0 0 1 1');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');box.append(svg);}
      const bounds=box.getBoundingClientRect();
      const markup=['region','text'].filter(kind=>groups[kind].length).map(kind=>'<g fill="var(--accent)" opacity="'+(kind==='region'?'0.08':'0.18')+'">'+mergePDFHighlightRects(groups[kind],bounds.height/bounds.width).map(([x,y,width,height])=>`<rect x="${x}" y="${y}" width="${width}" height="${height}"/>`).join('')+'</g>').join('');
      if(svg.innerHTML!==markup)svg.innerHTML=markup;
    }
  }
  function scheduleMarkers(){if(markerFrame===null)markerFrame=requestAnimationFrame(paintMarkers);}
  function paintMarkers(){
    markerFrame=null;const ids=new Set(items.map(item=>item.id));for(const id of ranges.keys())if(!ids.has(id))ranges.delete(id);
    const badges=[],occupied=[...document.querySelectorAll('#pdf-stage .pdf-auto-tag,#pdf-stage .textLayer span')].filter(element=>!element.querySelector('span')).map(element=>element.getBoundingClientRect()).filter(rect=>rect.width&&rect.height),existing=new Map([...markers.children].map(button=>[button.dataset.chatSelectionMarker,button]));
    items.forEach((item,index)=>{
      const location=markerLocation(item);if(!location||!location.root?.getClientRects().length)return;
      const scroller=location.root.closest('.pdf-scroll,#notes-stage,#chat-log,#details'),clip=scroller?.getBoundingClientRect()||{left:0,right:innerWidth,top:0,bottom:innerHeight};
      if(location.bottom<=Math.max(0,clip.top)||location.top>=Math.min(innerHeight,clip.bottom)||!location.margin&&(location.left<clip.left||location.left>clip.right))return;
      let button=existing.get(item.id);if(!button){button=document.createElement('button');button.type='button';button.className='chat-selection-marker';button.dataset.chatSelectionMarker=item.id;}if(button.textContent!==String(index+1))button.textContent=String(index+1);
      button.setAttribute('aria-label',`Show chat annotation ${index+1}`);button.title=`Chat annotation ${index+1}`;
      let left=Math.max(8,Math.min(location.left+(location.margin?0:5),clip.right-27,innerWidth-32));const initialTop=Math.max(clip.top+2,Math.min(location.top-3,clip.bottom-26,innerHeight-30));
      let top=initialTop;
      if(location.margin){
        const offsets=[0,...Array.from({length:20},(_,index)=>[(index+1)*28,-(index+1)*28]).flat()];
        const candidates=(location.marginCandidates||[left]).filter(x=>x>=Math.max(8,clip.left+3)&&x+24<=Math.min(innerWidth-8,clip.right-3)).map((x,index)=>{
          const y=offsets.map(offset=>initialTop+offset).find(y=>y>=Math.max(2,clip.top+2)&&y+24<=Math.min(innerHeight-6,clip.bottom-2)&&!occupied.some(rect=>x<rect.right+3&&x+24>rect.left-3&&y<rect.bottom+3&&y+24>rect.top-3));
          return y===undefined?null:{x,y,score:Math.abs(y-initialTop)+index*2};
        }).filter(Boolean).sort((a,b)=>a.score-b.score);
        if(!candidates.length)return;left=candidates[0].x;top=candidates[0].y;
      }
      occupied.push({left,right:left+24,top,bottom:top+24});button.style.left=left+'px';button.style.top=top+'px';
      button.onclick=()=>{showRightTab('chat');showPreview(true);host.querySelector(`[data-quote-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({block:'nearest'});};badges.push(button);
    });
    paintSourceHighlights();
    const visible=new Set(badges);for(const button of [...markers.children])if(!visible.has(button))button.remove();
    for(const button of badges)if(!button.isConnected)markers.append(button);
  }
  const observer=new MutationObserver(scheduleMarkers);
  observer.observe(document.body,{attributes:true,subtree:true,attributeFilter:['class','hidden']});
  for(const selector of ['#pdf-stage','#notes-stage','#chat-log','#details']){const root=document.querySelector(selector);if(root)observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','hidden']});}
  const action=document.createElement('div');action.id='selection-add-chat';action.hidden=true;document.body.append(action);
  function hideAction(){action.hidden=true;pending=null;}
  function inspectSelection(){
    frame=null;if(highlighting)return;const selection=getSelection();if(!selection?.rangeCount||selection.isCollapsed){hideAction();return;}
    const range=selection.getRangeAt(0),start=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement,end=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement;
    if(!start||!end||start.closest('textarea,input,[contenteditable="true"],#chat-selections,#selection-add-chat')||end.closest('textarea,input,[contenteditable="true"]')){hideAction();return;}
    const text=selection.toString().trim();if(!text){hideAction();return;}
    let source=null;
    const pdfStart=start.closest('#pdf-stage .textLayer'),pdfEnd=end.closest('#pdf-stage .textLayer');
    if(pdfStart&&pdfEnd&&typeof PDF!=='undefined')source={kind:'pdf',label:PDF.paper?.title||'PDF',paper_key:PDF.key,page:Number(pdfStart.closest('.pdf-page').dataset.page),page_end:Number(pdfEnd.closest('.pdf-page').dataset.page)};
    else if(start.closest('#notes-stage .nb-body')&&end.closest('#notes-stage .nb-body')&&typeof N!=='undefined'&&N.doc)source={kind:'note',label:N.doc.title||'Untitled note',note_id:N.doc.id,folder_id:N.target};
    else if(start.closest('#chat-log .msg')&&end.closest('#chat-log .msg'))source={kind:'chat',label:'Chat excerpt',chat_id:chat.id};
    else if(start.closest('#details')&&end.closest('#details'))source={kind:'paper',label:typeof lib!=='undefined'&&lib.detail?.title||'Paper details'};
    if(!source){hideAction();return;}
    source.label=source.label.slice(0,500);pending={text,source,range:range.cloneRange(),anchor:captureAnchor(range,start,end,source)};
    if(source.kind==='pdf'&&source.page===source.page_end){const bounds=pdfStart.closest('.pdf-page').getBoundingClientRect();pending.rects=[...range.getClientRects()].map(rect=>normalizedRect(rect,bounds)).filter(rect=>rect[2]>0&&rect[3]>0);}
    action.innerHTML='<button type="button" data-add-selection>Add to chat</button>'+(pending.rects?.length?`<div class="selection-highlight-colors" role="group" aria-label="Highlight selection">${pdfColors.map((color,index)=>`<button type="button" data-selection-highlight="${color}" style="--swatch:${color}" aria-label="Highlight with color ${index+1}" title="Highlight selection"></button>`).join('')}</div>`:'');
    const rects=[...range.getClientRects()].filter(rect=>rect.width&&rect.height&&rect.bottom>0&&rect.top<innerHeight);if(!rects.length){hideAction();return;}
    const rect=rects[rects.length-1];action.hidden=false;
    action.style.left=Math.max(8,Math.min((rect.left+rect.right)/2-action.offsetWidth/2,innerWidth-action.offsetWidth-8))+'px';
    action.style.top=Math.max(8,Math.min(rect.bottom+6,innerHeight-action.offsetHeight-8))+'px';
  }
  action.onpointerdown=event=>event.preventDefault();action.onclick=async event=>{
    if(!pending||highlighting)return;const passage=pending,color=event.target.closest('[data-selection-highlight]')?.dataset.selectionHighlight;
    if(!color){if(event.target.closest('[data-add-selection]'))add(passage);return;}
    highlighting=true;const controls=[...action.querySelectorAll('button')];controls.forEach(button=>button.disabled=true);
    try{
      const annotation=await pdfSave(api(paperURL(passage.source.paper_key)+'/annotations',{kind:'highlight',page:passage.source.page,quote:passage.text,rects:passage.rects,color,comment:''}));
      if(PDF.key===passage.source.paper_key){PDF.selection=null;PDF.selected=annotation.id;if(!pdfAnnotationMatchesFilter(annotation,PDF.annotationFilter))setPDFAnnotationFilter(null);await refreshPDFAnnotations();}
      if(pending===passage){hideAction();getSelection().removeAllRanges();}
    }catch(error){toast(error.message,{error:true});}finally{highlighting=false;controls.forEach(button=>button.disabled=false);}
  };
  document.addEventListener('pointerup',event=>{if(event.button===0&&!event.noctuaObjectSelection&&!event.target.closest('#selection-add-chat,#chat-selections'))setTimeout(inspectSelection,0);});
  document.addEventListener('selectionchange',()=>{if(action.hidden)return;if(frame!==null)cancelAnimationFrame(frame);frame=requestAnimationFrame(inspectSelection);});
  document.addEventListener('keyup',event=>{if(event.key==='Escape'){hideAction();showPreview(false);}else if(event.shiftKey||event.key==='Shift')inspectSelection();});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#selection-add-chat'))hideAction();if(!event.target.closest('#chat-selections'))showPreview(false);},true);
  document.addEventListener('scroll',()=>{hideAction();scheduleMarkers();},true);window.addEventListener('resize',()=>{hideAction();showPreview(false);scheduleMarkers();});
  host.onpointerenter=()=>{clearTimeout(closeTimer);showPreview(true);};host.onpointerleave=()=>{closeTimer=setTimeout(()=>showPreview(false),250);};
  host.onclick=event=>{
    const remove=event.target.closest('[data-quote-remove]');
    if(remove){items=items.filter(item=>item.id!==remove.dataset.quoteRemove);persist();render();host.querySelector('[data-quote-preview]')?.focus();}
    else if(event.target.closest('[data-quote-clear]')){items=[];persist();render();document.getElementById('chat-input').focus();}
    else if(event.target.closest('[data-quote-preview]')){clearTimeout(closeTimer);showPreview(true);}
  };
  host.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();showPreview(false);host.querySelector('[data-quote-preview]')?.focus();}};
  window.addEventListener('storage',event=>{if(event.key===key()||event.key===null)restore();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',restore,{once:true});else restore();
  return {restore,add,storageKey:key,moveDraft:previousKey=>{if(previousKey&&previousKey!==key()){const merged=new Map([...read(key()),...read(previousKey)].map(item=>[item.id,item]));store.set(key(),JSON.stringify([...merged.values()]));store.set(previousKey,'[]');}restore();},count:()=>items.length,snapshot:()=>({key:key(),items:structuredClone(items.map(({anchor,...item})=>item))}),consume:snapshot=>{
    const sent=new Set(snapshot.items.map(item=>item.id)),remaining=read(snapshot.key).filter(item=>!sent.has(item.id));store.set(snapshot.key,JSON.stringify(remaining));if(key()===snapshot.key){items=remaining;render();}
  },sentHTML:passages=>Array.isArray(passages)&&passages.length?`<details class="chat-sent-selections"><summary>${passages.length} ${passages.length===1?'annotation':'annotations'}</summary>${entries(passages,false)}</details>`:''};
})();
