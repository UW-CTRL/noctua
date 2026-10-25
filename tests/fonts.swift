// macOS: swift tests/fonts.swift
import Foundation
import JavaScriptCore
let context = JSContext()!
context.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
let source = try String(contentsOfFile: "web/fonts.js", encoding: .utf8)
let mocks = #"""
const window=globalThis,values=new Map(),properties=new Map(),listeners={},events=[];
const localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
window.addEventListener=(type,fn)=>listeners[type]=fn;
class CustomEvent{constructor(type,options){this.type=type;this.detail=options.detail;}}
const document={documentElement:{style:{setProperty:(k,v)=>properties.set(k,v)}},dispatchEvent:event=>events.push(event)};
function assert(value,message){if(!value)throw Error(message);}
"""#
let checks = #"""
assert(NoctuaFonts.get('ui').id==='system'&&NoctuaFonts.get('note').id==='latex','defaults changed');
const originalNote=properties.get('--font-note');
NoctuaFonts.set('ui','arial');assert(properties.get('--font-ui').startsWith('Arial'),'app font not applied');
assert(properties.get('--font-note')===originalNote,'app font changed independent note preference');
assert(JSON.parse(values.get('noctua.font.ui')).id==='arial','app font not saved');
NoctuaFonts.set('note','georgia');assert(properties.get('--font-note').startsWith('Georgia'),'note font not applied');
assert(NoctuaFonts.get('ui').id==='arial','note font changed app preference');
NoctuaFonts.set('note','app');assert(NoctuaFonts.get('note').id==='latex','removed note preset did not fall back');
NoctuaFonts.set('ui','custom','  Pretendard  ');assert(NoctuaFonts.get('ui').name==='Pretendard','custom name not normalized');
assert(properties.get('--font-ui').startsWith('"Pretendard",'),'custom font stack missing fallback');
NoctuaFonts.set('ui','custom','A"B\\C');assert(properties.get('--font-ui').startsWith('"A\\"B\\\\C",'),'custom font name was not quoted safely');
NoctuaFonts.set('ui','custom','');assert(NoctuaFonts.get('ui').id==='system','empty custom font did not fall back');
NoctuaFonts.set('note','invalid');assert(NoctuaFonts.get('note').id==='latex','invalid font did not fall back');
values.set('noctua.font.note',JSON.stringify({id:'times'}));listeners.storage({key:'noctua.font.note'});
assert(NoctuaFonts.get('note').id==='times'&&properties.get('--font-note').includes('Times New Roman'),'cross-window preference did not sync');
values.set('noctua.font.ui','invalid JSON');listeners.storage({key:'noctua.font.ui'});assert(NoctuaFonts.get('ui').id==='system','malformed preference did not recover');
assert(NoctuaFonts.choices('note').some(p=>p.id==='latex')&&!NoctuaFonts.choices('ui').some(p=>p.id==='latex'),'font choices mixed app and document roles');
assert(['ui','note','chat'].every(kind=>!NoctuaFonts.choices(kind).some(p=>p.id==='app')),'removed match-app option remains');
assert(events.some(e=>e.type==='noctua-font-change'&&e.detail.kind==='note'),'font change notification missing');
assert(NoctuaFonts.get('chat').id==='system'&&NoctuaFonts.getChatSize()===13,'chat defaults changed');
NoctuaFonts.set('chat','georgia');assert(properties.get('--font-chat').startsWith('Georgia'),'independent chat font missing');
NoctuaFonts.setChatSize(18);assert(properties.get('--chat-font-size')==='18px'&&values.get('noctua.font.chatSize')==='18','chat text size not applied and saved');
NoctuaFonts.setChatSize(100);assert(NoctuaFonts.getChatSize()===24,'chat maximum not enforced');
NoctuaFonts.setChatSize(1);assert(NoctuaFonts.getChatSize()===10,'chat minimum not enforced');
NoctuaFonts.setChatSize('invalid');assert(NoctuaFonts.getChatSize()===13,'invalid chat size did not recover');
values.set('noctua.font.chatSize','20');listeners.storage({key:'noctua.font.chatSize'});assert(NoctuaFonts.getChatSize()===20,'chat size did not sync across windows');
assert(events.some(e=>e.type==='noctua-chat-text-change'&&e.detail.size===20),'chat size notification missing');
NoctuaFonts.setSize('ui',16);NoctuaFonts.setSize('note',22);
assert(properties.get('--ui-font-size')==='16px'&&properties.get('--note-font-size')==='22px','UI/note sizes not applied');
assert(NoctuaFonts.getChatSize()===20,'UI/note sizing changed chat size');
assert(values.get('noctua.font.uiSize')==='16'&&values.get('noctua.font.noteSize')==='22','UI/note sizes not saved');
assert(NoctuaFonts.sizeChoices('ui').includes(16)&&NoctuaFonts.sizeChoices('note').includes(22),'size choices missing');
values.set('noctua.font.noteSize','24');listeners.storage({key:'noctua.font.noteSize'});assert(NoctuaFonts.getSize('note')===24,'note size did not sync across windows');
assert(NoctuaFonts.getSize('noteTitle')===28,'title default changed');
NoctuaFonts.setSize('noteTitle',28);
assert(properties.get('--note-title-font-size')==='28px'&&NoctuaFonts.getSize('note')===24,'title and body sizes are not independent');
assert(values.get('noctua.font.noteTitleSize')==='28','title size not saved');
NoctuaFonts.setSize('noteTitle',100);assert(NoctuaFonts.getSize('noteTitle')===36,'title maximum missing');
NoctuaFonts.setSize('noteTitle',1);assert(NoctuaFonts.getSize('noteTitle')===12,'title minimum missing');
NoctuaFonts.setSize('noteTitle','invalid');assert(NoctuaFonts.getSize('noteTitle')===28,'invalid title size not recovered');
values.set('noctua.font.noteTitleSize','30');listeners.storage({key:'noctua.font.noteTitleSize'});
assert(NoctuaFonts.getSize('noteTitle')===30&&properties.get('--note-title-font-size')==='30px','title size did not sync across windows');



"""#
context.evaluateScript(mocks + source + checks)
// Reloading the module must restore the saved choice before painting.
context.evaluateScript("NoctuaFonts.set('ui','helvetica');NoctuaFonts.setChatSize(17);" + source + "assert(NoctuaFonts.get('ui').id==='helvetica'&&NoctuaFonts.getChatSize()===17&&NoctuaFonts.getSize('ui')===16&&NoctuaFonts.getSize('note')===24&&NoctuaFonts.getSize('noteTitle')===30,'font preference not restored on reload');")
print("PASS: independent font choices, defaults, persistence, reload, custom names, UI/note/chat text sizing, bounds, escaping and cross-window updates")

// Exercise the real Appearance markup and size-change handler.
let setup = try String(contentsOfFile: "web/setup.js", encoding: .utf8)
let settingsStart = setup.range(of: "function fontSizeSetting")!.lowerBound
let settingsEnd = setup.range(of: "function syncFontSetting")!.lowerBound
let changeStart = setup.range(of: "card.addEventListener('change', async (e) => {")!.upperBound
let changeEnd = setup.range(of: "\n  });", range: changeStart..<setup.endIndex)!.lowerBound
context.evaluateScript("const esc=s=>String(s); function msg(){};" + String(setup[settingsStart..<settingsEnd]) + "\nasync function changeFontSetting(e){" + String(setup[changeStart..<changeEnd]) + "\n}")
context.evaluateScript(#"""
const noteSettings=fontSetting('note','Note font');
assert(noteSettings.includes('Title size')&&noteSettings.includes('Body size'),'separate note size labels missing');
assert(noteSettings.includes('setup-noteTitle-font-size')&&noteSettings.includes('setup-note-font-size'),'separate selectors missing');
(async()=>{
 await changeFontSetting({target:{id:'setup-noteTitle-font-size',value:'26',closest:()=>({})}});
 assert(NoctuaFonts.getSize('noteTitle')===26&&NoctuaFonts.getSize('note')===24,'title setting did not route independently');
 await changeFontSetting({target:{id:'setup-note-font-size',value:'20',closest:()=>({})}});
 assert(NoctuaFonts.getSize('note')===20&&NoctuaFonts.getSize('noteTitle')===26,'body setting did not route independently');
})().catch(e=>{throw e});
"""#)
print("PASS: separate title/body size selectors and Appearance change routing")
