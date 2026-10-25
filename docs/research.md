# Research

[Documentation](README.md) · [Project README](../README.md)

## Choose a view

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
Titles stay plain on hover; click one to inspect or edit its details. Use the PDF button or double-click
a paper with an attached PDF to open Reader. The network button opens that
paper's citation graph.

Switching to Graph or Lineage with no graph open builds a graph for the
selected library or collection. Graph and Lineage share a single sidebar: a
folder tree above selects the graph target, and **Papers** below
lists the current graph papers with filtering, sorting, and selection. Choosing
a folder opens its graph without hiding the tree or paper list. Drag the horizontal
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

Use the always-visible search field in the top app header to search Semantic
Scholar by keywords or paste a DOI, arXiv ID/link, or Semantic Scholar link,
then press Enter. Keyword results open below the field; choose a result to open its graph.
Press Escape or click outside to dismiss the results. There is no separate
Search tab.
The network shows a paper's references, citing papers, and similar recommendations.
Edges represent citations; node size reflects citation count and color reflects
year. A green ring marks papers already in your library.

Click a paper for details, double-click to build a graph around it, or use
**Expand here** to add its neighbors to the current graph. The **Top** selector
controls how many neighbors appear. Searches and graphs use Semantic Scholar;
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

## Organize a collection

Use **Add to Noctua**, **Import PDF**, or the optional
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

Select a collection in the folder tree and switch to **Graph** or **Lineage** to
explore connections among its papers. **Papers** contains just the graph paper
list with sorting and filtering. Colors distinguish citation-connected clusters;
shared external references reveal connections between clusters. Project graphs
are saved and updated as the collection changes.
