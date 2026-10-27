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

use crate::{agent::Provider, paths, zotero::Zotero, ApiResult, App, Status};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    #[serde(default)]
    pub library: LibrarySettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_location: Option<String>,
    #[serde(default)]
    pub skill_projects: Vec<crate::skills::SkillProject>,
    #[serde(default)]
    pub app_icon: AppIcon,
    #[serde(default)]
    pub highlight_palette: HighlightPalette,
    #[serde(default)]
    pub highlight_colors: HighlightColors,
    #[serde(default)]
    pub assistant: AssistantSettings,
    #[serde(default)]
    pub agent: Provider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_path: Option<String>,
    /// The user chose "continue without a key" (shared, rate-limited pool).
    #[serde(default)]
    pub s2_key_skipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zotero_dir: Option<String>,
    #[serde(default)]
    pub zotero_pdf_mode: crate::zotero::PdfMode,
    /// The user said they don't use Zotero.
    #[serde(default)]
    pub zotero_disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LibrarySettings {
    #[serde(default = "enabled")]
    pub include_subfolders: bool,
}
fn enabled() -> bool { true }
impl Default for LibrarySettings {
    fn default() -> Self { Self { include_subfolders: true } }
}

pub async fn set_library(State(app): State<Arc<App>>, Json(body): Json<LibrarySettings>) -> ApiResult {
    update(&app, |s| s.library = body.clone())?;
    Ok(Json(json!({"include_subfolders": body.include_subfolders})))
}

#[derive(Debug, Serialize, Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppIcon {
    Dark,
    #[default]
    Light,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppIconBody { pub app_icon: AppIcon }

async fn apply_app_icon(app: &App, icon: AppIcon) -> Result<()> {
    if let Some(desktop) = &app.desktop {
        let (tx, rx) = tokio::sync::oneshot::channel();
        desktop.send(crate::DesktopCmd::SetAppIcon(icon, Some(tx)))
            .map_err(|_| bad("The desktop app is unavailable."))?;
        tokio::time::timeout(std::time::Duration::from_secs(5), rx).await
            .map_err(|_| bad("The desktop app did not respond. Try again."))?
            .map_err(|_| bad("The desktop app closed before applying the icon."))?
            .map_err(bad)?;
    }
    Ok(())
}

pub async fn set_app_icon(State(app): State<Arc<App>>, Json(body): Json<AppIconBody>) -> ApiResult {
    let previous = app.settings.lock().unwrap().app_icon;
    apply_app_icon(&app, body.app_icon).await?;
    if let Err(error) = update(&app, |s| s.app_icon = body.app_icon) {
        let _ = apply_app_icon(&app, previous).await;
        return Err(error.into());
    }
    Ok(Json(json!({"app_icon": body.app_icon})))
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
pub struct HighlightPalette(pub Vec<String>);
impl Default for HighlightPalette {
    fn default()->Self {Self(["#ffd400","#5fb236","#2ea8e5","#e56eee","#a28ae5","#ff6666"].map(str::to_string).to_vec())}
}
impl Settings {
    fn normalize_highlight_colors(&mut self) {
        for color in &mut self.highlight_palette.0 {*color=color.to_ascii_lowercase();}
        if self.highlight_palette.0.len()!=6||self.highlight_palette.0.iter().any(|color|!crate::library::valid_color(color))||self.highlight_palette.0.iter().collect::<std::collections::HashSet<_>>().len()!=6 {self.highlight_palette=HighlightPalette::default();}
        for (category,index) in [("novelty",5),("method",1),("results",4),("limitations",0)] {
            let color=self.highlight_colors.color(category).unwrap().to_ascii_lowercase();
            self.highlight_colors.0.insert(category.to_string(),if self.highlight_palette.0.contains(&color){color}else{self.highlight_palette.0[index].clone()});
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
pub struct HighlightColors(pub std::collections::BTreeMap<String,String>);
impl Default for HighlightColors {
    fn default()->Self {Self(crate::library::HIGHLIGHT_CATEGORIES.iter().map(|category|((*category).to_string(),crate::library::category_color(category).unwrap().to_string())).collect())}
}
impl HighlightColors {
    pub fn color(&self,category:&str)->Option<&str> {
        let fallback=crate::library::category_color(category)?;
        Some(self.0.get(category).map(String::as_str).filter(|color|crate::library::valid_color(color)).unwrap_or(fallback))
    }
}

/// Choices are independent for each CLI; old settings retain provider defaults.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct AssistantSettings {
    pub claude: AssistantOptions,
    pub codex: AssistantOptions,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantOptions {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
}

impl AssistantSettings {
    pub fn for_provider(&self, provider: Provider) -> &AssistantOptions {
        match provider { Provider::Claude => &self.claude, Provider::Codex => &self.codex }
    }
}

impl AssistantOptions {
    fn validate(&mut self, provider: Provider) -> Result<()> {
        self.model = self.model.trim().to_string();
        if self.model.len() > 200 || self.model.starts_with('-') || self.model.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(bad("Enter a model ID without spaces (up to 200 characters)."));
        }
        let levels = match provider {
            Provider::Claude => &["", "low", "medium", "high", "xhigh", "max"][..],
            Provider::Codex => &["", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"][..],
        };
        if !levels.contains(&self.reasoning.as_str()) { return Err(bad("Unsupported reasoning effort for this provider.")); }
        Ok(())
    }
}

impl Settings {
    pub fn load(data: &Path) -> Self {
        let mut settings:Self=std::fs::read_to_string(data.join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        settings.normalize_highlight_colors();
        settings
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
        "version": env!("CARGO_PKG_VERSION"),
        "agent": s.agent,
        "app_icon": s.app_icon,
        "include_subfolders": s.library.include_subfolders,
        "assistant": s.assistant,
        "highlight_colors": s.highlight_colors,
        "highlight_palette": s.highlight_palette,
        "key_source": key_source,
        "key_hint": app.s2.key_hint(),
        "skipped": s.s2_key_skipped,
        "zotero_dir": zotero_dir(&s),
        "zotero_pdf_mode": s.zotero_pdf_mode,
        "zotero_source": zotero_source,
        "zotero_disabled": s.zotero_disabled && !env_set("ZOTERO_DATA_DIR"),
        "zotero_suggested": zotero_suggestion(),
        "desktop": app.desktop.is_some(),
        "data_dir": app.data_dir,
        "storage_pending": crate::storage::pending().ok().flatten(),
        "storage_error": crate::storage::migration_error(),
        "storage_override": env_set("NOCTUA_HOME") || env_set("NOCTUA_NOTES"),
    }))
}

pub async fn set_highlight_colors(State(app):State<Arc<App>>,Json(colors):Json<std::collections::BTreeMap<String,String>>)->ApiResult {
    if colors.is_empty()||colors.len()>4 {return Err(bad("Choose at least one highlight category color").into());}
    for (category,color) in &colors {
        if crate::library::category_color(category).is_none() {return Err(bad("Unknown highlight category").into());}
        if !crate::library::valid_color(color) {return Err(bad("Use a six-digit hex color, such as #ff6666").into());}
    }
    let mut saved=app.settings.lock().unwrap();
    let mut next=saved.clone();
    let mut recolor=std::collections::BTreeMap::new();
    for (category,color) in colors {
        let color=color.to_ascii_lowercase();
        if !next.highlight_palette.0.contains(&color){return Err(bad("Choose an AI highlight color from the six-color palette").into());}
        recolor.insert(category.clone(),color.clone());next.highlight_colors.0.insert(category,color);
    }
    next.save(&app.data_dir)?;
    if let Err(error)=app.library.recolor_ai_highlights(&recolor){saved.save(&app.data_dir)?;return Err(error.into());}
    *saved=next;
    Ok(Json(json!({"highlight_colors":saved.highlight_colors,"highlight_palette":saved.highlight_palette})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HighlightPaletteBody {colors:Vec<String>}
pub async fn set_highlight_palette(State(app):State<Arc<App>>,Json(body):Json<HighlightPaletteBody>)->ApiResult {
    if body.colors.len()!=6||body.colors.iter().any(|color|!crate::library::valid_color(color)) {return Err(bad("Choose exactly six six-digit hex colors").into());}
    let colors:Vec<String>=body.colors.iter().map(|color|color.to_ascii_lowercase()).collect();
    if colors.iter().collect::<std::collections::HashSet<_>>().len()!=6 {return Err(bad("Choose six different highlight colors").into());}
    let mut saved=app.settings.lock().unwrap();let mut next=saved.clone();
    for color in next.highlight_colors.0.values_mut(){
        if let Some(index)=next.highlight_palette.0.iter().position(|old|old==color){*color=colors[index].clone();}
    }
    next.highlight_palette=HighlightPalette(colors);next.normalize_highlight_colors();
    let recolor=next.highlight_colors.0.iter().filter(|(category,color)|saved.highlight_colors.0.get(*category)!=Some(*color)).map(|(category,color)|(category.clone(),color.clone())).collect();
    next.save(&app.data_dir)?;
    if let Err(error)=app.library.recolor_ai_highlights(&recolor){saved.save(&app.data_dir)?;return Err(error.into());}
    *saved=next;
    Ok(Json(json!({"highlight_palette":saved.highlight_palette,"highlight_colors":saved.highlight_colors})))
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ZoteroPdfBody { pub pdf_mode: crate::zotero::PdfMode }

pub async fn set_zotero_pdf(State(app):State<Arc<App>>,Json(body):Json<ZoteroPdfBody>)->ApiResult {
    update(&app,|s|s.zotero_pdf_mode=body.pdf_mode)?;
    Ok(Json(json!({"zotero_pdf_mode":body.pdf_mode})))
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

#[derive(Deserialize)]
pub struct StorageBody {
    dir: Option<String>,
}

pub async fn set_storage(State(app): State<Arc<App>>, Json(b): Json<StorageBody>) -> ApiResult {
    if env_set("NOCTUA_HOME") || env_set("NOCTUA_NOTES") {
        return Err(bad("Storage is controlled by NOCTUA_HOME or NOCTUA_NOTES. Unset these variables and restart Noctua before changing it here.").into());
    }
    let destination = b.dir.map(|d| expand_home(d.trim()));
    if destination.as_ref().is_some_and(|d| d.as_os_str().is_empty()) {
        return Err(bad("Enter a folder path.").into());
    }
    let pending = crate::storage::schedule(&paths::default_data_dir(), &app.data_dir, destination.as_deref())
        .map_err(|e| bad(format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true, "storage_pending": pending })))
}

pub(crate) fn update(app: &App, f: impl FnOnce(&mut Settings)) -> Result<()> {
    let mut s = app.settings.lock().unwrap();
    let mut next = s.clone();
    f(&mut next);
    next.save(&app.data_dir)?;
    *s = next;
    Ok(())
}

#[derive(Deserialize)]
pub struct AgentBody {
    pub provider: Provider,
    pub options: Option<AssistantOptions>,
}

pub async fn set_agent(State(app): State<Arc<App>>, Json(b): Json<AgentBody>) -> ApiResult {
    let mut options = b.options;
    if let Some(o) = &mut options { o.validate(b.provider)?; }
    update(&app, |s| {
        s.agent = b.provider;
        if let Some(o) = options {
            match b.provider { Provider::Claude => s.assistant.claude = o, Provider::Codex => s.assistant.codex = o }
        }
    })?;
    Ok(Json(json!({ "ok": true, "agent": b.provider })))
}

#[cfg(test)]
mod highlight_palette_tests {
    use super::*;

    #[test]
    fn legacy_colors_and_invalid_palettes_use_supported_slots() {
        let mut settings:Settings=serde_json::from_value(json!({"highlight_colors":{"novelty":"#123abc","method":"#5FB236"},"s2_key_skipped":true})).unwrap();
        settings.normalize_highlight_colors();
        assert_eq!(settings.highlight_palette.0.len(),6);
        assert_eq!(settings.highlight_colors.color("novelty"),Some("#ff6666"));
        assert_eq!(settings.highlight_colors.color("method"),Some("#5fb236"));
        assert!(settings.s2_key_skipped);
        settings.highlight_palette=HighlightPalette(vec!["#112233".into();6]);
        settings.normalize_highlight_colors();
        assert_eq!(settings.highlight_palette.0,HighlightPalette::default().0);
        for color in settings.highlight_colors.0.values(){assert!(settings.highlight_palette.0.contains(color));}
    }
}
