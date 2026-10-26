//! CLI backends. Credentials stay in each CLI's own credential store.
use std::{process::Stdio, sync::Arc, time::Duration};
use anyhow::{Context, Result};
use axum::{body::Body, extract::{Path, State}, http::header, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{io::{AsyncReadExt, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines}, process::{ChildStdin, ChildStdout, Command}, sync::mpsc};
use tokio_stream::{wrappers::ReceiverStream, StreamExt};
use crate::{ApiResult, App};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider { #[default] Claude, Codex }

impl Provider {
    pub fn key(self) -> &'static str { match self { Self::Claude => "claude", Self::Codex => "codex" } }
    pub fn label(self) -> &'static str { match self { Self::Claude => "Claude Code", Self::Codex => "Codex" } }
    pub fn command(self, app: &App) -> Command {
        let settings = app.settings.lock().unwrap();
        crate::paths::cli_command(self.key(), match self {
            Self::Claude => settings.claude_path.as_deref(), Self::Codex => settings.codex_path.as_deref(),
        })
    }
    /// Apply only to inference commands, never login or status probes.
    pub fn configure(self, app: &App, cmd: &mut Command) {
        let settings = app.settings.lock().unwrap();
        let options = settings.assistant.for_provider(self);
        if !options.model.is_empty() { cmd.arg("--model").arg(&options.model); }
        match self {
            Self::Claude => {
                if !options.reasoning.is_empty() { cmd.arg("--effort").arg(&options.reasoning); }
                cmd.arg("--settings").arg(json!({"fastMode": options.fast}).to_string());
            }
            Self::Codex => {
                if !options.reasoning.is_empty() {
                    cmd.arg("-c").arg(format!("model_reasoning_effort={}", json!(options.reasoning)));
                }
                cmd.arg("-c").arg(format!("service_tier={}", json!(if options.fast { "fast" } else { "default" })));
            }
        }
    }
    pub fn missing(self) -> String {
        format!("Could not start {}. Install the {} CLI, or set {}_path in settings.json (or NOCTUA_{}), then sign in from Settings → Research assistant.", self.label(), self.key(), self.key(), self.key().to_uppercase())
    }
}

pub async fn status(State(app): State<Arc<App>>, Path(provider): Path<Provider>) -> Json<Value> {
    let mut cmd = provider.command(&app);
    match provider { Provider::Claude => { cmd.args(["auth", "status", "--json"]); }, Provider::Codex => { cmd.args(["login", "status"]); } }
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    let value = match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(out)) => json!({ "installed": true, "signed_in": out.status.success() }),
        Ok(Err(_)) => json!({ "installed": false, "signed_in": false, "message": provider.missing() }),
        Err(_) => json!({ "installed": true, "signed_in": false, "message": "Checking sign-in timed out. Try again." }),
    };
    Json(value)
}

#[derive(Serialize)]
struct ModelChoice {
    id: String,
    label: String,
    reasoning_efforts: Vec<String>,
    is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_fast: Option<bool>,
}

/// Ask the installed CLI; never read credentials or infer model names from a screenshot.
pub async fn models(State(app): State<Arc<App>>, Path(provider): Path<Provider>) -> ApiResult {
    if provider == Provider::Claude {
        return Ok(Json(json!({ "models": claude_models(&app).await? })));
    }
    let mut cmd = provider.command(&app);
    let mut child = cmd.args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true)
        .spawn().with_context(|| provider.missing())?;
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        rpc(&mut stdin, &mut lines, 1, "initialize", json!({
            "clientInfo": { "name": "noctua", "title": "Noctua", "version": env!("CARGO_PKG_VERSION") }
        })).await?;
        stdin.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n").await?;
        let mut models = Vec::new();
        let mut cursor = None::<String>;
        let mut cursors = std::collections::HashSet::new();
        let mut ids = std::collections::HashSet::new();
        for page in 0..100 {
            let response = rpc(&mut stdin, &mut lines, page + 2, "model/list", json!({
                "limit": 100, "includeHidden": false, "cursor": cursor,
            })).await?;
            let entries = response["data"].as_array().context("Codex returned an invalid model catalog")?;
            for entry in entries {
                if entry["hidden"].as_bool() == Some(true) { continue; }
                let id = entry["model"].as_str().filter(|id| !id.is_empty()).context("Codex returned a model without an ID")?;
                if !ids.insert(id.to_string()) { continue; }
                let efforts = entry["supportedReasoningEfforts"].as_array().map(|efforts| efforts.iter()
                    .filter_map(|effort| effort["reasoningEffort"].as_str().map(str::to_string)).collect()).unwrap_or_default();
                models.push(ModelChoice { id: id.into(), label: id.into(), reasoning_efforts: efforts,
                    is_default: entry["isDefault"].as_bool().unwrap_or(false), supports_fast: None });
            }
            cursor = response["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
            if cursor.is_none() { return Ok::<_, anyhow::Error>(models); }
            if !cursors.insert(cursor.clone()) { anyhow::bail!("Codex returned a repeated model-list cursor"); }
        }
        anyhow::bail!("Codex returned too many model-list pages")
    }).await;
    // A discovery process must not remain running after success, errors, or a timeout.
    let _ = child.kill().await;
    let _ = child.wait().await;
    let models = result.context("Loading Codex models timed out. Try Check connection again.")??;
    Ok(Json(json!({ "models": models })))
}

async fn claude_models(app: &App) -> Result<Vec<ModelChoice>> {
    let mut cmd = Provider::Claude.command(app);
    let mut child = cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--settings", "{\"disableAllHooks\":true}"])
        .current_dir(&app.data_dir)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true)
        .spawn().with_context(|| Provider::Claude.missing())?;
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        // Only initialize the SDK control protocol. No user message or inference turn is sent.
        let request = json!({ "type": "control_request", "request_id": "noctua-models",
            "request": { "subtype": "initialize", "hooks": {} } });
        stdin.write_all(format!("{request}\n").as_bytes()).await?;
        stdin.flush().await?;
        while let Some(line) = lines.next_line().await? {
            let message: Value = serde_json::from_str(&line).context("Claude returned an invalid discovery response")?;
            let response = &message["response"];
            if message["type"] != "control_response" || response["request_id"] != "noctua-models" { continue; }
            if response["subtype"] == "error" {
                anyhow::bail!("Claude model discovery: {}", response["error"].as_str().unwrap_or("request failed"));
            }
            let entries = response["response"]["models"].as_array().context("Claude returned an invalid model catalog")?;
            let mut models = Vec::new();
            let mut ids = std::collections::HashSet::new();
            for entry in entries {
                let id = entry["value"].as_str().filter(|id| !id.is_empty()).context("Claude returned a model without an ID")?;
                if !ids.insert(id.to_string()) { continue; }
                let efforts = entry["supportedEffortLevels"].as_array().map(|efforts| efforts.iter()
                    .filter_map(|effort| effort.as_str().map(str::to_string)).collect()).unwrap_or_default();
                models.push(ModelChoice { id: id.into(), label: entry["displayName"].as_str().unwrap_or(id).into(),
                    reasoning_efforts: efforts, is_default: id == "default",
                    supports_fast: Some(entry["supportsFastMode"].as_bool().unwrap_or(false)) });
            }
            return Ok::<_, anyhow::Error>(models);
        }
        anyhow::bail!("Claude model discovery stopped. Check your CLI installation and sign-in.")
    }).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    result.context("Loading Claude models timed out. Try Check connection again.")?
}

async fn rpc(stdin: &mut ChildStdin, lines: &mut Lines<BufReader<ChildStdout>>, id: u64, method: &str, params: Value) -> Result<Value> {
    let request = json!({ "id": id, "method": method, "params": params });
    stdin.write_all(format!("{request}\n").as_bytes()).await?;
    stdin.flush().await?;
    while let Some(line) = lines.next_line().await? {
        let message: Value = serde_json::from_str(&line).context("Codex returned an invalid discovery response")?;
        if message["id"].as_u64() != Some(id) { continue; }
        if let Some(error) = message.get("error") {
            anyhow::bail!("Codex model discovery: {}", error["message"].as_str().unwrap_or("request failed"));
        }
        return message.get("result").cloned().context("Codex returned an empty discovery response");
    }
    anyhow::bail!("Codex model discovery stopped. Check your CLI installation and sign-in.")
}

/// Starts the CLI's own browser login; streams instructions/URLs without
/// reading or copying credential files. Disconnecting cancels the login.
pub async fn login(State(app): State<Arc<App>>, Path(provider): Path<Provider>) -> impl IntoResponse {
    let (tx, rx) = mpsc::channel::<Value>(64);
    tokio::spawn(async move {
        let Ok(_gate) = app.login_gate.try_lock() else {
            let _ = tx.send(json!({ "type": "error", "message": "A sign-in is already in progress. Finish or cancel it first." })).await;
            return;
        };
        let result: Result<()> = async {
            let mut cmd = provider.command(&app);
            match provider { Provider::Claude => { cmd.args(["auth", "login"]); }, Provider::Codex => { cmd.arg("login"); } }
            let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true)
                .spawn().with_context(|| provider.missing())?;
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let (mut out_open, mut err_open) = (true, true);
            let (mut out, mut err) = ([0u8; 4096], [0u8; 4096]);
            let deadline = tokio::time::sleep(Duration::from_secs(600));
            tokio::pin!(deadline);
            while out_open || err_open {
                let bytes = tokio::select! {
                    _ = tx.closed() => return Ok(()),
                    _ = &mut deadline => anyhow::bail!("Sign-in timed out. Please try again."),
                    n = stdout.read(&mut out), if out_open => { let n=n?; out_open=n>0; out[..n].to_vec() },
                    n = stderr.read(&mut err), if err_open => { let n=n?; err_open=n>0; err[..n].to_vec() },
                };
                if !bytes.is_empty() { let _ = tx.send(json!({ "type": "text", "text": String::from_utf8_lossy(&bytes) })).await; }
            }
            let exit = child.wait().await?;
            if !exit.success() { anyhow::bail!("{} sign-in failed. Try again, or run `{} {}` in a terminal.", provider.label(), provider.key(), if provider == Provider::Codex { "login" } else { "auth login" }); }
            let _ = tx.send(json!({ "type": "done" })).await;
            Ok(())
        }.await;
        if let Err(e) = result { let _ = tx.send(json!({ "type": "error", "message": format!("{e:#}") })).await; }
    });
    ([(header::CONTENT_TYPE, "application/x-ndjson")], Body::from_stream(ReceiverStream::new(rx).map(|v| Ok::<_, std::convert::Infallible>(format!("{v}\n")))))
}

/// Keep user-configured MCP servers out of Noctua, while sharing the CLI's
/// login. Noctua's MCP tools are the route for all research and note changes.
pub fn codex_command(app: &App, mcp_url: Option<&str>, instructions: &str) -> Command {
    let mut cmd = Provider::Codex.command(app);
    cmd.args(["exec", "--json", "--skip-git-repo-check", "--ignore-user-config"])
        .args(["-c", "approval_policy=\"never\"", "-c", "sandbox_mode=\"read-only\""])
        .args(["-c", "features.shell_tool=false", "-c", "web_search=\"disabled\""])
        .args(["-c", "project_doc_max_bytes=0"])
        .arg("-c").arg(format!("developer_instructions={}", json!(instructions)));
    Provider::Codex.configure(app, &mut cmd);
    if let Some(url) = mcp_url {
        cmd.arg("-c").arg(format!("mcp_servers.noctua.url={}", json!(url)))
            .args(["-c", "mcp_servers.noctua.required=true", "-c", "mcp_servers.noctua.tool_timeout_sec=600"])
            .args(["-c", "mcp_servers.noctua.default_tools_approval_mode=\"approve\""]);
    }
    cmd
}

/// Runs a prepared one-shot CLI command (no session, no tools), writes `input`
/// to stdin and returns the final reply text. `what` names the task in errors.
pub async fn one_shot(app: &App, provider: Provider, mut cmd: Command, input: &str, what: &str) -> Result<String> {
    std::fs::create_dir_all(&app.chat_dir)?;
    let mut child = cmd.current_dir(&app.chat_dir)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true)
        .spawn().with_context(|| provider.missing())?;
    let stderr = drain_stderr(child.stderr.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(input.as_bytes()).await?;
    drop(stdin);
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut text = String::new();
    let mut error = None;
    let mut finished = false;
    let read = async {
        while let Some(line) = lines.next_line().await? {
            if provider == Provider::Codex {
                for ev in crate::chat::translate_codex(&line, &mut finished) {
                    if ev["type"] == "text" { text.push_str(ev["text"].as_str().unwrap_or("")); }
                    if ev["type"] == "error" { error = Some(ev["message"].as_str().unwrap_or("request failed").to_string()); }
                }
            } else if let Ok(e) = serde_json::from_str::<Value>(&line) {
                if e["type"] == "result" {
                    finished = true;
                    text = e["result"].as_str().unwrap_or("").to_string();
                    if e["is_error"].as_bool().unwrap_or(false) { error = Some(text.clone()); }
                }
            }
        }
        anyhow::Ok(())
    };
    tokio::time::timeout(Duration::from_secs(300), read).await.with_context(|| format!("{} timed out trying to {what}", provider.label()))??;
    let status = child.wait().await?;
    let err = stderr.await.unwrap_or_default();
    if let Some(e) = error { anyhow::bail!("{} could not {what}: {e}", provider.label()); }
    if !status.success() || !finished || text.trim().is_empty() {
        anyhow::bail!("{} could not {what} ({status}): {}", provider.label(), err.trim());
    }
    Ok(text.trim().to_string())
}

/// A text-only one-shot question to the selected backend.
pub async fn ask_text(app: &App, provider: Provider, prompt: &str, what: &str) -> Result<String> {
    let cmd = if provider == Provider::Codex {
        let mut c = codex_command(app, None, include_str!("prompts/text-task.md"));
        c.args(["--ephemeral", "-"]);
        c
    } else {
        let mut c = provider.command(app);
        c.args(["-p", "--output-format", "stream-json", "--verbose"])
            .args(["--tools", "", "--strict-mcp-config", "--no-session-persistence"]);
        c
    };
    one_shot(app, provider, cmd, prompt, what).await
}

/// Drain stderr concurrently, so a noisy child cannot deadlock on its pipe.
pub fn drain_stderr(stderr: tokio::process::ChildStderr) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            tail.push_str(&line); tail.push('\n');
            if tail.len() > 16000 { let at = tail.char_indices().nth(8000).map(|(i,_)|i).unwrap_or(0); tail.drain(..at); }
        }
        tail
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{cache::Cache, history::History, notes::Notes, project::Projects, s2::S2, settings::Settings, zotero::Zotero};
    use axum::{body::to_bytes, http::{Request, StatusCode}, Router};
    use std::path::PathBuf;
    use tower::ServiceExt;

    struct Fixture { root: PathBuf, router: Router, app: Arc<App> }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
    impl Fixture {
        fn new() -> Result<Self> {
            Self::with_desktop(None)
        }
        fn with_desktop(desktop: Option<tokio::sync::mpsc::UnboundedSender<crate::DesktopCmd>>) -> Result<Self> {
            use std::os::unix::fs::PermissionsExt;
            let root = std::env::temp_dir().join(format!("noctua-cli-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root)?;
            for name in ["claude", "codex"] {
                let file = root.join(name);
                std::fs::write(&file, include_str!("../tests/fake_agent.py"))?;
                std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700))?;
            }
            let settings = Settings { claude_path: Some(root.join("claude").to_string_lossy().into_owned()), codex_path: Some(root.join("codex").to_string_lossy().into_owned()), s2_key_skipped: true, zotero_disabled: true, ..Default::default() };
            let app = Arc::new(App {
                s2: S2::new(None, Arc::new(Cache::open(&root.join("cache.sqlite"))?)),
                zotero: Zotero::new(None), library: crate::library::Library::open(root.join("library"))?, actions: tokio::sync::broadcast::channel(32).0,
                base_url: "http://127.0.0.1:7878".into(), chat_dir: root.join("chat"),
                history: History::open(&root.join("history.sqlite"))?, projects: Projects::open(&root.join("projects.sqlite"))?,
                notes: Notes::new(root.join("notes")), data_dir: root.clone(), _storage_lease: None, settings: std::sync::Mutex::new(settings),
                desktop, login_gate: tokio::sync::Mutex::new(()), chat_jobs: std::sync::Mutex::new(Default::default()),
            });
            let router = crate::router(app.clone(), Arc::new(vec!["127.0.0.1:7878".into()]));
            Ok(Self { root, router, app })
        }
        async fn request(&self, path: &str, body: Option<Value>, method: Option<&str>) -> axum::response::Response {
            let req = Request::builder().uri(path).header("host", "127.0.0.1:7878").header("content-type", "application/json")
                .method(method.unwrap_or(if body.is_some() { "POST" } else { "GET" }))
                .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default())).unwrap();
            self.router.clone().oneshot(req).await.unwrap()
        }
        async fn json(&self, path: &str, body: Option<Value>) -> Value {
            let r = self.request(path, body, None).await;
            assert_eq!(r.status(), StatusCode::OK, "{path}");
            serde_json::from_slice(&to_bytes(r.into_body(), 1 << 20).await.unwrap()).unwrap()
        }
        async fn events(&self, path: &str, body: Value) -> Vec<Value> {
            let r = self.request(path, Some(body), None).await;
            assert_eq!(r.status(), StatusCode::OK, "{path}");
            let bytes = to_bytes(r.into_body(), 1 << 20).await.unwrap();
            std::str::from_utf8(&bytes).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
        }
        async fn settled(&self, id: &str, provider: &str) -> Value {
            for _ in 0..100 {
                let c = self.json(&format!("/api/chats/{id}?provider={provider}"), None).await;
                if c["busy"] == false { return c; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            panic!("CLI did not stop and save its turn");
        }
    }

    #[tokio::test]
    async fn app_icon_preferences_persist_and_reject_unknown_choices() -> Result<()> {
        let f = Fixture::new()?;
        assert_eq!(f.json("/api/settings", None).await["app_icon"], "light");
        assert_eq!(f.json("/api/settings/app-icon", Some(json!({"app_icon":"dark"}))).await["app_icon"], "dark");
        let saved = Settings::load(&f.root);
        assert_eq!(saved.app_icon, crate::AppIcon::Dark);
        assert!(saved.s2_key_skipped && saved.zotero_disabled && saved.claude_path.is_some());
        assert_eq!(f.request("/api/settings/app-icon", Some(json!({"app_icon":"arbitrary"})), None).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(f.json("/api/settings", None).await["app_icon"], "dark");
        for variant in ["dark", "light"] {
            let icon = f.request(&format!("/app-icons/{variant}.svg"), None, None).await;
            assert_eq!(icon.status(), StatusCode::OK);
            assert_eq!(icon.headers()["content-type"], "image/svg+xml");
        }
        Ok(())
    }

    #[tokio::test]
    async fn subfolder_scope_defaults_persists_deduplicates_and_preserves_graph_cache() -> Result<()> {
        let f = Fixture::new()?;
        assert!(Settings::default().library.include_subfolders);
        let legacy: Settings = serde_json::from_value(json!({"library":{}}))?;
        assert!(legacy.library.include_subfolders);
        assert_eq!(f.json("/api/settings", None).await["include_subfolders"], true);
        let parent = f.app.library.create_collection("L1", "Parent")?;
        let child = f.app.library.create_collection(&parent, "Child")?;
        let grandchild = f.app.library.create_collection(&child, "Grandchild")?;
        let sibling = f.app.library.create_collection("L1", "Unrelated")?;
        let shared = json!({"paperId":"cached-a","title":"Shared parent and child paper"});
        f.app.library.save(&shared, &parent)?;
        f.app.library.save(&shared, &child)?;
        f.app.library.save(&json!({"paperId":"cached-b","title":"Child paper"}), &child)?;
        f.app.library.save(&json!({"paperId":"cached-c","title":"Grandchild paper"}), &grandchild)?;
        f.app.library.save(&json!({"paperId":"cached-d","title":"Unrelated paper"}), &sibling)?;
        let mut entries = serde_json::Map::new();
        for item in f.app.library.items_scoped(&parent, true)? {
            let value = |key: &str| item[key].as_str().unwrap_or("").trim().to_string();
            entries.insert(value("key"), json!({
                "ident": format!("{}|{}|{}|{}",value("s2"),value("arxiv"),value("DOI"),value("title")),
                "paper":{"paperId":value("s2"),"title":value("title"),"citationCount":0}, "refs":[]
            }));
        }
        rusqlite::Connection::open(f.root.join("projects.sqlite"))?.execute(
            "INSERT INTO projects (target,data,updated) VALUES (?1,?2,1)",
            rusqlite::params![parent,json!({"entries":entries,"ext":{}}).to_string()],
        )?;
        for (include, count) in [(true,3),(false,1),(true,3)] {
            let saved = f.json("/api/settings/library", Some(json!({"include_subfolders":include}))).await;
            assert_eq!(saved["include_subfolders"], include);
            assert_eq!(Settings::load(&f.root).library.include_subfolders, include);
            assert_eq!(f.json(&format!("/api/library/items?target={parent}"), None).await.as_array().unwrap().len(), count);
            let folders = f.json("/api/library/collections", None).await;
            assert_eq!(folders["targets"].as_array().unwrap().iter().find(|t|t["id"]==parent).unwrap()["count"], count);
            let graph = f.json(&format!("/api/project?target={parent}"), None).await;
            assert_eq!(graph["papers"].as_array().unwrap().len(), count);
            assert_eq!(graph["include_subfolders"], include);
            assert_eq!(graph["fetched"], 0, "scope changes must reuse existing lookups");
        }
        f.json("/api/settings/library", Some(json!({"include_subfolders":false}))).await;
        assert_eq!(f.json("/api/library/items?target=L1",None).await.as_array().unwrap().len(),4);
        assert_eq!(f.request("/api/settings/library",Some(json!({"include_subfolders":"no"})),None).await.status(),StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!Settings::load(&f.root).library.include_subfolders);
        Ok(())
    }

    #[tokio::test]
    async fn inspect_workspace_reads_logs_in_all_modes_and_rejects_escape() -> Result<()> {
        let f=Fixture::new()?;
        let root=crate::workspace::dir(&f.app,"L1")?.join(".workspace");
        assert_eq!(crate::workspace::inspect_internal(&f.app,"L1",&json!({}))?["exists"],false);
        std::fs::create_dir_all(root.join("paper/out"))?;
        let log=format!("{}\n! Undefined control sequence.\n", "a".repeat(70_000));
        std::fs::write(root.join("paper/build.log"),&log)?;
        std::fs::write(root.join("paper/out/.noctua-paper.log"),"Compiler details")?;
        std::fs::write(root.join("paper/output.pdf"),b"%PDF-1.7")?;
        for mode in ["plan","suggest","direct"] {
            let endpoint=format!("/mcp?mode={mode}");
            let listed=f.json(&endpoint,Some(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))).await;
            assert!(listed["result"]["tools"].as_array().unwrap().iter().any(|t|t["name"]=="inspect_workspace"));
            let result=f.json(&endpoint,Some(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"inspect_workspace","arguments":{"folder_id":"L1","path":"paper/build.log","tail":true}}}))).await;
            assert_ne!(result["result"]["isError"],true,"{result}");
            let content:Value=serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap())?;
            assert!(content["text"].as_str().unwrap().ends_with("! Undefined control sequence.\n"));
            assert_eq!(content["truncated"],true);assert_eq!(content["text"].as_str().unwrap().len(),65536);
        }
        let first=crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":"paper/build.log"}))?;
        assert_eq!(first["next_offset"],65536);
        let next=crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":"paper/build.log","offset":first["next_offset"]}))?;
        assert_eq!(format!("{}{}",first["text"].as_str().unwrap(),next["text"].as_str().unwrap()),log);
        assert_eq!(crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":".workspace/paper/out/.noctua-paper.log"}))?["text"],"Compiler details");
        assert_eq!(crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":"paper/output.pdf"}))?["binary"],true);
        for path in ["../settings.json","paper/../../outside","/etc/passwd","C:\\secret","paper/missing.log"] {
            assert!(crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":path})).is_err(),"{path}");
        }
        std::os::unix::fs::symlink(&f.root,root.join("escape"))?;
        assert!(crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":"escape"})).is_err());
        for n in 0..205 {std::fs::write(root.join("paper/out").join(format!("{n:03}.aux")),"aux")?;}
        let list=crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":"paper/out"}))?;
        assert_eq!(list["entries"].as_array().unwrap().len(),200);assert_eq!(list["next_offset"],200);
        let rest=crate::workspace::inspect_internal(&f.app,"L1",&json!({"path":"paper/out","offset":200}))?;
        assert_eq!(rest["entries"].as_array().unwrap().len(),6);
        assert_eq!(std::fs::read_to_string(root.join("paper/build.log"))?,log);
        Ok(())
    }

    #[tokio::test]
    async fn project_files_bibliographies_and_history() -> Result<()> {
        let f=Fixture::new()?;
        let note=f.app.notes.create("L1","A: note")?;
        f.app.notes.create("L1","Another note")?;
        let m=f.json("/api/workspaces/L1",None).await;
        assert_eq!(m["entries"].as_array().unwrap().len(),2);
        let m=f.json("/api/workspaces/L1",Some(json!({"revision":m["revision"],"op":"create","name":"references.bib","text":"@article{Lovelace1843,title={Notes on the Engine},author={Lovelace, Ada},year=1843}"}))).await;
        let id=m["entries"].as_array().unwrap().last().unwrap()["id"].clone();
        let m=f.json("/api/workspaces/L1",Some(json!({"revision":m["revision"],"op":"config","bibliographies":[id]}))).await;
        assert_eq!(m["bib_index"][0]["key"],"Lovelace1843");
        let m=f.json("/api/workspaces/L1",Some(json!({"revision":m["revision"],"op":"edit","id":id,"text":"@article{broken"}))).await;
        assert!(m["bib_error"].is_string());assert_eq!(m["bib_index"][0]["key"],"Lovelace1843");
        let restored=f.json("/api/workspaces/L1/history",Some(json!({"revision":m["revision"],"redo":false}))).await;
        assert!(restored["bib_error"].is_null());
        let stale=f.request("/api/workspaces/L1",Some(json!({"revision":m["revision"],"op":"rename","id":id,"name":"stale.bib"})),None).await;
        assert_eq!(stale.status(),StatusCode::CONFLICT);
        let bad=f.request("/api/workspaces/L1",Some(json!({"revision":restored["revision"],"op":"create","name":"../outside","text":"bad"})),None).await;
        assert!(!bad.status().is_success());
        let search=f.json("/api/workspaces/L1/bibliography-search",None).await;
        assert_eq!(search["entries"][0]["file_name"],"references.bib");
        let extra=f.json("/api/workspaces/L1",Some(json!({"revision":restored["revision"],"op":"create","name":"also.bib","text":"@article{Lovelace1843,title={A separate source}}"}))).await;
        let extra_id=extra["entries"].as_array().unwrap().last().unwrap()["id"].clone();
        let both=f.json("/api/workspaces/L1",Some(json!({"revision":extra["revision"],"op":"config","bibliographies":[id,extra_id]}))).await;
        assert_eq!(both["bib_index"].as_array().unwrap().len(),2,"separate bibliography sources must remain searchable");
        assert!(both["bib_error"].is_null());
        let search=f.json("/api/workspaces/L1/bibliography-search",None).await;
        assert_eq!(search["entries"].as_array().unwrap().len(),2);
        let broken=f.json("/api/workspaces/L1",Some(json!({"revision":both["revision"],"op":"edit","id":extra_id,"text":"@article{broken"}))).await;
        assert!(broken["bib_error"].is_string());
        let search=f.json("/api/workspaces/L1/bibliography-search",None).await;
        assert_eq!(search["entries"].as_array().unwrap().len(),1);
        assert_eq!(search["errors"].as_array().unwrap().len(),1,"one invalid bib must not hide valid citations");
        let nid=note["id"].as_str().unwrap();let mut changed=note.clone();changed["title"]=json!("Renamed");
        let mut second=changed.clone();second["blocks"]=json!([]);
        second["_history"]=json!([{"doc":changed,"label":"Rename"},{"doc":crate::editing::content(second.clone()),"label":"Delete block"}]);
        let revision=f.app.notes.save("L1",nid,second)?;
        let undo=f.app.notes.history("L1",nid,Some(false),Some(revision))?;
        assert_eq!(undo["doc"]["blocks"],note["blocks"]);assert_eq!(undo["doc"]["title"],"Renamed");
        assert!(f.app.notes.history("L1",nid,Some(false),Some(revision)).is_err());
        let undo2=f.app.notes.history("L1",nid,Some(false),undo["doc"]["updated"].as_u64())?;
        assert_eq!(undo2["doc"]["title"],note["title"]);
        let redo=f.app.notes.history("L1",nid,Some(true),undo2["doc"]["updated"].as_u64())?;
        assert_eq!(redo["doc"]["title"],"Renamed");
        Ok(())
    }

    #[tokio::test]
    async fn app_icon_native_failure_keeps_the_previous_saved_preference() -> Result<()> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let f = Fixture::with_desktop(Some(tx))?;
        let native = tokio::spawn(async move {
            for (expected, result) in [(crate::AppIcon::Light, Ok(())), (crate::AppIcon::Dark, Err("Native icon unavailable".to_string()))] {
                let Some(crate::DesktopCmd::SetAppIcon(icon, Some(reply))) = rx.recv().await else { panic!("Expected app icon request") };
                assert_eq!(icon, expected);
                let _ = reply.send(result);
            }
        });
        f.json("/api/settings/app-icon", Some(json!({"app_icon":"light"}))).await;
        let response = f.request("/api/settings/app-icon", Some(json!({"app_icon":"dark"})), None).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(Settings::load(&f.root).app_icon, crate::AppIcon::Light);
        assert_eq!(f.json("/api/settings", None).await["app_icon"], "light");
        native.await?;
        Ok(())
    }

    #[tokio::test]
    async fn file_histories_are_independent() -> Result<()> {
        let f=Fixture::new()?;let mut m=f.json("/api/workspaces/L1",None).await;
        let mut ids=Vec::new();for name in ["a.txt","b.txt"]{m=f.json("/api/workspaces/L1",Some(json!({"op":"create","name":name,"text":"original","revision":m["revision"]}))).await;ids.push(m["entries"].as_array().unwrap().last().unwrap()["id"].as_str().unwrap().to_owned());}
        for id in &ids{m=f.json("/api/workspaces/L1",Some(json!({"op":"edit","id":id,"text":"changed","revision":m["revision"]}))).await;}
        let url=format!("/api/workspaces/L1/files/{}/history",ids[0]);
        m=f.json(&url,Some(json!({"revision":m["revision"],"redo":false}))).await;
        assert_eq!(crate::workspace::read(&f.app,"L1",&ids[0])?["text"],"original");
        assert_eq!(crate::workspace::read(&f.app,"L1",&ids[1])?["text"],"changed");
        f.json(&url,Some(json!({"revision":m["revision"],"redo":true}))).await;
        assert_eq!(crate::workspace::read(&f.app,"L1",&ids[0])?["text"],"changed");Ok(())
    }

    #[tokio::test]
    async fn annotation_undo_restores_ids_and_protects_revisions() -> Result<()> {
        let f=Fixture::new()?;let key=f.app.library.upload("L1","history.pdf",b"%PDF-1.7 history fixture")?;
        let a=f.app.library.annotate(&key,&json!({"kind":"comment","page":1,"comment":"before"}),"user",false)?;
        let id=a["id"].as_str().unwrap();
        let updated=f.app.library.update_annotation(&key,id,&json!({"revision":a["revision"],"comment":"after"}))?;
        assert_eq!(updated["comment_author"],"user");
        f.app.library.delete_annotation(&key,id,updated["revision"].as_i64().unwrap())?;
        f.app.library.annotation_history(&key,Some(&json!({"redo":false,"expected":[]})))?;
        let list=f.app.library.annotations(&key)?;assert_eq!(list[0]["id"],id);assert_eq!(list[0]["comment"],"after");assert!(list[0]["revision"].as_i64().unwrap()>updated["revision"].as_i64().unwrap());
        assert!(f.app.library.update_annotation(&key,id,&json!({"revision":updated["revision"],"comment":"stale"})).is_err());
        f.app.library.annotation_history(&key,Some(&json!({"redo":false,"expected":list})))?;
        let list=f.app.library.annotations(&key)?;assert_eq!(list[0]["comment"],"before");
        assert!(f.app.library.annotation_history(&key,Some(&json!({"redo":true,"expected":[]}))).is_err());
        f.app.library.annotation_history(&key,Some(&json!({"redo":true,"expected":list})))?;
        assert_eq!(f.app.library.annotations(&key)?[0]["comment"],"after");Ok(())
    }

    #[tokio::test]
    async fn skill_zip_import_and_stale_run_are_safe() -> Result<()> {
        use std::io::Write;
        let f=Fixture::new()?;
        let archive=|name:&str|->Result<Vec<u8>> {let mut zip=zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));zip.start_file(name,zip::write::SimpleFileOptions::default())?;zip.write_all(b"# ZIP skill")?;Ok(zip.finish()?.into_inner())};
        let upload=|data:Vec<u8>|Request::builder().uri("/api/skills/import-zip").method("POST").header("host","127.0.0.1:7878").body(Body::from(data)).unwrap();
        let r=f.router.clone().oneshot(upload(archive("skill/SKILL.md")?)).await?;assert_eq!(r.status(),StatusCode::OK);
        let imported:Value=serde_json::from_slice(&to_bytes(r.into_body(),4096).await?)?;
        assert!(crate::skills::read(&f.app,imported["id"].as_str().unwrap(),"SKILL.md")?["text"].as_str().unwrap().contains("ZIP skill"));
        let r=f.router.clone().oneshot(upload(archive("../SKILL.md")?)).await?;assert!(!r.status().is_success());
        use base64::Engine;let b64=|s:&str|base64::engine::general_purpose::STANDARD.encode(s);
        let imported=f.json("/api/skills",Some(json!({"files":[{"path":"SKILL.md","data":b64("# Stale")},{"path":"run.sh","data":b64("printf 'should not run' > output.txt")}]}))).await;
        let id=imported["id"].as_str().unwrap();crate::skills::set_context(&f.app,"chat",Some("L1"),Some(&vec![id.into()]))?;
        let run=crate::skills::request(&f.app,Some("chat"),&json!({"folder_id":"L1","skill_id":id,"script":"run.sh","args":[],"files":[]}))?;
        std::fs::write(f.root.join("skills").join(id).join("run.sh"),"echo changed")?;
        let url=format!("/api/skill-runs/{}",run["id"].as_str().unwrap());f.json(&url,Some(json!({"action":"approve"}))).await;
        let mut result=Value::Null;for _ in 0..100 {result=f.json(&url,None).await;if result["status"]!="running"{break;}tokio::time::sleep(Duration::from_millis(10)).await;}
        assert_eq!(result["status"],"failed");assert!(result["error"].as_str().unwrap().contains("Skill contents changed"));
        assert!(f.json("/api/workspaces/L1",None).await["entries"].as_array().unwrap().is_empty());Ok(())
    }

    #[tokio::test]
    async fn file_edit_approval_is_scoped_to_file_and_prompt() -> Result<()> {
        let f=Fixture::new()?;
        let target=f.app.library.create_collection("L1","Approval test")?;
        let manifest=crate::workspace::list(&f.app,&target)?;
        let turn=crate::chat_approval::Turn::begin(&f.app,"chat-a");
        let mut events=f.app.actions.subscribe();
        let args=json!({"folder_id":target,"revision":manifest["revision"],"op":"create","name":"main.tex","text":"First"});
        let app=f.app.clone();let id=turn.0.clone();let first=args.clone();
        let pending=tokio::spawn(async move {crate::chat_approval::authorize(&app,&id,Some("chat-a"),&first).await});
        let event=events.recv().await?;
        assert_eq!(event["action"],"file_edit_approval");
        assert_eq!(event["changes"][0]["after"],"First");
        assert!(!pending.is_finished());
        assert!(crate::workspace::list(&f.app,&target)?["entries"].as_array().unwrap().is_empty());
        let app=f.app.clone();let id=turn.0.clone();let parallel_args=args.clone();
        let parallel=tokio::spawn(async move {crate::chat_approval::authorize(&app,&id,Some("chat-a"),&parallel_args).await});
        assert_eq!(events.recv().await?["changes"].as_array().unwrap().len(),2);
        let approval=event["approval_id"].clone();
        let url=format!("/api/chat-edit-approvals/{}",turn.0);
        let wrong=f.request(&url,Some(json!({"chat_id":"chat-b","approval_id":approval,"approve":true})),None).await;
        assert!(!wrong.status().is_success());
        f.json(&url,Some(json!({"chat_id":"chat-a","approval_id":approval,"approve":true}))).await;
        pending.await??;parallel.await??;
        // Once granted, later calls in this turn need no further UI event.
        crate::chat_approval::authorize(&f.app,&turn.0,Some("chat-a"),&args).await?;
        assert!(events.try_recv().is_err());
        let result=f.json(&format!("/mcp?mode=suggest&chat_id=chat-a&turn_id={}",turn.0),Some(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"edit_project_file","arguments":args}}))).await;
        assert_ne!(result["result"]["isError"],true);
        let applied:Value=serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap())?;
        assert!(crate::workspace::change(&f.app,&target,&args,None).is_err(),"Approval never bypasses revision checks");
        assert_eq!(events.recv().await?["action"],"workspace_changed");
        assert_eq!(applied["status"],"applied","Inline approval must persist the edit before returning");
        assert_eq!(applied["entries"].as_array().unwrap().len(),1,"Approved edits return only changed entries");
        let file=applied["entries"].as_array().unwrap().iter().find(|e|e["name"]=="main.tex").unwrap();
        assert!(file.get("blob").is_none(),"Approval binding must work with the bounded MCP result");
        let edit=json!({"folder_id":target,"revision":applied["revision"],"op":"edit","id":file["id"],"text":"Second"});
        crate::chat_approval::authorize(&f.app,&turn.0,Some("chat-a"),&edit).await?;
        assert!(events.try_recv().is_err(),"Creating then editing the same file must not ask twice");
        let mut different=args.clone();different["revision"]=applied["revision"].clone();different["name"]=json!("other.tex");
        let app=f.app.clone();let id=turn.0.clone();let other=different.clone();
        let pending=tokio::spawn(async move {crate::chat_approval::authorize(&app,&id,Some("chat-a"),&other).await});
        let other_event=events.recv().await?;
        assert_ne!(other_event["approval_id"],approval,"Different files require distinct permission");
        f.json(&url,Some(json!({"chat_id":"chat-a","approval_id":other_event["approval_id"],"approve":false}))).await;
        assert!(pending.await?.is_err());
        assert!(crate::chat_approval::authorize(&f.app,&turn.0,Some("chat-a"),&different).await.is_err());
        crate::chat_approval::authorize(&f.app,&turn.0,Some("chat-a"),&edit).await?;
        let planned=f.json(&format!("/mcp?mode=plan&chat_id=chat-a&turn_id={}",turn.0),Some(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"edit_project_file","arguments":args}}))).await;
        assert_eq!(planned["result"]["isError"],true,"Permission cannot override Plan mode");
        let expired=turn.0.clone();drop(turn);
        assert!(crate::chat_approval::authorize(&f.app,&expired,Some("chat-a"),&args).await.is_err());
        let next=crate::chat_approval::Turn::begin(&f.app,"chat-a");
        let next_args=edit.clone();
        let app=f.app.clone();let id=next.0.clone();
        let pending=tokio::spawn(async move {crate::chat_approval::authorize(&app,&id,Some("chat-a"),&next_args).await});
        let event=events.recv().await?;assert_eq!(event["turn_id"],next.0);assert!(!pending.is_finished());
        f.json(&format!("/api/chat-edit-approvals/{}",next.0),Some(json!({"chat_id":"chat-a","approval_id":event["approval_id"],"approve":false}))).await;
        assert!(pending.await?.is_err());
        assert!(crate::chat_approval::authorize(&f.app,&next.0,Some("chat-a"),&edit).await.is_err());
        let direct=f.json(&format!("/mcp?mode=direct&chat_id=chat-a&turn_id={}",next.0),Some(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"edit_project_file","arguments":edit}}))).await;
        assert_ne!(direct["result"]["isError"],true,"Direct edits require no approval, even after a Suggest denial");
        assert_eq!(events.recv().await?["action"],"workspace_changed");
        assert!(events.try_recv().is_err(),"Direct mode emits no approval request");
        Ok(())
    }

    #[tokio::test]
    async fn skill_execution_requires_approval_and_output_review() -> Result<()> {
        use base64::Engine;
        let f=Fixture::new()?;let b64=|s:&str|base64::engine::general_purpose::STANDARD.encode(s);
        let imported=f.json("/api/skills",Some(json!({"files":[{"path":"demo/SKILL.md","data":b64("# Demo\nWrite an output file.")},{"path":"demo/scripts/run.sh","data":b64("printf 'review me' > result.txt\nprintf 'done'\n")}]}))).await;
        let id=imported["id"].as_str().unwrap();let m=f.json("/api/workspaces/L1",None).await;
        f.json("/api/workspaces/L1",Some(json!({"revision":m["revision"],"op":"config","skills":[id]}))).await;
        crate::skills::set_context(&f.app,"chat",Some("L1"),None)?;
        assert!(crate::skills::enabled(&f.app,Some("different"),id).is_err());
        let run=crate::skills::request(&f.app,Some("chat"),&json!({"folder_id":"L1","skill_id":id,"script":"scripts/run.sh","args":[],"files":[]}))?;
        let rid=run["id"].as_str().unwrap();assert_eq!(run["status"],"approval_required");
        assert!(!f.root.join(".skill-runs").join(rid).exists());
        let url=format!("/api/skill-runs/{rid}");f.json(&url,Some(json!({"action":"approve"}))).await;
        let mut result=Value::Null;for _ in 0..100 {result=f.json(&url,None).await;if result["status"]!="running"{break;}tokio::time::sleep(Duration::from_millis(20)).await;}
        assert_eq!(result["status"],"review_required","{result}");assert_eq!(result["stdout"],"done");
        assert!(f.json("/api/workspaces/L1",None).await["entries"].as_array().unwrap().is_empty());
        let applied=f.json(&url,Some(json!({"action":"apply"}))).await;
        let file=applied["entries"][0]["id"].as_str().unwrap();assert_eq!(crate::workspace::read(&f.app,"L1",file)?["text"],"review me");
        let undone=crate::workspace::history(&f.app,"L1",&json!({"revision":applied["revision"],"redo":false}))?;
        assert!(undone["entries"].as_array().unwrap().iter().all(|e|e["deleted"]==true));
        let traversal=f.request("/api/skills",Some(json!({"files":[{"path":"SKILL.md","data":b64("# Bad")},{"path":"../escape","data":b64("bad")}]})),None).await;
        assert!(!traversal.status().is_success());
        let tools=f.json("/mcp?mode=plan",Some(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))).await;
        assert!(!tools["result"]["tools"].as_array().unwrap().iter().any(|t|t["name"]=="request_skill_run"||t["name"]=="edit_project_file"));
        Ok(())
    }

    #[tokio::test]
    async fn desktop_updates_validate_actions_and_relay_native_results() -> Result<()> {
        let browser = Fixture::new()?;
        assert_eq!(browser.request("/api/desktop/update", Some(json!({"action":"check"})), None).await.status(), StatusCode::NOT_FOUND);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let f = Fixture::with_desktop(Some(tx))?;
        assert_eq!(f.request("/api/desktop/update", Some(json!({"action":"arbitrary"})), None).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let native = tokio::spawn(async move {
            for expected in ["startup_check", "check", "install", "restart"] {
                let Some(crate::DesktopCmd::Update(action, version, reply)) = rx.recv().await else { panic!("Expected update request") };
                if expected == "install" { assert_eq!(version.as_deref(), Some("0.3.0")); }
                assert!(matches!((expected, action), ("startup_check", crate::UpdateAction::StartupCheck) | ("check", crate::UpdateAction::Check) | ("install", crate::UpdateAction::Install) | ("restart", crate::UpdateAction::Restart)));
                if expected == "install" { let _ = reply.send(Err("Signature verification failed".into())); }
                else { let _ = reply.send(Ok(json!({"status": expected}))); }
            }
        });
        assert_eq!(f.json("/api/desktop/update", Some(json!({"action":"startup_check"}))).await["status"], "startup_check");
        assert_eq!(f.json("/api/desktop/update", Some(json!({"action":"check"}))).await["status"], "check");
        let failure = f.request("/api/desktop/update", Some(json!({"action":"install", "version":"0.3.0"})), None).await;
        assert_eq!(failure.status(), StatusCode::BAD_GATEWAY);
        assert!(String::from_utf8(to_bytes(failure.into_body(), usize::MAX).await?.to_vec())?.contains("Signature verification failed"));
        assert_eq!(f.json("/api/desktop/update", Some(json!({"action":"restart"}))).await["status"], "restart");
        native.await?;
        Ok(())
    }

    #[tokio::test]
    async fn note_media_upload_seek_and_legacy_images() -> Result<()> {
        let f = Fixture::new()?;
        let bytes = b"\0\0\0\x18ftypmp42synthetic video fixture";
        let req = |method: &str, path: &str, body: Vec<u8>, range: Option<&str>| {
            let mut b = Request::builder().method(method).uri(path).header("host", "127.0.0.1:7878");
            if let Some(range) = range { b = b.header("range", range); }
            b.body(Body::from(body)).unwrap()
        };
        let r = f.router.clone().oneshot(req("POST", "/api/note-media/L1", bytes.to_vec(), None)).await?;
        assert_eq!(r.status(), StatusCode::OK);
        let result: Value = serde_json::from_slice(&to_bytes(r.into_body(), 4096).await?)?;
        assert_eq!(result["kind"], "video");
        let file = result["path"].as_str().unwrap().strip_prefix("media/").unwrap();
        let url = format!("/api/note-media/L1/{file}");
        let r = f.router.clone().oneshot(req("GET", &url, vec![], Some("bytes=8-11"))).await?;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()["content-type"], "video/mp4");
        assert_eq!(r.headers()["content-range"], format!("bytes 8-11/{}", bytes.len()));
        assert_eq!(&to_bytes(r.into_body(), 4096).await?[..], b"mp42");
        let r = f.router.clone().oneshot(req("HEAD", &url, vec![], None)).await?;
        assert_eq!(r.headers()["content-length"], bytes.len().to_string());
        assert!(to_bytes(r.into_body(), 4096).await?.is_empty());
        let r = f.router.clone().oneshot(req("GET", &url, vec![], Some("bytes=900-"))).await?;
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        let r = f.router.clone().oneshot(req("POST", "/api/note-media/L1", b"not a video".to_vec(), None)).await?;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let png = b"\x89PNG\r\n\x1a\nsynthetic image fixture";
        let r = f.router.clone().oneshot(req("POST", "/api/note-media/L1", png.to_vec(), None)).await?;
        let image: Value = serde_json::from_slice(&to_bytes(r.into_body(), 4096).await?)?;
        assert_eq!(image["kind"], "image");
        let args = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"view_note_image","arguments":{"folder_id":"L1","path":image["path"]}}});
        let viewed = crate::mcp::handle(&f.app, &args, "direct", None).await.unwrap();
        assert_ne!(viewed["result"]["isError"], true);
        let folder = f.app.library.folder_id("L1")?;
        let old = f.app.notes.save_image(&folder, "legacy.png", png)?;
        let r = f.request(&format!("/api/note-images/L1/{}", old.strip_prefix("images/").unwrap()), None, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        let dir = f.app.notes.root.join(folder).join("media");
        assert_eq!(std::fs::read_dir(dir)?.count(), 2, "failed upload must leave no temporary file");
        Ok(())
    }

    #[tokio::test]
    async fn agent_pdf_download_reuses_files_and_obeys_plan_mode()->Result<()> {
        let f=Fixture::new()?;
        let key=f.app.library.upload("L1","downloaded.pdf",b"%PDF-1.7\nalready downloaded")?;
        let call=|args:Value|json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"download_pdf","arguments":args}});
        let result=crate::mcp::handle(&f.app,&call(json!({"paper_key":key})),"direct",Some("chat")).await.unwrap();
        assert_ne!(result["result"]["isError"],true);
        let payload:Value=serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap())?;
        assert_eq!(payload["paper_key"],key);assert_eq!(payload["has_pdf"],true);assert_eq!(payload["already_downloaded"],true);
        assert_eq!(f.app.library.items("L1")?.len(),1);
        let blocked=crate::mcp::handle(&f.app,&call(json!({"paper_key":key})),"plan",Some("chat")).await.unwrap();assert_eq!(blocked["result"]["isError"],true);
        let both=crate::mcp::handle(&f.app,&call(json!({"paper_key":key,"paper_id":"other"})),"direct",None).await.unwrap();assert_eq!(both["result"]["isError"],true);
        let missing=f.app.library.save(&json!({"title":"No downloadable PDF"}),"L1")?;
        let invalid=crate::mcp::handle(&f.app,&call(json!({"paper_key":missing,"url":"file:///tmp/paper.pdf"})),"suggest",None).await.unwrap();assert_eq!(invalid["result"]["isError"],true);assert_eq!(f.app.library.paper(&missing)?["has_pdf"],false);
        let list=f.json("/mcp?mode=plan",Some(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))).await;
        assert!(!list["result"]["tools"].as_array().unwrap().iter().any(|t|t["name"]=="download_pdf"));
        Ok(())
    }

    #[tokio::test]
    async fn pdf_outlines_use_selected_backend_and_persist_without_duplicate_inference() -> Result<()> {
        let f=Fixture::new()?;
        let key=f.app.library.upload("L1","outline.pdf",b"%PDF-1.7\noutline fixture")?;
        let hash=f.app.library.paper(&key)?["pdf_hash"].clone();
        let path=format!("/api/library/papers/{key}/outline");
        assert!(f.json(&path,None).await.is_null());
        assert!(!f.request(&path,Some(json!({})),None).await.status().is_success());
        f.app.library.save_index(&key,&json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"Introduction to grounded outlines","words":[{"start":0,"end":12,"rect":[0.1,0.2,0.4,0.03]}]}]}))?;
        for provider in ["claude","codex"] {
            f.app.settings.lock().unwrap().agent=if provider=="claude" {Provider::Claude}else{Provider::Codex};
            let outline=f.json(&path,Some(json!({"regenerate":true}))).await;
            assert_eq!(outline["provider"],provider);assert_eq!(outline["entries"][0]["y"],0.2);
            assert_eq!(f.json(&path,None).await,outline);
            let before=std::fs::read_to_string(f.root.join("invocations.jsonl"))?;
            let (left,right)=tokio::join!(f.json(&path,Some(json!({}))),f.json(&path,Some(json!({}))));
            assert_eq!(left,outline);assert_eq!(right,outline);
            assert_eq!(std::fs::read_to_string(f.root.join("invocations.jsonl"))?,before);
        }
        let reopened=crate::library::Library::open(f.root.join("library"))?;
        assert_eq!(reopened.outline(&key)?,f.app.library.outline(&key)?);
        let other=f.app.library.upload("L1","scan.pdf",b"%PDF-1.7\nscan fixture")?;
        let other_hash=f.app.library.paper(&other)?["pdf_hash"].clone();
        f.app.library.save_index(&other,&json!({"version":2,"hash":other_hash,"pages":[{"page":1,"text":"","words":[]}]}))?;
        assert!(!f.request(&format!("/api/library/papers/{other}/outline"),Some(json!({})),None).await.status().is_success());
        assert!(f.app.library.outline(&other)?.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn deletes_only_the_saved_ai_outline_and_allows_regeneration()->Result<()> {
        let f=Fixture::new()?;
        let key=f.app.library.upload("L1","outline.pdf",b"%PDF-1.7\noutline delete fixture")?;
        let hash=f.app.library.paper(&key)?["pdf_hash"].clone();
        f.app.library.save_index(&key,&json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"Introduction to grounded outlines","words":[]}]}))?;
        let annotation=f.app.library.annotate(&key,&json!({"kind":"comment","page":1,"comment":"Keep this annotation."}),"user",false)?;
        let path=format!("/api/library/papers/{key}/outline");
        f.json(&path,Some(json!({}))).await;
        let other=f.app.library.upload("L1","other.pdf",b"%PDF-1.7\nunrelated outline fixture")?;
        let saved=json!({"hash":f.app.library.paper(&other)?["pdf_hash"],"source":"ai","entries":[{"title":"Other section","page":1,"level":1,"y":0.1}]});
        f.app.library.save_outline(&other,&saved)?;
        assert_eq!(f.request(&path,None,Some("DELETE")).await.status(),StatusCode::OK);
        assert!(f.json(&path,None).await.is_null());
        assert_eq!(f.app.library.outline(&other)?,Some(saved));
        assert_eq!(f.app.library.annotations(&key)?[0]["id"],annotation["id"]);
        let reopened=crate::library::Library::open(f.root.join("library"))?;
        assert!(reopened.outline(&key)?.is_none());
        assert_eq!(f.request(&path,None,Some("DELETE")).await.status(),StatusCode::OK);
        assert_eq!(f.json(&path,Some(json!({}))).await["entries"][0]["title"],"Introduction");
        Ok(())
    }

    #[tokio::test]
    async fn outline_startup_failures_report_cli_diagnostics_and_preserve_the_cache()->Result<()> {
        let f=Fixture::new()?;
        let key=f.app.library.upload("L1","outline.pdf",b"%PDF-1.7\noutline diagnostic fixture")?;
        let hash=f.app.library.paper(&key)?["pdf_hash"].clone();
        f.app.library.save_index(&key,&json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"Introduction to grounded outlines","words":[]}]}))?;
        for provider in ["claude","codex"] {
            f.app.settings.lock().unwrap().agent=if provider=="claude"{Provider::Claude}else{Provider::Codex};
            let path=format!("/api/library/papers/{key}/outline");
            let cached=f.json(&path,Some(json!({"regenerate":true}))).await;
            std::fs::write(f.root.join("analysis-start-failure"),"")?;
            let response=f.request(&path,Some(json!({"regenerate":true})),None).await;
            assert_eq!(response.status(),StatusCode::BAD_GATEWAY);
            let failed:Value=serde_json::from_slice(&to_bytes(response.into_body(),1<<20).await?)?;
            assert!(failed["error"].as_str().unwrap_or("").contains("The selected model is unavailable for this account."),"{failed}");
            assert_eq!(f.app.library.outline(&key)?,Some(cached));
            std::fs::remove_file(f.root.join("analysis-start-failure"))?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn auto_highlight_workers_are_independent_grounded_cached_and_atomic() -> Result<()> {
        let f=Fixture::new()?;
        for provider in ["claude","codex"] {
            f.app.settings.lock().unwrap().agent=if provider=="claude" {Provider::Claude}else{Provider::Codex};
            let key=f.app.library.upload("L1","analysis.pdf",format!("%PDF-1.7\n{provider}").as_bytes())?;
            let hash=f.app.library.paper(&key)?["pdf_hash"].clone();
            let index=json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"A novel method improves predictive performance.","words":[{"start":0,"end":46,"rect":[0.1,0.2,0.7,0.03]}]}]});
            f.app.library.save_index(&key,&index)?;
            let manual=f.app.library.annotate(&key,&json!({"kind":"comment","page":1,"comment":"Keep my own note."}),"user",false)?;
            let path=format!("/api/library/papers/{key}/auto-highlight");
            std::fs::write(f.root.join("auto-highlight-invalid"),"")?;
            assert!(!f.request(&path,Some(json!({})),None).await.status().is_success());
            assert_eq!(f.app.library.annotations(&key)?.len(),1);assert!(f.app.library.auto_highlights(&key)?.is_none());
            std::fs::remove_file(f.root.join("auto-highlight-invalid"))?;
            let result=f.json(&path,Some(json!({}))).await;assert_eq!(result["created"],1);
            let saved=f.app.library.annotations(&key)?;let generated=saved.iter().find(|a|a["source"]=="auto-highlight").unwrap();
            assert_eq!(generated["category"],"novelty");assert_eq!(generated["color"],"#ff6666");assert_eq!(generated["rects"][0][1],0.2);
            assert!(saved.iter().any(|a|a["id"]==manual["id"]));
            f.app.library.update_annotation(&key,generated["id"].as_str().unwrap(),&json!({"revision":1,"comment":"My edited explanation."}))?;
            let invocations=std::fs::read_to_string(f.root.join("invocations.jsonl"))?;
            let repeated=f.json(&path,Some(json!({}))).await;assert_eq!(repeated["created"],0);assert_eq!(repeated["existing"],1);
            assert_eq!(std::fs::read_to_string(f.root.join("invocations.jsonl"))?,invocations);
            assert!(f.app.library.annotations(&key)?.iter().any(|a|a["comment"]=="My edited explanation."));
            assert!(f.json(&format!("/api/chats?provider={provider}"),None).await.as_array().unwrap().is_empty());
            let analysis=f.app.library.auto_highlights(&key)?.unwrap();let mut bad=analysis.clone();
            let mut invalid=analysis["highlights"][0].clone();invalid["category"]=json!("invalid");bad["highlights"].as_array_mut().unwrap().push(invalid);
            assert!(f.app.library.save_auto_highlights(&key,&bad,&Default::default()).is_err());assert_eq!(f.app.library.annotations(&key)?.len(),2);
            let calls:Vec<Value>=invocations.lines().map(|s|serde_json::from_str(s).unwrap()).collect();
            let args=calls.last().unwrap()["args"].as_array().unwrap();
            assert!(!args.contains(&json!("resume"))&&!args.contains(&json!("--resume")));
            assert!(args.contains(&json!(if provider=="codex"{"--ephemeral"}else{"--no-session-persistence"})));
        }
        Ok(())
    }

    #[tokio::test]
    async fn highlight_colors_persist_and_recolor_existing_ai_annotations() -> Result<()> {
        let f=Fixture::new()?;
        let defaults=f.json("/api/settings",None).await["highlight_colors"].clone();
        assert_eq!(defaults["novelty"],"#ff6666");assert_eq!(defaults["method"],"#5fb236");
        let custom=json!(["#456def","#234bcd","#abcdef","#6789ab","#345cde","#123abc"]);
        f.json("/api/settings/highlight-palette",Some(json!({"colors":custom}))).await;
        let palette=json!({"novelty":"#123ABC","method":"#234bcd","results":"#345cde","limitations":"#456def"});
        let saved=f.json("/api/settings/highlight-colors",Some(palette)).await;
        assert_eq!(saved["highlight_colors"]["novelty"],"#123abc");
        assert_eq!(crate::settings::Settings::load(&f.root).highlight_colors.color("novelty"),Some("#123abc"));
        for invalid in [json!({"novelty":"red"}),json!({"method":"#abc"}),json!({"results":"#123456;"}),json!({"unknown":"#112233"}),json!({"novelty":"#111111"}),json!({})] {
            assert_eq!(f.request("/api/settings/highlight-colors",Some(invalid),None).await.status(),StatusCode::BAD_REQUEST);
        }
        assert_eq!(f.json("/api/settings",None).await["highlight_colors"],saved["highlight_colors"]);
        let key=f.app.library.upload("L1","colors.pdf",b"%PDF-1.7\ncolors fixture")?;
        let hash=f.app.library.paper(&key)?["pdf_hash"].clone();
        f.app.library.save_index(&key,&json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"A novel method improves predictive performance.","words":[{"start":0,"end":46,"rect":[0.1,0.2,0.7,0.03]}]}]}))?;
        let annotation_path=format!("/api/library/papers/{key}/annotations");
        let manual=f.json(&annotation_path,Some(json!({"kind":"highlight","category":"method","page":1,"quote":"A novel method"}))).await;
        assert_eq!(manual["color"],"#234bcd");
        let tool=json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"annotate_pdf","arguments":{"paper_key":key,"page":1,"category":"results","quote":"A novel method","comment":"Result."}}});
        let response=crate::mcp::handle(&f.app,&tool,"direct",None).await.unwrap();assert_ne!(response["result"]["isError"],true);
        assert!(f.app.library.annotations(&key)?.iter().any(|a|a["color"]=="#345cde"));
        let other_key=f.app.library.upload("L1","other.pdf",b"%PDF-1.7\nother colors")?;
        let other=f.app.library.annotate(&other_key,&json!({"kind":"highlight","category":"novelty","color":"#123abc","page":1,"rects":[[0.1,0.2,0.2,0.03]],"comment":"Keep this comment"}),"assistant",true)?;
        let path=format!("/api/library/papers/{key}/auto-highlight");
        f.json(&path,Some(json!({}))).await;
        let original=f.app.library.annotations(&key)?.into_iter().find(|a|a["source"]=="auto-highlight").unwrap();
        assert_eq!(original["color"],"#123abc");
        f.json("/api/settings/highlight-colors",Some(json!({"novelty":"#abcdef"}))).await;
        assert_eq!(f.app.settings.lock().unwrap().highlight_colors.color("method"),Some("#234bcd"));
        let recolored=f.app.library.annotations(&other_key)?.into_iter().find(|a|a["id"]==other["id"]).unwrap();
        assert_eq!(recolored["color"],"#abcdef");assert_eq!(recolored["comment"],"Keep this comment");assert_eq!(recolored["status"],"pending");assert_eq!(recolored["revision"],2);
        let invocations=std::fs::read_to_string(f.root.join("invocations.jsonl"))?;
        f.json(&path,Some(json!({}))).await;
        assert_eq!(f.app.library.annotations(&key)?.into_iter().find(|a|a["id"]==original["id"]).unwrap()["color"],"#abcdef");
        f.app.library.delete_annotation(&key,original["id"].as_str().unwrap(),2)?;
        f.json(&path,Some(json!({}))).await;
        assert_eq!(f.app.library.annotations(&key)?.into_iter().find(|a|a["source"]=="auto-highlight").unwrap()["color"],"#abcdef");
        assert_eq!(std::fs::read_to_string(f.root.join("invocations.jsonl"))?,invocations);
        for colors in [json!([]),json!(["#123abc"]),json!(["#123abc","#123abc","#123abc","#123abc","#123abc","#123abc"]),json!(["red","#234bcd","#abcdef","#6789ab","#345cde","#123abc"])] {
            assert_eq!(f.request("/api/settings/highlight-palette",Some(json!({"colors":colors})),None).await.status(),StatusCode::BAD_REQUEST);
        }
        assert_eq!(f.json("/api/settings",None).await["highlight_palette"],custom);
        let changed=json!(["#456def","#112233","#abcdef","#6789ab","#345cde","#123abc"]);
        let remapped=f.json("/api/settings/highlight-palette",Some(json!({"colors":changed}))).await;
        assert_eq!(remapped["highlight_colors"]["method"],"#112233");
        assert_eq!(crate::settings::Settings::load(&f.root).highlight_palette.0[1],"#112233");
        assert_eq!(f.app.library.annotations(&key)?.into_iter().find(|a|a["id"]==manual["id"]).unwrap()["color"],"#234bcd");
        f.json("/api/settings/highlight-palette",Some(json!({"colors":crate::settings::HighlightPalette::default()}))).await;
        f.json("/api/settings/highlight-colors",Some(defaults.clone())).await;
        assert_eq!(f.json("/api/settings",None).await["highlight_colors"],defaults);
        Ok(())
    }

    #[tokio::test]
    async fn selected_passages_reach_both_assistants_and_remain_in_history()->Result<()> {
        let f=Fixture::new()?;
        let selections=json!([{"id":"quote-1","text":"A grounded passage.","source":{"kind":"pdf","label":"A paper","paper_key":"paper-1","page":3}},{"id":"quote-2","text":"A note excerpt.","source":{"kind":"note","label":"Research note","note_id":"note-1","folder_id":"L1"}}]);
        for provider in ["claude","codex"]{
            let events=f.events("/api/chat",json!({"provider":provider,"message":"verify-selected-passages","selections":selections})).await;
            assert!(events.iter().any(|event|event["type"]=="done"),"{events:?}");
            let id=events.iter().find(|event|event["type"]=="chat").unwrap()["id"].as_str().unwrap();
            let stored=f.settled(id,provider).await;
            assert_eq!(stored["messages"][0]["selections"],selections);
            let prompt=std::fs::read_to_string(f.root.join(format!("{provider}-selected.txt")))?;
            assert!(prompt.contains("<selected_passages>")&&prompt.contains("A grounded passage.")&&prompt.contains("note-1"));
        }
        for invalid in [json!([{"id":"x","text":"x"}]),json!([{"id":"x","text":"x".repeat(12001),"source":{"label":"x"}}]),json!([{"id":"x","text":"","source":{"label":"x"}}])]{
            assert_eq!(f.request("/api/chat",Some(json!({"message":"test","selections":invalid})),None).await.status(),StatusCode::BAD_REQUEST);
        }
        Ok(())
    }

    #[tokio::test]
    async fn native_pdf_tools_and_http_assets() -> Result<()> {
        let f=Fixture::new()?;
        let key=f.app.library.upload("L1","test.pdf",b"%PDF-1.7\nfixture")?;
        let hash=f.app.library.paper(&key)?["pdf_hash"].clone();
        f.app.library.save_index(&key,&json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"energy","words":[{"start":0,"end":6,"rect":[0.1,0.2,0.2,0.03]}]}]}))?;
        for path in ["/pdf.js","/pdf.css","/library.js","/vendor/pdfjs/build/pdf.mjs","/vendor/pdfjs/build/pdf.worker.mjs"] {assert_eq!(f.request(path,None,None).await.status(),StatusCode::OK);}
        let call=|name:&str,args:Value|json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}});
        let read=crate::mcp::handle(&f.app,&call("read_pdf",json!({"paper_key":key})),"plan",Some("reader-chat")).await.unwrap();
        assert!(read["result"]["content"][0]["text"].as_str().unwrap().contains("energy"));
        let args=json!({"paper_key":key,"page":1,"quote":"energy","comment":"$E$"});
        let blocked=crate::mcp::handle(&f.app,&call("annotate_pdf",args.clone()),"plan",Some("reader-chat")).await.unwrap();assert_eq!(blocked["result"]["isError"],true);assert!(f.app.library.annotations(&key)?.is_empty());
        let mut events=f.app.actions.subscribe();
        let suggested=crate::mcp::handle(&f.app,&call("annotate_pdf",args),"suggest",Some("reader-chat")).await.unwrap();assert_ne!(suggested["result"]["isError"],true);
        let action=events.recv().await?;assert_eq!(action["chat_id"],"reader-chat");assert_eq!(action["action"],"pdf_annotations");assert_eq!(f.app.library.annotations(&key)?[0]["status"],"pending");
        assert_eq!(f.json("/api/library/items?target=L1",None).await[0]["has_pdf"],true);
        Ok(())
    }

    #[tokio::test]
    async fn discovers_codex_models_with_pagination_and_surfaces_cli_failures() -> Result<()> {
        let f = Fixture::new()?;
        let catalog = f.json("/api/agents/codex/models", None).await;
        let models = catalog["models"].as_array().unwrap();
        assert_eq!(models.len(), 2, "hidden and duplicate entries must be excluded");
        assert_eq!(models[0]["id"], "catalog-model");
        assert_eq!(models[1]["id"], "second-model");
        assert_eq!(models[0]["reasoning_efforts"], json!(["low", "high"]));
        assert_eq!(models[0]["is_default"], true);
        std::fs::write(f.root.join("model-list-fail"), "")?;
        assert!(!f.request("/api/agents/codex/models", None, None).await.status().is_success());
        std::fs::remove_file(f.root.join("model-list-fail"))?;
        std::fs::write(f.root.join("model-list-eof"), "")?;
        assert!(!f.request("/api/agents/codex/models", None, None).await.status().is_success());
        let calls: Vec<Value> = std::fs::read_to_string(f.root.join("invocations.jsonl"))?
            .lines().map(|s| serde_json::from_str(s).unwrap()).collect();
        assert!(calls.iter().all(|call| call["args"][0] == "app-server"), "discovery must never run inference");
        Ok(())
    }

    #[tokio::test]
    async fn discovers_claude_models_without_inference_and_reads_capabilities() -> Result<()> {
        let f = Fixture::new()?;
        let catalog = f.json("/api/agents/claude/models", None).await;
        let models = catalog["models"].as_array().unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0]["is_default"], true);
        assert_eq!(models[1]["id"], "new-opus");
        assert_eq!(models[1]["label"], "New Opus");
        assert_eq!(models[1]["supports_fast"], true);
        assert_eq!(models[1]["reasoning_efforts"], json!(["low", "high"]));
        assert_eq!(models[2]["supports_fast"], false);
        assert_eq!(models[2]["reasoning_efforts"], json!([]));
        std::fs::write(f.root.join("model-list-fail"), "")?;
        assert!(!f.request("/api/agents/claude/models", None, None).await.status().is_success());
        std::fs::remove_file(f.root.join("model-list-fail"))?;
        std::fs::write(f.root.join("model-list-eof"), "")?;
        assert!(!f.request("/api/agents/claude/models", None, None).await.status().is_success());
        let calls: Vec<Value> = std::fs::read_to_string(f.root.join("invocations.jsonl"))?
            .lines().map(|s| serde_json::from_str(s).unwrap()).collect();
        assert!(calls.iter().all(|call| call["args"].as_array().unwrap().contains(&json!("--no-session-persistence"))));
        Ok(())
    }

    #[tokio::test]
    async fn both_backends_login_resume_transcribe_and_keep_separate_histories() -> Result<()> {
        use base64::Engine;
        let f = Fixture::new()?;
        assert_eq!(f.json("/api/settings", None).await["agent"], "claude");
        let mut ids = Vec::new();
        for provider in ["claude", "codex"] {
            assert_eq!(f.json(&format!("/api/agents/{provider}"), None).await["signed_in"], false);
            let login = f.events(&format!("/api/agents/{provider}/login"), json!({})).await;
            assert_eq!(login.last().unwrap()["type"], "done", "{login:?}");
            assert_eq!(f.json(&format!("/api/agents/{provider}"), None).await["signed_in"], true);
            let model = if provider == "claude" { "opus" } else { "gpt-6.1-sol" };
            f.json("/api/settings/agent", Some(json!({ "provider": provider, "options": { "model": model, "reasoning": "high", "fast": true } }))).await;
            let saved = crate::settings::Settings::load(&f.root);
            assert_eq!(saved.assistant.for_provider(if provider == "claude" { Provider::Claude } else { Provider::Codex }).model, model);
            let events = f.events("/api/chat", json!({ "message": "hello", "provider": provider })).await;
            let id = events.iter().find(|e| e["type"] == "chat").unwrap()["id"].as_str().unwrap().to_string();
            assert!(events.iter().any(|e| e["text"] == format!("{provider} reply")), "{events:?}");
            f.events("/api/chat", json!({ "message": "continue", "provider": provider, "chat_id": id })).await;
            let c = f.settled(&id, provider).await;
            assert_eq!(c["messages"].as_array().unwrap().len(), 4);
            assert_eq!(f.json(&format!("/api/chats?provider={provider}"), None).await.as_array().unwrap().len(), 1);
            let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\ntest-drawing");
            // No provider in the request: the saved active choice controls transcription.
            assert_eq!(f.json("/api/ink-latex", Some(json!({ "png": png }))).await["latex"], r"\[x^2\]");
            assert!(!std::fs::read_dir(f.root.join("chat"))?.flatten().any(|e| e.file_name().to_string_lossy().starts_with("ink-")));
            ids.push(id);
        }
        let wrong = f.request(&format!("/api/chats/{}?provider=codex", ids[0]), None, None).await;
        assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
        let wrong_resume = f.request("/api/chat", Some(json!({ "message": "wrong", "provider": "codex", "chat_id": ids[0] })), None).await;
        assert!(!wrong_resume.status().is_success());
        let tools = f.json("/mcp?mode=plan", Some(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))).await;
        assert!(!tools["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "edit_note" || t["name"] == "save_to_library"));
        let denied = f.json("/mcp?mode=plan", Some(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"edit_note","arguments":{}}}))).await;
        assert_eq!(denied["result"]["isError"], true);
        let calls: Vec<Value> = std::fs::read_to_string(f.root.join("invocations.jsonl"))?.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        for (provider, flag, session) in [("claude", "--resume", "claude-session"), ("codex", "resume", "codex-session")] {
            assert!(calls.iter().any(|c| c["provider"] == provider && c["args"].as_array().unwrap().contains(&json!(flag)) && c["args"].as_array().unwrap().contains(&json!(session))));
        }
        for provider in ["claude", "codex"] {
            let inference: Vec<_> = calls.iter().filter(|c| c["provider"] == provider && c["args"].as_array().unwrap().iter().any(|a| a == "-p" || a == "exec")).collect();
            assert_eq!(inference.len(), 3, "initial, resumed, and drawing requests");
            for call in inference {
                let args = call["args"].as_array().unwrap();
                let has_pair = |flag: &str, value: &str| args.windows(2).any(|p| p[0] == flag && p[1] == value);
                if provider == "claude" {
                    assert!(has_pair("--model", "opus"));
                    assert!(has_pair("--effort", "high"));
                    assert!(has_pair("--settings", r#"{"fastMode":true}"#));
                } else {
                    assert!(has_pair("--model", "gpt-6.1-sol"));
                    assert!(has_pair("-c", r#"model_reasoning_effort="high""#));
                    assert!(has_pair("-c", r#"service_tier="fast""#));
                }
            }
        }
        // Provider-only updates preserve both saved configurations.
        f.json("/api/settings/agent", Some(json!({"provider":"claude"}))).await;
        let settings = f.json("/api/settings", None).await;
        assert_eq!(settings["assistant"]["claude"]["model"], "opus");
        assert_eq!(settings["assistant"]["codex"]["model"], "gpt-6.1-sol");
        for options in [json!({"model":"--bad"}), json!({"model":"a\nb"}), json!({"reasoning":"ultra"})] {
            assert_eq!(f.request("/api/settings/agent", Some(json!({"provider":"claude","options":options})), None).await.status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(f.json("/api/settings", None).await["assistant"], settings["assistant"]);
        f.json("/api/settings/agent", Some(json!({"provider":"codex","options":{}}))).await;
        let cmd = codex_command(&f.app, None, "test");
        let args: Vec<_> = cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(!args.iter().any(|a| a == "--model" || a.starts_with("model_reasoning_effort=")));
        assert!(args.iter().any(|a| a == r#"service_tier="default""#));
        Ok(())
    }

    #[tokio::test]
    async fn threads_are_explained_once_then_cached() -> Result<()> {
        let f = Fixture::new()?;
        let calls = || std::fs::read_to_string(f.root.join("invocations.jsonl")).map(|s| s.lines().count()).unwrap_or(0);
        for provider in ["claude", "codex"] {
            let body = json!({ "provider": provider, "threads": [{ "id": "t1",
                "papers": [{ "id": "a", "title": "Seq2seq", "year": 2014, "authors": ["Sutskever"], "abstract": "RNN encoder-decoder." },
                           { "id": "b", "title": "Attention", "year": 2015 }],
                "steps": [["a", "b"]] }], "others": ["Unrelated"] });
            let before = calls();
            let mut peek = body.clone();
            peek["cache_only"] = json!(true);
            assert_eq!(f.json("/api/threads", Some(peek.clone())).await["threads"], json!([]));
            assert_eq!(calls(), before, "cache_only must not run the CLI");
            let first = f.json("/api/threads", Some(body.clone())).await;
            assert_eq!(first["cached"], false);
            assert_eq!(first["threads"][0]["name"], format!("{provider} thread"));
            assert_eq!(first["threads"][0]["steps"][0]["relation"], "extends");
            assert_eq!(first["threads"][0]["key"], json!(["a", "b"]));
            assert_eq!(calls(), before + 1);
            let again = f.json("/api/threads", Some(body.clone())).await;
            assert_eq!(again["cached"], true);
            assert_eq!(calls(), before + 1, "a cached answer must not run the CLI");
            assert_eq!(f.json("/api/threads", Some(peek)).await["cached"], true);
            let mut forced = body;
            forced["force"] = json!(true);
            assert_eq!(f.json("/api/threads", Some(forced)).await["cached"], false);
            assert_eq!(calls(), before + 2);
        }
        Ok(())
    }

    #[tokio::test]
    async fn disconnect_saves_partial_replies_and_rejects_concurrent_turns() -> Result<()> {
        let f = Fixture::new()?;
        for provider in ["claude", "codex"] {
            let r = f.request("/api/chat", Some(json!({ "message": "slow", "provider": provider })), None).await;
            let mut stream = r.into_body().into_data_stream();
            let mut id = String::new();
            loop {
                let bytes = tokio::time::timeout(Duration::from_secs(5), stream.next()).await?.unwrap()?;
                let e: Value = serde_json::from_slice(&bytes)?;
                if e["type"] == "chat" { id = e["id"].as_str().unwrap().to_string(); }
                if e["text"] == "Partial" { break; }
            }
            let concurrent = f.request("/api/chat", Some(json!({ "message": "another tab", "provider": provider, "chat_id": id })), None).await;
            assert_eq!(concurrent.status(), StatusCode::CONFLICT);
            drop(stream); // equivalent to the browser's AbortController
            let c = f.settled(&id, provider).await;
            assert_eq!(c["messages"][1]["text"], "Partial");
            assert_eq!(c["messages"][1]["stopped"], true);
        }
        Ok(())
    }
    #[tokio::test]
    async fn tool_actions_are_scoped_to_the_owning_chat() -> Result<()> {
        let f = Fixture::new()?;
        let mut streams = Vec::new();
        let mut ids = Vec::new();
        for provider in ["claude", "codex"] {
            let r = f.request("/api/chat", Some(json!({ "message": "slow", "provider": provider })), None).await;
            let mut stream = r.into_body().into_data_stream();
            loop {
                let bytes = tokio::time::timeout(Duration::from_secs(5), stream.next()).await?.unwrap()?;
                let e: Value = serde_json::from_slice(&bytes)?;
                if e["type"] == "chat" { ids.push(e["id"].as_str().unwrap().to_string()); }
                if e["text"] == "Partial" { break; }
            }
            streams.push(stream);
        }
        f.app.ui(json!({ "action": "select", "id": "paper", "chat_id": ids[0] }));
        let bytes = tokio::time::timeout(Duration::from_secs(2), streams[0].next()).await?.unwrap()?;
        assert_eq!(serde_json::from_slice::<Value>(&bytes)?["action"], "select");
        assert!(tokio::time::timeout(Duration::from_millis(50), streams[1].next()).await.is_err(), "another backend's action leaked into this chat");
        drop(streams);
        for (id, provider) in ids.iter().zip(["claude", "codex"]) { f.settled(id, provider).await; }
        Ok(())
    }

    include!("mcp_tests.rs");
}
