const assert = require('node:assert/strict');
const { test } = require('node:test');
const manifest = require('./updater-manifest.cjs');

function fixture() {
  const names = ['Noctua_universal.app.tar.gz', 'Noctua_0.1.2_x64-setup.exe', 'Noctua_0.1.2_amd64.AppImage'];
  const assets = names.flatMap(name => [name, `${name}.sig`]).map((name, id) => ({
    id, name, size: 100, state: 'uploaded', browser_download_url: `https://example.com/${name}`,
  }));
  const calls = [];
  const repos = {
    getReleaseAsset: async p => { calls.push(['get', p.asset_id]); return { data: Buffer.from('c2lnbmF0dXJl\n') }; },
    deleteReleaseAsset: async p => { calls.push(['delete', p.asset_id]); },
    uploadReleaseAsset: async p => { calls.push(['upload', JSON.parse(p.data)]); },
  };
  const args = { github: { rest: { repos } }, context: { repo: { owner: 'UW-CTRL', repo: 'noctua' } },
    release: { id: 42, tag_name: 'v0.1.2', body: 'Release notes' }, assets };
  return { args, assets, calls, repos };
}

test('one complete manifest maps both Mac architectures to the signed Universal bundle', async () => {
  const f = fixture();
  await manifest(f.args);
  const uploaded = f.calls.at(-1)[1];
  assert.equal(uploaded.version, '0.1.2');
  assert.equal(uploaded.notes, 'Release notes');
  assert.deepEqual(Object.keys(uploaded.platforms), ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64']);
  assert.deepEqual(uploaded.platforms['darwin-aarch64'], uploaded.platforms['darwin-x86_64']);
  assert.equal(uploaded.platforms['windows-x86_64'].url, 'https://example.com/Noctua_0.1.2_x64-setup.exe');
  assert.equal(uploaded.platforms['linux-x86_64'].signature, 'c2lnbmF0dXJl');
  assert.equal(f.calls.filter(c => c[0] === 'get').length, 3);
});

test('each missing, empty, or incomplete bundle or signature prevents manifest writes', async () => {
  for (let i = 0; i < 6; i++) {
    for (const failure of ['missing', 'empty', 'incomplete']) {
      const f = fixture();
      if (failure === 'missing') f.assets.splice(i, 1);
      else if (failure === 'empty') f.assets[i].size = 0;
      else f.assets[i].state = 'starter';
      await assert.rejects(manifest(f.args), /Missing completed updater asset/);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('signature download failures and invalid content never replace the manifest', async () => {
  for (const data of ['', '<html>error</html>', { error: 'Not found' }, null]) {
    const f = fixture();
    f.repos.getReleaseAsset = async () => {
      if (data === null) throw new Error('Network unavailable');
      return { data };
    };
    await assert.rejects(manifest(f.args));
    assert.deepEqual(f.calls, []);
  }
});

test('a retry replaces an existing draft manifest only after downloading all signatures', async () => {
  const f = fixture();
  f.assets.push({ id: 88, name: 'latest.json' });
  await manifest(f.args);
  assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ['delete', 'upload']);
  assert.equal(f.calls.at(-2)[1], 88);
});
