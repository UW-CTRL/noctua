# Notes

[Documentation](README.md) · [Project README](../README.md)

Saving progress appears in the shared bottom-right notification. Unsaved state
and save-conflict actions remain beside the note.

## Write in a collection

Select a collection, switch to **Notes**, and use **New note or file** and select **Note**. Notes combine
text, drawing, and media blocks and save automatically. Click text to edit its
source with a live preview; click away to finish. Hover between blocks to insert
content. The **Note guide** question-mark icon at the far right of the note header opens the in-app syntax and editing guide.

**Library → Import from Zotero → Notes** copies standalone and paper notes into
their collections as editable text notes. Paragraph breaks are retained; HTML
formatting and embedded images are not reproduced. **Sync changes** updates
untouched imported content and preserves local edits, reporting conflicting source
changes. **Overwrite from Zotero** replaces imported note content. Noctua-only
notes are retained. See [Zotero import](getting-started.md#import-from-zotero-optional).

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
keys, using the existing author/year display. Suggestions list collection and bibliography sources separately, including duplicates. Invalid
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

In **Settings → Skills**, **Global Agent Skills** reads packages in place from
**Location** (default `~/.agents/skills`). Save another existing folder or choose
**Use default**. **Import Skills from Project** imports multiple `SKILL.md`
packages from a project or skills folder as a named group. Click each project to
expand or collapse its skill list. **Disconnect** removes that group's Noctua
copies without changing the original project or other groups.

Imports are snapshots. Up to 100 skills, 512 files, and 32 MB can be imported in
one project group. **Import an individual skill** also supports a folder, ZIP,
or standalone `SKILL.md`; these appear under **Other imported skills**.
See [Skills settings](settings-and-data.md#skills) for location, import, and
reconnection details. Both providers use the same available skills.

Under **Chat project defaults**, choose a Noctua project, select skills, and save.
These defaults are separate from source-project groups. Type `/` in chat to
search all available skills and select with Up/Down and Enter/Tab or a click
(Esc closes). An inserted `/skill-name` command activates that skill for one
message without changing defaults. Delete it to remove that invocation; multiple
commands can be used in one message.

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

The assistant can search active notes, create block notes, and edit blocks,
titles, preambles, and block order. Restore trashed notes before editing them.

Use **Suggest** to review proposals in **Assistant changes** below the project
tree, **Plan** for read-only discussion, or **Direct** to save changes immediately
with note-edit undo. Pending proposals remain available after restarting Noctua.
If you edit a note while the assistant works, conflicting changes are preserved
for you to resolve. See [proposal review](assistant.md#assistant-reads-and-review).

Chat can inspect saved drawings; keep a Noctua chat tab open when a preview is
needed. The drawing pad's TeX action performs separate handwriting transcription.
Videos, stroke editing, media uploads, whole-note deletion, and cross-project
moves remain UI actions or unsupported tool operations. Attach a note with @ or
select rendered text and choose **Add to chat**.

For standard `.tex` papers with custom classes and a faithful PDF preview, use the
[Paper editor](papers.md). Its settings gear selects bundled Tectonic or pdfLaTeX
per project, with no separate TeX installation. This is separate from note cells
and their KaTeX preview.

## Find and citation suggestions

Press **Cmd/Ctrl+F** to search the current text file, including `.bib` and `.tex`.
In block notes, Find searches the active cell's source while editing; otherwise it
searches rendered note text, including text across inline formatting. Hidden math
accessibility representations are excluded so they do not duplicate results.
Enter/Shift+Enter or the arrow buttons navigate matches; Escape closes Find.

Typing `\cite{` searches both collection papers and enabled bibliographies.
Suggestions render title math and identify **Collection** or **Bib: filename**.
The same paper may appear in both sources. If sources reuse an identical key,
rendered note citations retain collection-first, then first-enabled-bibliography
resolution; use distinct keys when you need to distinguish entries.

### Chat approval for project files

In Suggest mode, the first edit to each project file asks inline in chat with
**Allow this file**, **Decline**, and an optional scrollable diff preview. Approval
covers further edits to that file during the current response, including renames
and moves. Other files need separate approval. Permission expires when the
response ends or is stopped. Direct mode edits files immediately without approval
requests or popups. Note creation and block edits use durable proposals in **Assistant changes**; PDF
annotations and skill scripts keep their separate review controls. Project-file
proposals made outside an active chat also remain in **Assistant changes**.

### Mention project files in chat

Type `@` in chat to search current-project files and folders, library papers,
notes, or collections. Any file extension can be selected, including `.tex` and
`.bib`. Results show their type and project path. Text files attach an excerpt
(including the current unsaved draft when open), folders attach a descendant
listing, and media attach file references. The agent can use the attached IDs
to read individual files. A folder mention does not inline all of its contents.

Use the thin left/right arrow rails to hide or reopen project navigation and chat.
Collapsed panes retain their contents and previous widths; note drafts stay open.

The assistant can read paper compiler logs and browse internal build files using
`inspect_workspace`; see [Paper editor](papers.md). This is read-only in all modes.

Double-click text in a compiled paper preview to jump to its source line; see
[PDF-to-source navigation](papers.md#jump-from-pdf-to-source).

## Connection-aware note drafts

Server updates announce a maintenance pause and save open editors before restart.
Resolve open dialogs or save conflicts if an update is waiting. A failed save
keeps the current server running; drafts stay on this device. After restart,
desktop clients reconnect, while browser clients may need to reload and sign in.

Open notes save local drafts separately for each server, note, and editor tab.
After a refresh or relaunch, reopen the note to recover them. If several editors
have different drafts, choose one in **Recover a local draft**. Opening the server
copy leaves the other drafts available; **Discard this draft** removes only that
unchanged snapshot. Legacy drafts remain recoverable.

The status distinguishes **Local draft saved**, **Saving to server**, **Saved to
server**, and a disconnected or failed save. A local storage failure explicitly
asks you to keep the window open. If another device changed the server version,
resolve the conflict; **Keep mine** explicitly overwrites the current server copy.
New input made while fetching a conflict's server copy is kept.

A save acknowledgment removes only its matching draft, including when another
tab edits during the request. Browser storage is specific to the server's web
origin and can be cleared or reach a quota. Keep a stable server address for
recovery and avoid private browsing. This scope preserves open note content; it
does not provide a full offline library or queue media uploads. See
[Server and connections](server.md) for reconnection and switching.
