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
const svg={innerHTML:'',classList:{contains:()=>true},closest:()=>({dataset:{page:PDF.page},querySelector:()=>null})};const ink={innerHTML:'',classList:{contains:()=>false},closest:()=>({dataset:{page:PDF.page},querySelector:()=>null})};const pdfPageEntries=[];function closePDFLinkPreview(){}
const $=s=>s.includes('pdf-overlay')?svg:{scrollIntoView(){scrolls.push('mark');}};
const document={querySelectorAll:s=>s.includes('.pdf-overlay')?[svg,ink]:cards,addEventListener(){}};
const esc=String;
function updateChatContext(){}
function setPDFSidebarTab(){}
function setMode(mode){if(mode!=='pdf')throw Error('Unexpected mode');}
async function pdfNavigate(page){navigation.push(page);PDF.page=page;paintPDFAnnotations();}
async function refreshPDFAnnotations(){}
async function openPDF(){throw Error('Same-paper annotation should use current reader');}
function assert(value,why){if(!value)throw Error(why);}
"""#
let checks=#"""
(async()=>{
 const words=[[.1,.1,.08,.02],[.185,.1,.06,.02],[.25,.1,.1,.02],[.1,.14,.16,.02],[.55,.1,.1,.02]];
 const originalWords=JSON.stringify(words),joined=mergePDFHighlightRects(words,1.3);
 assert(joined.length===3&&Math.abs(joined[0][2]-.25)<1e-9,'word gaps must connect within a line without crossing rows or column gutters');
 assert(JSON.stringify(words)===originalWords,'display geometry must not rewrite saved word anchors');
 assert(mergePDFHighlightRects([[.1,.1,.1,.02],[.205,.1,.1,.02]],.3).length===2,'page aspect ratio must control the word-gap threshold');
 assert(mergePDFHighlightRects([[.1,.1,.1,.02],[.205,.1,.1,.02]],1.3).length===1,'portrait page word gap did not merge');
 assert(mergePDFHighlightRects([[.1,.1,.1,.02],[.1,.1,.1,.02],[.15,.1,.1,.02]],1).length===1,'duplicate or overlapping word boxes must merge');
 assert(mergePDFHighlightRects([[.1,.1,.1,.02],[.205,.095,.02,.012],[.23,.1,.1,.02]],1.3).length===1,'inline superscripts should connect to their text line');
 PDF.annotations.push({id:'ink',page:1,kind:'ink',color:'#123456',width:.003,points:[[.1,.2],[.2,.3]]});
 paintPDFAnnotations();assert(ink.innerHTML.includes('<polyline')&&!ink.innerHTML.includes('<rect')&&!svg.innerHTML.includes('<polyline'),'ink and highlights must render in separate layers');assert(svg.innerHTML.includes('opacity="0.35"'),'default opacity');
 await selectPDFAnnotation('a');assert(cards[0].selected&&!cards[1].selected,'comment selection not reflected in sidebar');
 assert(svg.innerHTML.includes('opacity="0.35"')&&svg.innerHTML.includes('stroke-width="2"'),'selected highlight must use an outline without obscuring text');
 PDF.annotations.push({...PDF.annotations[0],id:'overlap',rects:[[.1,.2,.2,.03],[.15,.2,.2,.03]]});
 paintPDFAnnotations();assert((svg.innerHTML.match(/opacity=/g)||[]).length===1&&!svg.innerHTML.includes('fill-opacity'),'overlaps must share one opacity group');
 assert(svg.innerHTML.includes('data-annotation="overlap"'),'overlapping annotations must remain independently addressable');
 PDF.dark=true;paintPDFAnnotations();assert(svg.innerHTML.includes('opacity="0.2"'),'dark highlight background must stay subdued');PDF.dark=false;
 await selectPDFAnnotation('b',{scrollComment:true});assert(PDF.page===2&&navigation[0]===2,'comment did not navigate to highlight page');
 assert(cards[1].selected&&!cards[0].selected,'old comment remains selected');assert(scrolls.includes('b'),'linked comment not scrolled into view');
 await pdfAction({action:'pdf_annotations',key:'paper',id:'a',page:1});assert(PDF.page===1&&PDF.selected==='a','agent highlight on another page stayed invisible');
 assert(cards[0].selected,'agent highlight not linked to selected comment');
 pdfOutsideComment({target:{closest:()=>null}});assert(PDF.selected===null&&!cards[0].selected,'outside click did not deselect comment');assert(!svg.innerHTML.includes('stroke-width="2"'),'bold highlight remained after deselection');
 await selectPDFAnnotation('a');pdfOutsideComment({target:{closest:s=>s.includes('article')?cards[0]:null}});assert(PDF.selected==='a','inside comment click cleared selection');
 globalThis.result='PASS: comment selection, outlined highlights, subdued dark backgrounds, non-stacking opacity, continuous line geometry, page navigation and agent annotation visibility';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#
context.evaluateScript(mocks+section("function inkSVG", "async function addPDFAnnotation")+section("async function pdfAction", "function pdfRoute")+checks)
let deadline=Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=context.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
