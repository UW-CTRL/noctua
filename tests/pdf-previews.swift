// macOS: swift tests/pdf-previews.swift
import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JavaScript error");exit(1)}
c.evaluateScript("const window=globalThis;")
c.evaluateScript(try String(contentsOfFile:"web/pdf-objects.js",encoding:.utf8))
let source=try String(contentsOfFile:"web/pdf.js",encoding:.utf8)
func section(_ start:String,_ end:String)->String {
 let a=source.range(of:start)!.lowerBound,b=source.range(of:end,range:a..<source.endIndex)!.lowerBound
 return String(source[a..<b])
}
c.evaluateScript(section("function pdfPreviewSizeKey(","function pdfReferenceCrop(")+section("function pdfReferenceCrop(","async function showPDFLinkPreview(")+#"""
function assert(v,m){if(!v)throw Error(m);}
const viewport={width:600,height:800,convertToViewportPoint:(x,y)=>[x,y]};
const text=(str,x,y,width,height=10)=>({str,transform:[height,0,0,height,x,y],width,height});
const prose='A complete line of body text describing the method and its results.';
const single=Array.from({length:20},(_,i)=>text(prose,100,100+i*14,400));
const double=Array.from({length:20},(_,i)=>[text(prose,45,100+i*14,235),text(prose,320,100+i*14,235)]).flat();
const a=pdfReferenceCrop(viewport,{x:.17,y:.25},single,[],'section.1');
const b=pdfReferenceCrop(viewport,{x:.08,y:.25},double,[],'section.1');
const right=pdfReferenceCrop(viewport,{x:.55,y:.25},double,[],'section.2');
assert(a.columns===1&&b.columns===2&&b.width<a.width*.75,'one-column and two-column passages must use their own text widths');
assert(b.x+b.width<=300&&right.x>=300,'text previews must not include the neighboring column');
const figure={kind:'figure',label:'Figure 1',rect:[.06,.08,.88,.5]};
const full=pdfReferenceCrop(viewport,{x:.08,y:.1},double,[figure],'figure.1');
assert(full.object&&Math.abs(full.x-36)<.01&&Math.abs(full.width-528)<.01&&Math.abs(full.height-400)<.01,'full-width figures must reuse the entire annotation box, without column clipping');
const table={kind:'table',rect:[.53,.3,.4,.3]},tableCrop=pdfReferenceCrop(viewport,{x:.54,y:.3},double,[table],'table.1');
assert(tableCrop.object&&Math.abs(tableCrop.x-318)<.01&&Math.abs(tableCrop.height-240)<.01,'tables must reuse the detected box including all rows');
const algorithm={kind:'algorithm',rect:[.12,.1,.76,.65]},tall=pdfReferenceCrop(viewport,{x:.12,y:.1},single,[algorithm],'algorithm.1');
assert(tall.height>500&&tall.object,'tall algorithms must not be cut to a fixed preview height');
const nearby=pdfReferenceCrop(viewport,{x:.54,y:.635},double,[table]);
assert(!nearby.object,'a passage below a table must not be replaced with that table');
const equations=[...single.filter(t=>t.transform[5]<150||t.transform[5]>250),text('x = y + z',130,190,180),text('(1)',480,190,20),text('y = z + 1',130,207,180)];
const eq=pdfReferenceCrop(viewport,{x:.8,y:190/800},equations,[],'equation.1');
assert(eq.y<=190&&eq.y+eq.height>=217&&eq.height<130,'equation groups must stay complete without a large fixed slice of unrelated prose');
const oneSize=pdfReferencePreviewSize(a,1200,900),twoSize=pdfReferencePreviewSize(b,1200,900);
assert(oneSize.width>twoSize.width,'popup width must adapt to the destination column width');
for(const crop of [a,b,full,tall])for(const [w,h] of [[1200,900],[380,320],[220,180]]){
 const size=pdfReferencePreviewSize(crop,w,h);
 assert(size.width<=w-24&&size.height<=h-24&&size.width>0&&size.height>0,'automatic preview sizes must fit narrow and short windows');
}
const citation=pdfPreviewSizeKey({dataset:{}}),pageKey=pdfPreviewSizeKey({dataset:{previewKind:'passage',previewLayout:'page.section'}}),columnKey=pdfPreviewSizeKey({dataset:{previewKind:'passage',previewLayout:'column.section'}});
assert(new Set([citation,pageKey,columnKey]).size===3,'citation, single-column, and double-column manual sizes must be independent');
const preferences=new Map(),store={get:key=>preferences.get(key),set:(key,value)=>preferences.set(key,value)},localStorage={removeItem:key=>preferences.delete(key)};
globalThis.innerWidth=1200;globalThis.innerHeight=900;
const document={createElement(){return {setAttribute(){}};}};
const classes=new Set(),popup={dataset:{},style:{},isConnected:true,classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},append(node){this.grip=node;},getBoundingClientRect(){return {left:12,top:12,width:parseFloat(this.style.width)||420,height:parseFloat(this.style.height)||280};},get offsetWidth(){return this.getBoundingClientRect().width;},get offsetHeight(){return this.getBoundingClientRect().height;}};
let redraws=0;popup.noctuaRenderPreview=()=>redraws++;
sizePDFReferencePreview(popup,a);bindPDFPreviewResize(popup);
const automatic=popup.getBoundingClientRect(),key=pdfPreviewSizeKey(popup);
popup.grip.onkeydown({key:'ArrowRight',preventDefault(){}});
assert(popup.dataset.previewManual==='true'&&JSON.parse(preferences.get(key)).width>automatic.width&&redraws===1,'manual resizing must save its layout preference and request a sharp re-render');
popup.grip.onkeydown({key:'Home',preventDefault(){}});
assert(!preferences.has(key)&&popup.dataset.previewManual==='false'&&popup.getBoundingClientRect().width===automatic.width&&redraws===2,'Home must restore automatic sizing and re-render');
preferences.set(key,'{"width":0}');sizePDFReferencePreview(popup,a);
assert(popup.dataset.previewManual==='false'&&popup.getBoundingClientRect().width===automatic.width,'invalid saved dimensions must fall back to automatic sizing');
const rotated=text('Rotated margin text',10,500,300);rotated.transform=[0,-10,10,0,10,500];
const rect=NoctuaPDFObjects.textRects([rotated],viewport)[0].rect;
assert(rect[2]<.03&&rect[3]>.3,'rotated margin text must retain its actual orientation rather than widening the content bounds');
"""#)
print("PASS: shared object boxes, complete tall objects and equations, column-aware crops, adaptive popup sizes, viewport bounds, independent size preferences and rotated margin text")
