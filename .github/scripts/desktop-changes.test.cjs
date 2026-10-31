const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const detect = require('./desktop-changes.cjs');

test('documentation and unrelated tests skip desktop checks', () => {
  for (const files of [
    ['README.md', 'docs/ci.md', 'docs/images/demo.gif'],
    ['tests/pdf-navigation.swift', 'tests/pdf-reader.html', 'tests/pdf-comments.cjs'],
  ]) {
    assert.equal(detect.requiresDesktop(files), false, files.join(', '));
  }
});

test('native, shared and unknown inputs require desktop checks', () => {
  for (const path of ['crates/client/src/client.rs', 'app/src/main.rs', 'app/tauri.conf.json', 'app/Cargo.toml', 'app/build.rs', 'app/icons/icon.png',
    'Cargo.toml', 'Cargo.lock', '.cargo/config.toml', 'rust-toolchain.toml',
    '.github/workflows/ci.yml', 'other.md', 'web-native/config.json', 'tests-native/build.rs']) {
    assert.equal(detect.requiresDesktop(['web/app.js', 'tests/reader.html', 'docs/ci.md', path]), true, path);
  }
});

test('an empty comparison conservatively runs desktop checks', () => {
  assert.equal(detect.requiresDesktop([]), true);
});

function logger() {
  const output = {}, warnings = [];
  return { output, warnings, core: {
    setOutput: (key, value) => { output[key] = value; },
    warning: value => warnings.push(value), info: () => {},
  } };
}

test('main pushes and manual runs always require desktop checks', async () => {
  for (const eventName of ['push', 'workflow_dispatch']) {
    const log = logger();
    assert.equal(await detect({ context: { eventName }, core: log.core }), true);
    assert.equal(log.output.run_desktop, 'true');
    assert.equal(log.output.run_paper, 'true');
  }
});

test('missing PR comparison data does not skip checks', async () => {
  const log = logger();
  assert.equal(await detect({ context: { eventName: 'pull_request', payload: {} }, core: log.core }), true);
  assert.equal(log.output.run_desktop, 'true');
  assert.equal(log.output.run_paper, 'true');
  assert.equal(log.warnings.length, 1);
});

test('Git comparisons distinguish documentation additions from source-to-documentation renames', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'noctua-changes-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'src', 'feature.rs'), 'fn main() {}\n');
  git('add', '.');
  const commit = message => git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid',
    'commit', '--quiet', '-m', message);
  commit('Initial source');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'docs', 'guide.md'), '# Guide\n');
  git('add', '.');
  commit('Add documentation');
  const docsHead = git('rev-parse', 'HEAD');
  assert.equal(detect.requiresDesktop(detect.changedFiles(base, docsHead, cwd)), false);
  git('mv', 'src/feature.rs', 'docs/feature.md');
  commit('Move source to documentation');
  const files = detect.changedFiles(docsHead, git('rev-parse', 'HEAD'), cwd);
  assert.deepEqual(files.sort(), ['docs/feature.md', 'src/feature.rs']);
  assert.equal(detect.requiresDesktop(files), false);
  assert.equal(detect.requiresPaper(files), true);
});

test('paper-only test changes reach the real compiler suite without native UI checks', () => {
  for (const path of ['tests/paper-integration.py', 'tests/paper_fixture.py',
    'tests/test_paper_synctex.py', 'tests/test_paper_fixture.py', 'tests/server-detach.py',
    'src/paper.rs', 'src/workspace.rs', 'src/prompts/notes.md', 'build.rs',
    'scripts/setup-tectonic.py', 'scripts/setup-pdflatex.py', 'third-party/texlive/README.md']) {
    assert.equal(detect.requiresPaper([path]), true, path);
    assert.equal(detect.requiresDesktop([path]), false, path);
  }
});

test('native window/menu changes do not schedule real paper compilation', () => {
  for (const path of ['app/src/main.rs', 'app/src/icons.rs', 'app/build.rs', 'app/Cargo.toml']) {
    assert.equal(detect.requiresDesktop([path]), true, path);
    assert.equal(detect.requiresPaper([path]), false, path);
  }
});

test('shared lifecycle, dependencies and CI changes schedule both native suites', () => {
  for (const path of ['crates/client/src/server_resources.rs', 'Cargo.toml', 'Cargo.lock',
    '.github/workflows/ci.yml', '.github/scripts/desktop-changes.cjs', 'unknown-input']) {
    assert.equal(detect.requiresDesktop([path]), true, path);
    assert.equal(detect.requiresPaper([path]), true, path);
  }
});

test('frontend-only changes leave real compiler checks off; fixture image changes run them', () => {
  for (const path of ['web/paper.js', 'tests/paper-source.html', 'tests/reader.swift', 'docs/ci.md']) {
    assert.equal(detect.requiresPaper([path]), false, path);
  }
  assert.equal(detect.requiresPaper(['app/icons/32x32.png']), true);
  assert.equal(detect.requiresPaper([]), true);
});

test('a paper-test-only Git change schedules paper integration', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'noctua-paper-routing-'));
  t.after(() => rmSync(cwd, {recursive:true,force:true}));
  const git = (...args) => execFileSync('git', args, {cwd,encoding:'utf8'}).trim();
  git('init', '--quiet');
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'tests', 'paper-integration.py'), '# fixture v1\n');
  git('add', '.');
  const commit = message => git('-c','user.name=CI test','-c','user.email=ci@example.invalid','commit','--quiet','-m',message);
  commit('Initial fixture');
  const base = git('rev-parse','HEAD');
  writeFileSync(join(cwd, 'tests', 'paper-integration.py'), '# fixture v2\n');
  git('add','.');commit('Change only the paper test');
  const files = detect.changedFiles(base,git('rev-parse','HEAD'),cwd);
  assert.equal(detect.requiresPaper(files),true);
  assert.equal(detect.requiresDesktop(files),false);
});

test('UI changes compile Desktop without building the server or real compilers', () => {
  const files = ['web/app.js', 'web/index.html', 'web/vendor/pdfjs/build/pdf.mjs'];
  assert.equal(detect.requiresDesktop(files), true);
  assert.equal(detect.requiresBackend(files), false);
  assert.equal(detect.requiresPaper(files), false);
});
test('native-only changes skip backend compilation; server and shared changes require it', () => {
  assert.equal(detect.requiresBackend(['app/src/main.rs']), false);
  for (const file of ['src/lib.rs', 'crates/client/src/frontend.rs', 'Cargo.lock', 'tests/server-update.py']) {
    assert.equal(detect.requiresBackend([file]), true, file);
  }
});

test('main UI pushes also skip backend compilation using the actual before/after diff', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'noctua-main-ui-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet'); mkdirSync(join(cwd, 'web'));
  writeFileSync(join(cwd, 'web/app.js'), 'old UI'); git('add', '.');
  const commit = () => git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', 'commit', '--quiet', '-m', 'UI');
  commit(); const before = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'web/app.js'), 'new UI'); git('add', '.'); commit();
  const after = git('rev-parse', 'HEAD'), log = logger();
  await detect({ context: { eventName: 'push', payload: { before, after } }, core: log.core, cwd });
  assert.equal(log.output.run_backend, 'false');
  assert.equal(log.output.run_desktop, 'true');
  assert.equal(log.output.run_paper, 'false');
});

test('a Desktop-only release version change leaves the server graph untouched', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'noctua-versions-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const manifest = version => `[package]\nname = "noctua"\nversion = "0.3.6"\n[workspace]\nmembers = ["app"]\n[workspace.package]\nversion = "${version}"\n`;
  const lock = version => `version = 4\n[[package]]\nname = "noctua"\nversion = "0.3.6"\n[[package]]\nname = "noctua-app"\nversion = "${version}"\n`;
  const commit = () => { git('add', '.'); git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', 'commit', '--quiet', '-m', 'Version'); return git('rev-parse', 'HEAD'); };
  writeFileSync(join(cwd, 'Cargo.toml'), manifest('0.3.6')); writeFileSync(join(cwd, 'Cargo.lock'), lock('0.3.6')); const before = commit();
  writeFileSync(join(cwd, 'Cargo.toml'), manifest('0.3.7')); writeFileSync(join(cwd, 'Cargo.lock'), lock('0.3.7')); const after = commit();
  const log = logger();
  await detect({ context: { eventName: 'push', payload: { before, after } }, core: log.core, cwd });
  assert.equal(log.output.run_backend, 'false'); assert.equal(log.output.run_desktop, 'true'); assert.equal(log.output.run_paper, 'false');
  writeFileSync(join(cwd, 'Cargo.toml'), manifest('0.3.7').replace('version = "0.3.6"', 'version = "0.3.7"'));
  const server = commit(), changed = detect.componentFiles(['Cargo.toml'], after, server, cwd, false);
  assert.equal(detect.requiresBackend(changed), true);
  assert.equal(detect.requiresPaper(changed), true);
});
