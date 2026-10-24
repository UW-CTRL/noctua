//! Chat assistant backed by Claude Code or Codex. Each message resumes its
//! provider-specific CLI session, exposes Noctua's MCP tools, and streams
//! normalized NDJSON events back to the browser:
//!
//! `{type:"chat",id}`     `{type:"session",id}`  `{type:"text",text}`  `{type:"text_start"}`
//! `{type:"tool",name}`   `{type:"action",...}` `{type:"done"}`  `{type:"error",message}`
//!
//! Every exchange is saved to the chat history, even if the browser leaves
//! halfway through.

use std::{process::Stdio, sync::Arc};

use anyhow::{bail, Context, Result};
use axum::body::Body;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_stream::{wrappers::ReceiverStream, StreamExt};

use crate::{agent::{self, Provider}, App};

const SYSTEM: &str = "You are the research assistant built into Noctua, the user's personal \
paper explorer. Noctua shows Semantic Scholar citation graphs next to this chat and connects to \
the user's native Noctua library. PDFs are stored locally. When asked to download a paper, use download_pdf with its paper_key or paper_id (or a direct PDF URL). Report a download as successful only if the tool confirms has_pdf. Use read_pdf, search_pdf and view_pdf_page to inspect them. Use annotate_pdf for exact-quote highlights and LaTeX math comments, and comment_on_pdf_annotation to reply. In suggest mode these remain pending until accepted. Link to pages with [page](pdf:PAPER_KEY?page=N).

Each user message may start with a <noctua_view> block describing what the user is looking at \
right now (graph center, selected paper, papers in the graph, their Noctua folders). Treat it as \
the current screen, not as something the user typed. A <noctua_mode> line says which chat mode \
the user picked (suggest edits, plan, or direct edits); follow it. An <attached> block holds papers \
and notes the user @-mentioned in the message (shown there as @[Title]).

Use the noctua tools to act: search for papers, show a paper's graph, select a paper, list Noctua \
folders or their contents, add papers to Noctua, get or show a folder's project graph (how \
the folder's papers cite each other: clusters of directly connected papers, and the shared \
references that link clusters), and list or read the user's notes (LaTeX notes with \
handwritten drawings, attached to Noctua folders; \\cite keys in them are Noctua item keys). \
Notes can contain local videos with \\includevideo[width=0.6\\textwidth]{media/…}, including alongside images in subfigures. Video playback is Noctua-specific; view_note_image cannot watch videos. New images and videos share media/ storage; legacy images/ paths still work. Notes can contain images (\\includegraphics{images/…} in a figure): view_note_image shows you one, \
so you can read, transcribe or interpret it and write the result into the note as LaTeX with \
edit_note (Noctua's LaTeX subset: math, align, lists, theorem-likes; no TikZ). \
When the user asks to add a paper without naming a folder, use the 'Add-to folder' from the view. Only add papers the user asked for.

Be concise. When you mention a specific paper whose paperId you know, link it as \
[Title](paper:PAPER_ID) so the user can click it.";

#[derive(Deserialize)]
pub struct ChatBody {
    message: String,
    provider: Option<Provider>,
    #[serde(default)]
    context: String,
    chat_id: Option<String>,
    #[serde(default)]
    mode: String,
    /// Papers and notes the user @-mentioned, as text.
    #[serde(default)]
    attachments: String,
}

/// The chat modes, cycled with Shift+Tab in the UI.
pub fn mode_or_default(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "direct" => "direct",
        _ => "suggest",
    }
}

fn mode_note(mode: &str) -> &'static str {
    match mode {
        "plan" => "Chat mode: Plan. Do not change anything: no note edits and no adding to Noctua. \
Investigate with the read-only tools and answer with a concrete plan; the user will switch modes to carry it out.",
        "direct" => "Chat mode: Direct edits. edit_note applies changes to the note immediately (the user can undo). \
Make only the changes the user asked for.",
        _ => "Chat mode: Suggest edits. To change a note, call edit_note: each edit appears as a suggestion the \
user accepts or rejects. Prefer small, targeted edits to single blocks.",
    }
}

/// What the assistant produced in one turn, for the history.
#[derive(Default)]
struct Turn {
    session: Option<String>,
    text: String,
    tools: Vec<String>,
    error: Option<String>,
    stopped: bool,
}

impl Turn {
    fn record(&mut self, ev: &Value) {
        let s = |k: &str| ev[k].as_str().filter(|v| !v.is_empty()).map(String::from);
        match ev["type"].as_str().unwrap_or("") {
            "session" => self.session = s("id").or(self.session.take()),
            "done" => self.session = s("session_id").or(self.session.take()),
            "text_start" if !self.text.is_empty() && !self.text.ends_with("\n\n") => self.text.push_str("\n\n"),
            "text" => self.text.push_str(ev["text"].as_str().unwrap_or("")),
            "tool" => self.tools.extend(s("name")),
            "error" => self.error = s("message"),
            _ => {}
        }
    }
}

pub fn stream(app: Arc<App>, body: ChatBody) -> Result<Body, crate::ApiError> {
    let provider = body.provider.unwrap_or_else(|| app.settings.lock().unwrap().agent);
    let (tx, rx) = mpsc::channel::<Value>(256);
    let chat_id = body
        .chat_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    app.history.reserve(&chat_id, provider)?;
    if !app.chat_jobs.lock().unwrap().insert(chat_id.clone()) {
        return Err(crate::Status(axum::http::StatusCode::CONFLICT, "This chat is already replying in another tab.".into()).into());
    }
    tokio::spawn(async move {
        let _ = tx.send(json!({ "type": "chat", "id": chat_id })).await;
        let mut turn = Turn::default();
        if let Err(e) = run(&app, provider, &chat_id, &body, &tx, &mut turn).await {
            let ev = json!({ "type": "error", "message": format!("{e:#}") });
            turn.record(&ev);
            let _ = tx.send(ev).await;
        }
        let user = json!({ "role": "user", "text": body.message });
        let mut reply = json!({ "role": "assistant", "text": turn.text, "tools": turn.tools });
        if let Some(e) = turn.error {
            reply["error"] = json!(e);
        }
        if turn.stopped {
            reply["stopped"] = json!(true);
        }
        if let Err(e) = app.history.append(&chat_id, provider, turn.session.as_deref(), user, reply) {
            eprintln!("chat: could not save history: {e:#}");
            let _ = tx.send(json!({ "type": "error", "message": format!("Could not save this conversation: {e:#}") })).await;
        }
        app.chat_jobs.lock().unwrap().remove(&chat_id);
    });
    Ok(Body::from_stream(
        ReceiverStream::new(rx).map(|v| Ok::<_, std::convert::Infallible>(format!("{v}\n"))),
    ))
}

async fn run(app: &App, provider: Provider, chat_id: &str, body: &ChatBody, tx: &mpsc::Sender<Value>, turn: &mut Turn) -> Result<()> {
    let mut url = reqwest::Url::parse(&format!("{}/mcp", app.base_url))?;
    url.query_pairs_mut().append_pair("mode", mode_or_default(&body.mode)).append_pair("chat_id", chat_id);
    let mcp = json!({
        "mcpServers": { "noctua": { "type": "http", "url": url.as_str() } }
    })
    .to_string();
    std::fs::create_dir_all(&app.chat_dir)?;

    let session = app.history.session(chat_id, provider);
    let mut cmd = if provider == Provider::Codex {
        let mut c = agent::codex_command(app, Some(url.as_str()), SYSTEM);
        if let Some(s) = &session { c.args(["resume", s]); }
        c.arg("-");
        c
    } else {
        let mut c = provider.command(app);
        c.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
            .args(["--tools", "", "--strict-mcp-config", "--mcp-config", &mcp])
            .args(["--allowedTools", "mcp__noctua", "--system-prompt", SYSTEM]);
        if let Some(s) = &session { c.args(["--resume", s]); }
        c
    };
    cmd.current_dir(&app.chat_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .with_context(|| provider.missing())?;

    let mut mode = format!("<noctua_mode>{}</noctua_mode>", mode_note(mode_or_default(&body.mode)));
    if !body.attachments.trim().is_empty() {
        mode.push_str(&format!("\n<attached>\n{}\n</attached>", body.attachments.trim()));
    }
    let prompt = if body.context.trim().is_empty() {
        format!("{mode}\n\n{}", body.message)
    } else {
        format!("{mode}\n<noctua_view>\n{}\n</noctua_view>\n\n{}", body.context.trim(), body.message)
    };
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(prompt.as_bytes()).await?;
    drop(stdin);

    let stderr = agent::drain_stderr(child.stderr.take().expect("piped stderr"));
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut actions = app.actions.subscribe();
    let mut finished = false;

    loop {
        tokio::select! {
            _ = tx.closed() => {
                turn.stopped = true;
                let _ = child.kill().await;
                let _ = stderr.await;
                return Ok(());
            }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                for ev in if provider == Provider::Codex { translate_codex(&line, &mut finished) } else { translate(&line, &mut finished) } {
                    turn.record(&ev);
                    if tx.send(ev).await.is_err() {
                        turn.stopped = true;
                        return Ok(()); // browser went away; kill_on_drop stops the CLI
                    }
                }
            }
            Ok(mut a) = actions.recv() => {
                if a["chat_id"].as_str() != Some(chat_id) { continue; }
                a["type"] = json!("action");
                if tx.send(a).await.is_err() {
                    turn.stopped = true;
                    return Ok(());
                }
            }
        }
    }

    let status = child.wait().await?;
    let err = stderr.await.unwrap_or_default();
    if !finished || !status.success() {
        bail!("{} exited ({status}): {}", provider.label(), err.trim());
    }
    Ok(())
}

/// Maps one line of `claude` stream-json output to zero or more UI events.
fn translate(line: &str, finished: &mut bool) -> Vec<Value> {
    let Ok(e) = serde_json::from_str::<Value>(line) else { return vec![] };
    match e["type"].as_str().unwrap_or("") {
        "system" if e["subtype"] == "init" => vec![json!({ "type": "session", "id": e["session_id"] })],
        "stream_event" => {
            let ev = &e["event"];
            match ev["type"].as_str().unwrap_or("") {
                "content_block_start" if ev["content_block"]["type"] == "text" => {
                    vec![json!({ "type": "text_start" })]
                }
                "content_block_delta" if ev["delta"]["type"] == "text_delta" => {
                    vec![json!({ "type": "text", "text": ev["delta"]["text"] })]
                }
                _ => vec![],
            }
        }
        "assistant" => e["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_use")
            .map(|b| {
                let name = b["name"].as_str().unwrap_or("");
                json!({ "type": "tool", "name": name.trim_start_matches("mcp__noctua__") })
            })
            .collect(),
        "result" => {
            *finished = true;
            if e["is_error"].as_bool().unwrap_or(false) {
                let msg = e["result"].as_str().unwrap_or("the assistant hit an error");
                vec![json!({ "type": "error", "message": msg, "session_id": e["session_id"] })]
            } else {
                vec![json!({ "type": "done", "session_id": e["session_id"] })]
            }
        }
        _ => vec![],
    }
}


/// `codex exec --json` emits complete message items and MCP tool events.
pub(crate) fn translate_codex(line: &str, finished: &mut bool) -> Vec<Value> {
    let Ok(e) = serde_json::from_str::<Value>(line) else { return vec![] };
    match e["type"].as_str().unwrap_or("") {
        "thread.started" => vec![json!({ "type": "session", "id": e["thread_id"] })],
        "item.completed" if e["item"]["type"] == "agent_message" => vec![
            json!({ "type": "text_start" }), json!({ "type": "text", "text": e["item"]["text"] }),
        ],
        "item.started" if e["item"]["type"] == "mcp_tool_call" => vec![json!({ "type": "tool", "name": e["item"]["tool"] })],
        "turn.completed" => { *finished = true; vec![json!({ "type": "done" })] },
        "turn.failed" => { *finished = true; vec![json!({ "type": "error", "message": e["error"]["message"].as_str().unwrap_or("Codex could not complete this turn.") })] },
        "error" => vec![json!({ "type": "error", "message": e["message"].as_str().unwrap_or("Codex encountered an error.") })],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_events_keep_sessions_tools_messages_and_failures() {
        let mut finished = false;
        let mut turn = Turn::default();
        for line in [
            r#"{"type":"thread.started","thread_id":"codex-session"}"#,
            r#"{"type":"item.started","item":{"type":"mcp_tool_call","tool":"read_note"}}"#,
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"private reasoning"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"First"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Second"}}"#,
            r#"{"type":"turn.completed"}"#,
        ] {
            for ev in translate_codex(line, &mut finished) { turn.record(&ev); }
        }
        assert!(finished);
        assert_eq!(turn.session.as_deref(), Some("codex-session"));
        assert_eq!(turn.text, "First\n\nSecond");
        assert_eq!(turn.tools, ["read_note"]);
        for ev in translate_codex(r#"{"type":"turn.failed","error":{"message":"Please sign in"}}"#, &mut finished) { turn.record(&ev); }
        assert_eq!(turn.error.as_deref(), Some("Please sign in"));
    }

    #[test]
    fn claude_session_and_partial_text_still_translate() {
        let mut finished = false;
        let mut turn = Turn::default();
        for line in [
            r#"{"type":"system","subtype":"init","session_id":"claude-session"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}"#,
            r#"{"type":"result","session_id":"claude-session","is_error":false}"#,
        ] { for ev in translate(line, &mut finished) { turn.record(&ev); } }
        assert!(finished);
        assert_eq!(turn.text, "Hello");
        assert_eq!(turn.session.as_deref(), Some("claude-session"));
    }
}
