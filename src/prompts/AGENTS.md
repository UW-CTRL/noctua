# Prompt conventions

Keep the prompt inventory below current when adding or removing task prompts.
Store static task instructions as Markdown, embedded explicitly with
`include_str!`; keep runtime context composition in Rust.

Preserve prompt contents and provider-specific delivery when moving files unless
a behavior change is intended. For instruction changes, review validation,
cached analysis, and the relevant feature guide. Follow
[Feature synchronization](../../docs/development.md#feature-synchronization).
Rebuild and restart the backend to apply prompt edits.

This file is a contributor reference, not an app task prompt.

## Shared chat prompts

| File | Purpose |
| --- | --- |
| [`chat.md`](chat.md) | Base research assistant instructions |
| [`notes.md`](notes.md) | Note syntax, editing capabilities, and tool limits; appended to chat |
| [`chat-formatting.md`](chat-formatting.md) | Chat rendering and source attachments; appended to chat |

## Edit mode prompts

| File | Purpose |
| --- | --- |
| [`mode-suggest.md`](mode-suggest.md) | Targeted note-edit suggestions for user review |
| [`mode-plan.md`](mode-plan.md) | Read-only investigation and planning |
| [`mode-direct.md`](mode-direct.md) | Immediate requested edits |

## Dedicated task prompts

| File | Purpose |
| --- | --- |
| [`pdf-outline.md`](pdf-outline.md) | Grounded PDF outline generation |
| [`pdf-autohighlight.md`](pdf-autohighlight.md) | Categorized PDF auto-highlighting |
| [`handwriting.md`](handwriting.md) | Handwriting-to-LaTeX transcription |
| [`lineage.md`](lineage.md) | Research thread summaries |
| [`text-task.md`](text-task.md) | Tool-free text task instructions for the Codex worker |
