const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

function context() {
  const cx = vm.createContext({ settings: { version: '0.3.5' }, isDesktopConnectionClient: () => false });
  vm.runInContext(fs.readFileSync('web/update-dialogs.js', 'utf8'), cx);
  return cx;
}

test('server-only offers use server release links and escape component warnings', () => {
  const cx = context();
  const html = cx.NoctuaUpdateDialogs.summary({component:'server', version:'0.3.6',
    server:{version:'0.3.6',current_version:'0.3.5'},warnings:['Desktop check <failed>']});
  assert.match(html, /0\.3\.5 → 0\.3\.6/);
  assert.match(html, /releases\/tag\/server-v0\.3\.6/);
  assert.match(html, /&lt;failed&gt;/);
  assert.doesNotMatch(html, /\/compare\//);
});

test('combined offers show both independently versioned components', () => {
  const html = context().NoctuaUpdateDialogs.summary({version:'0.4.0',current_version:'0.3.5',
    server:{version:'0.5.0',current_version:'0.4.8'}});
  assert.match(html, /Local server: 0\.4\.8 → 0\.5\.0/);
  assert.match(html, /0\.3\.5 → 0\.4\.0/);
});

test('a server-only installation does not offer a desktop restart', async () => {
  const cx = context();
  const source = fs.readFileSync('web/setup.js', 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function updateApp('), source.indexOf('\nfunction showUpdatePrompt(')), cx);
  cx.api = async () => ({status:'server_updating'});
  const button = {dataset:{updateAction:'install',updateVersion:'0.3.6'}};
  const messages = [];
  await cx.updateApp(button, {querySelector: () => null}, (_, message) => messages.push(message), {confirmInstall:false});
  assert.equal(button.dataset.updateAction, 'check');
  assert(messages.some(message => message.includes('Server & Connection')));
  assert(!messages.some(message => message.includes('Restart Noctua')));
});
