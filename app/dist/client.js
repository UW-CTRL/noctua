'use strict';
const $ = s => document.querySelector(s);
const invoke = (command,args={}) => window.__TAURI_INTERNALS__.invoke(command,args);
let busy=false,step=0,panel='connection',verified=null,serviceSupported=false,desktopVersion='Current version',startupMode='';
const dialog=$('#connection-dialog');
function status(message,state=''){
  const target=panel==='connection'?$('#status'):$('#management-status');
  target.textContent=message;target.dataset.state=state;
}
function render(){
  document.querySelectorAll('[data-step]').forEach(node=>node.hidden=Number(node.dataset.step)!==step);
  document.querySelectorAll('.connection-steps li').forEach((node,index)=>{if(index===step)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');});
  $('#back').hidden=step===0;$('#next').hidden=step===2;$('#connect').hidden=step!==2;
  $('#next').textContent=step===1&&!verified?'Test & continue':'Next';
}
function showStep(next){step=Math.max(0,Math.min(2,next));render();document.querySelector(`[data-step="${step}"] h2`).focus();}
function showPanel(next){
  if(next!=='local')hideLocalToken();
  panel=next;
  document.querySelectorAll('[data-panel]').forEach(tab=>{const selected=tab.dataset.panel===panel;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$('#panel-'+tab.dataset.panel).hidden=!selected;});
  $('#management-status').hidden=panel==='connection';
}
function invalidate(){verified=null;$('#identity').textContent='';render();}
function mode(){const remote=$('#mode').value==='remote';$('#remote').hidden=!remote;$('#local-explanation').hidden=remote;}
$('#mode').onchange=()=>{invalidate();mode();};
$('#address').oninput=$('#secret').oninput=invalidate;
async function operation(fn){
  if(busy)return;busy=true;
  const controls=Array.from(document.querySelectorAll('button,input,select'),node=>[node,node.disabled]);
  controls.forEach(([node])=>node.disabled=true);
  try{await fn()}catch(e){status(String(e),'error')}finally{busy=false;controls.forEach(([node,disabled])=>node.disabled=disabled);$('#autostart').disabled=!serviceSupported;render();}
}
function connectionKey(){return JSON.stringify([$('#mode').value,$('#address').value.trim()]);}
async function connect(testOnly=false){
  const key=connectionKey(),previous=verified?.key===key?verified:null;
  const secret=$('#secret').value||previous?.secret||'';
  status('Checking server identity, compatibility and authentication…');
  if(testOnly)verified=null;
  let identity;
  try{identity=await invoke('connect_server',{mode:$('#mode').value,address:$('#address').value.trim(),secret,testOnly,expectedServerId:!testOnly?previous?.identity.server_id||null:null,newWindow:new URLSearchParams(location.search).has('new'),openPath:new URLSearchParams(location.search).get('open')});}
  catch(error){if(testOnly)$('#secret').value=secret;throw error;}
  $('#secret').value='';$('#identity').textContent=JSON.stringify(identity,null,2);
  if(testOnly){
    verified={key,secret,identity};
    $('#review-mode').textContent=$('#mode').value==='local'?'This computer':'Another computer';
    $('#review-address').textContent=identity.url||$('#address').value||'This computer';
    $('#review-server').textContent=identity.name||identity.server_id;
    $('#review-version').textContent=identity.version||'API '+identity.api_version;
  }else{verified=null;dialog.close();}
  status(testOnly?'Connection test passed.':'Connected. Server tasks continue after closing the app.','ready');render();return identity;
}
async function nextStep(){
  if(step===0){status('');showStep(1);return;}
  if(step===1){if(!verified||verified.key!==connectionKey())await connect(true);status('Connection test passed.','ready');showStep(2);}
}
$('#next').onclick=()=>operation(nextStep);
$('#back').onclick=()=>{if(!busy){status('');showStep(step-1);}};
$('#connect').onclick=()=>operation(async()=>{if(!verified||verified.key!==connectionKey()){showStep(1);throw Error('Test this connection before saving.');}await connect();});
$('#test').onclick=()=>operation(()=>connect(true));
$('#change').onclick=()=>operation(async()=>{await invoke('clear_connection');invalidate();showStep(0);status('Saved connection cleared. Existing data and open windows are preserved.');});
function openDialog(){if(!dialog.open)dialog.showModal();}
async function closeDialog(){if(busy)return;hideLocalToken();dialog.close();try{await invoke('dismiss_connection')}catch{/* The local launcher always allows reopening. */}}
$('#open-connection').onclick=openDialog;$('#close-connection').onclick=closeDialog;
// Escape behaves like Close and always leaves a serverless way back to settings.
// Do not dismiss while a save/connection switch is still running.
dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
const tabs=Array.from(document.querySelectorAll('[data-panel]'));
tabs.forEach((tab,index)=>{
  tab.onclick=()=>{if(!busy)showPanel(tab.dataset.panel);};
  tab.onkeydown=event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();if(!busy){showPanel(tabs[next].dataset.panel);tabs[next].focus();}};
});
async function refresh({restoreSelection=false}={}){
  const state=await invoke('client_state');
  desktopVersion=state.version||desktopVersion;startupMode=state.connection.mode||'';
  if(restoreSelection){$('#mode').value=state.connection.mode||'local';$('#address').value=state.connection.address||'';mode();}
  serviceSupported=!!state.service.supported;
  $('#autostart').checked=!!state.service.enabled;$('#autostart').disabled=busy||!serviceSupported;
  $('#service').textContent=state.service.error||(!state.service.supported?'Login auto-start is unavailable on this platform.':state.service.enabled?'Login auto-start is enabled.':state.service.installed?'Login auto-start is disabled.':'Login auto-start is not installed.');
  $('#service').dataset.state=state.service.error?'error':'';
  $('#local-status').textContent=state.local?'This computer’s server is ready.':(state.local_error||'This computer’s server is not running.');
  $('#local-status').dataset.state=state.local?'ready':state.local_error?'error':'';
  $('#open-running-server').hidden=!state.local;
  $('#connection-status').textContent=state.current?.reachable?'Current server is reachable.':(state.current?.error?'Current server unavailable: '+state.current.error:'No active connection.');
  $('#connection-status').dataset.state=state.current?.reachable?'ready':state.current?.error?'error':'';
  $('#current-identity').textContent=state.current?.identity?JSON.stringify(state.current.identity,null,2):'';
  const update=state.server_update;
  if(update?.phase){
    const descriptions={announcing:'Notifying connected clients and saving edits…',draining:'Waiting for active AI, file and MCP tasks to finish…',backing_up:'Backing up stopped server data…',service:'Updating the registered login service…',starting:'Starting and verifying the replacement server…',cleanup:'Removing unused previous executables…',complete:'Server update completed.',failed:'Server update failed: '+(update.error||'Check server logs.')};
    $('#server-update-status').textContent=update.phase==='interrupted'?update.error:descriptions[update.phase]||update.phase;
    if(update.phase==='complete'&&update.cleanup_pending?.length)$('#server-update-status').textContent+=' Some update cleanup remains; retry Update server when the reported files are no longer in use.';
    $('#server-update-status').dataset.state=['failed','interrupted'].includes(update.phase)?'error':update.phase==='complete'?'ready':'';
    if(busy&&['announcing','draining','backing_up','service','starting','cleanup'].includes(update.phase))status('This computer’s server: '+$('#server-update-status').textContent);
  }
  return state;
}
function hideLocalToken(){
  $('#local-token').value='';$('#local-token').type='password';
  $('#show-local-token').textContent='Show token';$('#show-local-token').setAttribute('aria-pressed','false');
  $('#local-token-status').textContent='';delete $('#local-token-status').dataset.state;
}
async function localTokenAction(copy=false){
  const message=$('#local-token-status');
  message.textContent='';delete message.dataset.state;
  if(!copy&&$('#local-token').type==='text'){hideLocalToken();return;}
  try{
    const result=await invoke('local_server',{action:copy?'copy-token':'token'});
    if(copy){message.textContent='Token copied.';message.dataset.state='ready';}
    else {
      if(typeof result.token!=='string'||!result.token)throw Error('No local server token is available. Start this computer’s server first.');
      $('#local-token').value=result.token;$('#local-token').type='text';
      $('#show-local-token').textContent='Hide token';$('#show-local-token').setAttribute('aria-pressed','true');
    }
  }catch(error){hideLocalToken();message.textContent=String(error);message.dataset.state='error';}
}
$('#show-local-token').onclick=()=>operation(()=>localTokenAction());
$('#copy-local-token').onclick=()=>operation(()=>localTokenAction(true));
dialog.addEventListener('close',hideLocalToken);
window.addEventListener('pagehide',hideLocalToken);
$('#local-actions').onclick=e=>{const action=e.target.dataset.action;if(action)operation(async()=>{const r=await invoke('local_server',{action});if(action==='logs')$('#logs').textContent=r.log;else{if(r.reconnect_local){await invoke('connect_server',{mode:'local',address:'',secret:'',testOnly:false,newWindow:false,openPath:null,expectedServerId:r.server.server_id});dialog.close();}status(action+' completed','ready');await refresh();}});};
$('#autostart').onchange=()=>operation(async()=>{try{await invoke('local_server',{action:$('#autostart').checked?'enable':'disable'});}finally{await refresh();}});
let offered;
$('#open-running-server').onclick=()=>operation(async()=>{
  await invoke('connect_server',{mode:'local',address:'',secret:'',testOnly:false,newWindow:false,openPath:null,expectedServerId:null,deferServerUpdate:true});
  dialog.close();
});
async function performDesktop(action,version=offered,{offer=true,startup=false,returnFocus=null}={}){
  const result=await invoke('desktop_action',{action,version:version||null});
  if(['light','dark'].includes(action)){$('#update').textContent='App icon updated.';return result;}
  const messages={available:'Version '+result.version+' is available.',current:'You are using the latest published version.',installed:'Update installed. Restart Noctua to use it.',skipped:''};
  if(!Object.prototype.hasOwnProperty.call(messages,result.status))throw Error('Unexpected desktop updater response');
  $('#update').textContent=messages[result.status];
  if(result.status==='available'){
    offered=result.version;
    if(offer)await showDesktopOffer(result,startup,returnFocus);
  }else if(result.status==='current')offered=null;
  return result;
}
async function showDesktopOffer(result,startup=false,returnFocus=null){
  if($('#app-update-dialog'))return;
  await invoke('present_client');
  const previous=returnFocus||document.activeElement,prompt=document.createElement('dialog');
  prompt.id='app-update-dialog';prompt.className='connection-modal connection-update-modal';prompt.setAttribute('aria-labelledby','app-update-title');
  prompt.innerHTML='<h2 id="app-update-title">A new Noctua version is available</h2><div class="update-summary" tabindex="0" role="region" aria-label="Release history">'+NoctuaUpdateDialogs.summary(result,desktopVersion)+'</div><p>Save your work before updating. Installation may close and restart Noctua.</p><p class="connection-status" role="status"></p><div class="connection-actions"><button data-dismiss>Not now</button><button class="primary" data-install>Install update</button></div>';
  const close=()=>{if(busy)return;prompt.close();prompt.remove();if(previous?.isConnected)previous.focus();if(startup&&!dialog.open)invoke('dismiss_connection').catch(()=>{});};
  prompt.querySelector('[data-dismiss]').onclick=close;
  prompt.addEventListener('cancel',event=>{event.preventDefault();close();});
  let action='install';
  prompt.querySelector('[data-install]').onclick=()=>operation(async()=>{
    try{
      const response=await performDesktop(action,result.version,{offer:false});
      prompt.querySelector('[role=status]').textContent=$('#update').textContent;
      if(response.status==='installed'){action='restart';prompt.querySelector('[data-install]').textContent='Restart Noctua';}
    }catch(error){prompt.querySelector('[role=status]').textContent=String(error);throw error;}
  });
  document.body.appendChild(prompt);prompt.showModal();prompt.querySelector('[data-dismiss]').focus();
}
document.querySelectorAll('[data-desktop]').forEach(button=>button.onclick=async()=>{
  if(busy)return;
  const action=button.dataset.desktop,version=offered;
  if(action==='install'){
    if(!version){status('Check for a desktop update before installing.','error');return;}
    if(!await NoctuaUpdateDialogs.confirmInstall(version,{className:'connection-modal connection-update-modal'}))return;
  }
  await operation(()=>performDesktop(action,version,{returnFocus:button}));
});
mode();render();openDialog();
operation(async()=>{const s=await refresh({restoreSelection:true});if(s.connection.mode){showStep(1);await connect();}}).then(async()=>{
  if(startupMode)try{await performDesktop('startup_check',null,{startup:true});}catch(error){$('#update').textContent='Could not check for a desktop update: '+String(error);}
});
setInterval(()=>{refresh().catch(error=>{if(!busy)status(String(error),'error');});},2000);
