# Continuous integration

[Documentation](README.md) · [Project README](../README.md)

`.github/workflows/ci.yml` runs on pull requests targeting `main`, pushes to
`main`, and manual execution. Pushes to `main` skip CI when every changed file is `README.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`, `LICENSE.*`, `NOTICE`, or under
`docs/`. Any other changed path still triggers CI, including
runtime prompts under `src/prompts/`. PR checks, manual runs, and the separate
dependency security workflow retain their existing triggers. Each PR update starts fresh checks and cancels
older runs for that PR. Jobs have read-only repository access and no release or
deployment steps. The separate release workflow still builds installers only
for version tags or an explicit manual release run, then publishes the release
automatically after every platform build and installer verification succeeds.

## Checks

| Check | Runner | Coverage |
| --- | --- | --- |
| Backend tests | Ubuntu | `cargo test --locked -p noctua` compiles and tests the backend, including chats, MCP permissions and responses, assistant edits and review, library/PDF/media handling, model discovery, and storage relocation/failure recovery. |
| Frontend tests | macOS | `bash tests/run-frontend.sh` runs JavaScriptCore and WebKit checks for syntax, settings, Research views, chat rendering, file attachment upload, draft lifecycle, and PDF page rendering, notes/media, project files, assistant proposal review and edit conflicts, targeted PDF behavior, and responsive layout. |
| Desktop check (macos-latest) | macOS | `cargo check --locked -p noctua-app` for both Apple Silicon and Intel targets. |
| Desktop check (windows-latest) | Windows | `cargo check --locked -p noctua-app` for the native Windows target. |
| Desktop check (ubuntu-22.04) | Ubuntu | `cargo check --locked -p noctua-app` with the Linux Tauri system dependencies installed. |
| Release and workflow checks | Ubuntu | Python and Node release-script tests, workspace/lockfile version consistency, and actionlint validation of all workflow YAML files. |
| Dependency security audit | Ubuntu | `.github/workflows/security.yml` runs `cargo audit --file Cargo.lock` against RustSec's advisory database on PRs, pushes to main, manual runs, and weekly on Mondays at 09:17 UTC. |

Desktop checks type-check the desktop package and compile its build scripts and
required dependencies. They do not link the final application, package installers,
launch the app, or test installation. The macOS check covers both architectures
used in the Universal release; the release workflow still performs the final
linking and packaging.

For pull requests only, desktop checks are skipped when every changed path is
exactly `README.md` or under `docs/`, `web/`, or `tests/`. The release
and workflow job compares the event's base/head commits using their merge base;
it includes both deleted and added paths for renames. Classification uses the
whole PR diff, not just the last pushed commit. Any other path requires
desktop checks, including `src/prompts/*.md`, Rust source, native app assets,
dependencies, and workflow files. An empty/failed comparison conservatively runs
desktop checks. Main pushes containing non-documentation changes and manual runs always run
desktop checks. Backend,
frontend, release/workflow, and security jobs still run for these PRs; desktop
setup and compilation steps are skipped. Each desktop runner only
reports a skip message, keeping all three named checks successful and available
for branch protection. Keep the documentation allowlist aligned with build
inputs if future code starts consuming files under `docs/`.

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

From the repository root:

```sh
cargo test --locked -p noctua
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

Push a working branch and open a PR into `main`. Review all seven checks before
merging, allowing the three desktop checks to be skipped for PRs without native
compilation changes as described above. Fix failures in the same branch; pushing
another commit runs CI again.
For an infrastructure-only change such as CI, a PR verifies the workflow itself
before it reaches `main`.

A direct push to `main` also starts CI, but failures are discovered after the
change has already landed. Prefer PRs for normal changes. Running CI does not
itself block merges or direct pushes: an administrator must configure a main
branch ruleset or branch protection separately and require **Backend tests**,
**Frontend tests**, **Release and workflow checks**, the three **Desktop check**
jobs, and **Dependency security audit**. This change does not
modify repository protection settings.

If a runner or download fails transiently, use **Re-run failed jobs** in Actions.
If a test or workflow fails consistently, inspect its log and correct the cause
rather than bypassing the check.
