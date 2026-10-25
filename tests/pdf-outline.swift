// macOS: swift tests/pdf-outline.swift
import Foundation
import JavaScriptCore
let context=JSContext()!
context.exceptionHandler={_,error in print(error?.toString() ?? "JS error");exit(1)}
let pdf=try String(contentsOfFile:"web/pdf.js",encoding:.utf8)
let app=try String(contentsOfFile:"web/app.js",encoding:.utf8)
func section(_ source:String,_ start:String,_ end:String)->String {
 let a=source.range(of:start)!.lowerBound,b=source.range(of:end,range:a..<source.endIndex)!.lowerBound
 return String(source[a..<b])
}
context.evaluateScript(#"""
const pdfOutlines=new Map(),PDF={key:'paper',doc:{}},timers=[];
const classes=new Set(['hidden']),toastElement={textContent:'',dataset:{},setAttribute(){},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)}};
const panel={innerHTML:'',setAttribute(){},querySelector(){return {addEventListener(){}}},querySelectorAll(){return []}};
const $=selector=>selector==='#toast'?toastElement:panel;
const esc=String,paperURL=key=>'/api/papers/'+key;
let apiCalls=0;let api=async(path,body)=>{apiCalls++;if(body)throw Error('The outline sections are not in reading order. Try again.');return null;};
let deletes=0,deleteFailure=false;async function libraryRequest(path,method){assert(method==='DELETE'&&path.endsWith('/outline'),'delete must use the outline endpoint');deletes++;if(deleteFailure)throw Error('Could not delete outline');return {ok:true};}
let nativeCalls=0,nativeResult={source:'document',entries:[{title:'Embedded section',page:1,level:1}]};
async function nativePDFOutline(){nativeCalls++;return nativeResult;}
async function indexPDF(){}function updatePDFOutlineSelection(){}function clearTimeout(){}
function setTimeout(fn,delay){timers.push({fn,delay});return timers.length;}
function assert(v,m){if(!v)throw Error(m);}
"""#+section(app,"let toastTimer =", "function showTab(")+section(pdf,"function pdfOutlineState(","function updatePDFOutlineSelection()"))
context.evaluateScript(#"""
(async()=>{
 await loadPDFOutline('paper',PDF.doc);
 assert(apiCalls===0&&nativeCalls===1&&PDF.outlineSource!=='ai'&&panel.innerHTML.includes('Embedded section'),'opening Outline must display only the document outline without AI requests');
 assert(panel.innerHTML.indexOf('>Document<')<panel.innerHTML.indexOf('>AI-generated<'),'document and AI sources must be left and right tabs');
 await setPDFOutlineSource('ai');
 assert(PDF.outlineSource==='ai'&&pdfOutlines.get('paper').documentOutline===nativeResult,'the AI tab must switch immediately without replacing the document outline');
 assert(toastElement.textContent==='The outline sections are not in reading order. Try again.'&&!classes.has('hidden'),'generation errors must show the bottom-right toast');
 assert(timers.at(-1).delay===5000,'outline error toast must disappear after five seconds');
 assert(panel.innerHTML.includes('data-outline-retry')&&!panel.innerHTML.includes('reading order')&&!panel.innerHTML.includes('role="alert"'),'sidebar must keep Retry without a persistent error message');
 timers.at(-1).fn();assert(classes.has('hidden'),'error toast did not auto-dismiss');
 const saved={source:'ai',entries:[{title:'Introduction',page:1,level:1}]};Object.assign(pdfOutlines.get('paper'),{status:'ready',outline:saved});
 await loadPDFOutline('paper',PDF.doc,{forceAI:true,regenerate:true});
 assert(pdfOutlines.get('paper').outline===saved&&panel.innerHTML.includes('Introduction'),'failed regeneration must preserve the saved outline');
 await setPDFOutlineSource('document');assert(panel.innerHTML.includes('Embedded section')&&!panel.innerHTML.includes('Introduction'),'switching back must restore the original embedded outline');
 Object.assign(pdfOutlines.get('paper'),{status:'ready',outline:saved});const cachedCalls=apiCalls;await setPDFOutlineSource('ai');
 assert(apiCalls===cachedCalls&&panel.innerHTML.includes('Introduction'),'switching to a ready AI outline must reuse it without another request');
 assert(panel.innerHTML.indexOf('data-outline-retry')<panel.innerHTML.indexOf('data-outline-delete')&&panel.innerHTML.includes('aria-label="Delete AI-generated outline"'),'Regenerate must precede an accessible icon-only delete control');
 const beforeDelete=apiCalls;await deletePDFOutline();
 assert(deletes===1&&apiCalls===beforeDelete&&!pdfOutlines.get('paper').outline&&pdfOutlines.get('paper').status==='deleted','delete must clear the saved AI cache without immediately generating another outline');
 assert(pdfOutlines.get('paper').documentOutline===nativeResult,'deleting AI must preserve the document outline');
 Object.assign(pdfOutlines.get('paper'),{status:'ready',outline:saved});deleteFailure=true;await deletePDFOutline();deleteFailure=false;
 assert(pdfOutlines.get('paper').outline===saved&&pdfOutlines.get('paper').status==='ready'&&toastElement.textContent==='Could not delete outline','failed deletion must preserve the outline and re-enable its controls');
 hideToast();const count=timers.length;let reject;
 api=async()=>await new Promise((_,r)=>reject=r);
 const pending=loadPDFOutline('paper',PDF.doc,{forceAI:true,regenerate:true});while(!reject)await Promise.resolve();
 assert(notificationProgress.get('pdf-outline:paper')==='Generating outline…'&&!panel.innerHTML.includes('Generating outline'),'outline generation uses shared bottom-right progress');
 const previousDeletes=deletes;await deletePDFOutline();assert(deletes===previousDeletes,'an active generation job must not be deleted by the current view');
 await setPDFOutlineSource('document');assert(panel.innerHTML.includes('Embedded section')&&!panel.innerHTML.includes('Generating outline'),'document navigation must stay available while AI is generating');
 assert(setPDFOutlineSource('ai')===pending,'repeated AI tab clicks must reuse the running job');
 PDF.key='another-paper';reject(Error('Background failure'));await pending;
 assert(timers.length===count&&!notificationProgress.has('pdf-outline:paper'),'background failure clears progress without interrupting another paper with a toast');
 PDF.key='empty-paper';PDF.outlineSource='document';nativeResult=null;const before=apiCalls;await loadPDFOutline(PDF.key,PDF.doc);
 assert(apiCalls===before&&panel.innerHTML.includes('no document outline'),'a PDF without bookmarks must stay empty until the user chooses AI');
 globalThis.result='PASS: document-first source tabs, lazy AI generation, cached and pending job reuse, safe AI deletion, timed error toasts and background isolation';
})().catch(error=>globalThis.result='FAIL: '+error.stack);
"""#)
let deadline=Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined&&Date()<deadline{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=context.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
