# Releasing Noctua

The release workflow builds macOS Universal (Intel and Apple Silicon), Windows,
and Linux installers. It uploads them to a shared **draft** GitHub Release.
Once all three platform builds succeed, it verifies the completed installer uploads
and publishes the release automatically. A failed or cancelled build leaves the
release unpublished. The workflow never bumps versions or creates tags.

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
have distinct names. Platform jobs upload signed updater bundles and signatures;
the publication job creates a single `latest.json` after all uploads complete,
mapping the Universal macOS bundle to both Intel and Apple Silicon. This avoids
concurrent manifest writes. Missing signatures or failed manifest uploads prevent
publication. Tags predating `app/tauri.release.conf.json` retain the original
installer-only workflow, including manual rebuilds of older drafts.
The final `publish` job depends on preparation and the entire build matrix. It runs
only after they succeed and checks all seven required installers before publishing.
It preserves the release title, notes, media, and pre-release setting. GitHub chooses
the Latest release using version/date ordering, so an older draft retry is not
explicitly promoted over a newer version.

For manual execution, select **Actions → release → Run workflow**, use a workflow
ref containing this workflow, and enter an **existing** tag in the `tag` field.
The build always checks out that tag, regardless of the selected workflow ref.
The tagged commit must contain the preparation scripts and build configuration.
The publication helper comes from the selected workflow ref, allowing the updated
workflow on `main` to publish an older tagged draft without changing its source. Selecting
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

For custom notes, create or edit the draft for the intended tag **before starting
the workflow**. Add an English description, highlights, migration guidance,
screenshots, or GIF demonstrations using Markdown:

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

## Automatic publication

Review the intended tag, commit, version, and any custom release notes before
pushing the tag or dispatching a manual run. Builds upload into a shared draft;
the final publication job waits for all three builds and verifies these assets:

- macOS: Universal `.dmg` and `.app.tar.gz`.
- Windows: x64 setup `.exe` and `.msi`.
- Linux: amd64 `.AppImage`, `.deb`, and x86_64 `.rpm`.

Every required asset must match the chosen version, have a completed upload state,
and be non-empty. Missing or incomplete files fail publication and leave the draft
available for recovery. A successful run publishes automatically; there is no
manual publication approval step. Download and test installers on the supported
operating systems; build success alone does not verify application behavior.

Merging this workflow does not publish existing drafts retroactively. For an
existing draft such as `v0.1.1`, dispatch **Actions → release → Run workflow** from
updated `main` with that existing tag. It rebuilds the tagged source, preserves
existing notes, and publishes after the same checks. Rerunning failed publication
jobs can reuse successful build outputs. The preparation job continues to refuse
rebuilding already published releases; retrying publication itself is a no-op for
an already published release.

Updater-enabled releases also require completed `.sig` files for the macOS
archive, Windows NSIS installer, and Linux AppImage. The generated `latest.json`
is uploaded before the draft is published. It uses the release's existing notes.
The app checks GitHub's latest published stable release only on a user's request;
drafts and releases marked as prereleases are not offered. A release without a
manifest produces a visible check error rather than claiming the app is current.

## Update signing setup

Before tagging the first updater-enabled release, generate a persistent signing
key pair with the official [Tauri signing CLI](https://v2.tauri.app/plugin/updater/#signing-updates):

```sh
cargo tauri signer generate -w /secure/path/noctua-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo UW-CTRL/noctua < /secure/path/noctua-updater.key
gh variable set NOCTUA_UPDATER_PUBLIC_KEY --repo UW-CTRL/noctua < /secure/path/noctua-updater.key.pub
```

Keep a secure backup of the private key and its password. If encrypted, also set
the `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secret. Never commit private
keys. The workflow refuses to create an updater-enabled draft without both the
public-key repository variable and private-key secret. Use the same pair for
every future release: changing the public key prevents installed apps from
verifying new updates. The public key is compiled into the native app from
`NOCTUA_UPDATER_PUBLIC_KEY`; it is not supplied by the update server.

The release-only `app/tauri.release.conf.json` enables updater artifact signing.
The updater disables legacy ZIP support to avoid the vulnerable `zip` dependency.
Keep Windows updates as raw NSIS `.exe` files and Linux updates as raw AppImages;
macOS `.app.tar.gz` support remains enabled independently of that feature.
Ordinary local builds do not require a private key. They show an explanatory
error when checking for updates unless built with `NOCTUA_UPDATER_PUBLIC_KEY`.
For a local signed build, export that variable and Tauri's signing environment
variables, then run `cargo tauri build --config tauri.release.conf.json` in `app/`.

In the desktop app, **Settings → About & shortcuts → Check for updates** checks
for a strictly newer version. **Update to …** asks the user to save work and
confirm installation, then downloads and verifies the signed bundle before
replacing the app. Windows exits and relaunches through its installer; macOS and
Linux show **Restart Noctua** after installation. All windows share the pending
update and only one operation can run at a time. Network and installation errors
are shown in Settings and allow another check. There are no startup checks or
background installations. Linux supports in-app updates only for AppImage;
package-manager installations must update through their package manager.

Users of an older release without the updater must manually install a build
containing this feature once. Test updates between two signed packaged versions
on each supported OS before relying on them; unit tests and compilation do not
exercise actual application replacement or Windows installer relaunch.

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
  preparation, build, and publication jobs and inspect the API error. The default
  permission is read-only; only those three jobs request writes. Missing tags fail checkout.
- **Source or workflow fix:** merge the correction and release a new version/tag
  rather than silently rebuilding different source under a published version.
- **Publication failure:** check the final job for missing, empty, or incomplete
  assets, a tag mismatch, or an API error. Rerun failed jobs after correcting a
  transient failure; a missing installer requires its build/upload job to succeed.
- **Partial draft:** publication remains blocked until every intended installer is
  present. Review and remove obsolete assets manually if a packaging change
  leaves files with old names. Do not publish during a running build.

No deployment or publication is required to validate the workflow locally:

```sh
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
node --test .github/scripts/*.test.cjs
actionlint .github/workflows/release.yml
```

The first command requires Python 3.11+. `actionlint` is an optional local
workflow linter, not a runtime release dependency.
