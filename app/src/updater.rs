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
    if cfg!(target_os = "macos") {
        return manual_macos_update(action);
    }
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
            #[cfg(target_os = "linux")]
            anyhow::ensure!(std::env::var_os("APPIMAGE").is_some(),
                "In-app updates require the AppImage build on Linux. Update .deb installations with your package manager.");
            anyhow::ensure!(!option_env!("NOCTUA_UPDATER_PUBLIC_KEY").unwrap_or("").trim().is_empty(),
                "This build has no update verification key. Install an official release to enable updates.");
            // Forget an earlier offer if this check fails: never install stale metadata.
            pending.update = None;
            let updater = app.updater_builder()
                .timeout(std::time::Duration::from_secs(15 * 60)).build()?;
            pending.update = tokio::time::timeout(std::time::Duration::from_secs(30), updater.check())
                .await.map_err(|_| anyhow::anyhow!("Checking for updates timed out. Please try again."))??;
            Ok(match &pending.update {
                Some(update) => json!({ "status": "available", "version": update.version,
                    "current_version": update.current_version,
                    "releases": summaries(&update.raw_json, &update.current_version, &update.version) }),
                None => json!({ "status": "current" }),
            })
        }
        UpdateAction::Install => {
            let update = pending.update.as_ref()
                .ok_or_else(|| anyhow::anyhow!("Check for updates before installing."))?;
            anyhow::ensure!(version.as_ref().is_none_or(|version| version == &update.version),
                "The offered update changed in another window. Check for updates again before installing.");
            update.download_and_install(|_, _| {}, || {}).await?;
            pending.installed = true;
            pending.update = None;
            Ok(json!({ "status": "installed" }))
        }
        UpdateAction::Restart => anyhow::bail!("Install an update before restarting."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_skips_startup_and_requires_manual_installation_for_every_action() {
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
