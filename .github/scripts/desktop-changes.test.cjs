const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const detect = require('./desktop-changes.cjs');

test('documentation and media under the explicit allowlist skip desktop checks', () => {
  assert.equal(detect.requiresDesktop(['README.md', 'docs/ci.md', 'docs/images/demo.gif']), false);
});

test('runtime Markdown, unknown files, and mixed PRs require desktop checks', () => {
  for (const path of ['src/prompts/notes.md', 'src/prompts/chat-formatting.md', 'web/app.js',
    'app/tauri.conf.json', 'Cargo.lock', '.github/workflows/ci.yml', 'other.md']) {
    assert.equal(detect.requiresDesktop(['docs/ci.md', path]), true, path);
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
  }
});

test('missing PR comparison data does not skip checks', async () => {
  const log = logger();
  assert.equal(await detect({ context: { eventName: 'pull_request', payload: {} }, core: log.core }), true);
  assert.equal(log.output.run_desktop, 'true');
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
  assert.equal(detect.requiresDesktop(files), true);
});
