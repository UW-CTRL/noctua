# Notes

[Documentation](README.md) · [Project README](../README.md)

## Write in a collection

Select a collection, switch to **Notes**, and choose **New note**. Notes combine
text, drawing, and media blocks and save automatically. Click text to edit its
source with a live preview; click away to finish. Hover between blocks to insert
content. The **?** beside the title opens the in-app syntax and editing guide.

## Project files, bibliographies, and skills

Each collection now has a **Project files** tree alongside the existing block note
editor. Images and videos are grouped in a collapsed Media folder by default; click a
folder to expand it. Files already placed in custom folders stay there, and later manual
moves are preserved. The + File and + Folder buttons open an in-app form for the name
and destination folder. Create folders and text files, import files, use the entry menu
to rename/move/remove them, or preview their contents. Removal is recoverable with Undo
or the project Trash, including after a restart. Files use stable IDs, so moves and
renames preserve references. Existing notes and `images/` / `media/` attachments retain
their original storage. General imports support 32 MB; UTF-8 text editing supports 2 MB.
Note media uploads keep their existing larger video limit. This is a file workspace, not
a LaTeX compiler.

**+ File** creates an empty text file, using the filename exactly as entered. No
extension is added automatically. For example, use `reading-plan.md`, `draft.tex`,
`references.bib`, or `ideas.txt`. Text files open in the source editor; `.tex` files
do not become block notes or compile to PDF. Use **New note** for Noctua's block
editor, or **Import** to bring in existing files, including images and videos.

Drag files, notes, or folders onto a folder to move them within the project, or onto Project root to move them out of a folder. Drop onto Trash to open the same in-app removal confirmation. Folder moves include their contents, preserve stable IDs and references, and can be undone. Cross-project moves and moving a folder into itself or its descendants are rejected.

To remove a file or folder, open its **⋯** menu, choose **Move to trash**, then
confirm in the in-app dialog. Folders include their contents; any removed document
closes in the editor. Cancel leaves the project unchanged. Use **Undo** to reverse
the operation, or **Trash** to restore entries later. When restoring individually,
restore the parent folder before its children to preserve their placement.

Import or create a `.bib`, then select **Bibliographies** to enable it for this
collection. Its keys become available in the normal citation picker alongside library
keys, using the existing author/year display. Duplicate keys must be renamed. Invalid
source remains editable; a visible error marks the retained citation index as out of
date. Clicking an imported citation shows its reference details and DOI/URL when
available. Importing a bibliography does not download its papers.

Notes have a full-width, sticky toolbar with **Undo / Redo** buttons. These buttons and
**Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z** cover note typing, titles, preambles, blocks,
drawings, media edits, and assistant changes. Reader controls cover highlights,
drawings, comment text, replies and deletion. File-tree/text changes are also undoable.
Histories are separate by document/paper/workspace, remain available during the backend
session, and clear when it exits. New edits clear redo. Conflicting saves must be
resolved before undoing; failed operations do not consume history.

Open **Skills** from the project tree or chat toolbar to import a skill directory, ZIP,
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
a paper from the collection or an enabled imported bibliography, or `[[` to link another note. The title's gear
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
