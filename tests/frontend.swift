// macOS: swift tests/frontend.swift
// Parse the shipped JavaScript and exercise backend switching in JavaScriptCore.
import Foundation
import JavaScriptCore
let context = JSContext()!
var failed = false
context.exceptionHandler = { _, error in
    print(error?.toString() ?? "JavaScript error")
    failed = true
}
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
for name in ["web/connection.js", "app/dist/client.js", "web/edit-history.js", "web/workspace.js", "web/figures.js", "web/latex.js", "web/app.js", "web/lineage.js", "web/setup.js", "web/notes.js", "web/library.js", "web/shell.js", "web/mentions.js", "web/select.js", "web/fonts.js", "web/chat-render.js", "web/chat-selections.js", "web/pdf.js", "web/pdf-objects.js"] {
    let source = try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
    _ = context.objectForKeyedSubscript("Function").call(withArguments: [source])
    if failed { print("FAIL: \(name)"); exit(1) }
}
let app = try String(contentsOf: root.appendingPathComponent("web/app.js"), encoding: .utf8)
func section(_ start: String, _ end: String) -> String {
    let a = app.range(of: start)!.lowerBound
    let b = app.range(of: end, range: a..<app.endIndex)!.lowerBound
    return String(app[a..<b])
}
let mocks = #"""
const elements = new Map();
let $ = (id) => {
  if (!elements.has(id)) elements.set(id, {value:'',disabled:false});
  return elements.get(id);
};
const enc = encodeURIComponent;
const chat = {provider:'claude',ready:false,switching:false,id:null,running:null};
const values = new Map([['noctua.chat','legacy-claude'],['noctua.chat.codex','codex-history']]);
const store = {get:k=>values.get(k),set:(k,v)=>values.set(k,v)};
const calls = [];
let settings = {}, saving = false;
async function api(path, body) {
  calls.push({path, body});
  if (path.startsWith('/api/chats/')) {
    if (saving) {saving=false;return {busy:true};}
    return {busy:false};
  }
  return {};
}
function setTimeout(fn) { fn(); }
function toggleChatHistory() {}
function refreshAgentBadge() {}
function setChatId(id) { chat.id=id;store.set('noctua.chat.'+chat.provider,id||''); }
async function openChat(id) { setChatId(id); }
function chatWelcome() {}
function assert(value, why) { if (!value) throw new Error(why); }
"""#
let checks = #"""
(async () => {
  await activateAgent('claude',{persist:false});
  assert(chat.id==='legacy-claude','legacy Claude conversation was not restored');
  assert(store.get('noctua.chat')==='','legacy pointer was not migrated');
  $('#chat-input').value='Claude draft';
  let aborted=false;
  chat.abort={abort:()=>{aborted=true;}};
  chat.running=Promise.resolve();saving=true;
  await activateAgent('codex');
  assert(aborted,'switch did not stop the previous turn');
  assert(chat.id==='codex-history','Codex conversation was not restored');
  assert(store.get('noctua.chat.claude')==='legacy-claude','Claude history pointer was overwritten');
  assert($('#chat-input').value==='','Claude draft leaked into Codex');
  $('#chat-input').value='Codex draft';
  await activateAgent('claude');
  assert($('#chat-input').value==='Claude draft','Claude draft was not restored');
  assert(store.get('noctua.chatDraft.codex')==='Codex draft','Codex draft was not saved');
  assert(!$('#setup-agent').disabled&&!chat.switching,'switch controls stayed disabled');
  assert(calls.filter(c=>c.path.includes('legacy-claude')).length>=2,'switch did not wait for history persistence');
  // Provider switching also works when Settings is closed.
  const lookup=$; $=id=>id==='#setup-agent'?null:lookup(id);
  await activateAgent('codex');
  assert(chat.provider==='codex'&&!chat.switching,'switch failed with Settings closed');
  $=lookup;
  const before=chat.provider;
  const realApi=api;
  api=async (path,body)=>{if(path==='/api/settings/agent')throw new Error('disk full');return realApi(path,body);};
  try{await activateAgent('claude');throw new Error('expected failure');}catch(e){assert(e.message==='disk full','wrong failure');}
  assert(chat.provider===before,'failed preference save changed the active backend');
  assert(!$('#setup-agent').disabled&&!chat.switching,'failed switch did not recover controls');
  globalThis.testResult='PASS: JS syntax, legacy chat restore, backend switching, separate drafts, interrupted-turn persistence, and failure recovery';
})().catch(e=>{globalThis.testResult='FAIL: '+e.stack;});
"""#
context.evaluateScript(mocks + section("async function stopChat()", "async function refreshAgentBadge()") + checks)
let deadline = Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("testResult").isUndefined && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
let result = context.objectForKeyedSubscript("testResult").toString() ?? "FAIL: no result"
print(result)
if failed || !result.hasPrefix("PASS:") { exit(1) }

let storage = JSContext()!
storage.exceptionHandler = { _, error in print(error?.toString() ?? "Storage regression failed"); exit(1) }
let start = app.range(of:"const clientPreference")!.lowerBound
let stop = app.range(of:"// ---------------------------------------------------------------- API")!.lowerBound
storage.evaluateScript("const window={noctuaServerId:'A'},values=new Map(),localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};" + String(app[start..<stop]) + #"""
function check(v,m){if(!v)throw Error(m)}
store.set('pdf-draft:fontHeight','A draft');store.set('noctua.theme','dark');
window.noctuaServerId='B';check(store.get('pdf-draft:fontHeight')===null,'cache key text bypassed server isolation');
store.set('pdf-draft:fontHeight','B draft');store.remove('pdf-draft:fontHeight');check(store.get('pdf-draft:fontHeight')===null,'scoped cache removal failed');
check(store.get('noctua.theme')==='dark','device appearance was unexpectedly server-scoped');
window.noctuaServerId='A';check(store.get('pdf-draft:fontHeight')==='A draft','another server removed this draft');
"""#)
print("PASS: server-scoped cache reads/writes/removal and shared device appearance")
