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

The desktop starts with a bundled **Server & connection** screen that needs no
server. Choose **Use this computer** to validate and reuse an existing server, or
start a detached background process when none owns the data. Validation checks
product, persistent server identity, instance identity, API version, data folder
and readiness; a listening port or PID is insufficient. Parallel clients share
an ensure lock and the server holds an exclusive lifetime ownership lock.

Choose **Connect to another computer** and enter its HTTPS origin and token.
**Test connection** authenticates the identity endpoint; **Connect / retry** also
creates the WebView's HttpOnly browser session before opening the UI. Redirects
are refused and HTTPS certificate verification stays enabled. Remote use never
starts a local data server or requires local AI installation. The saved mode is
retried next launch. A failure leaves the connection manager available and never
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
| `noctua stop` | Authenticate with a separate private local control credential. Refuse while requests, AI chats, sign-in or skill executions are active; gracefully drain accepted connections. Never kill a PID. |
| `noctua restart` | Safely stop, refresh an enabled service's executable definition, and ensure again. It explicitly disconnects clients. |
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

Desktop updates leave a running server alone. Server executables are staged by
version and content hash in the client config folder, so replacing the app bundle
does not remove their path. An explicit safe Restart uses the newly bundled server;
it refuses when work is active and refreshes an enabled login registration. Other
clients disconnect and must reconnect; coordinate this action before updating.
There is no automatic server update or forced task cancellation.

`server-format.json` fences the data format before databases open. A binary that
implements this protocol rejects an unknown data version. Before first conversion
and a server version change, the ownership holder creates consistent SQLite
`VACUUM INTO` snapshots, including nested library databases and committed WAL data,
under `backups/<snapshot-id>/`. These are database snapshots, not complete copies
of PDFs, notes and project assets. For a complete backup, safely stop the server,
copy the entire data folder and retain the server version. Restore by stopping
all servers, restoring the entire folder to a separate location, selecting it
explicitly and starting its matching binary. Never mix database snapshots from
different generations or open newer data with an old pre-protocol app.

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
