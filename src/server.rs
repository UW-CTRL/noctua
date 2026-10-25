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
}

pub struct Owner {
    _lock: File,
    pub record: Record,
    pub token: String,
    pub control: String,
}
fn exclusive(path: &Path) -> Result<File> {
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
        fs::create_dir_all(data)?;
        let lock = exclusive(&data.join("server-owner.lock"))?;
        // This marker is deliberately separate from SQLite's schema and migration lease.
        let marker = data.join("server-format.json");
        let server_id = if marker.exists() {
            let value: Value = serde_json::from_slice(&fs::read(&marker)?)?;
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
        let token = if token_path.exists() {
            fs::read_to_string(&token_path)?
        } else {
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            crate::paths::write_private(&token_path, &token)?;
            token
        };
        anyhow::ensure!(
            token.len() >= 32 && !token.contains(char::is_whitespace),
            "Invalid server-token file"
        );
        let record = Record {
            product: "noctua".into(),
            server_id,
            instance_id: uuid::Uuid::new_v4().to_string(),
            api_version: API_VERSION,
            version: env!("CARGO_PKG_VERSION").into(),
            data_dir: fs::canonicalize(data)?,
            url: url.into(),
            pid: std::process::id(),
        };
        let control = uuid::Uuid::new_v4().simple().to_string();
        crate::paths::write_private(&data.join("server-control"), &control)?;
        Ok(Self {
            _lock: lock,
            record,
            token,
            control,
        })
    }
    pub fn publish(&self) -> Result<()> {
        crate::paths::write_private(
            &self.record.data_dir.join("server.json"),
            &serde_json::to_string_pretty(&self.record)?,
        )
    }
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
    validate_identity(&value)?;
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
fn validate_local_record(record: &Record) -> Result<()> {
    let url = validate_url(&record.url)?;
    anyhow::ensure!(
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        "Local server record must point to a loopback HTTP address; refusing to send credentials"
    );
    Ok(())
}

pub async fn status(data: &Path) -> Result<Value> {
    let r = record(data)?;
    anyhow::ensure!(
        r.product == "noctua" && r.api_version == API_VERSION,
        "Incompatible server record; update the client/server before reconnecting"
    );
    validate_local_record(&r)?;
    let v = probe(&r.url, &token(data)?).await?;
    anyhow::ensure!(
        v["server_id"] == r.server_id
            && v["instance_id"] == r.instance_id
            && v["data_dir"] == json!(fs::canonicalize(data)?),
        "Stale or foreign server record; refusing control"
    );
    Ok(v)
}

/// The control lock covers an entire ensure, stop, or restart transaction.
/// `serve` owns the data lock instead, so a detached child can become ready
/// while its launcher keeps concurrent client control operations serialized.
async fn control_lock(data: &Path) -> Result<File> {
    fs::create_dir_all(data)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("server-start.lock"))?;
    for _ in 0..300 {
        if file.try_lock().is_ok() {
            return Ok(file);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("Another client is managing the server. Retry shortly")
}

pub async fn ensure(executable: &Path, port: u16) -> Result<Value> {
    let coordination = crate::paths::existing_data_dir()?;
    let _control = control_lock(&coordination).await?;
    ensure_locked(executable, port, &coordination).await
}

async fn ensure_locked(executable: &Path, port: u16, coordination: &Path) -> Result<Value> {
    if let Ok(v) = status(coordination).await {
        return Ok(v);
    }
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
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .open(data.join("server.log"))?;
        crate::paths::restrict(&data.join("server.log"));
        let mut cmd = Command::new(fs::canonicalize(executable)?);
        if std::env::var_os("NOCTUA_HOME").is_some_and(|value| !value.is_empty()) {
            cmd.env("NOCTUA_HOME", fs::canonicalize(&data)?);
        }
        if std::env::var_os("NOCTUA_PROFILE_HOME").is_some_and(|value| !value.is_empty()) {
            cmd.env(
                "NOCTUA_PROFILE_HOME",
                fs::canonicalize(crate::paths::default_data_dir())?,
            );
        }
        for variable in ["NOCTUA_NOTES", "NOCTUA_CLAUDE", "NOCTUA_CODEX"] {
            if let Some(value) = std::env::var_os(variable) {
                let path = PathBuf::from(value);
                if path.is_relative()
                    && (variable == "NOCTUA_NOTES" || path.components().count() > 1)
                {
                    cmd.env(variable, std::env::current_dir()?.join(path));
                }
            }
        }
        cmd.arg("serve")
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
            cmd.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | NEW_PROCESS_GROUP
        }
        let mut child = cmd
            .spawn()
            .context("Cannot start the separate server executable")?;
        // Reap the launcher child without tying server lifetime to this process.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
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

async fn stop_locked(data: &Path) -> Result<()> {
    status(data).await?;
    let r = record(data)?;
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
