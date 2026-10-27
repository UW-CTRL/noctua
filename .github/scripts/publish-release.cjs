// Run only after every platform build succeeds; never publish incomplete assets.
module.exports = async function publishRelease({ github, context, core, tag, releaseId, updaterEnabled = false, macosArch = 'aarch64' }) {
  if (!['aarch64', 'universal'].includes(macosArch)) throw new Error('Unsupported macOS release architecture.');
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[1-9]\d*$/.test(String(releaseId))) {
    throw new Error('A numeric version tag and release ID are required.');
  }
  const params = { ...context.repo, release_id: Number(releaseId) };
  const { data: release } = await github.rest.repos.getRelease(params);
  if (release.tag_name !== tag) {
    throw new Error(`Release ${releaseId} belongs to ${release.tag_name}, not ${tag}.`);
  }
  if (!release.draft) {
    core.info(`Release ${tag} is already published; no changes made.`);
    return;
  }
  const version = tag.slice(1);
  const required = [
    `Noctua_${version}_${macosArch}.dmg`,
    `Noctua_${macosArch}.app.tar.gz`,
    `Noctua_${version}_x64-setup.exe`,
    `Noctua_${version}_x64_en-US.msi`,
    `Noctua_${version}_amd64.AppImage`,
    `Noctua_${version}_amd64.deb`,
    `Noctua-${version}-1.x86_64.rpm`,
  ];
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...params, per_page: 100 });
  const missing = required.filter(name => !assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0));
  if (missing.length) {
    throw new Error(`Release ${tag} is missing completed installers: ${missing.join(', ')}`);
  }
  if (updaterEnabled) {
    const manifest = require('./updater-manifest.cjs');
    await manifest({ github, context, release, assets, macosArch });
  }
  await require('./download-aliases.cjs')({ github, context, release: { ...release, id: params.release_id }, assets, macosArch });
  // Let GitHub choose Latest by version/date instead of promoting an older retry.
  const { data: published } = await github.rest.repos.updateRelease({ ...params, draft: false, make_latest: 'legacy' });
  core.info(`Published: ${published.html_url}`);
};
