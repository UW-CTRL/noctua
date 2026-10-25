# Research assistant

[Documentation](README.md) · [Project README](../README.md)

## Connect and chat

[Connect Codex or Claude Code](getting-started.md#connect-an-assistant-optional)
in **Settings → Research assistant**. Choose a model and preferences there.
Model access and fast-mode availability depend on your CLI and account; fast
mode may cost extra. Providers keep separate conversations and drafts.

Open **Chat** to discuss the current paper, graph, or notes. Use @ to attach a
paper or note, and **History** to return to earlier conversations. Pause the pointer
over the Skills, History, or New chat icon to reveal its label below. Keyboard
focus shows the same labels immediately; reduced-motion preferences disable the animation. The assistant
can search papers, explore your library, save papers, read PDFs, annotate
passages, and edit note text through Noctua's tools.

## Choose an edit mode

| Mode | Behavior |
| --- | --- |
| Suggest (default) | Stores note creation/edits and project file proposals for review; PDF annotations/replies remain pending. Requested Library organization and downloads apply immediately. |
| Plan | Investigates and answers without writing changes |
| Direct | Saves supported changes before reporting completion; version checks protect concurrent edits and note edits can be undone |

Choose the mode with the badge below the composer.

## Chat attachments

Select text in a PDF, note, paper details, or chat message, then choose
**Add to chat**. You can attach multiple passages, preview their sources, and
remove entries before sending. These attachments do not change saved annotations.

In the Reader, click a detected figure, table, or algorithm to attach its caption
and location. The assistant can inspect the original PDF page for visual details;
the attachment itself is not an uploaded image crop. Detection may miss scanned
or unusually formatted objects. Attaching sources is a UI action, not a chat tool.

## Capabilities and limits

The assistant can download available PDFs, search indexed text, view rendered
pages, and annotate exact passages. Keep a Noctua chat tab open when it needs
uncached PDF text or page images. Scanned PDFs do not gain OCR.

Bulk AI outlines and auto-highlighting are [Reader controls](reader.md), while
chat tools annotate individual passages. See [Notes](notes.md#assistant-edits)
for note-editing boundaries.

Project root is a drag target shown only while dragging project entries. The project sidebar combines its collection selector and creation controls in one row. Hover or keyboard-focus a creation icon to reveal its label below. The collection menu uses fixed indentation for nested folders and highlights the selection without checkmarks. New note or file offers Note and Text file in one compact form. Import files opens a review queue for chosen or dropped files before uploading; these remain UI actions.

The collection and save status align with the left end of the divider below
the title. The centered title has extra space above it, follows the divider’s width when space permits, and wraps onto more lines as needed. Only Undo/Redo at the left edge and Note guide and preamble icons at the right edge stay pinned close to the top while scrolling. The editable title scrolls with the document. Only the edge button groups have backgrounds; the center stays transparent and does not block note text or editing. The title, collection/save metadata, and empty-block writing hint use Note font; Settings → Appearance → Fonts provides separate Title size and Body size controls. Collection and save-status text stay at 14 px. These are UI controls.

Chat renders Markdown, math, tables, code blocks, collapsible explanations, and
Mermaid diagrams. Notes use their own LaTeX subset.

Credentials stay in the CLI's credential store. Context sent to an assistant is
processed through that provider's CLI and account; local storage does not mean
local AI inference.

## Project files and imported skills

The assistant can list and read project files, create or edit text files, and
rename or move entries using stable IDs and revision checks. Suggest mode asks
for review; Direct applies supported changes; Plan is read-only. File deletion
and bibliography activation remain UI actions. See [Notes](notes.md#project-files-bibliographies-and-skills).

Open the **Agent skills** icon below the project tree or the skills icon in the chat toolbar to import a skill folder, ZIP,
or `SKILL.md`. Packages are stored inside Noctua, shared by Claude and Codex, and
enabled per project with optional per-chat overrides. The assistant can read
enabled instructions and supporting resources. Every bundled script invocation
requires approval of its script, arguments, and inputs, followed by separate
review before applying output changes. Scripts run with local user permissions
on temporary input copies, not inside an OS sandbox. Plan mode cannot request
execution. See the [Notes guide](notes.md#project-files-bibliographies-and-skills)
for package limits, runtimes, and timeouts.

## Tool results and limits

The MCP catalog currently has 35 tools (25 in Plan). It separates remote paper
search from `search_library`, which searches saved local papers. `get_paper`
accepts either a remote `paper_id` or a local `paper_key`; local details include
citation keys, revision, PDF status, and direct collection memberships.
`update_paper_memberships` organizes multiple saved papers across projects,
reports each result, and never deletes a Library paper. `edit_collection` creates
or renames collections. `create_note` makes a block note; creating a text file is
a separate operation. `get_paper_relations` reads citation/recommendation
snapshots without changing the window. `read_pdf_outline` reads saved AI outlines
without starting analysis. `view_note_drawing` renders saved handwriting.

Lists return `items`, `total`, `has_more`, and `next_offset` where the source
supports paging. Text reads use Unicode character offsets and return their
continuation position. PDF reads return at most 20 pages and 40,000 characters,
with smaller defaults; use `next_page` and `next_char_offset` to continue.
PDF search returns paged matching-line excerpts instead of silently dropping
matches after 50 pages. A long line's excerpt reports its offset and truncation.
Remote paper search returns at most 30 results per call. Citation snapshots have
explicit upstream limits and do not claim to cover the entire corpus.

Note reads return `updated` for edits; workspace reads return `revision`.
`read_note` can select block IDs and read long blocks in parts. Its preamble
preview is bounded; use `view=preamble` to continue reading macros. Use
`list_project_files` with `include_bibliography=true` for paged citation metadata.
The default omits internal blob hashes, undo history, and full BibTeX fields.
Workspace snapshots do not auto-organize media. File writes return affected IDs,
the new version, and bibliography errors rather than the whole workspace.

**Assistant changes** below the project tree lists durable pending note/file
proposals. The review dialog can accept or reject them; accepting uses the
original version and rejects stale proposals. `get_edit_proposal` reads status
but cannot approve a proposal. Direct changes report `applied` only after saving;
view operations report `ui_requested`, not confirmation that a window opened.

Skill requests/status omit script source, filesystem roots and base64 outputs.
`get_skill_run` can page `stdout`/`stderr` or a selected file's `diff`; the review
UI retains full scripts and output bytes for user approval. PDF annotation lists
omit geometry and reply bodies by default. `include_geometry` and
`include_replies` explicitly request details, with page/kind/status filters.

Write tools optionally accept `request_id`. Retrying the same successful call
with identical arguments returns its saved response; changing the arguments
with that ID fails. This cache is scoped to the backend data root, chat, mode,
and tool, bounded to 256 responses, and lasts only for the backend session.
After restarting or cache eviction, inspect current state before retrying a
non-idempotent operation. Errors carry codes such as `CONFLICT`, `NOT_FOUND`,
`INVALID_ARGUMENT`, or `UI_REQUIRED`. Partial download failures preserve the
saved paper key. Always inspect pending states and per-item failures.

The server is still localhost-only, with Host/Origin checks. The edit mode and
chat ID are not authentication or per-project authorization. Cached PDF text,
pages and drawings can be read without a renderer; uncached content requires an
active Noctua chat and reports `UI_REQUIRED` otherwise. The old MCP names
`add_to_zotero` and `list_zotero_folders` and the duplicate `/api/zotero/*`
Library routes have been removed. Use `save_to_library`,
`list_library_collections`, and `/api/library/*`. The optional read-only Zotero
importer remains available.

## AI prompts

Prompts live in [`src/prompts/`](../src/prompts/). Runtime context is added
separately. Prompt instructions work alongside tool permissions and validation.

### Shared chat instructions

Chat combines all three prompts:

| Prompt | Instructions |
| --- | --- |
| [`chat.md`](../src/prompts/chat.md) | Research role, request scope, current view, source links, and truthful outcome reporting. |
| [`notes.md`](../src/prompts/notes.md) | Supported note syntax, references, media, and document semantics. |
| [`chat-formatting.md`](../src/prompts/chat-formatting.md) | Markdown, math, Mermaid, and source attachment interpretation. |

Tool arguments, result formats, limits, and tool-specific mode behavior are
delivered through the MCP catalog. The shared prompts keep common behavioral
rules and note/chat syntax rather than repeating those contracts.

### Edit mode instructions

Each message adds the selected mode. Tools also enforce the mode.

| Mode and prompt | Behavior |
| --- | --- |
| [Suggest](../src/prompts/mode-suggest.md) | Preference for small, targeted changes for user review. |
| [Plan](../src/prompts/mode-plan.md) | Investigation and planning without changing user data. |
| [Direct](../src/prompts/mode-direct.md) | Only requested direct changes, preserving unrelated content. |

### Dedicated AI features

These use separate task prompts rather than the combined chat instructions.

| Feature and prompt | Input and instructions | Output |
| --- | --- | --- |
| [PDF outline](../src/prompts/pdf-outline.md) | Page text; ground headings in exact quotes and PDF page numbers. | Validated JSON section tree. |
| [Auto-highlight](../src/prompts/pdf-autohighlight.md) | Page text; choose exact, non-overlapping quotes in four categories. | Validated highlights with brief English explanations. |
| [Handwriting](../src/prompts/handwriting.md) | Drawing image; preserve wording, use supported LaTeX, mark diagrams. | LaTeX source inserted below the drawing. |
| [Lineage](../src/prompts/lineage.md) | Titles, abstract excerpts, IDs, and citation steps; explain research threads. | JSON themes, key papers, and relationships. |

### Workers and maintenance

| Area | Behavior |
| --- | --- |
| [Text worker](../src/prompts/text-task.md) | Codex instruction to answer without tools; used by Lineage. |
| Execution | Reader analysis and handwriting run separately from chat; Reader workers have no tools. |
| Editing | Source files only; no Settings prompt editor. `AGENTS.md` governs repository work. |
| Applying changes | Rebuild and restart; cached analysis may be reused. See [Development](development.md#ai-prompts). |
