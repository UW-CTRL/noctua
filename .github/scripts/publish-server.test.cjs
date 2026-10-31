const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const publish = require('./publish-server.cjs');

function fixture(t, existing) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'noctua-server-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tag = 'server-v0.3.5';
  for (const suffix of ['aarch64-apple-darwin.tar.gz', 'x86_64-unknown-linux-gnu.tar.gz', 'x86_64-pc-windows-msvc.zip']) {
    const name = `noctua-${tag}-${suffix}`;
    const data = Buffer.from(name);
    fs.writeFileSync(join(directory, name), data);
    fs.writeFileSync(join(directory, name + '.sha256'), `${createHash('sha256').update(data).digest('hex')}  ${name}\n`);
    const target = suffix.replace(/\.tar\.gz$|\.zip$/, '');
    const binary = `noctua-${tag}-${target}${target.includes('windows') ? '.exe' : ''}`;
    fs.writeFileSync(join(directory, binary), data);
    const metadata = `server-update-${target}.json`;
    fs.writeFileSync(join(directory, metadata), JSON.stringify({
      version: '0.3.5', target, binary, size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'), api_version: 1, data_version: 1,
      paper_compilers: { tectonic: '0.17.0', texlive: 'TeX Live 2026 / TinyTeX 2026.10' },
    }));
    fs.writeFileSync(join(directory, metadata + '.sig'), Buffer.from('untrusted comment: fixture signature').toString('base64'));
  }
  const calls = [];
  const repos = {};
  for (const method of ['listReleases', 'listReleaseAssets', 'createRelease', 'uploadReleaseAsset', 'deleteReleaseAsset', 'updateRelease']) {
    repos[method] = async params => {
      calls.push({ method, params });
      return { data: { id: 42 } };
    };
  }
  const github = { rest: { repos }, paginate: async method => {
    if (method === repos.listReleases) return existing ? [existing] : [];
    return existing?.assets || [];
  } };
  return { calls, repos, directory, args: { github, context: { repo: { owner: 'UW-CTRL', repo: 'noctua' } }, tag, commit: 'abc123', directory } };
}

test('publishes all platforms and checksums while preserving desktop Latest', async t => {
  const f = fixture(t);
  await publish(f.args);
  const create = f.calls.find(call => call.method === 'createRelease').params;
  assert.equal(create.draft, true);
  assert.equal(create.make_latest, 'false');
  assert.equal(create.tag_name, f.args.tag);
  assert.equal(create.target_commitish, f.args.commit);
  assert.equal(f.calls.filter(call => call.method === 'uploadReleaseAsset').length, 15);
  assert.deepEqual(f.calls.at(-1), { method: 'updateRelease', params: {
    owner: 'UW-CTRL', repo: 'noctua', release_id: 42, draft: false, make_latest: 'false',
  } });
});

test('missing or corrupt artifacts prevent any release mutation', async t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t);
    const name = fs.readdirSync(f.directory).find(name => name.endsWith('.sha256'));
    if (corrupt) fs.writeFileSync(join(f.directory, name), 'incorrect hash');
    else fs.unlinkSync(join(f.directory, name));
    await assert.rejects(publish(f.args));
    assert.deepEqual(f.calls, []);
  }
});

test('published releases cannot be overwritten', async t => {
  const f = fixture(t, { tag_name: 'server-v0.3.5', draft: false });
  await assert.rejects(publish(f.args), /published release/);
  assert.deepEqual(f.calls, []);
});

test('draft retry replaces assets and preserves notes; failed uploads prevent publication', async t => {
  const f = fixture(t, { id: 42, tag_name: 'server-v0.3.5', draft: true, body: 'Keep notes', assets: [
    { id: 7, name: 'noctua-server-v0.3.5-aarch64-apple-darwin.tar.gz' },
  ] });
  await publish(f.args);
  assert.equal(f.calls[0].method, 'deleteReleaseAsset');
  assert.equal(f.calls.some(call => call.method === 'createRelease'), false);
  assert.equal(f.calls.at(-1).params.body, undefined);
  f.calls.length = 0;
  f.repos.uploadReleaseAsset = async () => { throw new Error('Upload failed'); };
  await assert.rejects(publish(f.args), /Upload failed/);
  assert.equal(f.calls.some(call => call.method === 'updateRelease'), false);
});
