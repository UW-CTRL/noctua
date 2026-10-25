# PDF reader

[Documentation](README.md) · [Project README](../README.md)

## Read and follow references

Open a library paper's PDF, scroll through it, or navigate with page controls
and the **Outline** sidebar. Zoom and page colors can be adjusted independently
of the app's appearance.

Hover linked citations to preview bibliography titles, including grouped numbered
and author-year citations. Other internal links preview the destination passage,
equation, figure, table, or algorithm. Previews adapt to the content and can be
resized. Click a citation entry or destination page label to navigate there.
Reliable previews depend on the PDF's links and selectable text.

## Annotate

Select text and choose **Highlight** or **Comment**; use **Draw** for freehand
annotations. Comments support math and save automatically. Click a highlight
to open its comment, or use **Annotations** to browse and filter user and AI
annotations. Text selections for saved highlights currently cover one page.

Annotations are stored in Noctua rather than embedded in the original PDF.
Include the full [data folder](settings-and-data.md#storage-and-backups) in backups.

## Use AI while reading

Outline generation and auto-highlighting report progress in the shared bottom-right
notification. Sidebar controls remain available for navigation and retries.

Connect an [assistant](assistant.md) to enable:

- **AI-generated outline:** select it in **Outline** to generate a navigable
  section tree. The default **Document** view uses embedded PDF bookmarks.
- **Auto-highlight paper:** click the toolbar sparkle icon to identify Novelty,
  Method, Results, and Limitations, with source highlights and explanations.

Results are saved locally. You can regenerate the outline, and repeated
highlight runs reuse saved analysis without duplicating annotations. These
features analyze selectable text up to 400 pages; they do not OCR scanned PDFs
or analyze figure images. Both are Reader UI actions, separate from chat tools.

To discuss a passage, select it and choose **Add to chat**. You can also click a
detected figure, table, or algorithm to attach its source region. See
[Chat attachments](assistant.md#chat-attachments).

See [AI prompts](assistant.md#dedicated-ai-features) for how the outline and
auto-highlight tasks are instructed, with links to their source prompts.

## Undo and redo

The Reader Undo/Redo icons sit to the right of Page … of …, below the paper
title, leaving more width for the title. Use these buttons or Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z for
highlights, drawings, comments, replies, deletion, and accepted suggestions.
Automatic highlights form a grouped edit. History is separate for each paper
and lasts for the backend session. Revision checks prevent overwriting changes
from another window; resolve save conflicts before undoing.

## Find text and user comments

Press **Cmd/Ctrl+F** to search the whole PDF and user-written comments, including
user replies and unsaved comment drafts. Search is case-insensitive and matches
phrases across PDF text-layer line breaks. Enter/Shift+Enter or the arrow buttons
move between results; the result label identifies a PDF page or user comment.

Quoted passages copied into annotation cards and assistant-authored comments are
excluded. Editing a comment marks that comment as user-authored even when its
highlight was created by an agent. Older comments without this metadata use their
annotation's author. Search highlights are temporary and do not change saved
annotations. Escape closes Find and removes its highlights. Image-only PDFs need
an existing text layer; Find does not perform OCR.

The thin left/right arrow rails hide or reopen navigation/annotations and chat/details.
Both side panes can be fully closed without closing the PDF or losing a draft.
