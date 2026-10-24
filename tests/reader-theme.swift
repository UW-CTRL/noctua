import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JS error");exit(1)}
let source=try String(contentsOfFile:"web/pdf.js",encoding:.utf8)
let a=source.range(of:"function applyReaderTheme()")!.lowerBound
let b=source.range(of:"let pdfEngine;")!.lowerBound
let mocks=#"""
const PDF={dark:true,key:null};
const pdfSystemTheme={matches:false};
const elements=new Map(['#pdf-stage','#pdf-sidebar','#setup-reader-theme'].map(k=>[k,{dataset:{},value:''}]));
const $=s=>elements.get(s);
const values=new Map(),store={set:(k,v)=>values.set(k,v)};
let redraws=0,anchor={page:3,x:.4,y:.5};
function pdfZoomAnchor(){return anchor;}
function renderPDF(a){if(a!==anchor)throw Error('Reading position lost');redraws++;}
function assert(v,m){if(!v)throw Error(m);}
"""#
let checks=#"""
setReaderTheme();assert(PDF.theme==='dark'&&PDF.dark,'default theme');
setReaderTheme('light');assert(PDF.dark&&values.get('noctua.readerTheme')==='light','chrome theme changed pages');
assert($('#pdf-stage').dataset.readerTheme==='light'&&$('#pdf-sidebar').dataset.readerTheme==='light','reader chrome theme');
assert($('#setup-reader-theme').value==='light','settings sync');
PDF.key='fixture';setPDFPageTheme('light');assert(!PDF.dark&&redraws===1,'light page redraw');
assert(PDF.theme==='light','page toggle changed reader theme');
assert(values.get('noctua.pdfPageTheme')==='light','page preference not saved');
setPDFPageTheme('light');assert(redraws===1,'unnecessary redraw');
setReaderTheme('dark');assert(!PDF.dark&&redraws===1,'reader theme changed pages');
setReaderTheme('system');assert($('#pdf-stage').dataset.readerTheme==='light','system light mode');
pdfSystemTheme.matches=true;applyReaderTheme();assert($('#pdf-stage').dataset.readerTheme==='dark'&&!PDF.dark,'system changes changed pages');
setPDFPageTheme('dark');assert(PDF.dark&&redraws===2,'dark page redraw');
setReaderTheme('invalid');assert(PDF.theme==='dark','invalid preference fallback');
"""#
c.evaluateScript(mocks+String(source[a..<b])+checks)
print("PASS: reader theme defaults, saved preferences, chrome, settings sync, system changes and reading position")
