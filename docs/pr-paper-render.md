# Paper rendering and project editing

## Summary

Add a standard LaTeX paper editor with source and compiled PDF side by side. Users
can import journal or conference templates, choose Tectonic or pdfLaTeX per
collection, and double-click the PDF to return to the corresponding source line.
Both compilers ship with the desktop app, so a separate TeX installation is not
required.

This change also improves the surrounding writing workflow: citation suggestions,
document Find, collapsible panes, project-file mentions, inline editing approvals,
and read-only access to compiler logs from chat.

Branch: `dev/paper-render`. Target: `main`. This record covers the paper-render
feature commit and the subsequent build-workflow fixes; it is not limited to the
remaining branch difference after the feature merge. For ongoing usage
instructions, see the [Paper editor guide](papers.md).

## Main features

### Standard LaTeX source and live PDF preview

Choose **Paper** in a collection's Project files toolbar to create a document, or
use **Set as main document** on an existing `.tex` file. The source editor and
continuously scrolling PDF preview open together. Supporting text files can be
edited while keeping the paper preview visible.

- Import `.tex`, `.cls`, `.sty`, `.bst`, `.bib`, and images into the project tree.
- Resolve inputs and media using project-relative paths, including subfolders.
- Enable **Auto** to compile after a one-second typing pause and pending saves.
- Use **Compile** for an explicit rebuild and **Stop** to cancel active and queued
  builds.
- Keep the last successful PDF visible during compilation and after errors, with
  status indicating outdated output.
- Expand **Compiler log** for diagnostics; recognized file/line links navigate to
  the source.
- Download the last successful PDF, even if the current source has errors.
- Resize source and preview, preserve zoom and scroll across refreshes, and use
  selectable PDF text with sharp zoom rendering.

Existing block notes retain their KaTeX preview. Papers use actual TeX compilation,
so their preview supports document classes, page layout, and typeset bibliographies.

### Compiler settings per project

A Lucide settings gear in Project files and the paper toolbar opens settings for
compiler, main document, and automatic compilation. Each collection stores its
own choices; existing projects default to Tectonic.

| Compiler | Bundled distribution | Intended use |
| --- | --- | --- |
| Tectonic | 0.17.0, XeLaTeX-based | Existing Noctua paper workflow and XeLaTeX-compatible templates. |
| pdfLaTeX/BibTeX | TeX Live 2026 via TinyTeX 2026.10 | Templates and Overleaf projects configured for pdfLaTeX. |

Matching the compiler used in Overleaf resolves compiler-dependent font and
layout differences without requiring source changes. Identical output is not
guaranteed across different package versions or external fonts.

Changing engines invalidates cached output. The previous PDF stays visible until
the newly selected engine succeeds. The main document is stored by stable file ID,
so renaming it preserves the selection.

### Double-click PDF text to open its source

Both engines generate SyncTeX data. Double-clicking text in a compiled paper opens
the corresponding project file, reveals the source pane, and centers/selects the
matching line, including lines in included `.tex` files.

Mappings belong to the successful PDF's build fingerprint. Navigation checks the
source against that snapshot rather than applying stale line positions to changed
files. Unsaved drafts are preserved, and changed source requires saving and
recompiling. A failed build retains the last successful PDF and its mapping.

SyncTeX locates source lines rather than exact words. Generated bibliography text
and compiler-owned package content may not have an editable project source. This
feature does not apply to imported library PDFs without their LaTeX project.

### Citation suggestions across project sources

Typing `\cite{` in a paper source searches all project bibliographies by key,
title, author, or year. Suggestions render title math and label the originating
**Bib: filename**. Bibliographies do not need to be enabled for note citations to
participate in paper suggestions.

In block notes, suggestions search both collection papers and enabled
bibliographies. **Collection** and **Bib: filename** labels distinguish results;
duplicates remain visible. If identical keys occur in multiple sources, rendered
note citations keep the existing collection-first, then first-enabled-bibliography
resolution. Distinct keys are needed to select distinct references reliably.

Paper bibliography rendering still uses ordinary LaTeX/BibTeX commands. Library
citation keys are not automatically exported into a paper's `.bib` file.

### Find and line-comment shortcuts

| Context | Cmd/Ctrl+F scope |
| --- | --- |
| Paper source or another project text file | The editor's source text, including `.bib`; not the compiled PDF. |
| Block note with an active editing cell | That cell's source. |
| Block note without an active editing cell | Rendered note text, without duplicate math accessibility text. |
| Library PDF reader | PDF text and user-written comments/replies, including unsaved comment drafts. |

Find supports next/previous results through Enter/Shift+Enter or arrow controls;
Escape closes it. Reader search excludes quoted annotation passages and
assistant-authored comments, and does not change stored highlights.

**Cmd/Ctrl+/** toggles line comments in `.tex`, `.cls`, `.sty`, and `.bst` source.
It preserves indentation, respects selected-line boundaries, and participates in
normal autosave and undo/redo.

### Fully collapsible panes

Thin arrow rails close and reopen the application's left and right sidebars,
including navigation, reader annotations/details, and chat. Pane contents,
drafts, and previous widths survive collapsing.

The paper editor also has source/preview collapse controls. At least one paper
pane remains visible, and fit-to-width PDF rendering adapts to the available space.

## Chat and assistant integration

### Mention project files and folders

The `@` picker includes current-project files of any extension, folders, library
papers, notes, and collections. Results expose their type and location and support
keyboard selection.

Text mentions include stable IDs and excerpts of up to 12,000 characters. An open
file's unsaved draft is included and labeled. Folder mentions provide bounded
descendant listings; collection mentions also include paper references. Binary
files attach metadata and IDs rather than their contents. Total attachment
context is limited to 60,000 characters.

### Approve file edits once per file per response

In **Suggest** mode, the first edit to a project file asks inline in chat with
**Allow this file**, **Decline**, and an optional scrollable diff snapshot.
Approval covers further edits to that file during the same response, including
renames and moves. New files retain their approval for subsequent edits. Other
files require separate decisions; permission expires when the response ends or
is stopped. Revision checks continue to protect concurrent user edits.

**Direct** mode applies project-file edits without approval requests or popups.
**Plan** remains read-only. Note-block suggestions, PDF annotations, and skill
scripts retain their existing review controls.

### Inspect compiler logs from chat

The read-only MCP tool `inspect_workspace` lets both integrated agents list and
inspect the collection's internal `.workspace` directory in all edit modes.
For example, `paper/build.log` exposes the paper build log, and `paper/out` contains
compiler intermediates and logs.

Text reads are bounded to 64 KiB per call; directory pages contain up to 200
entries. Additional pages and the end of long logs can be requested. Binary files
expose metadata only. This tool does not edit generated files or start a build;
compiler selection, main-document selection, and compilation remain UI controls.

## Implementation and build changes

| Area | Main files | Responsibility |
| --- | --- | --- |
| Compilation and PDF-to-source lookup | [src/paper.rs](../src/paper.rs) | Build snapshots, compiler execution, queueing, artifacts, logs, and SyncTeX. |
| Paper UI | [web/paper.js](../web/paper.js) | Source/preview layout, compilation controls, settings, and navigation. |
| Project configuration | [src/workspace.rs](../src/workspace.rs), [web/workspace.js](../web/workspace.js) | Main file and compiler settings in the existing project model. |
| Bibliographies | [src/bibliography.rs](../src/bibliography.rs), [web/citations.js](../web/citations.js) | BibTeX handling and shared citation suggestions. |
| Find and panes | [web/find.js](../web/find.js), [web/panes.js](../web/panes.js) | Scoped document search and persistent pane visibility. |
| Agent workflow | [src/chat_approval.rs](../src/chat_approval.rs), [src/agent.rs](../src/agent.rs), [web/mentions.js](../web/mentions.js) | Per-response file approval, internal workspace inspection, and context attachments. |
| Compiler distribution | [scripts/setup-tectonic.py](../scripts/setup-tectonic.py), [scripts/setup-pdflatex.py](../scripts/setup-pdflatex.py) | Pinned downloads, checksum validation, and relocatable desktop resources. |

Builds use isolated project snapshots under `.workspace/paper`. Multiple windows
share one queue per project; only the newest pending build follows the active
build. Successful output and SyncTeX data retain the latest two artifacts. Internal
working files do not clutter the project tree, and original project sources remain
in normal Noctua storage.

Compiler setup prepares ignored `target/tectonic` and `target/texlive` directories
without installing system TeX or changing the user's global PATH. Desktop bundles
include compiler resources and license notices. TinyTeX preparation adds
JMLR/algorithm2e/SyncTeX dependencies from a fixed-date TeX Live repository.

### Temporary Tectonic bibliography compatibility fix

Tectonic 0.17.0 can remove spaces from BibTeX string aliases, including journal
names. Noctua expands previously defined local aliases in temporary bibliography
build copies. Imported `.bib` source files remain unchanged; cross-file aliases
are left to the compiler.

Remove this workaround once a bundled Tectonic upgrade passes the original
alias-spacing regression. The real-compiler integration test checks both the
rendered bibliography data and preservation of the original source.

### Follow-up CI fixes

Ubuntu failed while extracting valid relative links in the TinyTeX archive with
the runner's system Python. Desktop CI and release builds now select Python 3.12
before compiler setup, retaining checksum validation and archive safety filters.
The same pinned Linux archive extracted successfully under Python 3.12 locally.

The Windows integration test reached SyncTeX but received no forward-search
location. The test now uses the exact `Input` path recorded by the compiler instead
of reconstructing it from Python's filesystem path. Added tests cover Windows
drive letters, backslashes, extended paths, spaces, and compressed/plain mappings.
Failures now report the command, exit status, and output. The next CI run confirmed Ubuntu passed, but Windows still returned no location.
Its mapping filename was 266 characters long. A follow-up changes both forward
tests and application inverse lookup to run from the mapping directory using a
short output basename, avoiding long absolute paths in SyncTeX's C file APIs.
The integration fixture now explicitly exercises sidecar paths over 260 characters.
Windows CI still failed after this change. Diagnostic probes then confirmed that
both engines' mappings work from a short temporary directory, in compressed and
plain form, with both forward and inverse queries. The application and integration
test now copy the immutable map into a unique temporary directory for each query
and remove the copy afterward. Saved PDFs, mappings, and source records remain
unchanged. The full Windows suite still needs to confirm this implementation.
CI retains synthetic failure artifacts and runs both engines after a failure.

## Validation

The following checks passed locally during the build-fix work:

- `python3 tests/paper-integration.py`: both Tectonic and pdfLaTeX; real custom
  class, nested inputs, BibTeX, image inclusion, successful PDF retrieval, source
  navigation, caching, cancellation, failed-build retention, engine switching,
  stale revisions, and bounded artifact retention. pdfLaTeX also exercised the
  bundled JMLR template and Times bold/italic with system PATH unavailable.
- `python3 -m unittest discover -s tests -p test_paper_synctex.py`: source-path
  matching for plain/compressed mappings, plus missing and ambiguous source errors.
- `python3 -m unittest discover -s .github/scripts -p 'test_*.py'`: seven release
  script tests.
- Extraction of the checksum-verified Linux TinyTeX archive with Python 3.12's
  `data` filter on macOS. This is archive validation, not a native Linux build.

Additional feature coverage lives in `tests/paper.html`, `tests/paper-source.html`,
`tests/document-tools.html`, `tests/mentions.html`, `tests/panes.html`, and
`tests/workspace.html`. See [CI](ci.md) for backend and frontend test commands.
These suites are not claimed as freshly rerun for this documentation update.

**Outstanding:** confirm temporary mapping staging in the full Windows suite, then complete
release packaging for all target platforms. Rerunning a release on an unchanged
older tag does not incorporate these fixes.

### Suggested manual review

1. Create a paper, import a class, bibliography, image, and included `.tex` file;
   compile and download the PDF.
2. Switch the project between Tectonic and pdfLaTeX; verify another collection's
   settings remain independent.
3. Introduce a LaTeX error; confirm the last good PDF remains and log navigation
   opens the failing source. Correct the error and rebuild.
4. Double-click text from the main and included files, then edit the source and
   verify stale mappings require recompilation.
5. Exercise citation suggestions, Find in each supported context, line commenting,
   and pane collapse/reopen with an unsaved draft.
6. Mention a `.tex`, `.bib`, and folder in chat. In Suggest mode, approve repeated
   edits to one file and verify another file needs its own approval. Check Direct
   mode separately, then ask the agent to inspect `paper/build.log`.

## Limits

- No Biber, LuaLaTeX, shell-escape tools, or ZIP-project import is included.
- Bundled pdfLaTeX works offline for included packages, but is not all of TeX Live.
  Missing template/package files can be imported into the project.
- Tectonic needs network access until required support files are cached. Neither
  engine uploads papers to a remote compilation service.
- Noctua-specific note commands, interactive videos, and drawing blocks are not
  converted into standard paper LaTeX.
- Shell escape is disabled and Tectonic uses untrusted mode, but compilation is
  not a complete security sandbox; templates should be trusted.
- Builds stop at five minutes, 128 MB of generated output, or 8 MB of console
  output. Project input is limited to 512 MB.
- Reader Find needs selectable text and does not OCR scanned PDFs.
- Compilation speed depends on the document and cached resources; faster-than-
  Overleaf performance is not guaranteed.
