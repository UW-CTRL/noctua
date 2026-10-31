use noctua::frontend::Frontend;
use std::{collections::HashMap, sync::Mutex};
include!(concat!(env!("OUT_DIR"), "/ui_assets.rs"));
#[derive(Default)]
pub struct Frontends(pub Mutex<HashMap<String, Frontend>>);
pub fn asset(path: &str) -> Option<&'static [u8]> {
    UI_ASSETS
        .iter()
        .find(|(name, _)| *name == path)
        .map(|(_, bytes)| *bytes)
}

const STORAGE_SCRIPT: &str = include_str!("../../web/desktop-storage.js");
async fn evaluate(
    window: &tauri::WebviewWindow,
    script: String,
) -> anyhow::Result<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(Mutex::new(Some(tx)));
    window.eval_with_callback(script, move |result| {
        if let Some(tx) = sender.lock().unwrap().take() {
            let _ = tx.send(result);
        }
    })?;
    let text = tokio::time::timeout(std::time::Duration::from_secs(20), rx).await??;
    anyhow::ensure!(
        text.len() <= 16 * 1024 * 1024,
        "Legacy UI storage is too large to migrate automatically; existing storage was kept"
    );
    Ok(serde_json::from_str(&text)?)
}
pub async fn migrate_storage(
    app: &tauri::AppHandle,
    target: &tauri::WebviewWindow,
    address: &str,
    id: &str,
) -> anyhow::Result<()> {
    let marker = serde_json::to_string(&format!("noctua.desktop-storage-migrated.{id}"))?;
    if evaluate(target, format!("localStorage.getItem({marker}) === '1'")).await?
        == serde_json::json!(true)
    {
        return Ok(());
    }
    let legacy_url = tauri::Url::parse(&format!("{address}/api/server"))?;
    let allowed = legacy_url.clone();
    let loaded = legacy_url.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(Mutex::new(Some(tx)));
    let legacy = tauri::WebviewWindowBuilder::new(
        app,
        format!("storage-{}", uuid::Uuid::new_v4().simple()),
        tauri::WebviewUrl::External(legacy_url),
    )
    .visible(false)
    .on_navigation(move |url| *url == allowed)
    .on_page_load(move |_window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished && *payload.url() == loaded {
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })
    .build()?;
    let result = async {
        tokio::time::timeout(std::time::Duration::from_secs(20), rx).await??;
        let value = evaluate(
            &legacy,
            format!("{STORAGE_SCRIPT}\nwindow.noctuaStorageMigration.read()"),
        )
        .await?;
        anyhow::ensure!(
            value["ok"] == true,
            "Could not read previous UI preferences/drafts; existing storage was kept"
        );
        let entries = serde_json::to_string(&value["entries"])?;
        let script =
            format!("{STORAGE_SCRIPT}\nwindow.noctuaStorageMigration.apply({entries},{marker})");
        anyhow::ensure!(
            evaluate(target, script).await? == serde_json::json!(true),
            "Could not import previous UI preferences/drafts; original storage was kept"
        );
        Ok(())
    }
    .await;
    let _ = legacy.close();
    result
}
