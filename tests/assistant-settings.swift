// macOS: swift tests/assistant-settings.swift
// Exercise assistant controls and persistence behavior in JavaScriptCore.
import Foundation
import JavaScriptCore
let context = JSContext()!
context.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
let source = try String(contentsOfFile: "web/setup.js", encoding: .utf8)
let helpers = String(source[source.range(of: "const ASSISTANT_MODELS")!.lowerBound..<source.range(of: "function agentSection")!.lowerBound])
let start = source.range(of: "card.addEventListener('change', async (e) => {")!.upperBound
let end = source.range(of: "\n  });", range: start..<source.endIndex)!.lowerBound
context.evaluateScript(#"""
const nodes = new Map();
const $ = id => { if (!nodes.has(id)) nodes.set(id, {id:id.slice(1),value:'',checked:false,disabled:false,focus(){this.focused=true;},closest(){return section;}}); return nodes.get(id); };
const section = {querySelectorAll(){return [...nodes.values()];}};
const chat = {provider:'claude'};
const settings = {assistant:{}};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
let message='', fail=false, calls=[], assistantSaving=false;
function msg(s,text){message=text;}
function toast(text){throw new Error(text);}
async function api(path,body){calls.push({path,body});if(fail)throw new Error('disk full');}
async function activateAgent(provider){chat.provider=provider;}
async function checkAgent(){}
function assert(v,why){if(!v)throw new Error(why);}
"""# + helpers + "\nasync function change(e) {" + String(source[start..<end]) + "\n}")
context.evaluateScript(#"""
(async()=>{
  assert(!assistantOptions({},'codex').includes('gpt-6.1-sol'),'model names were hardcoded before discovery');
  assert(!assistantOptions({},'claude').includes('>Opus<'),'Claude model names were hardcoded before discovery');
  modelCatalogs.codex = [{id:'gpt-6.1-sol',reasoning_efforts:['low','high'],is_default:true}, {id:'catalog-luna',reasoning_efforts:['low'],is_default:false}];
  ASSISTANT_MODELS.codex = modelCatalogs.codex.map(m=>[m.id,m.id]);
  modelCatalogs.claude = [{id:'opus',label:'Opus',reasoning_efforts:['low','medium','high','max'],supports_fast:true,is_default:true}, {id:'sonnet',label:'Sonnet',reasoning_efforts:['low','high'],supports_fast:false}];
  ASSISTANT_MODELS.claude = modelCatalogs.claude.map(m=>[m.id,m.label]);
  assert(assistantOptions({},'claude').includes('Provider default'),'legacy defaults missing');
  assert(!assistantOptions({},'claude').includes('gpt-6'),'Codex models leaked into Claude');
  assert(!assistantOptions({},'codex').includes('>Opus<'),'Claude models leaked into Codex');
  const custom=assistantOptions({assistant:{claude:{model:'a"<b',reasoning:'high',fast:true}}},'claude');
  assert(custom.includes('a&quot;&lt;b'),'custom model was not escaped');
  assert(custom.includes('value="custom" selected'),'custom model selection not restored');
  $('#setup-model').value='opus';$('#setup-reasoning').value='high';$('#setup-fast').checked=true;
  await change({target:$('#setup-model')});
  assert(settings.assistant.claude.model==='opus'&&settings.assistant.claude.fast,'settings not saved');
  assert(calls.at(-1).body.options.reasoning==='high','reasoning not sent');
  $('#setup-model').value='custom';
  const before=calls.length;
  await change({target:$('#setup-model')});
  assert(calls.length===before&&$('#setup-custom-model').focused,'custom selection saved prematurely');
  await change({target:$('#setup-custom-model')});
  assert(calls.length===before&&message.includes('Enter a custom'),'empty custom model accepted');
  $('#setup-custom-model').value='  my-model  ';
  await change({target:$('#setup-custom-model')});
  assert(settings.assistant.claude.model==='my-model','custom model did not save');
  fail=true;$('#setup-reasoning').value='max';
  await change({target:$('#setup-reasoning')});
  assert(message==='disk full','save failure was hidden');
  assert(settings.assistant.claude.reasoning==='high','failed save overwrote saved settings');
  assert([...nodes.values()].every(n=>!n.disabled),'failure left controls disabled');
  fail=false;$('#setup-agent').value='codex';
  await change({target:$('#setup-agent')});
  assert($('#assistant-options').innerHTML.includes('gpt-6.1-sol'),'provider switch did not refresh models');
  $('#setup-model').value='gpt-6.1-sol';$('#setup-fast').checked=false;$('#setup-reasoning').value='';
  await change({target:$('#setup-model')});
  assert(settings.assistant.codex.model==='gpt-6.1-sol','Codex settings not saved');
  assert(settings.assistant.claude.model==='my-model','switch overwrote Claude preferences');
  $('#setup-model').value='catalog-luna';$('#setup-reasoning').value='high';
  await change({target:$('#setup-model')});
  assert(settings.assistant.codex.reasoning==='','switch kept an unsupported reasoning effort');
  assert(!$('#setup-reasoning').innerHTML.includes('value="high"'),'unsupported reasoning effort was offered');
  const old = assistantOptions({assistant:{codex:{model:'old-custom-model'}}},'codex');
  assert(old.includes('value="custom" selected')&&old.includes('old-custom-model'),'saved custom model was lost');
  $('#setup-agent').value='claude';await change({target:$('#setup-agent')});
  assert($('#assistant-options').innerHTML.includes('my-model'),'switch did not restore custom model');
  $('#setup-model').value='sonnet';$('#setup-fast').checked=true;
  await change({target:$('#setup-model')});
  assert($('#setup-fast').disabled&&!settings.assistant.claude.fast,'Sonnet accepted fast mode');
  assert($('#setup-fast-field').hidden,'unsupported fast mode stayed visible');
  $('#setup-model').value='opus';await change({target:$('#setup-model')});
  assert(!$('#setup-fast').disabled,'Opus fast mode stayed disabled');
  assert(!$('#setup-fast-field').hidden,'supported fast mode stayed hidden');
  globalThis.result='PASS: provider controls, custom models, reasoning, fast mode, per-provider persistence, and save failure recovery';
})().catch(e=>globalThis.result='FAIL: '+e.message+' '+e.stack);
"""#)
let deadline = Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
let result = context.objectForKeyedSubscript("result").toString() ?? "FAIL: timed out"
print(result)
if !result.hasPrefix("PASS:") { exit(1) }
