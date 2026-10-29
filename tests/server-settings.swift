// macOS: swift tests/server-settings.swift
import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JavaScript error");exit(1)}
let source=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let a=source.range(of:"function isDesktopConnectionClient()")!.lowerBound
let b=source.range(of:"function skillSettingsSection()")!.lowerBound
let navStart=source.range(of:"  const selectTab = (id, focus = false) => {")!.lowerBound
let navEnd=source.range(of:"  const render = () => {",range:navStart..<source.endIndex)!.lowerBound
c.evaluateScript(#"""
let window={top:{}},location={origin:'http://localhost'},settings={version:'test'};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;');
let active=false,hiddenMessages=0;
const card={querySelector:selector=>selector==='.settings-content'?{classList:{toggle:(_,value)=>{active=value}}}:selector==='.server-settings-frame'?{contentWindow:{postMessage:message=>{if(message.type==='noctua-manager-hidden')hiddenMessages++}}}:null,querySelectorAll:()=>[]};
const store={set:()=>{}};const SETTINGS_TABS=[['appearance','Appearance'],['server','Server']];
function assert(v,m){if(!v)throw Error(m);}
"""# + String(source[a..<b]) + String(source[navStart..<navEnd]))
c.evaluateScript(#"""
assert(serverSection().includes('browser-server-token'),'browser must offer address and token fields');
assert(serverSection().includes('How to start a server')&&serverSection().includes('noctua ensure')&&serverSection().includes('noctua token'),'browser startup guide must include executable commands');
selectTab('server');assert(!active,'browser must retain regular settings layout');
window.top.noctuaDesktopClient=true;
assert(serverSection().includes('Reopen the app'),'missing manager endpoint must explain recovery');
window.top.noctuaManagerUrl='http://127.0.0.1:1234/ticket/index.html?overlay=1';
const html=serverSection();
assert(html.includes('<iframe')&&html.includes(window.top.noctuaManagerUrl)&&html.includes('title="Server &amp; Connection"'),'desktop must embed the isolated endpoint directly in its settings panel');
assert(!html.includes('browser-server-token')&&!html.includes('data-act='),'desktop must not show another launch button');
selectTab('server');assert(active,'server panel must use its full allocated DOM bounds');
selectTab('appearance');assert(!active&&hiddenMessages>=2,'leaving must restore normal tab layout and clear manager secrets');
"""#)
if source.contains("viewportHeight") || source.contains("close-manager") || source.contains("openServerConnectionSettings") { fatalError("Native geometry callbacks must be removed") }
print("PASS: DOM-based isolated server settings, tab navigation, secret clearing and browser fallback")
