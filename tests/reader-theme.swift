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
setReaderTheme('light');assert(!PDF.dark&&values.get('noctua.readerTheme')==='light','reader theme must change pages');
assert(!$('#pdf-stage').dataset.readerTheme&&!$('#pdf-sidebar').dataset.readerTheme,'reader theme must not override app palettes');
assert($('#setup-reader-theme').value==='light','settings sync');
PDF.key='fixture';setPDFPageTheme('dark');assert(PDF.dark&&redraws===1,'dark page redraw');
assert(PDF.theme==='dark'&&values.get('noctua.readerTheme')==='dark','toolbar and settings must share preference');
setPDFPageTheme('dark');assert(redraws===1,'unnecessary redraw');
setReaderTheme('system');assert(!PDF.dark&&redraws===2,'system light pages');
pdfSystemTheme.matches=true;applyReaderTheme();assert(PDF.dark&&redraws===3,'system dark pages');
assert(!$('#pdf-stage').dataset.readerTheme&&!$('#pdf-sidebar').dataset.readerTheme,'system theme changed app palettes');
setReaderTheme('invalid');assert(PDF.theme==='dark'&&redraws===3,'invalid preference fallback');
"""#
c.evaluateScript(mocks+String(source[a..<b])+checks)
print("PASS: page-only reader theme, shared saved preference, app palette isolation, system changes and reading position")
