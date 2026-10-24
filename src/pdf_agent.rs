//! Isolated, ephemeral CLI workers for Reader analysis, separate from chat sessions.
use std::{process::Stdio, time::Duration};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use crate::{agent::{self, Provider}, App};

pub fn input(index:&Value,title:&Value)->Result<String> {
    let pages=index["pages"].as_array().context("PDF text is not ready")?;
    if pages.len()>400 {bail!("AI paper analysis supports PDFs with up to 400 pages");}
    if !pages.iter().any(|p|p["text"].as_str().unwrap_or("").chars().any(char::is_alphabetic)) {
        bail!("This PDF has no selectable text. Scanned papers need OCR before AI analysis.");
    }
    let per_page=(180_000/pages.len().max(1)).min(10_000);
    let excerpts:Vec<Value>=pages.iter().map(|p|json!({"page":p["page"],"text":p["text"].as_str().unwrap_or("").chars().take(per_page).collect::<String>()})).collect();
    Ok(json!({"title":title,"pages":excerpts}).to_string())
}

pub fn response(text:&str)->Result<Value> {
    let text=text.trim().strip_prefix("```json").or_else(||text.trim().strip_prefix("```")).unwrap_or(text.trim()).trim().trim_end_matches("```").trim();
    serde_json::from_str(text).context("The assistant returned invalid analysis JSON. Try again.")
}

pub async fn complete(app:&App,provider:Provider,prompt:&str,input:&str)->Result<String> {
    std::fs::create_dir_all(&app.chat_dir)?;
    let mut cmd=if provider==Provider::Codex {
        let mut cmd=agent::codex_command(app,None,prompt);
        cmd.args(["--ephemeral","-"]);cmd
    }else{
        let mut cmd=provider.command(app);provider.configure(app,&mut cmd);
        cmd.args(["-p","--output-format","stream-json","--verbose","--no-session-persistence",
            "--tools","","--strict-mcp-config","--mcp-config","{\"mcpServers\":{}}","--system-prompt",prompt]);
        let fast=app.settings.lock().unwrap().assistant.for_provider(provider).fast;
        cmd.arg("--settings").arg(json!({"disableAllHooks":true,"fastMode":fast}).to_string());cmd
    };
    let mut child=cmd.current_dir(&app.chat_dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true).spawn().with_context(||provider.missing())?;
    let stderr=agent::drain_stderr(child.stderr.take().unwrap());
    let run=async {
        let mut stdin=child.stdin.take().unwrap();stdin.write_all(input.as_bytes()).await?;drop(stdin);
        let mut lines=BufReader::new(child.stdout.take().unwrap()).lines();
        let (mut text,mut error,mut finished)=(String::new(),None,false);
        while let Some(line)=lines.next_line().await? {
            if line.len()>2_000_000 {bail!("The assistant returned an oversized analysis response");}
            if provider==Provider::Codex {
                for event in crate::chat::translate_codex(&line,&mut finished) {
                    if event["type"]=="text" {text.push_str(event["text"].as_str().unwrap_or(""));}
                    if event["type"]=="error" {error=Some(event["message"].as_str().unwrap_or("Paper analysis failed").to_string());}
                }
            }else if let Ok(event)=serde_json::from_str::<Value>(&line) {
                if event["type"]=="result" {
                    finished=true;text=event["result"].as_str().unwrap_or("").to_string();
                    if event["is_error"]==true {error=Some(text.clone());}
                }
            }
            if text.len()>256_000 {bail!("The assistant returned an oversized analysis");}
        }
        let status=child.wait().await?;
        if let Some(error)=error {bail!("Paper analysis failed: {error}");}
        if !status.success()||!finished||text.trim().is_empty() {bail!("{} could not analyze the paper. Check Research assistant in Settings and try again.",provider.label());}
        Ok(text)
    };
    let result=tokio::time::timeout(Duration::from_secs(300),run).await.context("Paper analysis timed out. Try again.");
    // kill_on_drop also terminates the CLI when the HTTP request is cancelled.
    drop(child);
    stderr.abort();
    result?
}
