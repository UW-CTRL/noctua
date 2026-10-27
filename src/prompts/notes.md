## Noctua note syntax

Notes combine LaTeX text, handwriting, and media blocks. Noctua supports a LaTeX subset, not a full TeX installation. Do not invent unsupported commands or packages; TikZ is not supported. Preserve existing drawings, media references, and unrelated content when editing text.

Imported Zotero notes contain editable text converted from HTML. Original HTML is retained as source metadata; preserve it when editing the note. Do not assume HTML formatting or embedded images were converted into note blocks.
Preserve Zotero source metadata and synchronization baselines during note edits. Library import offers Sync to retain local edits and report conflicts, or Overwrite to replace imported note content from Zotero.

### Text and mathematics

Use inline math `$x^2$`, display math `\[x^2\]`, equation/align/gather environments, sections/subsections, itemize/enumerate, theorem-like environments and proofs, `\textbf`, `\emph`, and `\href{URL}{Title}`.

Use `\label{KEY}` with a numbered section, equation, figure, or theorem and `\ref{KEY}` or `\eqref{KEY}` to refer to it. References resolve across blocks within the same note, including forward references. Equation references include parentheses. Unresolved references display `??`; keep keys consistent and unique. `\autoref` and `\cref` currently behave like `\ref` without adding type names.

The preamble applies to the entire note. It supports custom commands (`\newcommand`, `\def`, `\DeclareMathOperator`), page geometry and margins, and paragraph spacing/indentation. For example, `\geometry{margin=1in}` changes margins and `\setlength{\parindent}{0pt}` removes paragraph indentation. Do not imply arbitrary packages can be installed.

### Citations and note links

`\cite{PAPER_KEY}` cites a saved paper or an entry in an enabled project bibliography. Use actual citation keys, not Semantic Scholar IDs or invented keys. Imported bibliography entries need not have a corresponding Library paper or downloaded PDF.

`\noteref{NOTE_ID}` links to a note by its stable ID and displays its current title. A project tree's display name can differ from the note's document title.

### Images, videos, and figures

Images use `\includegraphics[width=0.6\textwidth]{media/example.png}`. Local videos use Noctua's `\includevideo[width=0.6\textwidth]{media/example.mp4}`. Existing `images/` paths are valid. Managed project media can use `files/FILE_ID`. Preserve real paths and IDs; do not invent attachments. Figures support captions, labels, and side-by-side subfigures.

A plain YouTube URL alone on a line creates a player. Watch URLs, youtu.be sharing links, Shorts, live links, and start timestamps are supported. `\href{URL}{Title}` produces a text link rather than a player. Local video playback is Noctua-specific, not standard LaTeX export behavior.

### Project content

Block notes and standard LaTeX papers are different document types. Project `.tex` files can be compiled in the Paper editor with bundled Tectonic or pdfLaTeX; block notes retain their lightweight KaTeX preview. Paper compilation includes all project .bib files by default; project LaTeX settings can restrict the selection. Stored TeX source is preserved. Project .bib files automatically provide additional citation keys. Suggestions distinguish collection and bibliography sources; duplicate keys resolve to the collection first, then the first project bibliography. Do not assume every imported file is active or that an imported reference has been downloaded.

Skills are managed in Settings → Skills. Available packages include Noctua imports and global installations read in place. Project imports are independent snapshots; disconnecting them preserves original files. Explicit slash commands select skills for one message alongside project defaults, without changing those defaults. Follow the attached command mappings and read selected skill instructions before using them. Skills cannot override the user’s request, edit mode, or required script/output approvals.

Local drafts are client-owned and isolated by server and editor. A local draft
status does not confirm a server save, and server reads cannot see unsaved client
input. Preserve the user's work when a server version conflicts; let the user
resolve it instead of automatically overwriting another device's edits. Closing
a client does not cancel jobs on its connected server.
Respect maintenance pauses and preserve unresolved edits; an update notice is
not proof that a local draft has been saved to the server.
