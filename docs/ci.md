# Continuous integration

[Documentation](README.md) · [Project README](../README.md)

`.github/workflows/ci.yml` runs on all pull requests, including stacked feature branches, pushes to
`main`, and manual execution. Pushes to `main` skip CI when every changed file is `README.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`, `LICENSE.*`, `NOTICE`, or under
`docs/`. Any other changed path still triggers CI, including
runtime prompts under `src/prompts/`. The dependency security workflow also checks all PR targets. Manual runs and
main-push behavior are unchanged. Each PR update starts fresh checks and cancels
older runs for that PR. Jobs have read-only repository access and no release or
deployment steps. The separate release workflow still builds installers only
for version tags or an explicit manual release run, then publishes the release
automatically after every platform build and installer verification succeeds.
The independent `release-server` workflow builds standalone archives only for
`server-v*` tags or a manual server release run. Release checks also cover server
tag validation, prebuilt-server platform and checksum validation, signed update
metadata, archive contents, executable permissions, and checksums. Backend CI
runs both the server and extracted client-library unit suites. Each lifecycle,
recovery and update integration script has its own CI step so its duration and
failures are visible separately from the server and update-fixture builds.

All seven checks below are required before merging a PR into `main`. See
[Pull requests and merging](development.md#pull-requests-and-merging) for the
contribution and squash-merge conventions.

## Checks

| Check | Runner | Coverage |
| --- | --- | --- |
| Backend tests | Ubuntu | `cargo test --locked -p noctua -p noctua-client` compiles and tests the backend and client library, including chats, MCP permissions and responses, assistant edits and review, library/PDF/media handling, model discovery, storage relocation/failure recovery, and Scholar email OAuth state/PKCE, private credentials, paginated ingestion, full-text PDF screening with a fake agent, excluded/invalid decisions, collection prompts, retries, and restart deduplication. |
| Frontend tests | macOS | `bash tests/run-frontend.sh` runs JavaScriptCore and WebKit checks for syntax, settings, Research views, chat rendering, file attachment upload, draft lifecycle, and PDF page rendering, notes/media, project files, assistant proposal review and edit conflicts, targeted PDF behavior, and responsive layout, Settings skill groups/global locations, Scholar plugin settings, live activity logs/history and outcomes, and slash skill invocation. |
| Desktop check (macos-latest) | macOS | `cargo check --locked -p noctua-app` for the Apple Silicon target. |
| Desktop check (windows-latest) | Windows | `cargo check --locked -p noctua-app` for the native Windows target. |
| Desktop check (ubuntu-22.04) | Ubuntu | `cargo check --locked -p noctua-app` with the Linux Tauri system dependencies installed. |
| Paper integration (each platform) | macOS, Windows, Ubuntu | Build the server, test native detachment and paper helpers, then run both real compiler/API suites with one production-staged compiler resource fixture. |
| Release and workflow checks | Ubuntu | Python and Node release-script tests (including package-resource verification and cache ordering), workspace/lockfile version consistency, and actionlint validation of all workflow YAML files. |
| Dependency security audit | Ubuntu | `.github/workflows/security.yml` runs `cargo audit --file Cargo.lock` against RustSec's advisory database on PRs, pushes to main, manual runs, and weekly on Mondays at 09:17 UTC. |

WebKit tests that exercise real timers, such as search debouncing, attach the
WebView to a visible window without taking focus or accepting mouse input.
Detached WebViews may throttle timers on CI. CI windows may also pause animation
frames, so fixtures that wait for a frame fall back to a short timer. Research test timeouts report the
active check phase; native spellchecking is disabled in that fixture.

Desktop checks type-check the desktop package and compile its build scripts and
required dependencies. They do not link the final application, package installers,
launch the app, or test installation. The macOS check covers the Apple Silicon architecture
used in the release; the release workflow still performs the final
linking and packaging.

Desktop type-checks and paper integration are separate matrix jobs. The desktop
check clears bundle resources with a check-only `TAURI_CONFIG` override, so it
needs no managed TeX trees or bundled server. Installer builds and release
resource verification still use the full packaging configuration.

For PRs, change detection classifies the whole base/head diff independently for
each suite (including added and deleted paths for renames):

| Changed inputs | Desktop type-check | Real paper integration |
| --- | --- | --- |
| Native app code, menus, icons and app manifests | Run | Skip, except the `32x32.png` paper-test image |
| Server code under `src/`, embedded prompts and root `build.rs` | Skip | Run |
| Shared client/lifecycle code, root Cargo manifests/lockfile, CI and unknown inputs | Run | Run |
| Compiler setup scripts and notices under `third-party/` | Skip | Run |
| `paper-integration.py`, `paper_fixture.py`, `test_paper_*.py`, `server-detach.py` | Skip | Run |
| Other frontend fixtures, web assets and documentation | Skip | Skip |

Backend and frontend jobs still run, so their test-only changes remain covered.
Missing/failed comparisons conservatively run both native suites. Main pushes
containing non-documentation changes and manual runs exercise both suites. Skipped
jobs retain their named successful checks for branch protection. Classifier
regressions cover native-only and paper-only edits, shared dependencies,
unknown inputs and real Git renames.

Native desktop and paper jobs have distinct Rust dependency-cache keys. On
Windows only, `CARGO_PROFILE_DEV_DEBUG=0` omits debug/PDB data from these CI
artifacts and caches; debug assertions and compilation checks remain enabled.
Linux/macOS and ordinary local development keep normal debug information.
Compiled dependencies remain cached, while installed Cargo tools use their own
existing caches. The first run of the new cache keys rebuilds dependencies;
compare later matching runs when assessing cache transfer/build costs.

The audit uses cargo-audit 0.22.2 and fetches current advisories on each run.
Vulnerabilities fail the check; informational/unmaintained-crate warnings remain
visible in its log. No advisories are ignored by this workflow. Review findings
and prefer compatible patched dependency updates; do not hide failures with
blanket ignores. Database/network failures also fail the check and should be
distinguished from dependency findings in the job log. The audit only covers
Rust dependencies, not bundled JavaScript or OS libraries. It does not update
dependencies, create issues, or require write permissions. Weekly runs become
active after the workflow is merged into the default branch.

Backend assistant tests use the fake CLI fixture; CI does not log into assistant
accounts or make real model inference requests. Frontend tests use mocks or
bundled browser assets rather than testing live third-party services. The
WebKit launchers use nonpersistent browser storage so saved preferences from
another test or local session cannot change the results. The
workflow does not produce or upload installers, create tags, or publish releases.

The connection appearance fixture compares the serverless manager with the app’s
shared light/dark palette and checks system appearance, UI fonts, narrow layouts,
login failure recovery, loading and offline status. The native smoke also checks
that the shell saves appearance locally for the disconnected manager.
The connection fixture checks one-step-at-a-time popup navigation, Back preserving
the address and transient credential, test-before-save, failed saves retaining the
review step, and invalidating a test when the connection changes.
The maintenance WebKit fixture verifies editor flushing, draft preservation,
pause acknowledgments and conflict/cancellation recovery. Backend CI also builds
an offline next-version fixture and runs the isolated server update regression;
OS managers are mocked, never installed as resident services. Fixture polling
allows for large executable verification; identity, editor acknowledgment,
active-task and backup assertions remain mandatory. Development and test builds
optimize the `sha2` dependency because these checks repeatedly hash complete
debug executables. Server code keeps debug assertions and its normal optimization
level; only Windows native/paper CI omits debug symbols as described above.
Release builds and integrity checks are unchanged.

Paper integration separately caches Tectonic's downloaded TeX support files and generated
formats under the runner's temporary `tectonic-resources` directory. The paper
test step sets `TECTONIC_CACHE_DIR` so the server, compiler subprocesses and
offline `--only-cached` check use the same restored resources. This is separate
from the existing `target/tectonic` and `target/texlive` distribution cache.
The resource-cache key includes the runner OS/architecture and a content hash of
`scripts/setup-tectonic.py`, `tests/paper-integration.py` and
`tests/paper_fixture.py`. Changing any of these files produces a new key; there is no fallback to another key. On a miss, tests populate
the cache normally and a successful job saves it for matching later runs,
subject to GitHub's branch scope and cache eviction. Tests still run on cache
hits, including the offline compilation assertion.

The paper fixture prepares one disposable source bundle using hard links when
supported and ordinary copies otherwise. Production `ensure` still makes a real,
independent copy of both compiler trees. The source bundle is removed before
running the API scenarios. Both engines reuse that one staged tree with separate
data/client profiles and processes. This avoids copying the full distributions
for each engine while retaining the real staging and bundle-removal regression.
Original compiler distributions are never modified.

The frontend runner automatically includes `tests/*.swift` except the two
explicit WebKit launchers, which it invokes separately with selected fixtures,
and the manual PR media generators `tests/pr3-recordings.swift`,
`tests/pr3-screenshots.swift`, and `tests/note-qol-recordings.swift`. Reader
recordings require local inputs under ignored `target/pr3-recording/`; note-QOL
recordings require an isolated demo backend and data under
`target/note-qol-recording/`. Run these tools explicitly
when updating PR media; CI does not generate screenshots or GIFs.
The full PDF rendering integration fixtures (`tests/reader.html` and
`tests/pdf-reader.html`) remain manual because that suite has a known timeout.
Targeted PDF navigation, selection, zoom, theme, and reader-detail checks still
run in CI. CI success does not guarantee all PDF rendering, visual layout,
installation, upgrades, or live provider behavior works.

## Run locally

Zotero import coverage includes selectable content and retry/cancel behavior in
`tests/library-import.html`, PDF coordinate conversion in
`tests/zotero-annotations.swift`, and SQLite fixtures for notes, annotations,
re-imports, and PDF mismatches in the backend library tests.
Linked-PDF coverage includes source-folder relocation, missing/changed originals,
conversion to managed copies, annotation preservation, and persisted storage defaults;
`tests/zotero-settings.swift` exercises Settings controls and save failures.
Sync/Overwrite checks cover source-only updates, retained local edits, conflict
reporting, deselected fields, and note/annotation updates. The 64 MiB linked-PDF
fixture counts full-file validations across 100 cache queries and checks that file
changes invalidate verification; timings are diagnostic, not a pass/fail threshold.
The MCP regression verifies that a missing linked original reports download failure.

From the repository root:

```sh
cargo test --locked -p noctua -p noctua-client
cargo check --locked -p noctua-app
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
node --test .github/scripts/*.test.cjs
actionlint .github/workflows/*.yml
```

The desktop check needs Tauri's platform prerequisites, as with desktop builds.
For the security audit, install the pinned tool and scan the existing lockfile:

```sh
cargo install cargo-audit --version 0.22.2 --locked --no-default-features
cargo audit --file Cargo.lock
```

Python 3.11+ and Node.js 22 are used for release-script checks. On macOS, also run:

```sh
bash tests/run-frontend.sh
```

The script uses a temporary Swift module cache unless `SWIFT_MODULECACHE_PATH`
is supplied. To investigate the full PDF rendering suite manually:

```sh
swift tests/reader.swift tests/reader.html
swift tests/reader.swift tests/pdf-reader.html
```

Those manual checks are not counted as passing CI checks.

## PRs and main

Push a working branch and open a PR into `main`. Review all ten checks before
merging, allowing each native/paper suite to report a skip when its inputs are
unchanged as described above. Fix failures in the same branch; pushing
another commit runs CI again.
For an infrastructure-only change such as CI, a PR verifies the workflow itself
before it reaches `main`.

A direct push to `main` also starts CI, but failures are discovered after the
change has already landed. Prefer PRs for normal changes. Running CI does not
itself block merges or direct pushes: an administrator must configure a main
branch ruleset or branch protection separately and require **Backend tests**,
**Frontend tests**, **Release and workflow checks**, the three **Desktop check**
jobs, the three **Paper integration** jobs, and **Dependency security audit**. This change does not
modify repository protection settings.

If a runner or download fails transiently, use **Re-run failed jobs** in Actions.
If a test or workflow fails consistently, inspect its log and correct the cause
rather than bypassing the check.

Linux desktop and release jobs use the official Ubuntu archive over HTTPS instead
of the Azure package mirror, with bounded request timeouts and retries. Package
signature verification remains enabled.

## Independent server regression

After `cargo build --locked -p noctua`, run `python3 tests/server-lifecycle.py` and
`python3 tests/server-recovery.py`.
These use new temporary server/client/service directories and fake OS managers,
covering concurrent ensure, detached parent lifetime, identity/data ownership,
stale records, port collisions, safe restart, token/Host/Origin/CSRF rejection,
browser sessions, two-device note version conflicts, native isolation and the
incompatible data-format fence. Recovery regression also covers pre-protocol
storage locks, human-readable shutdown advice, explicit retry, and preservation
of another data folder's authenticated server. Neither addresses a user's server or registers
a real resident service. CI runs it on the backend Linux runner.

`tests/connection.html` runs with the nonpersistent WebKit fixture. It covers the
serverless desktop screen, remote connection test/retry without local fallback,
secret clearing, local draft persistence and per-server isolation, failed-save
switch blocking and a late acknowledgment preserving newer input. Backend tests
also cover lifetime ownership, persistent identity, address validation and nested
SQLite WAL snapshots. Real OS login, keyring authorization, packaged updates and
Tailscale/two-computer networking require platform release smoke tests.

For a macOS native WebView smoke, build both packages then run
`python3 tests/desktop-smoke.py`. It uses a debug-only unique application identifier with explicit temporary
folders, so it can run without contacting an existing desktop app. It verifies
actual cookie/session readiness before checking server survival
after the test desktop exits. It uses isolated data/config/service paths and
only stops its own server afterward. Backend chat regression verifies that a
subscriber disconnect leaves the job busy, concurrent turns are rejected, and
explicit cancellation persists a partial result.

The request-lifetime regression abandons an authenticated request while its handler
is blocked, then verifies the server job completes and retains its active-request
count until completion. This prevents interface loss from cancelling admitted
server AI/write jobs or permitting an unsafe shutdown during their work.

The server lifecycle fixture also blocks a mocked service refresh while another
ensure runs, proving the restart transaction is serialized. It tests relative
home paths, registration without starting, and profile relocation with the login
definition updated to the destination. `NOCTUA_PROFILE_HOME` keeps these tests
inside a temporary profile while exercising the real migration lease.
The refresh barrier waits for executable verification and reports an early
restart error directly; slower debug ELF preflight must not look like a lock failure.

`tests/note-drafts.html` verifies newer edits during save, malformed successful
responses, a full local store plus network failure, failed deletion, and input
typed during conflict reload. The connection fixture covers editor freezing and
rollback, independent per-editor drafts, legacy recovery, and recovery selection.
Server tests retain ownership for unfinished response streams and reject remote
addresses in local control records. Session capacity evicts one old session
rather than invalidating every connected client.

## Paper rendering

Paper integration CI and release builds select Python 3.12 before preparing the compilers.
This avoids the Ubuntu 22.04 system Python tar extraction failure on TinyTeX's
relative symlinks while retaining the archive data filter and checksum validation.
Use Python 3.12 when reproducing compiler setup locally.

Paper jobs share prepared compiler caches with release builds. Tauri CLI cache
preparation runs in a separate workflow, so neither main nor PR desktop checks
install that CLI. See [release caching](releases.md#paper-compiler-packaging) for
cache keys, invalidation, and cold-run behavior.

Paper integration prepares both pinned managed compilers, builds the server, and
runs `python3 tests/paper-integration.py` on macOS, Windows, and Linux. This uses
isolated temporary storage and tests real custom-class/BibTeX/image builds,
subfolder inputs, cached compilation, errors, stale revisions, cancellation, and
artifact retention. It requires network for uncached TeX resources.

The frontend suite includes `tests/paper.html` for editor/preview behavior, save
conflicts, debounced builds, cancellation, and stale PDF-load protection. It logs
completed assertions and pending operations to CI. Application operations have a
ten-second timeout with an operation name; the WebKit launcher retains its
35-second overall limit and reports the last progress message on timeout.

`tests/document-tools.html` covers citation source labels and duplicate results,
rendered title math, stale suggestion requests, line-comment shortcuts, and Find
scopes for file source, active cells, rendered notes, PDF text, and user comments.

`tests/mentions.html` checks project file/folder mentions, typed labels, duplicate
titles, unsaved excerpts, scoped listings, binary references, and project-switch races.

`tests/panes.html` verifies collapsed rails across graph, notes, and reader modes,
restored widths, retained drafts, and focus, plus the Reader/note split
layout, dragging, keyboard resizing, minimum widths, and persistence.
`tests/split-drag.html` checks PDF-to-note drops: LaTeX escaping of selected text,
cited quote and figure insertion, empty-block reuse, and refusal outside notes. Paper checks also cover collapsing
source/preview and restoring the layout across editor remounts.

Paper integration checks prepare both bundled compilers, then exercise Tectonic
and pdfLaTeX/BibTeX, project settings, engine switching, bibliography spacing,
cache invalidation, cancellation, and last-successful PDF retention.

SyncTeX integration queries use the exact source names recorded by the compiler,
including Windows paths, and report the command and output if no location is found.

The real-compiler fixture places SyncTeX sidecars beyond 260 characters to cover
Windows path limits. Forward queries and the application's inverse queries copy the immutable map
to a separate temporary directory and use a short output basename. The query copy
is removed afterward; the actual PDF and saved mapping remain in the artifact
directories. Merely changing cwd inside the long mapping path was insufficient
on Windows; diagnostic probes confirmed both engines work from a short directory.

On integration failure, CI uploads `paper-diagnostics-<platform>` for seven days.
These artifacts contain only synthetic fixture build files, the traceback, and
SyncTeX probes comparing compressed/plain mappings in short temporary directories.
Both engines run even if one fails; the job still fails if either engine fails.

The independent-server fixtures also cover packaged paper compiler staging and
compilation drain via `tests/server-paper-lifecycle.py`. Real compiler API tests
start an authenticated foreground server with temporary client/profile paths.

The desktop updater shares release history and confirmation helpers with the
About settings UI. `tests/updates.swift` covers both legacy HTTP updates and the
independent desktop bridge, including client version display, version-pinned
installation, native confirmation ownership and failure recovery.
`tests/updates-ui.html` covers update actions and release history.
`tests/client-updates.html` checks that server management omits app updates while
the startup offer remains available.

`python3 tests/server-detach.py` captures both `ensure` output streams and verifies
that they close after the launcher exits while the isolated server stays ready.
It runs in backend CI and all paper integration platform jobs, including Windows.

## Collection research regression

Backend research tests cover persistence, per-collection isolation, stale revision
rejection, invalid dates/progress, preservation of malformed/future-version data,
and symlink rejection. `tests/collection-research.html` runs in the WebKit suite
and covers save/reopen, target-date removal, failed saves retaining input,
collection/revision binding, duplicate saves, cancellation, and load errors.

Collection kind regressions also cover regular/project creation, type conversion, legacy research classification, distinct tree icons, and refreshing the tree after a type change.

Library management tests cover atomic bulk operations, stale edits, tag changes, trash restoration and undo, folder cycles/order/storage preservation, safe duplicate merging and differing-PDF refusal. `tests/library-management.html` exercises selection, native clipboard routing, dragging, batch actions, restore/undo, duplicate candidates and failed-form retention.

Trash regressions additionally cover table-style selection, Restore actions, Delete confirmation, rejection of purging active items, irreversible paper/annotation removal, and cleanup of owned folder files while preserving other storage.

Authentication tests cover stable 15-character token generation, replacement and rejection of older long credentials, and inline eye/copy controls in both browser and desktop connection fields, including containment inside the input border.

Desktop server settings checks (`tests/server-settings.swift` and `tests/manager-embedded.html`) cover inline layout, category navigation, token clearing and local controls. The app’s `manager_frame` unit test rejects remote or missing origins, unexpected hosts and requests without the management header.

### Release tool preparation and release eligibility

`cache-release-tools.yml` prepares the pinned Tauri CLI separately from CI, on
release workflow changes to main or manual dispatch. Its OS/architecture/version
cache is shared with both release workflows. Cache misses still install the CLI
inside a release; cache preparation is not a prerequisite for checks or releases.
Keep `TAURI_CLI_VERSION` aligned in the cache and both release workflows.

Both release workflows require successful `ci.yml` and `security.yml` push runs
on main for the exact tagged commit. The latest matching run must be completed
and successful; missing, pending, failed, or cancelled checks block preparation,
building, and publication. PR checks cannot substitute for main checks.

The Paper stale-load fixture waits for explicit mocked request-start signals
instead of timer ticks and suspends background polling during its two-load race.
