# Settings and data

[Documentation](README.md) · [Project README](../README.md)

## Personalize the workspace

In **Settings → Appearance**, choose App, Notes, and Reader themes independently.
All default to System. Choose Light or Dark app artwork separately; Light is the
default and the choice is applied on the next desktop launch.

You can also adjust interface, note, and chat fonts and highlight colors.
Changing AI category colors recolors matching assistant highlights; existing
user highlights keep their colors.

**Connections** holds the Semantic Scholar key and optional Zotero source;
**Research assistant** holds provider and model settings.

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
then quit all Noctua apps and servers and restart. Noctua copies the data and
keeps the original. Unset `NOCTUA_HOME` and `NOCTUA_NOTES` if they override the
location you want to select.

## Updates

Official desktop builds check for updates at startup. You can also use
**Settings → About & shortcuts → Check for updates**. Save work before installing.
Linux in-app updates require AppImage; use your package manager for other builds.
Browser mode is updated by rebuilding or replacing the server binary.

See [Development](development.md#environment-overrides) for environment overrides.
