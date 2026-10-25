# Research assistant

[Documentation](README.md) · [Project README](../README.md)

## Connect and chat

[Connect Codex or Claude Code](getting-started.md#connect-an-assistant-optional)
in **Settings → Research assistant**. Choose a model and preferences there.
Model access and fast-mode availability depend on your CLI and account; fast
mode may cost extra. Providers keep separate conversations and drafts.

Open **Chat** to discuss the current paper, graph, or notes. Use @ to attach a
paper or note, and **History** to return to earlier conversations. The assistant
can search papers, explore your library, save papers, read PDFs, annotate
passages, and edit note text through Noctua's tools.

## Choose an edit mode

| Mode | Behavior |
| --- | --- |
| Suggest (default) | Proposes note edits, project file changes, and PDF annotations/replies for Accept/Reject |
| Plan | Investigates and answers without writing changes |
| Direct | Applies supported changes immediately; note edits can be undone |

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
the title. The centered title has extra space above it, follows the divider’s width when space permits, and wraps onto more lines as needed. Only Undo/Redo at the left edge and Note guide and preamble icons at the right edge stay pinned close to the top while scrolling. The editable title scrolls with the document. Only the edge button groups have backgrounds; the center stays transparent and does not block note text or editing. These are UI controls.

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

## AI prompts

Prompts live in [`src/prompts/`](../src/prompts/). Runtime context is added
separately. Prompt instructions work alongside tool permissions and validation.

### Shared chat instructions

Chat combines all three prompts:

| Prompt | Instructions |
| --- | --- |
| [`chat.md`](../src/prompts/chat.md) | Research role, tools, current view, source links, and download confirmation. |
| [`notes.md`](../src/prompts/notes.md) | Supported LaTeX, targeted block edits, and UI-only boundaries. |
| [`chat-formatting.md`](../src/prompts/chat-formatting.md) | Markdown, math, Mermaid, and source attachment interpretation. |

### Edit mode instructions

Each message adds the selected mode. Tools also enforce the mode.

| Mode and prompt | Behavior |
| --- | --- |
| [Suggest](../src/prompts/mode-suggest.md) | Targeted edits; note edits and PDF annotations/replies await acceptance. |
| [Plan](../src/prompts/mode-plan.md) | Read-only investigation; write tools are unavailable. |
| [Direct](../src/prompts/mode-direct.md) | Requested changes apply immediately; note edits support undo. |

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
