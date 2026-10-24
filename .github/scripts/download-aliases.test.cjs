const assert = require('node:assert/strict');
const { test } = require('node:test');
const upload = require('./download-aliases.cjs');

function fixture() {
  const names = ['Noctua_0.2.1_universal.dmg', 'Noctua_0.2.1_x64-setup.exe', 'Noctua_0.2.1_amd64.AppImage'];
  const assets = names.map((name, id) => ({ name, id, state: 'uploaded', size: 3 }));
  const calls = [];
  const repos = {
    getReleaseAsset: async params => { calls.push(['download', params.asset_id]); return { data: Buffer.from([0, 128, 255]) }; },
    deleteReleaseAsset: async params => { calls.push(['delete', params.asset_id]); },
    uploadReleaseAsset: async params => { calls.push(['upload', params]); },
  };
  return { calls, repos, args: { github: { rest: { repos } }, context: { repo: { owner: 'UW-CTRL', repo: 'noctua' } }, release: { tag_name: 'v0.2.1', id: 42 }, assets } };
}

test('uploads byte-identical installers under the names used by README buttons', async () => {
  const f = fixture();
  await upload(f.args);
  const uploads = f.calls.filter(([action]) => action === 'upload').map(([, params]) => params);
  assert.deepEqual(uploads.map(p => p.name), ['Noctua-macOS-universal.dmg', 'Noctua-Windows-x64-setup.exe', 'Noctua-Linux-amd64.AppImage']);
  for (const p of uploads) {
    assert.deepEqual(p.data, Buffer.from([0, 128, 255]));
    assert.equal(p.release_id, 42);
    assert.equal(p.headers['content-length'], 3);
    assert.ok(require('node:fs').readFileSync('README.md', 'utf8').includes(`/releases/latest/download/${p.name}`));
  }
});

test('validates every source before making API calls', async () => {
  for (const invalid of ['missing', 'empty', 'uploading']) {
    const f = fixture();
    if (invalid === 'missing') f.args.assets.pop();
    else if (invalid === 'empty') f.args.assets[2].size = 0;
    else f.args.assets[2].state = 'starter';
    await assert.rejects(upload(f.args), /Missing completed download source/);
    assert.deepEqual(f.calls, []);
  }
});

test('a truncated download cannot replace an existing alias', async () => {
  const f = fixture();
  f.args.assets.push({ name: 'Noctua-macOS-universal.dmg', id: 99 });
  f.repos.getReleaseAsset = async () => ({ data: Buffer.alloc(2) });
  await assert.rejects(upload(f.args), /Incomplete download/);
  assert.deepEqual(f.calls, []);
});

test('retries replace aliases without deleting versioned installers', async () => {
  const f = fixture();
  f.args.assets.push({ name: 'Noctua-macOS-universal.dmg', id: 99 });
  await upload(f.args);
  assert.deepEqual(f.calls.filter(([action]) => action === 'delete'), [['delete', 99]]);
  assert.equal(f.calls[1][0], 'delete');
  assert.equal(f.calls[2][0], 'upload');
});

test('download and upload errors stop alias creation', async () => {
  for (const method of ['getReleaseAsset', 'uploadReleaseAsset']) {
    const f = fixture();
    f.repos[method] = async () => { throw new Error('API unavailable'); };
    await assert.rejects(upload(f.args), /API unavailable/);
  }
});
