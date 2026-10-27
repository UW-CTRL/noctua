import Foundation
import JavaScriptCore
let context=JSContext()!
context.exceptionHandler={_,error in print(error?.toString() ?? "JavaScript error");exit(1)}
let source=try String(contentsOfFile:"web/pdf.js",encoding:.utf8)
let start=source.range(of:"function projectZoteroAnnotation(")!.lowerBound
let end=source.range(of:"async function refreshPDFAnnotations",range:start..<source.endIndex)!.lowerBound
context.evaluateScript(String(source[start..<end]))
context.evaluateScript(#"""
function assert(value,message){if(!value)throw Error(message);}
const near=(a,b)=>Math.abs(a-b)<1e-9;
// Crop origin (50,100), unrotated 600x800 page.
const viewport={width:600,height:800,convertToViewportPoint:(x,y)=>[x-50,900-y]};
const raw={kind:'highlight',page:1,zotero_position:{pageIndex:0,rects:[[110,740,230,780]]}};
const a=projectZoteroAnnotation(raw,viewport);
assert(near(a.rects[0][0],.1)&&near(a.rects[0][1],.15)&&near(a.rects[0][2],.2)&&near(a.rects[0][3],.05),'crop box or PDF Y axis incorrect');
assert(raw.rects===undefined,'projection mutated persisted source');
const rotated={width:800,height:600,convertToViewportPoint:(x,y)=>[y-100,x-50]};
const b=projectZoteroAnnotation(raw,rotated);
assert(near(b.rects[0][0],.8)&&near(b.rects[0][1],.1)&&near(b.rects[0][2],.05)&&near(b.rects[0][3],.2),'rotated page projection incorrect');
const drawing=projectZoteroAnnotation({kind:'ink',zotero_position:{width:3,paths:[[50,900,650,100],[110,740,230,780]]}},viewport);
assert(drawing.paths.length===2&&drawing.paths[0][0][0]===0&&drawing.paths[0][1][1]===1,'multi-stroke drawing joined or inverted');
assert(near(drawing.width,.005),'pen width not normalized');
const comment={kind:'comment',comment:'Local edit'};assert(projectZoteroAnnotation(comment,viewport)===comment,'native annotation changed');
const edge=projectZoteroAnnotation({zotero_position:{rects:[[0,0,9999,9999]]}},viewport);
assert(edge.rects[0].join(',')==='0,0,1,1','out-of-crop coordinates were not clamped');
"""#)
print("PASS: Zotero annotation crop/rotation coordinates, multi-stroke ink and native annotations")
