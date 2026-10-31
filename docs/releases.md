# Releasing Noctua

[Documentation](README.md) · [Project README](../README.md)

The release workflow builds macOS Apple Silicon (aarch64), Windows,
and Linux installers. It uploads them to a shared **draft** GitHub Release.
Once all three platform builds succeed, it verifies the completed installer uploads
and publishes the release automatically. A failed or cancelled build leaves the
release unpublished. The workflow never bumps versions or creates tags.
New macOS releases do not support Intel Macs; Intel users can retain an older Universal release. The updater manifest includes signed Apple Silicon macOS application archives
alongside Windows and Linux update targets.

Before either release workflow can prepare or build a release, the exact tagged
commit must have successful main push runs of both CI and Dependency security.
Missing, running, failed, or cancelled checks block the release. Merge and verify
main before creating a tag; after a failed check, resolve the failure and obtain
a successful run for the intended commit. A successful PR check alone is not
sufficient. This gate applies to manual rebuilds too. Older tags without matching
main checks cannot be rebuilt through these gated workflows.

Tauri CLI cache preparation runs separately from CI. A missing cache slows the
release installation step but does not prevent a release.

## Standalone server releases

`.github/workflows/release-server.yml` publishes standalone server archives for
Linux x64, Windows x64, and macOS Apple Silicon. It runs on `server-v*` tags or a
manual run with an existing server tag. The desktop `v*` workflow and bundled
desktop installer format are preserved. Both release workflows use the reusable
`build-server.yml` workflow to produce native server artifacts. Desktop packaging
downloads those artifacts from its current run and does not invoke Cargo again
for the server. Server releases explicitly set `make_latest: false`
so desktop download aliases and updater URLs continue to use the desktop release.

The server version is `[package].version` in the root `Cargo.toml`; the desktop
version is `[workspace.package].version`. They can advance independently. Change
the server version and refresh the lockfile, then validate and tag the reviewed
commit (substitute the current version):

```sh
python3 .github/scripts/check-release-version.py server-v0.3.5 --server
git tag -a server-v0.3.5 -m "Server release v0.3.5"
git push origin refs/tags/server-v0.3.5
```

Validation checks the server manifest and lockfile version without requiring
Tauri configuration. All platform jobs use the resolved tagged commit, restore
Cargo caches, build with `cargo build --locked --release -p noctua --target TRIPLE`,
and smoke-test the executable with `describe`, checking its embedded version.
They archive the executable and license and generate a SHA-256 checksum for each
archive. It also produces raw executables and per-target update metadata binding
the version, platform, API/data versions, compiler requirements, size and SHA-256.
Native builds need no Tauri CLI, desktop libraries, or TeX setup. Publication uses
Tauri CLI 2.10.1 to sign that metadata with the existing
`TAURI_SIGNING_PRIVATE_KEY` and password secrets. Official desktop clients verify
with the embedded `NOCTUA_UPDATER_PUBLIC_KEY`; keep those keys paired. A missing
signing key or signature prevents server publication.

Only after every build succeeds does publication download the current run's
artifacts, verify checksums, upload to a draft, and publish it. Per-tag concurrency
queues overlapping runs. A failed upload leaves a draft that can be retried;
reruns replace matching draft assets and preserve edited notes. Published releases
cannot be overwritten. The workflow never creates tags. For manual runs, select
**Actions → release-server → Run workflow** and enter the existing server tag;
the tagged commit must contain the server release scripts and workflow.

See [Standalone installation](server.md#standalone-installation) for downloads,
checksum verification, runtime limits, and compatibility. Managed TeX compilers
are omitted from standalone archives. In-app server updates retain the verified
bundled compiler resources and require matching compiler versions. Changed
compiler requirements need a compatible desktop release or a manual deployment
with matching resources.

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

Desktop releases use `[workspace.package].version` in the root `Cargo.toml`.
`app/Cargo.toml` inherits that version; `app/tauri.conf.json` omits a version
override. Server releases use the root `[package].version`. The client library
has its own internal package version; it is not a server identity or API version.

Change the appropriate version in a reviewed commit. Refresh the generated
lockfile with `cargo metadata --format-version 1 > /dev/null` and commit the
resulting `Cargo.lock` changes. Each release validator checks its own package's
lockfile version; a desktop release can bundle a server with a different version.
Python 3.11+ is required:

```sh
python3 .github/scripts/check-release-version.py v0.3.5
python3 .github/scripts/check-release-version.py server-v0.3.5 --server
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
offering signed Windows NSIS and Linux AppImage updates. This avoids
concurrent manifest writes. Missing signatures or failed manifest uploads prevent
publication. Tags predating `app/tauri.release.conf.json` retain the original
installer-only workflow, including manual rebuilds of older drafts.
The final `publish` job depends on preparation and the entire build matrix. It runs
only after they succeed and checks all four required installers before publishing.
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
For older tags whose workflow explicitly builds Universal macOS installers,
preparation retains that architecture for the rebuild, installer checks,
and download alias. Universal archives serve both Mac architectures on these
rebuilds. New tags build only Apple Silicon.

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

- macOS: Apple Silicon `.dmg`.
- Windows: x64 NSIS setup `.exe`.
- Linux: amd64 `.AppImage` and `.deb`. RPM-based distributions can use AppImage.

Every required asset must match the chosen version, have a completed upload state,
and be non-empty. Missing or incomplete files fail publication and leave the draft
available for recovery. A successful run publishes automatically; there is no
manual publication approval step. Download and test installers on the supported
operating systems; build success alone does not verify application behavior.

Before publication, the workflow also copies the DMG, Windows setup EXE, and Linux
AppImage to `Noctua-macOS-aarch64.dmg`, `Noctua-Windows-x64-setup.exe`, and
`Noctua-Linux-amd64.AppImage`. README download buttons use GitHub's
`releases/latest/download/<filename>` URLs, so they follow the latest stable
release without editing version numbers. The original versioned assets remain
available for the updater and alternative downloads. A failed alias download or
upload leaves the release in draft; publication retries replace existing aliases.
The Apple Silicon download button becomes available after the first release
with the new alias; older Universal releases remain available on the releases page.

Merging this workflow does not publish existing drafts retroactively. For an
existing draft such as `v0.1.1`, dispatch **Actions → release → Run workflow** from
updated `main` with that existing tag. It rebuilds the tagged source, preserves
existing notes, and publishes after the same checks. Rerunning failed publication
jobs can reuse successful build outputs. The preparation job continues to refuse
rebuilding already published releases; retrying publication itself is a no-op for
an already published release.

Publication rejects MSI and RPM installers;
remove obsolete draft assets before retrying. Updater-enabled releases also require
a completed macOS `.app.tar.gz` archive and its `.sig`, plus completed `.sig`
files for the Windows NSIS installer and Linux AppImage. The generated `latest.json`
is uploaded before the draft is published. Its download URLs use the final
version tag, since GitHub's temporary draft asset URLs can expire on publication.
It uses the release's existing notes.
On Apple Silicon macOS, Windows and AppImage, the app checks GitHub's latest published stable release once per launch and when
the user requests a check in Settings;
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

Before building, the workflow also writes that same public key into
`plugins.updater.pubkey` in the runner's release configuration. The Tauri CLI
needs it to verify generated signatures; the runtime builder override alone
does not configure the bundler. The variable must contain the complete encoded
`.pub` file produced by Tauri, including its encoded comment line. This step
uses the selected workflow, so a manual run from updated `main` can rebuild an
older draft without moving its version tag.
For tags bundling the independent server, this step also pins the build hook
working directory to `app/`. Tauri otherwise runs hooks from the frontend root.
This packaging override lets updated workflows recover older drafts with a
relative server-script path while preserving their tagged application source.

The workflow enables updater artifact signing on every desktop platform in
`app/tauri.release.conf.json`; its checked-in default disables artifact generation.
The updater disables legacy ZIP support to avoid the vulnerable `zip` dependency.
Keep Windows updates as raw NSIS `.exe` files and Linux updates as raw AppImages;
macOS uses a signed `.app.tar.gz` archive. Platform configuration selects APP and DMG,
NSIS, or AppImage plus DEB explicitly; the workflow also overrides targets for older drafts.
Ordinary local builds do not require a private key. They show an explanatory
error when checking for updates unless built with `NOCTUA_UPDATER_PUBLIC_KEY`.
For a local signed build, export that variable and Tauri's signing environment
variables and set `plugins.updater.pubkey` to the same public key in your local
release configuration. Then run
`cargo tauri build --config tauri.release.conf.json --config '{"bundle":{"createUpdaterArtifacts":true}}'`
in `app/` on the supported desktop platforms. On macOS include the app target
with `--bundles app,dmg` to produce both the archive and installer.

On Apple Silicon macOS, Windows and AppImage, open **Settings → About & Shortcuts** and choose **Check for
updates** under **App and Local Server Updates**. An available release changes the button to
**Update to …**; installing or restarting requires native confirmation.
Confirming downloads and verifies the signed bundle before replacing the app.
Windows exits and relaunches through its installer; Linux shows
**Restart Noctua** after installation. Server-hosted pages can request only the
limited update actions; local installation and restart remain native operations.

All windows share the pending update and only one operation can run at a time.
Network and installation errors appear in About and allow another check. On
startup, one window checks after restoring or retrying a saved connection. A newer release opens a modal showing the installed and offered
versions, categorized release history, and **Install update** / **Not now** buttons.
The startup dialog's Install update button confirms installation directly.
Opening more tabs or windows does not repeat the prompt within the same process.
**Not now** dismisses it until the next launch; update controls remain available
in About. Startup failures and current-version results do not interrupt the user.
Installation always requires confirmation; there are no background installations.
Linux supports in-app updates only for AppImage; package-manager installations
must update through their package manager.

macOS installs the signed application archive and offers **Restart Noctua** after
installation. Publication validates that the archive contains the bundled server
and paper compiler resources, and requires its signature before generating the
macOS manifest entry. Apple Silicon archives are not offered to Intel Macs.

Desktop 0.3.6 disabled macOS desktop update checks and installation. Users of that
version must manually install a newer Apple Silicon DMG once to restore in-app
updates: quit Noctua and replace it in Applications, keeping the data folder.
Older builds with the updater enabled can consume the signed Mac manifest entry.
Intel users must retain an older compatible Universal release.

Users of an older release without the updater must manually install a build
containing this feature once. Test updates between two signed packaged versions
on each supported OS before relying on them; unit tests and compilation do not
exercise actual application replacement or Windows installer relaunch.

## Short update summaries

Publication adds structured `release_summaries` to `latest.json` alongside the
normal full `notes`. It includes the new release and published stable history,
sorted by numeric version. The app displays only releases newer than the user's
installed version and no newer than the offered update, so skipped versions are
covered. Full release notes and a comparison from the installed version remain
available through links. Older manifests without summaries show a release-notes
link instead of invented highlights.

The startup dialog keeps long history in a separately scrolling, keyboard-focusable
region while its heading and action buttons stay visible. Each listed version
links to its own full release notes. Deferring an update does not mark any release
as installed or remove it from this range; the next launch includes the versions
between the still-installed version and the newly offered version. This history
covers published stable releases included in the manifest and displays summaries,
not the complete text of every release note.

By default, summaries use the release body's categorized bullet lists: Breaking
Changes, New Features, Bug Fixes, Improvements, and Other Changes. Author credits,
URLs, images, and code blocks are omitted. Each release contains at most six
highlights, two per category, with each item limited to 110 characters. Review
the release notes before tagging to keep the automatic summary useful.

For a more focused summary, include this optional block in the draft's release
body before running the workflow. The marked bullets take precedence over the
generated list; the rest of the release notes remain intact:

```markdown
<!-- noctua:update-summary -->
### New Features
- Ask before installing updates at startup.
### Bug Fixes
- Preserve saved settings when restarting.
<!-- /noctua:update-summary -->
```

Summary generation reads all published stable release notes at publication time;
failure to fetch that history leaves the release in draft. Editing old notes
after publication does not change an existing manifest; the next release takes
a new snapshot. Summaries are informational and installation still verifies
the signed update artifact.

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
actionlint .github/workflows/*.yml
```

The first command requires Python 3.11+. `actionlint` is an optional local
workflow linter, not a runtime release dependency.

## Independent server packaging and release smoke tests

`app/prepare-server.py`, invoked by Tauri's beforeBuildCommand, builds the headless
`noctua` binary for the desktop target and bundles it under `binaries/noctua-server`
(`.exe` on Windows). Official macOS releases target Apple Silicon. Custom
universal builds require both Rust targets and lipo. Retain Python 3 on runners. The desktop stages a
content-addressed copy under NoctuaClient/servers before starting it; bundle replacement
must not remove that copy or terminate the server. Do not clean staged versions
while a server or service may still use them.

Before release, exercise installation and login/logout on each actual OS: macOS
LaunchAgent, Linux systemd user unit, Windows interactive logon task and each OS
credential store. Verify missing service manager/keyring, registration failure,
disable without stopping, app quit while tasks run, two clients reusing one owner,
remote browser authentication and app replacement with an old server still active.
A successful compile or generated service definition is not sufficient. Signed
installer/update replacement, live Tailscale Serve and two-computer use remain
release smoke tests. The development tests never register a real service.

On first opening the new desktop release, a separate update worker verifies the
bundled server, announces maintenance, waits for editor saves and active tasks,
and creates a complete stopped snapshot before replacement. It refreshes enabled
login registration and removes retired staged binaries only after readiness and
identity/hash checks. Test interrupted workers, failed replacement startup,
service-refresh failure, deferred Windows cleanup and rollback from a completed
snapshot with the matching release. Automatic downgrade is refused after newer
DBs have been opened. Maintenance and recovery are described in
[Server operations](server.md#drafts-backup-and-updates); do not run an older
pre-protocol binary against migrated data.

## Paper compiler packaging

Release and desktop CI jobs cache the prepared Tectonic and TinyTeX trees by
runner OS/architecture, native/Universal compiler layout, and a hash of both setup
scripts and their license notices.
Changing a compiler version, package list, setup behavior, or notice invalidates
the cache. Setup scripts still run after restoration and check their version
stamps. No partial-key fallback is used.

The release workflow caches Tauri CLI 2.10.1 in a dedicated installation directory,
separate from the Rust build cache. Update `TAURI_CLI_VERSION` in the dedicated cache and both release
workflows together to upgrade it; the new version gets a fresh cache.
Main-branch desktop CI also prepares this CLI cache because GitHub allows tag runs
to restore default-branch caches, but not caches belonging to other tags. Let main
CI finish before tagging to benefit from these caches on the first release run.
The first run, an evicted cache, or changed inputs still require full setup.
Cache reuse reduces preparation work; Rust compilation, packaging, and uploads
still run, and actual time savings depend on the runner and cache transfer time.

Release jobs run `scripts/setup-tectonic.py` and `scripts/setup-pdflatex.py` before
packaging. They prepare checksum-verified Tectonic 0.17.0 and TinyTeX 2026.10
(TeX Live 2026 pdfLaTeX/BibTeX), with fixed-date JMLR/algorithm2e/SyncTeX dependencies.
macOS releases include the Apple Silicon Tectonic compiler; TinyTeX retains its
upstream Universal binaries. Compilers resolve from app
resources at runtime: users need no separate TeX installation. The TeX distribution
increases installer size; package files, fonts, formats, and license notices must
ship together with the executables. Local packaging requires both setup scripts.

Release jobs restore the Rust build cache before restoring managed paper compilers.
Rust cache cleanup removes non-Cargo files under `target/`, so reversing this order
can silently empty compiler resource trees. Before publication, each platform job
checks its actual Debian package and AppImage, macOS DMG, or Windows NSIS installer
for the bundled server, Tectonic, pdfLaTeX, BibTeX, TeX packages, and license notices.
A missing resource fails the build and leaves the release unpublished.
