# Noctua 🦉

A small, fast research-paper explorer. Search Semantic Scholar, see a
Connected-Papers-style graph of what a paper builds on and what builds on it,
save papers into your Noctua library, and keep LaTeX + handwritten notes per
folder with your choice of Codex or Claude Code as the research assistant.

Noctua is a Rust program that serves its UI locally: as a **desktop app**
(its own windows, tabs and icon) or in your **browser**. No Node, no Electron,
no CDNs: the only third-party web code is KaTeX (MIT, for typesetting math),
embedded so everything works offline.

## Install

Download the app for your system from the GitHub **Releases** page:
`.dmg` (macOS), `.msi` / `.exe` (Windows), `.AppImage` / `.deb` (Linux).

The builds aren't code-signed yet, so the first launch needs one extra step:

- **macOS**: open it once, then System Settings → Privacy & Security →
  "Noctua was blocked…" → **Open Anyway**.
- **Windows**: SmartScreen → **More info** → **Run anyway**.

The research assistant uses your installed [Codex CLI](https://developers.openai.com/codex/cli)
or [Claude Code](https://code.claude.com/docs/en/overview) and its existing account login.
Use a current CLI version. In **Settings → Research assistant**, choose a backend and click
**Sign in** to complete its browser login. Existing CLI logins are detected automatically.
If a CLI is installed but not found, set `"codex_path"` or `"claude_path"` in
`settings.json` (see *Your data* below).

The **Settings → Research assistant** selector switches the backend for both chat and
handwriting-to-LaTeX. Each backend has its own saved conversations, CLI sessions, and
message draft. Switching restores that backend's last open conversation. If a reply is
running, switching stops it and waits for the interrupted turn to be saved. Existing
conversations are retained as Claude Code chats when upgrading.

## First run

Noctua asks for your **Semantic Scholar API key**. You can continue without one to use the slower shared pool. Configure the selected assistant in **Settings**.

Zotero is optional: configure its data folder in **Settings**, then choose **Library → Import from Zotero** to copy collections, metadata, and locally available PDFs. The source is read-only. Close Zotero before importing for the freshest database snapshot; it is never needed to open papers afterward.

## Settings

The header's **⚙ Settings** button opens a dialog with tabs on the left:

- **Appearance**: Light, Dark, or System for the app and independently for Notes.
  Appearance saves automatically in this browser and updates other tabs at the same address.
- **Research assistant**: choose Codex or Claude Code, a model (or custom model ID), reasoning
  effort, and fast mode. Choices save automatically per provider and apply to the next chat
  message or handwriting transcription. Provider defaults are available for model and effort.
  Supported efforts and fast mode availability depend on your model, CLI, and account; fast
  mode may use additional credits or incur extra charges. Sign in and check the connection here.
  Model choices and supported reasoning efforts are loaded from each installed CLI when
  Settings opens, after sign-in, and when checking the connection. Codex uses its `model/list`
  catalog; Claude uses its SDK initialization catalog, including fast-mode capabilities.
  Catalog entries can be cached by the CLI; successful inference confirms access. Saved model IDs
  outside the catalog remain available as custom models. Discovery failures are shown in Settings.
- **Connections**: save or remove a Semantic Scholar key and configure the Zotero import source.
- **Data & storage**: change the storage location.
  Choose an empty folder and save, then quit all Noctua apps and servers and restart.
  Noctua copies your library, PDFs, notes, settings, and chats to the new folder and keeps
  the original copy. You can cancel a pending change before restarting. The selection
  is saved in `storage-location.json` in the default data folder. Environment overrides
  (`NOCTUA_HOME` or `NOCTUA_NOTES`) must be unset before choosing a folder in Settings.
- **About & shortcuts**: app version and common keyboard shortcuts.

Switching settings tabs preserves unfinished fields. Keys and folder paths use explicit
Save buttons. Settings remembers its last tab; links such as **Add your API key** open
the relevant tab directly. Arrow Up/Down, Home, and End navigate the tabs; Esc closes the dialog.
The collection picker and Suggest / Plan / Direct controls stay in the workspace.

## Your data

Everything Noctua stores lives in a per-user folder, so updating the app or
`git pull` never touches it:

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/Noctua` |
| Windows | `%APPDATA%\Noctua` |
| Linux | `~/.local/share/noctua` |

It holds `key.txt` (your API key, readable only by you), `settings.json`,
`library/library.sqlite` (collections, paper metadata, annotations, and PDF text),
`library/pdfs/` (PDFs named by content hash), `notes/` (one folder per collection,
with an `images/` folder), the chat
history and the Semantic Scholar cache. Versions before this one kept these
files in the source folder; the first run copies them over (the originals are
left in place).

## Desktop app

Each window has tabs: **⌘T / Ctrl+T** new tab, **⌘W** close tab, **⌘N** new
window, **Ctrl+Tab** next tab, **⌘1–9** jump to a tab. Drag tabs to reorder;
right-click a tab to move it to a new window. Launching Noctua again opens
another window of the running app.

## Developing

Requires Rust (<https://rustup.rs>).

```sh
cargo run --release                 # browser version: serves http://127.0.0.1:7878 and opens it
cargo install tauri-cli --version "^2" --locked   # once
cd app && cargo tauri dev           # desktop app
cd app && cargo tauri build         # installers in target/release/bundle/
```

The browser version and the desktop app share the same data folder, key and
settings. Linux builds of the desktop app need WebKitGTK (`libwebkit2gtk-4.1-dev`
and friends; see the release workflow). Pushing a tag like `v0.2.0` builds
installers for all three systems with GitHub Actions
(`.github/workflows/release.yml`) as a draft release.

Environment overrides (all optional):

| Variable | Purpose |
|---|---|
| `NOCTUA_HOME` | use another data folder |
| `NOCTUA_S2_KEY` | Semantic Scholar key (instead of `key.txt`) |
| `ZOTERO_DATA_DIR` | Zotero data folder (instead of the one in Settings) |
| `NOCTUA_NOTES` | where notes are stored (default: `notes/` in the data folder) |
| `NOCTUA_CLAUDE` | path to the `claude` CLI |
| `NOCTUA_CODEX` | path to the `codex` CLI |
| `NOCTUA_PORT` | browser version's port (default 7878; the app uses 47878) |
| `NOCTUA_NO_OPEN` | don't open the browser |
| `NOCTUA_DEBUG` | log every request |

The local server only answers requests addressed to `127.0.0.1`/`localhost`
on its own port, and refuses writes from other websites' pages.

## Using it

- **Search** by keywords, or paste a DOI, arXiv id/link or Semantic Scholar link to
  jump straight to a graph.
- **Graph**: the center paper (accent ring), its references (*prior work*),
  papers citing it (*derivative work*) and Semantic Scholar's recommended
  *similar* papers. Edges are real citations between any two papers in view.
  Node size = citation count (log), colour = year (light = older).
  Green ring = already in your Noctua library.
- Selecting a paper automatically fetches its full abstract when missing from the current record, including library items. Loading, unavailable abstracts, and retryable errors are shown separately.
- Hover to highlight a paper's links (blue = it cites, orange = cites it).
  Click to open details, **double-click** to rebuild the graph around it, drag
  to move, scroll to zoom. **Expand here** adds a paper's own neighbours to the
  current graph. **Timeline** lays papers out left→right by year.
- **✕ Close graph** (next to the search bar) closes the current graph.
- **Library**: nested collections, local PDFs, filter/sort, metadata editing, and citation graphs. Use **Import PDF** for files, **Add to Noctua** for discovered papers, or the optional Zotero importer. A paper can belong to several collections without duplicating its PDF.
- **Projects** tab: pick a Noctua collection and **Open graph** to see how its own
  papers cite each other. Papers that cite one another (directly or through
  other folder papers) form a **cluster**, each with its own colour; papers with
  no citation links to the rest are *unconnected* (grey). Since clusters by
  definition don't cite each other, they're linked through **shared
  references**: outside papers cited from more than one cluster (hollow nodes,
  dashed lines; toggle with the chip). The tab lists the clusters, which
  clusters share the most references, and items Semantic Scholar couldn't find.
  The graph is saved per folder in `noctua-projects.sqlite`. Reopening it makes
  no Semantic Scholar requests; when the folder changes, only new or edited
  items are looked up (one batch request per 500 items, plus a title lookup for
  items with no DOI or arXiv id). If Semantic Scholar is rate-limiting, the
  items it couldn't reach are retried the next time you open the project.
- **Rename or create a folder**: hover it in the Library tab and click ✎ to
  rename it, or **+** (also on My Library) to create a folder inside it. Enter
  saves, Esc cancels. Changes are saved in Noctua’s own library.
- **Resize the side panels** by dragging the line between a panel and the
  middle (double-click it to reset). Widths are remembered.
- **Add to Noctua**: pick a folder (defaults to the one in the header, which is
  remembered) and optionally attach the open-access PDF.

## PDF reader

Open a library paper with **PDF**, **New tab**, or **New window**. Desktop PDF tabs can be reordered, restored, or moved into windows just like graph/note tabs. Scroll continuously through the document, or use the page controls to jump. Noctua keeps placeholders for all pages and renders a bounded set near the viewport, releasing distant canvases instead of allocating a high-resolution image for every page. Use zoom (40–600%) and the dark/light page toggle. Reader buttons and trackpad pinch re-render the PDF at the new scale and display pixel density; large canvases are bounded to 32 megapixels. Scanned pages remain limited by their source image resolution. Dark mode uses the bundled renderer’s Zotero color transformation at canvas resolution, without a CSS inversion filter. Use the light toggle for original page colors. **Settings → Appearance → Reader theme** offers **Dark**, **Light**, and **System** for the PDF pages only. The toolbar page toggle updates the same saved preference across reader tabs and windows. Annotations, document controls, and popovers follow the app theme. The PDF workspace follows the app theme and turns black in dark app mode, independently of the PDF page colors.

**Settings → Appearance → Fonts** lets you choose the app interface, note, and chat typefaces independently, with live previews. Each font picker has a size selector on its right: system UI 11–18px, note body 12–26px, and chat 10–24px. Chat text size can also be adjusted with the A−/A+ buttons in the chat header. Choose a preset or enter an installed font name under **Custom font…**. Choices are saved across sessions and synced between windows. Note titles stay centered; equations and source-code editors keep their own fonts.

The Reader's left sidebar has **Outline** and **Annotations** tabs. Outline shows the PDF's embedded section tree when available. If the PDF has no usable outline, Noctua automatically builds an AI outline from its selectable text using the assistant and model chosen in **Settings → Research assistant**, including inferred sections for papers without headings. Click a section to jump to its page and passage. AI section locations are checked against the indexed text and the result is cached locally for that PDF; reopening reuses it. **Generate with AI** can replace an embedded outline, and **Regenerate** refreshes an AI outline. Generation runs separately from chat and offers a retry if sign-in, generation, or location validation fails. AI outlines support up to 400 pages; scanned PDFs need OCR from another tool first. Outline generation controls are in the Reader UI, not MCP tools. Switching sidebar tabs preserves comment drafts, and selecting a highlight or comment opens Annotations.

**Settings → Appearance** shows six editable palette swatches in one row. Below them, Novelty, Method, Results, and Limitations each have a circular color button; click it to choose from those six palette colors. Changing a palette slot also updates AI defaults using that slot. Both settings save automatically. Defaults apply to new categorized annotations, including cached AI analysis and `annotate_pdf` calls that omit a color. Changing an AI category color also recolors existing assistant highlights in that category across the library; user highlights keep their saved colors. The Annotations filter buttons use the configured category colors.

Click **Auto-highlight paper** (the sparkle icon in the Reader toolbar) to have a dedicated AI worker identify the paper's **Novelty**, **Method**, **Results**, and **Limitations**. It uses the assistant/model configured in Settings, runs with its own temporary session and [start prompt](src/prompts/pdf-autohighlight.md), and leaves chat history unchanged. Progress and errors appear in Annotations. Highlights use category colors, page-margin labels, and short explanations; clicking a margin label opens its comment. Locations are checked against exact source passages before the batch is saved. Results save directly as ordinary annotations, which you can comment on or delete. Repeated clicks reuse the saved analysis and preserve edited comments without creating duplicate highlights. The worker only labels limitations supported by the paper; it may omit categories with no supporting passage. It analyzes selectable PDF text (up to 400 pages, with bounded page excerpts for long documents); it does not OCR scans or analyze figure images. The bulk Auto-highlight action is a Reader UI control. Assistants can use `annotate_pdf` with an optional `category` (`novelty`, `method`, `results`, or `limitations`) for individual passages.

Annotations shows separate **User highlights** and **AI highlights** totals at the top. Below them, click **User**, **Novelty**, **Methods**, **Results**, or **Limitations** to filter the comment list; click the active filter again to show all annotations. User includes user comments and drawings as well as highlights; the four category filters show assistant annotations in that category. The top totals count highlights across the whole paper and remain visible while the list scrolls. Filters affect the sidebar list, while all page highlights remain visible. Drafts survive filtering, and clicking a passage or margin label reveals its comment even if the current filter would hide it.

Select text and click **Highlight** or **Comment**; choose from six colors. **Draw** enables freehand annotation. Comments support `$inline math$` and `$$display math$$`, with a math preview as you type. The Reader has one comment editor per annotation, without a Reply composer or Save button. Comments save automatically after a short typing pause or when the editor loses focus; closing a Noctua tab flushes pending saves. Local drafts are retained if saving fails, and conflicting edits offer a choice between the saved comment and your draft. The icon in the card’s upper-right corner deletes the annotation (or rejects a pending suggestion). Previously saved discussion comments remain readable, including assistant suggestions with Accept/Reject controls. Selecting or focusing a comment emphasizes its highlight and scrolls to the passage; clicking highlighted text selects its comment. Clicking or focusing outside a comment removes the bold emphasis. Highlights and the blue background shown while dragging a text selection sit behind the original PDF text and graphics, keeping glyphs sharp in both light and dark page themes. Native text selection, copying, and annotation anchors remain available. Dark-page highlights use a subdued background; selecting a comment adds an outline without increasing the highlight fill. The reader joins neighboring word rectangles on the same line into a continuous highlight, including previously saved assistant and auto-highlights, while keeping separate lines and column gutters apart. Clicking the highlighted space between words selects its comment. Overlapping text highlights do not accumulate opacity, even when a selection contains duplicate rectangles. The later annotation supplies the color where different highlights overlap; each comment remains separate. Freehand drawings retain their original colors. Annotations save immediately; comment drafts survive reopening. Multiple windows share saved annotations and detect conflicting edits.

Hover over a linked numbered citation to see a text list such as `[2] World models`. All numbers in the bracket group are shown in ascending order; comma-separated citations and ranges such as `[2, 4–5]` are supported. Titles are extracted locally from the paper’s References/Bibliography text; unavailable entries are labeled rather than invented. Click an entry to jump to its reference, or click the original PDF link to navigate directly. Citation previews do not render page images. Other internal document links show their destination page as text. Drag the popup’s bottom-right corner to resize it (or focus that corner and use the arrow keys); the size is remembered in this browser and bounded to the window. Moving away dismisses the popup. External links open directly in a new browser tab (or the default browser in the desktop app), without hover previews or background website captures. Citation previews appear only on hover; dragging to select text does not open them. PDFs without selectable bibliography text cannot always supply titles. Saved text highlights currently cover one page per selection.

Both assistants can download PDFs on request with `download_pdf`: use a saved paper key or a Semantic Scholar/DOI/arXiv identifier, with an optional direct PDF URL. Downloads reuse existing files and report unavailable or invalid sources; Plan mode stays read-only.

Both assistants can read/search PDFs, view rendered page images, highlight exact passages, and discuss them in comment threads. **Suggest** creates pending highlights/replies with Accept/Reject controls; **Direct** saves immediately; **Plan** cannot write annotations. PDF text is indexed locally by the reader; scanned pages remain viewable but do not gain OCR. Keep a Noctua chat tab open while the assistant requests uncached text or page images.

The optional Zotero import preserves nested collections and citation keys, and reconnects existing collection notes. It copies the first available local PDF per paper; cloud-only files must first be downloaded in Zotero. Existing Zotero annotations are not imported. Noctua annotations live in its database, not embedded in the original PDF. Back up the entire Noctua data folder, including `library/`.

## Notes

Switch the header to **Notes** for a writing page attached to a Noctua
collection. Use **Settings → Appearance → Notes theme** to choose **Dark**, **Light**,
or **System** (follows your system appearance). Dark is the default. Your choice
is remembered in this browser and shared with other tabs at the same address.
Drawing colors adapt for readability without changing saved strokes.
Each folder holds any number of notes (**New note**, click to open, ×
to delete; the title is edited at the top of the page). A note mixes two kinds
of blocks; hover between blocks for **+ Text** / **+ Drawing**, or press ⌘⇧D
to add a drawing pad after the current block.

- **Text blocks** are written in LaTeX and typeset in Computer Modern, like a
  compiled paper. Click a block to edit its source, with a live preview
  underneath; Esc or ⌘↵ (or clicking away) finishes. Supported: `$…$`,
  `\[…\]`, `equation`/`align`/`gather` (numbered, with `\label`/`\eqref`),
  `\newcommand`, `\section`/`\subsection`, `itemize`/`enumerate`, theorem,
  lemma, definition, problem, … with optional titles, `proof`, `\emph`,
  `\textbf`, `\href` and more. Unknown commands are shown in orange.
  In text, click a resolved `\ref{key}` or `\eqref{key}` to jump to its
  `\label{key}` in the current note, including labels in other blocks.
  An align reference jumps to the equation group; missing labels show `??`.
- **Images and videos**: paste a screenshot or media file (⌘V, when the clipboard
  provides the file), drag files onto the note, or click **+ Image / Video**
  between cells. The **?** button beside the note title opens a guide to
  writing, YouTube embeds, media, blocks, citations, and assistant edits.
  New files share the collection's note
  `media/` directory; existing `images/` references continue to work.
  Noctua inserts `\includegraphics` for images and its own `\includevideo`
  command for videos, inside a figure with a caption and label. For example:
  `\includevideo[width=0.6\textwidth]{media/<file>.mp4}`.
  Paste a YouTube video URL on its own line in a text block to embed a player.
  Watch, short sharing, Shorts, and live links are supported, including start
  timestamps. Players do not autoplay and include an Open on YouTube link.
  Select an existing figure before pasting to add to it. Adding images or
  videos to that figure creates side-by-side subfigures; hold ⇧ while dropping
  to start a separate figure instead. Drag either edge of an image or video
  to resize it; the width is saved in the LaTeX. ✕ or Delete removes the
  selected item from the note, retaining the attachment file.
  Images: PNG, JPEG, GIF and WebP, up to 32 MB. Videos: MP4 (including M4V),
  MOV and WebM, up to 512 MB, with native playback controls and seeking.
  Codec support depends on the system's webview; MP4 with H.264/AAC is a
  practical choice. Videos play inside Noctua; `\includevideo` is not a
  standard LaTeX command and does not produce a playable PDF on export.
- **Typing shortcuts** (Overleaf-style, in note source and the preamble):
  select text and type `$`, `(`, `[`, `{`, `"` or `'` to wrap it (`"` gives
  ``` ``…'' ```); ⌘B / ⌘I (or Ctrl) wrap in `\textbf{…}` / `\textit{…}`, and
  pressing it again unwraps. Typing `(`, `[`, `{` or `$` inserts the closing
  one too, typing the closer steps over it, Backspace in an empty pair deletes
  both, and `$` inside `$|$` makes `$$|$$`.
- **Preamble**: hover the title and click **⚙** to open the note's header
  cell. Its preamble takes no space on the page and applies to the whole note:
  `\usepackage[margin=1in]{geometry}` or `\geometry{left=…, right=…, top=…,
  textwidth=…}` sets the page margins (the page is a scaled letter-size sheet,
  so 1in is 1/8.5 of its width). For a wider page, add `paperwidth=14in` (or
  `landscape` for 11in): the text column grows at the same type size, and the
  note scrolls sideways when the page is wider than the space between the
  side panels. `\newcommand`, `\def` and
  `\DeclareMathOperator` define commands for every block. `\usepackage{parskip}`
  (no indents, space between paragraphs) or `\setlength{\parindent}{0pt}` /
  `\setlength{\parskip}{6pt}` set the paragraph shape; `\noindent` works for
  a single paragraph. Packages KaTeX already
  covers (amsmath, amssymb, mathtools, …) are accepted, and others are flagged
  as unavailable. Esc closes it.
- **`\cite{`** opens a picker over the folder's papers; it inserts the Zotero
  item key and renders as "(Author Year)". Clicking a citation shows the paper
  in the right panel, with a button to graph it.
- **Note links**: type `[[` (or `\noteref{`) to search your notes in every
  folder; picking one inserts `\noteref{<note id>}`, shown as the note's current
  title (so renames never break links). Click it to open that note.
- **Drawing pads** take pen input (Wacom pressure sets the width; flip the pen
  to erase; touch is ignored), with colours, widths, eraser, undo/redo (⌘Z /
  ⇧⌘Z) and a draggable bottom edge. **TeX** (left of the block) converts the
  handwriting to LaTeX with the selected assistant (using its CLI login) and inserts it
  as a text block below; the drawing is kept.
- Notes save automatically (and on ⌘S) as one JSON file each in
  `notes/<folder>/`, keyed by the Zotero folder's permanent key, so renaming the
  folder doesn't lose them. Deleted notes move to `notes/.trash/`.
- The selected assistant sees the open note, and can list and read any folder's notes. It can
  also look at a note's images (the one you clicked is pointed out to it), so
  you can ask it to transcribe a photo of equations, interpret a plot, or turn
  a diagram into LaTeX; images over 5 MB can't be viewed. It can
  also edit them, depending on the **chat mode** (badge under the chat box;
  Shift+Tab in the chat box cycles):
  - **✎ Suggest edits** (default): each change appears as a card under its
    block with Accept / Reject (or accept/reject all).
  - **◇ Plan**: read-only. the assistant can't edit notes or save papers to Noctua; it
    investigates and answers with a plan.
  - **⚡ Direct edits**: changes apply immediately and are highlighted; "Undo
    assistant's edit" (under the note title) reverts them.

The English note capability guide in `src/prompts/notes.md` is included in both
assistants' system prompt at build time. Keep it, the in-app note guide, and
relevant MCP tool descriptions in sync whenever note features change (see
`AGENTS.md`). Rebuild and restart the backend to activate prompt changes.

  Edits go through the open editor, so they never collide with autosave.
- **@-mentions** in the chat box search your Noctua papers and notes together
  (results tagged PAPER / NOTE, best 4 shown). The picked item's details (a
  paper's metadata and abstract, or a note's full text) are attached to the
  message, so the assistant can read it, and edit a mentioned note.

## Chat

The right panel remembers the selected **Paper** or **Chat** tab across page reloads.

The **Chat** tab (right panel) uses the selected Codex or Claude Code backend and
its existing login (no separate API key). Every message
automatically includes what you're looking at: the graph's center, the selected
paper and its abstract, your folders, and the list of papers in the graph (only
re-sent when the graph changes). The assistant can also act through Noctua's tools:
search papers, open a paper's graph, select a paper, list your Noctua collections
and their contents, read or open a folder's project graph, list and read your
notes, and save papers to Noctua (adding existing papers to the chosen collection). Paper links in its answers are clickable. **New chat** starts a fresh
conversation, and **Stop** cancels a reply. LaTeX in messages (`$…$`, `$$…$$`,
`\(…\)`, `\[…\]`) is typeset.

Drag text in the PDF Reader, rendered notes, paper details, or a chat message and click **Add to chat** to attach the excerpt to the current composer. Theme-colored numbered badges and a faint highlight mark attached source passages. The badges show which passages are queued and match their order in the preview. Clicking a badge opens its attachment preview; removing or sending attachments removes the badges and faint highlights without modifying the source. Multiple passages appear as an annotation-count chip; hover over it to preview sources and text, remove individual entries, or clear them all. These attachments are distinct from saved PDF annotations. Pending attachments are kept locally per assistant and conversation, and sent excerpts remain expandable in saved user messages. The assistant receives each passage with its paper/page or note identifiers. Failed submissions retain the attachments. You can attach up to 20 passages (12,000 characters per passage; 40,000 total). Sending only attachments asks the assistant to explain them. This uses the existing Chat tab. For a one-page PDF selection, the same popup offers six palette circles below **Add to chat**; clicking a circle immediately saves a user highlight in that color.

Hover over a detected **Figure**, **Table**, or **Algorithm** in the Reader to see a faint box, then click it to add it directly to the current chat annotations. Boxes include caption continuations and nearby stacked figure panels, and tables can have captions above or below their rows. In two-column layouts, detection estimates the text gutter to keep adjacent objects and their captions separate while retaining figures that span both columns. Detection uses selectable captions and local PDF drawing geometry, then trims empty padding against the rendered page; no AI request runs on hover. Attachments include the caption, available text, and the paper/page/region location. The assistant can inspect the original page with `view_pdf_page`; the attachment is not an uploaded image crop. Ordinary text dragging and citation links retain their existing behavior. Scanned PDFs and unusual caption layouts may not expose selectable objects.


Replies also render Markdown tables, `>` blockquotes, read-only task status
(`- [ ]` / `- [x]`), and collapsible explanations using `<details>` with a
`<summary>` on its own line. Language-tagged code fences have syntax highlighting
and a Copy button. Fenced `mermaid` diagrams render after streaming finishes,
follow the app theme, and offer Source and Copy controls. Invalid diagrams keep
their source visible. Mermaid 12.2.0 and Highlight.js 11.12.0 are bundled locally;
diagram rendering loads on demand without a runtime CDN. These formats apply
to chat, while notes retain their LaTeX syntax. The shared assistant instructions
in `src/prompts/chat-formatting.md` describe the supported formats.

Chats are saved to `noctua-chats.sqlite` after every reply (including
stopped or interrupted ones). **History** lists them; pick one to reopen and
keep going, where the same backend still remembers the earlier messages, or hover and
click × to delete it. Reloading the page reopens the chat you were in.

Under the hood each message runs `claude -p` or `codex exec --json`, resuming
that conversation's provider-specific session. Both use Noctua's MCP tools at `/mcp`;
Claude's built-in tools are disabled, and Codex runs with command execution disabled
and a read-only filesystem sandbox. Codex receives an isolated per-invocation
configuration, sharing its normal login without importing user-configured MCP servers.
Codex messages appear as each message item completes; Claude streams text deltas.
Handwriting conversion uses an image attachment and a separate, non-persistent CLI run.
Credentials remain in the CLI's own credential store.

Development checks:

```sh
cargo test                         # migration, stream events, HTTP handlers and fake CLI integration
swift tests/frontend.swift         # macOS: JavaScript syntax and backend switching, using JavaScriptCore
swift tests/assistant-settings.swift # model, reasoning, fast mode, and preference save recovery
```

The backend integration tests use temporary data and fake CLIs; they do not sign in
to real accounts or make Semantic Scholar or model requests.

## How it works

- `src/s2.rs`: Semantic Scholar client. Every request goes through one FIFO
  gate spaced 1.1 s apart (the key allows 1 req/s; the margin avoids
  edge-of-window 429s). 429/5xx responses back off exponentially and delay the
  whole queue. The header shows how many requests are waiting.
  A graph costs 3 requests (paper, references, citations), plus one batch
  request for the links between papers and one for similar papers.
- `src/cache.rs`: every response is cached in `noctua-cache.sqlite`
  (search 1 day, papers 7 days, reference lists 30 days), so revisiting a
  graph is instant and uses no quota.
- `src/library.rs`: native SQLite library, immutable PDF files, collection membership, annotations, and optional Zotero import.
- `src/reader.rs`, `web/pdf.js`, `web/library.js`: reader HTTP API, offline PDF.js rendering, local text indexing, and assistant PDF tools.
- `src/zotero.rs`: read-only adapter for importing Zotero metadata and PDFs.
- `src/project.rs`: project graphs. Builds clusters (connected components of
  the citation graph) and shared references from each item's saved Semantic
  Scholar record and reference list.
- `src/agent.rs`: CLI discovery, account status, browser sign-in, and Codex configuration.
- `src/chat.rs` / `src/history.rs`: provider-specific chat execution, session resumption, and saved history.
- `src/notes.rs`: note files and handwriting-to-LaTeX through the selected backend,
  with the drawing sent as an image.
- `web/latex.js` (the LaTeX-subset typesetter), `web/ink.js` (drawing pads)
  and `web/notes.js` (the editor).
- `web/`: the UI (plain HTML/CSS/JS with a hand-rolled canvas force layout),
  embedded into the binary at compile time.

Citations are capped at the first 1000 Semantic Scholar returns per paper, and
the graph keeps the most-cited N of those (N = the "Top" selector).

Developer checks: `cargo test --offline` and (on macOS) `swift tests/frontend.swift`.
`swift tests/abstracts.swift` checks abstract loading, selection races, and retries.
`swift tests/fonts.swift` checks saved font preferences; `swift tests/reader.swift tests/fonts.html` checks UI/document font isolation and preserved math typography.
`swift tests/markdown.swift` checks chat tables, streaming, inline math, code fences, and HTML escaping.
It also checks blockquotes, nested collapsible content, checklist status, and
completed versus streaming diagrams. `swift tests/chat-rendering.swift` verifies
the real WebKit renderer, code copying and highlighting, diagram rendering,
theme changes, and invalid-diagram fallback.
`swift tests/reader.swift tests/selects.html` checks shared web dropdowns, keyboard controls, native value synchronization, and dynamic options in WebKit.
`swift tests/pdf-navigation.swift` checks page-window bounds, destination resolution, safe external links, and bibliography matching.
`swift tests/reader.swift tests/pdf-reader.html` exercises the continuous reader, Outline/Annotations tabs, outline navigation and retries, auto-highlight progress and category labels, highlight overlap pixels, and link popovers in a desktop WebKit session.
`swift tests/pdf-zoom.swift` checks rendering density, zoom gestures, and canvas limits.
`swift tests/pdf-selection.swift` checks comment/highlight selection, continuous line geometry, and agent page navigation.
`swift tests/highlight-colors.swift` checks palette swatches, circular AI color controls, per-category saves, palette remapping, and save-failure recovery.
`swift tests/reader.swift` exercises bundled PDF.js canvas rendering and text-selection geometry in WebKit; it requires a desktop session that permits WebKit subprocesses.

PDF attachment badges sit in the page margins, aligned with the start of the selected passage, without covering its text.
