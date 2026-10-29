# Research

[Documentation](README.md) · [Project README](../README.md)

Paper action icons in the details pane reveal labels below after a short hover.
Keyboard focus shows the labels immediately and uses color feedback without a surrounding focus box. Buttons with visible text, such as
Read PDF, keep hover emphasis without repeating their text below. Icon labels
cover opening a new tab/window, building a graph, and editing paper details.

## Choose a view

Use the tall arrow buttons centered on the left and right dividers to hide or
show the navigation and details panes. Drag a divider to resize its pane.
Toggle the left pane with **⌘B** on macOS or **Ctrl+B** on Windows/Linux;
use **⌘⌥B** or **Ctrl+Alt+B** for the right pane. While typing, these keys keep
their editor behavior. Press **Esc** to leave the input, then use a pane shortcut.
An open suggestion menu may consume Esc first. The original **⌘⌥1 / 2**
(**Ctrl+Alt+1 / 2**) shortcuts also work while editing. Open dialogs suspend
pane shortcuts.

The top-level **Library** tab has three visualizations: **Library**, **Graph**, and
**Lineage**, selected at the top of the left sidebar. Library is the initial
view; your last visualization is remembered. The selected tab uses an accent
underline and a view icon, matching the other sidebar tabs.
In Library, choose the library root or a collection in the left sidebar to browse
its papers in a table. All saved papers appear, including items that Semantic
Scholar cannot match. Use the magnifying glass beside the title in the compact table header
to filter by title, author, or publication. Hover or focus it to expand the field; it stays
expanded while it contains text. Filtering updates the table as you type,
and Escape clears the filter. Click the Title or Year column heading to sort (click Year again to reverse the order).
Titles stay plain on hover; click one to inspect or edit its details. Double-click
a paper with an attached PDF to open Reader in a new tab. Papers without a PDF
only show details. Use the details pane to open a PDF or build a citation graph.

Switching to Graph or Lineage with no graph open builds a graph for the
selected library or collection. Graph and Lineage share a single sidebar: a
folder tree above selects the graph target, and **Papers** below
lists the current graph papers with filtering, sorting, and selection. Choosing
a folder opens its graph without hiding the tree or paper list. When you switch
folders quickly, the graph opens after the selection settles. Graph data can be
reused across collections that contain the same papers. Paper info displays the
abstract already available in the selected record without fetching it on selection.
Drag the horizontal
boundary to resize the folder and paper areas; the height is remembered and shared
between Graph and Lineage. The folder area starts at 440 pixels, capped at 65% of
the sidebar height to leave room for the lower list. The focused boundary also supports Up/Down and Home/End;
double-click to restore the default height. Above the paper list, a borderless icon-only sort menu
and a visible search field align to the left. Sort choices mark the selected
option with accent-colored bold text, without a checkmark. The field shows the current graph
size as “Filter 276 papers” and filters locally as you type. Escape clears it. In Lineage, use the **Papers / Threads** switch below the boundary to choose
which list fills the lower pane. The folder tree stays visible, and your list
choice is remembered in this browser. Graph always shows Papers. Selecting a
thread on the timeline opens the Threads list.
Both graph views have an expanding magnifying-glass filter at the upper right.
Type a title, author, publication, or year to filter the graph and Papers list
locally. The Papers filter stays in sync; Escape in the top-right field clears
it. Filtering does not start a new search or automatic AI summary. The filter
is shared between Graph and Lineage and resets when another graph opens.
Library view shows the folder tree directly without extra sidebar tabs.
Graph views require Semantic Scholar matches, so they may contain fewer papers
than the Library table.

## Explore a paper's neighborhood

Use the search field in the top app header. Choose **arXiv**, **Semantic Scholar**,
or **OpenAlex** by clicking the engine name on its left. arXiv is the initial default. The first engine in
**Settings → Search** is your saved default for this browser and server. Choosing
another engine in the search menu changes the current search; reopening or
reloading the app returns to the first engine.
With the search field focused, **Tab** cycles arXiv → Semantic Scholar → OpenAlex
→ Google Scholar → arXiv in the initial order while keeping your query. **Shift+Tab** leaves the field.
In **Settings → Search**, drag engines to reorder the menu and Tab cycle. Changes save automatically for this browser
and server. Moving an engine to the top makes it the default and selects it immediately.

Results appear below the field after a brief pause in typing, aligned with its
left edge and at least as wide as the field. Enter searches immediately when no result list is open; the search icon always
runs a search. arXiv requests are spaced to respect its API limits. DOI and arXiv
ID/link lookups show a result before opening a graph where the provider supports
that identifier. Semantic Scholar links can be looked up directly with any inline engine.
Use **↑/↓** to select a result. **Enter**, the **PDF** button beside **Graph**,
or clicking the paper row saves the paper to the selected library
folder, downloads its available PDF, and opens Reader. If a PDF is unavailable,
the app shows an attachment/download notice; **Open paper** still opens its source.
**Shift+Enter**, or the **Graph** button beside **Open paper**, opens its Semantic Scholar citation graph; other providers use
DOI/arXiv identifiers, or a title match when no identifier is available. Some papers
have no matching graph. Use **Open paper** to open the provider's source instead.
arXiv does not supply citation counts, so its results omit them.

**Google Scholar ↗** opens a new browser tab rather than an inline list. Choosing
it from the menu with a query opens that search immediately. Switching to it with
Tab keeps you in the field; press Enter, click the search icon, or follow the
Google Scholar link below the field to launch the search. Typing alone never
opens a new tab. Press Escape or click outside to dismiss inline results.
There is no separate Search tab.
The network shows a paper's references, citing papers, and similar recommendations.
Edges represent citations; node size reflects citation count and color reflects
year. A green ring marks papers already in your library.

Click a paper for details, double-click to build a graph around it, or use
**Expand here** to add its neighbors to the current graph. The **Top** selector
controls how many neighbors appear. Citation graphs use Semantic Scholar;
cached results reduce requests, but fresh results can be delayed by rate limits.

## Trace research over time

Switch to **Lineage** to arrange papers chronologically in research
threads. The **Threads** selector sets a maximum of 3, 5, 8, 12, 16, or 24
threads (default 5); your choice is remembered. The algorithm may find fewer
usable paths than the selected maximum. Select a thread to focus it, or Shift-click two papers to trace their
main citation chain.

Use **Fit** to bring all visible papers back into view after zooming or panning.
In Lineage it fits the timeline and thread lanes between the year axis and
legend, accounting for controls that wrap in a narrow pane. Clicking a thread
label fits that thread instead.

The **Threads** section shows thread cards. Use **Summarize threads** in the
graph toolbar to summarize themes and key papers using your selected assistant. Cards start collapsed; click a card header to expand or collapse its
details. Open cards stay open while summaries or the graph refresh.
Automatic summaries are controlled in **Settings → Research assistant → Lineage →
Summarize threads automatically**; the preference is remembered in this browser.
Turn it off and use **Summarize threads** when you want to control AI usage. Lineage remains usable without AI summaries.

See [AI prompts](assistant.md#dedicated-ai-features) for the thread summary's
inputs, output format, and [source instructions](../src/prompts/lineage.md).

Select a paper in the Library list and press **Delete** or **Backspace** to delete it.
You can also choose **Delete paper** (the trash icon) in Paper info.
The confirmation dialog offers **Delete** and **Cancel**; press **Enter** to confirm
or **Escape** to cancel. Deletion moves the paper out of active lists into **Trash**, preserving
annotations, PDFs and memberships. **Trash** (the virtual folder at the bottom of the Library tree) → **Restore** restores them.
Command+Z/Ctrl+Z while the paper list is focused restores the
last deletion. Linked external PDFs and collection project files are preserved.

Paper info has collapsible **Libraries and Collections** and **Tags** sections.
It shows the abstract saved in the Library; selecting a paper does not fetch a missing abstract.
The library and assigned collection paths have distinct icons; the Tags heading
shows the count and each tag appears on its own row. Empty tags show **No tags**.
Add a tag directly in Paper info by typing its name and pressing Enter or the
add button. Matching tags from the entire Library appear below the field; select
one to add it. The display refreshes after editing tags or applying bulk tag changes.
**Libraries and Collections** lists the library and direct collection assignments with parent paths. This shows direct
assignments, independent of the include-subfolders setting; a paper with none
shows the library with **No collection assigned**. Membership changes refresh the list.

## Manage papers and folders

Command-click (macOS) or Ctrl-click toggles paper selections; Shift-click selects
ranges, and Command+A/Ctrl+A selects visible papers. Use dragging and
copy/cut/paste for collection changes, Delete for trash, and Command+Z/Ctrl+Z
for undo. Right-click selected papers for bulk tag editing or removal from the
current collection. Paper info retains individual edit and collection actions. The **Tags** panel at the bottom of the Library sidebar lists tags
from the selected collection with paper counts. **Filter tags** searches tag names
without changing the paper search. Click a tag to filter papers; click it again or
use **Clear tag filter** to show all tags. The list scrolls independently and
respects the include-subfolders setting. Drag the boundary above it to resize the
folder and tag areas; the height is remembered, the focused boundary supports
Up/Down and Home/End, and double-click restores the default. Tag and paper text filters combine. Paper info
**Edit details** also edits tags, one per line.

Collections are links to papers; Library always contains every active paper.
Copy/paste or drag papers into another collection to add links while keeping all
existing memberships. PDF bytes are not duplicated. Cutting and pasting papers
also adds links; only **Remove from collection** explicitly removes a membership.
Paper info defaults its Collection selector to the currently viewed folder and
refreshes when you change folders. Its remove button acts on that selector;
removal is disabled for Library itself.

Cutting and pasting a folder still changes its parent along with its subfolders
and project files. Folder copy is not offered. Clipboard entries are scoped to
the same server. Drag papers onto a collection to link them.
 For folders, drop on the upper/lower edge of a row to insert before/after it
(the line marks the insertion position), or on its center to move inside.
Drop on Library or the **Library root** area that appears while dragging to
bring a nested folder back to the top level. Edge drops also move folders
between parents in one operation.
Right-click a collection to open a compact menu with **Edit collection** (the
pencil action), **New folder**, and **Delete folder**. Use dragging to change
parents or sibling order. The menu supports arrow keys, Enter and Escape. The Library root cannot be moved or deleted.
Folder deletion hides its whole subtree but keeps IDs, memberships and project
files. Restore a folder in **Trash** to restore its deletion group; if its old
parent remains deleted it returns under Library.

**Settings → Data & Storage → Library → Check for duplicate papers** reviews candidates with a matching DOI, arXiv identifier, PDF hash,
or normalized title. Choose the paper to keep and review the confirmation.
Merging fills empty retained fields and combines tags, citation aliases,
memberships and annotations, retaining annotation IDs. Different PDF contents
cannot be merged because their page anchors may differ. The source record stays
archived in Trash and cannot be restored independently or unmerged there. Review
carefully before confirming. Ordinary paper and folder trash remains restorable until permanently deleted.
Trash uses the same table and Command/Ctrl/Shift selection style as Library.
Choose **Restore**, or press Delete/Backspace (or right-click → Delete permanently)
to permanently delete the selection after confirmation. This removes paper
metadata, annotations and folder project files, and cannot be undone. External
original PDFs are preserved; immutable PDF cache blobs may remain for reuse.
There is no automatic purge.

## Organize a collection

Copy files in your file manager, select a folder or project in the list,
and press **⌘V** (macOS) or **Ctrl+V** to import them into that collection. PDFs become Library papers; other file
types (including images, documents, text, code, and archives) are saved as
original files under **Notes → Project files**, up to 32 MB per general file.
Importing a file does not guarantee an editable preview for its format.
Pasting files keeps the current list open; PDFs do not automatically open Reader.
The browser must expose the copied files to the clipboard event.
You can also use **Add to Noctua** or the optional
[Zotero importer](getting-started.md#import-from-zotero-optional). Collections
can be nested, and one paper can belong to several without duplicating its PDF.
Folders with children have a chevron on the left: click it to collapse or expand
their subfolders without changing the selected folder or graph. Clicking the
folder name selects it. Initially only the library root is expanded; other
branches start collapsed. Your later choices are remembered in this browser.
**Settings → Data & storage → Include papers from subfolders** is on by default.
It controls folder paper lists, counts, and folder graphs, including assistant
folder tools. Duplicate papers appear once even if saved in multiple nested
folders. The library root always shows all papers. Notes and project files keep
their own folder scope.
Folder counts align at the right edge. Hover a folder or focus its controls to
replace its count with rename, new-folder, and available import actions.
The library supports filtering, sorting, and metadata editing.

The same tree appears in **Notes**, and the selection is shared between the two
modes. The selected collection's notes and project files are listed under its
row; click a note to open it in Notes. The **Collections** header above the tree
creates notes, project folders, and imports in the selected collection. See
[Notes](notes.md#project-files-bibliographies-and-skills).

The Library table lists the selected collection's notes beside its papers. Note
rows have a notebook icon, show **Note** and their last edit in the Publication
column, and open in Notes when you click the title, double-click the row, or
press Enter. Use **All / Papers / Notes** above the table to choose what is
listed (remembered on this device). The text filter matches note titles; a tag
filter lists papers only, since notes have no tags. Notes are listed for the
selected collection itself, not its subfolders. The **New note** icon beside the
filter, or **New note** in a collection's right-click menu, creates a note there
and opens it.

Select a collection in the folder tree and switch to **Graph** or **Lineage** to
explore connections among its papers. **Papers** contains just the graph paper
list with sorting and filtering. Colors distinguish citation-connected clusters;
shared external references reveal connections between clusters. Project graphs
are saved and updated as the collection changes.


## Assistant organization

Chat can search saved papers, inspect their details, create or rename collections,
and add or remove papers across several projects. Removing a paper from a project
keeps it and its PDF in the shared Library. These requested actions apply
immediately in Suggest and Direct; Plan is read-only.

## Collection research details

Choose **New folder inside** in the Library tree, enter a name, and select
**Folder** or **Research project** before creating it. The compact creation and
research-details forms use the same aligned controls and footer actions as
other workspace dialogs. Ordinary folders use the
folder icon; research projects use the Lucide briefcase icon in Library, Graph,
and Lineage. New projects open Research details after creation. Existing
collections without research data remain ordinary folders; previously saved
research details identify a project.

Click a project or folder in the tree, then press **Enter** to rename it.
Press **Enter** again to save, or **Escape** to cancel.

Change **Folder type** in Research details later to convert either way. Changing
the type preserves goals, dates, progress, collection IDs, papers, and files.
The type belongs to each collection and is not inherited by subfolders. The
presence of `.workspace/research/state.json` activates the project; no stored type flag is required. Switching to an ordinary folder saves the details as `.workspace/research/inactive.json` and removes the active file. Switching back restores those details. An existing active file always identifies a project, regardless of any older type flag.

Hover or keyboard-focus a collection in the Library folder tree and choose
**Research details** (the pencil icon). The pencil and new-folder icons change to the accent color on hover or keyboard focus. Rename the folder in **Name**, or enter a goal, progress as a whole number from 0 to 100%,
and up to 50 personal target dates. Choose **Save** to store the changes. This
also works from the Graph and Lineage folder tree. Ordinary collections need no
research fields; no separate project entity is created.

Target dates are calendar dates for your own plan. They do not represent official
venue deadlines, time zones, or automatic countdowns. Research details belong to
the selected collection and are not inherited by its subfolders. Existing paper
membership, note/file IDs, and graph scope are unchanged.

A failed save keeps the editor and your input open. If another device saved a
new revision, copy any edits you want to retain, close the editor, then reopen it
to load the saved version before reapplying them. Cancel or Close asks before
discarding changed input. Changes are not automatically saved or recovered after
a browser crash.

Research data is stored in `.workspace/research/state.json` inside the collection's
existing notes directory. It is durable data, excluded from the Notes file tree,
normal file access, and compiler inputs. Include this hidden directory in backups;
a complete server update snapshot includes it when notes are inside the data
folder. An external notes directory needs its own backup, as described in
[Server and connections](server.md#drafts-backup-and-updates).

Switch Library, Notes, and Reader with Option+1, Option+2, and Option+3 on macOS, or Alt+1, Alt+2, and Alt+3 on Windows/Linux. Reader requires an open PDF. These shortcuts are inactive while a dialog is open.

Trash appears as the last row in the continuous Library folder list and is a virtual folder, not a collection membership. Click it to browse and restore deleted items in the main area. Drag papers or folders onto Trash to delete them after confirmation. Removing a paper from a collection or linking it to other collections does not put it in Trash.
