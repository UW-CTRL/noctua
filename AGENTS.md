# Repository conventions

Write source comments, UI text, documentation, prompts, and test fixtures in English.

## Keep note features and the assistant in sync

Whenever adding or changing a note feature, update these together in the same change:

- Its implementation and relevant validation.
- `src/prompts/notes.md`, the note capability guide included in the system prompt for both Claude and Codex.
- The user-facing note guide in `showNoteHelp()` in `web/notes.js`, and relevant README documentation.
- MCP tool descriptions or schemas in `src/mcp.rs` when the available tool behavior changes.

Describe supported syntax, how users activate the feature, and what the assistant can actually do with the available tools. Clearly distinguish UI-only controls from assistant actions. Do not claim a tool exists unless it is implemented. Keep examples valid for Noctua's actual LaTeX subset. Backend prompt changes require rebuilding and restarting the backend before they affect running chats.

For changes to chat rendering, update `src/prompts/chat-formatting.md`, relevant
README documentation, and rendering checks together. Keep chat Markdown and
note LaTeX capabilities distinct in both the UI and assistant guidance.
