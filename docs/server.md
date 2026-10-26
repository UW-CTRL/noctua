# Server and connections

[Documentation](README.md) · [Settings and data](settings-and-data.md)

Noctua has one data server and any number of interfaces for one user. The server
owns the library, PDFs, annotations, notes, projects, chats, search, AI processes,
MCP and running jobs. Desktop windows and browsers connect to it. Closing the
desktop app leaves the server running. There is no mode that couples its lifetime
to the app. Changing to a remote server preserves the local data and server.
Replication, merging, multiple-user collaboration and organization accounts are
outside this release.

## First launch and recovery

The desktop opens a bundled **Server & connection** popup that needs no server.
Setup shows one step at a time: **Choose → Connect → Save**. **Next** moves forward;
**Back** returns without losing the selected mode, address or tested credential.
Changing the mode, address or token requires another connection test. Only
**Save & connect** commits a new connection; a failed test or save keeps the popup
available. **Close** returns to the connected library, or leaves an **Open
connection settings** button on the local launcher when no library is open.
Server controls and desktop options are separate popup tabs.

Choose **Use this computer** to validate and reuse an existing server, or
start a detached background process when none owns the data. Validation checks
product, persistent server identity, instance identity, API version, data folder
and readiness; a listening port or PID is insufficient. Parallel clients share
an ensure lock and the server holds an exclusive lifetime ownership lock.

Choose **Connect to another computer** and enter its HTTPS origin and token.
**Test connection** (or **Test & continue**) verifies the server through the actual
WebView. **Save & connect** rechecks its identity and
creates the WebView's HttpOnly browser session before opening the UI. Redirects
are refused and HTTPS certificate verification stays enabled. Remote use never
starts a local data server or requires local AI installation. The saved mode is
retried next launch without repeating setup. Success opens the library and hides
the local launcher. A failure leaves the connection popup available and never
falls back to local data.

The selection is in the operating system's config directory under `NoctuaClient`,
independent of server storage. Tokens use macOS Keychain, Windows Credential
Manager, or Linux Secret Service (`secret-tool` must be installed and a keyring
unlocked). Storage errors leave the connection manager available. Resetting the
connection selection does not delete research data or remove credentials from
the OS keyring. Credentials never belong in URLs.

Use the native **Settings** menu to reopen the manager at any time, including
while disconnected. Settings → **Server & connection** in the web UI shows the
server origin, identifier and version, and offers a connection test. In a browser,
connect to another server by opening that server's HTTPS address and signing in;
OS service and process controls are restricted to the local desktop screen/CLI.

Before a desktop connection switch, input is frozen in every existing content
window, including the end of any in-progress drawing stroke. Every window must then flush its notes,
project text, PDF comments and chat draft. Failed saves or unresolved conflicts
block the switch. The old windows stay open and resume editing on failure.
Status polling does not replace connection settings you are still typing. A successful switch opens
fresh server content and closes the old windows, so old responses cannot update
the new interface. Server-owned tab state, chat drafts and note drafts are
namespaced by server identity. Browser requests also carry that identity; the
server rejects an old window’s requests if the same address now serves different
data, before any stale content can be written. Tasks stay on their original server; reconnect to
that server to view them. Closing a chat subscriber does not cancel its reply;
request Stop explicitly to cancel and preserve the partial result. Admitted HTTP
AI/write jobs also retain their server lifetime when a response subscriber leaves. No server is stopped by a connection switch.

## Local commands

Build with `cargo build --locked -p noctua`, then use `target/debug/noctua`
(`target/debug/noctua.exe` on Windows). Packaged desktop apps include a headless
server binary and stage a durable copy outside the app bundle before launch.

| Command | Behavior |
| --- | --- |
| `noctua serve` | Run the authenticated loopback server in the foreground, without opening a browser. |
| `noctua ensure` | Validate/reuse the owner, otherwise start the registered enabled user service for this data folder, or detach a background process. Never install a service. This is also the default command. |
| `noctua status` | Authenticate the recorded owner and print identity/readiness. Offline, stale and incompatible owners fail with a nonzero exit. |
| `noctua stop` | Authenticate with a separate private local control credential. Refuse while requests, AI chats, sign-in, skill executions or unresolved skill reviews remain; gracefully drain accepted connections. Never kill a PID. |
| `noctua restart` | Safely stop, refresh an enabled service's executable definition, and ensure again. It explicitly disconnects clients. |
| `noctua update --server /absolute/path/to/new/noctua` | Announce maintenance, require connected editors to save, drain active tasks, snapshot stopped data, replace/verify the server and clean retired staged executables. Defaults: 30-second notice and 30-minute task wait; a timeout cancels instead of killing work. |
| `noctua update-status` | Read local update progress/recovery information even while the data server is stopped. |
| `noctua token` | Explicitly display the server authentication token in the terminal. Treat it as a password. Normal status and logs omit it. |
| `noctua service enable` | Explicitly register automatic start at this user's login. |
| `noctua service disable` | Remove/disable login registration without stopping the current server. |
| `noctua service start` | Ask the registered user service manager to start the server. Use `status` to confirm readiness. |
| `noctua service status` | Show definition and actual enabled state, or a service-manager error. |

`NOCTUA_HOME` selects an isolated server data folder. `NOCTUA_PORT` defaults to
47878; an occupied port falls back to a free loopback port recorded in
`server.json`. With the default port, subsequent starts prefer that recorded port
to keep browser storage at the same origin; a nondefault explicit port takes precedence. Read the returned URL instead of assuming a port. `serve
--data-dir /absolute/folder` is also accepted for login-task execution. A shell
launch can use the inherited environment. Detached starts explicitly set the
working directory to the data folder, disconnect stdin, append stdout/stderr to
`server.log` and detach the process/session from its parent. Login launches adopt
the user's shell PATH for AI CLI discovery. Absolute CLI paths in server Settings
are more predictable than shell startup files.

The server maintains `server-owner.lock` for its entire lifetime. Do not delete
it to break ownership: OS locks release when a process dies. `server-start.lock`
serializes complete ensure, stop and restart transactions, including service refresh. `storage-location.lock` separately protects
storage migration and detects a running older app during initial conversion.
The server retains that lease exclusively so an older app cannot join its data;
clients probe/reuse the server before taking the migration lease.
Quit older apps/servers before conversion; older binaries do not know the new
ownership protocol and must not be launched against this data afterward. Existing
data stays in its configured folder. Stale records are replaced only after the
ownership lock proves no server is using the data. A live unavailable or
incompatible owner is never replaced automatically.

## Login auto-start

macOS uses a per-user LaunchAgent, Linux uses a `systemd --user` unit, and Windows
uses a Task Scheduler user-logon task with `InteractiveToken` and least privilege.
These are user-login registrations; pre-login machine services are not provided.
Service paths may contain spaces, but control characters are rejected before any
registration changes.
The desktop checkbox changes registration explicitly. Normal launch and `ensure`
do not register anything. Registering login auto-start does not start a server on
any platform; use Start/ensure explicitly or wait for the next user login. A running
detached server continues to own the data, so a service cannot create a duplicate.

Failures from installation, enable/disable and start are surfaced. Definition
presence, enabled state and server readiness are separate facts. Registration
metadata ties a service to its data folder; ensure refuses to start a service for
another folder. To repoint a service after moving data, stop its previous server
and explicitly enable login auto-start again for the new folder. Repointing is
refused while the previous folder still has an owner. Disabling startup preserves current tasks. Safe Stop is separate.
An explicit Restart refreshes an enabled service definition only after safe stop.
A pending data move is completed first, so the new definition points at the new
folder instead of restarting the preserved source. Normal profile services retain
the profile migration lease; explicit data-folder services retain data ownership.

## Private HTTPS and authentication

The listener always binds to `127.0.0.1`. Install/configure Tailscale yourself; this
app and its tests never install it, run Serve, or publish a network endpoint.
Use Tailscale Serve to proxy your chosen stable loopback port over private HTTPS.
Configure the precise externally visible origin before connecting, for example
in the server data folder's `server-config.json`:

```json
{"origins":["https://research-machine.example-tailnet.ts.net"]}
```

Alternatively set `NOCTUA_ORIGINS` to a comma-separated list for a shell launch;
this overrides that file for that process. Persisting `server-config.json` works
for login services too. Restart explicitly after changes, when tasks are finished.
Confirm the actual bound port from status before configuring your proxy; if it
changed because of a collision, adjust the proxy yourself.

Only exact loopback Hosts and configured HTTPS Hosts/Origins are allowed. No
forwarded header implicitly grants trust. Use a proxy that preserves the configured
Host; additional origins must be HTTPS origins with no user info, path, query or
fragment. Authentication applies locally as well as remotely.

Browser login exchanges a bearer token for a 12-hour, in-memory, HttpOnly,
SameSite=Strict session (Secure for HTTPS). Session cookie names are isolated by
server identity, so different loopback ports do not overwrite each other’s login. A server restart requires a new login.
Cookie-authenticated writes require an allowed exact Origin and the non-simple
`X-Noctua-Client: 1` and matching `X-Noctua-Server` headers; cross-origin CORS access is not enabled. Nonbrowser MCP
clients send `Authorization: Bearer <token>` to `/mcp`; internally launched Claude
and Codex receive this authentication without putting it in the URL. The API token
does not grant the server stop operation: that needs `server-control`, kept private
on the server computer and never returned by the identity API.

Server content has no Tauri native management privilege. Its old desktop HTTP
endpoints report unavailable. Same-server app links open native windows and preserve the requested app path;
external links open the system browser. **Open in new window** saves first and
keeps the source tab open. Windows/tabs, client file
uploads, app icons and signed desktop updates remain client responsibilities.
AI CLI configuration, API credentials, Zotero imports and typed data paths in the
server Settings refer to the **server computer**. Client uploads use browser file
inputs; they do not choose a server data path.

## Drafts, backup and updates

Open notes snapshot into this device's localStorage on each edit, keyed by server
identity, collection, note ID and editor tab. Different editor drafts never
overwrite each other. A recovery chooser presents multiple retained versions,
including legacy single-slot drafts. This is the first offline scope: it does not
make the entire library available offline or queue image/media uploads. Browser storage belongs to its web origin, so use a stable server address.
Browser storage may have a quota or be cleared; the editor reports storage failures and
must be kept open until a server save succeeds. Do not use private browsing if
you need drafts to survive application exit.

Reload/relaunch recovers a saved draft when the note is opened. It retains the
base server version; if another device changed that version, use the existing
conflict choice. There is no automatic overwrite. A successful server save only
clears the exact snapshot acknowledged, preserving edits made while saving.
Explicitly reloading the server copy discards the current draft only after the
server copy was fetched successfully. See [Notes](notes.md).

After opening a new desktop release, an existing local server is upgraded by an
independent worker. This also applies to a local server left running while the
client uses a remote connection; remote servers are updated on their own computer.
A remote-only client never starts a local data server. **This computer → Update
server** retries an update or deferred cleanup. Update progress/errors appear in
the local connection popup, including while the data server is stopped.

The worker stages the bundled executable outside the app bundle, checks its API,
data format and content hash, and announces maintenance for 30 seconds. Connected
editor shells finish current input, save drafts/files/annotations, and acknowledge
the pause. Failed saves, conflicts, open editor dialogs or missing acknowledgments
cancel replacement and leave the server running. Wait for a recently closed
client's presence lease to expire before retrying. Existing AI, MCP and file work
continues; new work is refused during draining. The worker waits up to 30 minutes
and cancels if work is still active. It never kills a job or guesses ownership
from a port/PID. Normal app exit cannot cancel this independent worker.
Skill requests awaiting approval or generated output review block replacement;
apply or reject them first. If a running skill finishes into a review state while
draining, the update cancels and preserves that server session and its results.
Use **Open running server · defer update** in the local popup to reopen a healthy,
API-compatible owner and resolve its pending reviews before retrying. This is an
explicit choice; update failure never silently changes connection mode or data.

Once idle, the old owner exits and the worker copies the stopped data folder to
`backups/update-<id>/`, excluding older backups, runtime locks and logs. A
`snapshot-complete.json` marker confirms a finished snapshot. Enabled login
registration is repointed and starts the replacement through its OS service
manager, without installing a new service or enabling disabled auto-start.
Without an enabled service, the worker starts a detached process.
The replacement must retain the same server identity and match the
verified executable hash/version before the previous staged binary is retired.
The browser origin stays pinned to the previous server address during replacement.
Referenced or still-open binaries remain queued for later cleanup; arbitrary
user-installed/bundle executables are never deleted. Login definitions retain the
same client profile so they share its ownership lock.

Updates preserve the running server's allowed HTTPS origins, notes location,
AI CLI paths and launch environment. Non-secret launch settings remain with the
data folder. Environment-provided API credentials travel through a private,
owner-only temporary file in the local client profile, outside the data snapshot;
it is removed after the replacement is verified. Failed starts retain this
protected handoff for retry. This handoff is never copied into update progress,
logs or the snapshot. Explicit launch environment values take precedence.

One local server may own the default OS-user client profile, even if another
process requests a different data folder/port. Every data folder also keeps its
own exclusive lock. Explicitly isolated development profiles use separate
`NOCTUA_CLIENT_HOME` folders; two profiles still cannot write the same data folder.

If failure occurs before the replacement starts, the old server is kept or
restarted. Once a replacement may have opened the databases, Noctua retains the
snapshot and old executable and refuses an automatic downgrade. Retry the new
release, or stop all servers, copy a **complete** snapshot into a separate empty
data folder, select that folder explicitly, and start its matching release. The
completion manifest records the prior origin/version; preserve that port and proxy
address to recover origin-bound drafts. Never mix files from different generations.
A worker crash leaves recoverable status;
its maintenance lease expires so a still-running old owner can accept work again.
Retrying **Update server** or `noctua update --server …` also handles a stopped
failed replacement: ownership locks prove no server is alive, then the worker
backs up the stopped data before starting the candidate again. Completed prior
snapshots remain available; a partial new database is never opened by an old binary.
Incomplete snapshots have no completion marker and must not be used for recovery.

`server-format.json` rejects unknown formats and older release versions before
DB open. First conversion and version changes also keep database-only SQLite
`VACUUM INTO` snapshots (including nested databases and committed WAL data).
These older database-only snapshots do not replace the complete update snapshot.
Automatic update refuses external `NOCTUA_NOTES` folders and data symlinks because
a complete in-folder snapshot cannot protect their targets. Use a separately
verified full backup and a coordinated manual upgrade for those configurations.
Servers predating the maintenance protocol require a notified, explicit safe stop
with their matching CLI; the new desktop never force-terminates them.

## Validation limits

The automated lifecycle test uses temporary data and fake OS service managers;
it does not register a real resident service. macOS code checks, linked desktop
build, backend tests and WebKit regression cover the implementation. An isolated
native macOS smoke also verifies WebView cookie authentication/readiness, saved
connection selection and the same server surviving desktop process exit. Run it
with `python3 tests/desktop-smoke.py` after building both binaries. Actual login,
logout, signed installer/update replacement and a live Tailscale/multiple-computer
network still require a release-environment smoke test. Windows and Linux service,
credential-store and installer behavior is implemented but has not been exercised
on those OSes in this development environment. Do not interpret a generated
service file or successful compile as a verified login service installation.
