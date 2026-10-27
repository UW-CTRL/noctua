// macOS: swift tests/app-icons.swift
import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JavaScript error");exit(1)}
let source=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let a=source.range(of:"function appIconSettings()")!.lowerBound,b=source.range(of:"function appearanceSection()")!.lowerBound
let start=source.range(of:"    if (e.target.name === 'app-icon') {")!.lowerBound,end=source.range(of:"    const category=",range:start..<source.endIndex)!.lowerBound
c.evaluateScript(#"""
let settings={desktop:true},fail=false,message='',calls=[];
const controls=['dark','light'].map(value=>({value,checked:value==='dark',disabled:false}));
const section={querySelectorAll(){return controls;}};
function msg(section,text){message=text;}
async function api(path,body){calls.push({path,body});if(fail)throw Error('Cannot save icon');return body;}
function assert(value,message){if(!value)throw Error(message);}
"""#+String(source[a..<b])+"\nasync function change(e){"+String(source[start..<end])+"\n}")
c.evaluateScript(#"""
(async()=>{
 let html=appIconSettings();
 assert(html.includes('/app-icons/dark.svg')&&html.includes('/app-icons/light.svg'),'both icon previews must be available');
 assert(html.includes('value="light" checked')&&html.includes('Applies immediately'),'default choice and application timing must be clear');
 assert(!/macOS|Finder|Dock|Windows|Linux/.test(html),'icon guidance must be platform-neutral');
 settings.app_icon='dark';assert(appIconSettings().includes('value="dark" checked'),'saved Dark choices must be preserved');
 const event=icon=>({target:{name:'app-icon',value:icon,closest:()=>section}});
 await change(event('light'));
 assert(settings.app_icon==='light'&&controls[1].checked&&!controls[0].checked,'successful selection must update the saved choice');
 assert(controls.every(c=>!c.disabled)&&calls[0].path==='/api/settings/app-icon','selection must save through the backend and restore controls');
 fail=true;await change(event('dark'));
 assert(settings.app_icon==='light'&&controls[1].checked&&message==='Cannot save icon','failed saves must retain the previous choice and show the error');
 settings.desktop=false;
 assert(appIconSettings()==='','browser/server content must hide native icon controls');
 globalThis.result='PASS: app icon previews, platform-neutral guidance, persistence, failed saves and browser mode';
})().catch(error=>globalThis.result='FAIL: '+error.stack);
"""#)
let deadline=Date().addingTimeInterval(5)
while c.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=c.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
