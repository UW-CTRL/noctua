const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Store {
  getItem(key) { return Object.hasOwn(this,key) ? this[key] : null; }
  setItem(key,value) { if(this.full)throw Error('quota');Object.defineProperty(this,key,{value:String(value),writable:true,enumerable:true,configurable:true}); }
}
function migration(storage) {
  const context=vm.createContext({window:{},localStorage:storage});
  vm.runInContext(fs.readFileSync('web/desktop-storage.js','utf8'),context);
  return context.window.noctuaStorageMigration;
}
test('migration retains source data, unrelated storage and newer destination edits',()=>{
  const source=new Store(),target=new Store();
  source.setItem('noctua.theme','dark');source.setItem('unrelated.secret','private');
  const draft='noctua.draft.v2:server:L1:note:old-editor';
  source.setItem(draft,'old draft');target.setItem(draft,'new draft');
  const snapshot=migration(source).read();
  assert.equal(snapshot.ok,true);assert.equal(snapshot.entries.length,2);
  assert.equal(migration(target).apply(snapshot.entries,'noctua.desktop-storage-migrated.server'),true);
  assert.equal(source.getItem(draft),'old draft');
  assert.equal(target.getItem(draft),'new draft');
  assert.equal(target.getItem(draft+':migrated'),'old draft');
  assert.equal(target.getItem('noctua.theme'),'dark');
  assert.equal(target.getItem('unrelated.secret'),null);
});
test('partial/quota failures never mark migration complete and can be retried',()=>{
  const target=new Store(),helper=migration(target),marker='noctua.desktop-storage-migrated.server';
  target.full=true;assert.equal(helper.apply([['noctua.theme','dark']],marker),false);assert.equal(target.getItem(marker),null);
  target.full=false;assert.equal(helper.apply([['noctua.theme','dark']],marker),true);assert.equal(target.getItem(marker),'1');
});
test('malformed and unrelated imports are rejected before any writes',()=>{
  for(const entries of [null,[['unrelated','private']],[['noctua.theme',{}]],[['noctua.theme']]]) {
    const target=new Store();assert.equal(migration(target).apply(entries,'marker'),false);assert.equal(Object.keys(target).length,0);
  }
});
test('legacy note draft conflicts are preserved in a recoverable v2 slot',()=>{
  const target=new Store(),key='noctua.draft.v1:server:L1:note';target.setItem(key,'new');
  assert.equal(migration(target).apply([[key,'old']],'marker'),true);
  assert.equal(target.getItem('noctua.draft.v2:server:L1:note:migrated'),'old');
});

test('native migration can keep its completion marker outside the draft-storage quota',()=>{
  const target=new Store(),helper=migration(target);
  target.setItem=function(key,value){if(key.includes('migrated'))throw Error('no room for a marker');Store.prototype.setItem.call(this,key,value)};
  assert.equal(helper.apply([['noctua.theme','dark']],null),true);
  assert.equal(target.getItem('noctua.theme'),'dark');
  assert.deepEqual(Object.keys(target),['setItem','noctua.theme']);
});
