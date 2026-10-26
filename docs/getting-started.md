# Getting started

[Documentation](README.md) · [Project README](../README.md)

## Install and open

Download the installer for your OS from
[GitHub Releases](https://github.com/UW-CTRL/noctua/releases/latest), install it,
and open Noctua. On Linux, make the AppImage executable before opening it.

You can continue without a Semantic Scholar API key. AI and Zotero are optional;
you do not need them to read local PDFs or write notes.

## Read your first paper and write a note

| Step | Action |
| --- | --- |
| 1. Choose a collection | In **Library**, select a collection or use **New folder inside** (+) to create one. |
| 2. Add a paper | Choose **Import PDF** and select a local file. Alternatively, search by title, DOI, or arXiv link and choose **Add to Noctua**. |
| 3. Read | Select the saved paper and choose **Read PDF**. Select text to highlight it or add a comment. |
| 4. Write | Switch to **Notes**, select the same collection, and choose **New note**. Enter a title and write a short takeaway; changes save automatically. |

If a search result has no downloadable PDF, use **Attach PDF** in its saved
paper details to add a local copy. The PDF and note are stored locally.

For more, see [Research](research.md), [PDF reader](reader.md), and [Notes](notes.md).

## Optional setup

### Add a Semantic Scholar API key

Enter a key in **Settings → Connections** for your own API access. Without one,
online search uses a slower shared pool and may encounter rate limits.

### Connect an assistant (optional)

Install [Codex CLI](https://developers.openai.com/codex/cli) or
[Claude Code](https://code.claude.com/docs/en/overview), then:

1. Open **Settings → Research assistant** and choose the provider.
2. Click **Sign in**, or use an existing CLI login detected by Noctua.
3. Choose a model, click **Check connection**, and open **Chat**.

No separate model API key is needed. Model access depends on your CLI account.
See [Research assistant](assistant.md) for capabilities, edit modes, and prompts.

### Import from Zotero (optional)

Set the Zotero data folder in **Settings → Connections**, then choose
**Library → Import from Zotero**. Close Zotero first for the freshest snapshot.
The dialog lets you choose detailed bibliography, tags, local PDFs, notes, and PDF
annotations. Collections and basic paper information are always copied. Cancel
closes the dialog without importing anything.

Noctua copies nested collections, metadata, tags (manual and automatic), citation
keys, and available local PDFs without changing Zotero. Import again to add missing
tags to existing papers; existing tags are kept and duplicates are skipped.
Bibliographic details include the full publication date, journal/book/proceedings
titles, volume, issue, pages, publisher, place, edition, series, ISBN/ISSN, language,
short title, journal abbreviation, and page/volume counts. Re-importing fills missing
details without overwriting existing values. These details are stored with the paper;
the details editor currently exposes only the common paper fields.
Notes are copied to their paper's collections; standalone notes keep their own
collections or go to the library root when unfiled. HTML becomes editable text
with paragraph breaks. Formatting and embedded images are not reproduced; original
HTML is retained with the note. Re-imports skip existing imported notes and
annotations, preserving local edits.

PDF annotations include highlights, underlines (shown as highlights), comments,
area/text annotations, and multi-stroke drawings. Positions, colors, quoted text,
and comments are retained. Area annotations show their rectangle rather than an
image thumbnail. Annotations follow the first available local PDF per paper;
additional attachments are not imported. Selecting annotations also selects PDFs.
Missing local PDFs or PDFs that differ from Noctua's attached copy produce a
warning. Download cloud-only PDFs in Zotero before importing. Zotero can stay
closed afterward.

## Show or hide side panes

Click the small arrow on either vertical rail to fully hide navigation or the
chat/details pane. The thin rail stays visible so you can reopen it. This works
in graph, notes, paper editor, and PDF reader views. Panes keep their previous
width, selection, and drafts; visibility is remembered across restarts. Drag the
rail to resize an open pane, or double-click outside the arrow to reset its width.
Arrow buttons are keyboard accessible with Tab and Enter/Space.
