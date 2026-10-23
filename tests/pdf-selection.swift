// macOS: swift tests/pdf-selection.swift
import Foundation
import JavaScriptCore
let context=JSContext()!
context.exceptionHandler={_,error in print(error?.toString() ?? "JS error");exit(1)}
let source=try String(contentsOfFile:"web/pdf.js",encoding:.utf8)
func section(_ start:String,_ end:String)->String {
 let a=source.range(of:start)!.lowerBound
 let b=source.range(of:end,range:a..<source.endIndex)!.lowerBound
 return String(source[a..<b])
}
let mocks=#"""
const PDF={key:'paper',page:1,selected:null,annotations:[{id:'a',page:1,kind:'highlight',status:'accepted',color:'#ffd400',rects:[[.1,.2,.2,.03]]},{id:'b',page:2,kind:'highlight',status:'pending',color:'#5fb236',rects:[[.2,.3,.1,.03]]}]};
const scrolls=[],navigation=[];
const cards=PDF.annotations.map(a=>({dataset:{id:a.id},selected:false,classList:{toggle(k,v){cards.find(c=>c.dataset.id===a.id).selected=v;}},setAttribute(){},scrollIntoView(){scrolls.push(a.id);}}));
const svg={innerHTML:'',closest:()=>({dataset:{page:PDF.page}})};const pdfPageEntries=[];function closePDFLinkPreview(){}
const $=s=>s.includes('pdf-overlay')?svg:{scrollIntoView(){scrolls.push('mark');}};
const document={querySelectorAll:s=>s.includes('.pdf-overlay')?[svg]:cards,addEventListener(){}};
const esc=String;
function updateChatContext(){}
function setMode(mode){if(mode!=='pdf')throw Error('Unexpected mode');}
async function pdfNavigate(page){navigation.push(page);PDF.page=page;paintPDFAnnotations();}
async function refreshPDFAnnotations(){}
async function openPDF(){throw Error('Same-paper annotation should use current reader');}
function assert(value,why){if(!value)throw Error(why);}
"""#
let checks=#"""
(async()=>{
 paintPDFAnnotations();assert(svg.innerHTML.includes('fill-opacity="0.35"'),'default opacity');
 await selectPDFAnnotation('a');assert(cards[0].selected&&!cards[1].selected,'comment selection not reflected in sidebar');
 assert(svg.innerHTML.includes('fill-opacity="0.6"')&&svg.innerHTML.includes('stroke-width="2"'),'selected highlight must be bold');
 await selectPDFAnnotation('b',{scrollComment:true});assert(PDF.page===2&&navigation[0]===2,'comment did not navigate to highlight page');
 assert(cards[1].selected&&!cards[0].selected,'old comment remains selected');assert(scrolls.includes('b'),'linked comment not scrolled into view');
 await pdfAction({action:'pdf_annotations',key:'paper',id:'a',page:1});assert(PDF.page===1&&PDF.selected==='a','agent highlight on another page stayed invisible');
 assert(cards[0].selected,'agent highlight not linked to selected comment');
 pdfOutsideComment({target:{closest:()=>null}});assert(PDF.selected===null&&!cards[0].selected,'outside click did not deselect comment');assert(!svg.innerHTML.includes('stroke-width="2"'),'bold highlight remained after deselection');
 await selectPDFAnnotation('a');pdfOutsideComment({target:{closest:s=>s.includes('article')?cards[0]:null}});assert(PDF.selected==='a','inside comment click cleared selection');
 globalThis.result='PASS: comment selection, bold highlights, page navigation and agent annotation visibility';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#
context.evaluateScript(mocks+section("function inkSVG", "async function addPDFAnnotation")+section("async function pdfAction", "function pdfRoute")+checks)
let deadline=Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=context.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
