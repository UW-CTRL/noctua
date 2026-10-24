// macOS: swift tests/updates.swift
// Exercise Settings update states without downloading or replacing the app.
import Foundation
import JavaScriptCore
let context = JSContext()!
context.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
let source = try String(contentsOfFile: "web/setup.js", encoding: .utf8)
let start = source.range(of: "function aboutSection")!.lowerBound
let end = source.range(of: "// First run stays short")!.lowerBound
context.evaluateScript(#"""
const esc = s => String(s);
let allow=true, calls=[], messages=[], fail=false, status='available';
const confirm = () => allow;
async function api(path,body){calls.push({path,body});if(fail)throw new Error('Network unavailable');return {status,version:'0.2.0'};}
const button={dataset:{updateAction:'check'},textContent:'Check for updates'};
const msg=(_,text)=>messages.push(text);
function assert(v,why){if(!v)throw new Error(why);}
"""# + String(source[start..<end]))
context.evaluateScript(#"""
(async()=>{
  assert(!aboutSection({desktop:false}).includes('data-act="update"'),'browser app offers native updates');
  assert(aboutSection({desktop:true}).includes('Check for updates'),'desktop update button missing');
  await updateApp(button,{},msg);
  assert(calls[0].path==='/api/desktop/update'&&calls[0].body.action==='check','check was not sent');
  assert(button.dataset.updateAction==='install'&&button.textContent==='Update to 0.2.0','available version not shown');
  allow=false;
  await updateApp(button,{},msg);
  assert(calls.length===1&&button.dataset.updateAction==='install','cancelled confirmation installed update');
  allow=true;status='installed';
  await updateApp(button,{},msg);
  assert(calls[1].body.action==='install'&&button.dataset.updateAction==='restart','installation did not offer restart');
  await updateApp(button,{},msg);
  assert(calls[2].body.action==='restart','restart not sent');
  fail=true;button.dataset.updateAction='install';
  try {await updateApp(button,{},msg);throw new Error('failure hidden');} catch(e){assert(e.message==='Network unavailable','wrong error');}
  assert(button.dataset.updateAction==='check'&&button.textContent==='Check for updates','failure did not reset button');
  fail=false;status='current';
  await updateApp(button,{},msg);
  assert(button.dataset.updateAction==='check'&&messages.at(-1).includes('latest published'),'up-to-date state missing');
  status='installed';
  await updateApp(button,{},msg);
  assert(button.dataset.updateAction==='restart','install in another window not recovered');
  status='unexpected';
  try {await updateApp(button,{},msg);throw new Error('invalid response accepted');} catch(e){assert(e.message.includes('Unexpected response'),'wrong response error');}
  globalThis.result='PASS: desktop visibility, check, install confirmation, restart, failure recovery, current version, and cross-window recovery';
})().catch(e=>globalThis.result='FAIL: '+e.message+' '+e.stack);
"""#)
let deadline = Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
let result = context.objectForKeyedSubscript("result").toString() ?? "FAIL: timed out"
print(result)
if !result.hasPrefix("PASS:") { exit(1) }
