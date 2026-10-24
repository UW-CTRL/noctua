# Releasing Noctua

The release workflow builds macOS Universal (Intel and Apple Silicon), Windows,
and Linux installers. It uploads them to a shared **draft** GitHub Release.
Publication is always manual. The workflow never bumps versions or creates tags.

## Choose a version

Use `0.x.x` during early development. Before `1.0.0`, interfaces may change:
use a minor increment for features or breaking changes and a patch increment for
compatible fixes. Describe breaking changes and migration steps explicitly.

Starting at `1.0.0`, follow [Semantic Versioning](https://semver.org/) strictly:

- **MAJOR:** breaking changes to supported interfaces or behavior.
- **MINOR:** backward-compatible new features.
- **PATCH:** backward-compatible bug fixes.

Decide and document the supported compatibility contract before the first stable
release. Use numeric tags such as `v0.1.0` and `v1.2.3`; prerelease suffixes and
build metadata are not supported by this workflow's desktop version check.
Early development (`0.x.x`) is distinct from GitHub's optional pre-release flag.

The only manually maintained version is `[workspace.package].version` in the
root `Cargo.toml`. Both Rust packages inherit it using `version.workspace = true`.
`app/tauri.conf.json` omits `version`, so Tauri uses the desktop Cargo package's
version. See [Tauri's version configuration](https://v2.tauri.app/reference/config/#version).
Do not add a separate Tauri version override.

Change the workspace version in a reviewed commit. Refresh the generated lockfile
with `cargo metadata --format-version 1 > /dev/null` and commit the resulting
`Cargo.lock` changes. Check that only intended dependency changes are included.
The release validator checks both packages' lockfile versions as well as the
workspace version and inheritance configuration. Python 3.11+ is required:

```sh
python3 .github/scripts/check-release-version.py v0.1.0
```

This command only validates files; it does not change the version or create a tag.
An outdated lockfile or mismatched tag stops the workflow before any release
creation or installer build.

## Create and push the tag

Merge the release changes, including the version and lockfile, into the default
branch. Check out that reviewed commit in a clean working tree and run the
project's relevant tests and the version validator. Then create and push the tag:

```sh
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin refs/tags/v0.1.0
```

Replace `v0.1.0` with the chosen version everywhere. Confirm the target commit
before tagging; do not move or reuse a published version tag.

A push of a `v*` tag triggers `.github/workflows/release.yml`. Preparation checks
the version, resolves the tagged commit, and creates or reuses one draft release.
All three builds check out that resolved commit and upload to the same release
ID. Per-tag concurrency queues overlapping runs. Platform-specific installers
have distinct names; updater metadata uploads are disabled because Noctua has no
updater configured and a shared `latest.json` would require serialized merging.

For manual execution, select **Actions → release → Run workflow**, use a workflow
ref containing this workflow, and enter an **existing** tag in the `tag` field.
The build always checks out that tag, regardless of the selected workflow ref.
The tagged commit must contain these release scripts and configuration. Selecting
a branch name as `tag` does not build or create a release from that branch.

## Prepare release notes

GitHub's native release-note generator lists merged PRs with links and adds a
full changelog comparison when a previous release is available. It selects the
previous release automatically; earlier unpublished drafts may not provide the
baseline you intend. Review that comparison before publication. On the first
release, inspect the generated history rather than expecting a comparison link.

Label PRs before generating the notes. Create these repository labels manually
if they do not exist; this workflow does not manage labels:

| PR label | Release-note category |
| --- | --- |
| `breaking-change` | Breaking Changes |
| `feature` | New Features |
| `bug` | Bug Fixes |
| `enhancement` or `improvement` | Improvements |
| Unmatched labels or no labels | Other Changes |

The category order in `.github/release.yml` gives breaking changes priority.
Labels categorize PRs, not individual commits. Direct commits are available in
the full comparison, but may need a manually written summary in the release body.
See [GitHub's generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes).

Open the draft on **Releases**, choose **Edit**, and add an English description,
highlights, migration guidance, screenshots, or GIF demonstrations using Markdown:

```markdown
## Highlights

Describe the user-visible result and link to the relevant PR.

![Screenshot of the new feature](https://example.com/noctua-screenshot.png)
![GIF demonstration of the new feature](https://example.com/noctua-demo.gif)
```

Replace the example URLs with real uploaded image URLs. Drag images or GIFs into
GitHub's release-description editor and keep the generated Markdown links; local
filesystem paths will not work for release readers.

You may also prepare a draft for an existing tag before running the workflow.
Preparation appends generated notes after any existing manual text. The reserved
`<!-- noctua:generated-release-notes -->` marker records that notes were generated.
Once present, reruns leave the entire release body and title untouched, including
manual edits to the generated notes. Platform builds only upload installers.

Notes are a snapshot, not a continuously updated changelog. If labels or the
comparison baseline need correction, edit or regenerate the relevant section in
GitHub while retaining your manual content and the marker. Rerunning the workflow
does not refresh notes that already contain the marker.

## Review and publish

Wait for **all three** platform jobs to succeed. A draft can exist while builds
are running or after one of them fails. Check the tag, commit, version, release
notes, comparison range, and all expected installer assets. Download and test
installers on the supported operating systems; CI success alone does not verify
installation and application behavior.

Keep the release as a draft while any job runs or any required file is missing.
When verification is complete, choose **Publish release** in GitHub. Noctua's
workflow does not publish automatically or configure application auto-updates.
It refuses to rebuild a release that is already published.

## Recover from failures

- **Version validation:** inspect the tag and configuration. For a new release,
  commit the correct workspace version and refreshed lockfile before creating
  its tag. Do not disable validation to build mismatched installers. Correct an
  unpublished mistaken tag only through an explicit maintainer decision;
  published tags remain immutable and fixes require a new version.
- **Build or upload failure:** inspect the failed job's log. For transient
  failures, rerun failed jobs from the same Actions run. Preparation outputs are
  reused; rerunning all jobs also reuses the draft without replacing its notes.
  Existing assets with matching names can be replaced on rerun.
- **Preparation failure:** verify Actions has `contents: write` access for the
  preparation and build jobs and inspect the API error. The default permission
  is read-only; only those two jobs request writes. Missing tags fail checkout.
- **Source or workflow fix:** merge the correction and release a new version/tag
  rather than silently rebuilding different source under a published version.
- **Partial draft:** keep it unpublished until every intended installer is
  present. Review and remove obsolete assets manually if a packaging change
  leaves files with old names. Do not publish during a running build.

No deployment or publication is required to validate the workflow locally:

```sh
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
node --test .github/scripts/prepare-release.test.cjs
actionlint .github/workflows/release.yml
```

The first command requires Python 3.11+. `actionlint` is an optional local
workflow linter, not a runtime release dependency.
