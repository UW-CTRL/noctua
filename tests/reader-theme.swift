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
const elements=new Map(['#pdf-stage','#pdf-sidebar','#setup-reader-theme','#notes-stage','#setup-notes-theme','#setup-app-theme'].map(k=>[k,{dataset:{},value:''}]));
const $=s=>elements.get(s);
const document={documentElement:{dataset:{}}};
function readColors(){}function draw(){}
const values=new Map(),store={set:(k,v)=>values.set(k,v)};
let redraws=0,anchor={page:3,x:.4,y:.5};
function pdfZoomAnchor(){return anchor;}
function renderPDF(a){if(a!==anchor)throw Error('Reading position lost');redraws++;}
function assert(v,m){if(!v)throw Error(m);}
"""#
let notes=try String(contentsOfFile:"web/notes.js",encoding:.utf8)
let app=try String(contentsOfFile:"web/app.js",encoding:.utf8)
func section(_ source:String,_ start:String,_ end:String)->String {
 let a=source.range(of:start)!.lowerBound,b=source.range(of:end,range:a..<source.endIndex)!.lowerBound
 return String(source[a..<b])
}
let checks=#"""
setAppTheme();setNotesTheme();
assert(document.documentElement.dataset.theme==='system'&&$('#notes-stage').dataset.notesTheme==='system','app and notes must default to system on first launch');
for(const theme of ['dark','light','system']){
 setAppTheme(theme);setNotesTheme(theme);setReaderTheme(theme);
 assert(values.get('noctua.theme')===theme&&values.get('noctua.notesTheme')===theme&&values.get('noctua.readerTheme')===theme,'explicit saved themes must be preserved');
}
setNotesTheme('invalid');assert($('#notes-stage').dataset.notesTheme==='system','invalid notes preference must follow the system');
setReaderTheme();assert(PDF.theme==='system'&&!PDF.dark&&values.get('noctua.readerTheme')==='system','reader must default to system on first launch');
setReaderTheme('light');assert(!PDF.dark&&values.get('noctua.readerTheme')==='light','reader theme must change pages');
assert(!$('#pdf-stage').dataset.readerTheme&&!$('#pdf-sidebar').dataset.readerTheme,'reader theme must not override app palettes');
assert($('#setup-reader-theme').value==='light','settings sync');
PDF.key='fixture';setPDFPageTheme('dark');assert(PDF.dark&&redraws===1,'dark page redraw');
assert(PDF.theme==='dark'&&values.get('noctua.readerTheme')==='dark','toolbar and settings must share preference');
setPDFPageTheme('dark');assert(redraws===1,'unnecessary redraw');
setReaderTheme('system');assert(!PDF.dark&&redraws===2,'system light pages');
pdfSystemTheme.matches=true;applyReaderTheme();assert(PDF.dark&&redraws===3,'system dark pages');
assert(!$('#pdf-stage').dataset.readerTheme&&!$('#pdf-sidebar').dataset.readerTheme,'system theme changed app palettes');
setReaderTheme('invalid');assert(PDF.theme==='system'&&PDF.dark&&redraws===3,'invalid preference must follow the system');
"""#
c.evaluateScript(mocks+String(source[a..<b])+section(notes,"function setNotesTheme(","setNotesTheme(store.get")+section(app,"function setAppTheme(","document.addEventListener('noctua-font-change'")+checks)
print("PASS: page-only reader theme, shared saved preference, app palette isolation, system changes and reading position")
