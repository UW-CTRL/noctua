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

For desktop development, build the headless binary first, then the Tauri app:

```sh
cargo build --locked -p noctua
cargo install tauri-cli --version "^2" --locked
cd app
cargo tauri dev
# Build installers (also builds and bundles the headless executable):
cargo tauri build
```

Installers appear under `target/release/bundle/`. The bundled local connection
screen opens without starting a data server. `app/prepare-server.py` runs from
the build hook, builds the requested server target and puts it in the bundle's
`binaries/` resources. Universal macOS builds combine both architectures with
lipo. Tauri supplies the target through its [build hook environment](https://v2.tauri.app/reference/config/#buildconfig).
The desktop stages a version/content-addressed durable copy before ensure, so
an app update does not remove a running server's executable.

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
font and dropdown scripts into its offline bundle. For standalone frontend tests, run
`python3 app/prepare-ui.py` first (`tests/run-frontend.sh` does this automatically).
Generated copies in `app/dist/` are ignored; edit the sources in `web/`.

| Path | Responsibility |
| --- | --- |
| `src/` | Rust server, domain models, assistant integration, and MCP tools. |
| `src/prompts/` | Shared and task-specific AI instructions in Markdown. |
| `web/` | Browser UI, PDF reader, note editor, and chat rendering. |
| `app/` | Server-independent connection UI, Tauri native management, bundled server builder, icons and desktop updater. |
| `src/server.rs`, `src/security.rs`, `src/service.rs`, `src/client.rs` | Ownership/CLI, server authentication, local user services and device-local configuration/OS credentials. |
| `tests/` | Frontend checks and manual demo fixtures. |
| `.github/` | CI, security, and release workflows and helpers. |
| `docs/` | User guides, development references, and demo assets. |

Rebuild and restart after changing embedded web assets or prompts.

```sh
cargo test --locked -p noctua
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
| `NOCTUA_CLIENT_HOME` | Device-local connection preferences and staged server binaries |
| `NOCTUA_ORIGINS` | Comma-separated exact HTTPS origins, overriding server-config.json |
| `NOCTUA_SERVICE_HOME` / `NOCTUA_SERVICE_MANAGER` | Isolated definition directory and fake service manager for tests |
| `NOCTUA_SERVER_NAME` | Human-readable name in server identity |

For an assistant CLI not found automatically, you can also set `claude_path` or
`codex_path` in `settings.json`.

## Connection and shutdown transactions

The server control lock spans ensure, stop and restart, including an enabled
service's executable refresh. Migration also locks the source data owner before
copying. Response bodies retain the admitted request count until consumed or
abandoned; safe shutdown refuses an active stream or detached AI/write job.

Native connection callbacks are bound to a window and purpose. The provisional
window and callback are discarded on any error; the old connection is saved only
after the new WebView authenticates and every old editor freezes and flushes.
Failure resumes the old editors. Device preferences use exact shared keys, while
server state and its removal operations share the same namespace.

Note drafts use an editor-owned slot within each server/note namespace. A legacy
slot and multiple editor versions remain available for explicit recovery. An
HTTP success without a valid saved revision does not acknowledge a draft. Test
quota failures together with disconnection, edits during saves/reloads, and
multiple tabs before changing this contract.
