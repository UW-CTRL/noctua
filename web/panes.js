'use strict';
// Hide panes without unmounting editors or chat. Saved width and visibility are
// independent so opening a pane restores its previous width and unsaved state.
// Widths are bounded by the window; the center keeps its own minimum.
const PANES={left:{def:320,min:180,max:Infinity},right:{def:360,min:240,max:Infinity}};
function paneCollapsed(side){return $('main').classList.contains(`${side}-collapsed`);}
function setPaneCollapsed(side,collapsed,save=true){
 const main=$('main'),pane=$('#'+side),button=$(`#gutter-${side} button`);
 main.classList.toggle(`${side}-collapsed`,collapsed);pane.inert=collapsed;
 pane.setAttribute('aria-hidden',String(collapsed));
 button.setAttribute('aria-expanded',String(!collapsed));
 button.ariaLabel=`${collapsed?'Show':'Hide'} ${side==='left'?'navigation pane':'chat and details pane'}`;
 button.title=`${button.ariaLabel} (${side==='left'?'⌘B / Ctrl+B':'⌘⌥B / Ctrl+Alt+B'})`;
 button.setAttribute('aria-keyshortcuts',side==='left'?'Meta+B Control+B':'Meta+Alt+B Control+Alt+B');
 button.dataset.icon=(side==='left')!==collapsed?'chevron-left':'chevron-right';
 if(collapsed&&pane.contains(document.activeElement))button.focus();
 if(save)store.set(`noctua.pane.${side}.collapsed`,String(collapsed));
 window.dispatchEvent(new Event('resize'));
}
function setPaneWidth(side,w,save=true){
 const p=PANES[side],other=side==='left'?'right':'left';
 const otherW=paneCollapsed(other)?0:parseFloat(getComputedStyle($('main')).getPropertyValue(`--${other}-w`))||PANES[other].def;
 w=Math.round(Math.max(p.min,Math.min(p.max,w,$('main').clientWidth-otherW-320-32)));
 $('main').style.setProperty(`--${side}-w`,w+'px');
 if(save)store.set(`noctua.pane.${side}`,String(w));
}
for(const side of ['left','right']){
 const g=$(`#gutter-${side}`),button=document.createElement('button');
 button.className='pane-toggle';button.dataset.iconOnly='';button.setAttribute('aria-controls',side);g.appendChild(button);
 button.onclick=()=>setPaneCollapsed(side,!paneCollapsed(side));
 setPaneCollapsed(side,store.get(`noctua.pane.${side}.collapsed`)==='true',false);
 g.title='Drag to resize; use the arrow to hide or show';
 g.addEventListener('pointerdown',e=>{
  if(e.target.closest('button')||e.button!==0)return;
  e.preventDefault();g.setPointerCapture(e.pointerId);g.classList.add('dragging');document.body.classList.add('resizing');
  if(paneCollapsed(side))setPaneCollapsed(side,false);
  const main=$('main'),rect=main.getBoundingClientRect(),other=side==='left'?'right':'left';
  const otherWidth=paneCollapsed(other)?0:parseFloat(getComputedStyle(main).getPropertyValue(`--${other}-w`))||PANES[other].def;
  const max=Math.max(PANES[side].min,Math.min(PANES[side].max,rect.width-otherWidth-320-32));
  let pending=null,frame=null,finished=false;
  const apply=()=>{frame=null;if(pending!==null)main.style.setProperty(`--${side}-w`,Math.round(Math.max(PANES[side].min,Math.min(max,pending)))+'px');};
  const move=ev=>{pending=side==='left'?ev.clientX-rect.left:rect.right-ev.clientX;if(frame===null)frame=requestAnimationFrame(apply);};
  const up=ev=>{if(finished)return;finished=true;if(frame!==null)cancelAnimationFrame(frame);apply();g.removeEventListener('pointermove',move);for(const type of ['pointerup','pointercancel','lostpointercapture'])g.removeEventListener(type,up);g.classList.remove('dragging');document.body.classList.remove('resizing');if(g.hasPointerCapture(ev.pointerId))g.releasePointerCapture(ev.pointerId);store.set(`noctua.pane.${side}`,main.style.getPropertyValue(`--${side}-w`).replace('px',''));window.dispatchEvent(new Event('noctua-pane-resize-end'));};
  g.addEventListener('pointermove',move);
  for(const type of ['pointerup','pointercancel','lostpointercapture'])g.addEventListener(type,up);
 });
 g.addEventListener('dblclick',e=>{if(!e.target.closest('button')){setPaneCollapsed(side,false);setPaneWidth(side,PANES[side].def);}});
}

// Restore widths after both visibility flags, so a hidden neighbor takes no space.
for(const side of ["left","right"]){const saved=Number(store.get(`noctua.pane.${side}`));if(saved)setPaneWidth(side,saved,false);}

// Split view: the open note sits beside the PDF (Reader) or beside the Library,
// Graph or Lineage view in the center column. Each mode remembers whether its
// split is open; the ratio is the main view's share of the column, and each
// side keeps a usable minimum.
const SPLIT={def:.5,min:240,step:.02};
const libraryMode=()=>!document.body.classList.contains('pdf-mode')&&!document.body.classList.contains('notes-mode');
const splitClass=()=>libraryMode()?'split-library':'split-view';
const splitViewActive=()=>(document.body.classList.contains('pdf-mode')&&document.body.classList.contains('split-view'))||(libraryMode()&&document.body.classList.contains('split-library'));
const splitMain=()=>$(libraryMode()?'#stage':'#pdf-stage');
let splitSide='pdf';
// Ambiguous keys (undo, Find) go to whichever side was used last; 'pdf' is the main view.
const lastSplitSide=()=>splitViewActive()?splitSide:null;
for(const [id,side] of [['pdf-stage','pdf'],['stage','pdf'],['notes-stage','notes']])for(const type of ['pointerdown','focusin'])$('#'+id)?.addEventListener(type,()=>{splitSide=side;},true);
function splitRatio(){return parseFloat($('main').style.getPropertyValue('--split'))/100||SPLIT.def;}
function setSplitRatio(r,save=true){
 // Hidden panes cannot be measured; keep any reasonable saved ratio until shown.
 const w=splitViewActive()?$('#notes-stage').getBoundingClientRect().right-splitMain().getBoundingClientRect().left:0;
 const lo=w>0?Math.min(.5,SPLIT.min/w):.2;
 r=Math.max(lo,Math.min(1-lo,r||SPLIT.def));
 $('main').style.setProperty('--split',(r*100).toFixed(2)+'%');
 const d=$('#split-divider');if(d){d.setAttribute('aria-valuenow',String(Math.round(r*100)));d.setAttribute('aria-valuetext',`Reader ${Math.round(r*100)}%, note ${100-Math.round(r*100)}%`);}
 if(save)store.set('noctua.pane.split.ratio',r.toFixed(4));
}
function syncSplitButtons(){
 const on=splitViewActive(),what=libraryMode()?'this view':'the paper';
 for(const b of document.querySelectorAll('[data-split]')){b.setAttribute('aria-pressed',String(on));b.title=b.ariaLabel=`${on?'Close':'Open'} notes beside ${what}`;}
}
function setSplitView(on,save=true){
 const library=libraryMode();
 document.body.classList.toggle(splitClass(),on);
 syncSplitButtons();
 if(!on&&$('#notes-stage').contains(document.activeElement))(library?$('#stage'):$('#pdf-stage .pdf-scroll'))?.focus?.();
 if(save)store.set(library?'noctua.pane.split.library':'noctua.pane.split',String(on));
 if(on)requestAnimationFrame(()=>setSplitRatio(splitRatio(),false));
 document.dispatchEvent(new Event('noctua-split-change'));
 window.dispatchEvent(new Event('resize'));
}
{
 const d=document.createElement('div');
 Object.assign(d,{id:'split-divider',tabIndex:0,title:'Drag to resize the paper and note; double-click to reset'});
 d.setAttribute('role','separator');d.setAttribute('aria-orientation','vertical');d.setAttribute('aria-label','Resize paper and note');
 d.setAttribute('aria-controls','pdf-stage stage notes-stage');d.setAttribute('aria-valuemin','0');d.setAttribute('aria-valuemax','100');
 $('#pdf-stage').after(d);
 d.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;
  e.preventDefault();d.setPointerCapture(e.pointerId);d.classList.add('dragging');document.body.classList.add('resizing');
  const a=splitMain().getBoundingClientRect(),b=$('#notes-stage').getBoundingClientRect(),width=b.right-a.left;
  let pending=null,frame=null,finished=false;
  const apply=()=>{frame=null;if(pending!==null&&width>0)setSplitRatio((pending-a.left)/width,false);};
  const move=ev=>{pending=ev.clientX;if(frame===null)frame=requestAnimationFrame(apply);};
  const up=ev=>{if(finished)return;finished=true;if(frame!==null)cancelAnimationFrame(frame);apply();d.removeEventListener('pointermove',move);for(const type of ['pointerup','pointercancel','lostpointercapture'])d.removeEventListener(type,up);d.classList.remove('dragging');document.body.classList.remove('resizing');if(d.hasPointerCapture(ev.pointerId))d.releasePointerCapture(ev.pointerId);setSplitRatio(splitRatio());window.dispatchEvent(new Event('noctua-pane-resize-end'));window.dispatchEvent(new Event('resize'));};
  d.addEventListener('pointermove',move);for(const type of ['pointerup','pointercancel','lostpointercapture'])d.addEventListener(type,up);
 });
 d.addEventListener('dblclick',()=>setSplitRatio(SPLIT.def));
 d.addEventListener('keydown',e=>{
  const step={ArrowLeft:-SPLIT.step,ArrowRight:SPLIT.step}[e.key];
  if(step){e.preventDefault();setSplitRatio(splitRatio()+step);}
  else if(e.key==='Home'||e.key==='End'){e.preventDefault();setSplitRatio(e.key==='Home'?0:1);}
 });
 setSplitRatio(Number(store.get('noctua.pane.split.ratio'))||SPLIT.def,false);
 setSplitView(store.get('noctua.pane.split')==='true',false);
 document.body.classList.toggle('split-library',store.get('noctua.pane.split.library')==='true');
 for(const b of document.querySelectorAll('#stage [data-split]'))b.addEventListener('click',()=>setSplitView(!splitViewActive()));
 syncSplitButtons();
}

// Let editors and popups handle their own keys before the global shortcuts.
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented||e.isComposing||e.repeat||document.querySelector('dialog[open]'))return;
 const active=document.activeElement;
 const editing=active?.matches('input,textarea')||active?.isContentEditable;
 if(e.key==='Escape'&&editing){e.preventDefault();active.blur();return;}
 if(e.shiftKey||!(e.metaKey||e.ctrlKey))return;
 // Keep the original number shortcuts available while editing.
 const numbered=e.altKey&&(e.code==='Digit1'?'left':e.code==='Digit2'?'right':null);
 const side=numbered||(!editing&&(e.code==='KeyB'||e.key.toLowerCase()==='b')?(e.altKey?'right':'left'):null);
 if(!side)return;
 e.preventDefault();setPaneCollapsed(side,!paneCollapsed(side));
});
