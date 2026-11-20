# Changelog

## 0.4.1 — 2026-11-20

Desktop-only patch; bundles the existing Server 0.4.0 release.

- Fix macOS release packaging to sign the entire application bundle, correcting
  the incomplete signature in 0.4.0 that produces a “damaged” error.
- Verify macOS bundle signatures inside both DMGs and updater archives before
  publication. Ad-hoc signing does not provide Apple notarization.
- Correct server packaging tests to use the independent server version during
  desktop-only releases.

## 0.4.0 — 2026-11-20

Desktop and Server release, following 0.3.10. This release brings external project
folders, a unified explorer, and document tabs to Noctua, alongside LaTeX editor
and pane-performance improvements. Existing collections, notes, and imported
files remain in place; linking a directory does not migrate or copy its sources.

### Linked projects, Git, and terminals

- Link multiple external directories to a collection. Files remain at their
  original paths and can be edited with Noctua, external editors, or Git.
- Browse nested folders and files alongside native notes and the permanent
  Papers entry. Multiple collections and linked roots can stay expanded without
  replacing the active document.
- Choose a directory with the native picker on a local desktop connection, or
  enter its absolute path on the server. Remote browser paths refer to the server.
- Detect existing Git repositories, enclosing repositories, and worktrees without
  automatically initializing Git. Hide ignored files by default; enable them in
  the linked root's settings.
- Open a terminal from each linked root's row for Git status, pull, commit, push,
  conflict resolution, and other shell work. Hiding the terminal preserves its
  session; closing it terminates the session. Output retention is bounded.
- Keep Terminal and Settings on the root row; remove the redundant Git, access,
  and terminal footer beneath the file list.
- Create, edit, rename, move, import, trash, and restore linked project files.
  Recoverable trash is stored in Noctua and restoration refuses to overwrite an
  existing path. Source revision checks prevent stale writes.
- Reload clean files after external edits. For dirty drafts, compare disk and
  editor contents and choose which version to keep; another intervening edit
  rejects a stale overwrite again.
- Relink moved directories or unlink their association without deleting external
  sources. Relinking clears prior access grants and paper configuration;
  unlinking/relinking closes that root's terminals and agent commands.
- Bundle xterm.js and its MIT license for an offline terminal UI.

### Assistant access to project files

- Make linked project files available to the collection's integrated assistant.
  Suggest mode retains proposed edits for review; Direct edit requires file
  access approval and supports remembered grants.
- Inspect and revoke saved grants through the root's Agent access settings.
  Revocation stops running commands for that root.
- Add approved project command execution with explicit working directory, write
  scope, network access, bounded output, and a two-minute timeout.
- Constrain agent commands with macOS filesystem restrictions, with no
  unrestricted fallback. Membership in a larger Git repository does not grant
  repository-wide write access automatically.
- Allow reusable approval for supported exact Git commands. Scripts, pushes,
  destructive actions, and scope expansion require fresh approval.
- Cancel pending and running project commands when their chat is stopped. Count
  terminal sessions and agent commands as active work for safe server shutdown.

### Explorer, navigation, and document tabs

- Replace the overlapping Library/Notes/Reader and Library/Graph/Lineage
  navigation groups with one Library/Graph/Lineage group. Open documents directly
  from the explorer and show the paper table through the explicit Papers entry.
- Add center document tabs for native notes, source files, and PDFs, independent
  of the outer application tabs. Switching saves drafts first, preserves source
  caret/scroll state, and blocks navigation on save conflicts.
- Preserve directory scroll position when selecting files and remember expanded
  directories. Keep child collections visible before their parent's project tree.
- Restore the reading position of native LaTeX-cell notes when reopened.
- Update outer tab titles to match the main pane's paper, collection, file, note,
  or project context.
- Remove bibliography indexing warnings from the collection tree and the empty
  header control between navigation and search.
- Widen and reposition header search, with space between it and navigation.
- Use consistent borderless file rows in active and inactive collections, fixing
  the unintended rounded button outlines in expanded inactive trees.

### LaTeX source editing and compilation

- Build relative to the selected main TeX file's immediate directory, for both
  internal and linked projects. Resolve local classes, bibliography files,
  images, and included sources from that directory and its descendants; exclude
  sibling paper directories from the build snapshot and bibliography selection.
- Preserve separate main-document/compiler settings for each linked root and the
  collection's internal project. Select another open TeX file as the entry point.
- Build verified source snapshots in Noctua's cache without writing compiler
  outputs into external source directories.
- Disable source autocomplete and native text suggestions to remove typing lag.
- Add theme-aware lexical colors for commands, structure/environment boundaries,
  math content and symbols, delimiters, numbers, formatting, references, citations,
  and comments. Cache multiline math state and color a bounded viewport.
- Soft-wrap long source lines to the pane width without horizontal scrolling or
  inserting newlines into the saved file. Align color overlays and diagnostic
  markers with wrapped text. Large sources use wrapped plain text to keep editing
  responsive (over 200,000 characters or 10,000 lines).
- Share native note-cell formatting shortcuts with source editing, including
  bold/italic and bracket/dollar pairing or wrapping selected text.
- Restore native text during typing and pane dragging; repaint color and
  diagnostic overlays after settling to avoid stale highlight artifacts.

### PDF Reader

- Open PDFs from internal and linked project files in the shared Reader instead
  of an isolated embedded preview. Retain selectable text, rendering, zoom,
  document bookmarks, search, highlights, comments, and drawings.
- Provide exclusive Outline, Annotations, and Files sidebar panels for both
  Library and project PDFs. Files contains the same explorer, instead of stacking
  collection controls beneath outlines and annotation cards.
- Store project PDF annotations separately in Noctua metadata, keyed to the file
  and PDF contents; never modify the source PDF. Check annotation revisions to
  reject stale edits and invalidate cached rendering when PDF contents change.
- Preserve PDF page position when switching center documents and show the
  Annotations panel after creating an annotation.

### Performance and reliability

- Use native filesystem change notifications with lightweight change-token
  checks, avoiding full directory scans on each polling interval. Refresh after
  changes, expansion/focus, and a 30-second fallback; pause refresh during typing
  and pane dragging. Cache unchanged file hashes.
- Perform workspace listing work off the async request executor.
- Coalesce pane-drag updates into animation frames and persist widths after
  dragging, including chat, navigation, and source/PDF dividers.
- Defer PDF preview resizing and diagnostic/color geometry work while dragging;
  release preview pages outside the nearby viewport.
- Stop compiler-status polling for idle or hidden editors and use background
  requests for passive project refreshes.

### Integration and validation

- Integrate main through a94a107, including the rusqlite/SQLite security update
  (#78), removal of scheduled weekly dependency audits (#77), and named progress
  and timeouts for chat-file UI tests (#79). PR/main/manual security checks remain.
- Add backend checks for linked-file revision conflicts, Git detection, access
  grants, command confinement/cancellation, terminal sessions, filesystem change
  tokens, main-directory build scope, and project PDF annotation persistence.
- Add WebKit fixtures for independent collection expansion, center tabs,
  save-conflict navigation, linked editor operations, and real project PDF
  rendering/annotations. Extend checks for scroll retention, syntax colors,
  wrapping, source diagnostics, pane dragging, and navigation layout.
- Run macOS backend library checks in the paper job so linked-directory, PTY,
  and command-confinement tests are exercised in CI. Support previous-version
  update fixtures at minor/major release boundaries.
- Run the editor fixture in an active AppKit window to prevent background WebKit
  timer throttling during repeated editor mounts.
- Update the linked-project, Reader, paper, notes, assistant, storage, development,
  and CI guides and synchronize assistant prompts with the new workflow.

### Compatibility and release notes

- External-directory linking, integrated terminals, and confined agent commands
  currently require a macOS server. Desktop/browser clients can connect to it.
- Linked listings are bounded to 20,000 visible entries and 512 MB of visible file
  contents. Git administrative files and symlinks are not exposed for editing.
- Backups of Noctua metadata do not include current external directory contents;
  back up/version those directories separately. Existing internal data stays put.
- Center document tabs last for the current window session; directory expansion
  and per-document reading positions are remembered locally.
- Project PDF annotations belong to a particular file/content version. Replacing
  PDF contents starts a separate annotation set. AI outlines, auto-highlighting,
  and annotation undo/redo remain Library-paper features.
- A project's main-file directory is now its compilation boundary. Move required
  dependencies beneath that directory or choose a suitable main entry point.
- Publish Server 0.4.0 before Desktop 0.4.0: desktop packaging verifies and bundles
  the pinned published server. Both tags must point to commits with successful
  CI and Dependency security push checks on main; PR checks alone do not qualify.
