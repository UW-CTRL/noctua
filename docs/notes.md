# Notes

[Documentation](README.md) · [Project README](../README.md)

Saving progress appears in the shared bottom-right notification. Unsaved state
and save-conflict actions remain beside the note.

## Write in a collection

Select a collection, switch to **Notes**, and use **New note or file** and select **Note**. Notes combine
text, drawing, and media blocks and save automatically. Click text to edit its
source with a live preview; click away to finish. Hover between blocks to insert
content. The **Note guide** question-mark icon at the far right of the note header opens the in-app syntax and editing guide.

## Project files, bibliographies, and skills

The collection menu uses consistent indentation for nested folders and highlights the selected collection without a checkmark.

The project sidebar has one header row with the collection selector and New note
or file, New folder, and Import files icons. Hover or focus one of these icons
to reveal its label underneath without moving the file list. To create a note, choose Note in
the New note or file form; Text file creates a project text file instead. Both
use the name and destination folder in the form. Creation forms use compact aligned fields. Import files opens a compact queue: choose or drop files, remove unwanted selections, then click Import. Each file is limited to 32 MB. Failed uploads keep the remaining files available for retry.

Each collection now has a **Project files** tree alongside the existing block note
editor. Images and videos are grouped in a collapsed Media folder by default; click a
folder to expand it. Files already placed in custom folders stay there, and later manual
moves are preserved. The **New note or file** and **New folder** icons above the tree open an in-app form for the name
and destination folder. Create folders and text files, import files, use the entry menu
to rename/move/remove them, or preview their contents. Removal is recoverable with Undo
or the project Trash, including after a restart. Files use stable IDs, so moves and
renames preserve references. Existing notes and `images/` / `media/` attachments retain
their original storage. General imports support 32 MB; UTF-8 text editing supports 2 MB.
Note media uploads keep their existing larger video limit. This is a file workspace, not
a LaTeX compiler.

**New note or file → Text file** creates an empty text file, using the filename exactly as entered. No
extension is added automatically. For example, use `reading-plan.md`, `draft.tex`,
`references.bib`, or `ideas.txt`. Text files open in the source editor; `.tex` files
do not become block notes or compile to PDF. Select **Note** in the same form for Noctua's block
editor, or **Import** to bring in existing files, including images and videos.

Drag files, notes, or folders onto a folder to move them within the project, or onto Project root to move them out of a folder. Project root appears only while dragging project entries; it is hidden otherwise. Drop onto Trash to open the same in-app removal confirmation. Folder moves include their contents, preserve stable IDs and references, and can be undone. Cross-project moves and moving a folder into itself or its descendants are rejected.

To remove a file or folder, open its **⋯** menu, choose **Move to trash**, then
confirm in the in-app dialog. Folders include their contents; any removed document
closes in the editor. Cancel leaves the project unchanged. Use **Undo** to reverse
the operation, or **Trash** to restore entries later. When restoring individually,
restore the parent folder before its children to preserve their placement.

Import or create a `.bib`, then select the **Bibliographies** icon below the tree to enable it for this
collection. Its keys become available in the normal citation picker alongside library
keys, using the existing author/year display. Duplicate keys must be renamed. Invalid
source remains editable; a visible error marks the retained citation index as out of
date. Clicking an imported citation shows its reference details and DOI/URL when
available. Importing a bibliography does not download its papers.

The collection and save status align with the left end of the divider below
the title. The centered title has extra space above it, follows the divider’s width when space permits, and wraps onto more lines as needed. The pinned controls place **Undo / Redo** at the far left of the writing panel
and **Note guide** and **Preamble and page layout** at the far right, close to
the top edge. Only these controls stay visible at the top while scrolling; the title scrolls with the document. The space between the edge buttons stays transparent and does not block note text or editing. Hover over an icon to see its label; all icons
are keyboard accessible. The project tree highlights the open note or file, with
file actions available on hover or keyboard focus. Project settings and workspace
Undo/Redo sit below the scrolling file list. These buttons and
**Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z** cover note typing, titles, preambles, blocks,
drawings, media edits, and assistant changes. Reader controls cover highlights,
drawings, comment text, replies and deletion. File-tree/text changes are also undoable.
Histories are separate by document/paper/workspace, remain available during the backend
session, and clear when it exits. New edits clear redo. Conflicting saves must be
resolved before undoing; failed operations do not consume history.

Open the **Agent skills** icon below the project tree or in the chat toolbar to import a skill directory, ZIP,
or standalone `SKILL.md`. Packages may contain scripts and supporting resources (up to
512 files / 32 MB). Inspect them before enabling. Packages live in Noctua's `skills/`
directory and work with both Claude and Codex; project enablement can be overridden for
an individual chat.

Every script invocation requires approval showing its source, arguments, and selected
project files. Scripts run with your local user permissions: the temporary working
directory is **not an OS security sandbox**. They receive copies of selected inputs,
have a 120-second time limit, and do not install dependencies. Review proposed file
changes separately before applying them; accepted output forms one undoable transaction.
If the project changed meanwhile, request a fresh run. Python (`python3`), Node
(`node`), and shell (`sh`) must already be installed for their respective script types.
Plan mode cannot request script execution.

Workspace manifests and immutable file versions live under each collection's notes
directory (`.workspace/manifest.json` and `.files/`). Back up the entire configured
Noctua data directory; storage relocation includes project files and imported skills.
Temporary script work directories are removed after execution; approval/results and undo
histories are session-only.

In Settings → Appearance → Fonts, Note font applies to the title, body, collection/save metadata, and empty-block writing hint. Title size (12–36 px, default 28 px) and Body size (12–26 px) are independent, apply
immediately, and are saved for this browser or desktop profile. Collection and save-status text stay at 14 px.

## LaTeX, citations, and links

Notes support a LaTeX subset: inline and display math, numbered equations,
sections, lists, theorem-like environments, proofs, and custom commands.
For example:

```latex
\section{Main idea}
The state evolves as $x_{t+1} = f(x_t, u_t)$.
\begin{equation}\label{eq:cost}
J = \sum_{t=0}^{T} c(x_t, u_t)
\end{equation}
We minimize the cost in \eqref{eq:cost}.
```

Use `\label`, `\ref`, and `\eqref` to link within a note. Type `\cite{` to pick
a paper from the collection or an enabled imported bibliography, or `[[` to link another note. The gear at the far right of the note header
opens a preamble for shared commands and page layout.

This is not a full TeX installation: arbitrary packages and TikZ are unsupported.
Chat Markdown and Mermaid use a separate renderer.

## Drawings and media

Add a drawing pad for handwritten notes. Its **TeX** button uses the selected
assistant to insert a LaTeX transcription below while preserving the drawing.

The [transcription prompt](../src/prompts/handwriting.md) specifies supported
LaTeX and how diagrams are represented. See
[AI prompts](assistant.md#dedicated-ai-features) for the task's input and output.

Paste or drop images and videos, or choose **Image / Video** between blocks.
Media supports captions, labels, and side-by-side layouts. A YouTube URL alone
on a source line embeds a player. Local video uses Noctua's `\includevideo`
command; playback is not standard LaTeX export behavior.

## Assistant edits

The assistant can read notes, inspect attached images, and propose or apply
text-block edits. Drawing transcription uses the pad's TeX control; chat image
tools do not read drawing strokes or videos. Whole-note management, preamble
changes, media insertion, and layout controls remain UI actions.

Use **Suggest** to review edits, **Plan** for read-only discussion, or **Direct**
for immediate changes with note-edit undo. Attach a note with @ in chat or select
rendered text and choose **Add to chat**. See [Research assistant](assistant.md).
