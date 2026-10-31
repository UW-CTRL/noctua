'use strict';
const $ = s => document.querySelector(s);
const invoke = (command,args={}) => window.__TAURI_INTERNALS__.invoke(command,args);
let busy=false,step=0,panel='connection',verified=null,serviceSupported=false,desktopVersion='Current version',startupMode='';
let serverRecovery=null,localReady=null,localUpdateActive=false,currentConnection=null,savedSelection={mode:'local',address:''};
const dialog=$('#connection-dialog'),settingsDialog=dialog;
const embedded = new URLSearchParams(location.search).has('overlay');
const management=$('#server-management'), managementHome=management.parentNode, managementNext=management.nextElementSibling;
function status(message,state=''){
  const target=panel==='connection'?$('#status'):$('#management-status');
  target.textContent=message;target.dataset.state=state;
}
function placeManagement(){
  const inWizard=!embedded || dialog.dataset.editing==='true';
  const connectStep=document.querySelector('[data-step="1"]');
  if(inWizard && management.parentNode!==connectStep)connectStep.insertBefore(management,connectStep.querySelector('.connection-actions'));
  if(!inWizard && management.parentNode!==managementHome)managementHome.insertBefore(management,managementNext);
  management.open=true;
}
function render(){
  placeManagement();
  document.querySelectorAll('[data-step]').forEach(node=>node.hidden=Number(node.dataset.step)!==step);
  document.querySelectorAll('.connection-steps li').forEach((node,index)=>{if(index===step)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');});
  $('#back').hidden=step===0;$('#next').hidden=step===2;$('#connect').hidden=step!==2;
  $('#next').textContent=step===1&&!verified?'Test & continue':'Next';
  $('#popup-current-connection').hidden=embedded || step!==2 || !currentConnection;
  renderServerRecovery();
}
function showStep(next){step=Math.max(0,Math.min(2,next));if(step!==1 && (!embedded || dialog.dataset.editing==='true'))hideLocalToken();render();document.querySelector(`[data-step="${step}"] h2`).focus();}
function showPanel(next){
  panel=next;
  if(!dialog.open){if(embedded)dialog.show();else dialog.showModal();}
  if(next==='local')$('#server-management').open=true;
  $('#management-status').hidden=false;
}
if(embedded){
  window.addEventListener('message',event=>{if(event.source===window.parent && event.data?.type==='noctua-manager-hidden')hideLocalToken();});
  window.addEventListener('keydown',event=>{if(event.key==='Escape' && !document.querySelector('dialog:modal')){event.preventDefault();window.parent.postMessage({type:'noctua-manager-close'}, '*');}});
  $('.connection-token').hidden=false;
  $('#server-management').open=true;
  $('#embedded-connection-summary').hidden=false;
  $('#dialog-title').textContent='Server & Connection';
  $('#close-connection').hidden=true;
  $('#edit-connection').onclick=()=>{
    const editing=dialog.dataset.editing!=='true';
    dialog.dataset.editing=String(editing);
    $('#edit-connection').textContent=editing?'Cancel connection change':'Change connection';
    if(editing)showStep(0);else{invalidate();$('#secret').value='';$('#mode').value=savedSelection.mode;$('#address').value=savedSelection.address;mode();}
  };
}
function renderLocalActions(){
  for(const action of ['start','stop','restart']){
    const button=$(`[data-action="${action}"]`);
    button.hidden=localReady===null || (action==='start' ? localReady : !localReady);
    button.disabled=busy || localReady===null || localUpdateActive;
  }
}
function invalidate(){verified=null;render();}
function mode(){const remote=$('#mode').value==='remote';$('#remote').hidden=!remote;$('#local-explanation').hidden=remote;$('#server-management').hidden=remote;if(remote)hideLocalToken();}
$('#mode').onchange=()=>{invalidate();mode();};
$('#address').oninput=$('#secret').oninput=invalidate;
async function operation(fn){
  if(busy)return;busy=true;
  const controls=Array.from(document.querySelectorAll('button,input,select'),node=>[node,node.disabled]);
  controls.forEach(([node])=>node.disabled=true);
  try{await fn()}catch(e){status(String(e),'error')}finally{busy=false;controls.forEach(([node,disabled])=>node.disabled=disabled);$('#autostart').disabled=!serviceSupported;$('#refresh-logs').disabled=logsLoading;renderLocalActions();render();}
}
function renderServerRecovery(){
  for(const id of ['connection-recovery','local-recovery']){
    const box=$('#'+id),visible=serverRecovery&&(id==='local-recovery'||$('#mode').value==='local');
    box.hidden=!visible;if(!visible)continue;
    box.querySelector('[data-recovery-summary]').textContent=serverRecovery.message;
    const details=[serverRecovery.version?'Version: '+serverRecovery.version:'',serverRecovery.url?'Address: '+serverRecovery.url:'',serverRecovery.data_dir?'Data folder: '+serverRecovery.data_dir:'',serverRecovery.executable?'Server executable: '+serverRecovery.executable:'',serverRecovery.stop_command?'Safe-stop command: '+serverRecovery.stop_command:'',serverRecovery.requested_data_dir?'Requested data folder: '+serverRecovery.requested_data_dir:''].filter(Boolean);
    box.querySelector('[data-recovery-identity]').textContent=details.join('\n');
    box.querySelector('[data-recovery-steps]').replaceChildren(...(serverRecovery.steps||[]).map(text=>{const item=document.createElement('li');item.textContent=text;return item;}));
  }
}
document.querySelectorAll('[data-recovery-retry]').forEach(button=>button.onclick=()=>operation(async()=>{
  if(panel!=='connection'){showPanel('connection');$('#mode').value='local';mode();}
  invalidate();showStep(1);await nextStep();
}));
function connectionKey(){return JSON.stringify([$('#mode').value,$('#address').value.trim()]);}
async function connect(testOnly=false){
  const key=connectionKey(),previous=verified?.key===key?verified:null;
  const secret=$('#secret').value||previous?.secret||'';
  status('Checking server identity, compatibility and authentication…');
  if(testOnly)verified=null;
  let identity;
  try{identity=await invoke('connect_server',{mode:$('#mode').value,address:$('#address').value.trim(),secret,testOnly,expectedServerId:!testOnly?previous?.identity.server_id||null:null,newWindow:new URLSearchParams(location.search).has('new'),openPath:new URLSearchParams(location.search).get('open')});}
  catch(error){if(testOnly)$('#secret').value=secret;if(!testOnly&&!embedded)await invoke('present_client').catch(()=>{});try{await refresh();}catch{}if(serverRecovery)throw Error(serverRecovery.message);throw error;}
  $('#secret').value='';
  if(testOnly){
    verified={key,secret,identity};
    $('#review-address').textContent=$('#mode').value==='remote'?($('#address').value.trim()||'Unavailable'):(identity.url||'Unavailable');
    $('#review-server').textContent=identity.name||'Unavailable';
    $('#review-version').textContent=identity.version||'Unavailable';
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
$('#change').onclick=()=>operation(async()=>{
  const message=$('#clear-connection-status');
  try{await invoke('clear_connection');invalidate();await refresh();message.textContent='Saved connection cleared. Current connection remains open.';message.dataset.state='ready';}
  catch(error){message.textContent=String(error);message.dataset.state='error';}
});
function openDialog(){showPanel('connection');}
window.openClientSettings=section=>showPanel(section==='local'?'local':'connection');
async function closeDialog(){if(busy)return;hideLocalToken();dialog.close();settingsDialog.close();try{await invoke('dismiss_connection')}catch{/* The local launcher always allows reopening. */}}
$('#open-connection').onclick=openDialog;$('#close-connection').onclick=closeDialog;
// Escape behaves like Close and always leaves a serverless way back to settings.
// Do not dismiss while a save/connection switch is still running.
for(const modal of [dialog,settingsDialog])modal.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
async function refresh({restoreSelection=false}={}){
  let state;
  try{state=await invoke('client_state');}catch(error){localReady=null;renderLocalActions();$('#local-status').textContent='Could not check this computer’s server.';$('#local-status').dataset.state='error';throw error;}
  serverRecovery=state.server_recovery||null;renderServerRecovery();
  desktopVersion=state.version||desktopVersion;startupMode=state.connection.mode||'';
  savedSelection={mode:state.connection.mode||'local',address:state.connection.address||''};
  if(restoreSelection){$('#mode').value=state.connection.mode||'local';$('#address').value=state.connection.address||'';mode();}
  serviceSupported=!!state.service.supported;
  $('#autostart').checked=!!state.service.enabled;$('#autostart').disabled=busy||!serviceSupported;
  $('#service').textContent=state.service.error||(!state.service.supported?'Automatic start is unavailable on this computer.':'');
  $('#service').hidden=!$('#service').textContent;
  $('#service').dataset.state=state.service.error?'error':'';
  localReady=!!state.local;
  localUpdateActive=['announcing','draining','backing_up','service','starting','cleanup'].includes(state.server_update?.phase);
  const update=state.server_update;
  $('[data-action="update"]').hidden=!(update && (['failed','interrupted'].includes(update.phase) || (update.phase==='complete' && update.cleanup_pending?.length)));
  renderLocalActions();
  $('#local-status').textContent=state.local?'This computer’s server is ready.':(state.local_error||'This computer’s server is not running.');
  $('#local-status').dataset.state=state.local?'ready':state.local_error?'error':'';
  $('#open-running-server').hidden=!state.local || (embedded && !serverRecovery && (!state.server_update?.phase || state.server_update.phase==='complete'));
  const current=state.current;
  currentConnection=current?.reachable || current?.error ? current : null;
  const currentStatus=current?.reachable?'Current server is reachable.':(current?.error?'Current server unavailable: '+current.error:'No active connection.');
  const currentState=current?.reachable?'ready':current?.error?'error':'';
  for(const id of ['connection-status','embedded-current-status']){$('#'+id).textContent=currentStatus;$('#'+id).dataset.state=currentState;}
  const identity=current?.identity;
  for(const prefix of ['popup-current','embedded-current']){
    $('#'+prefix+'-info').hidden=!identity;
    for(const [field,value] of [['name',identity?.name],['address',current?.address||identity?.url],['version',identity?.version]]) $('#'+prefix+'-'+field).textContent=value||'Unavailable';
  }
  $('#popup-current-connection').hidden=embedded || step!==2 || !currentConnection;
  if(update?.phase){
    const descriptions={announcing:'Notifying connected clients and saving edits…',draining:'Waiting for active AI, file and MCP tasks to finish…',backing_up:'Backing up stopped server data…',service:'Updating the registered login service…',starting:'Starting and verifying the replacement server…',cleanup:'Removing unused previous executables…',complete:'Server update completed.',failed:'Server update failed: '+(update.error||'Check server logs.')};
    $('#server-update-status').textContent=update.phase==='interrupted'?update.error:descriptions[update.phase]||update.phase;
    if(update.phase==='complete'&&update.cleanup_pending?.length)$('#server-update-status').textContent+=' Some update cleanup remains; retry server update when the reported files are no longer in use.';
    $('#server-update-status').dataset.state=['failed','interrupted'].includes(update.phase)?'error':update.phase==='complete'?'ready':'';
    if(busy&&['announcing','draining','backing_up','service','starting','cleanup'].includes(update.phase))status('This computer’s server: '+$('#server-update-status').textContent);
  }
  return state;
}
function hideLocalToken(){
  $('#local-token').value='';$('#local-token').type='password';
  $('#show-local-token').setAttribute('aria-label','Show token');$('#show-local-token').title='Show token';$('#show-local-token').setAttribute('aria-pressed','false');
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
      $('#show-local-token').setAttribute('aria-label','Hide token');$('#show-local-token').title='Hide token';$('#show-local-token').setAttribute('aria-pressed','true');
    }
  }catch(error){hideLocalToken();message.textContent=String(error);message.dataset.state='error';}
}
$('#show-local-token').onclick=()=>operation(()=>localTokenAction());
$('#copy-local-token').onclick=()=>operation(()=>localTokenAction(true));
dialog.addEventListener('close',hideLocalToken);
$('#server-management').addEventListener('toggle',()=>{if(!$('#server-management').open)hideLocalToken();});

window.addEventListener('pagehide',hideLocalToken);
$('#local-actions').onclick=e=>{const action=e.target.dataset.action;if(action)operation(async()=>{const r=await invoke('local_server',{action});if(r.reconnect_local){await invoke('connect_server',{mode:'local',address:'',secret:'',testOnly:false,newWindow:false,openPath:null,expectedServerId:r.server.server_id});dialog.close();settingsDialog.close();}status(action+' completed','ready');await refresh();});};
let logsLoading=false;
async function loadServerLogs(){
  if(logsLoading)return;
  logsLoading=true;$('#refresh-logs').disabled=true;
  const message=$('#server-logs-status');message.textContent='Loading server logs…';message.dataset.state='';
  try{const result=await invoke('local_server',{action:'logs'});$('#logs').textContent=result.log||'No server logs yet.';message.textContent='';}
  catch(error){message.textContent=String(error);message.dataset.state='error';}
  finally{logsLoading=false;$('#refresh-logs').disabled=false;}
}
$('#server-logs').addEventListener('toggle',()=>{if($('#server-logs').open)loadServerLogs();});
$('#refresh-logs').onclick=loadServerLogs;
$('#autostart').onchange=()=>operation(async()=>{try{await invoke('local_server',{action:$('#autostart').checked?'enable':'disable'});}finally{await refresh();}});
let offered=null,desktopInstalled=false,updateMessage='';
$('#open-running-server').onclick=()=>operation(async()=>{
  await invoke('connect_server',{mode:'local',address:'',secret:'',testOnly:false,newWindow:false,openPath:null,expectedServerId:null,deferServerUpdate:true});
  dialog.close();settingsDialog.close();
});
async function performDesktop(action,version=offered,{offer=true,startup=false,returnFocus=null}={}){
  const result=await invoke('desktop_action',{action,version:version||null});
  if(['light','dark'].includes(action)){updateMessage='App icon updated.';return result;}
  const messages={available:(result.component==='server'?'Local server version ':'Version ')+result.version+' is available.',current:'You are using the latest published versions.',installed:'Update installed. Restart Noctua to use it.',server_updating:'The local server is updating. Follow progress in Server & Connection.',skipped:''};
  if(!Object.prototype.hasOwnProperty.call(messages,result.status))throw Error('Unexpected desktop updater response');
  updateMessage=messages[result.status];
  if(result.status==='available'){
    offered=result.version;desktopInstalled=false;
      if(offer)await showDesktopOffer(result,startup,returnFocus);
  }else if(result.status==='current'){offered=null;desktopInstalled=false;}
  else if(result.status==='installed'){offered=null;desktopInstalled=true;}
  else if(result.status==='server_updating'){offered=null;desktopInstalled=false;}
  return result;
}
async function showDesktopOffer(result,startup=false,returnFocus=null){
  if($('#app-update-dialog'))return;
  await invoke('present_client');
  const previous=returnFocus||document.activeElement,prompt=document.createElement('dialog');
  prompt.id='app-update-dialog';prompt.className='connection-modal connection-update-modal';prompt.setAttribute('aria-labelledby','app-update-title');
  prompt.innerHTML='<h2 id="app-update-title">A new Noctua version is available</h2><div class="update-summary" tabindex="0" role="region" aria-label="Release history">'+NoctuaUpdateDialogs.summary(result,desktopVersion)+'</div><p>Save your work before updating. Installation may close and restart Noctua.</p><p class="connection-status" role="status"></p><div class="connection-actions"><button data-dismiss>Not now</button><button class="primary" data-install>Install update</button></div>';
  const close=()=>{if(busy)return;prompt.close();prompt.remove();if(previous?.isConnected)previous.focus();if(startup&&!dialog.open&&!settingsDialog.open)invoke('dismiss_connection').catch(()=>{});};
  prompt.querySelector('[data-dismiss]').onclick=close;
  prompt.addEventListener('cancel',event=>{event.preventDefault();close();});
  let action='install';
  prompt.querySelector('[data-install]').onclick=()=>operation(async()=>{
    try{
      const response=await performDesktop(action,result.version,{offer:false});
      prompt.querySelector('[role=status]').textContent=updateMessage;
      if(response.status==='installed'){action='restart';prompt.querySelector('[data-install]').textContent='Restart Noctua';}
      if(response.status==='server_updating')prompt.querySelector('[data-install]').remove();
    }catch(error){prompt.querySelector('[role=status]').textContent=String(error);throw error;}
  });
  document.body.appendChild(prompt);prompt.showModal();prompt.querySelector('[data-dismiss]').focus();
}
mode();render();openDialog();
// Give a saved connection a moment to restore before showing the manager.
// First-time setup and errors are shown immediately; a slow connection stays visible.
let startupFinished=false;
const startupTimer=setTimeout(()=>{if(!startupFinished&&!embedded)invoke('present_client').catch(()=>{});},1000);
operation(async()=>{
  try{
    const s=await refresh({restoreSelection:true});
    if(embedded){$('#server-management').open=true;}
    else if(s.connection.mode){showStep(1);await connect();}
    else await invoke('present_client');
  }catch(error){await invoke('present_client').catch(()=>{});throw error;}
  finally{startupFinished=true;clearTimeout(startupTimer);}
}).then(async()=>{
  if(startupMode&&!embedded)try{await performDesktop('startup_check',null,{startup:true});}catch(error){updateMessage='Could not check for a desktop update: '+String(error);}
});
setInterval(()=>{refresh().catch(error=>{localReady=null;renderLocalActions();if(!busy)status(String(error),'error');});},2000);
