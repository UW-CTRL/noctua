# Linked project directories

A collection can link to directories outside Noctua storage. Your files stay at
their original paths, so Git, external editors, Noctua, and its assistant work
on the same sources. Existing Noctua notes and imported files remain available.
This workflow currently requires a **macOS server**; desktop and browser clients
can connect to that server.

## Link and browse

Select a collection, then **Link directory** beneath its project tree. Enter an
absolute path on the server, such as `/Users/you/ctrl/papers/2027/L4DC.27`.
**Browse on this computer** requires a local desktop connection. A browser file
upload does not link a directory on the browser computer to a remote server.

The left tree contains a permanent **Papers** entry, notes and files, and linked
directories. Papers opens the central paper list. Expanding or collapsing a collection leaves the current document open. **Library | Graph | Lineage** is the single navigation group;
Option+1/2/3 on macOS, or Alt+1/2/3, selects those views. Open notes, source files,
and PDFs from their entries rather than separate Notes and Reader tabs.

Linked roots, Papers, and internal notes and files share one nested tree. Click a
folder to expand or collapse it; subfolders stay inside their parent, and their
expansion is remembered when you return to the root. Multiple linked directories
can remain expanded while you switch between files.

Select a linked root to browse its files. Noctua detects its Git repository,
including an enclosing repository or a worktree. Use the terminal for Git branch
and change status. Linking does not initialize a repository. Ignored files are hidden unless
**Show ignored files** is enabled in the settings button beside that root. Git administrative files and symbolic links
are not exposed as editable project files. The current directory listing supports
20,000 visible entries and 512 MB of visible file contents; ignore generated
outputs or link a smaller directory for larger repositories.

## Editing and external changes

Text edits save to the original file. Noctua uses filesystem notifications on the
server to detect changes, and checks a small change token once a second for the
active project and expanded directories. Full listings are fetched after changes,
on expansion/focus, and as a safety check every 30 seconds. If notifications are
unavailable, the safety check still discovers external changes. Large directories
can take longer to scan. Refreshes pause during typing and pane dragging.
Ignored files still require **Show ignored files**.
Clean editors reload changed files; unsaved drafts offer a comparison with the
disk version. Choose to keep the draft, reload disk, or explicitly save the draft
over the displayed version. A newer intervening change rejects that save again.

Use the file tree to create, rename, move, or trash files. Linked-file Trash is
stored in Noctua, and restoration refuses to overwrite an existing path. An
external rename is shown as a removed path and a new entry; reopen the new path.
The internal workspace's version-history buttons do not represent Git history.

Directory settings offer **Relink** for a moved or disconnected directory and
**Unlink** to remove its association. Unlinking never deletes the external files. Unlinking or relinking closes that
root’s terminal sessions and stops its agent commands.
Relinking clears remembered agent permissions and paper configuration.

## LaTeX papers

A linked directory may contain multiple `.tex` and `.bib` files, included
chapters, figures, and other dependencies. Select **Project LaTeX settings** and
explicitly choose the main document before compiling. Each linked root remembers
its own main document and compiler. The selected main file’s immediate directory
is the build root: selecting `ctrl/papers/L4DC.27/main.tex` uses the files in
`ctrl/papers/L4DC.27/` and its subfolders. Sibling papers and bibliographies are
excluded. Relative class, bibliography, image, and input paths resolve from that
directory. **Set as main document** switches the entry
point to another open TeX file.

Compilation uses a verified source snapshot and writes temporary files and PDFs
to Noctua's cache. It does not create compiler outputs in the linked directory.
External edits invalidate the preview and bibliography index. The collection's
internally stored paper retains its separate settings.

## Terminal and Git

Click **Terminal** beside a linked directory’s name in the left tree to open a
shell on the server in that directory. The button is available even while the
directory is collapsed. Use your normal Git commands to initialize, pull, stage, commit,
resolve conflicts, and push. Use Git in the terminal to inspect status and perform repository actions. Credentials and Git configuration are those of the server
account.

The terminal identifies the server and directory. **Hide** preserves the shell;
**Close session** terminates it. Refreshing can reconnect to the same session
while the server remains running; older output has a bounded retention buffer.
Open terminals count as active work for safe server restart. The user terminal
has the account's normal filesystem permissions.

## Assistant access

The assistant's linked-file scope is the selected collection. In Suggest mode,
linked-file changes remain proposals for review. In Direct edit mode, first
access asks for permission to edit a file; **Remember access** preserves that
grant across prompts, chats, and server restarts. Use **Agent access** in the linked
root’s settings to inspect or revoke grants. Additional files require their own grants.

Project commands have a separate approval card showing arguments, working
directory, write scope, and requested network access. They run under macOS
filesystem restrictions, even when the user terminal is unrestricted. A command
cannot gain repository-wide writes simply because the linked folder belongs to
a larger repository: expanded access must be approved explicitly.

Supported exact Git commands may offer a reusable grant. Shell scripts,
interpreters, pushes, destructive actions, and repository-scope expansion always
require a fresh approval. Commands have a two-minute timeout and bounded output;
use the user terminal for longer or interactive work. Revoking access stops
running agent commands for that linked root. Stopping a chat also cancels its
pending and running project commands. Noctua never falls back to an
unrestricted agent command if confinement fails.

## Backups

Noctua stores directory associations, paper settings, access grants, build caches,
and recoverable trash in its own data directory. Its backups do **not** include
the current contents of external directories. Back those directories up separately
and use Git to version the files you intend to track.

Terminal and settings stay on each linked directory’s row. There is no separate
Git/status footer below its files. Switching files preserves the directory pane’s
scroll position. Tabs show the collection and active file, note, or linked root.

Multiple collections and linked roots can remain expanded at once. File rows use
the same borderless styling in active and inactive collections. Opening a file
adds it to the center document tabs, separate from the outer application tabs.
Use these tabs to switch between notes, source files, and PDFs; close a tab with
its × button. Edits save before switching, and a save conflict blocks navigation
until resolved. The open tab list lasts for the current window session.

Project PDFs use the same Reader as Library papers, with exclusive **Outline**,
**Annotations**, and **Files** sidebar views. Highlights, comments, and drawings
are stored in Noctua metadata, leaving the original PDF unchanged. Annotations
belong to a file and its PDF contents; replacing the PDF starts a separate set.
AI outlines, auto-highlighting, and annotation undo are currently Library-paper
features. Back up Noctua metadata as well as the external project directory.
