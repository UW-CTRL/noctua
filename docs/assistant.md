# Research assistant

[Documentation](README.md) · [Project README](../README.md)

## Connect and chat

[Connect Codex or Claude Code](getting-started.md#connect-an-assistant-optional)
in **Settings → Research assistant**. Choose a model and preferences there.
Model access and fast-mode availability depend on your CLI and account; fast
mode may cost extra. Providers keep separate conversations and drafts.

Open **Chat** to discuss the current paper, graph, or notes. Use @ to attach a
paper, note, project file, folder, or collection, and **History** to return to earlier conversations. Pause the pointer
over the History or New chat icon to reveal its label below. Keyboard
focus shows the same labels immediately; reduced-motion preferences disable the animation. The assistant
can search papers, explore your library, save papers, read PDFs, annotate
passages, and edit note text through Noctua's tools.

The `@` picker includes every file type in the current project (`.bib`, `.tex`,
images, and more), plus library papers, notes, and collections. Search by filename,
folder path, title, or author; results show their type and location. Choose a result
with the arrow keys and Enter/Tab, or click it. You can mention multiple items.

Text files attach up to 12,000 characters and stable IDs for further reading. The
open file's unsaved draft is included and labeled as such. Folders attach a bounded
listing of descendants; collections also include paper references. They do not
recursively attach every file's contents. Binary/media mentions supply metadata and
IDs rather than uploading their bytes; supported images can be opened with the
agent's image tool. Total attachment context is capped at 60,000 characters.

## Choose an edit mode

| Mode | Behavior |
| --- | --- |
| Suggest (default) | Stores note creation/edits for review and asks inline for project-file approval during chat; PDF annotations/replies remain pending. Requested Library organization and downloads apply immediately. |
| Plan | Investigates and answers without writing changes |
| Direct | Saves supported changes before reporting completion; version checks protect concurrent edits and note edits can be undone |

Choose the mode with the badge below the composer.

## Chat attachments

Drag files onto the chat input, paste clipboard files or screenshots with
Ctrl+V (Cmd+V on macOS), or choose **Attach files** (paperclip) at the right of the toolbar below the
input. The input uses the full composer width. Clipboard file
pasting depends on the browser and operating system; use drag-and-drop or the
file picker if copied files are not available to the browser. Ordinary text
pasting continues to insert text.

Review the upload chips and image thumbnails, and remove unwanted files before sending. Wait for
uploads to finish; failed uploads can be retried or removed. You can send files
without typing a message, or combine attachments with a `/skill-name` command
to use that skill on the files. Each message accepts up to 10 files totaling 32 MB;
PNG, JPEG, GIF, and WebP images must be 5 MB or smaller. The assistant can inspect
these images and read UTF-8 text files. PDFs are indexed locally before upload,
with a limit of 1,000 pages and 8 MB of extracted text. Unlock password-protected
PDFs first. The original PDF is retained: Claude Code uses its native PDF Read
capability in a restricted directory containing only PDFs sent in that conversation
(requires Claude Code 2.1.248 or later). Codex uses rendered PDF page images through
its vision capability; both providers can also request those page images through
Noctua. Keep the chat tab open while uncached pages are rendered. Charts, tables,
handwriting, and scanned pages can be inspected visually without a separate image
attachment or external OCR. This does not create a searchable OCR index, and small
or unclear scans can still be misread. Other binary files can be attached and downloaded, but the assistant cannot interpret their
contents through this feature.

Uploaded files are stored in Noctua's local chat data, independently of Library
and project files. Sending makes them available to the selected assistant through
Noctua's tools; it does not import them into your Library. Sent file links remain
in chat history, and queued uploads are restored per conversation and provider.
Removing a chip removes it from the draft; uploaded local copies are retained.

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

Zotero import is a Library dialog control. Imported notes are ordinary editable
text notes; imported PDF annotations can be read and edited through the existing
annotation tools. Re-importing with Sync preserves local edits and reports conflicting
source changes; Overwrite replaces imported fields with Zotero values. HTML note
formatting and embedded images are not reproduced. A download request for a broken
linked PDF reports failure and requires reconnecting or attaching the original.

Project root is a drag target shown only while dragging project entries. The project sidebar combines its collection selector and creation controls in one row. Hover or keyboard-focus a creation icon to reveal its label below. The collection menu uses fixed indentation for nested folders and highlights the selection without checkmarks. New note or file offers Note, LaTeX (.tex), and File in one compact form. Rows reveal Rename and Trash on hover or keyboard focus. Ctrl-click (Command-click on macOS) adds or removes selections; Shift-click selects a visible range. With the file list focused, Command+A (Ctrl+A on Windows/Linux) selects all visible entries; Delete or Backspace opens one confirmation to move the selection to Trash. Drag a selected row to move the selection together. Drag entries onto folders or onto a destination revealed by hovering over the project selector to move them. Import files opens a review queue for chosen or dropped files before uploading; these remain UI actions.

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
once per file per prompt, inline in chat. Each request has **Allow this file**
and **Decline** buttons and an optional scrollable diff snapshot. Allowing a file
permits further edits to that same file during the response, including after a
rename or move; other files need their own approval. Newly created files keep
their approval for subsequent edits. Permission expires when the response ends
or is stopped. Declining a file does not decline edits to other files.
Revision checks still protect newer user edits. **Direct mode applies file edits
immediately, without approval requests or popups.** Plan is read-only. Note/PDF
suggestions and skill-script execution retain their existing review rules. File deletion
and bibliography activation remain UI actions. See [Notes](notes.md#project-files-bibliographies-and-skills).

Open **Settings → Skills**. **Global Agent Skills → Location** defaults to
`~/.agents/skills`; save another existing folder or choose **Use default**.
Global packages are read in place. **Import Skills from Project** imports multiple
`SKILL.md` packages from a project or skills folder as one named group. Expand
Project A or Project B to browse its skills; **Disconnect** removes only that
group's Noctua copies and leaves originals and other groups unchanged. Imports
are snapshots. Individual folder, ZIP, and `SKILL.md` imports remain available.
See [Skills settings](settings-and-data.md#skills) for limits and reconnection.
Both providers share the available skills. Under **Chat project defaults**,
choose a project, select its skills, and save. These defaults apply to every
message in that project. In the chat input, type `/`
to list available skills, then type to filter by name or description. Use Up/Down
and Enter/Tab, or click a result, to insert its `/skill-name` command; Esc closes
the list. Include a question after the command, or send it alone to invoke the
skill. Commands add those skills for that message alongside the project
defaults, without saving new defaults. Delete a command to remove that invocation.
The assistant can read
enabled instructions and supporting resources. Every bundled script invocation
requires approval of its script, arguments, and inputs, followed by separate
review before applying output changes. Scripts run with local user permissions
on temporary input copies, not inside an OS sandbox. Plan mode cannot request
execution. See the [Notes guide](notes.md#project-files-bibliographies-and-skills)
for package limits, runtimes, and timeouts.

## Assistant reads and review

The assistant searches both remote papers and your saved Library. Long lists and
PDF or note text are read in parts, so you can ask for a quick overview or a
closer reading. It can also read saved AI outlines and paper relationships
without starting new analysis or changing the current graph.

Use **Assistant changes** below the project tree to review pending note and
project file proposals made outside an active chat, including after restarting Noctua.
During chat, project files use the per-file approval cards described above. Accept saves a proposal;
Reject leaves the content unchanged. If the content changed since the proposal
was made, ask for a fresh proposal. Direct edits are saved before the assistant
reports completion, and conflicting edits require resolution.

## AI prompts

Prompts live in [`src/prompts/`](../src/prompts/). Runtime context is added
separately. Prompt instructions work alongside tool permissions and validation.

### Scholar Inbox Screening

**Settings → Integrations → Google Scholar Inbox → Edit prompt** configures a
separate, collection-specific Scholar worker. Replace `<Research Interest>` before
first use. It reads accessible PDF text and uses your selected Research Assistant
provider and model to recommend saving or excluding each paper. It has no tools;
only validated decisions can add matching papers to the destination collection.
The default prompt is in [`scholar-default.md`](../src/prompts/scholar-default.md),
with fixed evidence and document-handling rules in
[`scholar-agent.md`](../src/prompts/scholar-agent.md). See
[Google Scholar Inbox](settings-and-data.md#google-scholar-inbox) for activation,
background polling, retries, and supported documents.

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

## Local drafts and server edits

Finish pending client file uploads, or resolve/remove failed uploads, before
switching servers or installing an update. Attachment drafts stay with their
original server and chat.

During a server update, open editors save and pause while existing AI tasks finish.
An unresolved save/conflict blocks replacement; local drafts are preserved. An
update notice alone does not confirm that unsaved client input reached the server.
Skill approvals and output reviews must be resolved before a server update;
replacement is canceled rather than discarding those session-owned results.

The assistant reads saved server content, not unsaved local input. Multiple editor
drafts remain separate, and another device's edits require conflict resolution.
See [note draft recovery](notes.md#connection-aware-note-drafts) before discarding
a draft or explicitly keeping a local version.

## Server job lifetime

Closing a desktop window, losing the connection or switching servers leaves an
AI reply running on its original server. Reopen that server's chat history to
see its busy state and eventual persisted result. Use **Stop server reply** in
a restored running chat, or the Stop control for the current stream, to request
explicit cancellation. Stopping retains the partial reply. A client disconnect
is not a stop request. Provider changes/new chat retain their explicit stop
behavior for the currently attached stream.
Reopening a running chat restores its pending file-edit approval cards. They
still require an explicit decision; reconnecting never grants edit permission.

## Paper files

The [Paper editor](papers.md) compiles standard LaTeX project files with bundled Tectonic or pdfLaTeX.
The settings gear chooses compiler, main file, and automatic compilation per
collection/project; these compilation controls are UI-only.
Existing project-file tools can read and edit `.tex`, `.cls`, `.sty`, `.bst`, and
`.bib` sources. Use project-relative paths and actual BibTeX keys. Library keys
are not automatically exported to papers. Noctua note-only commands are not valid
paper syntax. Choosing the main document and requesting compilation are UI actions;
there is no new agent compilation tool.

Document Find is a UI-only control: reader searches include PDF text and user-authored comment text, excluding annotation quotes and assistant-authored replies. Editing a primary comment in the reader records user authorship without changing the highlight creator.

The chat assistant can inspect internal workspace files with the read-only
`inspect_workspace` tool in Plan, Suggest, and Direct modes. Ask it to inspect the
LaTeX build log: `paper/build.log` is relative to the collection's `.workspace`.
It can list directories, inspect `paper/out` compiler logs, and read the end of long
logs. Reads are limited to 64 KiB per call and directory pages to 200 entries;
the agent can request additional pages. Binary files expose metadata only.
This tool does not trigger compilation or edit generated files.

The paper preview supports double-click PDF-to-source navigation via SyncTeX.
It opens the corresponding project source and centers the line; this is a UI
control, separate from the assistant’s read-only build-log inspection.

## Collection research details

Library collections can store a goal, progress, and personal target dates through
**Research details** in the collection tree. This is currently a UI-only editor;
the assistant's general file tools do not read or edit its hidden
`.workspace/research/` data. Research metadata does not change paper membership,
Notes files, or graph scope. See [Research](research.md#collection-research-details).

The Library creation dialog offers Folder or Research project. The briefcase icon identifies projects. Users can change Folder type in Research details without losing research data. Assistant collection creation defaults to an ordinary folder; project selection and conversion are currently UI controls.

Files copied from a file manager can be pasted into the Library collection list with Command+V or Ctrl+V. PDFs become Library papers; other formats are preserved in that collection’s Notes Project files (up to 32 MB each). Binary formats may only support download rather than editing. The browser must expose clipboard files.

Project files use image icons for image formats and video icons for video formats; folders and ordinary documents retain their own icons. Icons identify file types and do not imply preview support.

Switch Library, Notes, and Reader with Option+1, Option+2, and Option+3 on macOS, or Alt+1, Alt+2, and Alt+3 on Windows/Linux. Reader requires an open PDF. These shortcuts are inactive while a dialog is open.

Library folders can be moved, ordered, or moved to recoverable Library trash without changing collection IDs or deleting project files. Restore a deleted folder in Library Trash to recover its deletion group. Library paper trash preserves annotations and memberships; bulk management and duplicate review are available in the Library UI. Duplicate merges retain annotation IDs and citation aliases, but refuse different PDFs.

Library Trash supports permanent deletion after confirmation. Permanently deleting a folder removes its owned project notes and files; permanently deleting a paper removes its metadata and annotations. These actions cannot be restored or undone. External original PDFs are preserved.
