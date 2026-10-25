# Development

[Documentation](README.md) · [Project README](../README.md)

## Run and build

Build the independent server and CLI, then use a separate development profile:

```sh
cargo build --locked -p noctua
NOCTUA_HOME=/absolute/isolated/data target/debug/noctua ensure
NOCTUA_HOME=/absolute/isolated/data target/debug/noctua token
```

Open the returned URL and sign in with the token. Ensure reuses the verified
owner or detaches a separate process; it never registers login auto-start.
Use `status`, `stop`, or `restart` to manage this server explicitly. Closing an
interface leaves server jobs running. See [Server operations](server.md).

For desktop development, build the headless server above before starting Tauri.
The desktop and browser connect to the same authenticated backend.

## Project structure and checks

The Rust backend in `src/` embeds the HTML/CSS/JavaScript interface in `web/`.

| Path | Responsibility |
| --- | --- |
| `src/` | Rust server, domain models, assistant integration, and MCP tools. |
| `src/prompts/` | Shared and task-specific AI instructions in Markdown. |
| `web/` | Browser UI, PDF reader, note editor, and chat rendering. |
| `app/` | Tauri desktop shell, native controls, icons, and updater. |
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
| `NOCTUA_PORT` | Preferred loopback server port; default 47878, recorded fallback reuse |
| `NOCTUA_PROFILE_HOME` | Isolated profile root for migration tests |
| `NOCTUA_CLIENT_HOME` | Device-local configuration and staged server executables |
| `NOCTUA_ORIGINS` | Allowed private HTTPS origins |
| `NOCTUA_DEBUG` | Log requests |

For an assistant CLI not found automatically, you can also set `claude_path` or
`codex_path` in `settings.json`.
