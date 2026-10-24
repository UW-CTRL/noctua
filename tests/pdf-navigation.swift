import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JS error");exit(1)}
let source=try String(contentsOfFile:"web/pdf.js",encoding:.utf8)
func section(_ start:String,_ end:String)->String {
 let a=source.range(of:start)!.lowerBound,b=source.range(of:end,range:a..<source.endIndex)!.lowerBound
 return String(source[a..<b])
}
let mocks=#"""
function assert(v,m){if(!v)throw Error(m);}
// JavaScriptCore has no browser URL class. This mock only supplies protocol parsing.
class URL{constructor(value){if(!/^[a-z]+:/i.test(value))throw Error('invalid');this.protocol=value.match(/^[^:]+:/)[0].toLowerCase();this.href=value;}}
"""#
let checks=#"""
(async()=>{
 let innerWidth=1200,innerHeight=800;
 const popup={offsetWidth:480,offsetHeight:300,style:{}};
 // Positioning reads the browser viewport globals.
 globalThis.innerWidth=innerWidth;globalThis.innerHeight=innerHeight;
 positionPDFPreview(popup,200,100);assert(popup.style.left==='212px','preview did not prefer right');
 positionPDFPreview(popup,1000,100);assert(popup.style.left==='508px','right-edge preview did not move left');
 positionPDFPreview(popup,600,700);assert(popup.style.left==='612px'&&popup.style.top==='488px','right preference or vertical bounds failed');
 globalThis.innerWidth=600;
 positionPDFPreview(popup,500,100);assert(popup.style.left==='12px','narrow viewport did not clamp left placement');
 const viewport={width:612,height:792,convertToViewportRectangle:r=>r};
 const crop=pdfReferenceCrop(viewport,{x:60/612,y:400/792},[{str:'[7]',transform:[1,0,0,10,60,400],width:15,height:10},{str:'Author and title',transform:[1,0,0,10,80,400],width:420,height:10}]);
 assert(crop.width<500&&Math.abs(crop.x+crop.width/2-280)<1,'reference text not centered in a tighter crop');
 assert(crop.y<400&&crop.y+crop.height>430,'preview does not surround the reference');
 const fallback=pdfReferenceCrop(viewport,{x:.2,y:.95},[]);assert(Number.isFinite(fallback.x)&&fallback.y+fallback.height<=792,'empty/edge crop invalid');
 const metrics=Array.from({length:100},(_,i)=>({number:i+1,top:i*1024,bottom:i*1024+1000,pixels:3000000}));
 const first=pdfRenderWindow(metrics,0,900);assert(first.includes(1)&&first.length<=5&&!first.includes(50),'whole document rasterized');
 const middle=pdfRenderWindow(metrics,50*1024,50*1024+900);assert(middle.includes(51)&&!middle.includes(1),'old pages retained after distant scroll');
 const seam=pdfRenderWindow([{number:1,top:-5000,bottom:300,pixels:32*1024*1024},{number:2,top:324,bottom:6000,pixels:32*1024*1024},{number:3,top:6024,bottom:12000,pixels:32*1024*1024}],0,900);assert(seam.length===2&&seam.includes(1)&&seam.includes(2),'visible seam pages not both rendered');
 assert(safePDFLinkURL('https://example.org/paper')==='https://example.org/paper','safe external link rejected');
 for(const bad of ['javascript:alert(1)','data:text/html,x','file:///tmp/paper','relative'])assert(safePDFLinkURL(bad)===null,'unsafe link allowed');
 const doc={numPages:4,getDestination:async name=>name==='cite.2'?[{num:42},{name:'XYZ'},100,600,null]:null,getPageIndex:async ref=>ref.num===42?2:0,getPage:async()=>({view:[0,0,600,800],getViewport:()=>({width:600,height:800,convertToViewportPoint:(x,y)=>[x,800-y]})})};
 const target=await resolvePDFDestination(doc,{dest:'cite.2'});assert(target.page===3&&target.y===.25,'citation destination page/position wrong');
 const firstPage=await resolvePDFDestination(doc,{dest:[0,{name:'Fit'}]});assert(firstPage.page===1&&firstPage.y===0,'page-only destination failed');
 try{await resolvePDFDestination(doc,{dest:'missing'});throw Error('expected failure');}catch(e){assert(e.message.includes('usable destination'),'broken destination silently accepted');}
 const text='Before references [2]\nReferences\n[1]\nFirst reference\n[2]\nSecond reference\n[3]\nThird reference';
 const offset=text.indexOf('Second');
 const index={pages:[{page:1,text,words:[{start:offset,end:offset+6,rect:[.1,.7,.2,.02]}]}]};
 const ref=findNumberedPDFReference(index,2);assert(ref&&ref.y===.7&&ref.excerpt.includes('Second reference')&&!ref.excerpt.includes('Third reference'),'bibliography preview matched wrong entry');
 assert(findNumberedPDFReference({pages:[{page:1,text:'[2]\nAn inline citation',words:[]}]},2)===null,'unlinked inline citation invented a reference');
 globalThis.result='PASS: bounded page rendering, scroll eviction, link safety, named destinations and bibliography previews';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#
c.evaluateScript(mocks+section("function pdfRenderWindow", "function disposePDFPage")+section("function safePDFLinkURL", "async function pdfPageLinks")+section("async function resolvePDFDestination", "let pdfLinkTimer")+section("function findNumberedPDFReference", "async function previewNumberedCitation")+section("function positionPDFPreview", "function pdfReferenceCrop")+section("function pdfReferenceCrop", "async function showPDFLinkPreview")+checks)
let deadline=Date().addingTimeInterval(5)
while c.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=c.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
