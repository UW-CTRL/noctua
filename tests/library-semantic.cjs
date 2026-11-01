// Run with node tests/library-semantic.cjs. Exercise actual request/scheduling
// functions without a server or a Semantic Scholar key.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('web/app.js', 'utf8');
const lineage = fs.readFileSync('web/lineage.js', 'utf8');
const notes = fs.readFileSync('web/notes.js', 'utf8');
function extract(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(match, `Missing ${name}`);
  const end = source.indexOf('\n}', match.index);
  assert.ok(end > match.index, `Missing end of ${name}`);
  return source.slice(match.index, end + 2);
}
function fixture() {
  let next = 0;
  const timers = new Map(), modes = new Set(), requests = [], projects = [];
  const context = {
    document: { body: { classList: { contains: name => modes.has(name), remove() {}, toggle(name, active) { if (active) modes.add(name); else modes.delete(name); } } }, querySelectorAll: () => [] },
    G: { layout: 'lineage', token: 0, filter: false, project: null, nodes: new Map() },
    LIN: { auto: true, ai: null, res: { threads: [{ id: 't1' }] }, reqKey: 'same', error: null },
    lib: { target: 'C1' }, store: { set() {} }, inflight: 0, enc: encodeURIComponent,
    $: () => ({ classList: { add() {} } }), isNotesMode: () => modes.has('notes-mode'),
    showNotes() {}, saveNow() {}, updateChatContext() {}, requestAnimationFrame() {},
    addEdge() {}, refreshAll() {}, kick() {},
    setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    projectFolderTimer: null,
    api: async (path, body) => { requests.push({ path, body }); return {}; },
    openProject: async target => projects.push(target),
    revealCollection() {}, renderDetails() {}, renderLibTree() {}, loadLibItems() {},
    renderThreads() {}, draw() {}, toast() {}, hideToast() {}, threadsRequest: () => ({ target: 'C1' }),
  };
  vm.createContext(context);
  vm.runInContext(lineage.match(/^const lineageOn = .*$/m)[0] + '\n' +
    lineage.match(/^const lineageRequestsAllowed = .*$/m)[0] + '\n' +
    [extract(lineage, 'scheduleSummary'), extract(lineage, 'requestThreads'), extract(app, 'showCollection'), extract(app, 'loadLinks'), extract(app, 'expand'), extract(notes, 'setMode')].join('\n'), context);
  return { context, timers, modes, requests, projects, runTimers() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); } };
}
(async () => {
  for (const mode of ['notes-mode', 'pdf-mode']) {
    const f = fixture(); f.modes.add(mode);
    f.context.showCollection('C2'); f.context.scheduleSummary();
    await f.context.requestThreads({ cacheOnly: true });
    f.context.G.nodes.set('paper', {});
    await f.context.loadLinks(f.context.G.token);
    await f.context.expand('paper');
    f.runTimers();
    assert.equal(f.timers.size, 0, `${mode} must not queue graph or summary work`);
    assert.deepEqual(f.projects, [], `${mode} selection must not open project graph`);
    assert.deepEqual(f.requests, [], `${mode} must not request even cached thread summaries`);
  }
  {
    const f = fixture(); f.context.G.layout = 'library';
    f.context.showCollection('C2'); f.context.scheduleSummary();
    await f.context.requestThreads(); f.runTimers();
    assert.deepEqual(f.projects, []); assert.deepEqual(f.requests, []);
  }
  {
    const f = fixture(); f.context.showCollection('C2'); f.runTimers();
    assert.deepEqual(f.projects, ['C2'], 'Visible graph view must still load selected collection');
    f.context.scheduleSummary(); f.runTimers();
    assert.equal(f.requests[0]?.path, '/api/threads', 'Visible Lineage must still request summaries');
  }
  {
    const f = fixture(); f.context.scheduleSummary();
    assert.equal(f.timers.size, 1);
    f.modes.add('notes-mode'); f.runTimers();
    assert.deepEqual(f.requests, [], 'A queued summary must recheck Notes visibility before starting');
  }
  {
    const f = fixture(); f.context.showCollection('C2');
    assert.equal(f.timers.size, 1);
    f.modes.add('notes-mode'); f.runTimers();
    assert.deepEqual(f.projects, [], 'A queued project load must recheck Notes visibility before starting');
  }
  for (const mode of ['notes', 'pdf']) {
    const f = fixture();
    f.context.showCollection('C2');
    const token = f.context.G.token;
    assert.equal(f.timers.size, 1);
    f.context.setMode(mode);
    assert.ok(f.context.G.token > token, `${mode} must invalidate in-flight graph work`);
    assert.equal(f.timers.size, 0, `${mode} must cancel queued collection graph work`);
    await f.context.loadLinks(token);
    assert.deepEqual(f.requests, [], 'Invalidated work must not start a links request');
  }
  {
    const f = fixture(); f.context.api = async path => { f.requests.push(path); return []; };
    await f.context.loadLinks(f.context.G.token);
    assert.deepEqual(f.requests, ['/api/links'], 'Visible graph must still fetch links');
    const before = f.requests.length;
    await f.context.loadLinks(f.context.G.token - 1);
    assert.equal(f.requests.length, before, 'Stale token must not start another links request');
  }
  // Evaluate the actual initial hash block in isolation to reproduce restoring
  // Notes with a retained graph URL, before Notes mode classes are installed.
  const startupAt = app.indexOf('const collectionsReady = loadCollections();');
  assert.ok(startupAt >= 0);
  const startupEnd = app.indexOf('\n}', startupAt);
  const startup = app.slice(startupAt, startupEnd + 2);
  for (const hash of ['#paper=paper-id', '#project=C1']) {
    for (const mode of ['notes', 'graph']) {
      const calls = [], context = {
        location: { hash }, store: { get: () => mode },
        loadCollections: () => Promise.resolve(),
        loadGraph: id => calls.push(['paper', id]), openProject: id => calls.push(['project', id]),
      };
      vm.createContext(context); vm.runInContext(startup, context);
      await Promise.resolve();
      assert.equal(calls.length, mode === 'notes' ? 0 : 1, `Startup ${hash} with saved ${mode}`);
    }
  }
  {
    const f = fixture(); f.modes.add('notes-mode');
    // Leave the request pending so only the real openProject entry and request
    // setup run; this verifies explicit graph navigation leaves Notes first.
    f.context.api = async path => { f.requests.push(path); return new Promise(() => {}); };
    Object.assign(f.context, { closeSearchResults() {}, targetName: id => id, showTab() {} });
    vm.runInContext(extract(app, 'openProject'), f.context);
    f.context.openProject('C1');
    assert.equal(f.modes.has('notes-mode'), false, 'Explicit graph navigation must leave Notes');
    assert.deepEqual(f.requests, ['/api/project?target=C1']);
  }
  console.log('PASS Library Semantic Scholar request scope');
})().catch(error => { console.error(error); process.exitCode = 1; });
