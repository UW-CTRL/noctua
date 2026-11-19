# Paper editor

For external source directories, Git, and the embedded server terminal, see
[Linked projects](linked-projects.md). Linked directories remain outside Noctua
storage and must be backed up separately.

[Documentation](README.md) · [Notes and project files](notes.md)

Choose **New note or file → LaTeX (.tex)** to create a standard LaTeX
article from the starter template in a chosen folder. The `.tex` extension is added when missing, and the first
paper becomes the main document without replacing an existing selection. Noctua opens source on the left and the compiled PDF on the right. Existing
notes keep their block editor and lightweight preview. To use an imported `.tex`,
choose it as the main document in **Project LaTeX settings**. Each collection has one
main paper, identified by its stable file ID; renaming it preserves the selection.

The editor uses the same document heading and grouped icon toolbar as Reader.
Hover an icon for its label: Play compiles, Square stops, circular arrows toggle
automatic compilation, and Maximize fits the PDF to the available width. Source
save status, Undo/Redo, reload, and source download sit below the filename;
the toolbar scrolls horizontally in narrow panes; compiler and main-document
details appear only in Project LaTeX settings; PDF zoom and download sit together in the toolbar. Changing compilation and preview status
appears to the right of **Compiler log**, including when the log is collapsed.
Error and warning counts remain visible there. Click either count to open its
message list, then choose an item with a project source location to open the file
and select the reported line. Diagnostics without a source location remain
readable in the list. The source editor also marks affected lines with a subtle
background and an error or warning icon. Hover an icon to read the messages or
click it to open that line’s diagnostics. Markers follow source scrolling. Editing clears old markers until new compiler results arrive. New logs never expand the panel automatically. Click to open or close it.

Automatic completion is disabled in the source editor, including command,
citation, reference, and filename suggestions. The editor also disables native
text predictions, autocorrection, and spellchecking. Type LaTeX commands and
citation keys directly; compilation still resolves them normally.

## Project LaTeX settings

Click the small **settings gear** in Project files to choose
**Tectonic (XeLaTeX)** or **pdfLaTeX**, the main `.tex` document, and automatic
compilation. Close with **X** (or Escape) to save and dismiss; a save error keeps
the dialog open for retry. Settings are saved separately for each collection/project; existing
projects keep Tectonic until you change them. The toolbar's **Auto** checkbox also
saves to the current project. Switching compilers invalidates the build cache;
the previous PDF stays visible until a new build succeeds.

Choose pdfLaTeX when your Overleaf project uses pdfLaTeX. This usually resolves
compiler-dependent font and template differences without changing the source.
Exact output can still differ with TeX Live/package versions or external fonts.

The main `.tex` document’s immediate folder is the build root, for both internal
project files and linked directories. For example, selecting
`papers/L4DC.27/main.tex` resolves `conference.cls`, `refs.bib`, and
`figures/plot.pdf` inside `papers/L4DC.27/`. Only that folder and its subfolders
are staged for compilation; sibling papers are excluded. Keep each paper’s
sources and dependencies together in its directory.

Compilation includes **All in main document directory** bibliographies by default,
including nested folders. Bibliographies outside that directory are excluded even
if previously selected. In Project LaTeX settings, switch Bibliographies to **Selected files** to
choose a subset. Selecting none disables automatic integration and leaves the
document’s own bibliography commands in control.
For BibTeX/natbib, existing bibliography commands use these files; if no command
is present and the document cites references, a bibliography is added at the end
using `plain` unless a style is specified. Only disposable build files change. Duplicate keys across selected
files must be resolved. Automatic bibliography integration does not support biblatex.

## Templates, figures, and bibliographies

New papers share a compact 11pt article template with one-inch margins, Korean
support, mathematics, figures, tables, and linked numeric citations. Bibliography
commands start commented out. Add project `.bib` files and use `\cite{key}`;
the compiler automatically includes the selected references.

Import `.cls`, `.sty`, `.bst`, `.bib`, images, and additional `.tex` files using
**Import**, then organize them in the project tree. Ordinary LaTeX paths refer to
the names and folders shown in that tree, relative to the main document’s folder. For example:

```latex
\documentclass{myclass} % myclass.cls beside the main .tex file
\usepackage{graphicx}
\begin{document}
\input{sections/introduction}
\includegraphics[width=0.8\linewidth]{Media/figure.png}
See \cite{example2026}.
\bibliographystyle{plain}
\bibliography{references} % references.bib beside the main .tex file
\end{document}
```

Opening a supporting source or bibliography keeps the paper preview alongside it.
Moving or renaming a file may require updating the paths in your LaTeX source.
The paper compiler reads `.bib` files directly; enabling them for the note citation
picker is not necessary. Noctua library citation keys are not automatically
exported into a paper bibliography.

For bundled Tectonic 0.17.0, Noctua works around a BibTeX bug that removes spaces
from string aliases (for example, journal names defined with `@string`). It expands
previously defined local aliases in temporary build copies only; your imported
`.bib` files remain unchanged. Aliases defined in other bibliography files are
left to the compiler. This compatibility workaround should be removed once a
bundled Tectonic upgrade passes the original alias-spacing regression test.

## Compile and preview

**Auto** compiles after a one-second typing pause and after saving pending edits.
**Compile** explicitly rebuilds, including unchanged sources. **Stop** cancels both
the current build and queued changes. Multiple windows share one compilation queue
per project. Only the newest pending build runs after the active build finishes.
Compilation runs on the server computer and continues after closing a client.
Server maintenance waits for active and queued builds; bundled compilers remain
available outside the desktop bundle while an application update is installed.

The last successful PDF stays visible while compiling and if an edit contains an
error. The status identifies outdated output. Expand **Compiler log** to read
errors or download progress; recognized file/line links open the source location.
A save conflict must be resolved before that draft can compile.

Drag the divider to resize the panes; keyboard users can focus it and use the
arrow keys. The two thin divider arrows hide/reopen the source editor or PDF
preview; at least one stays visible. Visibility and split width are remembered,
and hiding a pane keeps its document and unsaved edits. Fit previews adapt to the
available width when panes change. The outer rails also hide navigation and chat.
PDF pages are white for faithful output, with selectable text,
continuous scrolling, and sharp zoom controls. **Download PDF** downloads the last
successful compiled artifact, even when the current source has errors. Scroll
position and zoom are preserved when the preview refreshes.

## Compiler and limits

Official desktop builds include both Tectonic 0.17.0 and pdfLaTeX/BibTeX from
TeX Live 2026 (TinyTeX 2026.10). No separate MacTeX, MiKTeX, or system TeX install
is required. The bundled pdfLaTeX distribution includes common packages, Times
fonts, JMLR, and algorithm2e, and works offline for included packages. It is not
the entire TeX Live distribution: import missing template/package files into your
project when a compiler log reports them missing.

Tectonic's first builds download TeX support files and can be slower; later builds
use its cache. Tectonic needs internet until all required files are cached. Neither
compiler uploads your paper to a compilation service.

Both compilers support BibTeX. This version does not supply
Biber, LuaLaTeX, shell-escape tools or ZIP-project import. Noctua note commands, interactive videos, and drawing blocks are not
converted into paper LaTeX. Use ordinary images and standard LaTeX instead.

Builds disable shell escape and Tectonic also uses its untrusted mode, but this is **not a
complete security sandbox**; use trusted templates. Compilation stops after five
minutes, at 128 MB of generated output, or at 8 MB of console output. Input projects
are limited to 512 MB. Temporary inputs, build intermediates, and the two most
recent successful PDFs live under the collection's internal `.workspace/paper`
directory and do not appear in the project tree. Source files remain in Noctua project storage or their linked directory. Do not edit compiler working copies.

A preview matching the PDF is the priority: paper rendering does not substitute
KaTeX for TeX. Compilation time depends on the document and cached resources;
Noctua does not guarantee faster compilation than Overleaf.

## Citation suggestions and keyboard shortcuts

Type `\cite{` in a `.tex` source to search all project `.bib` files by title,
author, year, or key. Suggestions show formatted title math and **Bib: filename**;
duplicate entries remain separate. Note bibliography activation is not required.
Your document still needs its normal bibliography commands to typeset references.
Invalid `.bib` files do not hide results from other valid files.

**Cmd/Ctrl+/** toggles `%` comments on the current line or selected lines in TeX
source (`.tex`, `.cls`, `.sty`, `.bst`). Indentation is preserved, and the edits use
normal autosave and undo/redo. A selection ending at the next line's start does
not comment that next line.

**Cmd/Ctrl+F** searches only the source editor, not the compiled PDF. Enter and
Shift+Enter move forward/backward; Escape closes Find. The same Find bar works in
other project text files, including bibliographies.

The chat assistant can inspect internal workspace files with the read-only
`inspect_workspace` tool in Plan, Suggest, and Direct modes. Ask it to inspect the
LaTeX build log: `paper/build.log` is relative to the collection's `.workspace`.
It can list directories, inspect `paper/out` compiler logs, and read the end of long
logs. Reads are limited to 64 KiB per call and directory pages to 200 entries;
the agent can request additional pages. Binary files expose metadata only.
This tool does not trigger compilation or edit generated files.

## Jump from PDF to source

Double-click text in the compiled paper preview to open the corresponding project
source file, reveal the source pane, and center/select the matching line. This uses
SyncTeX from both Tectonic and pdfLaTeX, including included `.tex` files, at any zoom.
Click **Compile** once for PDFs built before this feature was added. Save and
recompile if the source has changed; old line mappings are not used for changed
files. Unsaved editor drafts are preserved and navigation asks for a recompile.

SyncTeX maps typeset regions to source lines, not always individual words. Generated
bibliographies and text from compiler packages may have no editable project source.
The mapping for the last successful PDF survives a failed build. Mapping data lives
under `.workspace/paper/sync` and retains the latest two successful build mappings.
This applies to paper previews, not imported library PDFs without LaTeX sources.

For lookup, Noctua makes a temporary copy of the mapping in the system temporary
directory and removes it afterward. This avoids Windows SyncTeX path-length
failures in deeply nested project storage; the saved PDF and mapping stay in
`.workspace/paper`.

Pane dividers resize the editor live. PDF rendering and diagnostic-marker
measurement settle after the drag ends; moving a divider does not save its width
on every pointer movement. Idle or hidden editors stop compiler-status polling.
PDF preview pages outside the nearby scroll area are released and rendered again
when needed.

The source editor colors LaTeX commands, formatting commands, citations and references, math delimiters, brackets, numbers, and comments. Long lines wrap to the source pane width without horizontal scrolling; wrapping does not insert newlines into the saved file. Coloring is limited to the visible lines and briefly yields to native text while typing; very large files or exceptionally long lines use plain text. No autocomplete is involved. Command/Ctrl+B and I toggle bold and italic; brackets and dollar signs pair automatically, and typing a wrapper around selected text encloses it, just as in native note cells.

Math contents use teal, math symbols such as `\omega` use rose, and environment
boundaries (`\begin`/`\end`) and structural commands use purple. References,
formatting commands, comments, numbers, and delimiters remain distinct. Math
coloring carries across lines in `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and common
math environments such as `equation` and `align`. This is lexical highlighting,
not TeX macro expansion. Colors adapt to light and dark themes.

The categories follow the distinctions in [Overleaf’s grammar](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/lezer-latex/latex.grammar)
and [CodeMirror’s theme](https://github.com/codemirror/codemirror5/blob/master/lib/codemirror.css),
with a palette adapted to Noctua. Line states are cached so scrolling does not
reparse an unchanged prefix or create offscreen token elements.

During pane dragging, the editor temporarily shows native plain text and hides
the syntax and diagnostic overlays. Colors return after resizing stops. This
avoids stale highlight positions and repeated token painting while dragging.
Opening another directory leaves the current source open; center document tabs
switch between files after saving the current draft.

Wrapped line positions are cached between edits and pane size changes, so scrolling
only colors the visible source. Files over 200,000 characters or 10,000 lines use wrapped plain
text to keep editing responsive.
