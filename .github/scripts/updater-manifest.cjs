// Generate once, after all platform uploads, so parallel builds cannot lose targets.
module.exports = async function uploadManifest({ github, context, release, assets }) {
  const version = release.tag_name.slice(1);
  const targets = {
    'windows-x86_64': `Noctua_${version}_x64-setup.exe`,
    'linux-x86_64': `Noctua_${version}_amd64.AppImage`,
  };
  const complete = name => {
    const asset = assets.find(a => a.name === name && a.state === 'uploaded' && a.size > 0);
    if (!asset) throw new Error(`Missing completed updater asset: ${name}`);
    return asset;
  };
  // Validate every file before any download or manifest mutation.
  for (const name of new Set(Object.values(targets))) {
    complete(name);
    complete(`${name}.sig`);
  }
  const platforms = {};
  const signatures = new Map();
  for (const [target, name] of Object.entries(targets)) {
    if (!signatures.has(name)) {
      const { data } = await github.rest.repos.getReleaseAsset({
        ...context.repo, asset_id: complete(`${name}.sig`).id,
        headers: { accept: 'application/octet-stream' },
      });
      const signature = (typeof data === 'string' ? data : Buffer.from(data).toString('utf8')).trim();
      if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
        throw new Error(`Invalid updater signature: ${name}.sig`);
      }
      signatures.set(name, signature);
    }
    // Draft browser URLs can contain an untagged-* slug that expires on publication.
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
    platforms[target] = { signature: signatures.get(name), url };
  }
  const history = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const { releaseSummaries } = require('./release-summary.cjs');
  const release_summaries = releaseSummaries(release, history);
  const serverVersion = process.env.NOCTUA_RELEASE_SERVER_VERSION;
  const data = Buffer.from(JSON.stringify({ version, ...(serverVersion ? { server_version: serverVersion } : {}), notes: release.body || '', release_summaries, platforms }, null, 2));
  const previous = assets.find(a => a.name === 'latest.json');
  if (previous) await github.rest.repos.deleteReleaseAsset({ ...context.repo, asset_id: previous.id });
  await github.rest.repos.uploadReleaseAsset({
    ...context.repo, release_id: release.id, name: 'latest.json', data,
    headers: { 'content-type': 'application/json', 'content-length': data.length },
  });
};
