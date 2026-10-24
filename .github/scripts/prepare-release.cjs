// Prepare the shared draft once. Never replace manually edited release notes.
const marker = '<!-- noctua:generated-release-notes -->';

module.exports = async function prepareRelease({ github, context, core, tag }) {
  const repo = context.repo;
  // listReleases includes drafts with this job's contents: write permission.
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repo, per_page: 100,
  });
  let release = releases.find(item => item.tag_name === tag);
  if (release && !release.draft) {
    throw new Error(`Release ${tag} is already published; refusing to replace its assets.`);
  }
  if (!release || !(release.body || '').includes(marker)) {
    const { data: notes } = await github.rest.repos.generateReleaseNotes({
      ...repo, tag_name: tag, configuration_file_path: '.github/release.yml',
    });
    const body = [release?.body, marker, notes.body].filter(Boolean).join('\n\n');
    if (release) {
      ({ data: release } = await github.rest.repos.updateRelease({
        ...repo, release_id: release.id, body,
      }));
    } else {
      ({ data: release } = await github.rest.repos.createRelease({
        ...repo, tag_name: tag, name: `Noctua ${tag}`, body, draft: true,
      }));
    }
  }
  core.setOutput('release_id', String(release.id));
  core.info(`Draft ready: ${release.html_url}`);
};
