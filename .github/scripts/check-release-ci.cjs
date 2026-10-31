// Only main push checks for the exact tagged commit can authorize a release.
module.exports = async function checkReleaseCI({ github, context, tag }) {
  if (!/^(?:server-)?v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid release tag');
  const repo = context.repo;
  const { data: commit } = await github.rest.repos.getCommit({ ...repo, ref: `refs/tags/${tag}` });
  for (const workflow_id of ['ci.yml', 'security.yml']) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...repo, workflow_id, branch: 'main', event: 'push', head_sha: commit.sha, per_page: 100,
    });
    const latest = runs.filter(run => run.head_sha === commit.sha && run.head_branch === 'main' && run.event === 'push')
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
      throw new Error(`${workflow_id} must succeed on main at ${commit.sha}; ${latest ? `${latest.status}/${latest.conclusion || 'pending'} (${latest.html_url})` : 'no matching run'}`);
    }
  }
  return commit.sha;
};
