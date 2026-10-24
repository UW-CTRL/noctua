import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JS error");exit(1)}
let source=try String(contentsOfFile:"web/app.js",encoding:.utf8)
let start=source.range(of:"const abstractDetails =")!.lowerBound
let end=source.range(of:"function renderDetails()",range:start..<source.endIndex)!.lowerBound
let mocks=#"""
const enc=encodeURIComponent,esc=String;
let calls=[],pending=[],renders=0;
const G={selected:'a',nodes:new Map()},results=[],lib={detail:null};
const PDF={paper:null},modes=new Set(),document={body:{classList:{contains:k=>modes.has(k)}}};
function api(path){calls.push(path);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}
function renderDetails(){renders++;}
function updateChatContext(){}
function titlesAgree(a,b){return a===b;}
function assert(v,m){if(!v)throw Error(m);}
const tick=()=>new Promise(resolve=>{Promise.resolve().then(()=>Promise.resolve()).then(resolve);});
"""#
let checks=#"""
(async()=>{
 const a={paperId:'a'},b={paperId:'b'};G.nodes.set('a',{p:a});G.nodes.set('b',{p:b});
 ensureAbstract(a);ensureAbstract(a);assert(calls.length===1,'duplicate abstract request');assert(abstractHTML(a).includes('Loading'),'missing loading state');
 G.selected='b';ensureAbstract(b);pending[0].resolve({abstract:'Abstract A'});await tick();await tick();assert(renders===0,'late A response rerendered B');
 pending[1].resolve({abstract:'Abstract B'});await tick();await tick();assert(b.abstract==='Abstract B'&&renders===1,'selected abstract did not load');
 const native={key:'native',s2:'native-s2'};lib.detail=native;ensureAbstract(native,true);pending[2].resolve({abstract:'Library abstract'});await tick();await tick();assert(native.abstractNote==='Library abstract'&&abstractHTML(native,true).includes('Library abstract'),'library abstract missing');
 const empty={paperId:'empty'};G.selected='empty';G.nodes.set('empty',{p:empty});ensureAbstract(empty);pending[3].resolve({abstract:null});await tick();await tick();ensureAbstract(empty);assert(calls.length===4,'unavailable abstract repeatedly fetched');assert(abstractHTML(empty).includes('No abstract supplied'),'unavailable state missing');
 const failed={paperId:'failed'};ensureAbstract(failed);pending[4].reject(Error('offline'));await tick();await tick();assert(abstractHTML(failed).includes('Retry'),'failed request has no retry');
 abstractDetails.delete(abstractKey(failed,false));ensureAbstract(failed);assert(calls.length===6,'retry did not request again');pending[5].resolve({abstract:'Recovered'});await tick();await tick();
 const reader={key:'reader',s2:'reader-s2'};PDF.paper=reader;modes.add('pdf-mode');const beforeReader=renders;
 ensureAbstract(reader,true);pending[6].resolve({abstract:'Reader abstract'});await tick();await tick();assert(reader.abstractNote==='Reader abstract'&&renders===beforeReader+1,'reader abstract did not refresh active paper info');
 const stale={key:'stale',s2:'stale-s2'};PDF.paper=stale;ensureAbstract(stale,true);PDF.paper=reader;const beforeStale=renders;
 pending[7].resolve({abstract:'Old PDF abstract'});await tick();await tick();assert(renders===beforeStale,'late response from a previous PDF refreshed the current paper info');

 globalThis.result='PASS: automatic abstracts, deduplication, selection races, library display, missing records, retry and reader selection races';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#
c.evaluateScript(mocks+String(source[start..<end])+checks)
let deadline=Date().addingTimeInterval(5)
while c.objectForKeyedSubscript("result").isUndefined && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=c.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
