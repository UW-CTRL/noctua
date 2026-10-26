// Exercise the shipped chat request path, including one-message skill enablement.
import Foundation
import JavaScriptCore
let context=JSContext()!
var failed=false
context.exceptionHandler={_,error in print(error?.toString() ?? "JavaScript error");failed=true}
let app=try String(contentsOfFile:"web/app.js",encoding:.utf8)
let workspace=try String(contentsOfFile:"web/workspace.js",encoding:.utf8)
let start=app.range(of:"async function sendChat(text)")!.lowerBound
let end=app.range(of:"\nfunction showRightTab",range:start..<app.endIndex)!.lowerBound
let picker=workspace.range(of:"window.NoctuaSkillPicker=")!.lowerBound
context.evaluateScript(#"""
const window=globalThis,chat={provider:'claude',id:'chat',mode:'plan'},requests=[];
const body={querySelector:()=>null,insertAdjacentHTML:()=>{throw Error('Unexpected send error');}};
const $=()=>null,enc=encodeURIComponent;
const AbortController=function(){this.signal={aborted:false};};
function appendMsg(){return {querySelector:()=>body};}
const saves=[];
function stopEdit(){saves.push("stop");}
async function saveWorkspaceFile(){saves.push("file");}
async function flushNoteEdits(){saves.push("note");}
function toast(message){throw Error(message);}
let approvalClosures=0;
function closeFileEditApprovals(){approvalClosures++;}
function setChatBusy(b){chat.busy=b;}
function userMsgHtml(t){return t;}
function chatContext(){return {context:'project',key:'key',noteKey:null};}
function chatProjectTarget(){return 'L1';}
let fileDrafts=[{id:"upload-one",name:"chart.pdf"}];
window.NoctuaChatFiles={snapshot:()=>({files:[...fileDrafts]}),consume:()=>{fileDrafts=[];}};
const NoctuaChatRender={enhance(){}};
async function chatAttachments(){return 'paper attachment';}
async function readEvents(){}
async function api(path){return path==='/api/skills'?[{id:'s1',name:'review',description:'Review papers'}]:{skills:['project-skill']};}
async function fetch(path,options){requests.push(JSON.parse(options.body));return {ok:true};}
function assert(ok,message){if(!ok)throw Error(message);}
"""# + String(workspace[picker...]) + String(app[start..<end]) + #"""
(async()=>{
 await sendChat('/review summarize this');
 const request=requests[0];
 assert(request.skill_ids.join(',')==='s1','selected skill not enabled in request');
 assert(request.files.join(',')==='upload-one','uploaded file lost when invoking a skill');
 assert(request.attachments.includes('paper attachment')&&request.attachments.includes('skill_id="s1"'),'skill instructions or existing attachments lost');
 assert(request.message==='/review summarize this'&&request.mode==='plan','message or mode changed');
 await sendChat('next question');
 assert(requests[1].skill_ids.length===0&&!requests[1].attachments.includes('skill_id='),'one-message skill leaked into next request');
 assert(requests[1].files.length===0,'sent file leaked into the next request');
 assert(!chat.busy&&!chat.abort,'request did not finish');
 assert(approvalClosures===2,'file approvals were not closed after each skill turn');
 assert(saves.join(',')==='stop,file,note,stop,file,note','skill turns must save current drafts before sending');
 globalThis.testResult='PASS: actual chat payload enables selected skills, preserves attachments and Plan mode, and restores defaults next turn';
})().catch(e=>globalThis.testResult='FAIL: '+e.message+'\n'+e.stack);
"""#)
let deadline=Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("testResult").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=context.objectForKeyedSubscript("testResult").toString() ?? "FAIL: no result"
print(result)
if failed || !result.hasPrefix("PASS:"){exit(1)}
