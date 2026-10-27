# PDF reader

[Documentation](README.md) · [Project README](../README.md)

## Read and follow references

Open a library paper's PDF, scroll through it, or navigate with page controls
and the **Outline** sidebar. Zoom and page colors can be adjusted independently
of the app's appearance.

To copy Zotero annotations, choose **Library → Import from Zotero → PDF annotations**.
The matching local PDF is required. Imported highlights, comments, area/text
annotations, and drawings appear in the Reader; underlines display as highlights.
On re-import, **Sync changes** preserves local edits and reports conflicts;
**Overwrite from Zotero** replaces imported fields while retaining local replies. See
[Zotero import](getting-started.md#import-from-zotero-optional) for attachment limits.
Zotero PDFs link to their originals by default; **Copy to Noctua** keeps an
independent file. Linked PDFs need their source folder available. If a file moves,
update the Zotero folder in Settings → Connections and import again. Noctua keeps
notes and annotations locally and does not modify the original PDF.
Downloading an already linked PDF checks that its source still exists and matches
the imported content. An unavailable or changed source returns an error rather than
a successful download. File verification is reused while size, timestamps, and
file identity remain unchanged, so cached text and outlines do not reread the whole
PDF on every request. A restart or detected file change requires validation again.

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

Detected boxes include the object and its caption while keeping neighboring
columns, running headers, author notes, and body paragraphs separate. Figures
can float beside prose or have captions beside their drawings; stacked panels
stay together. Tables can span columns and include rotated headings, outlined
lettering, or rows below an internal divider without a bottom border. References
inside table cells stay within their table. Ruled algorithm boxes stop at the
listing's closing border. Fully transparent drawing objects are excluded.

Detection requires selectable caption text and PDF drawing information; scanned
captions and unusual layouts may still need a text selection instead.

See [AI prompts](assistant.md#dedicated-ai-features) for how the outline and
auto-highlight tasks are instructed, with links to their source prompts.

## Undo and redo

The Reader Undo/Redo icons sit to the right of Page … of …, below the paper
title, leaving more width for the title. Use these buttons or Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z for
highlights, drawings, comments, replies, deletion, and accepted suggestions.
Automatic highlights form a grouped edit. History is separate for each paper
and lasts for the backend session. Revision checks prevent overwriting changes
from another window; resolve save conflicts before undoing.


## Assistant reads

Chat can search PDF text, read passages in parts, inspect annotations, and read
saved AI outlines without generating new analysis. Keep a Noctua chat tab open
when it needs uncached text or page images. Outline generation and
auto-highlighting remain Reader controls.

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
