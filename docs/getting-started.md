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

## Read your first paper and write a note

| Step | Action |
| --- | --- |
| 1. Choose a collection | In **Library**, select a collection or use **New folder inside** (+) to create one. |
| 2. Add a paper | Choose **Import PDF** and select a local file. Alternatively, search by title, DOI, or arXiv link and choose **Add to Noctua**. |
| 3. Read | Select the saved paper and choose **Read PDF**. Select text to highlight it or add a comment. |
| 4. Write | Switch to **Notes**, select the same collection, and choose **New note**. Enter a title and write a short takeaway; changes save automatically. |

If a search result has no downloadable PDF, use **Attach PDF** in its saved
paper details to add a local copy. The PDF and note are stored on the connected server.

For more, see [Research](research.md), [PDF reader](reader.md), and [Notes](notes.md).

## Optional setup

### Add a Semantic Scholar API key

Enter a key in **Settings → Connections** for your own API access. Without one,
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

Set the Zotero data folder on the **server computer** in **Settings → Connections**, then choose
**Library → Import from Zotero**. Close Zotero first for the freshest snapshot.

Noctua copies nested collections, metadata, citation keys, and available local
PDFs without changing Zotero. Download cloud-only PDFs in Zotero before importing;
existing Zotero annotations are not imported. Zotero can stay closed afterward.

## Show or hide side panes

Click the small arrow on either vertical rail to fully hide navigation or the
chat/details pane. The thin rail stays visible so you can reopen it. This works
in graph, notes, paper editor, and PDF reader views. Panes keep their previous
width, selection, and drafts; visibility is remembered across restarts. Drag the
rail to resize an open pane, or double-click outside the arrow to reset its width.
Arrow buttons are keyboard accessible with Tab and Enter/Space.
