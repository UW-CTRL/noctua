const { execFileSync } = require('node:child_process');

const compilerSetup = path => ['scripts/setup-tectonic.py', 'scripts/setup-pdflatex.py'].includes(path);
const documentation = path => path === 'README.md' || path.startsWith('docs/');

function requiresDesktop(files) {
  // The native shell links crates/client, not the research backend in src/.
  const unrelated = path => documentation(path) ||
    ['tests/', 'src/', 'third-party/'].some(prefix => path.startsWith(prefix)) ||
    path === 'build.rs' || compilerSetup(path);
  return files.length === 0 || files.some(path => !unrelated(path));
}

function requiresBackend(files) {
  return files.length === 0 || files.some(path => {
    if (documentation(path) || path.startsWith('web/') || path.startsWith('app/')) return false;
    if (path.startsWith('tests/')) return /^tests\/(server[^/]*\.py|build-update-fixture\.py)$/.test(path);
    return true;
  });
}

function requiresPaper(files) {
  const paperTest = path => path === 'tests/paper-integration.py' ||
    path === 'tests/paper_fixture.py' || path === 'tests/server-detach.py' ||
    /^tests\/test_paper_.*\.py$/.test(path);
  const relevant = path => {
    if (paperTest(path) || path === 'app/icons/32x32.png') return true;
    if (documentation(path) || ['web/', 'app/', 'tests/'].some(prefix => path.startsWith(prefix))) return false;
    // Server/client code, manifests, setup scripts, compiler notices, CI and
    // unknown inputs conservatively exercise the real compilers on every OS.
    return true;
  };
  return files.length === 0 || files.some(relevant);
}

function changedFiles(base, head, cwd, mergeBase = true) {
  if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha || ''))) {
    throw new Error('Missing or invalid pull request commit SHA');
  }
  // Disable rename detection so a move out of source retains its deleted path.
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}${mergeBase ? "..." : ".."}${head}`], {
    cwd, encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

// Cargo files are shared, but changing only Desktop's package version does
// not change the server graph. Every other byte must match to skip its build.
function componentFiles(files, base, head, cwd, mergeBase) {
  if (!files.some(path => path === 'Cargo.toml' || path === 'Cargo.lock')) return files;
  if (mergeBase) base = execFileSync('git', ['merge-base', base, head], { cwd, encoding: 'utf8' }).trim();
  const normalized = (path, sha) => {
    const text = execFileSync('git', ['show', `${sha}:${path}`], { cwd, encoding: 'utf8' });
    const pattern = path === 'Cargo.toml'
      ? /(\[workspace\.package\]\s*\nversion\s*=\s*)"[0-9]+\.[0-9]+\.[0-9]+"/
      : /(\[\[package\]\]\s*\nname = "noctua-app"\s*\nversion = )"[0-9]+\.[0-9]+\.[0-9]+"/;
    if (!pattern.test(text)) return null;
    if (path === 'Cargo.toml' && !/^version = "[0-9]+\.[0-9]+\.[0-9]+"/m.test(text.split('[workspace]')[0])) return null;
    return text.replace(pattern, '$1"DESKTOP_VERSION"');
  };
  return files.map(path => {
    if (path !== 'Cargo.toml' && path !== 'Cargo.lock') return path;
    const old = normalized(path, base), next = normalized(path, head);
    return old !== null && next !== null && old === next ? 'app/Cargo.toml' : path;
  });
}

module.exports = async function detect({ context, core, cwd }) {
  let desktop = true, paper = true, backend = true;
  if (context.eventName === 'pull_request' || context.eventName === 'push') {
    try {
      const pr = context.payload?.pull_request;
      const files = context.eventName === 'pull_request'
        ? changedFiles(pr?.base?.sha, pr?.head?.sha, cwd)
        : changedFiles(context.payload?.before, context.payload?.after || context.sha, cwd, false);
      const inputs = componentFiles(files,
        context.eventName === 'pull_request' ? pr.base.sha : context.payload.before,
        context.eventName === 'pull_request' ? pr.head.sha : (context.payload.after || context.sha),
        cwd, context.eventName === 'pull_request');
      desktop = requiresDesktop(inputs);
      paper = requiresPaper(inputs);
      backend = requiresBackend(inputs);
    } catch (error) {
      core.warning(`Change detection failed; running all checks: ${error.message}`);
    }
  }
  core.setOutput('run_backend', String(backend));
  core.setOutput('run_desktop', String(desktop));
  core.setOutput('run_paper', String(paper));
  core.info(`Native desktop checks: ${desktop ? 'required' : 'skipped'}; real paper checks: ${paper ? 'required' : 'skipped'}.`);
  return desktop;
};
module.exports.requiresDesktop = requiresDesktop;
module.exports.changedFiles = changedFiles;
module.exports.requiresPaper = requiresPaper;

module.exports.requiresBackend = requiresBackend;

module.exports.componentFiles = componentFiles;
