# Settings and data

[Documentation](README.md) · [Project README](../README.md)

## Server & connection

The native Settings menu opens the local connection manager, including while
servers are offline. It selects this computer or another server, tests and retries
connections, shows identity/version/status and errors/logs, and manages **this
computer's** server and user-login auto-start. These local controls remain local
when a remote server is selected. Start/stop/restart and login auto-start are
separate actions; app exit and connection changes leave servers running.

Connection selection is device-local; remote tokens use the OS secure store.
AI CLI, API keys, Zotero and data-folder fields in the server UI belong to the
server computer. Client uploads are separate browser file controls. A connection
switch flushes every open editor first and is blocked by failed saves/conflicts.
Read [Server and connections](server.md) for operations, backup and recovery.

## Personalize the workspace

In **Settings → Appearance**, choose App, Notes, and Reader themes independently.
The three theme selectors have the same width. All default to System. Choose Light or Dark app artwork in the local connection manager’s Desktop
section; Light is the default. The device-local choice applies immediately and
is restored on launch. Server-hosted pages do not change native app artwork.

Checkboxes and selected graph filters follow the app theme's accent color:
brown in Light and purple in Dark, including when System changes appearance.
Navigation tabs share hover and pressed feedback; motion is disabled when your
system requests reduced motion.

You can also adjust interface, note, and chat fonts and highlight colors.
Changing AI category colors recolors matching assistant highlights; existing
user highlights keep their colors.

**Connections** holds the Semantic Scholar key and optional Zotero source;
**Research assistant** holds provider and model settings. Its **Lineage** group
contains **Summarize threads automatically** (enabled by default). This preference
is remembered in this browser and takes effect immediately; turning it off cancels
pending automatic summaries, while an already running request may finish. Manual
**Summarize threads** remains available in Lineage.

## Save destination and notifications

**Data & storage** groups its controls under **Library**, **Save destination**,
and **Storage**, using the same bold headings and section dividers as the other Settings pages.

**Settings → Data & storage → Include papers from subfolders** is enabled by
default and saved with Noctua's data. Turn it off to show only direct collection
members in folder lists, counts, and graphs. The library root always includes
all papers. Scope changes keep existing graph lookups cached.

Choose **Settings → Data & storage → Default save folder** for papers added
from search or a graph. The choice is remembered in this browser; if the folder
is unavailable, new papers default to the library root. PDF imports use the
folder selected in Library. Folder lists and counts refresh after changes.

Temporary progress, completion messages, and errors share one notification at
the bottom right. It uses a solid theme-accent background with contrasting text;
errors use a red background. This includes request queues, settings actions,
note saving, and Reader analysis. Active tasks remain visible until finished;
completion messages disappear after a few seconds, and errors stay longer.
Concurrent tasks share the same card and do not overwrite an error message.
The header no longer shows a separate request indicator or save-folder selector.

In Settings → Appearance → Fonts, Note font applies to the title, body, collection/save metadata, and empty-block writing hint. Title size (12–36 px, default 28 px) and Body size (12–26 px) are independent, apply
immediately, and are saved for this browser or desktop profile. Collection and save-status text stay at 14 px.

## Storage and backups

Desktop and browser modes share a local data folder:

| Platform | Default folder |
| --- | --- |
| macOS | `~/Library/Application Support/Noctua` |
| Windows | `%APPDATA%\Noctua` |
| Linux | `~/.local/share/noctua` |

It contains your library, PDFs, annotations, notes, media, project files, imported
skills, settings, and chats. Collection manifests and immutable file versions
live beneath the notes directory in `.workspace/manifest.json` and `.files/`;
imported skill packages live in `skills/`. Undo history and skill run results
last only for the backend session.
App updates do not replace it. Quit Noctua apps and servers before backing up
the entire folder; copying PDFs alone does not preserve annotations or notes.

To move storage, choose an empty folder in **Settings → Data & storage**, save,
then use **Restart safely** after other tasks finish. Closing a desktop window
alone does not stop the independent server. An enabled login definition follows
the relocated data, and the source remains available as a backup. Noctua copies the data and
keeps the original. Unset `NOCTUA_HOME` and `NOCTUA_NOTES` if they override the
location you want to select.

## Updates

Use the local connection manager's **Desktop → Check desktop update**.
Server-hosted web pages do not control the native updater. Save work before installing.
Linux in-app updates require AppImage; use your package manager for other builds.
Browser mode is updated by rebuilding or replacing the server binary.

See [Development](development.md#environment-overrides) for environment overrides.

## Independent server updates

Desktop updates do not stop or replace a running server. The server executable
is staged outside the app bundle by version/content hash. Use an explicit safe
Restart in the local connection manager after tasks finish to use the newly
bundled server and refresh an enabled service definition. Coordinate with other
clients before restarting. Unknown data-format versions are rejected before DB
open; first conversion and server version changes snapshot the SQLite databases.
See [server backup and updates](server.md#drafts-backup-and-updates) for complete
backup/restore and validation limits.
