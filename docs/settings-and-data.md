# Settings and data

[Documentation](README.md) · [Project README](../README.md)

## Personalize the workspace

In **Settings → Appearance**, choose App, Notes, and Reader themes independently.
The three theme selectors have the same width. All default to System. Choose Light or Dark app artwork separately; Light is the
default and the choice is applied on the next desktop launch.

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

## Skills

Open **Settings → Skills**. **Global Agent Skills** reads installed packages in
place. **Location** defaults to `~/.agents/skills`, the
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

Under **Chat project defaults**, choose a Noctua project, select skills to make
available on every chat message there, and choose **Save project defaults**.
This is separate from the source-project import groups. An empty selection clears
its defaults. Use `/` in chat to search all available skills and invoke additional
skills for one message without changing these defaults. Both providers share the
available skills. Discovery and import never enable skills or run scripts.
Scripts require approval and separate output review; see
[Research assistant](assistant.md#project-files-and-imported-skills).

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
last only for the backend session. Globally installed skills stay in
the configured global location and are not included in Noctua backups or storage relocation.
App updates do not replace it. Quit Noctua apps and servers before backing up
the entire folder; copying PDFs alone does not preserve annotations or notes.

To move storage, choose an empty folder in **Settings → Data & storage**, save,
then quit all Noctua apps and servers and restart. Noctua copies the data and
keeps the original. Unset `NOCTUA_HOME` and `NOCTUA_NOTES` if they override the
location you want to select.

## Updates

Official desktop builds check for updates at startup. You can also use
**Settings → About & shortcuts → Check for updates**. Save work before installing.
Linux in-app updates require AppImage; use your package manager for other builds.
Browser mode is updated by rebuilding or replacing the server binary.

See [Development](development.md#environment-overrides) for environment overrides.
