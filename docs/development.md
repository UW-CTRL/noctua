# Development

[Project README](../README.md)

## AI prompts

Static AI task instructions live in `src/prompts/` and are embedded at compile
time with `include_str!`. Rust code composes these instructions and adds runtime
inputs such as the current view, selected passages, paper text, and thread data.

Find the file inventory in the [prompt index](../src/prompts/AGENTS.md).

### Delivery and maintenance

| Area | Implementation |
| --- | --- |
| Claude chat and Reader analysis | Instructions passed through `--system-prompt` |
| Codex | Instructions passed through `developer_instructions` |
| Other one-shot tasks | Retain their task-specific input handling |
| Tool descriptions and schemas | Defined in [`src/mcp.rs`](../src/mcp.rs) |
| Applying prompt edits | Rebuild and restart the backend |
| Cached results | May be reused after a prompt change; review the feature's cache policy |
