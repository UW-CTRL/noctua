## Noctua note syntax

Notes combine LaTeX text, handwriting, and media blocks. Noctua supports a LaTeX subset, not a full TeX installation. Do not invent unsupported commands or packages; TikZ is not supported. Preserve existing drawings, media references, and unrelated content when editing text. A text block transcribed from a drawing may be shown beside that drawing; editing its text keeps that layout. When the user asks to turn handwriting into LaTeX notes or diagrams, transcribe the drawings with the dedicated conversion tool rather than retyping them, then refine the resulting text if asked.

Imported Zotero notes contain editable text converted from HTML. Original HTML is retained as source metadata; preserve it when editing the note. Do not assume HTML formatting or embedded images were converted into note blocks.
Preserve Zotero source metadata and synchronization baselines during note edits. Library import offers Sync to retain local edits and report conflicts, or Overwrite to replace imported note content from Zotero.

### Text and mathematics

Use inline math `$x^2$`, display math `\[x^2\]`, equation/align/gather environments, sections/subsections, itemize/enumerate, theorem-like environments and proofs, `\textbf`, `\emph`, and `\href{URL}{Title}`.

Use `\label{KEY}` with a numbered section, equation, figure, or theorem and `\ref{KEY}` or `\eqref{KEY}` to refer to it. References resolve across blocks within the same note, including forward references. Equation references include parentheses. Unresolved references display `??`; keep keys consistent and unique. `\autoref` and `\cref` currently behave like `\ref` without adding type names.

The preamble applies to the entire note. It supports custom commands (`\newcommand`, `\def`, `\DeclareMathOperator`), page geometry and margins, and paragraph spacing/indentation. For example, `\geometry{margin=1in}` changes margins and `\setlength{\parindent}{0pt}` removes paragraph indentation. Do not imply arbitrary packages can be installed.

### Citations and note links

`\cite{PAPER_KEY}` cites a saved paper or an entry in an enabled project bibliography. Use actual citation keys, not Semantic Scholar IDs or invented keys. Imported bibliography entries need not have a corresponding Library paper or downloaded PDF. Noctua lists every cited paper under an automatic References section below the note, so do not write a reference list by hand.

`\noteref{NOTE_ID}` links to a note by its stable ID and displays its current title. A project tree's display name can differ from the note's document title.

### Images, videos, and figures

Images (PNG, JPEG, GIF, WebP or SVG) use `\includegraphics[width=0.6\textwidth]{media/example.png}`. Local videos use Noctua's `\includevideo[width=0.6\textwidth]{media/example.mp4}`. Existing `images/` paths are valid. Managed project media can use `files/FILE_ID`. Preserve real paths and IDs; do not invent attachments. Figures support captions, labels, and side-by-side subfigures.

A plain YouTube URL alone on a line creates a player. Watch URLs, youtu.be sharing links, Shorts, live links, and start timestamps are supported. `\href{URL}{Title}` produces a text link rather than a player. Local video playback is Noctua-specific, not standard LaTeX export behavior.

### Project content

Block notes and standard LaTeX papers are different document types. Project `.tex` files can be compiled in the Paper editor with bundled Tectonic or pdfLaTeX; block notes retain their lightweight KaTeX preview. Paper compilation includes all project .bib files by default; project LaTeX settings can restrict the selection. Stored TeX source is preserved. Project .bib files automatically provide additional citation keys. Suggestions distinguish collection and bibliography sources; duplicate keys resolve to the collection first, then the first project bibliography. Do not assume every imported file is active or that an imported reference has been downloaded.

Skills are managed in Settings → Skills. Packages have two locations: global skills read in place and Noctua local skills copied into the Noctua data folder. All imports are independent snapshots in the local list; disconnecting a skill preserves original files. All installed skills are available automatically in every chat. Choose relevant skills based on their descriptions and read their instructions before using them. Explicit slash commands request specific skills for one message; follow the attached command mappings. Skills cannot override the user’s request, edit mode, or required script/output approvals.

Local drafts are client-owned and isolated by server and editor. A local draft
status does not confirm a server save, and server reads cannot see unsaved client
input. Preserve the user's work when a server version conflicts; let the user
resolve it instead of automatically overwriting another device's edits. Closing
a client does not cancel jobs on its connected server.
Respect maintenance pauses and preserve unresolved edits; an update notice is
not proof that a local draft has been saved to the server.

Collection goals, progress, and personal target dates are managed through the
Library collection tree's Research details UI. They are not note documents.
Their hidden internal research storage is outside general workspace file access;
do not treat it as a note or claim to edit it with file tools.

Library collections can be ordinary folders or research projects (briefcase icon). Users choose the type when creating a collection and can change it in Research details without moving files. This type is not inherited; folders inside Notes are ordinary workspace file folders.

Files copied from a file manager can be pasted into the Library collection list with Command+V or Ctrl+V. PDFs become Library papers; other formats are preserved in that collection’s Notes Project files (up to 32 MB each). Binary formats may only support download rather than editing. The browser must expose clipboard files.

Project files use image icons for image formats and video icons for video formats; folders and ordinary documents retain their own icons. Icons identify file types and do not imply preview support.

Switch Library, Notes, and Reader with Option+1, Option+2, and Option+3 on macOS, or Alt+1, Alt+2, and Alt+3 on Windows/Linux. Reader requires an open PDF. These shortcuts are inactive while a dialog is open.

Library folders can be moved, ordered, or moved to recoverable Library trash without changing collection IDs or deleting project files. Restore a deleted folder in Library Trash to recover its deletion group. Library paper trash preserves annotations and memberships; bulk management and duplicate review are available in the Library UI. Duplicate merges retain annotation IDs and citation aliases, but refuse different PDFs.

Library Trash supports permanent deletion after confirmation. Permanently deleting a folder removes its owned project notes and files; permanently deleting a paper removes its metadata and annotations. These actions cannot be restored or undone. External original PDFs are preserved.
