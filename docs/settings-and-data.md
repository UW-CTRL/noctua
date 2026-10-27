# Settings and data

[Documentation](README.md) · [Project README](../README.md)

## Server & connection

Connection, recovery and browser sign-in screens use the app’s light/dark colors,
controls and UI typography. The desktop remembers the last connected app’s
appearance on this device, so its local connection screen keeps that appearance
even while the server is offline; first launch follows the system theme.
Connection setup is a popup with **Choose → Connect → Save** steps and **Back**
navigation. **This computer** and **Desktop** tabs contain management controls,
so they do not appear alongside the connection steps. Input is retained when
going back; changing connection details requires a new test before saving.

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

**Connections** holds the Semantic Scholar key, optional Zotero source, and Google Scholar Inbox;
choose the Zotero data folder containing `zotero.sqlite`. **Default PDF storage**
defaults to **Link original**, which reads PDFs from their source paths without
copying them. Choose **Copy to Noctua** and **Save default** for independent copies.
The import dialog uses this preference and allows a per-import override, including
when the source folder is set by `ZOTERO_DATA_DIR`. Save the source folder, then
choose **Import from Zotero** to select and import content. After moving the source,
update the folder and re-import to reconnect unchanged PDFs.

**Research Assistant** holds provider and model settings. Its **Lineage** group
contains **Summarize threads automatically** (enabled by default). This preference
is remembered in this browser and takes effect immediately; turning it off cancels
pending automatic summaries, while an already running request may finish. Manual
**Summarize threads** remains available in Lineage.

## Google Scholar Inbox

Open **Settings → Connections → Google Scholar Inbox** to import Google Scholar
alerts from Gmail. The **?** button beside the heading opens a setup guide for
Scholar alerts, Google Cloud, OAuth credentials, and Gmail connection in four
short steps. Expand **Access & Troubleshooting** for the full scope, reconnect
guidance, and inbox creation details. Close it
with the close button or Esc to return to your unchanged settings.
This is optional and off by default. In Google Cloud, enable
Gmail API, configure the OAuth consent screen (add your account as a test user
when using Testing), and create an OAuth client of type **Desktop app**. Save its
client ID and client secret under **Google Connection**, then choose
**Save & connect** to save settings and
approve read-only Gmail access. Sign in using the system browser on the computer
running the Noctua server; the callback uses that computer's loopback address.
See Google's [Desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)
and [Gmail API setup](https://developers.google.com/workspace/gmail/api/quickstart/python#set-up-environment).
Google may require verification for wider distribution; external apps in Testing
can require frequent reauthorization.

Choose **Check now** to collect alerts immediately, or enable **Poll automatically**
and save. Polling defaults to every 15 minutes; the minimum is 15 minutes (maximum: 1440).
Saving a shorter interval shows an error. Previously saved shorter intervals
use 15 minutes after restart. Polling runs only while the Noctua
server is running. Active Scholar runs prevent a safe server stop or update
until they finish. Check now also works with automatic polling turned off.
The first scan considers all available messages from
`scholaralerts-noreply@google.com`, including already-read alerts; subsequent
scans skip completed messages. Mail is never marked read, labeled, moved, deleted,
or sent. Gmail grants read access to the mailbox; Noctua searches only Scholar
alerts. Refresh tokens and OAuth client credentials stay in the server's data
folder and are never returned to the browser. Keep data-folder backups private.

### Scholar Agent Prompt

Choose **Destination collection**, then **Edit prompt**. The popup edits the
screening instructions for that collection. Replace the literal
`<Research Interest>` placeholder with your research interests during first setup,
then choose **Save prompt**. Until you replace it, collection is paused and no
papers are saved. The default instruction saves only papers with a clear,
substantive match. Each folder has its own prompt; renaming it keeps its prompt.
**Use default** restores the editable template; **Cancel** keeps the saved prompt.
A conflicting save or an active sync leaves the editor open so you can retry.

Save the destination settings, connect Gmail, and use **Check now** or automatic
polling. Scholar verifies each alert's paper against Semantic Scholar, downloads
its available open-access PDF, and extracts text on the server. The Scholar agent
uses the provider, model, and reasoning settings under **Research Assistant**.
Set up and sign into that provider first. Text is sent to your selected AI provider
for screening. Noctua checks the decision, explanation, and quoted evidence before
saving a matching paper and its PDF to the selected collection. Unrelated papers
are marked **excluded** and stay out of Library; existing papers are deduplicated
and linked only when accepted. No per-paper approval is required.

The prompt controls save/exclude decisions. It does not execute skill scripts,
edit notes, link other projects, or enable agent tools. Emails remain unchanged;
Gmail tokens and OAuth secrets are not sent to the agent. Background reading works
without an open Reader tab. Automatic reading currently supports text-based PDFs
from Semantic Scholar's open-access link, arXiv, or a matching Library PDF, up to 20 MB, 400 pages, and
240,000 bytes of extracted text. HTML-only articles, paywalled links, encrypted
PDFs, and scans without readable text need manual review. Noctua does not bypass
access controls or decide from an abstract alone. Inaccessible papers, invalid
analysis, and provider failures are not saved and are retried on later polls.

Choose **Log** next to **Edit prompt** to see the Scholar agent’s activity.
The header shows Idle or the current step and paper (Reading PDF, Analyzing,
or Saving). The list stays compact: time, result, and paper title on one line.
Expand a row for the decision reason or error, full date, provider, destination,
and account. **Results** shows saved, linked, excluded, retry, and sync outcomes;
**All steps** also shows Gmail checks, verification, PDF reading, analysis, and
cached decisions. The open log updates every three seconds. **Older entries**
loads earlier history. Logs survive restarts and prompt changes; unfinished runs
are marked Interrupted after restart. Disconnecting keeps the local history.
Logs contain operational events and decision reasons, not raw agent transcripts,
full paper text, prompts, or OAuth secrets.

Recent outcomes show imported, duplicate, excluded, and retry counts with reasons.
Progress and completed screening decisions survive restart. Duplicate alerts reuse
a completed decision for the same prompt and destination. Editing the prompt or
changing destination reconsiders earlier alerts on the next sync; existing Library
papers are kept. Selecting **scholar_inbox** creates it when you save; other
existing folders, including nested folders, can be selected from the list.

**Save & reconnect** renews expired Gmail access. **Disconnect Gmail** stops
polling and removes the local refresh token while keeping papers and prompts.
To revoke Google's grant too, remove the app from your Google Account connections.

## Skills

Open **Settings → Skills**. **Global Agent Skills** reads installed packages in
place on the server computer. **Location** defaults to `~/.agents/skills`, the
[Vercel Skills CLI's shared global location](https://github.com/vercel-labs/skills/blob/main/src/installer.ts).
Enter an existing absolute folder path (or a path beginning with `~/`) and choose
**Save location** to use another folder. **Use default** restores the default.
This preference persists in Noctua. Changing it does not move or modify packages.
Use **Refresh** to see local updates; `/` searches also read the current location.
CLI link-mode package folders are supported; internal resource symlinks are not.

Under **Project Skills**, choose **Import Skills from Project** and select a
project folder or its skills folder. Noctua finds folders containing `SKILL.md`
and imports all their supporting files together. Unrelated project files, `.git`,
and `node_modules` are excluded. Each import appears as a named project with a
skill count. Click its heading to expand or collapse its available skills, then
expand a skill to inspect its instructions and resources. Project A and Project B
keep independent lists even if their skills have identical names.

Imports are snapshots copied into Noctua, not live links. A project import supports
up to 100 skills, 512 files, and 32 MB total; each `SKILL.md` must be under 256 KB.
**Disconnect** on a project removes all of that group's Noctua copies. It keeps
the original project, global installations, and other imported projects unchanged.
Stop any running scripts for that group before disconnecting. Import the project
again to reconnect; reselect any desired chat defaults.

**Import an individual skill** retains folder, ZIP, and standalone `SKILL.md`
imports. These and older ungrouped imports appear under **Other imported skills**
with individual Disconnect actions. Global installations have no Disconnect action.

Under **Chat Project Defaults**, choose a Noctua project, select skills to make
available on every chat message there, and choose **Save project defaults**.
This is separate from the source-project import groups. An empty selection clears
its defaults. Use `/` in chat to search all available skills and invoke additional
skills for one message without changing these defaults. Both providers share the
available skills. Discovery and import never enable skills or run scripts.
Scripts require approval and separate output review; see
[Research assistant](assistant.md#project-files-and-imported-skills).

## Save destination and notifications

**Data & Storage** groups its controls under **Library**, **Save Destination**,
and **Storage**, using the same bold headings and section dividers as the other Settings pages.

**Settings → Data & Storage → Include papers from subfolders** is enabled by
default and saved with Noctua's data. Turn it off to show only direct collection
members in folder lists, counts, and graphs. The library root always includes
all papers. Scope changes keep existing graph lookups cached.

Choose **Settings → Data & Storage → Default save folder** for papers added
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
last only for the backend session. Globally installed skills stay in
the configured global location and are not included in Noctua backups or storage relocation.
App updates do not replace it. Quit Noctua apps and servers before backing up
the entire folder; copying PDFs alone does not preserve annotations or notes.
Linked Zotero PDFs remain outside Noctua storage and are not copied by backups or
storage relocation. Their notes, annotations, and cached analysis stay in Noctua;
keep the Zotero source available separately. Originals are read without modification.

To move storage, choose an empty folder in **Settings → Data & Storage**, save,
then use **Restart safely** after other tasks finish. Closing a desktop window
alone does not stop the independent server. An enabled login definition follows
the relocated data, and the source remains available as a backup. Noctua copies the data and
keeps the original. Unset `NOCTUA_HOME` and `NOCTUA_NOTES` if they override the
location you want to select.

## Updates

Use the local connection manager's **Desktop → Check desktop update**.
Server-hosted web pages do not control the native updater. Official builds check
at startup after restoring or retrying a saved connection. Save work before installing.
**Install offered update** opens an in-app confirmation. Choose **Install update** to download,
verify, and install it, or **Cancel** / Esc to leave the app unchanged. After
installation, use **Restart Noctua** when offered.
The startup popup lists release highlights from your installed version through
the offered update, newest first, including versions you skipped. Scroll the
history with a mouse or trackpad, or focus it with Tab and use the arrow keys.
The update and dismissal buttons stay visible. Each version has a **Release notes**
link for its full details; the popup shows summaries, not every changelog item.
Older update manifests without history provide a link to the offered release.
Linux in-app updates require AppImage; use your package manager for other builds.
Browser mode is updated by rebuilding or replacing the server binary.

See [Development](development.md#environment-overrides) for environment overrides.

## Independent server updates

After the updated desktop opens, an existing local server is upgraded separately.
Clients receive a maintenance notice and save open edits; active tasks finish
before the server is stopped, backed up and replaced. Failed saves or a task wait
timeout keep the old owner running. An enabled login service follows the verified
replacement; auto-start is never installed implicitly. Previous staged executables
are cleaned only after the new identity/version is verified and their references
are released. Use **This computer → Update server** to retry and inspect progress.
A default OS-user client profile permits one local server across data folders.
If pending skill reviews block an update, use **Open running server · defer
update** to resolve them on the compatible current server, then retry. Failed
replacement startup can be retried from the same popup while the server is down.
See [server backup and updates](server.md#drafts-backup-and-updates) for complete
backup/restore and validation limits.
