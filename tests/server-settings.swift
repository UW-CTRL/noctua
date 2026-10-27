// macOS: swift tests/server-settings.swift
import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JavaScript error");exit(1)}
let source=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let a=source.range(of:"function isDesktopConnectionClient()")!.lowerBound
let b=source.range(of:"function skillSettingsSection()")!.lowerBound
let navStart=source.range(of:"    if (nav) {")!.lowerBound
let navEnd=source.range(of:"    const t =",range:navStart..<source.endIndex)!.lowerBound
c.evaluateScript(#"""
let window={top:{location:{href:''}}},location={origin:'http://localhost'},settings={version:'test'};
const esc=s=>String(s);let selected='';const selectTab=id=>{selected=id;};
function assert(v,m){if(!v)throw Error(m);}
"""# + String(source[a..<b]) + "\nfunction clickCategory(nav){" + String(source[navStart..<navEnd]) + "}")
c.evaluateScript(#"""
assert(!openServerConnectionSettings()&&window.top.location.href==='','browser must not navigate to native callback');
assert(!serverSection().includes('data-act="open-server-connection"')&&serverSection().includes('browser-server-token'),'browser must offer address and token fields');
assert(serverSection().includes('How to start a server')&&serverSection().includes('noctua ensure')&&serverSection().includes('noctua token')&&serverSection().includes('noctua status')&&serverSection().includes('noctua stop'),'browser startup guide must include executable commands');
window.top.noctuaDesktopClient=true;
assert(serverSection().includes('data-client-section="local"')&&serverSection().includes('Change connection')&&!serverSection().includes('browser-server-start-help'),'desktop must offer native manager instead of browser startup guide');
clickCategory({dataset:{settingsTab:'server'}});
assert(selected==='server'&&!window.top.location.href,'desktop server category must stay in general settings');
openServerConnectionSettings('local');assert(window.top.location.href==='https://noctua.invalid/settings?section=local','server management must open the local settings section');
window.top.location.href='';clickCategory({dataset:{settingsTab:'appearance'}});
assert(selected==='appearance'&&!window.top.location.href,'other categories must stay in settings');
window.top={location:{href:''}};window.noctuaDesktopClient=true;
assert(openServerConnectionSettings(),'top-level desktop marker must also work');
"""#)
print("PASS: general Settings navigation, separate connection/server management actions, scoped native callbacks and browser fallback")
