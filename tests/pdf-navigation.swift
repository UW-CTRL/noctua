import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JS error");exit(1)}
c.evaluateScript("const window=globalThis;")
c.evaluateScript(try String(contentsOfFile:"web/pdf-objects.js",encoding:.utf8))
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
 assert(JSON.stringify(pdfCitationNumbers('[5, 2, 4, 2]'))==='[2,4,5]','group citations must sort and deduplicate');
 assert(JSON.stringify(pdfCitationNumbers('[2, 4–5]'))==='[2,4,5]','citation ranges must expand');
 assert(pdfCitationNumbers('[5-2]').length===0&&pdfCitationNumbers('[1-9000]').length===0,'invalid citation ranges must be rejected');
 assert(pdfReferenceTitle('D. Ha and J. Schmidhuber. World models. arXiv preprint, 2018.')==='World models','initials must not be mistaken for the author/title separator');
 assert(pdfReferenceTitle('Danijar Hafner and Wilson Yan. Training agents inside of scalable world models, 2025. URL https://example.org')==='Training agents inside of scalable world models','publication year must not appear in the title');
 assert(pdfReferenceTitle('S. Author, “A general safety framework for learning-based control in uncertain robotic systems,” Journal, 2020.')==='A general safety framework for learning-based control in uncertain robotic systems','quoted citation titles must omit the bibliography comma');
 assert(pdfReferenceTitle('S. Author. Safety, learning, and control,. Journal, 2020.')==='Safety, learning, and control','unquoted citation titles must omit only the trailing comma');
 const crop=pdfReferenceCrop({width:612,height:792,convertToViewportPoint:(x,y)=>[x,y]},{x:60/612,y:400/792},[{str:'Target',transform:[1,0,0,10,60,400],width:350,height:10}]);
 assert(crop.x<=60&&crop.x+crop.width>=410&&crop.y<=400&&crop.y+crop.height>=410,'internal reference crop must include the destination text');
 const grouped={pages:[{page:1,text:'Prior work [2, 4–5].',words:[{start:12,end:13,rect:[.1,.2,.03,.02]}]}]};
 assert(JSON.stringify(pdfLinkCitationNumbers(grouped,{sourcePage:1,rect:[.1,.2,.03,.02]}))==='[2,4,5]','hovering one linked number must resolve the complete bracket group');
 assert(pdfIsNamedCitation('cite.JMLR:v16:garcia15a')&&pdfIsNamedCitation('citation.author2020'),'author-year citation keys must be recognized');
 assert(!pdfIsNamedCitation('section.5')&&!pdfIsNamedCitation('equation.3.2')&&!pdfIsNamedCitation(null),'ordinary internal references must keep page previews');
 const firstTitle='A. Author. First paper title. Journal, 2020.',secondTitle='B. Author. Second paper title. Journal, 2021.';
 const bibliography={pages:[{page:2,text:firstTitle+'\n'+secondTitle,words:[{start:0,end:2,rect:[.1,.2,.1,.02]},{start:firstTitle.length+1,end:firstTitle.length+3,rect:[.1,.5,.1,.02]}]}]};
 let destinationsRead=0;
 const namedDoc={...doc,getDestinations:async()=>{destinationsRead++;return {'cite.namespace:author20':[1,{name:'XYZ'},60,640,null],'cite.author21':[1,{name:'XYZ'},60,400,null]};}};
 const namedRef=await pdfNamedCitationReference(bibliography,namedDoc,'cite.namespace:author20');
 assert(namedRef?.title==='First paper title'&&!namedRef.excerpt.includes('Second paper title'),'named citations must extract only their own bibliography entry');
 const secondRef=await pdfNamedCitationReference(bibliography,namedDoc,'cite.author21');
 assert(secondRef?.title==='Second paper title'&&destinationsRead===1,'bibliography destination lookup must be cached');
 assert(await pdfNamedCitationReference({pages:[]},namedDoc,'cite.namespace:author20')===null,'missing bibliography text must not invent a title');
 const sourceFixture=text=>{
  const words=[...text.matchAll(/\S+/g)].map((match,i)=>({start:match.index,end:match.index+match[0].length,rect:[.05+(i%8)*.1,.1+Math.floor(i/8)*.025,.085,.02]}));
  const links=words.flatMap(word=>{
    const token=text.slice(word.start,word.end),name=/Alpha|2020/.test(token)?'cite.alpha':/Beta|2021/.test(token)?'cite.beta':/Gamma|2022/.test(token)?'cite.gamma':/Delta|2023/.test(token)?'cite.delta':null;
    return name?[{dest:name,sourcePage:1,rect:word.rect}]:[];
  });
  return {index:{pages:[{page:1,text,words}]},links};
 };
 const group=sourceFixture('Prior work (Alpha et al., 2020; Beta et al.,\n2021) and other work (Gamma, 2022; Delta, 2023).');
 for(const link of group.links.filter(link=>link.dest==='cite.alpha'||link.dest==='cite.beta'))assert(JSON.stringify(pdfLinkCitationNames(group.index,link,group.links))==='["cite.alpha","cite.beta"]','hovering an author or year in a wrapped group must show all citations once, without adjoining groups');
 const nested=sourceFixture('Prior work (e.g., Alpha (2020); Beta (2021)).');
 assert(JSON.stringify(pdfLinkCitationNames(nested.index,nested.links[1],nested.links))==='["cite.alpha","cite.beta"]','nested year parentheses must retain the enclosing citation group');
 const separate=sourceFixture('Alpha (2020); Beta (2021).');
 assert(JSON.stringify(pdfLinkCitationNames(separate.index,separate.links[1],separate.links))==='["cite.alpha"]','separate citation parentheses must stay separate');
 const abbreviated=sourceFixture('(Alpha, 2020; 2021)');
 assert(JSON.stringify(pdfLinkCitationNames(abbreviated.index,abbreviated.links[1],abbreviated.links))==='["cite.alpha","cite.beta"]','repeated-author year links must be included in the group');
 const adjacent=sourceFixture('(Alpha, 2020; Beta, 2021)'),edge=adjacent.links[0].rect;
 const spill={dest:'cite.gamma',sourcePage:1,rect:[edge[0],edge[1]-.019,edge[2],edge[3]]};
 assert(JSON.stringify(pdfLinkCitationNames(adjacent.index,adjacent.links[0],[...adjacent.links,spill]))==='["cite.alpha","cite.beta"]','small annotation overlaps from the adjacent line must not join the group');
 globalThis.result='PASS: bounded page rendering, scroll eviction, link safety, named destinations, grouped citation ranges and bibliography titles';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#
c.evaluateScript(mocks+section("function pdfRenderWindow", "function disposePDFPage")+section("function pdfPointInRect", "async function pdfPageLinks")+section("async function resolvePDFDestination", "let pdfLinkTimer")+section("function findNumberedPDFReference", "function inkSVG")+section("function positionPDFPreview", "async function showPDFLinkPreview")+checks)
let deadline=Date().addingTimeInterval(5)
while c.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=c.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
