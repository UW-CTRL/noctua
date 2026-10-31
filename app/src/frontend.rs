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
    secret: &str,
    id: &str,
) -> anyhow::Result<()> {
    let marker = noctua::frontend::storage_marker(
        &noctua::client::config_dir()?,
        address,
        id,
        &target.url()?.origin().ascii_serialization(),
    );
    if marker.is_file() {
        return Ok(());
    }
    let response = noctua::server::http()?
        .post(format!("{address}/auth/login"))
        .header("Origin", address)
        .bearer_auth(secret)
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Could not authenticate previous UI storage; original drafts were kept"
    );
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| anyhow::anyhow!("Server did not create a migration browser session"))?;
    let (cookie_name, cookie_value) = noctua::frontend::legacy_session(cookie)?;
    let parsed = tauri::Url::parse(address)?;
    let cookie = tauri::webview::Cookie::build((cookie_name, cookie_value))
        .domain(parsed.host_str().unwrap_or_default().to_string())
        .path("/")
        .http_only(true)
        .same_site(tauri::webview::cookie::SameSite::Strict)
        .secure(parsed.scheme() == "https")
        .build();
    let legacy_url = tauri::Url::parse(&format!("{address}/api/server"))?;
    let allowed = legacy_url.clone();
    let loaded = legacy_url.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(Mutex::new(Some(tx)));
    let legacy = tauri::WebviewWindowBuilder::new(
        app,
        format!("storage-{}", uuid::Uuid::new_v4().simple()),
        tauri::WebviewUrl::App("loading.html".into()),
    )
    .visible(false)
    .on_navigation(move |url| {
        *url == allowed
            || ((url.scheme() == "tauri" && url.host_str() == Some("localhost")
                || matches!(url.scheme(), "http" | "https")
                    && url.host_str() == Some("tauri.localhost"))
                && url.path() == "/loading.html")
    })
    .on_page_load(move |_window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished && *payload.url() == loaded {
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })
    .build()?;
    let result = async {
        legacy.set_cookie(cookie)?;
        legacy.navigate(legacy_url)?;
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
            format!("{STORAGE_SCRIPT}\nwindow.noctuaStorageMigration.apply({entries},null)");
        anyhow::ensure!(
            evaluate(target, script).await? == serde_json::json!(true),
            "Could not import previous UI preferences/drafts; original storage was kept"
        );
        noctua::frontend::complete_storage_migration(&marker)?;
        Ok(())
    }
    .await;
    let _ = legacy.close();
    result
}
