'use strict';
// Local font preferences shared by app tabs and the desktop window shell.
(() => {
  const system = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const common = [
    {id:'system',label:'System default',family:system},
    {id:'arial',label:'Arial',family:'Arial, Helvetica, sans-serif'},
    {id:'helvetica',label:'Helvetica Neue',family:'"Helvetica Neue", Helvetica, Arial, sans-serif'},
    {id:'georgia',label:'Georgia',family:'Georgia, "Times New Roman", serif'},
    {id:'times',label:'Times New Roman',family:'"Times New Roman", Times, serif'},
    {id:'mono',label:'Monospace',family:'"SFMono-Regular", Menlo, Consolas, monospace'},
    {id:'custom',label:'Custom font…'},
  ];
  const presets = {
    ui:common,
    chat:common,
    note:[{id:'latex',label:'LaTeX serif (default)',family:'KaTeX_Main, "Latin Modern Roman", "CMU Serif", Georgia, serif'},
      ...common],
  };
  const fallback = kind => kind === 'note' ? 'latex' : 'system';
  function normalize(kind, value) {
    const id = typeof value === 'string' ? value : value?.id;
    const name = String(value?.name || '').replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,100);
    return {id:presets[kind].some(p=>p.id===id) && (id!=='custom'||name) ? id : fallback(kind),name};
  }
  function read(kind) {
    try { return normalize(kind,JSON.parse(localStorage.getItem('noctua.font.'+kind))); }
    catch { return normalize(kind,null); }
  }
  const current = {ui:read('ui'),note:read('note'),chat:read('chat')};
  const sizeRanges = {ui:{min:11,max:18,default:14},note:{min:12,max:26,default:18},noteTitle:{min:12,max:36,default:28},chat:{min:10,max:24,default:13}};
  function normalizeSize(kind,value) {
    const range=sizeRanges[kind],number=Number(value);
    return Number.isFinite(number)&&number>0 ? Math.max(range.min,Math.min(range.max,Math.round(number))) : range.default;
  }
  function readSize(kind) {
    try { return normalizeSize(kind,localStorage.getItem('noctua.font.'+kind+'Size')); } catch { return sizeRanges[kind].default; }
  }
  const sizes={ui:readSize('ui'),note:readSize('note'),noteTitle:readSize('noteTitle'),chat:readSize('chat')};
  function applySize(kind,notify=false) {
    document.documentElement.style.setProperty('--'+(kind==='noteTitle'?'note-title':kind)+'-font-size',sizes[kind]+'px');
    if(kind==='ui'||kind==='note')document.documentElement.style.setProperty('--'+kind+'-font-scale',String(sizes[kind]/sizeRanges[kind].default));
    if(notify){
      document.dispatchEvent(new CustomEvent('noctua-font-size-change',{detail:{kind,size:sizes[kind]}}));
      if(kind==='chat')document.dispatchEvent(new CustomEvent('noctua-chat-text-change',{detail:{size:sizes.chat}}));
    }
  }
  function setSize(kind,value) {
    if(!sizeRanges[kind])return;
    sizes[kind]=normalizeSize(kind,value);
    try { localStorage.setItem('noctua.font.'+kind+'Size',String(sizes[kind])); } catch { /* retain session preference */ }
    applySize(kind,true);
  }
  function apply(kind, notify = false) {
    const preference = current[kind];
    const family = preference.id === 'custom'
      ? '"'+preference.name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'", '+system
      : presets[kind].find(p=>p.id===preference.id).family;
    document.documentElement.style.setProperty('--font-'+kind,family);
    if(notify)document.dispatchEvent(new CustomEvent('noctua-font-change',{detail:{kind}}));
  }
  window.NoctuaFonts = {
    choices:kind=>presets[kind].map(({id,label})=>({id,label})),
    get:kind=>({...current[kind]}),
    getSize:kind=>sizes[kind],
    sizeChoices:kind=>Array.from({length:sizeRanges[kind].max-sizeRanges[kind].min+1},(_,index)=>index+sizeRanges[kind].min),
    setSize,
    getChatSize:()=>sizes.chat,
    setChatSize:value=>setSize('chat',value),
    set(kind,id,name='') {
      if(!presets[kind])return;
      current[kind]=normalize(kind,{id,name});
      try { localStorage.setItem('noctua.font.'+kind,JSON.stringify(current[kind])); } catch { /* retain the choice for this session */ }
      apply(kind,true);
    },
  };
  for(const kind of ['ui','note','chat'])apply(kind);
  for(const kind of Object.keys(sizeRanges))applySize(kind);
  window.addEventListener('storage',event=>{
    for(const kind of ['ui','note','chat']){
      if(event.key===null||event.key==='noctua.font.'+kind){current[kind]=read(kind);apply(kind,true);}
    }
    for(const kind of Object.keys(sizeRanges)){
      if(event.key===null||event.key==='noctua.font.'+kind+'Size'){sizes[kind]=readSize(kind);applySize(kind,true);}
    }
  });
})();
