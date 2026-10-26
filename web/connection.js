'use strict';
// Every cookie-authenticated write carries a non-simple header; the server also checks Origin.
window.noctuaServerId = document.querySelector('meta[name=noctua-server-id]')?.content || null;
const noctuaFetch = window.fetch.bind(window);
window.fetch = (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin === location.origin) {
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Noctua-Client', '1');
    if (window.noctuaServerId) headers.set('X-Noctua-Server', window.noctuaServerId);
    options = { ...options, headers };
  }
  return noctuaFetch(input, options);
};
// Only top-level shells register as editors; a shell flushes all of its iframe tabs.
const noctuaEditor = window.top === window ? (window.crypto?.randomUUID?.() || String(Date.now())+'-'+Math.random().toString(36).slice(2)) : null;
window.readNoctuaServer = async () => {
  const r = await fetch('/api/server', {headers:noctuaEditor?{'X-Noctua-Editor':noctuaEditor}:{}});
  if (!r.ok) throw Error('Server disconnected; reconnect through Server & connection');
  const server = await r.json();
  if (server.api_version !== 1 || server.server_id !== window.noctuaServerId) throw Error('Server identity or version changed; open Server & connection');
  return server;
};
window.verifyNoctuaServer = async () => {
  const server=await window.readNoctuaServer();
  if(!server.ready)throw Error('Server is updating; existing work is preserved');
  return server;
};
window.noctuaServer = window.verifyNoctuaServer();
window.noctuaServer.catch(() => {});

window.addEventListener('DOMContentLoaded', () => {
  const banner = document.createElement('div');
  banner.className='connection-banner';banner.setAttribute('role','status');
  banner.hidden=true;document.body.appendChild(banner);
  let paused=false,acknowledged=null,checking=false;
  const resume=()=>{if(paused){if(window.noctuaShell)window.noctuaShell.endSwitch('maintenance');else document.body.inert=false;paused=false;}acknowledged=null;};
  const saveForUpdate=async notice=>{
    if(!noctuaEditor||acknowledged===notice.id)return;
    let saved=false;
    try{
      paused=true;
      if(window.noctuaShell){window.noctuaShell.beginSwitch('maintenance');await window.noctuaShell.flush();}
      else{
        if(document.querySelector('dialog[open]'))throw Error('Resolve the open editor dialog first');
        window.prepareEditorSwitch?.();document.body.inert=true;
        window.preserveChatDraft?.();
        await window.saveWorkspaceFile?.();await window.flushNoteEdits?.();await window.flushPDF?.();
      }
      saved=true;acknowledged=notice.id;
    }catch{resume();banner.textContent='Server update is waiting for your edits. Resolve open dialogs or save conflicts, then retry. Your current work is preserved.';}
    const response=await fetch('/api/server/update/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:notice.id,client:noctuaEditor,saved})});
    if(!response.ok){resume();throw Error('Server update acknowledgment failed');}
  };
  const check=async()=>{
    if(checking)return;checking=true;
    try{
      const server=await window.readNoctuaServer();
      window.noctuaServer=server.ready?Promise.resolve(server):Promise.reject(Error('Server is updating'));
      window.noctuaServer.catch(()=>{});
      if(server.maintenance){
        banner.textContent='Server update scheduled. Saving open edits; existing AI and file tasks will finish before restart. Reconnect after the update.';banner.hidden=false;
        await saveForUpdate(server.maintenance);
      }else{resume();banner.hidden=true;}
    }catch{
      resume();banner.textContent='Disconnected. Open Server & connection from desktop Settings to reconnect. Browser: reload to sign in again. Local note drafts stay on this device.';banner.hidden=false;
    }finally{checking=false;}
  };
  window.addEventListener('offline',check);window.addEventListener('online',check);check();setInterval(check,2000);
});
