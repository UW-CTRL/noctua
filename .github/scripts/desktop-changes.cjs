const { execFileSync } = require('node:child_process');

function requiresDesktop(files) {
  // Unknown paths, including runtime Markdown in src/prompts/, require checks.
  return files.length === 0 || files.some(path => path !== 'README.md' && !path.startsWith('docs/'));
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
  let run = true;
  if (context.eventName === 'pull_request') {
    try {
      const pr = context.payload.pull_request;
      run = requiresDesktop(changedFiles(pr?.base?.sha, pr?.head?.sha));
    } catch (error) {
      core.warning(`Change detection failed; running desktop checks: ${error.message}`);
    }
  }
  core.setOutput('run_desktop', String(run));
  core.info(run ? 'Desktop checks required.' : 'Documentation-only PR: skipping desktop checks.');
  return run;
};
module.exports.requiresDesktop = requiresDesktop;
module.exports.changedFiles = changedFiles;
