'use strict';
const $ = s => document.querySelector(s);
const invoke = (command,args={}) => window.__TAURI_INTERNALS__.invoke(command,args);
let busy=false;
function status(message,state=''){$('#status').textContent=message;$('#status').dataset.state=state;}
async function operation(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn()}catch(e){status(String(e),'error')}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)}}
function mode(){ $('#remote').hidden=$('#mode').value!=='remote'; }
$('#mode').onchange=mode;
async function connect(testOnly=false){
  status('Checking server identity, compatibility and authentication…');
  const identity=await invoke('connect_server',{mode:$('#mode').value,address:$('#address').value,secret:$('#secret').value,testOnly,newWindow:new URLSearchParams(location.search).has('new'),openPath:new URLSearchParams(location.search).get('open')});
  $('#secret').value='';$('#identity').textContent=JSON.stringify(identity,null,2);status(testOnly?'Connection test passed.':'Connected. Server tasks continue after closing the app.','ready');
}
$('#connect').onclick=()=>operation(()=>connect());$('#test').onclick=()=>operation(()=>connect(true));
$('#change').onclick=()=>operation(async()=>{await invoke('clear_connection');status('Saved connection cleared. Choose a server; existing data and open windows are preserved.');});
async function refresh({restoreSelection=false}={}) {
  const state=await invoke('client_state');
  if(restoreSelection){$('#mode').value=state.connection.mode||'local';$('#address').value=state.connection.address||'';mode();}
  $('#autostart').checked=!!state.service.enabled;$('#autostart').disabled=!state.service.supported;
  $('#service').textContent=state.service.error||(!state.service.supported?'Login auto-start is unavailable on this platform.':state.service.enabled?'Login auto-start is enabled.':state.service.installed?'Login auto-start is disabled.':'Login auto-start is not installed.');
  $('#service').dataset.state=state.service.error?'error':'';
  $('#local-status').textContent=state.local?'This computer’s server is ready.':(state.local_error||'This computer’s server is not running.');
  $('#local-status').dataset.state=state.local?'ready':state.local_error?'error':'';
  $('#connection-status').textContent=state.current?.reachable?'Current server is reachable.':(state.current?.error?'Current server unavailable: '+state.current.error:'No active connection.');
  $('#connection-status').dataset.state=state.current?.reachable?'ready':state.current?.error?'error':'';
  if(state.current?.identity)$('#identity').textContent=JSON.stringify(state.current.identity,null,2);
  else if($('#mode').value==='local'&&state.local)$('#identity').textContent=JSON.stringify(state.local,null,2);
  return state;
}
$('#local-actions').onclick=e=>{const action=e.target.dataset.action;if(action)operation(async()=>{const r=await invoke('local_server',{action});if(action==='logs')$('#logs').textContent=r.log;else{status(action+' completed','ready');await refresh();}});};
$('#autostart').onchange=()=>operation(async()=>{try{await invoke('local_server',{action:$('#autostart').checked?'enable':'disable'});}finally{await refresh();}});
let offered;
document.querySelectorAll('[data-desktop]').forEach(b=>b.onclick=()=>operation(async()=>{const r=await invoke('desktop_action',{action:b.dataset.desktop,version:offered||null});if(r.version)offered=r.version;$('#update').textContent=JSON.stringify(r,null,2);}));
operation(async()=>{const s=await refresh({restoreSelection:true});if(s.connection.mode)await connect();});
setInterval(()=>{if(!busy)refresh().catch(error=>{status(String(error),'error');});},10000);
