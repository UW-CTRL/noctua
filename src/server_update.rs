//! Transactional local updates. The detached worker outlives the desktop installer.
use crate::server;
const SAFE_ENV: &[&str] = &[
    "NOCTUA_ORIGINS",
    "NOCTUA_SERVER_NAME",
    "NOCTUA_NOTES",
    "NOCTUA_CLAUDE",
    "NOCTUA_CODEX",
    "NOCTUA_LAUNCH_PATH",
    "ZOTERO_DATA_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
];
const SECRET_ENV: &[&str] = &[
    "NOCTUA_S2_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
];
fn handoff_path(id: &str) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    path(&format!(
        "server-launch-{:x}.json",
        Sha256::digest(id.as_bytes())
    ))
}
pub(crate) fn absolute(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return Ok(fs::canonicalize(path)?);
    }
    if !path.is_absolute() {
        return absolute(&std::env::current_dir()?.join(path));
    }
    Ok(
        absolute(path.parent().context("Launch path has no parent")?)?
            .join(path.file_name().context("Launch path has no filename")?),
    )
}
/// Only the private local control endpoint exports this; ordinary API/browser clients cannot.
pub(crate) fn launch_environment(app: &crate::App) -> Result<Value> {
    let mut environment = serde_json::Map::new();
    for key in SAFE_ENV.iter().chain(SECRET_ENV.iter()) {
        if let Ok(value) = std::env::var(key) {
            environment.insert((*key).into(), json!(value));
        }
    }
    let runtime = app.runtime.as_ref().context("Server control unavailable")?;
    environment.insert(
        "NOCTUA_ORIGINS".into(),
        json!(runtime
            .origins
            .iter()
            .filter(|value| value.starts_with("https://"))
            .cloned()
            .collect::<Vec<_>>()
            .join(",")),
    );
    environment.insert("NOCTUA_NOTES".into(), json!(absolute(&app.notes.root)?));
    environment.insert(
        "NOCTUA_LAUNCH_PATH".into(),
        json!(std::env::var("PATH").unwrap_or_default()),
    );
    Ok(Value::Object(environment))
}
fn validate_launch(data: &Path, environment: &Value) -> Result<()> {
    if let Some(notes) = environment["NOCTUA_NOTES"].as_str() {
        anyhow::ensure!(absolute(Path::new(notes))?.starts_with(fs::canonicalize(data)?),"External notes need a separately verified backup and manual update; the running server was kept");
    }
    Ok(())
}
fn save_launch(data: &Path, id: &str, environment: &Value) -> Result<()> {
    validate_launch(data, environment)?;
    let mut safe = serde_json::Map::new();
    let mut secrets = serde_json::Map::new();
    for key in SAFE_ENV {
        if let Some(value) = environment[*key].as_str() {
            safe.insert((*key).into(), json!(value));
        }
    }
    for key in SECRET_ENV {
        if let Some(value) = environment[*key].as_str() {
            secrets.insert((*key).into(), json!(value));
        }
    }
    if !safe.is_empty() {
        crate::paths::write_private(
            &data.join("server-launch.json"),
            &Value::Object(safe).to_string(),
        )?;
    }
    if !secrets.is_empty() {
        crate::paths::write_private(&handoff_path(id)?, &Value::Object(secrets).to_string())?;
    }
    Ok(())
}
/// Run only after acquiring the real machine/data owner, before loading server settings/keys.
pub(crate) fn restore_launch(data: &Path, id: &str) -> Result<()> {
    for (file, keys) in [
        (data.join("server-launch.json"), SAFE_ENV),
        (handoff_path(id)?, SECRET_ENV),
    ] {
        if !file.exists() {
            continue;
        }
        let values: Value = serde_json::from_slice(&fs::read(file)?)?;
        for key in keys {
            if std::env::var_os(key).is_none() {
                if let Some(value) = values[*key].as_str() {
                    std::env::set_var(key, value);
                }
            }
        }
    }
    if let Ok(path) = std::env::var("NOCTUA_LAUNCH_PATH") {
        std::env::set_var("PATH", path);
    }
    Ok(())
}
fn clear_handoff(id: &str) -> Result<()> {
    let file = handoff_path(id)?;
    if file.exists() {
        fs::remove_file(file)?;
    }
    Ok(())
}
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn path(name: &str) -> Result<PathBuf> {
    Ok(crate::client::config_dir()?.join(name))
}
fn lock(name: &str) -> Result<File> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path(name)?)?;
    f.try_lock()
        .context("Another server update worker is already running")?;
    Ok(f)
}
pub fn progress() -> Value {
    let mut value: Value = path("server-update.json")
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    if matches!(
        value["phase"].as_str(),
        Some("announcing" | "draining" | "backing_up" | "service" | "starting" | "cleanup")
    ) && value["updated_at"]
        .as_u64()
        .is_some_and(|at| now().saturating_sub(at) > 5)
        && lock("server-update-worker.lock").is_ok()
    {
        value["phase"] = json!("interrupted");
        value["error"]=json!("The update worker is no longer running. Previous binaries and any completed snapshot were retained. Check server status and retry the new release.");
    }
    value
}
fn report(state: &mut Value, phase: &str) -> Result<()> {
    state["phase"] = json!(phase);
    state["updated_at"] = json!(now());
    crate::paths::write_private(&path("server-update.json")?, &state.to_string())
}
fn reserve(id: &str, executable: &Path, data: &Path) -> Result<()> {
    crate::paths::write_private(
        &path("server-reservation.json")?,
        &json!({"id":id,"expires":now()+120,"executable":fs::canonicalize(executable)?,"data_dir":fs::canonicalize(data)?}).to_string(),
    )
}
pub fn check_reservation() -> Result<()> {
    let p = path("server-reservation.json")?;
    if !p.exists() {
        return Ok(());
    }
    if let Ok(_worker) = lock("server-update-worker.lock") {
        let _ = fs::remove_file(p);
        return Ok(());
    }
    let value: Value = serde_json::from_slice(&fs::read(p)?)?;
    // The live worker's OS lock is authoritative, including across wall-clock changes.
    let service_candidate = value["executable"]
        == json!(fs::canonicalize(std::env::current_exe()?)?)
        && value["data_dir"] == json!(fs::canonicalize(crate::paths::existing_data_dir()?)?);
    anyhow::ensure!(std::env::var("NOCTUA_START_TICKET").ok().as_deref()==value["id"].as_str()||service_candidate,"A server update has reserved startup. Wait for it to finish; no duplicate server was started");
    Ok(())
}
pub async fn candidate(executable: &Path) -> Result<Value> {
    let mut cmd = tokio::process::Command::new(executable);
    cmd.arg("describe").kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .context("Server executable compatibility check timed out")??;
    anyhow::ensure!(
        output.status.success(),
        "The new server could not describe its compatibility; the running server was kept"
    );
    let value: Value =
        serde_json::from_slice(&output.stdout).context("Invalid server executable metadata")?;
    anyhow::ensure!(
        value["product"] == "noctua"
            && value["api_version"] == server::API_VERSION
            && value["data_version"] == server::DATA_VERSION,
        "The bundled server has an incompatible API or data format"
    );
    anyhow::ensure!(
        value["executable_hash"] == server::executable_hash(executable)?,
        "The server executable changed during verification"
    );
    semver::Version::parse(
        value["version"]
            .as_str()
            .context("Server version missing")?,
    )?;
    Ok(value)
}
fn needs_update(current: &Value, next: &Value) -> Result<bool> {
    anyhow::ensure!(semver::Version::parse(current["version"].as_str().context("Running server version missing")?)?<=semver::Version::parse(next["version"].as_str().unwrap())?,"The running server is newer than this desktop. Update the desktop; automatic downgrade is refused");
    Ok(current["executable_hash"] != next["executable_hash"]
        || current["version"] != next["version"])
}
async fn control(data: &Path, action: &str, id: &str, version: &str) -> Result<Value> {
    let record = server::record(data)?;
    server::validate_local_record(&record)?;
    let identity = server::probe_any(&record.url, &server::token(data)?).await?;
    anyhow::ensure!(
        identity["server_id"] == record.server_id
            && identity["instance_id"] == record.instance_id
            && identity["data_dir"] == json!(fs::canonicalize(data)?),
        "Update control record changed; no lifecycle operation was sent"
    );
    let response = server::http()?
        .post(format!("{}/api/server/update", record.url))
        .bearer_auth(server::token(data)?)
        .header(
            "x-noctua-control",
            fs::read_to_string(data.join("server-control"))?,
        )
        .json(&json!({"action":action,"id":id,"version":version}))
        .send()
        .await?;
    let success = response.status().is_success();
    let body: Value = response.json().await?;
    anyhow::ensure!(
        success,
        "{}",
        body["error"]
            .as_str()
            .unwrap_or("Server refused the update control request")
    );
    Ok(body)
}
fn snapshot(data: &Path) -> Result<PathBuf> {
    fn copy(source: &Path, target: &Path, top: bool) -> Result<()> {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let name = entry.file_name();
            let text = name.to_string_lossy();
            if top
                && (text == "backups"
                    || matches!(
                        text.as_ref(),
                        "server.log"
                            | "server.json"
                            | "server-control"
                            | "server-owner.lock"
                            | "server-start.lock"
                            | "storage-location.lock"
                    ))
            {
                continue;
            }
            anyhow::ensure!(
                !entry.file_type()?.is_symlink(),
                "A data symlink needs a manual backup before server update"
            );
            if entry.file_type()?.is_dir() {
                copy(&entry.path(), &target.join(name), false)?;
            } else {
                fs::copy(entry.path(), target.join(name))?;
            }
        }
        Ok(())
    }
    let destination = data
        .join("backups")
        .join(format!("update-{}", uuid::Uuid::new_v4()));
    copy(data, &destination, true)?;
    let record = server::record(data)?;
    let marker: Value = serde_json::from_slice(&fs::read(data.join("server-format.json"))?)?;
    crate::paths::write_private(&destination.join("snapshot-complete.json"),&json!({"data_dir":fs::canonicalize(data)?,"created":now(),"scope":"complete stopped data folder","server_id":record.server_id,"server_version":marker["server_version"],"origin":record.url}).to_string())?;
    Ok(destination)
}
/// Only remove verified staged binaries. Never delete bundle paths or referenced registrations.
pub fn cleanup(keep: &Path) -> Result<Vec<String>> {
    let _cleanup = lock("server-cleanup.lock")?;
    let queue_path = path("retired-executables.json")?;
    let mut retired: Vec<PathBuf> = if queue_path.exists() {
        serde_json::from_slice(&fs::read(&queue_path)?)?
    } else {
        vec![]
    };
    let root = path("servers")?;
    let mut warnings = Vec::new();
    if !root.exists() {
        return Ok(warnings);
    }
    let mut protected = vec![fs::canonicalize(keep)?, std::env::current_exe()?];
    if let Some(p) = crate::service::registered_executable()? {
        protected.push(p);
    }
    if let Ok(record) = server::record(&crate::paths::existing_data_dir()?) {
        protected.push(record.executable);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((_, hash)) = name.rsplit_once('-') else {
            continue;
        };
        if hash.len() != 16 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let binary = dir.join(if cfg!(windows) {
            "noctua.exe"
        } else {
            "noctua"
        });
        if !binary.is_file() || binary.is_symlink() {
            continue;
        }
        if !retired
            .iter()
            .any(|p| fs::canonicalize(p).ok() == fs::canonicalize(&binary).ok())
        {
            continue;
        }
        if protected
            .iter()
            .any(|p| fs::canonicalize(p).ok() == fs::canonicalize(&binary).ok())
        {
            warnings.push(format!(
                "Previous executable is still referenced or running: {}",
                binary.display()
            ));
            continue;
        }
        if !server::executable_hash(&binary)?.starts_with(hash) {
            continue;
        }
        if let Err(error)=crate::server_resources::cleanup(&dir){warnings.push(format!("Compiler cleanup deferred: {error}"));continue;}
        match fs::remove_file(&binary) {
            Ok(()) => {
                let _ = fs::remove_dir(&dir);
            }
            Err(_) => warnings.push(format!(
                "Old staged executable is still in use: {}",
                binary.display()
            )),
        }
    }
    retired.retain(|p| p.exists());
    crate::paths::write_private(&queue_path, &serde_json::to_string(&retired)?)?;
    Ok(warnings)
}
fn retire(old: &Path) -> Result<()> {
    if !old.try_exists()? {
        return Ok(());
    }
    let old = fs::canonicalize(old)?;
    if !old.starts_with(fs::canonicalize(path("servers")?)?) {
        return Ok(());
    }
    let _cleanup = lock("server-cleanup.lock")?;
    let p = path("retired-executables.json")?;
    let mut retired: Vec<PathBuf> = if p.exists() {
        serde_json::from_slice(&fs::read(&p)?)?
    } else {
        vec![]
    };
    if !retired.iter().any(|entry| entry == &old) {
        retired.push(old);
    }
    crate::paths::write_private(&p, &serde_json::to_string(&retired)?)
}
/// A foreground CLI worker; desktop callers spawn this command detached.
pub async fn run(
    executable: &Path,
    _port: u16,
    force: bool,
    grace: Duration,
    timeout: Duration,
) -> Result<Value> {
    let _worker = lock("server-update-worker.lock")?;
    let next = candidate(executable).await?;
    let data = crate::paths::existing_data_dir()?;
    let _control = server::control_lock(&data).await?;
    let old = server::record(&data)?;
    server::validate_local_record(&old)?;
    anyhow::ensure!(
        old.product == "noctua"
            && old.api_version == server::API_VERSION
            && old.data_dir == fs::canonicalize(&data)?,
        "The stopped server record belongs to another product, API or data folder"
    );
    let marker: Value = serde_json::from_slice(&fs::read(data.join("server-format.json"))?)?;
    anyhow::ensure!(
        marker["server_id"] == old.server_id && marker["data_version"] == server::DATA_VERSION,
        "The recorded data generation is incompatible; no server was changed"
    );
    anyhow::ensure!(
        semver::Version::parse(
            marker["server_version"]
                .as_str()
                .context("Data generation version missing")?
        )? <= semver::Version::parse(next["version"].as_str().unwrap())?,
        "An older binary cannot reopen this data generation"
    );
    let (current, running) = match server::status_any(&data).await {
        Ok(value) => (value, true),
        Err(_) => {
            // Prove absence with ownership locks, never with a PID or failed HTTP probe.
            let machine = server::machine_lease()?;
            drop(server::exclusive(&data.join("server-owner.lock"))?);
            drop(machine);
            let mut value = serde_json::to_value(&old)?;
            value["version"] = marker["server_version"].clone();
            (value, false)
        }
    };
    if running && !needs_update(&current, &next)? && !force {
        return Ok(current);
    }
    if running {
        anyhow::ensure!(current["capabilities"]["server_updates"]==true,"This server cannot coordinate updates. Notify clients and safely stop it with its matching CLI before upgrading; no process was stopped");
    }
    if std::env::var_os("NOCTUA_HOME").is_none() {
        anyhow::ensure!(
            crate::storage::pending()?.is_none(),
            "Finish or cancel the pending data-folder move before updating the server"
        );
    }
    if let Some(notes) = std::env::var_os("NOCTUA_NOTES") {
        anyhow::ensure!(fs::canonicalize(notes)?.starts_with(fs::canonicalize(&data)?),"External notes require a separate verified backup. Move notes under the data folder or perform a manual update");
    }
    let service = crate::service::status();
    anyhow::ensure!(
        service["error"].is_null(),
        "Cannot verify login service state; no server was stopped"
    );
    if service["installed"] == true {
        anyhow::ensure!(
            crate::service::matches_data(&data)?,
            "The login service belongs to another data folder"
        );
    }
    let old_binary_usable = server::executable_hash(&old.executable).ok().as_deref()
        == Some(old.executable_hash.as_str())
        && marker["server_version"] == old.version;
    if running {
        anyhow::ensure!(current["executable"]==json!(old.executable)&&current["executable_hash"]==old.executable_hash&&current["version"]==old.version,"The local executable record does not match the authenticated running server; no server was stopped");
        anyhow::ensure!(old_binary_usable,"The previous executable was replaced on disk. Keep a matching old binary and perform a coordinated manual update; the running server was kept");
    }
    let pinned_port = reqwest::Url::parse(&old.url)?
        .port_or_known_default()
        .context("Running server port missing")?;
    let id = uuid::Uuid::new_v4().to_string();
    let previous = progress();
    let mut state = json!({"id":id,"data_dir":data,"old_executable":old.executable,"old_version":old.version,"old_server_id":old.server_id,"target_executable":executable,"target_version":next["version"],"started_at":now(),"previous_backup":previous["backup"],"old_stopped":!running});
    let mut stopped = !running;
    let mut candidate_started = false;
    let mut launch_context = Value::Null;
    let result: Result<Value> = async {
        reserve(&id,executable,&data)?;
        report(&mut state, if running { "announcing" } else { "backing_up" })?;
        if running {
            launch_context=control(&data, "begin", &id, next["version"].as_str().unwrap()).await?["launch_environment"].clone();
            validate_launch(&data,&launch_context)?;
            let until = tokio::time::Instant::now() + grace;
            while tokio::time::Instant::now() < until {
                reserve(&id,executable,&data)?;
                control(&data, "heartbeat", &id, "").await?;
                tokio::time::sleep(Duration::from_millis(500).min(
                    until.saturating_duration_since(tokio::time::Instant::now())
                )).await;
            }
            control(&data, "drain", &id, "").await?;
            report(&mut state, "draining")?;
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                reserve(&id,executable,&data)?;
                let status = control(&data, "heartbeat", &id, "").await?;
                anyhow::ensure!(status["pending_review"] != true,
                    "A chat file edit or completed skill run needs approval/output review. Apply or reject it before retrying the update; the server and results were kept");
                if status["idle"] == true { break; }
                anyhow::ensure!(tokio::time::Instant::now() < deadline,
                    "Timed out waiting for tasks. The old server remains running; no task was killed");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            // Persist the protected launch handoff before the last running owner
            // exits, so a worker crash immediately after stop cannot lose it.
            save_launch(&data,&old.server_id,&launch_context)?;
            server::stop_locked(&data).await?;
            stopped = true;
            state["old_stopped"] = json!(true);
        }
        // Keep direct serve commands out while snapshotting and repointing the service.
        let machine = server::machine_lease()?;
        let data_owner=server::exclusive(&data.join("server-owner.lock"))?;
        report(&mut state, "backing_up")?;
        save_launch(&data,&old.server_id,&launch_context)?;
        let backup = snapshot(&data)?;
        state["backup"] = json!(backup);
        drop(data_owner);
        if service["enabled"] == true {
            report(&mut state, "service")?;
            crate::service::refresh(executable, &data)?;
        }
        report(&mut state, "starting")?;
        reserve(&id,executable,&data)?;
        drop(machine);
        if service["enabled"]==true {crate::service::start()?;}else{server::spawn_detached(executable, &data, pinned_port, &[], Some(&id))?;}
        candidate_started = true;
        state["candidate_started"] = json!(true);
        report(&mut state, "starting")?;
        let ready = server::wait_ready(&data).await?;
        anyhow::ensure!(ready["server_id"] == current["server_id"]
            && ready["executable_hash"] == next["executable_hash"]
            && ready["version"] == next["version"] && ready["url"] == old.url,
            "Replacement server identity/version/address does not match the verified candidate. Previous binaries and backup were retained");
        state["instance_id"] = ready["instance_id"].clone();
        report(&mut state, "cleanup")?;
        let retired = if fs::canonicalize(&old.executable).ok() == fs::canonicalize(executable).ok() {
            Ok(())
        } else {
            retire(&old.executable)
        };
        let mut warnings = retired
            .and_then(|_| retire_previous(&previous, &ready))
            .and_then(|_| cleanup(executable))
            .unwrap_or_else(|error| vec![format!("Cleanup deferred: {error}")]);
        if clear_handoff(&old.server_id).is_err(){warnings.push("Protected credential handoff cleanup is pending".into());}
        state["cleanup_pending"] = json!(warnings);
        report(&mut state, "complete")?;
        Ok(ready)
    }.await;
    if let Err(error) = &result {
        let mut restored_old = false;
        if !stopped {
            let _ = control(&data, "cancel", &id, "").await;
            let _ = clear_handoff(&old.server_id);
        }
        if stopped && !candidate_started && running && old_binary_usable {
            let _ = reserve(&id, &old.executable, &data);
            let registered = service["enabled"] == true
                && crate::service::refresh(&old.executable, &data).is_ok();
            if registered {
                if let Ok(Some(executable)) = crate::service::registered_executable() {
                    let _ = reserve(&id, &executable, &data);
                }
            }
            let restored = if registered {
                crate::service::start()
            } else {
                server::spawn_detached(&old.executable, &data, pinned_port, &[], Some(&id))
            };
            if restored.is_ok() {
                restored_old = server::wait_ready(&data).await.is_ok_and(|ready| {
                    ready["server_id"] == old.server_id
                        && ready["version"] == old.version
                        && ready["executable_hash"] == old.executable_hash
                        && ready["url"] == old.url
                });
            }
        }
        if restored_old {
            let _ = clear_handoff(&old.server_id);
        }
        state["old_server_restored"] = json!(restored_old);
        state["error"] = json!(format!("{error:#}"));
        state["recovery"] = json!(if candidate_started {
            "A replacement may have opened the database. Keep its backup and previous executable; retry the new release or restore the entire snapshot while stopped. Do not start an older binary against changed data."
        } else if restored_old {
            "The previous server is ready again. Resolve the reported issue and retry."
        } else {
            "No replacement was confirmed. Check server status; snapshots and previous executables were retained. Retry the new release after resolving the reported issue."
        });
        let _ = report(&mut state, "failed");
    }
    let reservation = path("server-reservation.json")?;
    if fs::read(&reservation)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v["id"] == id)
    {
        let _ = fs::remove_file(reservation);
    }
    result
}
fn active(state: &Value) -> bool {
    matches!(
        state["phase"].as_str(),
        Some("announcing" | "draining" | "backing_up" | "service" | "starting" | "cleanup")
    )
}
fn retire_previous(previous: &Value, current: &Value) -> Result<()> {
    if previous["old_stopped"] != true {
        return Ok(());
    }
    let Some(backup) = previous["backup"].as_str().map(PathBuf::from) else {
        return Ok(());
    };
    let data = PathBuf::from(
        current["data_dir"]
            .as_str()
            .context("Server data folder missing")?,
    );
    if !fs::canonicalize(&backup)?.starts_with(fs::canonicalize(data.join("backups"))?) {
        return Ok(());
    }
    let complete: Value =
        serde_json::from_slice(&fs::read(backup.join("snapshot-complete.json"))?)?;
    anyhow::ensure!(
        complete["server_id"] == current["server_id"],
        "The recovery snapshot belongs to a different server"
    );
    anyhow::ensure!(complete["origin"]==current["url"],"The replacement address changed. Keep the snapshot and restore the previous port/proxy before completing recovery");
    if let Some(old) = previous["old_executable"].as_str().map(PathBuf::from) {
        if fs::canonicalize(&old).ok()
            != current["executable"]
                .as_str()
                .and_then(|p| fs::canonicalize(p).ok())
        {
            retire(&old)?;
        }
    }
    Ok(())
}
/// Reuse a compatible owner, or resume/launch an independent release transaction.
pub async fn ensure_current(executable: &Path, port: u16) -> Result<Value> {
    let data = crate::paths::existing_data_dir()?;
    let next = candidate(executable).await?;
    let mut current = match server::status_any(&data).await {
        Ok(value) => value,
        Err(_) => {
            if let Ok(record) = server::record(&data) {
                let state = progress();
                if record.executable_hash != next["executable_hash"].as_str().unwrap_or("")
                    || record.version != next["version"].as_str().unwrap_or("")
                    || matches!(state["phase"].as_str(), Some("failed" | "interrupted"))
                {
                    return launch_and_wait(executable, port, &next, &data, false).await;
                }
            }
            return server::ensure(executable, port).await;
        }
    };
    if current["maintenance"].is_object() || active(&progress()) {
        let watched = progress()["id"].clone();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1900);
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = progress();
            anyhow::ensure!(
                !(state["id"] == watched
                    && matches!(state["phase"].as_str(), Some("failed" | "interrupted"))),
                "The existing update did not finish. Check Server & connection and retry"
            );
            if let Ok(value) = server::status_any(&data).await {
                if value["maintenance"].is_null() && value["ready"] == true && !active(&state) {
                    current = value;
                    break;
                }
            }
            anyhow::ensure!(
                tokio::time::Instant::now() < deadline,
                "The server is still updating; its independent worker continues"
            );
        }
    }
    // A compatible older desktop must reuse a newer server, never downgrade it.
    if semver::Version::parse(
        current["version"]
            .as_str()
            .context("Server version missing")?,
    )? > semver::Version::parse(next["version"].as_str().unwrap())?
    {
        return server::status(&data).await;
    }
    if !needs_update(&current, &next)? {
        if let Ok(_worker) = lock("server-update-worker.lock") {
            let _control = server::control_lock(&data).await?;
            current = server::status(&data).await?;
            let mut state = progress();
            if matches!(state["phase"].as_str(), Some("failed" | "interrupted"))
                && state["candidate_started"] == true
                && state["backup"]
                    .as_str()
                    .is_some_and(|p| Path::new(p).join("snapshot-complete.json").is_file())
                && state["target_version"] == current["version"]
                && current["executable_hash"] == next["executable_hash"]
            {
                retire_previous(&state, &current)?;
                state["instance_id"] = current["instance_id"].clone();
                clear_handoff(
                    current["server_id"]
                        .as_str()
                        .context("Server identity missing")?,
                )?;
                state["recovered"] = json!(true);
                if let Some(object) = state.as_object_mut() {
                    object.remove("error");
                    object.remove("recovery");
                }
                state["cleanup_pending"] =
                    json!(cleanup(executable).unwrap_or_else(|e| vec![e.to_string()]));
                report(&mut state, "complete")?;
            } else if let Ok(warnings) = cleanup(executable) {
                if state["phase"] == "complete" {
                    clear_handoff(
                        current["server_id"]
                            .as_str()
                            .context("Server identity missing")?,
                    )?;
                    state["cleanup_pending"] = json!(warnings);
                    report(&mut state, "complete")?;
                }
            }
        }
        return Ok(current);
    }
    anyhow::ensure!(current["capabilities"]["server_updates"]==true,"This older server cannot coordinate an update. Notify clients, finish tasks and stop it safely with its matching CLI, then retry the new release");
    launch_and_wait(executable, port, &next, &data, false).await
}
pub async fn retry_current(executable: &Path, port: u16) -> Result<Value> {
    if matches!(progress()["phase"].as_str(), Some("failed" | "interrupted")) {
        let data = crate::paths::existing_data_dir()?;
        let next = candidate(executable).await?;
        launch_and_wait(executable, port, &next, &data, true).await
    } else {
        ensure_current(executable, port).await
    }
}
async fn launch_and_wait(
    executable: &Path,
    port: u16,
    next: &Value,
    data: &Path,
    force: bool,
) -> Result<Value> {
    let staged = crate::service::stage(executable)?;
    let previous = progress();
    let began = tokio::time::Instant::now();
    let arguments = if force {
        vec!["update", "--force"]
    } else {
        vec!["update"]
    };
    server::spawn_detached(&staged, data, port, &arguments, None)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1900);
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let state = progress();
        if state["target_executable"] == json!(staged)
            && matches!(state["phase"].as_str(), Some("failed" | "interrupted"))
            && (state["id"] != previous["id"] || previous["phase"] != "failed")
        {
            anyhow::bail!(
                "Server update failed: {}. {}",
                state["error"].as_str().unwrap_or("Check server.log"),
                state["recovery"]
                    .as_str()
                    .unwrap_or("Retry from Server & connection")
            );
        }
        if let Ok(ready) = server::status(data).await {
            if replacement_confirmed(&state, &previous, &ready, next) {
                return Ok(ready);
            }
        }
        if began.elapsed() > Duration::from_secs(15) && lock("server-update-worker.lock").is_ok() {
            anyhow::bail!("The update worker exited before confirming replacement. Check server.log and retry; no process was killed");
        }
        anyhow::ensure!(tokio::time::Instant::now()<deadline,"The update is still pending. Its independent worker continues; check Server & connection");
    }
}
fn replacement_confirmed(state: &Value, previous: &Value, ready: &Value, next: &Value) -> bool {
    ready["executable_hash"] == next["executable_hash"]
        && ready["version"] == next["version"]
        && state["id"] != previous["id"]
        && state["phase"] == "complete"
        && state["instance_id"] == ready["instance_id"]
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_snapshot_retains_hidden_collection_research() -> Result<()> {
        let data = tempfile::tempdir()?;
        let relative = "notes/C1/.workspace/research/state.json";
        fs::create_dir_all(data.path().join(relative).parent().unwrap())?;
        fs::write(data.path().join(relative), r#"{"version":1,"revision":1,"goal":"Draft","progress":20,"dates":[]}"#)?;
        fs::write(data.path().join("server.json"), json!({"product":"noctua","server_id":"test","instance_id":"test-instance","api_version":1,"version":"0.2.8","data_dir":data.path(),"url":"http://127.0.0.1:47878","pid":0}).to_string())?;
        fs::write(data.path().join("server-format.json"), r#"{"server_version":"0.2.8"}"#)?;
        let backup = snapshot(data.path())?;
        assert_eq!(fs::read(backup.join(relative))?, fs::read(data.path().join(relative))?);
        assert!(backup.join("snapshot-complete.json").exists());
        Ok(())
    }

    #[test]
    fn same_binary_retry_waits_for_its_new_instance_and_completed_transaction() {
        let previous = json!({"id":"previous","phase":"failed"});
        let ready = json!({"executable_hash":"same","version":"2.0.0","instance_id":"old"});
        assert!(!replacement_confirmed(&previous, &previous, &ready, &ready));
        let mut state = json!({"id":"retry","phase":"starting","instance_id":"new"});
        assert!(!replacement_confirmed(&state, &previous, &ready, &ready));
        state["phase"] = json!("complete");
        assert!(!replacement_confirmed(&state, &previous, &ready, &ready));
        let mut replaced = ready.clone();
        replaced["instance_id"] = json!("new");
        assert!(replacement_confirmed(&state, &previous, &replaced, &ready));
    }
    #[test]
    fn downgrade_and_unchanged_binary_are_detected() {
        let current = json!({"version":"2.0.0","executable_hash":"old"});
        assert!(needs_update(
            &current,
            &json!({"version":"1.0.0","executable_hash":"new"})
        )
        .is_err());
        assert!(!needs_update(&current, &current).unwrap());
        assert!(needs_update(
            &current,
            &json!({"version":"2.0.0","executable_hash":"new"})
        )
        .unwrap());
    }
}
