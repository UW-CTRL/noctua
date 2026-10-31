const assert = require('node:assert/strict');
const { test } = require('node:test');
const manifest = require('./updater-manifest.cjs');

function fixture() {
  const names = ['Noctua_0.1.2_x64-setup.exe', 'Noctua_0.1.2_amd64.AppImage', 'Noctua_aarch64.app.tar.gz'];
  const assets = names.flatMap(name => [name, `${name}.sig`]).map((name, id) => ({
    id, name, size: 100, state: 'uploaded', browser_download_url: `https://github.com/UW-CTRL/noctua/releases/download/untagged-draft/${name}`,
  }));
  const calls = [];
  const repos = {
    getReleaseAsset: async p => { calls.push(['get', p.asset_id]); return { data: Buffer.from('c2lnbmF0dXJl\n') }; },
    deleteReleaseAsset: async p => { calls.push(['delete', p.asset_id]); },
    uploadReleaseAsset: async p => { calls.push(['upload', JSON.parse(p.data)]); },
    listReleases: () => {},
  };
  const args = { github: { rest: { repos }, paginate: async () => [] }, context: { repo: { owner: 'UW-CTRL', repo: 'noctua' } },
    release: { id: 42, tag_name: 'v0.1.2', body: 'Release notes' }, assets };
  return { args, assets, calls, repos };
}

test('one complete manifest offers signed macOS, Windows and AppImage updates', async () => {
  const f = fixture();
  await manifest(f.args);
  const uploaded = f.calls.at(-1)[1];
  assert.equal(uploaded.version, '0.1.2');
  assert.equal(uploaded.notes, 'Release notes');
  assert.deepEqual(uploaded.release_summaries, [{ version: '0.1.2', changes: [] }]);
  assert.deepEqual(Object.keys(uploaded.platforms), ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64']);
  assert.equal(uploaded.platforms['darwin-x86_64'], undefined);
  const base = 'https://github.com/UW-CTRL/noctua/releases/download/v0.1.2/';
  assert.equal(uploaded.platforms['darwin-aarch64'].url, base + 'Noctua_aarch64.app.tar.gz');
  assert.equal(uploaded.platforms['darwin-aarch64'].signature, 'c2lnbmF0dXJl');
  assert.equal(uploaded.platforms['windows-x86_64'].url, base + 'Noctua_0.1.2_x64-setup.exe');
  assert.equal(uploaded.platforms['linux-x86_64'].url, base + 'Noctua_0.1.2_amd64.AppImage');
  assert(!JSON.stringify(uploaded.platforms).includes('untagged-'));
  assert.equal(uploaded.platforms['linux-x86_64'].signature, 'c2lnbmF0dXJl');
  assert.equal(f.calls.filter(c => c[0] === 'get').length, 3);
});

test('release history summaries include older stable releases and fail closed on API errors', async () => {
  const f = fixture();
  f.args.github.paginate = async () => [{ tag_name: 'v0.1.1', body: '### Bug Fixes\n* Fix startup' }];
  await manifest(f.args);
  assert.deepEqual(f.calls.at(-1)[1].release_summaries[1], { version: '0.1.1', changes: [{ kind: 'fixes', items: ['Fix startup'] }] });
  const failure = fixture();
  failure.args.github.paginate = async () => { throw new Error('History unavailable'); };
  await assert.rejects(manifest(failure.args), /History unavailable/);
  assert(!failure.calls.some(c => ['delete', 'upload'].includes(c[0])));
});

test('desktop manifests retain the independently versioned bundled server', async () => {
  const previous = process.env.NOCTUA_RELEASE_SERVER_VERSION;
  try {
    process.env.NOCTUA_RELEASE_SERVER_VERSION = '0.9.0';
    const f = fixture();
    await manifest(f.args);
    assert.equal(f.calls.at(-1)[1].version, '0.1.2');
    assert.equal(f.calls.at(-1)[1].server_version, '0.9.0');
  } finally {
    if (previous === undefined) delete process.env.NOCTUA_RELEASE_SERVER_VERSION;
    else process.env.NOCTUA_RELEASE_SERVER_VERSION = previous;
  }
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

test('Universal archives serve both Mac architectures with one verified signature', async () => {
  const f = fixture();
  for (const asset of f.assets) asset.name = asset.name.replace('aarch64.app', 'universal.app');
  await manifest({ ...f.args, macosArch: 'universal' });
  const platforms = f.calls.at(-1)[1].platforms;
  assert.deepEqual(platforms['darwin-aarch64'], platforms['darwin-x86_64']);
  assert(platforms['darwin-x86_64'].url.endsWith('Noctua_universal.app.tar.gz'));
  assert.equal(f.calls.filter(c => c[0] === 'get').length, 3);
});
