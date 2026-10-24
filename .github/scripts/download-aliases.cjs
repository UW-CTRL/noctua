// Keep README download URLs stable while retaining versioned installers for updates.
module.exports = async function uploadDownloadAliases({ github, context, release, assets }) {
  const version = release.tag_name.slice(1);
  const aliases = [
    [`Noctua_${version}_universal.dmg`, 'Noctua-macOS-universal.dmg', 'application/x-apple-diskimage'],
    [`Noctua_${version}_x64-setup.exe`, 'Noctua-Windows-x64-setup.exe', 'application/vnd.microsoft.portable-executable'],
    [`Noctua_${version}_amd64.AppImage`, 'Noctua-Linux-amd64.AppImage', 'application/octet-stream'],
  ].map(([source, name, type]) => {
    const asset = assets.find(a => a.name === source && a.state === 'uploaded' && a.size > 0);
    if (!asset) throw new Error(`Missing completed download source: ${source}`);
    return { asset, name, type };
  });
  for (const { asset, name, type } of aliases) {
    const { data: downloaded } = await github.rest.repos.getReleaseAsset({
      ...context.repo, asset_id: asset.id, headers: { accept: 'application/octet-stream' },
    });
    const data = Buffer.from(downloaded);
    if (data.length !== asset.size) throw new Error(`Incomplete download: ${asset.name}`);
    const previous = assets.find(a => a.name === name);
    if (previous) await github.rest.repos.deleteReleaseAsset({ ...context.repo, asset_id: previous.id });
    await github.rest.repos.uploadReleaseAsset({
      ...context.repo, release_id: release.id, name, data,
      headers: { 'content-type': type, 'content-length': data.length },
    });
  }
};
