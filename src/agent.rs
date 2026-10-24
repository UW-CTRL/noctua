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
            use std::os::unix::fs::PermissionsExt;
            let root = std::env::temp_dir().join(format!("noctua-cli-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
            std::fs::create_dir_all(&root)?;
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
                desktop: None, login_gate: tokio::sync::Mutex::new(()), chat_jobs: std::sync::Mutex::new(Default::default()),
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
        assert!(!tools["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "edit_note" || t["name"] == "add_to_zotero"));
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

}
