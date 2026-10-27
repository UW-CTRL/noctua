import Foundation
import JavaScriptCore
let context=JSContext()!
context.exceptionHandler={_,error in print(error?.toString() ?? "JavaScript error");exit(1)}
let source=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let renderStart=source.range(of:"function zoteroSection(")!.lowerBound
let renderEnd=source.range(of:"const ASSISTANT_MODELS")!.lowerBound
let clickStart=source.range(of:"card.addEventListener('click', async (e) => {")!.upperBound
let clickEnd=source.range(of:"\n  });",range:clickStart..<source.endIndex)!.lowerBound
context.evaluateScript(#"""
const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',disabled:false});return nodes.get(id);};
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const section={querySelectorAll:()=>[...nodes.values()]},card={querySelectorAll:()=>[]};
let settings={zotero_pdf_mode:'link'},calls=[],message='',refreshed=0,fail=false,loginAbort=null;
function toast(text){message=text;}function msg(section,text){message=text;}
async function api(path,body){calls.push({path,body});if(fail)throw Error('disk unavailable');settings.zotero_dir=body.dir;}
async function next(step){if(step!=='zotero')throw Error('wrong refreshed section');refreshed++;}
function assert(v,m){if(!v)throw Error(m);}
const target={closest:s=>s==='[data-act]'?{dataset:{act:'save-zotero'},closest:()=>section}:null};
"""# + String(source[renderStart..<renderEnd]) + "\nasync function click(e){" + String(source[clickStart..<clickEnd]) + "\n}")
context.evaluateScript(#"""
(async()=>{
 const defaults=zoteroSection({zotero_dir:'/test/Zotero'},false);
 assert(defaults.includes('/test/Zotero'),'configured folder missing');
 assert(defaults.includes('class="zotero-location"><input')&&defaults.includes('data-act="save-zotero">Save Zotero location</button></div>'),'location save button must be grouped with the path input');
 assert(!defaults.includes('setup-zotero-pdf')&&!defaults.includes('Save default'),'PDF storage must only appear in the import dialog');
 const env=zoteroSection({zotero_source:'env',zotero_dir:'/env/Zotero'},false);
 assert(env.includes('/env/Zotero')&&!env.includes('setup-zotero-pdf'),'environment source or PDF controls incorrect');
 $('#setup-zotero').value='/test/Zotero';await click({target,preventDefault(){}});
 assert(calls[0].path==='/api/settings/zotero'&&calls[0].body.dir==='/test/Zotero'&&refreshed===1,'folder not saved');
 fail=true;await click({target,preventDefault(){}});
 assert(refreshed===1&&message.includes('disk unavailable'),'failed save hid error');
 globalThis.result='PASS: Zotero source folder, environment configuration, persistence and save failure';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#)
let deadline=Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=context.objectForKeyedSubscript("result").toString() ?? "FAIL: timed out"
print(result)
if !result.hasPrefix("PASS:"){exit(1)}
