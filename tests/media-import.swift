// Exercise the real picker, paste and drop handlers with a minimal DOM and upload server.
import Foundation
import JavaScriptCore
let js = JSContext()!
var failed = false
js.exceptionHandler = { _, e in print(e?.toString() ?? "JS error"); failed = true }
js.evaluateScript(#"""
const handlers = {};
const console = {error(){}};
function element() { return {dataset:{}, classList:{add(){},remove(){}}, addEventListener(name, fn){handlers[name]=fn},querySelectorAll(){return []},querySelector(){return null},closest(){return null},scrollIntoView(){},appendChild(){},contains(){return true},click(){}}; }
const stage = element(), body = element();
const document = {body, createElement:element, querySelector:()=>null,querySelectorAll:()=>[],addEventListener(name,fn){handlers['document:'+name]=fn}};
const window = {addEventListener(){}};
const $ = ()=>stage, enc = encodeURIComponent;
let messages=[], uploads=[], rendered=0, dirty=0, counter=0;
const N={target:'L1',doc:{id:'note',blocks:[]},editing:null,imgSel:null};
function toast(s){messages.push(s)}
function stopEdit(){}
function markDirty(){dirty++}
function typeset(){}
function renderEditor(){rendered++}
function newId(){return 'b'+(++counter)}
function blockIndex(id){return N.doc.blocks.findIndex(b=>b.id===id)}
function isNotesMode(){return true}
async function fetch(url,opts){uploads.push({url,body:opts.body}); return {ok:true,json:async()=>({path:'media/'+opts.body.name,kind:opts.body.type.startsWith('video/')?'video':'image'})};}
function assert(ok,why){if(!ok)throw Error(why)}
"""#)
js.evaluateScript(try String(contentsOfFile:"web/figures.js",encoding:.utf8))
js.evaluateScript(#"""
let done=false;
async function settle(){for(let i=0;i<12;i++)await Promise.resolve()}
(async()=>{
 const photo={name:'test.png',type:'image/png'};
 pickImages({index:0}); imgInput.files=[photo]; imgInput.onchange(); await settle();
 assert(N.doc.blocks.length===1 && N.doc.blocks[0].src.includes('\\includegraphics'), 'picker must insert image: '+messages.join(';'));
 handlers.drop({dataTransfer:{types:['Files'],files:[photo]},target:stage,preventDefault(){}}); await settle();
 assert(N.doc.blocks.length===2, 'drop must insert image');
 handlers['document:paste']({target:body,clipboardData:{files:[{name:'movie.mp4',type:'video/mp4'}]},preventDefault(){}}); await settle();
 assert(N.doc.blocks.some(b=>b.src.includes('\\includevideo')), 'paste must insert video');
 assert(uploads.every(u=>u.url==='/api/note-media/L1'), 'shared media endpoint');
 assert(dirty===3 && rendered===2, 'imports save and render');
 const oldFetch = fetch;
 fetch = async()=>({ok:false,status:415,json:async()=>({error:'Unsupported image format'})});
 await addImages([photo]);
 assert(messages.includes('Unsupported image format'), 'upload failures must be reported');
 fetch = oldFetch;
 renderEditor = ()=>{throw Error('render failed')};
 await addImages([photo], {forceNew:true});
 assert(messages.some(m=>m.includes('render failed')), 'insertion failures must be reported');
 done=true;
})().catch(e=>{globalThis.failure=String(e);done=true});
"""#)
for _ in 0..<30 { if js.evaluateScript("done")?.toBool() == true {break}; RunLoop.current.run(until:Date().addingTimeInterval(0.01)) }
if let error=js.evaluateScript("globalThis.failure")?.toString(), error != "undefined" { print(error); failed=true }
if js.evaluateScript("done")?.toBool() != true { print("Async test did not finish"); failed=true }
if failed {exit(1)}
print("PASS: image picker, drop, video paste, upload endpoint, persistence and rendering")
