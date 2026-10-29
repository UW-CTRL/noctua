# Getting started

[Documentation](README.md) · [Project README](../README.md)

## Choose a server

On first launch the desktop opens a **Server & connection** popup even when no
server is running. Follow **Choose → Connect → Save**; **Back** keeps your inputs.
Choose **Use this computer** to reuse/start an independent background
server, or enter another computer's private HTTPS address and authentication
token, test the connection, then choose **Save & connect**. Remote use requires no
AI CLI or API key on this client. Closing the app
leaves the server running; login auto-start is a separate opt-in setting.
The saved connection is retried next launch. If it fails, retry or change it from
the same screen; Noctua never silently switches a remote connection to local data.
See [Server and connections](server.md) for browser login, CLI and Tailscale Serve.

## Install and open

Download the installer for your OS from
[GitHub Releases](https://github.com/UW-CTRL/noctua/releases/latest), install it,
and open Noctua. On Linux, make the AppImage executable before opening it.

You can continue without a Semantic Scholar API key. AI and Zotero are optional;
you do not need them to read local PDFs or write notes.

## Use in a browser without the desktop app

You do not need to install the Noctua desktop app on the computer you browse
from. You do need a running Noctua server. Noctua does not provide a hosted
service, and opening a browser alone does not start a server.

If a server is already running, get its address and authentication token from
its owner. Open that address in your browser, enter the token and choose
**Connect**. Use the local address only on the server computer; another computer
needs the server’s configured HTTPS address. No local AI CLI or API key is needed
on a browser-only client.

To host a server without installing the desktop app, [build the standalone
server](development.md#run-and-build) on the computer that will store your library.
With its executable available, run:

```sh
noctua ensure
noctua token
```

Use the executable’s full path if it is not on your PATH: for a source build,
`target/debug/noctua` on macOS/Linux or `target/debug/noctua.exe` on Windows.
`ensure` starts or reuses a background server and prints its address; `token`
prints the authentication token separately. Open the returned address and sign
in. Keep the token private. Building the server requires the development tools
in the build guide; only the browser client needs no Noctua installation.

Once connected, **Settings → Server & connection** lets you enter another server’s
address and token, with a **How to start a server** reminder. Authenticated
localhost sessions also offer **Show token / Copy token** for the current server.
Closing the browser leaves the server running; use `noctua stop` on the server
computer to stop it after saving your work. For remote HTTPS setup and server
operations, see [Server and connections](server.md).

## Read your first paper and write a note

| Step | Action |
| --- | --- |
| 1. Choose a collection | In **Library**, select a collection or use **New folder inside** (+) to create one. |
| 2. Add a paper | Choose **Import PDF** and select a local file. Alternatively, search by title, DOI, or arXiv link and choose **Add to Noctua**. |
| 3. Read | Select the saved paper and choose **Read PDF**. Select text to highlight it or add a comment. |
| 4. Write | With the same collection selected, choose **New note or file** above the collection tree and pick **Note**. Enter a title and write a short takeaway; changes save automatically. |

If a search result has no downloadable PDF, use **Attach PDF** in its saved
paper details to add a local copy. The PDF and note are stored on the connected server.

For more, see [Research](research.md), [PDF reader](reader.md), and [Notes](notes.md).

## Optional setup

### Add a Semantic Scholar API key

Enter a key in **Settings → Integrations** for your own API access. Without one,
online search uses a slower shared pool and may encounter rate limits.

### Connect an assistant (optional)

On the **server computer**, install [Codex CLI](https://developers.openai.com/codex/cli) or
[Claude Code](https://code.claude.com/docs/en/overview), then:

1. Open **Settings → Research assistant** and choose the provider.
2. Click **Sign in**, or use an existing CLI login detected by Noctua.
3. Choose a model, click **Check connection**, and open **Chat**.

No separate model API key is needed. Model access depends on your CLI account.
See [Research assistant](assistant.md) for capabilities, edit modes, and prompts.

### Import from Zotero (optional)

Set the Zotero data folder on the **server computer** in **Settings → Integrations**, then choose
**Library → Import from Zotero**. Close Zotero first for the freshest snapshot.
Enter the folder path and select **Save Zotero location** beside it.
The dialog lets you choose detailed bibliography, tags, local PDFs, notes, and PDF
annotations. Collections and basic paper information are always copied. Cancel
closes the dialog without importing anything.

**Existing items → Sync changes** is the default. Each import compares Zotero's
current values with the last imported values. Unchanged imported fields receive
Zotero updates; local-only edits stay intact. When both sides change a field,
Noctua keeps the local value and reports the conflict. Imported tags merge source
and local additions/removals. Note content is compared as a whole.

Choose **Overwrite from Zotero** to replace selected paper fields, imported note
content, and imported annotation fields with Zotero values. Unselected content,
Noctua-only items, note settings, and local annotation replies stay intact.
Neither mode deletes papers, collection memberships, notes, or annotations that
were removed in Zotero, and neither replaces a different PDF. This is a one-way
update when you import, not continuous synchronization or a write back to Zotero.
Older imports without a saved baseline are handled conservatively by Sync;
choose Overwrite to adopt the source values for reported conflicts.

For PDFs, **Link original** is the default: Noctua reads the PDF at its Zotero
path without copying it into Noctua storage. Choose **Copy to Noctua** to keep an
independent file instead. Choose the PDF storage mode in the import dialog; a
successful PDF import remembers the choice for next time.
The source folder is the Zotero data folder containing `zotero.sqlite`, as configured
in Integrations (or `ZOTERO_DATA_DIR`). Setting a folder does not start an import.

Keep linked originals available. After moving the Zotero folder, update its path
in Integrations and import again to reconnect the same PDFs. A missing file produces
an error; a changed PDF is rejected to keep its cached text and annotations attached
to the original content. Changing the choice affects future imports. Re-importing
can switch the same PDF between link and copy; existing managed copies are not
automatically deleted when switching to links.

Noctua copies nested collections, metadata, tags (manual and automatic), and citation
keys without changing Zotero. Import again to add missing
tags to existing papers; duplicate tags are skipped.
Bibliographic details include the full publication date, journal/book/proceedings
titles, volume, issue, pages, publisher, place, edition, series, ISBN/ISSN, language,
short title, journal abbreviation, and page/volume counts. Re-importing follows
the selected Sync or Overwrite mode. These details are stored with the paper;
the details editor currently exposes only the common paper fields.
Notes are copied to their paper's collections; standalone notes keep their own
collections or go to the library root when unfiled. HTML becomes editable text
with paragraph breaks. Formatting and embedded images are not reproduced; original
HTML is retained with the note. Sync preserves local edits and reports conflicts;
Overwrite replaces imported note content and annotation fields.

PDF annotations include highlights, underlines (shown as highlights), comments,
area/text annotations, and multi-stroke drawings. Positions, colors, quoted text,
and comments are retained. Area annotations show their rectangle rather than an
image thumbnail. Annotations follow the first available local PDF per paper;
additional attachments are not imported. Selecting annotations also selects PDFs.
Missing local PDFs or PDFs that differ from Noctua's attached PDF produce a
warning. Download cloud-only PDFs in Zotero before importing. Zotero can stay
closed afterward.

## Show or hide side panes

Click the small arrow on either vertical rail to fully hide navigation or the
chat/details pane. The thin rail stays visible so you can reopen it. This works
in graph, notes, paper editor, and PDF reader views. Panes keep their previous
width, selection, and drafts; visibility is remembered across restarts. Drag the
rail to resize an open pane up to the space the center view needs, or double-click
outside the arrow to reset its width.
Arrow buttons are keyboard accessible with Tab and Enter/Space.
