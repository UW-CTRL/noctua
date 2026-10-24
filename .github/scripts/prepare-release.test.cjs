const assert = require('node:assert/strict');
const { test } = require('node:test');
const prepare = require('./prepare-release.cjs');

function fixture(releases = []) {
  const calls = [];
  const outputs = {};
  const repos = {
    listReleases: () => {},
    generateReleaseNotes: async params => {
      calls.push(['generate', params]);
      return { data: { body: '## New Features\n* A feature in #1\n\nFull Changelog: v0.0.3...v0.1.0' } };
    },
    createRelease: async params => {
      calls.push(['create', params]);
      return { data: { ...params, id: 42, html_url: 'https://example.com/draft' } };
    },
    updateRelease: async params => {
      calls.push(['update', params]);
      return { data: { ...params, id: params.release_id, html_url: 'https://example.com/draft' } };
    },
  };
  return {
    calls, outputs,
    args: {
      github: { rest: { repos }, paginate: async () => releases },
      context: { repo: { owner: 'UW-CTRL', repo: 'noctua' } },
      core: { setOutput: (key, value) => { outputs[key] = value; }, info: () => {} },
      tag: 'v0.1.0',
    },
  };
}

test('creates exactly one draft with generated notes and returns its ID', async () => {
  const f = fixture();
  await prepare(f.args);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['generate', 'create']);
  const params = f.calls[1][1];
  assert.equal(params.draft, true);
  assert.equal(params.tag_name, 'v0.1.0');
  assert.match(params.body, /Full Changelog/);
  assert.match(params.body, /noctua:generated-release-notes/);
  assert.equal(f.outputs.release_id, '42');
});

test('supplements a prewritten draft without removing Markdown media or title', async () => {
  const body = '## Highlights\n![Demo](https://example.com/demo.gif)';
  const f = fixture([{ id: 7, tag_name: 'v0.1.0', draft: true, body }]);
  await prepare(f.args);
  const params = f.calls[1][1];
  assert.equal(f.calls[1][0], 'update');
  assert.ok(params.body.startsWith(body + '\n\n'));
  assert.match(params.body, /New Features/);
  assert.equal(params.name, undefined);
  assert.equal(params.draft, undefined);
  assert.equal(f.outputs.release_id, '7');
});

test('reruns preserve all edited notes and make no release mutations', async () => {
  const f = fixture([{
    id: 7, tag_name: 'v0.1.0', draft: true,
    body: 'Manual edits\n<!-- noctua:generated-release-notes -->\nEdited generated notes',
  }]);
  await prepare(f.args);
  assert.deepEqual(f.calls, []);
  assert.equal(f.outputs.release_id, '7');
});

test('refuses published releases before generating notes or allowing uploads', async () => {
  const f = fixture([{ id: 7, tag_name: 'v0.1.0', draft: false }]);
  await assert.rejects(prepare(f.args), /already published/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.outputs, {});
});

test('does not modify a different release', async () => {
  const f = fixture([{ id: 9, tag_name: 'v0.0.3', draft: true, body: 'Keep me' }]);
  await prepare(f.args);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['generate', 'create']);
});

test('a note-generation failure does not create a partial release', async () => {
  const f = fixture();
  f.args.github.rest.repos.generateReleaseNotes = async () => { throw new Error('API failure'); };
  await assert.rejects(prepare(f.args), /API failure/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.outputs, {});
});
