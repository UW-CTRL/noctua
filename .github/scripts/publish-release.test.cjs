const assert = require('node:assert/strict');
const { test } = require('node:test');
const publish = require('./publish-release.cjs');

function fixture() {
  const names = [
    'Noctua_0.1.1_aarch64.dmg',
    'Noctua_0.1.1_x64-setup.exe',
    'Noctua_0.1.1_amd64.AppImage', 'Noctua_0.1.1_amd64.deb',
  ];
  const release = { tag_name: 'v0.1.1', draft: true, name: 'Edited title', body: '![Demo](https://example.com/demo.gif)', prerelease: false };
  const assets = names.map((name, id) => ({ id, name, state: 'uploaded', size: 123 }));
  const calls = [];
  const repos = {
    getRelease: async () => ({ data: release }),
    listReleaseAssets: () => {},
    getReleaseAsset: async () => ({ data: Buffer.alloc(123) }),
    uploadReleaseAsset: async () => {},
    updateRelease: async params => { calls.push(params); return { data: { html_url: 'https://example.com/release' } }; },
  };
  return {
    release, assets, calls,
    args: {
      github: { rest: { repos }, paginate: async () => assets },
      context: { repo: { owner: 'UW-CTRL', repo: 'noctua' } },
      core: { info() {} }, tag: 'v0.1.1', releaseId: '42',
    },
  };
}

test('publishes complete installers without changing release notes, title, or prerelease status', async () => {
  const f = fixture();
  await publish(f.args);
  assert.deepEqual(f.calls, [{ owner: 'UW-CTRL', repo: 'noctua', release_id: 42, draft: false, make_latest: 'legacy' }]);
});

test('each missing, empty, or incomplete installer keeps the release unpublished', async () => {
  for (let index = 0; index < 4; index++) {
    for (const state of ['missing', 'empty', 'uploading']) {
      const f = fixture();
      if (state === 'missing') f.assets.splice(index, 1);
      else if (state === 'empty') f.assets[index].size = 0;
      else f.assets[index].state = 'starter';
      await assert.rejects(publish(f.args), /missing completed installers/);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('assets for another version cannot satisfy required installers', async () => {
  const f = fixture();
  f.assets[0].name = 'Noctua_0.1.0_aarch64.dmg';
  await assert.rejects(publish(f.args), /Noctua_0.1.1_aarch64.dmg/);
  assert.deepEqual(f.calls, []);
});

test('Universal installers cannot satisfy a new Apple Silicon release', async () => {
  const f = fixture();
  for (const asset of f.assets) asset.name = asset.name.replace('_aarch64', '_universal');
  await assert.rejects(publish(f.args), /Noctua_0.1.1_aarch64.dmg/);
  assert.deepEqual(f.calls, []);
});

test('an explicit legacy Universal rebuild preserves its DMG alias without macOS updater targets', async () => {
  const f = fixture();
  f.release.id = 42;
  for (const asset of f.assets) asset.name = asset.name.replace('_aarch64', '_universal');
  for (const name of ['Noctua_0.1.1_x64-setup.exe', 'Noctua_0.1.1_amd64.AppImage']) {
    f.assets.push({ name: `${name}.sig`, id: 99, size: 12, state: 'uploaded' });
  }
  const repos = f.args.github.rest.repos;
  repos.listReleases = () => {};
  f.args.github.paginate = async method => method === repos.listReleases ? [] : f.assets;
  repos.getReleaseAsset = async p => ({ data: p.asset_id === 99 ? 'c2lnbmF0dXJl' : Buffer.alloc(123) });
  const uploads = [];
  repos.uploadReleaseAsset = async p => uploads.push(p);
  await publish({ ...f.args, macosArch: 'universal', updaterEnabled: true });
  const platforms = JSON.parse(uploads[0].data).platforms;
  assert.equal(platforms['darwin-aarch64'], undefined);
  assert.equal(platforms['darwin-x86_64'], undefined);
  assert.equal(uploads[1].name, 'Noctua-macOS-universal.dmg');
  assert.equal(f.calls.length, 1);
});

test('an unsupported macOS architecture fails before accessing GitHub', async () => {
  const f = fixture();
  f.args.github.rest.repos.getRelease = async () => { throw new Error('Unexpected GitHub call'); };
  await assert.rejects(publish({ ...f.args, macosArch: 'x86_64' }), /Unsupported macOS/);
});

test('a release for another tag is never published', async () => {
  const f = fixture();
  f.release.tag_name = 'v0.1.0';
  await assert.rejects(publish(f.args), /belongs to/);
  assert.deepEqual(f.calls, []);
});

test('retrying publication makes no changes to an already published release', async () => {
  const f = fixture();
  f.release.draft = false;
  await publish(f.args);
  assert.deepEqual(f.calls, []);
});

test('API failures do not attempt publication', async () => {
  for (const method of ['getRelease', 'paginate']) {
    const f = fixture();
    if (method === 'paginate') f.args.github.paginate = async () => { throw new Error('API unavailable'); };
    else f.args.github.rest.repos.getRelease = async () => { throw new Error('API unavailable'); };
    await assert.rejects(publish(f.args), /API unavailable/);
    assert.deepEqual(f.calls, []);
  }
});

test('invalid tags and release IDs fail before accessing GitHub', async () => {
  const f = fixture();
  f.args.github.rest.repos.getRelease = async () => { throw new Error('Unexpected GitHub call'); };
  for (const tag of ['main', 'v0.1.1-beta']) await assert.rejects(publish({ ...f.args, tag }), /required/);
  for (const releaseId of ['', '0', 'not-an-id']) await assert.rejects(publish({ ...f.args, releaseId }), /required/);
});

test('a publication API failure fails the job instead of reporting success', async () => {
  const f = fixture();
  f.args.github.rest.repos.updateRelease = async () => { throw new Error('Publication denied'); };
  await assert.rejects(publish(f.args), /Publication denied/);
});

test('download alias failures keep the release unpublished', async () => {
  for (const method of ['getReleaseAsset', 'uploadReleaseAsset']) {
    const f = fixture();
    f.args.github.rest.repos[method] = async () => { throw new Error('Alias transfer failed'); };
    await assert.rejects(publish(f.args), /Alias transfer failed/);
    assert.deepEqual(f.calls, []);
  }
});

test('updater-enabled releases stay in draft when signatures are missing', async () => {
  const f = fixture();
  await assert.rejects(publish({ ...f.args, updaterEnabled: true }), /Missing completed updater asset/);
  assert.deepEqual(f.calls, []);
});

test('updater manifest upload must succeed before an enabled release is published', async () => {
  for (const failUpload of [false, true]) {
    const f = fixture();
    f.release.id = 42;
    for (const name of ['Noctua_0.1.1_x64-setup.exe', 'Noctua_0.1.1_amd64.AppImage']) {
      f.assets.push({ name: `${name}.sig`, size: 10, state: 'uploaded', id: 10 });
    }
    const repos = f.args.github.rest.repos;
    repos.listReleases = () => {};
    f.args.github.paginate = async method => method === repos.listReleases ? [] : f.assets;
    repos.getReleaseAsset = async params => ({ data: params.asset_id === 10 ? 'c2lnbmF0dXJl' : Buffer.alloc(123) });
    let uploaded = false;
    repos.uploadReleaseAsset = async params => {
      assert.equal(params.release_id, 42);
      assert.deepEqual(f.calls, []);
      if (failUpload) throw new Error('Upload unavailable');
      uploaded = true;
    };
    if (failUpload) {
      await assert.rejects(publish({ ...f.args, updaterEnabled: true }), /Upload unavailable/);
      assert.deepEqual(f.calls, []);
    } else {
      await publish({ ...f.args, updaterEnabled: true });
      assert.equal(uploaded, true);
      assert.equal(f.calls.length, 1);
    }
  }
});

test('obsolete installers and macOS updater archives block publication on retries', async () => {
  for (const name of ['old.msi', 'old.rpm', 'Noctua_aarch64.app.tar.gz', 'Noctua_aarch64.app.tar.gz.sig']) {
    const f = fixture();
    f.assets.push({ name });
    await assert.rejects(publish(f.args), /Remove excluded release assets/);
    assert.deepEqual(f.calls, []);
  }
});
