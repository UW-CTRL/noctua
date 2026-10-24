// macOS: swift tests/paper-opening.swift
import Foundation
import JavaScriptCore
let context = JSContext()!
context.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
let source = try String(contentsOfFile:"web/library.js",encoding:.utf8)
let a = source.range(of:"async function openPaperView(")!.lowerBound
let b = source.range(of:"async function readDiscoveredPaper(")!.lowerBound
let mocks = #"""
const enc=encodeURIComponent,calls=[];
let settings={desktop:false};
const window={screen:{availWidth:1024,availHeight:768},open:(...args)=>calls.push({open:args})};window.parent=window;
async function openPDF(key,options){calls.push({read:key,options});}
async function api(path,body){calls.push({path,body});}
function toast(message){calls.push({error:message});}
function assert(value,message){if(!value)throw Error(message);}
"""#
let checks = #"""
(async()=>{
 await openPaperView('paper/key','window',{page:7});let call=calls.pop();
 assert(call.open[0]==='/#pdf=paper%2Fkey&page=7','new window lost paper or page');
 assert(call.open[2].includes('popup=yes')&&call.open[2].includes('width=1024')&&call.open[2].includes('height=768')&&call.open[2].includes('noopener'),'browser window did not request a separate bounded window');
 await openPaperView('paper','tab');call=calls.pop();assert(call.open[2]==='noopener','browser tab became a popup');
 window.parent={noctuaShell:{openTab:url=>calls.push({shell:url})}};
 await openPaperView('paper','tab');assert(calls.pop().shell==='/#pdf=paper&page=1','desktop tab routing regressed');
 settings.desktop=true;await openPaperView('paper','window',{page:3});call=calls.pop();assert(call.path==='/api/desktop/window'&&call.body.url.endsWith('page=3'),'native window routing regressed');
 await openPaperView('paper','here',{page:2});call=calls.pop();assert(call.read==='paper'&&call.options.page===2,'inline PDF opening regressed');
 globalThis.result='PASS: browser windows vs tabs, screen bounds, paper/page URLs, native windows and inline reading';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#
context.evaluateScript(mocks + String(source[a..<b]) + checks)
let deadline = Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date()<deadline { RunLoop.current.run(until:Date().addingTimeInterval(0.01)) }
let result=context.objectForKeyedSubscript("result").toString() ?? "FAIL: timed out"
print(result)
if !result.hasPrefix("PASS:") { exit(1) }
