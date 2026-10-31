const { test } = require('node:test');
const assert = require('node:assert/strict');
const check = require('./check-release-ci.cjs');
const sha = 'a'.repeat(40);
const good = { id: 10, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
function fixture(runs) {
  const queries = [];
  const github = {
    rest: { repos: { getCommit: async ({ ref }) => { assert.equal(ref, 'refs/tags/v1.2.3'); return { data: { sha } }; } }, actions: { listWorkflowRuns() {} } },
    paginate: async (_, args) => { queries.push(args); return runs[args.workflow_id] || []; },
  };
  return { github, context: { repo: { owner: 'owner', repo: 'repo' } }, tag: 'v1.2.3', queries };
}
test('requires both workflows for the exact main push commit', async () => {
  const input = fixture({ 'ci.yml': [good], 'security.yml': [good] });
  assert.equal(await check(input), sha);
  assert.deepEqual(input.queries.map(q => q.workflow_id), ['ci.yml', 'security.yml']);
  assert(input.queries.every(q => q.head_sha === sha && q.event === 'push' && q.branch === 'main'));
});
for (const run of [null, { ...good, conclusion: 'failure' }, { ...good, conclusion: 'cancelled' }, { ...good, status: 'in_progress', conclusion: null }, { ...good, head_sha: 'b'.repeat(40) }, { ...good, event: 'pull_request' }, { ...good, head_branch: 'other' }]) {
  test(`rejects missing or ineligible checks: ${JSON.stringify(run)}`, async () => {
    await assert.rejects(check(fixture({ 'ci.yml': run ? [run] : [], 'security.yml': [good] })), /ci.yml must succeed/);
  });
}
test('an older success cannot hide a newer failed run', async () => {
  await assert.rejects(check(fixture({ 'ci.yml': [good, { ...good, id: 11, conclusion: 'failure' }] })), /ci.yml must succeed/);
});
test('CI success cannot substitute for missing security checks', async () => {
  await assert.rejects(check(fixture({ 'ci.yml': [good] })), /security.yml must succeed/);
});
test('API errors fail closed', async () => {
  const input = fixture({}); input.github.paginate = async () => { throw Error('API unavailable'); };
  await assert.rejects(check(input), /API unavailable/);
});
