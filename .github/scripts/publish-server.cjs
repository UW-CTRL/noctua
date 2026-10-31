// Publish only complete standalone server releases; preserve the desktop Latest slot.
module.exports = async function publishServer({ github, context, tag, commit, directory = 'server-dist' }) {
  const fs = require('node:fs');
  const { createHash } = require('node:crypto');
  const repo = context.repo;
  if (!/^server-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error('Invalid server release tag.');
  }
  const archives = [
    `noctua-${tag}-aarch64-apple-darwin.tar.gz`,
    `noctua-${tag}-x86_64-unknown-linux-gnu.tar.gz`,
    `noctua-${tag}-x86_64-pc-windows-msvc.zip`,
  ];
  const names = archives.flatMap(name => [name, `${name}.sha256`]);
  // Check the complete current-run artifact set before creating or mutating a release.
  for (const name of archives) {
    const data = fs.readFileSync(`${directory}/${name}`);
    const checksum = fs.readFileSync(`${directory}/${name}.sha256`, 'utf8');
    const digest = createHash('sha256').update(data).digest('hex');
    if (!data.length || checksum.trim() !== `${digest}  ${name}`) {
      throw new Error(`Invalid server archive or checksum: ${name}`);
    }
  }
  for (const target of ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']) {
    const binary = `noctua-${tag}-${target}${target.includes('windows') ? '.exe' : ''}`;
    const metadata = `server-update-${target}.json`;
    const manifest = JSON.parse(fs.readFileSync(`${directory}/${metadata}`, 'utf8'));
    const data = fs.readFileSync(`${directory}/${binary}`);
    if (manifest.version !== tag.slice('server-v'.length) || manifest.target !== target || manifest.binary !== binary ||
        manifest.size !== data.length || !data.length || manifest.sha256 !== createHash('sha256').update(data).digest('hex') ||
        !Number.isInteger(manifest.api_version) || !Number.isInteger(manifest.data_version) || !manifest.paper_compilers) {
      throw new Error(`Invalid server update metadata: ${metadata}`);
    }
    const signature = fs.readFileSync(`${directory}/${metadata}.sig`, 'utf8').trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || !Buffer.from(signature, 'base64').toString('utf8').startsWith('untrusted comment:')) {
      throw new Error(`Missing or invalid server update signature: ${metadata}`);
    }
    names.push(binary, metadata, `${metadata}.sig`);
  }
  const releases = await github.paginate(github.rest.repos.listReleases, repo);
  let release = releases.find(item => item.tag_name === tag);
  if (release && !release.draft) throw new Error('Refusing to overwrite a published release.');
  if (!release) {
    ({ data: release } = await github.rest.repos.createRelease({
      ...repo, tag_name: tag, target_commitish: commit,
      name: `Noctua server ${tag.slice('server-'.length)}`, draft: true,
      make_latest: 'false',
      body: 'Standalone headless server binaries. See [installation and compatibility](https://github.com/' +
        `${repo.owner}/${repo.repo}/blob/${commit}/docs/server.md#standalone-installation). ` +
        'Archive checksums and signed metadata for in-app server updates are included. Paper compilers are not included.',
    }));
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo, release_id: release.id,
  });
  for (const name of names) {
    const previous = assets.find(asset => asset.name === name);
    if (previous) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: previous.id });
    await github.rest.repos.uploadReleaseAsset({
      ...repo, release_id: release.id, name,
      data: fs.readFileSync(`${directory}/${name}`),
    });
  }
  await github.rest.repos.updateRelease({
    ...repo, release_id: release.id, draft: false, make_latest: 'false',
  });
};
