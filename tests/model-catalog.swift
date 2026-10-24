// macOS: swift tests/model-catalog.swift
// Exercise asynchronous CLI catalog refreshes without altering user settings.
import Foundation
import JavaScriptCore

let context = JSContext()!
context.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
let source = try String(contentsOfFile: "web/setup.js", encoding: .utf8)
let helpers = String(source[source.range(of: "const ASSISTANT_MODELS")!.lowerBound..<source.range(of: "function agentSection")!.lowerBound])
let checker = String(source[source.range(of: "  let agentCheck = 0;")!.lowerBound..<source.range(of: "  const signIn = async")!.lowerBound])
context.evaluateScript(#"""
const nodes = new Map();
function $(id) {
  if (!nodes.has(id)) nodes.set(id, {value:'',checked:false,disabled:false,hidden:false,innerHTML:'',textContent:''});
  return nodes.get(id);
}
const el = {isConnected:true}, message = {textContent:''};
const card = {querySelector(){return message;}};
let loginAbort = null, assistantSaving = false, mode = 'success', waiting = [];
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
function msg(section, text) {message.textContent=text;}
function assert(value, why) {if(!value)throw new Error(why);}
async function api(path) {
  if (!path.endsWith('/models')) return {installed:true,signed_in:true};
  if (mode === 'error') throw new Error('catalog offline');
  if (mode === 'deferred') return new Promise(resolve=>waiting.push(resolve));
  return path.includes('/claude/') ? {models:[{id:'live-claude',label:'Claude from CLI',reasoning_efforts:['medium'],supports_fast:false,is_default:true}]} :
    {models:[{id:'live-model',reasoning_efforts:['low'],is_default:true}]};
}
"""# + helpers + "\nfunction makeChecker() {" + checker + "return checkAgent;}\nconst checkAgent=makeChecker();")
context.evaluateScript(#"""
(async()=>{
  $('#setup-agent').value='codex';
  $('#setup-model').value='custom';
  $('#setup-custom-model').value='my-unsaved-draft';
  $('#setup-reasoning').value='high';
  await checkAgent();
  assert(ASSISTANT_MODELS.codex[0][0]==='live-model','CLI catalog was not used');
  assert($('#setup-model').value==='custom' && $('#setup-custom-model').value==='my-unsaved-draft','refresh lost custom draft');
  assert($('#setup-reasoning').value==='high','refresh changed unsaved effort');
  assert(!$('#setup-model').innerHTML.includes('900k'),'fabricated model appeared');

  mode='deferred';
  let pending=checkAgent();
  $('#setup-agent').value='claude';
  waiting.shift()({models:[{id:'stale-model',reasoning_efforts:[]}]});
  await pending;
  assert(ASSISTANT_MODELS.codex[0][0]==='live-model','provider switch accepted stale catalog');

  $('#setup-agent').value='codex';
  const first=checkAgent(), second=checkAgent();
  const older=waiting.shift(), newer=waiting.shift();
  newer({models:[{id:'new-model',reasoning_efforts:['low']}]});
  await second;
  older({models:[{id:'old-model',reasoning_efforts:[]}]});
  await first;
  assert(ASSISTANT_MODELS.codex[0][0]==='new-model','old response overwrote newer catalog');

  mode='error';modelCatalogs.codex=null;ASSISTANT_MODELS.codex=[];
  $('#setup-model').disabled=true;
  await checkAgent();
  assert(!$('#setup-model').disabled,'discovery failure left model picker disabled');
  assert(message.textContent.includes('catalog offline'),'discovery error was hidden');
  assert($('#setup-custom-model').value==='my-unsaved-draft','failure discarded custom draft');
  assert(ASSISTANT_MODELS.codex.length===0,'failure invented fallback models');
  mode='success';$('#setup-agent').value='claude';$('#setup-model').value='';
  await checkAgent();
  assert(ASSISTANT_MODELS.claude[0][0]==='live-claude','Claude catalog was not loaded');
  assert($('#setup-model').innerHTML.includes('Claude from CLI'),'Claude display name was lost');
  assert($('#setup-fast').disabled,'Claude fast mode capability was ignored');
  assert($('#setup-fast-field').hidden,'catalog refresh left unsupported fast mode visible');
  assert(assistantEfforts('claude','').join(',')==='medium','Claude default model efforts were ignored');
  assert(ASSISTANT_MODELS.codex.length===0,'Claude discovery modified the Codex catalog');
  globalThis.result='PASS: live model catalogs, custom drafts, stale-response protection, and failure recovery';
})().catch(e=>globalThis.result='FAIL: '+e.message+' '+e.stack);
"""#)
let deadline = Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
let result = context.objectForKeyedSubscript("result").toString() ?? "FAIL: timed out"
print(result)
if !result.hasPrefix("PASS:") { exit(1) }
