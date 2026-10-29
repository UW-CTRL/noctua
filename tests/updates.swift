// macOS: swift tests/updates.swift
// Exercise Settings update states without downloading or replacing the app.
import Foundation
import JavaScriptCore
let context = JSContext()!
context.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
let shared = try String(contentsOfFile: "web/update-dialogs.js", encoding: .utf8)
let source = try String(contentsOfFile: "web/setup.js", encoding: .utf8)
let start = source.range(of: "function updateSummary")!.lowerBound
let end = source.range(of: "// First run stays short")!.lowerBound
context.evaluateScript(#"""
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const settings={version:'0.1.0'};let native=false;function isDesktopConnectionClient(){return native;}
let allow=true, calls=[], nativeCalls=[], messages=[], fail=false, status='available';
const window={top:{noctuaAppVersion:'0.1.0',noctuaDesktopUpdate:async(action,version)=>{
  nativeCalls.push({action,version});
  if(fail)throw new Error('Native updater unavailable');
  return {status,version:'0.2.0'};
}}};
const confirm = () => { throw new Error('Native confirmation must not be used'); };
async function api(path,body){calls.push({path,body});if(fail)throw new Error('Network unavailable');return {status,version:'0.2.0'};}
const button={dataset:{updateAction:'check'},textContent:'Check for updates'};
const section={querySelector(){return null;}};
const msg=(_,text)=>messages.push(text);
function assert(v,why){if(!v)throw new Error(why);}
"""# + shared + String(source[start..<end]))
context.evaluateScript(#"""
// DOM confirmation is exercised in updates-ui.swift; keep state tests DOM-free.
confirmUpdateInstall = async () => allow;
(async()=>{
  assert(!aboutSection({desktop:false}).includes('data-act="update"'),'browser app offers native updates');
  assert(aboutSection({desktop:true}).includes('Check for updates'),'desktop update button missing');
  native=true;
  const nativeAbout=aboutSection({desktop:false,version:'9.9.9'});
  assert(nativeAbout.includes('Check for updates')&&!nativeAbout.includes('data-client-section='),'independent desktop must update directly in About');
  assert(nativeAbout.includes('Version 0.1.0 · Desktop app'),'About must show the client version rather than the server version');
  native=false;
  const html=updateSummary({current_version:'0.1.0',version:'0.3.0',releases:[{version:'0.3.0',changes:[{kind:'fixes',items:['<img src=x onerror=alert(1)>']}]}]});
  assert(html.includes('0.1.0 → 0.3.0')&&html.includes('Fixed:'),'version range or category missing');
  assert(!html.includes('<img')&&html.includes('&lt;img'),'release highlight was not escaped');
  assert(html.includes('compare/v0.1.0...v0.3.0'),'full comparison link missing');
  assert(updateSummary({version:'0.2.0'}).includes('full release notes'),'legacy metadata fallback missing');
  await updateApp(button,section,msg);
  assert(calls[0].path==='/api/desktop/update'&&calls[0].body.action==='check','check was not sent');
  assert(button.dataset.updateAction==='install'&&button.textContent==='Update to 0.2.0','available version not shown');
  allow=false;
  await updateApp(button,section,msg);
  assert(calls.length===1&&button.dataset.updateAction==='install','cancelled confirmation installed update');
  allow=true;status='installed';
  await updateApp(button,section,msg);
  assert(calls[1].body.action==='install'&&button.dataset.updateAction==='restart','installation did not offer restart');
  await updateApp(button,section,msg);
  assert(calls[2].body.action==='restart','restart not sent');
  fail=true;button.dataset.updateAction='install';
  try {await updateApp(button,section,msg);throw new Error('failure hidden');} catch(e){assert(e.message==='Network unavailable','wrong error');}
  assert(button.dataset.updateAction==='check'&&button.textContent==='Check for updates','failure did not reset button');
  fail=false;status='current';
  await updateApp(button,section,msg);
  assert(button.dataset.updateAction==='check'&&messages.at(-1).includes('latest published'),'up-to-date state missing');
  status='installed';
  await updateApp(button,section,msg);
  assert(button.dataset.updateAction==='restart','install in another window not recovered');
  status='unexpected';
  try {await updateApp(button,section,msg);throw new Error('invalid response accepted');} catch(e){assert(e.message.includes('Unexpected response'),'wrong response error');}
  const httpCalls=calls.length,nativeButton={dataset:{updateAction:'check'},textContent:'Check for updates'};
  native=true;status='available';
  await updateApp(nativeButton,section,msg);
  assert(nativeCalls.at(-1).action==='check'&&nativeButton.dataset.updateAction==='install','desktop check must use the native bridge');
  allow=false;status='installed';
  await updateApp(nativeButton,section,msg);
  assert(nativeCalls.at(-1).action==='install'&&nativeCalls.at(-1).version==='0.2.0'&&nativeButton.dataset.updateAction==='restart','native installation must pass the checked version and defer confirmation to the native process');
  await updateApp(nativeButton,section,msg);
  assert(nativeCalls.at(-1).action==='restart'&&calls.length===httpCalls,'desktop updates must not use server HTTP endpoints');
  fail=true;nativeButton.dataset.updateAction='install';
  try {await updateApp(nativeButton,section,msg);throw new Error('native failure hidden');} catch(e){assert(e.message==='Native updater unavailable','wrong native error');}
  assert(nativeButton.dataset.updateAction==='check','native failure must allow a new check');
  globalThis.result='PASS: About visibility, client version, HTTP and native update routing, version-pinned installation, confirmation ownership, restart and failure recovery';
})().catch(e=>globalThis.result='FAIL: '+e.message+' '+e.stack);
"""#)
let deadline = Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
let result = context.objectForKeyedSubscript("result").toString() ?? "FAIL: timed out"
print(result)
if !result.hasPrefix("PASS:") { exit(1) }
