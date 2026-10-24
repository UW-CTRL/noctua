# Continuous integration

`.github/workflows/ci.yml` runs on pull requests targeting `main`, pushes to
`main`, and manual execution. Each PR update starts fresh checks and cancels
older runs for that PR. Jobs have read-only repository access and no release or
deployment steps. The separate release workflow still builds installers only
for version tags or an explicit manual release run.

## Checks

| Check | Runner | Coverage |
| --- | --- | --- |
| Backend tests | Ubuntu | `cargo test --locked -p noctua` compiles and tests the backend, including chats, tool isolation, library/PDF/media handling, model discovery, and storage relocation/failure recovery. |
| Frontend tests | macOS | `bash tests/run-frontend.sh` runs the JavaScriptCore checks for syntax, settings, models, typography, chat Markdown, notes/media, and targeted PDF behavior, plus WebKit checks for chat rendering, fonts, and dropdowns. |
| Release and workflow checks | Ubuntu | Python and Node release-script tests, workspace/lockfile version consistency, and actionlint validation of all workflow YAML files. |

Backend assistant tests use the fake CLI fixture; CI does not log into assistant
accounts or make real model inference requests. Frontend tests use mocks or
bundled browser assets rather than testing live third-party services. The
workflow does not produce or upload installers, create tags, or publish releases.

The frontend runner automatically includes `tests/*.swift` except the two
explicit WebKit launchers, which it invokes separately with selected fixtures.
The full PDF rendering integration fixtures (`tests/reader.html` and
`tests/pdf-reader.html`) remain manual because that suite has a known timeout.
Targeted PDF navigation, selection, zoom, theme, and reader-detail checks still
run in CI. CI success does not guarantee all PDF rendering, visual layout,
installation, upgrades, or live provider behavior works.

## Run locally

From the repository root:

```sh
cargo test --locked -p noctua
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
node --test .github/scripts/prepare-release.test.cjs
actionlint .github/workflows/*.yml
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

Push a working branch and open a PR into `main`. Review all three checks before
merging. Fix failures in the same branch; pushing another commit runs CI again.
For an infrastructure-only change such as CI, a PR verifies the workflow itself
before it reaches `main`.

A direct push to `main` also starts CI, but failures are discovered after the
change has already landed. Prefer PRs for normal changes. Running CI does not
itself block merges or direct pushes: an administrator must configure a main
branch ruleset or branch protection separately and require **Backend tests**,
**Frontend tests**, and **Release and workflow checks**. This change does not
modify repository protection settings.

If a runner or download fails transiently, use **Re-run failed jobs** in Actions.
If a test or workflow fails consistently, inspect its log and correct the cause
rather than bypassing the check.
