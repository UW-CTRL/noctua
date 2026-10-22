//! Chat assistant backed by the local `claude` CLI. Each message runs
//! `claude -p` (resuming the conversation's session), with Noctua's MCP tools
//! as its only tools, and streams NDJSON events back to the browser:
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
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_stream::{wrappers::ReceiverStream, StreamExt};

use crate::App;

const SYSTEM: &str = "You are the research assistant built into Noctua, the user's personal \
paper explorer. Noctua shows Semantic Scholar citation graphs next to this chat and connects to \
the user's Zotero library.

Each user message may start with a <noctua_view> block describing what the user is looking at \
right now (graph center, selected paper, papers in the graph, their Zotero folders). Treat it as \
the current screen, not as something the user typed. A <noctua_mode> line says which chat mode \
the user picked (suggest edits, plan, or direct edits); follow it. An <attached> block holds papers \
and notes the user @-mentioned in the message (shown there as @[Title]).

Use the noctua tools to act: search for papers, show a paper's graph, select a paper, list Zotero \
folders or their contents, add papers to Zotero, get or show a folder's project graph (how \
the folder's papers cite each other: clusters of directly connected papers, and the shared \
references that link clusters), and list or read the user's notes (LaTeX notes with \
handwritten drawings, attached to Zotero folders; \\cite keys in them are Zotero item keys). \
Notes can contain images (\\includegraphics{images/…} in a figure): view_note_image shows you one, \
so you can read, transcribe or interpret it and write the result into the note as LaTeX with \
edit_note (Noctua's LaTeX subset: math, align, lists, theorem-likes; no TikZ). \
When the user asks to add a paper without naming a folder, use the 'Add-to folder' from the view. Only add papers the user asked for.

Be concise. When you mention a specific paper whose paperId you know, link it as \
[Title](paper:PAPER_ID) so the user can click it.";

#[derive(Deserialize)]
pub struct ChatBody {
    message: String,
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
        "plan" => "Chat mode: Plan. Do not change anything: no note edits and no adding to Zotero. \
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

pub fn stream(app: Arc<App>, body: ChatBody) -> Body {
    let (tx, rx) = mpsc::channel::<Value>(256);
    let chat_id = body
        .chat_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    tokio::spawn(async move {
        let _ = tx.send(json!({ "type": "chat", "id": chat_id })).await;
        let mut turn = Turn::default();
        if let Err(e) = run(&app, &chat_id, &body, &tx, &mut turn).await {
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
        if let Err(e) = app.history.append(&chat_id, turn.session.as_deref(), user, reply) {
            eprintln!("chat: could not save history: {e:#}");
        }
    });
    Body::from_stream(
        ReceiverStream::new(rx).map(|v| Ok::<_, std::convert::Infallible>(format!("{v}\n"))),
    )
}

async fn run(app: &App, chat_id: &str, body: &ChatBody, tx: &mpsc::Sender<Value>, turn: &mut Turn) -> Result<()> {
    let mcp = json!({
        "mcpServers": { "noctua": { "type": "http", "url": format!("{}/mcp?mode={}", app.base_url, mode_or_default(&body.mode)) } }
    })
    .to_string();
    std::fs::create_dir_all(&app.chat_dir)?;

    let mut cmd = crate::paths::claude_command(app.claude_path().as_deref());
    cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .args(["--tools", "", "--strict-mcp-config", "--mcp-config", &mcp])
        .args(["--allowedTools", "mcp__noctua", "--system-prompt", SYSTEM]);
    if let Some(s) = app.history.session(chat_id) {
        cmd.args(["--resume", &s]);
    }
    cmd.current_dir(&app.chat_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .context(crate::NO_CLAUDE)?;

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

    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut actions = app.actions.subscribe();
    let mut finished = false;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                for ev in translate(&line, &mut finished) {
                    turn.record(&ev);
                    if tx.send(ev).await.is_err() {
                        turn.stopped = true;
                        return Ok(()); // browser went away; kill_on_drop stops claude
                    }
                }
            }
            Ok(mut a) = actions.recv() => {
                a["type"] = json!("action");
                if tx.send(a).await.is_err() {
                    turn.stopped = true;
                    return Ok(());
                }
            }
        }
    }

    let status = child.wait().await?;
    if !finished {
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err).await;
        bail!("claude exited ({status}): {}", err.trim());
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

