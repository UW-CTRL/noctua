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
}

pub async fn run(app: &AppHandle, action: UpdateAction) -> anyhow::Result<Value> {
    let state = app.state::<Updates>();
    let mut pending = state.0.try_lock()
        .map_err(|_| anyhow::anyhow!("An update operation is already in progress. Please wait."))?;
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
        UpdateAction::Check => {
            #[cfg(target_os = "linux")]
            anyhow::ensure!(std::env::var_os("APPIMAGE").is_some(),
                "In-app updates require the AppImage build on Linux. Update .deb and .rpm installations with your package manager.");
            anyhow::ensure!(!option_env!("NOCTUA_UPDATER_PUBLIC_KEY").unwrap_or("").trim().is_empty(),
                "This build has no update verification key. Install an official release to enable updates.");
            // Forget an earlier offer if this check fails: never install stale metadata.
            pending.update = None;
            let updater = app.updater_builder()
                .timeout(std::time::Duration::from_secs(15 * 60)).build()?;
            pending.update = tokio::time::timeout(std::time::Duration::from_secs(30), updater.check())
                .await.map_err(|_| anyhow::anyhow!("Checking for updates timed out. Please try again."))??;
            Ok(match &pending.update {
                Some(update) => json!({ "status": "available", "version": update.version }),
                None => json!({ "status": "current" }),
            })
        }
        UpdateAction::Install => {
            let update = pending.update.as_ref()
                .ok_or_else(|| anyhow::anyhow!("Check for updates before installing."))?;
            update.download_and_install(|_, _| {}, || {}).await?;
            pending.installed = true;
            pending.update = None;
            Ok(json!({ "status": "installed" }))
        }
        UpdateAction::Restart => anyhow::bail!("Install an update before restarting."),
    }
}
