//! Optional, server-owned Gmail Scholar alert ingestion. No Gmail write calls.
use crate::{paths, ApiResult, App};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{Query, State},
    response::Html,
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_PROMPT: &str = include_str!("prompts/scholar-default.md");
const AGENT_PROMPT: &str = include_str!("prompts/scholar-agent.md");
const SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn bad(s: &str) -> anyhow::Error {
    crate::Status(axum::http::StatusCode::BAD_REQUEST, s.into()).into()
}
fn busy() -> anyhow::Error {
    crate::Status(
        axum::http::StatusCode::CONFLICT,
        "Scholar plugin is busy. Try again shortly.".into(),
    )
    .into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    enabled: bool,
    collection: String,
    interval_minutes: u64,
    client_id: String,
    client_secret: String,
    refresh_token: String,
    account: String,
    prompts: std::collections::BTreeMap<String, String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            collection: "scholar_inbox".into(),
            interval_minutes: 15,
            client_id: String::new(),
            client_secret: String::new(),
            refresh_token: String::new(),
            account: String::new(),
            prompts: Default::default(),
        }
    }
}
struct Pending {
    state: String,
    verifier: String,
    redirect: String,
    expires: u64,
}
pub struct Scholar {
    path: PathBuf,
    config: Mutex<Config>,
    db: Mutex<Connection>,
    pending: Mutex<Option<Pending>>,
    activity: Mutex<Value>,
    gate: Arc<tokio::sync::Mutex<()>>,
    http: reqwest::Client,
    gmail_url: String,
    token_url: String,
    #[cfg(test)]
    allow_private_pdfs: bool,
}
impl Scholar {
    pub fn open(data: &Path) -> Result<Self> {
        let path = data.join("scholar-credentials.json");
        let mut config: Config = match std::fs::read_to_string(&path) {
            Ok(body) => {
                serde_json::from_str(&body).context("Cannot read Scholar plugin settings")?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(e) => return Err(e.into()),
        };
        config.interval_minutes = config.interval_minutes.clamp(15, 1440);
        let db_path = data.join("scholar-sync.sqlite");
        let db = Connection::open(&db_path)?;
        paths::restrict(&db_path);
        db.execute_batch("CREATE TABLE IF NOT EXISTS messages(account TEXT NOT NULL,id TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',PRIMARY KEY(account,id));
            CREATE TABLE IF NOT EXISTS items(account TEXT NOT NULL,message TEXT NOT NULL,candidate TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,paper TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',PRIMARY KEY(account,message,candidate));
            CREATE TABLE IF NOT EXISTS decisions(account TEXT NOT NULL,paper TEXT NOT NULL,policy TEXT NOT NULL,save INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(account,paper,policy));
            CREATE TABLE IF NOT EXISTS scholar_runs(id TEXT PRIMARY KEY,account TEXT NOT NULL,collection TEXT NOT NULL,started INTEGER NOT NULL,status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS scholar_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,run TEXT NOT NULL,account TEXT NOT NULL,collection TEXT NOT NULL,time INTEGER NOT NULL,phase TEXT NOT NULL,title TEXT NOT NULL,paper TEXT NOT NULL,detail TEXT NOT NULL,provider TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS scholar_logs_account ON scholar_logs(account,id);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
        db.execute("INSERT INTO scholar_logs(run,account,collection,time,phase,title,paper,detail,provider) SELECT id,account,collection,?1,'interrupted','','','Server stopped before this sync finished. Unfinished papers will retry.','' FROM scholar_runs WHERE status='running'",[now()])?;
        db.execute(
            "UPDATE scholar_runs SET status='interrupted' WHERE status='running'",
            [],
        )?;
        Ok(Self {
            path,
            config: Mutex::new(config),
            db: Mutex::new(db),
            pending: Mutex::new(None),
            activity: Mutex::new(Value::Null),
            gate: Arc::new(tokio::sync::Mutex::new(())),
            gmail_url: GMAIL.into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            #[cfg(test)]
            allow_private_pdfs: false,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    fn save(&self, config: Config) -> Result<()> {
        paths::write_private(&self.path, &serde_json::to_string(&config)?)?;
        *self.config.lock().unwrap() = config;
        Ok(())
    }
    fn meta(&self, key: &str) -> Result<String> {
        Ok(self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
            .optional()?
            .unwrap_or_default())
    }
    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO meta VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
    fn begin_run(&self, provider: &str) -> Result<()> {
        let c = self.config.lock().unwrap().clone();
        let id = uuid::Uuid::new_v4().to_string();
        self.db.lock().unwrap().execute(
            "INSERT INTO scholar_runs VALUES(?1,?2,?3,?4,'running')",
            params![id, c.account, c.collection, now()],
        )?;
        *self.activity.lock().unwrap() = json!({"run":id,"account":c.account,"collection":c.collection,"provider":provider,"phase":"checking","title":"","paper":"","started":now()});
        self.progress("checking", "", "", "Checking Gmail alerts")
    }
    fn progress(&self, phase: &str, title: &str, paper: &str, detail: &str) -> Result<()> {
        let mut activity = self.activity.lock().unwrap();
        if activity.is_null() {
            return Ok(());
        }
        activity["phase"] = json!(phase);
        activity["title"] = json!(title);
        activity["paper"] = json!(paper);
        let c = self.config.lock().unwrap();
        let mut detail = detail.to_string();
        for secret in [&c.refresh_token, &c.client_secret] {
            if !secret.is_empty() {
                detail = detail.replace(secret, "[redacted]");
            }
        }
        let detail = detail.chars().take(1500).collect::<String>();
        drop(c);
        self.db.lock().unwrap().execute("INSERT INTO scholar_logs(run,account,collection,time,phase,title,paper,detail,provider) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![activity["run"].as_str(),activity["account"].as_str(),activity["collection"].as_str(),now(),phase,title,paper,detail,activity["provider"].as_str()])?;
        Ok(())
    }
    fn finish_run(&self, error: Option<&str>) -> Result<()> {
        self.progress(
            if error.is_some() {
                "error"
            } else {
                "completed"
            },
            "",
            "",
            error.unwrap_or("Sync completed"),
        )?;
        let mut activity = self.activity.lock().unwrap();
        if let Some(run) = activity["run"].as_str() {
            self.db.lock().unwrap().execute(
                "UPDATE scholar_runs SET status=?1 WHERE id=?2",
                params![
                    if error.is_some() {
                        "error"
                    } else {
                        "completed"
                    },
                    run
                ],
            )?;
        }
        *activity = Value::Null;
        Ok(())
    }

    fn status(&self) -> Result<Value> {
        let c = self.config.lock().unwrap().clone();
        let (counts, items, errors) = {
            let db = self.db.lock().unwrap();
            let mut stmt =
                db.prepare("SELECT status,count(*) FROM items WHERE account=?1 GROUP BY status")?;
            let counts: Vec<(String, u64)> = stmt
                .query_map([&c.account], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let mut stmt = db.prepare("SELECT title,status,paper,error FROM items WHERE account=?1 ORDER BY rowid DESC LIMIT 30")?;
            let items: Vec<Value> = stmt.query_map([&c.account], |r| Ok(json!({"title":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"paper":r.get::<_,String>(2)?,"error":r.get::<_,String>(3)?})))?.collect::<rusqlite::Result<_>>()?;
            let mut stmt = db.prepare("SELECT id,error FROM messages WHERE account=?1 AND error<>'' ORDER BY rowid DESC LIMIT 10")?;
            let errors: Vec<Value> = stmt
                .query_map([&c.account], |r| {
                    Ok(json!({"message":r.get::<_,String>(0)?,"error":r.get::<_,String>(1)?}))
                })?
                .collect::<rusqlite::Result<_>>()?;
            (counts, items, errors)
        };
        Ok(
            json!({"enabled":c.enabled,"collection":c.collection,"interval_minutes":c.interval_minutes,"client_id":c.client_id,"has_client_secret":!c.client_secret.is_empty(),"connected":!c.refresh_token.is_empty(),"account":c.account,"running":self.gate.try_lock().is_err(),"activity":self.activity.lock().unwrap().clone(),"last_sync":self.meta("last_sync")?,"last_attempt":self.meta("last_attempt")?,"error":self.meta("error")?,"reauthorize":self.meta("reauthorize")?=="true","counts":counts.into_iter().collect::<std::collections::BTreeMap<_,_>>(),"items":items,"message_errors":errors}),
        )
    }
    async fn token(&self, form: &[(&str, &str)]) -> Result<Value> {
        let response = self
            .http
            .post(&self.token_url)
            .form(form)
            .send()
            .await
            .context("Could not reach Google sign-in")?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .context("Invalid Google sign-in response")?;
        if !status.is_success() {
            if value["error"] == "invalid_grant" {
                self.set_meta("reauthorize", "true")?;
            }
            // Never persist provider response bodies: they can contain credentials.
            bail!("Google sign-in failed ({status}). Reconnect Gmail if access expired or was revoked.");
        }
        Ok(value)
    }
    async fn refresh(&self, c: &mut Config) -> Result<(String, u64)> {
        let token = self
            .token(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &c.refresh_token),
                ("client_id", &c.client_id),
                ("client_secret", &c.client_secret),
            ])
            .await?;
        if token.get("scope").is_some() {
            validate_scope(&token)?;
        }
        let access = token["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("Google did not return an access token")?
            .to_string();
        if let Some(refresh) = token["refresh_token"].as_str().filter(|s| !s.is_empty()) {
            if refresh != c.refresh_token {
                c.refresh_token = refresh.into();
                self.save(c.clone())?;
            }
        }
        self.set_meta("reauthorize", "false")?;
        Ok((
            access,
            now()
                + token["expires_in"]
                    .as_u64()
                    .unwrap_or(3600)
                    .saturating_sub(60),
        ))
    }
    async fn gmail(&self, path: &str, token: &str, query: &[(&str, &str)]) -> Result<Value> {
        let response = self
            .http
            .get(format!("{}/{path}", self.gmail_url))
            .bearer_auth(token)
            .query(query)
            .send()
            .await
            .context("Could not reach Gmail")?;
        let status = response.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                self.set_meta("reauthorize", "true")?;
            }
            bail!("Gmail returned {status}. Check access and try again.");
        }
        Ok(response.json().await.context("Invalid Gmail response")?)
    }
    fn done(&self, account: &str, message: &str) -> Result<bool> {
        Ok(self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT done FROM messages WHERE account=?1 AND id=?2",
                params![account, message],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    fn message_result(&self, account: &str, message: &str, error: &str) -> Result<()> {
        self.db.lock().unwrap().execute("INSERT INTO messages VALUES(?1,?2,?3,?4) ON CONFLICT(account,id) DO UPDATE SET done=excluded.done,error=excluded.error",params![account,message,error.is_empty(),error])?;
        Ok(())
    }
    fn item_done(&self, account: &str, message: &str, candidate: &str) -> Result<bool> {
        Ok(self.db.lock().unwrap().query_row("SELECT status IN ('imported','duplicate','excluded') FROM items WHERE account=?1 AND message=?2 AND candidate=?3",params![account,message,candidate],|r|r.get(0)).optional()?.unwrap_or(false))
    }
    fn item_result(
        &self,
        account: &str,
        message: &str,
        candidate: &Candidate,
        status: &str,
        paper: &str,
        error: &str,
    ) -> Result<()> {
        self.db.lock().unwrap().execute("INSERT INTO items VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(account,message,candidate) DO UPDATE SET status=excluded.status,paper=excluded.paper,error=excluded.error",params![account,message,candidate.url,candidate.title,status,paper,error])?;
        Ok(())
    }
}

pub async fn get(State(app): State<Arc<App>>) -> ApiResult {
    let mut status = app.scholar.status()?;
    let folders = app.library.collections()?["targets"].clone();
    let selected = status["collection"].as_str().unwrap_or("scholar_inbox");
    if let Some(id) = destination(&app.library, selected)? {
        status["collection"] = json!(id);
    }
    let prompt = collection_prompt(
        &app.scholar.config.lock().unwrap(),
        status["collection"].as_str().unwrap_or("scholar_inbox"),
    );
    status["prompt_ready"] = json!(prompt_ready(&prompt));
    status["prompt_ready_by_collection"] = json!(app
        .scholar
        .config
        .lock()
        .unwrap()
        .prompts
        .iter()
        .map(|(id, prompt)| (id.clone(), prompt_ready(prompt)))
        .collect::<std::collections::BTreeMap<_, _>>());
    status["collections"] = folders;
    Ok(Json(status))
}
#[derive(Deserialize)]
pub struct LogQuery {
    before: Option<u64>,
    mode: Option<String>,
}
pub async fn logs(State(app): State<Arc<App>>, Query(q): Query<LogQuery>) -> ApiResult {
    let account = app.scholar.config.lock().unwrap().account.clone();
    let db = app.scholar.db.lock().unwrap();
    let mut statement=db.prepare("SELECT id,run,collection,time,phase,title,paper,detail,provider,account FROM scholar_logs WHERE (?1='' OR account=?1) AND (?2=0 OR id<?2) AND (?3='all' OR phase IN ('imported','duplicate','excluded','retry','error','completed','interrupted')) ORDER BY id DESC LIMIT 51")?;
    let mut entries:Vec<Value>=statement.query_map(params![account,q.before.unwrap_or(0),q.mode.as_deref().unwrap_or("results")],|r|Ok(json!({"id":r.get::<_,u64>(0)?,"run":r.get::<_,String>(1)?,"collection":r.get::<_,String>(2)?,"time":r.get::<_,u64>(3)?,"phase":r.get::<_,String>(4)?,"title":r.get::<_,String>(5)?,"paper":r.get::<_,String>(6)?,"detail":r.get::<_,String>(7)?,"provider":r.get::<_,String>(8)?,"account":r.get::<_,String>(9)?})))?.collect::<rusqlite::Result<_>>()?;
    let more = entries.len() > 50;
    entries.truncate(50);
    let next = if more {
        entries.last().and_then(|e| e["id"].as_u64())
    } else {
        None
    };
    drop(statement);
    drop(db);
    Ok(Json(
        json!({"entries":entries,"next_before":next,"activity":app.scholar.activity.lock().unwrap().clone()}),
    ))
}
#[derive(Deserialize)]
pub struct PromptQuery {
    collection: String,
}
fn collection_prompt(config: &Config, collection: &str) -> String {
    config
        .prompts
        .get(collection)
        .cloned()
        .unwrap_or_else(|| DEFAULT_PROMPT.into())
}
fn prompt_ready(prompt: &str) -> bool {
    !prompt.trim().is_empty() && !prompt.contains("<Research Interest>")
}
pub async fn get_prompt(State(app): State<Arc<App>>, Query(q): Query<PromptQuery>) -> ApiResult {
    let target = destination(&app.library, &q.collection)?.unwrap_or(q.collection);
    if target != "scholar_inbox" {
        app.library.folder_id(&target)?;
    }
    let prompt = collection_prompt(&app.scholar.config.lock().unwrap(), &target);
    Ok(Json(
        json!({"collection":target,"prompt":prompt,"default_prompt":DEFAULT_PROMPT,"ready":prompt_ready(&prompt)}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptBody {
    collection: String,
    prompt: String,
    previous: String,
}
pub async fn save_prompt(State(app): State<Arc<App>>, Json(body): Json<PromptBody>) -> ApiResult {
    let _guard = app.scholar.gate.try_lock().map_err(|_| busy())?;
    if body.prompt.trim().is_empty() || body.prompt.len() > 20000 {
        return Err(bad("Enter a screening prompt (up to 20,000 bytes).").into());
    }
    let target = if body.collection == "scholar_inbox" {
        app.library.scholar_collection("scholar_inbox")?
    } else {
        app.library.folder_id(&body.collection)?;
        body.collection
    };
    let mut config = app.scholar.config.lock().unwrap().clone();
    if collection_prompt(&config, &target) != body.previous {
        return Err(crate::Status(
            axum::http::StatusCode::CONFLICT,
            "This prompt changed in another window. Reopen the editor before saving.".into(),
        )
        .into());
    }
    config.prompts.insert(target.clone(), body.prompt.clone());
    app.scholar.save(config)?;
    Ok(Json(
        json!({"collection":target,"ready":prompt_ready(&body.prompt)}),
    ))
}
// Retain compatibility with destinations stored by name before folder selection.
fn destination(library: &crate::library::Library, selected: &str) -> Result<Option<String>> {
    if library.folder_id(selected).is_ok() {
        return Ok(Some(selected.into()));
    }
    Ok(library.collections()?["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|f| f["parent"] == "L1" && f["name"] == selected)
        .and_then(|f| f["id"].as_str())
        .map(String::from))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configure {
    enabled: bool,
    collection: String,
    interval_minutes: u64,
    client_id: String,
    client_secret: Option<String>,
}
pub async fn configure(State(app): State<Arc<App>>, Json(body): Json<Configure>) -> ApiResult {
    let _guard = app.scholar.gate.try_lock().map_err(|_| busy())?;
    let mut c = app.scholar.config.lock().unwrap().clone();
    let name = body.collection.trim();
    if name.is_empty()
        || name.len() > 200
        || name.chars().any(char::is_control)
        || !(15..=1440).contains(&body.interval_minutes)
    {
        return Err(bad(
            "Choose an existing folder or scholar_inbox and a polling interval (15–1440 minutes).",
        )
        .into());
    }
    let client_id = body.client_id.trim();
    if client_id.len() > 500 || client_id.chars().any(char::is_whitespace) {
        return Err(bad("Invalid Google OAuth client ID.").into());
    }
    let secret = body
        .client_secret
        .unwrap_or_else(|| c.client_secret.clone());
    if secret.len() > 1000 || secret.chars().any(char::is_control) {
        return Err(bad("Invalid Google OAuth client secret.").into());
    }
    if c.client_id != client_id || c.client_secret != secret {
        c.refresh_token.clear();
        c.account.clear();
        *app.scholar.pending.lock().unwrap() = None;
    }
    c.enabled = body.enabled;
    c.collection = if name == "scholar_inbox" {
        app.library.scholar_collection("scholar_inbox")?
    } else {
        app.library
            .folder_id(name)
            .map_err(|_| bad("This folder no longer exists. Choose another destination."))?;
        name.into()
    };
    c.interval_minutes = body.interval_minutes;
    c.client_id = client_id.into();
    c.client_secret = secret;
    app.scholar.save(c)?;
    Ok(Json(json!({"ok":true})))
}
pub async fn connect(State(app): State<Arc<App>>) -> ApiResult {
    let _guard = app.scholar.gate.try_lock().map_err(|_| busy())?;
    let c = app.scholar.config.lock().unwrap().clone();
    if c.client_id.is_empty() {
        return Err(bad("Save a Google Desktop OAuth client ID first.").into());
    }
    let state = uuid::Uuid::new_v4().simple().to_string();
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let redirect = format!("{}/api/scholar/callback", app.base_url);
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", c.client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ]);
    *app.scholar.pending.lock().unwrap() = Some(Pending {
        state,
        verifier,
        redirect,
        expires: now() + 600,
    });
    Ok(Json(json!({"url":url.as_str()})))
}
#[derive(Deserialize)]
pub struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
pub async fn callback(
    State(app): State<Arc<App>>,
    Query(q): Query<Callback>,
) -> Result<Html<&'static str>, crate::ApiError> {
    let _guard = app.scholar.gate.try_lock().map_err(|_| busy())?;
    let pending = {
        let mut pending = app.scholar.pending.lock().unwrap();
        if !pending
            .as_ref()
            .is_some_and(|p| p.expires >= now() && q.state.as_deref() == Some(p.state.as_str()))
        {
            return Err(bad("Invalid or expired sign-in. Start Connect Gmail again.").into());
        }
        pending.take().unwrap()
    };
    if q.error.is_some() {
        return Ok(Html(
            "Gmail connection was cancelled. You can close this tab.",
        ));
    }
    let code = q
        .code
        .as_deref()
        .filter(|s| !s.is_empty())
        .context("Missing authorization code")?;
    let mut c = app.scholar.config.lock().unwrap().clone();
    let token = app
        .scholar
        .token(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", &c.client_id),
            ("client_secret", &c.client_secret),
            ("redirect_uri", &pending.redirect),
            ("code_verifier", &pending.verifier),
        ])
        .await?;
    validate_scope(&token)?;
    let access = token["access_token"]
        .as_str()
        .context("Google did not return an access token")?;
    let profile = app.scholar.gmail("profile", access, &[]).await?;
    let previous_account = c.account.clone();
    c.account = profile["emailAddress"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("Google did not return an account")?
        .into();
    c.refresh_token = token["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("Google did not return offline access. Reconnect Gmail.")?
        .into();
    if c.account != previous_account {
        app.scholar.set_meta("last_sync", "")?;
        app.scholar.set_meta("last_attempt", "")?;
    }
    app.scholar.save(c)?;
    app.scholar.set_meta("reauthorize", "false")?;
    app.scholar.set_meta("error", "")?;
    // A new account must start its own scan. Per-account outcomes remain available.
    app.scholar.set_meta("page", "")?;
    Ok(Html("Gmail connected. Return to Noctua Settings to enable polling or choose Check now. You can close this tab."))
}
fn validate_scope(token: &Value) -> Result<()> {
    if !token["scope"]
        .as_str()
        .is_some_and(|s| s.split_whitespace().any(|s| s == SCOPE))
    {
        bail!("Google did not grant read-only Gmail access. Reconnect and allow Gmail access.");
    }
    Ok(())
}
pub async fn disconnect(State(app): State<Arc<App>>) -> ApiResult {
    let _guard = app.scholar.gate.try_lock().map_err(|_| busy())?;
    let mut c = app.scholar.config.lock().unwrap().clone();
    c.enabled = false;
    c.refresh_token.clear();
    c.account.clear();
    app.scholar.save(c)?;
    *app.scholar.pending.lock().unwrap() = None;
    app.scholar.set_meta("page", "")?;
    app.scholar.set_meta("reauthorize", "false")?;
    app.scholar.set_meta("error", "")?;
    Ok(Json(json!({"ok":true})))
}
pub async fn check(State(app): State<Arc<App>>) -> ApiResult {
    let config = app.scholar.config.lock().unwrap().clone();
    let target =
        destination(&app.library, &config.collection)?.unwrap_or(config.collection.clone());
    if !prompt_ready(&collection_prompt(&config, &target)) {
        return Err(bad("Edit the Scholar agent prompt and replace <Research Interest> before collecting papers.").into());
    }

    if app.scholar.config.lock().unwrap().refresh_token.is_empty() {
        return Err(bad("Connect Gmail first.").into());
    }
    let guard = app
        .scholar
        .gate
        .clone()
        .try_lock_owned()
        .map_err(|_| busy())?;
    tokio::spawn(async move {
        let _guard = guard;
        run(&app).await;
    });
    Ok(Json(json!({"ok":true})))
}
pub fn poll(app: &Arc<App>) {
    let weak = Arc::downgrade(app);
    tokio::spawn(async move {
        loop {
            let Some(app) = weak.upgrade() else { break };
            let c = app.scholar.config.lock().unwrap().clone();
            let last = app
                .scholar
                .meta("last_attempt")
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            if c.enabled
                && !c.refresh_token.is_empty()
                && now().saturating_sub(last) >= c.interval_minutes * 60
                && app.scholar.meta("reauthorize").unwrap_or_default() != "true"
            {
                if let Ok(_guard) = app.scholar.gate.try_lock() {
                    run(&app).await;
                }
            }
            drop(app);
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}
struct BackgroundRequest(Arc<crate::security::Runtime>);
impl Drop for BackgroundRequest {
    fn drop(&mut self) {
        self.0
            .requests
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
fn admit_background(app: &App) -> Result<Option<BackgroundRequest>> {
    let Some(runtime) = &app.runtime else {
        return Ok(None);
    };
    let _admission = runtime.admission.lock().unwrap();
    if runtime.draining.load(std::sync::atomic::Ordering::SeqCst) {
        bail!("Server is draining; Scholar will resume after restart");
    }
    runtime
        .requests
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(Some(BackgroundRequest(runtime.clone())))
}
async fn run(app: &App) {
    let Ok(_request) = admit_background(app) else {
        return;
    };
    let result = async {
        let provider = app.settings.lock().unwrap().agent;
        app.scholar.begin_run(provider.key())?;
        app.scholar.set_meta("last_attempt", &now().to_string())?;
        sync(app).await?;
        app.scholar.set_meta("last_sync", &now().to_string())?;
        app.scholar.set_meta("error", "")?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(e) = result {
        let _ = app.scholar.set_meta("error", &format!("{e:#}"));
        let _ = app.scholar.finish_run(Some(&e.to_string()));
    } else {
        let _ = app.scholar.finish_run(None);
    }
}
async fn sync(app: &App) -> Result<()> {
    let s = &app.scholar;
    let mut c = s.config.lock().unwrap().clone();
    let target =
        match destination(&app.library, &c.collection)? {
            Some(id) => id,
            None if c.collection == "scholar_inbox" => {
                app.library.scholar_collection("scholar_inbox")?
            }
            None => return Err(bad(
                "Destination folder no longer exists. Choose another folder in Scholar settings.",
            )),
        };
    {
        let mut activity = s.activity.lock().unwrap();
        if !activity.is_null() {
            activity["collection"] = json!(target);
        }
    }
    let prompt = collection_prompt(&c, &target);
    if !prompt_ready(&prompt) {
        bail!("Edit the Scholar agent prompt: replace <Research Interest> with your research interests before collecting papers.");
    }
    let policy = format!(
        "{:x}",
        Sha256::digest(format!("{target}\n{prompt}").as_bytes())
    );
    if s.meta("policy")? != policy {
        let mut db = s.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM messages WHERE account=?1", [&c.account])?;
        tx.execute("DELETE FROM items WHERE account=?1", [&c.account])?;
        tx.execute(
            "INSERT INTO meta VALUES('page','') ON CONFLICT(key) DO UPDATE SET value=''",
            [],
        )?;
        tx.execute("INSERT INTO meta VALUES('policy',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[&policy])?;
        tx.commit()?;
    }
    let (mut access, mut expires) = s.refresh(&mut c).await?;
    // Persist the page only after every message on it has a durable outcome.
    // Failed items are retried on the next complete scan, independent of read labels.
    let mut page = s.meta("page")?;
    loop {
        if now() >= expires {
            (access, expires) = s.refresh(&mut c).await?;
        }
        let list = s
            .gmail(
                "messages",
                &access,
                &[
                    ("q", "from:scholaralerts-noreply@google.com"),
                    ("maxResults", "100"),
                    ("pageToken", &page),
                ],
            )
            .await;
        let list = match list {
            Ok(v) => v,
            Err(e) => {
                s.set_meta("page", "")?;
                return Err(e);
            }
        };
        for message in list["messages"].as_array().into_iter().flatten() {
            let id = message["id"].as_str().context("Gmail message has no ID")?;
            if s.done(&c.account, id)? {
                continue;
            }
            if now() >= expires {
                (access, expires) = s.refresh(&mut c).await?;
            }
            s.progress("checking", "", "", "Fetching Scholar alert")?;
            let result = ingest(app, &c, &target, &prompt, &policy, &access, id).await;
            let error = result.err().map(|e| format!("{e:#}")).unwrap_or_default();
            s.message_result(&c.account, id, &error)?;
            let paper_failure = {
                let activity = s.activity.lock().unwrap();
                activity["phase"] == "retry"
                    && activity["title"].as_str().is_some_and(|t| !t.is_empty())
            };
            if !error.is_empty() && !paper_failure {
                s.progress("retry", "", "", &format!("Alert {id}: {error}"))?;
            }
        }
        page = list["nextPageToken"].as_str().unwrap_or("").to_string();
        s.set_meta("page", &page)?;
        if page.is_empty() {
            break;
        }
    }
    let failed: u64 = s.db.lock().unwrap().query_row(
        "SELECT count(*) FROM messages WHERE account=?1 AND done=0",
        [&c.account],
        |r| r.get(0),
    )?;
    if failed > 0 {
        bail!("{failed} alert(s) have unresolved papers or fetch errors. See outcomes; Check now retries them.");
    }
    Ok(())
}
async fn ingest(
    app: &App,
    c: &Config,
    target: &str,
    prompt: &str,
    policy: &str,
    token: &str,
    id: &str,
) -> Result<()> {
    let s = &app.scholar;
    let message = s
        .gmail(&format!("messages/{id}"), token, &[("format", "full")])
        .await?;
    let from = message["payload"]["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| {
            v["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case("from"))
        })
        .and_then(|v| v["value"].as_str())
        .unwrap_or("");
    if !scholar_sender(from) {
        bail!("Message sender is not Google Scholar alerts.");
    }
    let candidates = extract(&message["payload"])?;
    if candidates.is_empty() {
        bail!("No supported paper links found. Review this alert in Gmail; its format may not be supported.");
    }
    let mut failed = 0;
    for candidate in candidates {
        if s.item_done(&c.account, id, &candidate.url)? {
            continue;
        }
        s.progress(
            "verifying",
            &candidate.title,
            "",
            "Verifying paper metadata",
        )?;
        let result = async {
            let paper = verify(app, &candidate).await?;
            let (decision, bytes) = screen(app, c, prompt, policy, &paper).await?;
            if !decision.save {
                return Ok::<_, anyhow::Error>((String::new(), "excluded", decision.reason));
            }
            s.progress("saving",&candidate.title,paper["paperId"].as_str().unwrap_or(""),"Saving to destination collection")?;
            let (key, created, _) = app.library.save_report(&paper, target)?;
            if let Some(bytes) = bytes {
                app.library.attach_pdf(&key, &bytes)?;
            }
            app.scholar.db.lock().unwrap().execute("INSERT INTO decisions VALUES(?1,?2,?3,1,?4) ON CONFLICT(account,paper,policy) DO UPDATE SET save=1,reason=excluded.reason",params![c.account,paper["paperId"].as_str().unwrap(),policy,decision.reason])?;
            Ok((
                key,
                if created { "imported" } else { "duplicate" },
                decision.reason,
            ))
        }
        .await;
        match result {
            Ok((key, status, reason)) => {
                s.item_result(&c.account, id, &candidate, status, &key, &reason)?;
                s.progress(status, &candidate.title, &key, &reason)?
            }
            Err(e) => {
                failed += 1;
                s.item_result(&c.account, id, &candidate, "retry", "", &format!("{e:#}"))?;
                s.progress("retry", &candidate.title, "", &e.to_string())?;
            }
        }
    }
    if failed > 0 {
        bail!("{failed} paper(s) could not be read, screened, or saved.");
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
struct Decision {
    save: bool,
    reason: String,
}
fn validate_decision(output: &str, text: &str) -> Result<Decision> {
    let value = crate::pdf_agent::response(output)?;
    let save = value["save"]
        .as_bool()
        .context("Scholar agent must return a boolean save decision")?;
    let reason = value["reason"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 2000)
        .context("Scholar agent must explain its decision")?;
    let evidence = value["evidence"]
        .as_str()
        .context("Scholar agent must quote supporting paper text")?;
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    if evidence.chars().count() < 20
        || evidence.len() > 3000
        || !norm(text).contains(&norm(evidence))
    {
        bail!("Scholar agent evidence was not found in the paper; will retry.");
    }
    Ok(Decision {
        save,
        reason: reason.into(),
    })
}
async fn screen(
    app: &App,
    c: &Config,
    prompt: &str,
    policy: &str,
    paper: &Value,
) -> Result<(Decision, Option<Vec<u8>>)> {
    let id = paper["paperId"].as_str().context("Missing paper ID")?;
    let cached = app
        .scholar
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT save,reason FROM decisions WHERE account=?1 AND paper=?2 AND policy=?3",
            params![c.account, id, policy],
            |r| {
                Ok(Decision {
                    save: r.get(0)?,
                    reason: r.get(1)?,
                })
            },
        )
        .optional()?;
    let local = app
        .library
        .items("L1")?
        .into_iter()
        .find(|p| p["s2"] == id && p["has_pdf"] == true);
    if let Some(cached) = cached {
        if !cached.save || local.is_some() {
            app.scholar.progress(
                "cached",
                paper["title"].as_str().unwrap_or(""),
                id,
                "Reusing a completed decision for this prompt",
            )?;
            return Ok((cached, None));
        }
    }
    app.scholar.progress(
        "reading",
        paper["title"].as_str().unwrap_or(""),
        id,
        "Reading accessible PDF text",
    )?;
    let (source, bytes) = if let Some(local) = local {
        let key = local["key"].as_str().context("Library paper has no key")?;
        let path = app.library.pdf_path(key)?;
        if std::fs::metadata(&path)?.len() > 20 * 1024 * 1024 {
            bail!("Paper PDF exceeds 20 MB");
        }
        (format!("Library:{key}"), std::fs::read(path)?)
    } else {
        let source=paper["openAccessPdf"]["url"].as_str().filter(|s|!s.is_empty()).map(String::from)
            .or_else(||paper["externalIds"]["ArXiv"].as_str().map(|id|format!("https://arxiv.org/pdf/{id}")))
            .context("No accessible full-text PDF is available. This paper was not saved; a later poll will retry.")?;
        let bytes = fetch_paper(&app.scholar, &source).await?;
        (source, bytes)
    };
    let input_bytes = bytes.clone();
    let text = tokio::task::spawn_blocking(move || -> Result<String> {
        let document =
            pdf_extract::Document::load_mem(&input_bytes).context("Cannot read this PDF")?;
        if document.get_pages().len() > 400 {
            bail!("Paper exceeds the 400-page screening limit");
        }
        let text = pdf_extract::extract_text_from_mem(&input_bytes).map_err(|_| {
            anyhow::anyhow!(
                "Cannot extract paper text; encrypted or scanned PDFs require manual review"
            )
        })?;
        if text.chars().filter(|c| c.is_alphabetic()).count() < 100 {
            bail!("Paper has too little readable text; scanned PDFs require manual review");
        }
        if text.len() > 240000 {
            bail!("Paper text exceeds the automatic screening limit; review it manually");
        }
        Ok(text)
    })
    .await
    .context("Paper text extraction failed")??;
    let provider = app.settings.lock().unwrap().agent;
    let system=format!("{AGENT_PROMPT}\n\nCollection screening instructions:\n{prompt}\n\nReturn one JSON object with boolean save, string reason, and string evidence containing an exact quotation from the supplied paper text. No other output.");
    let input =
        json!({"title":paper["title"],"paper_id":id,"source":source,"text":text}).to_string();
    app.scholar.progress(
        "analyzing",
        paper["title"].as_str().unwrap_or(""),
        id,
        &format!("{} is screening this paper", provider.label()),
    )?;
    let output = crate::pdf_agent::complete(app, provider, &system, &input).await?;
    let decision = validate_decision(&output, &text)?;
    if !decision.save {
        app.scholar.db.lock().unwrap().execute("INSERT INTO decisions VALUES(?1,?2,?3,?4,?5) ON CONFLICT(account,paper,policy) DO UPDATE SET save=excluded.save,reason=excluded.reason",params![c.account,id,policy,decision.save,decision.reason])?;
    }
    Ok((decision, Some(bytes)))
}
fn public_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && !ip.is_multicast()
                && ip.octets()[0] != 0
                && ip.octets()[0] < 224
                && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
        }
        std::net::IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                public_address(ip.into())
            } else {
                !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && (ip.segments()[0] & 0xfe00) != 0xfc00
                    && (ip.segments()[0] & 0xffc0) != 0xfe80
            }
        }
    }
}
async fn fetch_paper(_s: &Scholar, source: &str) -> Result<Vec<u8>> {
    const LIMIT: usize = 20 * 1024 * 1024;
    let mut url = reqwest::Url::parse(source).context("Invalid full-text URL")?;
    for _ in 0..6 {
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            bail!("Full-text URL must be a public HTTP(S) URL without credentials");
        }
        let host = url.host_str().context("Full-text URL has no host")?;
        let addresses: Vec<_> = tokio::time::timeout(
            Duration::from_secs(15),
            tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443))),
        )
        .await
        .context("Paper host lookup timed out")??
        .collect();
        let allow_private = {
            #[cfg(test)]
            {
                _s.allow_private_pdfs
            }
            #[cfg(not(test))]
            {
                false
            }
        };
        if addresses.is_empty()
            || (!allow_private && addresses.iter().any(|a| !public_address(a.ip())))
        {
            bail!("Paper URL points to a non-public address");
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(host, &addresses)
            .build()?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .context("Could not access paper PDF")?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .context("Paper redirect has no destination")?;
            url = url.join(next)?;
            continue;
        }
        if !response.status().is_success() {
            bail!(
                "Paper PDF is not accessible ({}); will retry later",
                response.status()
            );
        }
        if response.content_length().is_some_and(|n| n > LIMIT as u64) {
            bail!("Paper PDF exceeds 20 MB");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > LIMIT {
                bail!("Paper PDF exceeds 20 MB");
            }
            bytes.extend_from_slice(&chunk);
        }
        if !bytes.starts_with(b"%PDF-") {
            bail!("Full-text link did not return a PDF; the paper was not saved");
        }
        return Ok(bytes);
    }
    bail!("Too many paper PDF redirects")
}

#[derive(Debug)]
struct Candidate {
    title: String,
    url: String,
}
fn scholar_sender(from: &str) -> bool {
    let address = from
        .rsplit_once('<')
        .map(|(_, s)| s.trim().trim_end_matches('>'))
        .unwrap_or(from)
        .trim();
    address.eq_ignore_ascii_case("scholaralerts-noreply@google.com")
}
fn normalized(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
async fn verify(app: &App, candidate: &Candidate) -> Result<Value> {
    let url = reqwest::Url::parse(&candidate.url)?;
    let host = url.host_str().unwrap_or("");
    let ident = if host == "doi.org" || host == "dx.doi.org" {
        Some(format!("DOI:{}", url.path().trim_start_matches('/')))
    } else if host == "arxiv.org" || host == "www.arxiv.org" {
        url.path()
            .strip_prefix("/abs/")
            .or_else(|| url.path().strip_prefix("/pdf/"))
            .map(|p| format!("ARXIV:{}", p.trim_end_matches(".pdf")))
    } else {
        None
    };
    let paper = if let Some(ident) = ident {
        app.s2.paper(&ident).await?
    } else {
        if normalized(&candidate.title).len() < 8 {
            bail!("No reliable title or paper identifier in this link.");
        }
        let result = app.s2.search(&candidate.title, 0).await?;
        result["data"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| normalized(p["title"].as_str().unwrap_or("")) == normalized(&candidate.title))
            .cloned()
            .context("No exact title match on Semantic Scholar; will retry later")?
    };
    if paper["paperId"].as_str().is_none_or(str::is_empty)
        || paper["title"].as_str().is_none_or(|s| s.trim().is_empty())
    {
        bail!("Semantic Scholar returned incomplete metadata.");
    }
    Ok(paper)
}

// Parse only title links in Scholar's HTML MIME parts. External pages are never fetched.
fn extract(payload: &Value) -> Result<Vec<Candidate>> {
    fn visit(part: &Value, out: &mut Vec<Candidate>, depth: usize) -> Result<()> {
        if depth > 30 {
            bail!("Alert MIME nesting is too deep.");
        }
        if part["mimeType"] == "text/html" {
            if let Some(data) = part["body"]["data"].as_str() {
                let bytes = URL_SAFE_NO_PAD
                    .decode(data.trim_end_matches('='))
                    .context("Invalid alert body encoding")?;
                if bytes.len() > 4 * 1024 * 1024 {
                    bail!("Alert body is too large.");
                }
                let html = String::from_utf8_lossy(&bytes);
                out.extend(anchors(&html));
            }
        }
        for part in part["parts"].as_array().into_iter().flatten() {
            visit(part, out, depth + 1)?;
        }
        Ok(())
    }
    let mut out = Vec::new();
    visit(payload, &mut out, 0)?;
    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c.url.clone()));
    if out.len() > 200 {
        bail!("Too many paper links in one alert.");
    }
    Ok(out)
}
fn anchors(html: &str) -> Vec<Candidate> {
    let lower = html.to_ascii_lowercase();
    let mut pos = 0;
    let mut out = Vec::new();
    while let Some(start) = lower[pos..].find("<a") {
        let start = pos + start;
        let Some(end) = lower[start..].find('>') else {
            break;
        };
        let end = start + end;
        pos = end + 1;
        if !lower
            .as_bytes()
            .get(start + 2)
            .is_some_and(u8::is_ascii_whitespace)
        {
            continue;
        }
        let Some(close) = lower[pos..].find("</a>") else {
            break;
        };
        let close = pos + close;
        let tag = &html[start..end];
        if let Some(href) = attribute(tag, "href") {
            if let Ok(link) = reqwest::Url::parse(&decode_entities(&href)) {
                let host = link.host_str().unwrap_or("");
                if host == "scholar.google.com" && link.path() == "/scholar_url" {
                    if let Some((_, url)) = link.query_pairs().find(|(k, _)| k == "url") {
                        if reqwest::Url::parse(&url)
                            .is_ok_and(|u| ["http", "https"].contains(&u.scheme()))
                        {
                            let mut title = String::new();
                            let mut tag = false;
                            for c in html[pos..close].chars() {
                                if c == '<' {
                                    tag = true;
                                } else if c == '>' {
                                    tag = false;
                                    title.push(' ');
                                } else if !tag {
                                    title.push(c);
                                }
                            }
                            let title = decode_entities(&title)
                                .split_whitespace()
                                .collect::<Vec<_>>()
                                .join(" ");
                            let title = title
                                .trim_start_matches("[PDF]")
                                .trim_start_matches("[HTML]")
                                .trim()
                                .to_string();
                            out.push(Candidate {
                                title,
                                url: url.into_owned(),
                            });
                        }
                    }
                }
            }
        }
        pos = close + 4;
    }
    out
}
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    for (i, _) in lower.match_indices(name) {
        if i == 0 || !lower.as_bytes()[i - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = tag[i + name.len()..]
            .trim_start()
            .strip_prefix('=')?
            .trim_start();
        let quote = rest.chars().next()?;
        if quote == '\'' || quote == '"' {
            return rest[1..].split(quote).next().map(String::from);
        }
        return Some(rest.split_whitespace().next()?.to_string());
    }
    None
}
fn decode_entities(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(end) = rest.find(';').filter(|end| *end < 16) {
            let entity = &rest[1..end];
            let c = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ => entity
                    .strip_prefix("#x")
                    .and_then(|s| u32::from_str_radix(s, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|s| s.parse().ok()))
                    .and_then(char::from_u32),
            };
            if let Some(c) = c {
                out.push(c);
                rest = &rest[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::StatusCode,
        routing::{get, post},
        Router,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use tower::ServiceExt;

    fn body(title: &str, url: &str) -> Value {
        json!({"mimeType":"multipart/alternative","parts":[{"mimeType":"text/html","body":{"data":URL_SAFE_NO_PAD.encode(format!("<a href=\"https://scholar.google.com/scholar_url?url={url}&amp;hl=en\">{title}</a>"))}}],"headers":[{"name":"From","value":"Google Scholar Alerts <scholaralerts-noreply@google.com>"}]})
    }
    #[test]
    fn parse_mime_entities_and_filter_navigation() -> Result<()> {
        let html="<A HREF='https://scholar.google.com/scholar_url?url=https%3A%2F%2Fdoi.org%2F10.1%2Ftest&amp;hl=en'>[PDF] A <b>paper</b> &amp; &#945;</A><a href='https://scholar.google.com/alerts'>Manage alerts</a><a href='https://scholar.google.evil/scholar_url?url=https://example.org'>Fake</a><a href='https://scholar.google.com/scholar_url?url=javascript:bad'>Bad</a>";
        let payload = json!({"mimeType":"multipart/mixed","parts":[{"mimeType":"text/plain","body":{"data":URL_SAFE_NO_PAD.encode("ignored")}}, {"mimeType":"text/html","body":{"data":URL_SAFE_NO_PAD.encode(html)}}]});
        let c = extract(&payload)?;
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].title, "A paper & α");
        assert_eq!(c[0].url, "https://doi.org/10.1/test");
        assert!(scholar_sender(
            "Google Scholar <scholaralerts-noreply@google.com>"
        ));
        assert!(!scholar_sender("scholaralerts-noreply@google.com.evil"));
        assert!(!scholar_sender(
            "scholaralerts-noreply@google.com <evil@example.com>"
        ));
        assert!(validate_scope(&json!({"scope":SCOPE})).is_ok());
        assert!(
            validate_scope(&json!({"scope":"https://www.googleapis.com/auth/gmail.metadata"}))
                .is_err()
        );
        assert!(extract(&json!({"mimeType":"text/html","body":{"data":"!!!"}})).is_err());
        Ok(())
    }
    #[test]
    fn legacy_polling_interval_has_a_fifteen_minute_minimum() -> Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::write(
            dir.path().join("scholar-credentials.json"),
            r#"{"interval_minutes":1}"#,
        )?;
        let scholar = Scholar::open(dir.path())?;
        assert_eq!(scholar.config.lock().unwrap().interval_minutes, 15);
        Ok(())
    }
    #[test]
    fn private_credentials_and_durable_per_account_outcomes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let s = Scholar::open(dir.path())?;
        let mut c = Config::default();
        c.refresh_token = "private-refresh".into();
        c.client_secret = "private-secret".into();
        c.account = "a@example.org".into();
        s.save(c)?;
        s.set_meta("page", "next-page")?;
        let candidate = Candidate {
            title: "A paper".into(),
            url: "https://doi.org/test".into(),
        };
        s.item_result(
            "a@example.org",
            "m1",
            &candidate,
            "retry",
            "",
            "Temporary failure",
        )?;
        assert!(!s.item_done("a@example.org", "m1", &candidate.url)?);
        s.item_result("a@example.org", "m1", &candidate, "imported", "p1", "")?;
        s.message_result("a@example.org", "m1", "")?;
        let serialized = s.status()?.to_string();
        assert!(!serialized.contains("private-refresh"));
        assert!(!serialized.contains("private-secret"));
        drop(s);
        let s = Scholar::open(dir.path())?;
        assert_eq!(s.meta("page")?, "next-page");
        assert!(s.done("a@example.org", "m1")?);
        assert!(!s.done("b@example.org", "m1")?);
        assert!(s.item_done("a@example.org", "m1", &candidate.url)?);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&s.path)?.permissions().mode() & 0o777,
                0o600
            );
        }
        Ok(())
    }
    struct Mock {
        fail: AtomicBool,
        invalid_grant: AtomicBool,
        requests: Mutex<Vec<String>>,
    }
    async fn mock(
        State(mock): State<Arc<Mock>>,
        req: axum::extract::Request,
    ) -> (StatusCode, Json<Value>) {
        let path = req.uri().path().to_string();
        mock.requests
            .lock()
            .unwrap()
            .push(format!("{} {}", req.method(), req.uri()));
        let value = match path.as_str() {
            "/token" => {
                if mock.invalid_grant.load(Ordering::SeqCst) {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":"invalid_grant"})),
                    );
                }
                json!({"access_token":"access","refresh_token":"refresh","scope":SCOPE})
            }
            "/profile" => json!({"emailAddress":"a@example.org"}),
            "/messages" => {
                if req.uri().query().unwrap_or("").contains("pageToken=next") {
                    json!({"messages":[{"id":"c"}]})
                } else {
                    json!({"messages":[{"id":"a"},{"id":"b"}],"nextPageToken":"next"})
                }
            }
            "/messages/a" => {
                json!({"payload":body("Verified first paper","https%3A%2F%2Fexample.org%2Fa")})
            }
            "/messages/b" => {
                if mock.fail.swap(false, Ordering::SeqCst) {
                    return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})));
                }
                json!({"payload":body("Verified second paper","https%3A%2F%2Fexample.org%2Fb")})
            }
            "/messages/c" => {
                json!({"payload":body("Verified first paper","https%3A%2F%2Fexample.org%2Fa")})
            }
            _ => return (StatusCode::NOT_FOUND, Json(json!({}))),
        };
        (StatusCode::OK, Json(value))
    }
    fn test_pdf() -> Vec<u8> {
        let text="We study neural networks for scientific discovery and develop a reliable method for screening research papers with full text evidence. Our experiments compare the proposed model to strong baselines and find useful improvements in scientific research workflows.";
        let stream = format!("BT /F1 12 Tf 50 700 Td ({text}) Tj ET");
        let objects=vec!["<< /Type /Catalog /Pages 2 0 R >>".to_string(),"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".into(),"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),format!("<< /Length {} >>\nstream\n{stream}\nendstream",stream.len())];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = vec![0];
        for (i, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", i + 1));
        }
        let xref = pdf.len();
        pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
        for offset in &offsets[1..] {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
        ));
        pdf.into_bytes()
    }
    fn fixture(data: &Path, endpoint: &str) -> Result<App> {
        let cache = Arc::new(crate::cache::Cache::open(&data.join("cache.sqlite"))?);
        for (title, id) in [
            ("Verified first paper", "first"),
            ("Verified second paper", "second"),
        ] {
            cache.put(
                &format!("search:0:{title}"),
                &json!({"data":[{"paperId":id,"title":title,"authors":[{"name":"Author"}],"openAccessPdf":{"url":format!("{endpoint}/paper.pdf")}}]}),
            );
        }
        let mut scholar = Scholar::open(data)?;
        scholar.allow_private_pdfs = true;
        scholar.gmail_url = endpoint.into();
        scholar.token_url = format!("{endpoint}/token");
        let mut settings = crate::settings::Settings::default();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in ["claude", "codex"] {
                let path = data.join(name);
                std::fs::write(&path, include_str!("../tests/fake_agent.py"))?;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }
            settings.claude_path = Some(data.join("claude").to_string_lossy().into_owned());
            settings.codex_path = Some(data.join("codex").to_string_lossy().into_owned());
        }
        Ok(App {
            scholar,
            search_providers: crate::search_providers::SearchProviders::new(cache.clone()),
            s2: crate::s2::S2::new(None, cache),
            zotero: crate::zotero::Zotero::new(None),
            library: crate::library::Library::open(data.join("library"))?,
            actions: tokio::sync::broadcast::channel(32).0,
            base_url: "http://127.0.0.1:7878".into(),
            chat_dir: data.join("chat"),
            history: crate::history::History::open(&data.join("history.sqlite"))?,
            projects: crate::project::Projects::open(&data.join("projects.sqlite"))?,
            notes: crate::notes::Notes::new(data.join("notes")),
            data_dir: data.into(),
            shared_skills_dir: None,
            _storage_lease: None,
            runtime: None,
            chat_cancels: Mutex::new(Default::default()),
            settings: Mutex::new(settings),
            desktop: None,
            login_gate: tokio::sync::Mutex::new(()),
            chat_jobs: Mutex::new(Default::default()),
        })
    }
    #[tokio::test]
    async fn sync_pages_retry_and_restart_without_duplicate_papers() -> Result<()> {
        let mock_state = Arc::new(Mock {
            fail: AtomicBool::new(true),
            invalid_grant: AtomicBool::new(false),
            requests: Mutex::new(Vec::new()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let router = Router::new()
            .route("/token", post(mock))
            .route("/profile", get(mock))
            .route("/messages", get(mock))
            .route("/messages/{id}", get(mock))
            .route("/paper.pdf", get(|| async { test_pdf() }))
            .with_state(mock_state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let dir = tempfile::tempdir()?;
        let app = fixture(dir.path(), &endpoint)?;
        let mut c = Config::default();
        c.account = "a@example.org".into();
        c.refresh_token = "refresh".into();
        let target = app.library.scholar_collection("scholar_inbox")?;
        c.prompts.insert(target,"Research interests: neural networks for scientific discovery. Save relevant papers only.".into());
        app.scholar.save(c)?;
        run(&app).await;
        assert_eq!(app.library.items("L1")?.len(), 1);
        assert!(!app.scholar.meta("error")?.is_empty());
        assert!(!app.scholar.done("a@example.org", "b")?);
        assert!(app.scholar.done("a@example.org", "c")?);
        // Model a process stop after a page was persisted, then reopen everything.
        app.scholar.set_meta("page", "next")?;
        drop(app);
        let app = fixture(dir.path(), &endpoint)?;
        assert_eq!(app.scholar.meta("page")?, "next");
        run(&app).await; // Finishes the saved page; retry b on the next complete scan.
        run(&app).await;
        assert_eq!(app.library.items("L1")?.len(), 2);
        assert!(app.scholar.done("a@example.org", "b")?);
        assert_eq!(app.scholar.status()?["counts"]["imported"], 2);
        assert_eq!(app.scholar.status()?["counts"]["duplicate"], 1);
        assert_eq!(app.scholar.meta("error")?, "");
        assert!(!app.scholar.meta("last_sync")?.is_empty());
        let requests = mock_state.requests.lock().unwrap().clone();
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.starts_with("GET /messages/a?"))
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.starts_with("GET /messages/b?"))
                .count(),
            2
        );
        assert!(requests
            .iter()
            .all(|r| r.starts_with("GET ") || r == "POST /token"));
        let target = app.library.scholar_collection("scholar_inbox")?;
        assert_eq!(app.library.items(&target)?.len(), 2);
        assert_eq!(app.library.scholar_collection("scholar_inbox")?, target);
        std::fs::write(dir.path().join("scholar-exclude"), "")?;
        let mut changed = app.scholar.config.lock().unwrap().clone();
        changed.prompts.insert(
            target.clone(),
            "Research interests: unrelated biology topics. Exclude unrelated work.".into(),
        );
        app.scholar.save(changed)?;
        run(&app).await;
        assert_eq!(app.scholar.status()?["counts"]["excluded"], 3);
        let phases: Vec<String> = {
            let db = app.scholar.db.lock().unwrap();
            let mut stmt = db.prepare("SELECT DISTINCT phase FROM scholar_logs")?;
            let rows = stmt
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        for phase in [
            "reading",
            "analyzing",
            "saving",
            "imported",
            "excluded",
            "completed",
        ] {
            assert!(phases.iter().any(|p| p == phase), "missing phase {phase}");
        }

        assert_eq!(app.library.items("L1")?.len(), 2);
        std::fs::remove_file(dir.path().join("scholar-exclude"))?;
        mock_state.invalid_grant.store(true, Ordering::SeqCst);
        run(&app).await;
        assert_eq!(app.scholar.meta("reauthorize")?, "true");
        assert!(app.scholar.meta("error")?.contains("Google sign-in failed"));
        mock_state.invalid_grant.store(false, Ordering::SeqCst);
        let mut c = app.scholar.config.lock().unwrap().clone();
        c.client_id = "client".into();
        app.scholar.save(c)?;
        let app = Arc::new(app);
        let Json(login) = connect(State(app.clone())).await.map_err(|e| e.0)?;
        let login = reqwest::Url::parse(login["url"].as_str().unwrap())?;
        let state = login
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let _ = callback(
            State(app.clone()),
            Query(Callback {
                state: Some(state),
                code: Some("code".into()),
                error: None,
            }),
        )
        .await
        .map_err(|e| e.0)?;
        assert_eq!(app.scholar.meta("reauthorize")?, "false");
        assert_eq!(app.scholar.config.lock().unwrap().account, "a@example.org");
        let _ = disconnect(State(app.clone())).await.map_err(|e| e.0)?;
        assert!(app.scholar.config.lock().unwrap().refresh_token.is_empty());
        assert_eq!(app.library.items("L1")?.len(), 2);
        server.abort();
        Ok(())
    }
    #[tokio::test]
    async fn destination_uses_folder_ids_and_creates_inbox_only_when_saved() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let app = Arc::new(fixture(dir.path(), "http://127.0.0.1:1")?);
        let parent = app.library.create_collection("L1", "Research")?;
        let nested = app.library.create_collection(&parent, "Reading")?;
        let Json(status) = super::get(State(app.clone())).await.map_err(|e| e.0)?;
        assert_eq!(status["collections"].as_array().unwrap().len(), 3);
        assert_eq!(status["collection"], "scholar_inbox");
        let save = |collection: String| Configure {
            enabled: false,
            collection,
            interval_minutes: 15,
            client_id: String::new(),
            client_secret: None,
        };
        let _ = configure(State(app.clone()), Json(save(nested.clone())))
            .await
            .map_err(|e| e.0)?;
        app.library.rename(&nested, "Renamed")?;
        assert_eq!(
            destination(&app.library, &app.scholar.config.lock().unwrap().collection)?,
            Some(nested)
        );
        assert_eq!(
            app.library.collections()?["targets"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert!(configure(State(app.clone()), Json(save("missing".into())))
            .await
            .is_err());
        let _ = configure(State(app.clone()), Json(save("scholar_inbox".into())))
            .await
            .map_err(|e| e.0)?;
        let inbox = app.scholar.config.lock().unwrap().collection.clone();
        assert_ne!(inbox, "scholar_inbox");
        assert_eq!(
            app.library.collections()?["targets"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        let _ = configure(State(app.clone()), Json(save("scholar_inbox".into())))
            .await
            .map_err(|e| e.0)?;
        assert_eq!(app.scholar.config.lock().unwrap().collection, inbox);
        assert_eq!(
            app.library.collections()?["targets"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        Ok(())
    }
    #[tokio::test]
    async fn activity_log_is_compact_paginated_private_and_recovers_interruptions() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let app = Arc::new(fixture(dir.path(), "http://127.0.0.1:1")?);
        let mut config = app.scholar.config.lock().unwrap().clone();
        config.account = "one@example.org".into();
        config.refresh_token = "secret-refresh".into();
        config.client_secret = "secret-client".into();
        app.scholar.save(config)?;
        app.scholar.begin_run("codex")?;
        app.scholar
            .progress("reading", "Paper A", "s2-a", "Reading PDF")?;
        app.scholar
            .progress("analyzing", "Paper A", "s2-a", "Screening paper")?;
        assert_eq!(app.scholar.status()?["activity"]["phase"], "analyzing");
        for i in 0..55 {
            app.scholar.progress(
                "excluded",
                &format!("Paper {i}"),
                "",
                "Not relevant. secret-refresh secret-client",
            )?;
        }
        let Json(page) = logs(
            State(app.clone()),
            Query(LogQuery {
                before: None,
                mode: None,
            }),
        )
        .await
        .map_err(|e| e.0)?;
        assert_eq!(page["entries"].as_array().unwrap().len(), 50);
        assert!(!page.to_string().contains("secret-refresh"));
        assert!(!page.to_string().contains("secret-client"));
        assert!(page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["phase"] == "excluded"));
        let Json(older) = logs(
            State(app.clone()),
            Query(LogQuery {
                before: page["next_before"].as_u64(),
                mode: None,
            }),
        )
        .await
        .map_err(|e| e.0)?;
        assert_eq!(older["entries"].as_array().unwrap().len(), 5);
        let ids = page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].clone())
            .collect::<Vec<_>>();
        assert!(older["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| !ids.contains(&e["id"])));
        drop(app);
        let app = Arc::new(fixture(dir.path(), "http://127.0.0.1:1")?);
        assert!(app.scholar.status()?["activity"].is_null());
        let Json(restarted) = logs(
            State(app.clone()),
            Query(LogQuery {
                before: None,
                mode: Some("all".into()),
            }),
        )
        .await
        .map_err(|e| e.0)?;
        assert_eq!(restarted["entries"][0]["phase"], "interrupted");
        app.scholar.begin_run("claude")?;
        app.scholar.finish_run(None)?;
        assert!(app.scholar.status()?["activity"].is_null());
        let mut config = app.scholar.config.lock().unwrap().clone();
        config.account = "other@example.org".into();
        app.scholar.save(config)?;
        let Json(other) = logs(
            State(app.clone()),
            Query(LogQuery {
                before: None,
                mode: None,
            }),
        )
        .await
        .map_err(|e| e.0)?;
        assert!(other["entries"].as_array().unwrap().is_empty());
        Ok(())
    }
    #[tokio::test]
    async fn oauth_callback_is_nonce_protected_and_background_jobs_block_server_stop() -> Result<()>
    {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir()?;
        let mut app = fixture(dir.path(), "http://127.0.0.1:1")?;
        let owner = crate::server::Owner::acquire(dir.path(), "http://127.0.0.1:7878")?;
        let runtime = Arc::new(crate::security::Runtime::new(
            owner,
            vec!["127.0.0.1:7878".into()],
            vec!["http://127.0.0.1:7878".into()],
        ));
        app.runtime = Some(runtime.clone());
        let app = Arc::new(app);
        let router = crate::router(app.clone(), Arc::new(vec!["127.0.0.1:7878".into()]));
        async fn request(router: &Router, method: &str, path: &str) -> StatusCode {
            router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .header("host", "127.0.0.1:7878")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
                .status()
        }
        assert_eq!(
            request(&router, "GET", "/api/scholar").await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&router, "GET", "/api/scholar/callback?state=wrong&code=x").await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(&router, "POST", "/api/scholar/callback").await,
            StatusCode::UNAUTHORIZED
        );
        let lease = admit_background(&app)?;
        assert_eq!(runtime.requests.load(Ordering::SeqCst), 1);
        assert!(crate::server_stop(State(app.clone())).await.is_err());
        drop(lease);
        assert_eq!(runtime.requests.load(Ordering::SeqCst), 0);
        runtime.draining.store(true, Ordering::SeqCst);
        assert!(admit_background(&app).is_err());
        Ok(())
    }
    #[test]
    fn grounded_decisions_and_public_download_addresses() {
        let text =
            "A long quotation proving relevance to neural networks and scientific discovery.";
        assert!(
            validate_decision(
                &json!({"save":true,"reason":"Relevant","evidence":text}).to_string(),
                text
            )
            .unwrap()
            .save
        );
        assert!(validate_decision(
            &json!({"save":"yes","reason":"Relevant","evidence":text}).to_string(),
            text
        )
        .is_err());
        assert!(validate_decision(&json!({"save":true,"reason":"Relevant","evidence":"Completely fabricated supporting evidence."}).to_string(),text).is_err());
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
        ] {
            assert!(!public_address(address.parse().unwrap()));
        }
        assert!(public_address("8.8.8.8".parse().unwrap()));
        assert!(!prompt_ready(DEFAULT_PROMPT));
        assert!(prompt_ready("Neural networks for scientific discovery"));
    }
    #[tokio::test]
    async fn prompts_are_collection_scoped_persistent_and_conflict_checked() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let app = Arc::new(fixture(dir.path(), "http://127.0.0.1:1")?);
        let folder = app.library.create_collection("L1", "Research")?;
        let body = PromptBody {
            collection: folder.clone(),
            prompt: "Research interests: neural networks".into(),
            previous: DEFAULT_PROMPT.into(),
        };
        let _ = save_prompt(State(app.clone()), Json(body))
            .await
            .map_err(|e| e.0)?;
        let Json(result) = get_prompt(
            State(app.clone()),
            Query(PromptQuery {
                collection: folder.clone(),
            }),
        )
        .await
        .map_err(|e| e.0)?;
        assert_eq!(result["ready"], true);
        let Json(root) = get_prompt(
            State(app.clone()),
            Query(PromptQuery {
                collection: "L1".into(),
            }),
        )
        .await
        .map_err(|e| e.0)?;
        assert_eq!(root["ready"], false);
        assert!(save_prompt(
            State(app.clone()),
            Json(PromptBody {
                collection: folder.clone(),
                prompt: "stale".into(),
                previous: DEFAULT_PROMPT.into()
            })
        )
        .await
        .is_err());
        assert!(Scholar::open(dir.path())?
            .config
            .lock()
            .unwrap()
            .prompts
            .contains_key(&folder));
        Ok(())
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn scholar_reads_pdf_and_excludes_or_retries_without_saving() -> Result<()> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/paper.pdf", get(|| async { test_pdf() })),
            )
            .await
            .unwrap();
        });
        let dir = tempfile::tempdir()?;
        let app = fixture(dir.path(), &endpoint)?;
        let mut c = Config::default();
        c.account = "test".into();
        let paper = json!({"paperId":"screen","title":"Research paper","openAccessPdf":{"url":format!("{endpoint}/paper.pdf")}});
        std::fs::write(dir.path().join("scholar-exclude"), "")?;
        let (decision, bytes) =
            screen(&app, &c, "Neural network papers only", "policy-a", &paper).await?;
        assert!(!decision.save);
        assert!(bytes.is_some());
        assert!(app.library.items("L1")?.is_empty());
        assert!(
            std::fs::read_to_string(dir.path().join("scholar-input.json"))?
                .contains("scientific discovery")
        );
        std::fs::remove_file(dir.path().join("scholar-exclude"))?;
        // A changed prompt has a new decision, rather than reusing an exclusion.
        let (decision, _) =
            screen(&app, &c, "Neural network papers only", "policy-b", &paper).await?;
        assert!(decision.save);
        app.settings.lock().unwrap().agent = crate::agent::Provider::Codex;
        let (codex, _) = screen(
            &app,
            &c,
            "Neural network papers only",
            "policy-codex",
            &paper,
        )
        .await?;
        assert!(codex.save);
        std::fs::write(dir.path().join("scholar-invalid"), "")?;
        assert!(
            screen(&app, &c, "Neural network papers only", "policy-c", &paper)
                .await
                .is_err()
        );
        let mut inaccessible = paper.clone();
        inaccessible["openAccessPdf"] = Value::Null;
        assert!(screen(
            &app,
            &c,
            "Neural network papers only",
            "policy-d",
            &inaccessible
        )
        .await
        .is_err());
        assert!(app.library.items("L1")?.is_empty());
        server.abort();
        Ok(())
    }
    #[tokio::test]
    async fn verification_rejects_fuzzy_titles_and_accepts_resolved_identifiers() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let app = fixture(dir.path(), "http://127.0.0.1:1")?;
        app.s2.cache().put(
            "search:0:A different research paper",
            &json!({"data":[{"paperId":"wrong","title":"A slightly different research paper"}]}),
        );
        let candidate = Candidate {
            title: "A different research paper".into(),
            url: "https://example.org/paper".into(),
        };
        assert!(verify(&app, &candidate).await.is_err());
        assert!(app.library.items("L1")?.is_empty());
        app.s2.cache().put(
            "paper:DOI:10.123/test",
            &json!({"paperId":"resolved","title":"Verified DOI metadata"}),
        );
        let candidate = Candidate {
            title: "".into(),
            url: "https://doi.org/10.123/test".into(),
        };
        assert_eq!(verify(&app, &candidate).await?["paperId"], "resolved");
        let candidate = Candidate {
            title: "".into(),
            url: "https://example.org/unknown".into(),
        };
        assert!(verify(&app, &candidate).await.is_err());
        Ok(())
    }
    #[tokio::test]
    async fn oauth_state_pkce_settings_and_busy_routes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let app = Arc::new(fixture(dir.path(), "http://127.0.0.1:1")?);
        let router = crate::router(app.clone(), Arc::new(vec!["127.0.0.1:7878".into()]));
        async fn request(
            router: &Router,
            method: &str,
            path: &str,
            body: Value,
        ) -> axum::response::Response {
            router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .header("host", "127.0.0.1:7878")
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        }
        assert_eq!(
            request(
                &router,
                "POST",
                "/api/scholar",
                json!({"enabled":true,"collection":"x","interval_minutes":0,"client_id":"id"})
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(request(&router,"POST","/api/scholar",json!({"enabled":true,"collection":"L1","interval_minutes":15,"client_id":"id","client_secret":"secret"})).await.status(),StatusCode::OK);
        for minutes in [1, 14, 1441] {
            assert_eq!(request(&router,"POST","/api/scholar",json!({"enabled":true,"collection":"L1","interval_minutes":minutes,"client_id":"id"})).await.status(),StatusCode::BAD_REQUEST);
            assert_eq!(app.scholar.config.lock().unwrap().interval_minutes, 15);
        }

        let response = request(&router, "POST", "/api/scholar/connect", json!({})).await;
        let data: Value =
            serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1 << 20).await?)?;
        let url = reqwest::Url::parse(data["url"].as_str().unwrap())?;
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["scope"], SCOPE);
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(
            query["redirect_uri"],
            "http://127.0.0.1:7878/api/scholar/callback"
        );
        assert!(!data.to_string().contains("secret"));
        assert_eq!(
            request(
                &router,
                "GET",
                "/api/scholar/callback?state=wrong&error=access_denied",
                Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert!(app.scholar.pending.lock().unwrap().is_some());
        let denied = format!(
            "/api/scholar/callback?state={}&error=access_denied",
            query["state"]
        );
        assert_eq!(
            request(&router, "GET", &denied, Value::Null).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            request(&router, "GET", &denied, Value::Null).await.status(),
            StatusCode::BAD_REQUEST
        );
        let _guard = app.scholar.gate.lock().await;
        assert_eq!(
            request(&router, "DELETE", "/api/scholar", Value::Null)
                .await
                .status(),
            StatusCode::CONFLICT
        );
        drop(_guard);
        assert_eq!(
            request(&router, "DELETE", "/api/scholar", Value::Null)
                .await
                .status(),
            StatusCode::OK
        );
        assert!(!app.scholar.config.lock().unwrap().enabled);
        Ok(())
    }
}
