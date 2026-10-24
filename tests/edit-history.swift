import Foundation
import JavaScriptCore
let js=JSContext()!
var failed=false
js.exceptionHandler={_,e in print(e?.toString() ?? "JavaScript error");failed=true}
js.evaluateScript(#"""
const handlers={};
const document={querySelectorAll:()=>[],addEventListener:(name,fn)=>handlers[name]=fn};
const N={target:'L1',doc:{id:'n1',title:'Note',blocks:[{id:'b1',type:'text',src:''}]}};
const enc=encodeURIComponent;
async function api(){return {undo:null,redo:null}}
function assert(ok,msg){if(!ok)throw Error(msg)}
"""#)
js.evaluateScript(try String(contentsOfFile:"web/edit-history.js",encoding:.utf8))
js.evaluateScript(#"""
resetNoteHistory();
NoteUndo.input={block:'b1',field:'nb-src',start:0,end:0};
N.doc.blocks[0].src='a';recordNoteChange();N.doc.blocks[0].src='ab';recordNoteChange();
assert(NoteUndo.frames.length===1,'continuous typing coalesces');
NoteUndo.group=null;N.doc.blocks[0].src='ab pasted';recordNoteChange();
assert(NoteUndo.frames.length===2,'paste forms a separate transaction');
NoteUndo.input=null;N.doc.blocks=[];recordNoteChange();
assert(NoteUndo.frames.length===3,'block deletion is independently undoable');
assert(NoteUndo.frames[1].doc.blocks.length===1,'earlier snapshots remain immutable');
N.doc.updated=123;recordNoteChange();assert(NoteUndo.frames.length===3,'save revisions do not create edits');
NoteUndo.busy=true;N.doc.title='restore';recordNoteChange();assert(NoteUndo.frames.length===3,'restoring does not create an undo entry');
NoteUndo.busy=false;
let dispatched=[];
undoNote=redo=>dispatched.push(['note',redo]);undoReader=redo=>dispatched.push(['reader',redo]);workspaceUndo=redo=>dispatched.push(['file',redo]);
let mode='notes-mode';document.body={classList:{contains:n=>mode===n}};
function key(place,shift=false){let prevented=false;handlers.keydown({metaKey:true,ctrlKey:false,altKey:false,key:'z',shiftKey:shift,target:{closest:s=>s.split(',').map(s=>s.trim()).includes(place),matches:()=>false},preventDefault(){prevented=true},stopImmediatePropagation(){}});return prevented}
assert(key('#notes-stage')&&dispatched.at(-1)[0]==='note','note shortcut');
assert(key('#workspace-editor',true)&&dispatched.at(-1)[0]==='file'&&dispatched.at(-1)[1],'file redo shortcut');
mode='pdf-mode';assert(key('#pdf-stage')&&dispatched.at(-1)[0]==='reader','reader shortcut');
assert(!key('#chat-box'),'chat input keeps native history');
"""#)
if failed{exit(1)}
print("PASS: typing groups, paste boundaries, structural edits, immutable history, and editor shortcut routing")
