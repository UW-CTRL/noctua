# Research

[Documentation](README.md) · [Project README](../README.md)

## Explore a paper's neighborhood

Search by keywords or paste a DOI, arXiv ID/link, or Semantic Scholar link.
The network shows a paper's references, citing papers, and similar recommendations.
Edges represent citations; node size reflects citation count and color reflects
year. A green ring marks papers already in your library.

Click a paper for details, double-click to build a graph around it, or use
**Expand here** to add its neighbors to the current graph. The **Top** selector
controls how many neighbors appear. Searches and graphs use Semantic Scholar;
cached results reduce requests, but fresh results can be delayed by rate limits.

## Trace research over time

Switch **Network | Lineage** to arrange papers chronologically in research
threads. Select a thread to focus it, or Shift-click two papers to trace their
main citation chain.

The **Threads** tab summarizes themes and key papers using your selected
assistant. Turn off **Summarize automatically** and use **Summarize threads**
when you want to control AI usage. Lineage remains usable without AI summaries.

See [AI prompts](assistant.md#dedicated-ai-features) for the thread summary's
inputs, output format, and [source instructions](../src/prompts/lineage.md).

## Organize a collection

Use **Add to Noctua**, **Import PDF**, or the optional
[Zotero importer](getting-started.md#import-from-zotero-optional). Collections
can be nested, and one paper can belong to several without duplicating its PDF.
**Settings → Data & storage → Include papers from subfolders** is on by default.
It controls folder paper lists, counts, and folder graphs, including assistant
folder tools. Duplicate papers appear once even if saved in multiple nested
folders. The library root always shows all papers. Notes and project files keep
their own folder scope.
The library supports filtering, sorting, and metadata editing.

In **Projects**, select a collection and choose **Open graph** to explore
connections among its papers. Colors distinguish citation-connected clusters;
shared external references reveal connections between clusters. Project graphs
are saved and updated as the collection changes.
