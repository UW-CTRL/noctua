'use strict';
// Hide panes without unmounting editors or chat. Saved width and visibility are
// independent so opening a pane restores its previous width and unsaved state.
const PANES={left:{def:320,min:200,max:640},right:{def:360,min:260,max:760}};
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
  const width=ev=>{const r=$('main').getBoundingClientRect();return side==='left'?ev.clientX-r.left:r.right-ev.clientX;};
  const move=ev=>{if(paneCollapsed(side))setPaneCollapsed(side,false);setPaneWidth(side,width(ev),false);};
  const up=ev=>{g.removeEventListener('pointermove',move);g.removeEventListener('pointerup',up);g.removeEventListener('pointercancel',cancel);g.classList.remove('dragging');document.body.classList.remove('resizing');if(g.hasPointerCapture(ev.pointerId))g.releasePointerCapture(ev.pointerId);if(!paneCollapsed(side))setPaneWidth(side,parseFloat($('main').style.getPropertyValue(`--${side}-w`))||PANES[side].def);};
  const cancel=ev=>up(ev);
  g.addEventListener('pointermove',move);g.addEventListener('pointerup',up);g.addEventListener('pointercancel',cancel);
 });
 g.addEventListener('dblclick',e=>{if(!e.target.closest('button')){setPaneCollapsed(side,false);setPaneWidth(side,PANES[side].def);}});
}

// Restore widths after both visibility flags, so a hidden neighbor takes no space.
for(const side of ["left","right"]){const saved=Number(store.get(`noctua.pane.${side}`));if(saved)setPaneWidth(side,saved,false);}

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
