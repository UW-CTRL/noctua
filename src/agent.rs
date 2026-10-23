//! CLI backends. Credentials stay in each CLI's own credential store.
use std::{process::Stdio, sync::Arc, time::Duration};
use anyhow::{Context, Result};
use axum::{body::Body, extract::{Path, State}, http::header, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{io::{AsyncReadExt, AsyncBufReadExt, BufReader}, process::Command, sync::mpsc};
use tokio_stream::{wrappers::ReceiverStream, StreamExt};
use crate::App;

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
                notes: Notes::new(root.join("notes")), data_dir: root.clone(), settings: std::sync::Mutex::new(settings),
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
            f.json("/api/settings/agent", Some(json!({ "provider": provider }))).await;
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
