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
const PDF={doc:{},key:'paper',page:1,scale:1.25};
const window={devicePixelRatio:3,visualViewport:{scale:1}};window.parent=window;
let draws=[],timers=new Map(),seq=0;
function setTimeout(fn){timers.set(++seq,fn);return seq;}
function clearTimeout(id){timers.delete(id);}
function flush(){const work=[...timers.values()];timers.clear();work.forEach(fn=>fn());}
function pdfZoomAnchor(){return {anchor:true};}
async function renderPDF(anchor){draws.push({scale:PDF.scale,anchor});}
function toast(e){throw Error(e);}
function assert(v,m){if(!v)throw Error(m);}
"""#
let checks=#"""
(async()=>{
 const normal=pdfRasterSize(612,792,3);assert(normal.width===1836&&normal.height===2376,'3x screen incorrectly capped at 2x');
 const zoomed=pdfRasterSize(1224,1584,3);assert(zoomed.width===normal.width*2,'zoom did not increase raster resolution');
 const standard=pdfRasterSize(612,792,1),scaled=pdfRasterSize(612,792,1.25);assert(standard.width===1224&&scaled.width===1224,'standard and fractional screens are not supersampled to 2x');
 const huge=pdfRasterSize(20000,20000,3);assert(huge.width*huge.height<=32*1024*1024&&huge.width<=16384,'canvas memory bound missing');
 window.visualViewport.scale=2;assert(pdfPixelDensity()===6,'browser magnification ignored');
 let prevented=false;const wheel={ctrlKey:true,deltaY:-50,deltaMode:0,clientX:100,clientY:200,preventDefault(){prevented=true;}};
 pdfWheelZoom(wheel);pdfWheelZoom(wheel);assert(prevented&&timers.size===1,'pinch not intercepted or redraw not debounced');flush();await Promise.resolve();
 assert(draws.length===1&&draws[0].scale>1.25&&draws[0].anchor.anchor,'pinch did not rerender the PDF around its anchor');
 prevented=false;pdfWheelZoom({...wheel,ctrlKey:false});assert(!prevented&&timers.size===0,'ordinary scrolling intercepted');
 schedulePDFZoom(4,100,200);PDF.page=2;flush();assert(draws.length===1,'queued zoom applied to a different page');
 await zoomPDF(99);assert(PDF.scale===6,'upper zoom limit missing');await zoomPDF(.01);assert(PDF.scale===.4,'lower zoom limit missing');
 globalThis.result='PASS: Retina rendering, zoom resolution, bitmap bounds, pinch redraw, anchoring and ordinary scrolling';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#
c.evaluateScript(mocks+section("function pdfRasterSize", "let pdfZoomTimer")+section("let pdfZoomTimer", "function pdfZoomAnchor")+section("async function zoomPDF", "const pdfZoomStage")+checks)
let deadline=Date().addingTimeInterval(5)
while c.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=c.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
