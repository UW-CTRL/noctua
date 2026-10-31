//! Signed updates, shared by every window and tab in this process.
use noctua::UpdateAction;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates(tokio::sync::Mutex<Pending>);

#[derive(Default)]
struct Pending {
    update: Option<Update>,
    server: Option<noctua::releases::Offer>,
    server_id: Option<String>,
    installed: bool,
    startup_checked: bool,
}

fn summaries(raw: &Value, current: &str, latest: &str) -> Vec<Value> {
    let (Ok(current), Ok(latest)) = (semver::Version::parse(current), semver::Version::parse(latest)) else { return vec![] };
    let mut entries: Vec<_> = raw["release_summaries"].as_array().into_iter().flatten().filter_map(|entry| {
        let version = semver::Version::parse(entry["version"].as_str()?).ok()?;
        (version > current && version <= latest && version.pre.is_empty()).then(|| (version, entry.clone()))
    }).collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.dedup_by(|a, b| a.0 == b.0);
    entries.into_iter().map(|(_, entry)| entry).collect()
}

// DMG-only releases must never check for or install an archive update.
fn manual_macos_update(action: UpdateAction) -> anyhow::Result<Value> {
    if matches!(action, UpdateAction::StartupCheck) {
        return Ok(json!({ "status": "skipped" }));
    }
    anyhow::bail!("macOS updates require manual installation. Download the Apple Silicon DMG from https://github.com/UW-CTRL/noctua/releases/latest, quit Noctua, and replace Noctua in Applications. Intel Macs must retain an older Universal release.");
}

pub async fn run(app: &AppHandle, action: UpdateAction, version: Option<String>) -> anyhow::Result<Value> {
    let state = app.state::<Updates>();
    let mut pending = state.0.try_lock()
        .map_err(|_| anyhow::anyhow!("An update operation is already in progress. Please wait."))?;
    if matches!(action, UpdateAction::StartupCheck) {
        if pending.startup_checked { return Ok(json!({ "status": "skipped" })); }
        // Claim before awaiting the network: opening another window must not show a second prompt.
        pending.startup_checked = true;
    }
    if pending.installed {
        if matches!(action, UpdateAction::Restart) {
            // Give the local HTTP response time to reach the Settings panel.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                handle.request_restart();
            });
        }
        return Ok(json!({ "status": "installed" }));
    }
    match action {
        UpdateAction::Check | UpdateAction::StartupCheck => {
            let public_key = option_env!("NOCTUA_UPDATER_PUBLIC_KEY").unwrap_or("").trim();
            anyhow::ensure!(!public_key.is_empty(),
                "This build has no update verification key. Install an official release to enable updates.");
            // Forget an earlier offer if this check fails: never install stale metadata.
            pending.update = None;
            pending.server = None;
            pending.server_id = None;
            let mut warnings = Vec::new();
            if cfg!(target_os = "macos") {
                if matches!(action, UpdateAction::Check) {
                    warnings.push(manual_macos_update(UpdateAction::Check).unwrap_err().to_string());
                }
            } else if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
                warnings.push("Use your package manager to update this desktop installation. Local server updates are still available.".to_owned());
            } else {
                let updater = app.updater_builder()
                    .timeout(std::time::Duration::from_secs(15 * 60)).build()?;
                match tokio::time::timeout(std::time::Duration::from_secs(30), updater.check()).await {
                    Ok(Ok(update)) => pending.update = update,
                    Ok(Err(error)) => warnings.push(format!("Desktop update check failed: {error}")),
                    Err(_) => warnings.push("Desktop update check timed out.".to_owned()),
                }
            }
            let mut server_current = None;
            if let Ok(data) = noctua::paths::existing_data_dir() {
                if let Ok(local) = noctua::server::status(&data).await {
                    let bundled = crate::bundled_server_executable(app)?;
                    let identity = noctua::server_update::candidate(&bundled).await?;
                    let current = local["version"].as_str().ok_or_else(|| anyhow::anyhow!("Local server version missing"))?;
                    server_current = Some(current.to_owned());
                    let mut baseline = semver::Version::parse(current)?;
                    for version in [identity["version"].as_str(), pending.update.as_ref().and_then(|u| u.raw_json["server_version"].as_str())].into_iter().flatten() {
                        baseline = baseline.max(semver::Version::parse(version)?);
                    }
                    match tokio::time::timeout(std::time::Duration::from_secs(45), noctua::releases::check(&baseline.to_string(), public_key, &identity["paper_compilers"])).await {
                        Ok(Ok(offer)) => { pending.server = offer; pending.server_id = local["server_id"].as_str().map(str::to_owned); }
                        Ok(Err(error)) => warnings.push(format!("Server update check failed: {error}")),
                        Err(_) => warnings.push("Server update check timed out.".to_owned()),
                    }
                }
            }
            let mut result = match &pending.update {
                Some(update) => json!({ "status": "available", "version": update.version,
                    "current_version": update.current_version,
                    "releases": summaries(&update.raw_json, &update.current_version, &update.version) }),
                None => json!({ "status": "current" }),
            };
            if let Some(offer) = &pending.server {
                result["server"] = json!({"version":offer.manifest.version,"current_version":server_current});
                if pending.update.is_none() {
                    result["status"] = json!("available");
                    result["component"] = json!("server");
                    result["version"] = json!(offer.manifest.version);
                    result["current_version"] = json!(server_current);
                }
            }
            result["warnings"] = json!(warnings);
            if result["status"] == "current" && !warnings.is_empty() {
                anyhow::bail!("{}", warnings.join(" "));
            }
            if cfg!(target_os = "macos") && matches!(action, UpdateAction::StartupCheck) && result["status"] == "current" {
                result["status"] = json!("skipped");
            }
            Ok(result)
        }
        UpdateAction::Install => {
            if cfg!(target_os = "macos") && pending.server.is_none() {
                return manual_macos_update(action);
            }
            let offered_version = pending.update.as_ref().map(|u| u.version.as_str())
                .or_else(|| pending.server.as_ref().map(|s| s.manifest.version.as_str()))
                .ok_or_else(|| anyhow::anyhow!("Check for updates before installing."))?;
            anyhow::ensure!(version.as_deref() == Some(offered_version),
                "The offered update changed in another window. Check for updates again before installing.");
            if let Some(offer) = &pending.server {
                let data = noctua::paths::existing_data_dir()?;
                let current = noctua::server::status(&data).await?;
                anyhow::ensure!(current["server_id"].as_str() == pending.server_id.as_deref(), "The local server changed. Check for updates again.");
                anyhow::ensure!(semver::Version::parse(current["version"].as_str().ok_or_else(|| anyhow::anyhow!("Local server version missing"))?)? < semver::Version::parse(&offer.manifest.version)?, "The local server version changed. Check for updates again.");
                let bundled = crate::bundled_server_executable(app)?;
                let binary = noctua::releases::download(offer, option_env!("NOCTUA_UPDATER_PUBLIC_KEY").unwrap_or(""), &bundled).await?;
                noctua::releases::begin(&binary, crate::PORT)?;
                pending.server = None;
            }
            let Some(update) = pending.update.as_ref() else {
                return Ok(json!({"status":"server_updating"}));
            };
            update.download_and_install(|_, _| {}, || {}).await?;
            pending.installed = true;
            pending.update = None;
            Ok(json!({ "status": "installed" }))
        }
        UpdateAction::Restart => {
            if cfg!(target_os = "macos") { return manual_macos_update(action); }
            anyhow::bail!("Install an update before restarting.")
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_desktop_archive_updates_require_manual_installation() {
        assert_eq!(manual_macos_update(UpdateAction::StartupCheck).unwrap(), json!({"status":"skipped"}));
        for action in [UpdateAction::Check, UpdateAction::Install, UpdateAction::Restart] {
            let message = manual_macos_update(action).unwrap_err().to_string();
            assert!(message.contains("manual installation"));
            assert!(message.contains("https://github.com/UW-CTRL/noctua/releases/latest"));
        }
    }

    #[test]
    fn changes_cover_only_versions_between_installed_and_offered_releases() {
        let raw = json!({"release_summaries": [
            {"version":"0.2.0"}, {"version":"0.1.0"}, {"version":"0.4.0"},
            {"version":"0.3.0"}, {"version":"0.3.0"}, {"version":"0.3.0-beta"},
            {"version":"invalid"}, {"changes":[]}
        ]});
        assert_eq!(summaries(&raw, "0.1.0", "0.3.0"), vec![json!({"version":"0.3.0"}), json!({"version":"0.2.0"})]);
        assert!(summaries(&Value::Null, "0.1.0", "0.3.0").is_empty());
    }
}
