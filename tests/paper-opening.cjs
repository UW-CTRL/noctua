'use strict';
// Run with node tests/paper-opening.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('web/index.html', 'utf8');
const source = fs.readFileSync('web/pdf.js', 'utf8');
const routeStart = source.indexOf('function pdfRoute(){');
const route = source.slice(routeStart, source.indexOf('\n}', routeStart) + 2);
const bootstrap = html.match(/<body>\s*<script>([\s\S]*?)<\/script>/)[1];

function fixture(hash, key = null) {
  const modes = [], errors = [], requests = [], classes = [];
  const stage = { innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const context = vm.createContext({
    location: { hash }, URLSearchParams, PDF: { key },
    document: { body: { classList: { add: name => classes.push(name) } } },
    setMode: mode => modes.push(mode), $: () => stage,
    openPDF: (key, options) => { requests.push({ key, options }); return pending; },
    toast: message => errors.push(message),
  });
  vm.runInContext(bootstrap, context);
  vm.runInContext(route, context);
  return { context, modes, errors, requests, classes, stage, resolve, reject };
}

(async () => {
  const f = fixture('#pdf=paper%2Fkey&page=7&annotation=a1');
  assert.deepEqual(f.classes, ['pdf-mode'], 'Reader must be selected before the page content is parsed');
  const opened = f.context.pdfRoute();
  assert.deepEqual(f.modes, ['pdf'], 'Reader must appear before PDF loading completes');
  assert.match(f.stage.innerHTML, /role="status".*Loading paper/);
  assert.equal(f.requests[0].key, 'paper/key');
  assert.equal(f.requests[0].options.page, '7');
  assert.equal(f.requests[0].options.annotation, 'a1');
  assert.equal(f.requests[0].options.push, false);
  f.resolve(); await opened;
  assert.deepEqual(f.modes, ['pdf']);

  const failed = fixture('#pdf=missing');
  const opening = failed.context.pdfRoute();
  failed.reject(Error('PDF unavailable')); await opening;
  assert.deepEqual(failed.modes, ['pdf', 'graph']);
  assert.equal(failed.stage.innerHTML, '');
  assert.deepEqual(failed.errors, ['PDF unavailable']);

  const existing = fixture('#pdf=missing', 'current');
  const switching = existing.context.pdfRoute();
  existing.reject(Error('PDF unavailable')); await switching;
  assert.deepEqual(existing.modes, ['pdf'], 'A failed navigation must preserve the existing Reader');
  assert.equal(existing.stage.innerHTML, '');

  for (const hash of ['', '#project=C1', '#paper=abc']) {
    const library = fixture(hash);
    assert.deepEqual(library.classes, []);
    library.context.pdfRoute();
    assert.deepEqual(library.modes, []);
    assert.deepEqual(library.requests, []);
  }
  console.log('PASS: direct Reader startup, pending PDF, routes and failure recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
