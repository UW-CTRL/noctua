# Noctua 🦉

A small, fast research-paper explorer. Search Semantic Scholar, see a
Connected-Papers-style graph of what a paper builds on and what builds on it,
save papers into your Zotero folders, and keep LaTeX + handwritten notes per
folder with a Claude research assistant alongside.

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

The chat assistant uses [Claude Code](https://claude.com/claude-code): install
it and sign in once (`claude` in a terminal). If Noctua can't find it, set
`"claude_path"` in `settings.json` (see *Your data* below).

## First run

Noctua asks for two things before it starts:

1. **Your Semantic Scholar API key.** Every user needs their own (free):
   [request one here](https://www.semanticscholar.org/product/api#api-key-form).
   Approval can take a while; until then choose *Continue without a key* to
   use the shared pool, which is slow and often rate-limited.
2. **Your Zotero data folder** (the one containing `zotero.sqlite`; Zotero →
   Settings → Advanced → Files and Folders), or *I don't use Zotero*.

Change either later with **⚙** in the header (or Noctua → Settings… / ⌘,).

## Your data

Everything Noctua stores lives in a per-user folder, so updating the app or
`git pull` never touches it:

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/Noctua` |
| Windows | `%APPDATA%\Noctua` |
| Linux | `~/.local/share/noctua` |

It holds `key.txt` (your API key, readable only by you), `settings.json`,
`notes/` (one folder per Zotero folder, with an `images/` folder), the chat
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
  Green ring = already in your Zotero library.
- Hover to highlight a paper's links (blue = it cites, orange = cites it).
  Click to open details, **double-click** to rebuild the graph around it, drag
  to move, scroll to zoom. **Expand here** adds a paper's own neighbours to the
  current graph. **Timeline** lays papers out left→right by year.
- **✕ Close graph** (next to the search bar) closes the current graph.
- **Library** tab: browse your Zotero libraries and folders (with item
  counts), filter/sort their items, and hit **Graph** on any item to build its
  citation graph. Items are found on Semantic Scholar by the Semantic Scholar id
  Noctua stores, arXiv id, or DOI, and otherwise by title (only accepted if the
  matched title agrees). Read from `zotero.sqlite`; while Zotero is running
  this is a snapshot that can lag a little behind very recent changes.
- **Projects** tab: pick a Zotero folder and **Open graph** to see how its own
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
  saves, Esc cancels. This writes to `zotero.sqlite` directly, so **Zotero must
  be closed**. The database is backed up to `zotero.sqlite.noctua-bak` before
  each change. New folders are marked unsynced, so Zotero uploads them on its
  next sync.
- **Resize the side panels** by dragging the line between a panel and the
  middle (double-click it to reset). Widths are remembered.
- **Add to Zotero**: pick a folder (defaults to the one in the header, which is
  remembered) and optionally attach the open-access PDF.

## Notes

Switch the header to **Notes** for a dark writing page attached to a Zotero
folder. Each folder holds any number of notes (**New note**, click to open, ×
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
- **Images**: paste a screenshot or copied file (⌘V; it goes into a new image
  cell unless an image, or an image cell's open source, is selected), drag
  files onto the note, or click **+ Image** between cells (🖼 on a text cell). Files are saved
  in the folder's notes directory under `images/`, and the cell gets a
  `figure` with `\includegraphics`, a caption and a `\label` (Figure n, with
  `\ref` working). Adding more images to an image cell turns it into
  `subfigure`s in a row (hold ⇧ while dropping to start a new figure instead).
  Click an image to select it, drag its left or right edge to resize (the
  width is written into the LaTeX), and press ✕ or Delete to remove it; the
  subfigures shrink back to a plain figure when one image is left. The image
  files themselves are never deleted. PNG, JPEG, GIF and WebP.
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
  handwriting to LaTeX with Claude (via your `claude` CLI login) and inserts it
  as a text block below; the drawing is kept.
- Notes save automatically (and on ⌘S) as one JSON file each in
  `notes/<folder>/`, keyed by the Zotero folder's permanent key, so renaming the
  folder doesn't lose them. Deleted notes move to `notes/.trash/`.
- The chat sees the open note, and can list and read any folder's notes. It can
  also look at a note's images (the one you clicked is pointed out to it), so
  you can ask it to transcribe a photo of equations, interpret a plot, or turn
  a diagram into LaTeX; images over 5 MB can't be viewed. It can
  also edit them, depending on the **chat mode** (badge under the chat box;
  Shift+Tab in the chat box cycles):
  - **✎ Suggest edits** (default): each change appears as a card under its
    block with Accept / Reject (or accept/reject all).
  - **◇ Plan**: read-only. Claude can't edit notes or add papers to Zotero; it
    investigates and answers with a plan.
  - **⚡ Direct edits**: changes apply immediately and are highlighted; "Undo
    Claude's edit" (under the note title) reverts them.

  Edits go through the open editor, so they never collide with autosave.
- **@-mentions** in the chat box search your Zotero papers and notes together
  (results tagged PAPER / NOTE, best 4 shown). The picked item's details (a
  paper's metadata and abstract, or a note's full text) are attached to the
  message, so Claude can read it, and edit a mentioned note.

## Chat

The **Chat** tab (right panel) is Claude, running through your installed
Claude Code CLI and your existing Claude login (no API key). Every message
automatically includes what you're looking at: the graph's center, the selected
paper and its abstract, your folders, and the list of papers in the graph (only
re-sent when the graph changes). Claude can also act through Noctua's tools:
search papers, open a paper's graph, select a paper, list your Zotero folders
and their contents, read or open a folder's project graph, list and read your
notes, and add papers to Zotero (it skips papers already in your
library). Paper links in its answers are clickable. **New chat** starts a fresh
conversation, and **Stop** cancels a reply. LaTeX in messages (`$…$`, `$$…$$`,
`\(…\)`, `\[…\]`) is typeset.

Chats are saved to `noctua-chats.sqlite` after every reply (including
stopped or interrupted ones). **History** lists them; pick one to reopen and
keep going, where Claude still remembers the earlier messages, or hover and
click × to delete it. Reloading the page reopens the chat you were in.

Under the hood each message runs `claude -p` (resuming the conversation) with
all built-in tools disabled. Its only tools are Noctua's, served over MCP at
`/mcp`. Set `NOCTUA_CLAUDE` to use a different `claude` binary.

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
- `src/zotero.rs`:
  - **Folders** are read from the running Zotero app's local connector
    (port 23119). If Zotero is closed, they're read read-only from
    `zotero.sqlite`.
  - **Saving** uses the same connector API as the Zotero browser extension
    (`saveItems`, then `updateSession` to file it into the chosen folder), so no
    Zotero web API key is needed, but **Zotero must be running**.
  - **"Already in library"** matches by DOI or normalised title against the
    local database.
- `src/project.rs`: project graphs. Builds clusters (connected components of
  the citation graph) and shared references from each item's saved Semantic
  Scholar record and reference list.
- `src/notes.rs`: note files, and handwriting-to-LaTeX through `claude -p`
  with the drawing sent as an image.
- `web/latex.js` (the LaTeX-subset typesetter), `web/ink.js` (drawing pads)
  and `web/notes.js` (the editor).
- `web/`: the UI (plain HTML/CSS/JS with a hand-rolled canvas force layout),
  embedded into the binary at compile time.

Citations are capped at the first 1000 Semantic Scholar returns per paper, and
the graph keeps the most-cited N of those (N = the "Top" selector).
