//! Per-user settings (`settings.json` in the data folder) and the routes behind
//! the first-run setup and the Settings dialog: the Semantic Scholar key
//! (stored in `key.txt`, readable only by the user) and the Zotero data folder.

use std::{
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{bail, Result};
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{paths, zotero::Zotero, ApiResult, App, Status};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    /// The user chose "continue without a key" (shared, rate-limited pool).
    #[serde(default)]
    pub s2_key_skipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zotero_dir: Option<String>,
    /// The user said they don't use Zotero.
    #[serde(default)]
    pub zotero_disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_path: Option<String>,
}

impl Settings {
    pub fn load(data: &Path) -> Self {
        std::fs::read_to_string(data.join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, data: &Path) -> Result<()> {
        paths::write_private(&data.join("settings.json"), &serde_json::to_string_pretty(self)?)
    }
}

fn env_set(name: &str) -> bool {
    env::var(name).is_ok_and(|v| !v.trim().is_empty())
}

/// The S2 key: `$NOCTUA_S2_KEY`, else `key.txt` in the data folder.
pub fn load_key(data: &Path) -> Option<String> {
    env::var("NOCTUA_S2_KEY")
        .ok()
        .or_else(|| std::fs::read_to_string(data.join("key.txt")).ok())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// The Zotero data folder: `$ZOTERO_DATA_DIR`, else the one chosen in Settings.
pub fn zotero_dir(settings: &Settings) -> Option<PathBuf> {
    if let Some(d) = env::var_os("ZOTERO_DATA_DIR").filter(|d| !d.is_empty()) {
        return Some(d.into());
    }
    if settings.zotero_disabled {
        return None;
    }
    settings.zotero_dir.as_ref().map(PathBuf::from)
}

/// Zotero's default data folder, if it's there.
pub fn zotero_suggestion() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Zotero")).filter(|d| d.join("zotero.sqlite").is_file())
}

fn bad(msg: impl Into<String>) -> anyhow::Error {
    Status(StatusCode::BAD_REQUEST, msg.into()).into()
}

pub async fn get(State(app): State<Arc<App>>) -> Json<Value> {
    let s = app.settings.lock().unwrap().clone();
    let key_source = if env_set("NOCTUA_S2_KEY") {
        Some("env")
    } else if app.data_dir.join("key.txt").is_file() {
        Some("file")
    } else {
        None
    };
    let zotero_source = if env_set("ZOTERO_DATA_DIR") {
        Some("env")
    } else if s.zotero_dir.is_some() && !s.zotero_disabled {
        Some("file")
    } else {
        None
    };
    Json(json!({
        "key_source": key_source,
        "key_hint": app.s2.key_hint(),
        "skipped": s.s2_key_skipped,
        "zotero_dir": zotero_dir(&s),
        "zotero_source": zotero_source,
        "zotero_disabled": s.zotero_disabled && !env_set("ZOTERO_DATA_DIR"),
        "zotero_suggested": zotero_suggestion(),
        "desktop": app.desktop.is_some(),
        "data_dir": app.data_dir,
    }))
}

#[derive(Deserialize)]
pub struct KeyBody {
    key: String,
}

/// Tests the key against Semantic Scholar, then saves and uses it.
pub async fn set_key(State(app): State<Arc<App>>, Json(b): Json<KeyBody>) -> ApiResult {
    if env_set("NOCTUA_S2_KEY") {
        return Err(bad("NOCTUA_S2_KEY is set in the environment and takes precedence; change it there").into());
    }
    let key = b.key.trim();
    if key.is_empty() || key.len() > 200 || key.chars().any(char::is_whitespace) {
        return Err(bad("that doesn't look like an API key").into());
    }
    app.s2.test_key(key).await.map_err(|e| bad(format!("{e:#}")))?;
    paths::write_private(&app.data_dir.join("key.txt"), key)?;
    app.s2.set_key(Some(key.to_string()));
    update(&app, |s| s.s2_key_skipped = false)?;
    Ok(Json(json!({ "ok": true, "key_hint": app.s2.key_hint() })))
}

pub async fn delete_key(State(app): State<Arc<App>>) -> ApiResult {
    let _ = std::fs::remove_file(app.data_dir.join("key.txt"));
    if !env_set("NOCTUA_S2_KEY") {
        app.s2.set_key(None);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn skip_key(State(app): State<Arc<App>>) -> ApiResult {
    update(&app, |s| s.s2_key_skipped = true)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ZoteroBody {
    /// The Zotero data folder, or null for "I don't use Zotero".
    dir: Option<String>,
}

pub async fn set_zotero(State(app): State<Arc<App>>, Json(b): Json<ZoteroBody>) -> ApiResult {
    if env_set("ZOTERO_DATA_DIR") {
        return Err(bad("ZOTERO_DATA_DIR is set in the environment and takes precedence; change it there").into());
    }
    let Some(dir) = b.dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) else {
        update(&app, |s| {
            s.zotero_dir = None;
            s.zotero_disabled = true;
        })?;
        app.zotero.set_data_dir(None);
        return Ok(Json(json!({ "ok": true, "zotero_dir": null })));
    };
    let dir = expand_home(&dir);
    check_zotero_dir(&dir).map_err(|e| bad(format!("{e:#}")))?;
    let shown = dir.to_string_lossy().into_owned();
    update(&app, |s| {
        s.zotero_dir = Some(shown.clone());
        s.zotero_disabled = false;
    })?;
    app.zotero.set_data_dir(Some(dir));
    Ok(Json(json!({ "ok": true, "zotero_dir": shown })))
}

fn check_zotero_dir(dir: &Path) -> Result<()> {
    if !dir.is_dir() {
        bail!("{} isn't a folder", dir.display());
    }
    if !dir.join("zotero.sqlite").is_file() {
        bail!("no zotero.sqlite in {}; pick the folder shown in Zotero → Settings → Advanced → Files and Folders", dir.display());
    }
    Zotero::new(Some(dir.to_path_buf())).probe()
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ if p == "~" => dirs::home_dir().unwrap_or_else(|| p.into()),
        _ => PathBuf::from(p),
    }
}

fn update(app: &App, f: impl FnOnce(&mut Settings)) -> Result<()> {
    let mut s = app.settings.lock().unwrap();
    f(&mut s);
    s.save(&app.data_dir)
}
