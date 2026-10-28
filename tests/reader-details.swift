// macOS: swift tests/reader-details.swift
import Foundation
import JavaScriptCore
let context=JSContext()!
context.exceptionHandler={_,error in print(error?.toString() ?? "JavaScript error");exit(1)}
let app=try String(contentsOfFile:"web/app.js",encoding:.utf8)
let notes=try String(contentsOfFile:"web/notes.js",encoding:.utf8)
func section(_ source:String,_ start:String,_ end:String)->String {
 let a=source.range(of:start)!.lowerBound,b=source.range(of:end,range:a..<source.endIndex)!.lowerBound
 return String(source[a..<b])
}
let mocks=#"""
const modes=new Set(),shown=[],G={selected:'original-selection',nodes:new Map()},results=[],lib={detail:{key:'previous',title:'Previous selection'}},PDF={paper:{key:'reader-a',title:'Reader A'}};
const document={body:{classList:{contains:k=>modes.has(k),toggle(k,v){if(v)modes.add(k);else modes.delete(k);}}},querySelectorAll:()=>[]};
const $=()=>({classList:{add(){}}});
const store={set(){}};
function renderLibDetails(paper){shown.push(paper.key);}
const isNotesMode=()=>modes.has('notes-mode');function showNotes(){}
function updateChatContext(){}function saveNow(){}function draw(){}function requestAnimationFrame(fn){fn();}
function assert(v,m){if(!v)throw Error(m);}
"""#
let checks=#"""
setMode('pdf');assert(shown.at(-1)==='reader-a','entering Reader kept the previous paper info');
PDF.paper={key:'reader-b',title:'Reader B'};setMode('pdf');assert(shown.at(-1)==='reader-b','switching PDFs did not update paper info');
renderDetails();assert(shown.at(-1)==='reader-b','refresh replaced reader metadata with another selection');
assert(G.selected==='original-selection'&&lib.detail.key==='previous','reader sync changed graph/library selection');
setMode('graph');assert(shown.at(-1)==='previous','leaving Reader did not restore selected-paper info');
setMode('pdf');assert(shown.at(-1)==='reader-b','returning to Reader did not restore PDF info');
"""#
context.evaluateScript(mocks+section(app,"function renderDetails()","async function saveToLibrary(")+section(notes,"function setMode(","function showNotes()")+checks)
print("PASS: reader paper info follows PDFs and mode switches, survives refresh, and preserves graph/library selection")
