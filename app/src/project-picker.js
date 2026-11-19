// Injected only into a bundled desktop window connected to its local server.
if(window.top===window){
 window.noctuaPickProjectDirectory=()=>new Promise((resolve,reject)=>{
  const request=crypto.randomUUID();
  const done=event=>{if(event.detail.request!==request)return;clearTimeout(timer);window.removeEventListener('noctua-project-directory',done);if(event.detail.error)reject(Error(event.detail.error));else resolve({path:event.detail.path});};
  const timer=setTimeout(()=>{window.removeEventListener('noctua-project-directory',done);reject(Error('Directory selection expired'));},300000);
  window.addEventListener('noctua-project-directory',done);
  location.href='https://noctua.invalid/project-directory?request='+request;
 });
}
