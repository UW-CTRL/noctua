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
async function api(path,body){calls.push({path,body});if(fail)throw Error('disk unavailable');settings.zotero_pdf_mode=body.pdf_mode;}
async function next(step){if(step!=='zotero')throw Error('wrong refreshed section');refreshed++;}
function assert(v,m){if(!v)throw Error(m);}
const target={closest:s=>s==='[data-act]'?{dataset:{act:'save-zotero-pdf'},closest:()=>section}:null};
"""# + String(source[renderStart..<renderEnd]) + "\nasync function click(e){" + String(source[clickStart..<clickEnd]) + "\n}")
context.evaluateScript(#"""
(async()=>{
 const defaults=zoteroSection({zotero_dir:'/test/Zotero'},false);
 assert(defaults.includes('value="link" selected')&&defaults.includes('/test/Zotero'),'default link or configured folder missing');
 const copy=zoteroSection({zotero_pdf_mode:'copy',zotero_source:'env',zotero_dir:'/env/Zotero'},false);
 assert(copy.includes('value="copy" selected')&&copy.includes('data-act="save-zotero-pdf"'),'saved copy preference or environment override controls missing');
 $('#setup-zotero-pdf').value='copy';await click({target,preventDefault(){}});
 assert(calls[0].path==='/api/settings/zotero-pdf'&&calls[0].body.pdf_mode==='copy'&&refreshed===1,'PDF default not persisted or settings not refreshed');
 fail=true;$('#setup-zotero-pdf').value='link';await click({target,preventDefault(){}});
 assert(settings.zotero_pdf_mode==='copy'&&refreshed===1&&message.includes('disk unavailable'),'failed save changed default or hid error');
 assert(!$('#setup-zotero-pdf').disabled,'failed save left preference disabled');
 globalThis.result='PASS: Zotero PDF defaults, source-folder display, environment configuration, persistence and save failure';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#)
let deadline=Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=context.objectForKeyedSubscript("result").toString() ?? "FAIL: timed out"
print(result)
if !result.hasPrefix("PASS:"){exit(1)}
