const { execFileSync } = require('node:child_process');

const compilerSetup = path => ['scripts/setup-tectonic.py', 'scripts/setup-pdflatex.py'].includes(path);
const documentation = path => path === 'README.md' || path.startsWith('docs/');

function requiresDesktop(files) {
  // The native shell links crates/client, not the research backend in src/.
  const unrelated = path => documentation(path) ||
    ['web/', 'tests/', 'src/', 'third-party/'].some(prefix => path.startsWith(prefix)) ||
    path === 'build.rs' || compilerSetup(path);
  return files.length === 0 || files.some(path => !unrelated(path));
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

function changedFiles(base, head, cwd) {
  if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha || ''))) {
    throw new Error('Missing or invalid pull request commit SHA');
  }
  // Disable rename detection so a move out of source retains its deleted path.
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`], {
    cwd, encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

module.exports = async function detect({ context, core }) {
  let desktop = true, paper = true;
  if (context.eventName === 'pull_request') {
    try {
      const pr = context.payload.pull_request;
      const files = changedFiles(pr?.base?.sha, pr?.head?.sha);
      desktop = requiresDesktop(files);
      paper = requiresPaper(files);
    } catch (error) {
      core.warning(`Change detection failed; running desktop and paper checks: ${error.message}`);
    }
  }
  core.setOutput('run_desktop', String(desktop));
  core.setOutput('run_paper', String(paper));
  core.info(`Native desktop checks: ${desktop ? 'required' : 'skipped'}; real paper checks: ${paper ? 'required' : 'skipped'}.`);
  return desktop;
};
module.exports.requiresDesktop = requiresDesktop;
module.exports.changedFiles = changedFiles;
module.exports.requiresPaper = requiresPaper;
