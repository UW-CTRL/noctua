// Run with: node tests/pdf-comments.cjs
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/pdf.js','utf8');
let server,calls=[],release,fail=false,defer=false;
const drafts=new Map(),timers=new Map();let nextTimer=0;
const context=vm.createContext({console,TextEncoder,Promise,enc:encodeURIComponent,PDF:{key:'paper',annotations:[]},
 document:{querySelectorAll:()=>[]},window:{addEventListener(){}},
 store:{get:k=>drafts.get(k),set:(k,v)=>drafts.set(k,v)},localStorage:{removeItem:k=>drafts.delete(k)},
 setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id),
 pdfSaves:new Set(),paperURL:key=>'/api/papers/'+key,pdfSave:p=>p,
 api:async()=>[{...server}],
 fetch:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push(body);
  if(defer){defer=false;await new Promise(resolve=>release=resolve);}
  if(fail)throw Error('Offline');
  if(body.revision!==server.revision)return {ok:false,status:409,json:async()=>({error:'Conflict'})};
  Object.assign(server,{comment:body.comment,revision:server.revision+1});
  return {ok:true,json:async()=>({...server})};
 },
 libraryRequest:async(url,method,body)=>{
  assert.equal(method,'DELETE');assert.equal(Number(url.split('?revision=')[1]),server.revision);
  calls.push('DELETE');return {};
 }
});
vm.runInContext(source.slice(source.indexOf('const pdfCommentEdits='),source.indexOf('async function refreshPDFAnnotations()')),context);
vm.runInContext(source.match(/window\.flushPDF=async[^\n]+/)[0],context);
const run=s=>vm.runInContext(s,context);
function reset(comment='original'){
 server={id:'a',revision:1,comment};calls=[];drafts.clear();timers.clear();fail=false;defer=false;
 context.PDF.annotations=[{...server}];run("pdfCommentEdits.clear();globalThis.edit=pdfCommentEdit('paper',PDF.annotations[0]);");
}
(async()=>{
 reset();run("queuePDFComment(edit,'first');queuePDFComment(edit,'latest');");assert.equal(timers.size,1);assert.equal(calls.length,0);
 await run('savePDFComment(edit)');assert.equal(server.comment,'latest');assert.equal(drafts.size,0);
 reset();defer=true;run("queuePDFComment(edit,'first')");const first=run('savePDFComment(edit)');
 run("queuePDFComment(edit,'newer')");release();await first;
 assert.equal(server.comment,'newer');assert.deepEqual(calls.map(c=>c.revision),[1,2]);assert.equal(drafts.size,0);
 reset();run("queuePDFComment(edit,'draft')");server.revision=2;await run('savePDFComment(edit)');
 assert.equal(server.comment,'draft');assert.deepEqual(calls.map(c=>c.revision),[1,2]);
 reset();run("queuePDFComment(edit,'local draft')");server={...server,comment:'remote edit',revision:2};
 await assert.rejects(run('savePDFComment(edit)'),/changed in another window/);
 assert.equal(server.comment,'remote edit');assert.equal(drafts.get('pdf-draft:a'),'local draft');assert.equal(run('edit.conflict'),true);
 await run('savePDFComment(edit)');assert.equal(calls.length,1,'conflict must not silently overwrite another writer');
 reset();run("queuePDFComment(edit,'offline draft')");fail=true;await assert.rejects(run('savePDFComment(edit)'),/Offline/);
 assert.equal(drafts.get('pdf-draft:a'),'offline draft');fail=false;await run('savePDFComment(edit)');assert.equal(server.comment,'offline draft');
 reset();defer=true;run("queuePDFComment(edit,'before delete')");const save=run('savePDFComment(edit)');
 const deletion=run("changePDFAnnotation(edit,'DELETE')");assert.equal(calls.length,1);release();await Promise.all([save,deletion]);
 assert.equal(calls.at(-1),'DELETE');assert.equal(run('edit.deleted'),true);assert.equal(drafts.size,0);
 await run('savePDFComment(edit)');assert.equal(calls.length,2,'deleted annotations must never be saved again');
 reset();drafts.set('pdf-draft:a','recovered draft');drafts.set('pdf-draft-base:a','old comment');run("pdfCommentEdits.clear();globalThis.edit=pdfCommentEdit('paper',PDF.annotations[0]);");
 assert.equal(run('edit.conflict'),true,'restored drafts must detect changes made while closed');
 reset();run("queuePDFComment(edit,'flush draft')");await run('window.flushPDF()');assert.equal(server.comment,'flush draft');assert.equal(timers.size,0);
 console.log('PASS: tab-close flushing, debounce, serialized comment saves, safe revision rebasing, conflicts, offline draft recovery, deletion during save, restored draft conflicts');
})().catch(e=>{console.error(e);process.exitCode=1;});
