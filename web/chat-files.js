// Composer file uploads, isolated by provider and conversation.
window.NoctuaChatFiles = (() => {
  const drafts = new Map(), limit = 32 * 1024 * 1024;
  const key = () => `noctua.chatFiles.${chat.provider}.${chat.id || 'new'}`;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const url = id => `/api/chat-files/${encodeURIComponent(id)}`;
  function items(k = key()) {
    if (!drafts.has(k)) {
      let saved = [];
      try { saved = JSON.parse(store.get(k) || '[]'); } catch (_) { /* Start with an empty draft. */ }
      drafts.set(k, Array.isArray(saved) ? saved.filter(f => f.id && f.name && Number.isFinite(f.size)) : []);
    }
    return drafts.get(k);
  }
  function save(k) { store.set(k, JSON.stringify(items(k).filter(f => f.id))); }
  const thumbnail = file => file.mime?.startsWith('image/') ? `<img src="${url(file.id)}" alt="" loading="lazy">` : '';
  function sentHTML(files = []) {
    return files.length ? `<div class="chat-file-list">${files.map(f => `<a class="chat-file" href="${url(f.id)}" download="${escape(f.name)}" title="Download ${escape(f.name)}">${thumbnail(f)}<span>${escape(f.name)} <small>${size(f.size)}</small></span></a>`).join('')}</div>` : '';
  }
  function size(bytes) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  function render() {
    const box = document.getElementById('chat-files');
    if (!box) return;
    const list = items();
    box.hidden = !list.length;
    box.innerHTML = list.map((f, i) => `<div class="chat-file ${f.error ? 'chat-file-error' : ''}">${thumbnail(f)}<span>${escape(f.name)} <small>${f.error ? escape(f.error) : f.id ? size(f.size) : 'Uploading…'}</small></span>${f.error ? `<button type="button" data-retry="${i}" aria-label="Retry ${escape(f.name)}">Retry</button>` : ''}<button type="button" data-remove="${i}" aria-label="Remove ${escape(f.name)}" title="Remove attachment">×</button></div>`).join('');
    box.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => { const k=key();items(k).splice(Number(button.dataset.remove),1);save(k);render(); });
    box.querySelectorAll('[data-retry]').forEach(button => button.onclick = () => upload(items()[Number(button.dataset.retry)],key()));
  }
  const base64 = file => new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read this file'));
    reader.readAsDataURL(file);
  });
  async function pdfPages(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0,5)) !== '%PDF-') return [];
    const engine = await pdfjs();
    const task = engine.getDocument({data:bytes,isEvalSupported:false,standardFontDataUrl:'/vendor/pdfjs/web/standard_fonts/',cMapUrl:'/vendor/pdfjs/web/cmaps/',cMapPacked:true,wasmUrl:'/vendor/pdfjs/web/wasm/'});
    task.onPassword = () => { passwordProtected=true;task.destroy().catch(()=>{}); };
    let doc,passwordProtected=false;
    try {
      doc = await task.promise;
      if (doc.numPages > 1000) throw new Error('PDFs must have 1,000 pages or fewer');
      const pages = [];let length=0;
      for (let n=1;n<=doc.numPages;n++) {
        const page=await doc.getPage(n),content=await page.getTextContent();
        const text=content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('');
        length+=new TextEncoder().encode(text).length;
        if(length>8*1024*1024)throw new Error('PDF text exceeds the 8 MB indexing limit');
        pages.push(text);page.cleanup();
      }
      return pages;
    } catch (error) {
      throw new Error(passwordProtected||error.name==='PasswordException'?'Password-protected PDFs must be unlocked before attaching':error.message||'Could not read this PDF');
    } finally { await task.destroy(); }
  }
  // Use the same bundled PDF renderer as the Reader and return original page
  // pixels to the CLI's vision model, without importing the file into Library.
  const rendering = new Map();
  async function preparePDFPage(action) {
    const taskKey=`${action.file_id}:${action.page}`;
    const endpoint=`${url(action.file_id)}/pages/${action.page}?chat_id=${encodeURIComponent(action.chat_id)}&request_id=${encodeURIComponent(action.request_id)}`;
    let promise=rendering.get(taskKey);
    if(!promise) {
      promise=(async()=>{
        const engine=await pdfjs();
        const task=engine.getDocument({url:url(action.file_id),isEvalSupported:false,standardFontDataUrl:'/vendor/pdfjs/web/standard_fonts/',cMapUrl:'/vendor/pdfjs/web/cmaps/',cMapPacked:true,wasmUrl:'/vendor/pdfjs/web/wasm/'});
        let passwordProtected=false;
        task.onPassword=()=>{passwordProtected=true;task.destroy().catch(()=>{});};
        try {
          const doc=await task.promise;
          if(!Number.isInteger(action.page)||action.page<1||action.page>doc.numPages)throw new Error('Page is outside the attached PDF');
          const page=await doc.getPage(action.page),base=page.getViewport({scale:1});
          if(!Number.isFinite(base.width)||!Number.isFinite(base.height)||base.width<=0||base.height<=0)throw new Error('Invalid PDF page dimensions');
          let scale=Math.min(2,1800/Math.max(base.width,base.height));
          for(let attempt=0;attempt<5;attempt++) {
            const viewport=page.getViewport({scale}),canvas=document.createElement('canvas');
            canvas.width=Math.max(1,Math.ceil(viewport.width));canvas.height=Math.max(1,Math.ceil(viewport.height));
            try {
              // Export directly; display intent can wait for animation frames in background tabs.
              await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'#ffffff',intent:'print'}).promise;
              const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
              if(blob&&blob.size<=5*1024*1024)return blob;
            } finally {canvas.width=canvas.height=0;}
            scale*=.65;
          }
          throw new Error('PDF page preview exceeds 5 MB');
        } catch(error) {
          throw new Error(passwordProtected?'Unlock this PDF before attaching it':error.message||'Could not render the attached PDF');
        } finally {await task.destroy();}
      })();
      rendering.set(taskKey,promise);
      promise.finally(()=>rendering.delete(taskKey)).catch(()=>{});
    }
    let blob;
    try {blob=await promise;} catch(error) {
      await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:error.message})});
      throw error;
    }
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'image/png'},body:blob});
    if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error||'Could not save the PDF preview');
  }
  async function upload(entry,k) {
    entry.error=null;render();
    try {
      const pages=await pdfPages(entry.file),data=await base64(entry.file);
      const response=await fetch('/api/chat-files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:entry.name,data,pages})});
      const result=await response.json().catch(()=>({error:`Upload failed (${response.status})`}));
      if(!response.ok)throw new Error(result.error||'Upload failed');
      Object.assign(entry,result);delete entry.file;
      for(const [draftKey,list] of drafts)if(list.includes(entry))save(draftKey);
    } catch(error) { entry.error=error.message||'Upload failed'; }
    render();
  }
  async function add(files) {
    if(!chat.ready||chat.switching)return;
    const k=key(),list=items(k),uploads=[];
    for(const file of files) {
      if(list.some(f=>f.name===file.name&&f.size===file.size&&f.modified===file.lastModified))continue;
      if(list.length>=10||list.reduce((sum,f)=>sum+f.size,0)+file.size>limit){toast('Attach up to 10 files totaling 32 MB.',{error:true});continue;}
      if(file.type.startsWith('image/')&&file.size>5*1024*1024){toast('Images must be 5 MB or smaller.',{error:true});continue;}
      const entry={name:file.name||'Pasted image.png',size:file.size,modified:file.lastModified,file};list.push(entry);uploads.push(entry);
    }
    render();
    for(const entry of uploads)if(list.includes(entry))await upload(entry,k);
  }
  function snapshot() {
    const list=items();
    if(list.some(f=>!f.id))throw new Error('Wait for uploads to finish, then retry or remove failed attachments.');
    return {key:key(),files:list.map(({id,name,size,mime,pages})=>({id,name,size,mime,pages}))};
  }
  function consume(snapshot) {
    const ids=new Set(snapshot.files.map(f=>f.id));
    drafts.set(snapshot.key,items(snapshot.key).filter(f=>!ids.has(f.id)));save(snapshot.key);render();
  }
  function moveDraft(oldKey) {
    const list=items(oldKey);drafts.set(key(),list);drafts.set(oldKey,[]);save(oldKey);save(key());render();
  }
  function init() {
    const composer=document.getElementById('chat-form'),input=document.getElementById('chat-file-input');
    document.getElementById('chat-attach').onclick=()=>input.click();
    input.onchange=()=>{add([...input.files]);input.value='';};
    composer.addEventListener('paste',event=>{
      const files=[...(event.clipboardData?.files||[])];
      if(!files.length)for(const item of event.clipboardData?.items||[])if(item.kind==='file'){const file=item.getAsFile();if(file)files.push(file);}
      if(files.length){event.preventDefault();add(files);}
    });
    composer.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';composer.classList.add('chat-file-drag');}});
    composer.addEventListener('dragleave',event=>{if(!composer.contains(event.relatedTarget))composer.classList.remove('chat-file-drag');});
    composer.addEventListener('drop',event=>{composer.classList.remove('chat-file-drag');if(event.dataTransfer.files.length){event.preventDefault();event.stopPropagation();add([...event.dataTransfer.files]);}});
    render();
  }
  document.addEventListener('DOMContentLoaded',init);
  return {add,render,snapshot,consume,moveDraft,key,sentHTML,preparePDFPage,count:()=>items().length};
})();
