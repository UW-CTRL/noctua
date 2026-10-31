# Development

[Documentation](README.md) · [Project README](../README.md)

## Run and build

Install [Rust](https://rustup.rs), then run from the repository root:

```sh
cargo build --locked -p noctua
NOCTUA_HOME=/absolute/isolated/data target/debug/noctua ensure
NOCTUA_HOME=/absolute/isolated/data target/debug/noctua token
```

Open the URL returned by ensure in a browser and sign in with the token. The
server remains running after ensure exits. Stop that isolated server explicitly
with `NOCTUA_HOME=/absolute/isolated/data target/debug/noctua stop`. Never use
production data for tests. See [Server operations](server.md) for CLI semantics.

For an optimized standalone binary, run `cargo build --locked --release -p noctua`.
This builds only the server and embedded web interface, without Tauri or desktop
system libraries. See [Standalone installation](server.md#standalone-installation)
for release downloads and runtime requirements.

For desktop development, build the headless binary first, then the Tauri app:

```sh
cargo build --locked -p noctua
cargo install tauri-cli --version "^2" --locked
cd app
cargo tauri dev
# Build installers (also builds and bundles the headless executable):
cargo tauri build
```

Platform configuration builds DMG on macOS, NSIS EXE on Windows, and AppImage
plus DEB on Linux. macOS updates require manual DMG installation.
Installers appear under `target/release/bundle/`. The bundled local connection
screen opens without starting a data server. The build hook explicitly uses the
native app directory (`cwd: "."`); its default frontend-root working directory
is outside `app/`. `app/prepare-server.py` puts the requested server in the bundle's `binaries/`
resources. By default it builds the server locally. To reuse a prebuilt executable,
set `NOCTUA_SERVER_BINARY` to its absolute path and `NOCTUA_SERVER_SHA256` to its
SHA-256 digest before `cargo tauri build`. The hook checks the digest and executable
header against the desktop target and never falls back to compilation when an
explicit prebuilt binary is invalid. Official releases use current-run server
artifacts this way. Universal macOS builds combine both architectures with
lipo. Tauri supplies the target through its [build hook environment](https://v2.tauri.app/reference/config/#buildconfig).
The desktop stages a content-addressed durable copy before ensure, so
an app update does not remove a running server's executable.

The desktop links `noctua-client`, which owns connection and lifecycle plumbing,
instead of the research backend. Workspace web assets remain embedded in the
server, so changing the reader, notes, library or chat UI still needs a server
build and replacement. Native shell changes can use an existing verified server
binary. API/data compatibility versions are shared by the client crate; package
release versions are independent and never substitute for those checks.

Use `NOCTUA_HOME` and `NOCTUA_CLIENT_HOME` pointing to separate temporary folders
for parallel development. A second port does not permit a second writer to the
same data. `NOCTUA_SERVICE_HOME` redirects generated definitions and
`NOCTUA_SERVICE_MANAGER` substitutes a fake manager executable for tests; always
set both for service tests. Do not install a real service during development.
Server web assets are embedded: rebuild, explicitly stop/restart your isolated
server, then refresh. Rebuilding the desktop alone does not update a running
server. Platform prerequisites are in the [release workflow](../.github/workflows/release.yml).

## Project structure and checks

The Rust backend in `src/` embeds the HTML/CSS/JavaScript interface in `web/`.

`web/ui.css` owns shared theme tokens and controls. Connection and sign-in layouts
use `web/connection.css`; the desktop build copies these and the shared appearance,
font, dropdown and shared update-dialog scripts into its offline bundle. For standalone frontend tests, run
`python3 app/prepare-ui.py` first (`tests/run-frontend.sh` does this automatically).
Generated copies in `app/dist/` are ignored; edit the sources in `web/`.

| Path | Responsibility |
| --- | --- |
| `src/` | Rust server, domain models, assistant integration, and MCP tools. |
| `src/prompts/` | Shared and task-specific AI instructions in Markdown. |
| `web/` | Browser UI, PDF reader, note editor, and chat rendering. |
| `app/` | Server-independent connection UI, Tauri native management, bundled server builder, icons and desktop updater. |
| `crates/client/` | Client protocol, API/data compatibility versions, device-local credentials, storage/lifecycle management, signed server downloads and detached update transactions. Desktop depends on this crate instead of the research backend. |
| `src/server.rs`, `src/server_launch.rs`, `src/maintenance.rs`, `src/security.rs` | Server identity, SQLite backup, private launch-environment capture, editor acknowledgments and authentication. |
| `src/research.rs`, `web/research.js` | Revisioned collection goals, progress, and personal target dates; durable hidden `.workspace/research/` storage and its editor. |
| `crates/client/src/server_resources.rs` | Atomically stage packaged compilers with the independent server and retire them after verified replacement. |
| `tests/` | Frontend checks and manual demo fixtures. |
| `.github/` | CI, security, and release workflows and helpers. |
| `docs/` | User guides, development references, and demo assets. |

Rebuild and restart after changing embedded web assets or prompts.

```sh
cargo test --locked -p noctua -p noctua-client
# macOS frontend checks:
bash tests/run-frontend.sh
```

Follow [AGENTS.md](../AGENTS.md). Keep note and chat documentation, assistant
prompts, tool descriptions, and relevant validation in sync when features change.
See [CI](ci.md) for coverage and known gaps, and [Releasing](releases.md) for
versioning, packaging, and publication.

## Feature synchronization

Update these together in the same change:

| Change | Required updates |
| --- | --- |
| User-visible behavior | Implementation, relevant validation, and the affected guide from the [documentation index](README.md). Explain activation, behavior, and limits. |
| Note features | [`notes.md` prompt](../src/prompts/notes.md), `showNoteHelp()` in `web/notes.js`, [Notes](notes.md), and relevant [assistant guidance](assistant.md). |
| Chat rendering | [`chat-formatting.md`](../src/prompts/chat-formatting.md), [assistant guidance](assistant.md), and rendering checks. |
| Tool behavior | Descriptions and schemas in [`src/mcp.rs`](../src/mcp.rs) and [`src/mcp_data.rs`](../src/mcp_data.rs); review prompts for stale claims without copying tool contracts into them. |
| Overview or navigation | Affected project README summaries and links; add new guides to the [documentation index](README.md). |

Describe supported syntax, activation, and actual assistant capabilities. Separate
UI-only controls from tool actions, and do not claim unimplemented tools. Keep
examples valid for Noctua's LaTeX subset and distinguish it from chat Markdown.
The shared note syntax prompt is included in both Claude and Codex chat instructions.
Backend prompt changes require rebuilding and restarting before they affect chats.

## AI prompts

Static AI task instructions live in `src/prompts/` and are embedded at compile
time with `include_str!`. Rust code composes these instructions and adds runtime
inputs such as the current view, selected passages, paper text, and thread data.
See [Research assistant → AI prompts](assistant.md#ai-prompts) for how each
feature's instructions are written and what outputs they request.

Find the file inventory in the [prompt index](../src/prompts/AGENTS.md).

### Delivery and maintenance

| Area | Implementation |
| --- | --- |
| Claude chat and Reader analysis | Instructions passed through `--system-prompt` |
| Codex | Instructions passed through `developer_instructions` |
| Other one-shot tasks | Retain their task-specific input handling |
| Tool descriptions and schemas | Delivered through MCP from [`src/mcp.rs`](../src/mcp.rs) and [`src/mcp_data.rs`](../src/mcp_data.rs) |
| Applying prompt edits | Rebuild and restart the backend |
| Cached results | May be reused after a prompt change; review the feature's cache policy |

## Chat PDF inspection

Claude chats with attached PDFs run with `--restricted --tools Read` in a
conversation-specific directory holding copies of that conversation's sent PDFs.
Claude Code 2.1.248 or later is required for restricted mode. No shell or editing
tools are enabled; Noctua MCP still enforces the selected edit mode. Existing CLI
sessions resume by ID, including sessions created before these directories existed.

Codex CLI accepts images rather than raw PDF attachments. Noctua reuses its bundled
PDF.js renderer to return requested original pages as MCP image content to the
provider's vision model. This follows the render-and-inspect PDF workflow without
requiring an installed PDF skill, Python, Poppler, or enabling Codex shell execution.
The bundled PDF.js text reader uses `getReader()` rather than stream async
iteration to support older WebKit. The attachment regression fixture removes
`ReadableStream` async iteration before indexing and rendering real PDFs.
PDF page previews are capped at 5 MB, cached locally, and checked against the
conversation's attachment grants before being returned. Cached previews remain
readable when no renderer is active; new previews require an active chat tab.

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `NOCTUA_HOME` | Data folder |
| `NOCTUA_S2_KEY` | Semantic Scholar key |
| `ZOTERO_DATA_DIR` | Zotero source folder |
| `NOCTUA_NOTES` | Notes folder |
| `NOCTUA_CLAUDE` / `NOCTUA_CODEX` | Assistant CLI paths |
| `NOCTUA_PORT` | Preferred loopback server port; default 47878, free-port fallback on conflict |
| `NOCTUA_PROFILE_HOME` | Isolated server profile/config root; preserves migration locking in tests |
| `NOCTUA_SERVER_BINARY` / `NOCTUA_SERVER_SHA256` | Verified prebuilt executable for desktop packaging; unset for a local server build |
| `NOCTUA_CLIENT_HOME` | Device-local connection preferences and staged server binaries |
| `NOCTUA_ORIGINS` | Comma-separated exact HTTPS origins, overriding server-config.json |
| `NOCTUA_SERVICE_HOME` / `NOCTUA_SERVICE_MANAGER` | Isolated definition directory and fake service manager for tests |
| `NOCTUA_SERVER_NAME` | Human-readable name in server identity |

For an assistant CLI not found automatically, you can also set `claude_path` or
`codex_path` in `settings.json`.

## Connection and shutdown transactions

A per-client-profile machine owner lock permits one local server across data
folders; the separate data owner lock still protects each folder. The global
manager lock spans ensure, stop, restart and updates, including an enabled
service's executable refresh. Migration also locks the source data owner before
copying. Response bodies retain the admitted request count until consumed or
abandoned; safe shutdown refuses an active stream or detached AI/write job.

Native connection callbacks are bound to a window and purpose. The provisional
window and callback are discarded on any error; the old connection is saved only
after the new WebView authenticates and every old editor freezes and flushes.
Failure resumes the old editors. Device preferences use exact shared keys, while
server state and its removal operations share the same namespace.
Shell pauses have separate connection and maintenance owners. Releasing either
must leave editors inert while the other owner remains; regress both completion
orders and maintenance disconnection during a native connection change.

Note drafts use an editor-owned slot within each server/note namespace. A legacy
slot and multiple editor versions remain available for explicit recovery. An
HTTP success without a valid saved revision does not acknowledge a draft. Test
quota failures together with disconnection, edits during saves/reloads, and
multiple tabs before changing this contract.

## Server update regression

Build the normal server, then `python3 tests/build-update-fixture.py` to build a
fictional next patch version offline under ignored `target/` sources. Run
`python3 tests/server-update.py` with temporary data/client profiles only. The
fixture exercises a real version change, active work, client acknowledgments,
concurrent ensure, complete snapshots, executable cleanup, launch-environment
preservation, service-start/refresh failures, cold retry and downgrade fencing.
No updater download or resident-service installation is used.
The detached `update` CLI accepts `--grace-seconds` and `--timeout-seconds`; use
short durations only in isolated tests. `--force` tests an identical binary
replacement without bypassing editor acknowledgments or active-work draining.
On macOS, also build `python3 tests/build-update-fixture.py --previous` and run
`python3 tests/desktop-update.py`. It launches a uniquely identified test app,
expires the prior desktop editor presence, quits during the automatic upgrade,
verifies the detached worker finishes,
then reopens the actual WebView against the replacement. Test profiles/services
are isolated; never substitute production paths.

## Managed paper compilers

Before running or packaging the paper editor, run both setup scripts:

```sh
python3 scripts/setup-tectonic.py
python3 scripts/setup-pdflatex.py
```

Current macOS releases target Apple Silicon, so the default Tectonic setup is
sufficient on an Apple Silicon Mac. pdfLaTeX retains its upstream Universal binaries.
Scripts verify pinned
archive checksums and prepare ignored `target/tectonic` and `target/texlive`.
They do not install system TeX or change the user's PATH. Desktop resources include
both distributions and their license notices; release and desktop CI prepare them
automatically. pdfLaTeX uses TinyTeX 2026.10 plus JMLR/algorithm2e/SyncTeX from the fixed
2026-10-01 TeX Live archive. Update the setup stamp and backend compiler version
together when upgrading, so cached output is invalidated.

`python3 tests/paper-integration.py` exercises both real compilers against isolated
projects after `cargo build --bin noctua`. Tectonic's first run downloads resources;
pdfLaTeX uses bundled packages. Startup is bounded; stage progress, periodic Python
stack traces and isolated server logs diagnose a stalled CI run. Windows compiler
resources use ordinary drive/UNC paths; TeX Live cannot resolve its programs from
verbatim-prefixed executable arguments. Backend unit tests
need neither distribution.
Use `swift tests/reader.swift tests/paper.html` on macOS for paper UI checks.

`tests/server-paper-lifecycle.py` uses isolated packaged fake compilers to verify
build ownership during stop/update, app-bundle removal, persisted output and
retired compiler cleanup. It runs in backend CI without installing TeX or services.

`src/library_management.rs` implements revision-checked Library bulk operations, recoverable paper/folder trash and undo, collection ordering, and safe duplicate merging. Trash keeps original database rows and immutable file storage; active queries exclude its IDs.
