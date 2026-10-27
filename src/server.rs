//! Data ownership and the detached server control plane. Never infer identity from a PID.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

pub const API_VERSION: u32 = 1;
pub const DATA_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 47878;

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub product: String,
    pub server_id: String,
    pub instance_id: String,
    pub api_version: u32,
    pub version: String,
    pub data_dir: PathBuf,
    pub url: String,
    pub pid: u32,
    #[serde(default)]
    pub executable: PathBuf,
    #[serde(default)]
    pub executable_hash: String,
}

pub struct Owner {
    _lock: File,
    _machine: Option<File>,
    pub record: Record,
    pub token: String,
    pub control: String,
}
pub(crate) fn exclusive(path: &Path) -> Result<File> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    crate::paths::restrict(path);
    f.try_lock().context("This data folder is owned by another Noctua server. Quit the older app/server before migrating; do not remove the lock file")?;
    Ok(f)
}

impl Owner {
    pub fn acquire(data: &Path, url: &str) -> Result<Self> {
        #[cfg(not(test))]
        let machine = {
            crate::server_update::check_reservation()?;
            Some(machine_lease()?)
        };
        #[cfg(test)]
        let machine = None;
        Self::acquire_with_machine(data, url, machine)
    }
    pub(crate) fn acquire_with_machine(
        data: &Path,
        url: &str,
        machine: Option<File>,
    ) -> Result<Self> {
        fs::create_dir_all(data)?;
        let lock = exclusive(&data.join("server-owner.lock"))?;
        // This marker is deliberately separate from SQLite's schema and migration lease.
        let marker = data.join("server-format.json");
        let server_id = if marker.exists() {
            let value: Value = serde_json::from_slice(&fs::read(&marker)?)?;
            if let Some(previous) = value["server_version"].as_str() {
                anyhow::ensure!(semver::Version::parse(previous)? <= semver::Version::parse(env!("CARGO_PKG_VERSION"))?, "A newer server has opened this data. Use that release or restore a complete pre-update backup; automatic downgrade is unsafe");
            }
            anyhow::ensure!(
                value["data_version"] == DATA_VERSION,
                "Incompatible data format. Use the matching server or restore a complete backup"
            );
            let id = value["server_id"]
                .as_str()
                .context("Invalid server identity")?
                .to_owned();
            if value["server_version"] != env!("CARGO_PKG_VERSION") {
                backup(data)?;
                crate::paths::write_private(&marker,&json!({"server_id":id,"data_version":DATA_VERSION,"server_version":env!("CARGO_PKG_VERSION")}).to_string())?;
            }
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            // Snapshot existing databases before this server generation opens them.
            backup(data)?;
            crate::paths::write_private(&marker, &json!({"server_id":id,"data_version":DATA_VERSION,"server_version":env!("CARGO_PKG_VERSION")}).to_string())?;
            id
        };
        let token_path = data.join("server-token");
        let mut token = if token_path.exists() {
            fs::read_to_string(&token_path)?
        } else {
            let token = new_connection_token();
            crate::paths::write_private(&token_path, &token)?;
            token
        };
        anyhow::ensure!(
            (valid_connection_token(&token) || token.len() >= 32) && !token.contains(char::is_whitespace),
            "Invalid server-token file"
        );
        // Replace older credentials once; the short token stays stable on subsequent restarts.
        if !valid_connection_token(&token){token=new_connection_token();crate::paths::write_private(&token_path,&token)?;}
        let record = Record {
            product: "noctua".into(),
            server_id,
            instance_id: uuid::Uuid::new_v4().to_string(),
            api_version: API_VERSION,
            version: env!("CARGO_PKG_VERSION").into(),
            data_dir: fs::canonicalize(data)?,
            url: url.into(),
            pid: std::process::id(),
            executable: fs::canonicalize(std::env::current_exe()?)?,
            executable_hash: executable_hash(&std::env::current_exe()?)?,
        };
        let control = uuid::Uuid::new_v4().simple().to_string();
        crate::paths::write_private(&data.join("server-control"), &control)?;
        Ok(Self {
            _lock: lock,
            _machine: machine,
            record,
            token,
            control,
        })
    }
    pub fn publish(&self) -> Result<()> {
        #[cfg(not(test))]
        crate::paths::write_private(
            &crate::client::config_dir()?.join("active-server.json"),
            &serde_json::to_string(&self.record)?,
        )?;
        crate::paths::write_private(
            &self.record.data_dir.join("server.json"),
            &serde_json::to_string_pretty(&self.record)?,
        )
    }
}
pub(crate) fn machine_lease() -> Result<File> {
    exclusive(&crate::client::config_dir()?.join("server-machine.lock")).context("Another Noctua server is already running for this OS user. Reuse it or stop it safely before selecting another data folder")
}
pub fn executable_hash(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!("{:x}", Sha256::digest(fs::read(path)?)))
}
pub fn describe() -> Result<Value> {
    Ok(
        json!({"product":"noctua","version":env!("CARGO_PKG_VERSION"),"api_version":API_VERSION,"data_version":DATA_VERSION,"executable_hash":executable_hash(&std::env::current_exe()?)?}),
    )
}

pub fn backup(data: &Path) -> Result<()> {
    fn collect(root: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_symlink() {
                continue;
            }
            if entry.file_type()?.is_dir() && entry.file_name() != "backups" {
                collect(&path, paths)?;
            } else if path.extension().is_some_and(|e| e == "sqlite") {
                paths.push(path);
            }
        }
        Ok(())
    }
    let mut names = Vec::new();
    collect(data, &mut names)?;
    if names.is_empty() {
        return Ok(());
    }
    let destination = data.join("backups").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&destination)?;
    for source in names {
        let target = destination.join(source.strip_prefix(data)?);
        fs::create_dir_all(target.parent().unwrap())?;
        let db = rusqlite::Connection::open_with_flags(
            &source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    }
    Ok(())
}

pub fn record(data: &Path) -> Result<Record> {
    Ok(serde_json::from_slice(&fs::read(
        data.join("server.json"),
    )?)?)
}
const CONNECTION_ALPHABET:&[u8]=b"23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
fn valid_connection_token(value:&str)->bool{value.len()==15&&value.bytes().all(|byte|CONNECTION_ALPHABET.contains(&byte))}
fn new_connection_token()->String{
    let mut out=String::with_capacity(15);let limit=256/CONNECTION_ALPHABET.len()*CONNECTION_ALPHABET.len();
    while out.len()<15{let random=uuid::Uuid::new_v4();for(index,byte)in random.as_bytes().iter().enumerate(){
        // UUID version/variant bytes contain fixed bits; use only wholly random bytes.
        if index==6||index==8||usize::from(*byte)>=limit{continue;}
        out.push(CONNECTION_ALPHABET[usize::from(*byte)%CONNECTION_ALPHABET.len()]as char);if out.len()==15{break;}
    }}out
}
pub fn token(data: &Path) -> Result<String> {
    Ok(fs::read_to_string(data.join("server-token"))?)
}

pub fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?)
}

pub fn validate_url(address: &str) -> Result<reqwest::Url> {
    let u = reqwest::Url::parse(address).context("Enter an HTTPS server address")?;
    anyhow::ensure!(
        u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
            && u.path() == "/",
        "Use only the server origin; credentials belong in the authentication field"
    );
    anyhow::ensure!(
        u.scheme() == "https"
            || (u.scheme() == "http"
                && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))),
        "Remote servers require HTTPS"
    );
    Ok(u)
}
/// Keep the web origin stable after an initial default-port collision.
pub(crate) fn preferred_port(data: &Path, requested: u16) -> u16 {
    if requested != DEFAULT_PORT {
        return requested;
    }
    record(data)
        .ok()
        .filter(|record| {
            record.product == "noctua"
                && record.api_version == API_VERSION
                && validate_local_record(record).is_ok()
                && fs::canonicalize(data).ok().as_ref() == Some(&record.data_dir)
        })
        .and_then(|record| reqwest::Url::parse(&record.url).ok()?.port())
        .filter(|port| *port != 0)
        .unwrap_or(requested)
}

pub async fn probe(address: &str, secret: &str) -> Result<Value> {
    let value = probe_any(address, secret).await?;
    validate_identity(&value)?;
    Ok(value)
}
pub(crate) async fn probe_any(address: &str, secret: &str) -> Result<Value> {
    let u = validate_url(address)?;
    let response = http()?
        .get(u.join("api/server")?)
        .bearer_auth(secret)
        .send()
        .await
        .context("Server connection failed")?;
    anyhow::ensure!(
        response.status().is_success(),
        "Server authentication or connection failed (HTTP {})",
        response.status()
    );
    let value: Value = response
        .json()
        .await
        .context("Server returned an invalid identity")?;
    anyhow::ensure!(
        value["product"] == "noctua"
            && value["api_version"] == API_VERSION
            && value["server_id"].as_str().is_some_and(|s| !s.is_empty()),
        "Incompatible server identity"
    );
    Ok(value)
}
fn validate_identity(value: &Value) -> Result<()> {
    anyhow::ensure!(value["product"] == "noctua" && value["api_version"] == API_VERSION && value["ready"] == true && value["capabilities"]["note_versions"] == true, "This server is incompatible or not ready. Update the client/server or choose another server");
    anyhow::ensure!(
        value["server_id"].as_str().is_some_and(|s| !s.is_empty()),
        "Server identity missing"
    );
    Ok(())
}
pub(crate) fn validate_local_record(record: &Record) -> Result<()> {
    let url = validate_url(&record.url)?;
    anyhow::ensure!(
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        "Local server record must point to a loopback HTTP address; refusing to send credentials"
    );
    Ok(())
}

pub async fn status(data: &Path) -> Result<Value> {
    let value = status_any(data).await?;
    validate_identity(&value)?;
    Ok(value)
}
pub(crate) async fn status_any(data: &Path) -> Result<Value> {
    let r = record(data)?;
    anyhow::ensure!(
        r.product == "noctua" && r.api_version == API_VERSION,
        "Incompatible server record; update the client/server before reconnecting"
    );
    validate_local_record(&r)?;
    let v = probe_any(&r.url, &token(data)?).await?;
    anyhow::ensure!(
        v["server_id"] == r.server_id
            && v["instance_id"] == r.instance_id
            && v["data_dir"] == json!(fs::canonicalize(data)?),
        "Stale or foreign server record; refusing control"
    );
    Ok(v)
}
/// Read authenticated update progress even while the owner is draining.
pub async fn status_any_for_update(data: &Path) -> Result<Value> {
    status_any(data).await
}

/// The control lock covers an entire ensure, stop, or restart transaction.
/// `serve` owns the data lock instead, so a detached child can become ready
/// while its launcher keeps concurrent client control operations serialized.
pub(crate) async fn control_lock(data: &Path) -> Result<(File, File)> {
    let machine = crate::client::config_dir()?.join("server-manager.lock");
    let manager = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(machine)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while manager.try_lock().is_err() {
        anyhow::ensure!(tokio::time::Instant::now()<deadline,"Another server operation or update is in progress. Check Server & connection for progress");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    fs::create_dir_all(data)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("server-start.lock"))?;
    for _ in 0..300 {
        if file.try_lock().is_ok() {
            return Ok((manager, file));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("Another client is managing the server. Retry shortly")
}
pub async fn control_lock_for_cli(data: &Path) -> Result<(File, File)> {
    control_lock(data).await
}

pub async fn ensure(executable: &Path, port: u16) -> Result<Value> {
    let coordination = crate::paths::existing_data_dir()?;
    let _control = control_lock(&coordination).await?;
    ensure_locked(executable, port, &coordination).await
}

pub(crate) async fn ensure_locked(
    executable: &Path,
    port: u16,
    coordination: &Path,
) -> Result<Value> {
    if let Ok(v) = status(coordination).await {
        return Ok(v);
    }
    if let Some(help)=crate::server_recovery::inspect(coordination).await {
        bail!("{}",crate::server_recovery::error(&help));
    }
    drop(machine_lease()?);
    let lease = crate::storage::lease()?;
    crate::storage::exclusive_lease(&lease)?;
    let data = crate::paths::data_dir()?;
    fs::create_dir_all(&data)?;
    // Never replace a live but unavailable/incompatible owner.
    drop(exclusive(&data.join("server-owner.lock"))?);
    drop(lease);
    let service = crate::service::status();
    if service["supported"] == true && service["error"].is_string() {
        bail!("Cannot verify registered login service state; repair its reported error before starting another server")
    }
    if service["installed"] == true && service["enabled"].is_null() {
        bail!("Cannot verify registered service state; repair login auto-start before starting another server")
    }
    if service["enabled"] == true {
        anyhow::ensure!(crate::service::matches_data(&data)?,"The registered login service uses a different data folder. Change or disable that service explicitly; no other server was started");
        crate::service::start()?;
    } else {
        let staged=crate::service::stage(executable)?;
        spawn_detached(&staged, &data, port, &[], None)?;
    }
    wait_ready(&data).await
}
// Rust's Windows Command duplicates the requested log handles, but also allows
// inheritable handles already present in this process into the child. In a CLI
// launched with captured output those include the caller's original pipe ends.
// They must not stay open for the lifetime of a detached server/update worker.
#[cfg(windows)]
fn protect_parent_stdio() -> std::io::Result<()> {
    use std::ffi::c_void;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(kind: u32) -> *mut c_void;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
    }
    for kind in [-10_i32, -11, -12] { // STD_INPUT/OUTPUT/ERROR_HANDLE
        let handle = unsafe { GetStdHandle(kind as u32) };
        if !handle.is_null() && handle as isize != -1 {
            // Keep the parent's streams usable. Command creates separate
            // inheritable duplicates for any explicitly selected child stdio.
            if unsafe { SetHandleInformation(handle, 1, 0) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
    }
    Ok(())
}

pub(crate) fn spawn_detached(
    executable: &Path,
    data: &Path,
    port: u16,
    arguments: &[&str],
    ticket: Option<&str>,
) -> Result<()> {
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .open(data.join("server.log"))?;
    crate::paths::restrict(&data.join("server.log"));
    let mut cmd = Command::new(fs::canonicalize(executable)?);
    cmd.env("NOCTUA_CLIENT_HOME", crate::client::config_dir()?);
    if std::env::var_os("NOCTUA_HOME").is_some_and(|value| !value.is_empty()) {
        cmd.env("NOCTUA_HOME", fs::canonicalize(&data)?);
    }
    if std::env::var_os("NOCTUA_PROFILE_HOME").is_some_and(|value| !value.is_empty()) {
        cmd.env("NOCTUA_PROFILE_HOME", {
            let profile = crate::paths::default_data_dir();
            if profile.exists() {
                fs::canonicalize(profile)?
            } else if profile.is_absolute() {
                profile
            } else {
                std::env::current_dir()?.join(profile)
            }
        });
    }
    for variable in ["NOCTUA_NOTES", "NOCTUA_CLAUDE", "NOCTUA_CODEX"] {
        if let Some(value) = std::env::var_os(variable) {
            let path = PathBuf::from(value);
            if path.is_relative() && (variable == "NOCTUA_NOTES" || path.components().count() > 1) {
                cmd.env(variable, std::env::current_dir()?.join(path));
            }
        }
    }
    if let Some(ticket) = ticket {
        cmd.env("NOCTUA_START_TICKET", ticket);
    }
    cmd.args(if arguments.is_empty() {
        vec!["serve"]
    } else {
        arguments.to_vec()
    })
    .env("NOCTUA_PORT", port.to_string())
    .current_dir(&data)
    .stdin(Stdio::null())
    .stdout(Stdio::from(log.try_clone()?))
    .stderr(Stdio::from(log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        protect_parent_stdio().context("Cannot isolate the background process from parent streams")?;
        cmd.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | NEW_PROCESS_GROUP
    }
    let mut child = cmd
        .spawn()
        .context("Cannot start the separate server executable")?;
    // Reap the launcher child without tying server lifetime to this process.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
pub(crate) async fn wait_ready(data: &Path) -> Result<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) {
        if let Ok(Ok(identity)) = tokio::time::timeout(remaining, status(&data)).await {
            return Ok(identity);
        }
        tokio::time::sleep(Duration::from_millis(100).min(remaining)).await;
    }
    bail!("Server did not become ready. Check server.log in the data folder; an older app or occupied port may need attention")
}

pub async fn stop(data: &Path) -> Result<()> {
    let _control = control_lock(data).await?;
    stop_locked(data).await
}

pub async fn restart(executable: &Path, port: u16) -> Result<Value> {
    let data = crate::paths::existing_data_dir()?;
    let _control = control_lock(&data).await?;
    let current = status_any(&data).await?;
    let candidate = crate::server_update::candidate(executable).await?;
    anyhow::ensure!(semver::Version::parse(current["version"].as_str().context("Server version missing")?)?<=semver::Version::parse(candidate["version"].as_str().unwrap())?,"Restart would downgrade a newer server. Update the desktop first; the running server was kept");
    if current["executable_hash"]!=candidate["executable_hash"]||current["version"]!=candidate["version"] {
        drop(_control);
        return crate::server_update::ensure_current(executable,port).await;
    }
    // Validate the service target before stopping anything.
    let service = crate::service::status();
    anyhow::ensure!(
        service["error"].is_null(),
        "Cannot verify login service state before restart"
    );
    if service["enabled"] == true {
        anyhow::ensure!(
            crate::service::matches_data(&data)?,
            "The login service uses another data folder; no server was stopped"
        );
    }
    stop_locked(&data).await?;
    // Apply a pending data move before regenerating a login definition. Otherwise
    // its pinned NOCTUA_HOME would silently reopen the preserved source at login.
    let lease = crate::storage::lease()?;
    crate::storage::exclusive_lease(&lease)?;
    let destination = crate::paths::data_dir()?;
    drop(lease);
    if service["enabled"] == true {
        crate::service::refresh(executable, &data)?;
    }
    ensure_locked(executable, port, &destination).await
}

pub(crate) async fn stop_locked(data: &Path) -> Result<()> {
    status_any(data).await?;
    let r = record(data)?;
    validate_local_record(&r)?;
    let response = http()?
        .post(format!("{}/api/server/stop", r.url))
        .bearer_auth(token(data)?)
        .header(
            "x-noctua-control",
            fs::read_to_string(data.join("server-control"))?,
        )
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Server refused shutdown (HTTP {}). Wait for running tasks and retry",
        response.status()
    );
    for _ in 0..300 {
        if exclusive(&data.join("server-owner.lock")).is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("Server is still draining requests; no process was killed")
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("noctua-owner-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn connection_tokens_are_short_stable_and_replace_legacy_credentials()->Result<()> {
        let folder=Folder::new();let old="a".repeat(64);crate::paths::write_private(&folder.0.join("server-token"),&old)?;
        let owner=Owner::acquire(&folder.0,"http://127.0.0.1:1")?;
        assert!(valid_connection_token(&owner.token));assert_ne!(owner.token,old);assert_eq!(token(&folder.0)?,owner.token);
        let short=owner.token.clone();drop(owner);let owner=Owner::acquire(&folder.0,"http://127.0.0.1:1")?;assert_eq!(owner.token,short);
        let other=Folder::new();let fresh=Owner::acquire(&other.0,"http://127.0.0.1:2")?;assert!(valid_connection_token(&fresh.token));assert_ne!(fresh.token,short);Ok(())
    }
    #[test]
    fn ownership_is_exclusive_and_identity_survives_processes() -> Result<()> {
        let f = Folder::new();
        let owner = Owner::acquire(&f.0, "http://127.0.0.1:1")?;
        assert!(Owner::acquire(&f.0, "http://127.0.0.1:2").is_err());
        let id = owner.record.server_id.clone();
        let instance = owner.record.instance_id.clone();
        let token = owner.token.clone();
        drop(owner);
        let next = Owner::acquire(&f.0, "http://127.0.0.1:2")?;
        assert_eq!(next.record.server_id, id);
        assert_ne!(next.record.instance_id, instance);
        assert_eq!(next.token, token);
        Ok(())
    }
    #[test]
    fn future_format_is_not_opened_and_nested_wal_is_snapshotted() -> Result<()> {
        let f = Folder::new();
        fs::create_dir(f.0.join("library"))?;
        let db = rusqlite::Connection::open(f.0.join("library/library.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE research (title TEXT); INSERT INTO research VALUES ('Kept');")?;
        let owner = Owner::acquire(&f.0, "http://127.0.0.1:1")?;
        drop(owner);
        let snapshot = fs::read_dir(f.0.join("backups"))?
            .next()
            .unwrap()?
            .path()
            .join("library/library.sqlite");
        let copied = rusqlite::Connection::open(snapshot)?;
        assert_eq!(
            copied.query_row("SELECT title FROM research", [], |r| r.get::<_, String>(0))?,
            "Kept"
        );
        fs::write(
            f.0.join("server-format.json"),
            json!({"server_id":"keep","data_version":999}).to_string(),
        )?;
        assert!(Owner::acquire(&f.0, "http://127.0.0.1:1").is_err());
        assert!(fs::read_to_string(f.0.join("server-format.json"))?.contains("999"));
        Ok(())
    }
    #[test]
    fn recorded_fallback_port_preserves_origin_without_overriding_custom_ports() -> Result<()> {
        let f = Folder::new();
        let owner = Owner::acquire(&f.0, "http://127.0.0.1:49123")?;
        owner.publish()?;
        assert_eq!(preferred_port(&f.0, DEFAULT_PORT), 49123);
        assert_eq!(preferred_port(&f.0, 7879), 7879);
        assert_eq!(preferred_port(&f.0, 0), 0);
        Ok(())
    }
    #[test]
    fn local_records_cannot_redirect_credentials_to_remote_hosts() -> Result<()> {
        let f = Folder::new();
        let owner = Owner::acquire(&f.0, "http://127.0.0.1:7878")?;
        let mut record = owner.record.clone();
        assert!(validate_local_record(&record).is_ok());
        for url in [
            "https://remote.example",
            "http://127.0.0.2:7878",
            "https://localhost",
        ] {
            record.url = url.into();
            assert!(validate_local_record(&record).is_err(), "{url}");
        }
        Ok(())
    }
    #[test]
    fn incompatible_api_readiness_and_capabilities_are_rejected() {
        let valid = json!({"product":"noctua","api_version":API_VERSION,"server_id":"test","ready":true,"capabilities":{"note_versions":true}});
        assert!(validate_identity(&valid).is_ok());
        for (field, value) in [
            ("api_version", json!(999)),
            ("ready", json!(false)),
            ("product", json!("foreign")),
            ("capabilities", json!({})),
            ("server_id", json!("")),
        ] {
            let mut changed = valid.clone();
            changed[field] = value;
            assert!(validate_identity(&changed).is_err(), "{field}");
        }
    }
    #[test]
    fn connection_addresses_cannot_hide_credentials_or_redirect_paths() {
        for value in [
            "http://remote.example",
            "https://user:secret@example.com",
            "https://example.com/path",
            "https://example.com/?token=secret",
            "https://example.com/#secret",
            "file:///tmp/a",
        ] {
            assert!(validate_url(value).is_err(), "{value}")
        }
        for value in ["http://127.0.0.1:7878", "https://computer.example.ts.net"] {
            assert!(validate_url(value).is_ok(), "{value}")
        }
    }
}
