//! Revision-checked assistant edits. Direct writes persist before returning;
//! suggestions are durable proposals accepted only through the review UI.
use crate::{ApiResult, App, Shared};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex};
static GATE: Mutex<()> = Mutex::new(());
fn conflict(message: &str) -> anyhow::Error {
    crate::Status(axum::http::StatusCode::CONFLICT, message.into()).into()
}
fn path(app: &App, id: &str) -> Result<PathBuf> {
    crate::notes::check_id(id)?;
    Ok(app
        .notes
        .root
        .join(".agent-edits")
        .join(format!("{id}.json")))
}
fn store(app: &App, p: &Value) -> Result<()> {
    let file = path(app, p["id"].as_str().context("Proposal id required")?)?;
    std::fs::create_dir_all(file.parent().unwrap())?;
    crate::notes::write_atomic(&file, &p.to_string())
}
fn load(app: &App, id: &str) -> Result<Value> {
    Ok(serde_json::from_slice(
        &std::fs::read(path(app, id)?).context("Proposal not found")?,
    )?)
}
pub fn summary(p: &Value) -> Value {
    json!({"proposal_id":p["id"],"tool":p["tool"],"folder_id":p["args"]["folder_id"],"note_id":p["args"]["note_id"],"status":p["status"],"result":p["result"]})
}
pub fn status(app: &App, id: &str) -> Result<Value> {
    Ok(summary(&load(app, id)?))
}

pub fn note_state(app: &App, target: &str, id: &str) -> Result<(Value, Value)> {
    let m = crate::workspace::snapshot(app, target)?;
    let entry = m["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["note"] == id)
        .context("Note not found")?
        .clone();
    let doc = app
        .notes
        .get(&app.library.folder_id(target)?, id)?
        .context("Note not found")?;
    Ok((doc, entry))
}
fn edited_note(app: &App, a: &Value) -> Result<(Value, Vec<Value>)> {
    let target = a["folder_id"].as_str().context("Folder required")?;
    let id = a["note_id"].as_str().context("Note id required")?;
    let (mut doc, entry) = note_state(app, target, id)?;
    if entry["deleted"] == true {
        bail!("Restore this note from project trash before editing it");
    }
    let stale = || conflict("Note changed. Read it again and use its updated version.");
    let read = a["updated"].as_u64().ok_or_else(stale)?;
    if doc["updated"].as_u64() != Some(read) {
        // Someone saved since the read; the edit still applies to the current
        // note if nothing it touches has changed.
        let base = app
            .notes
            .version(&app.library.folder_id(target)?, id, read)
            .ok_or_else(stale)?;
        unchanged_since(&base, &doc, a)?;
    }
    let mut results = Vec::new();
    for field in ["title", "preamble"] {
        if let Some(v) = a.get(field) {
            let text = v.as_str().context("Note metadata must be text")?;
            if (field == "title" && (text.trim().is_empty() || text.chars().count() > 200))
                || text.len() > 100_000
            {
                bail!("Invalid note metadata length");
            }
            doc[field] = v.clone();
            results.push(json!({"field":field,"status":"updated"}));
        }
    }
    for (index, e) in a["edits"].as_array().into_iter().flatten().enumerate() {
        let op = e["op"].as_str().context("Edit operation required")?;
        let block = e["block_id"].as_str();
        let blocks = doc["blocks"]
            .as_array_mut()
            .context("Invalid note blocks")?;
        let position = block.and_then(|id| blocks.iter().position(|b| b["id"] == id));
        if block.is_some() && position.is_none() {
            bail!("Block not found: {}", block.unwrap());
        }
        let mut affected = block.map(str::to_owned);
        match op {
            "replace" | "delete" | "move" => {
                let i = position.context("replace, delete and move require block_id")?;
                match op {
                    "delete" => {
                        blocks.remove(i);
                    }
                    "replace" => {
                        let text = e["latex"].as_str().context("replace requires latex")?;
                        if text.len() > 100_000 {
                            bail!("Block text exceeds 100000 bytes");
                        }
                        if blocks[i]["type"] == "text" {
                            blocks[i]["src"] = json!(text);
                        } else {
                            let id = crate::library::id("b");
                            blocks.insert(i + 1, json!({"id":id,"type":"text","src":text}));
                            affected = Some(id);
                        }
                    }
                    _ => {
                        let after = e["after_block_id"]
                            .as_str()
                            .context("move requires after_block_id (empty for first)")?;
                        if Some(after) == block {
                            bail!("A block cannot move after itself");
                        }
                        if !after.is_empty() && !blocks.iter().any(|b| b["id"] == after) {
                            bail!("Destination block not found");
                        }
                        let moving = blocks.remove(i);
                        let at = if after.is_empty() {
                            0
                        } else {
                            blocks.iter().position(|b| b["id"] == after).unwrap() + 1
                        };
                        blocks.insert(at, moving);
                    }
                }
            }
            "insert_after" => {
                let text = e["latex"].as_str().context("insert_after requires latex")?;
                if text.len() > 100_000 {
                    bail!("Block text exceeds 100000 bytes");
                }
                let id = crate::library::id("b");
                blocks.insert(
                    position.map_or(0, |p| p + 1),
                    json!({"id":id,"type":"text","src":text}),
                );
                affected = Some(id);
            }
            _ => bail!("Unknown note operation"),
        }
        if blocks.is_empty() {
            blocks.push(json!({"id":crate::library::id("b"),"type":"text","src":""}));
        }
        results.push(json!({"index":index,"op":op,"block_id":affected,"status":"applied"}));
    }
    if results.is_empty() {
        bail!("Provide edits, title or preamble");
    }
    Ok((doc, results))
}
fn unchanged_since(base: &Value, doc: &Value, a: &Value) -> Result<()> {
    for field in ["title", "preamble"] {
        if a.get(field).is_some() && base[field] != doc[field] {
            return Err(conflict(&format!(
                "The note {field} changed since it was read. Read the note again."
            )));
        }
    }
    let block = |d: &Value, id: &str| {
        d["blocks"]
            .as_array()
            .and_then(|b| b.iter().find(|b| b["id"] == id))
            .cloned()
    };
    for e in a["edits"].as_array().into_iter().flatten() {
        let Some(id) = e["block_id"].as_str() else { continue };
        let now = block(doc, id);
        // Inserting only needs its anchor to exist; other operations need
        // the block exactly as it was read.
        if now.is_none() || (e["op"] != "insert_after" && now != block(base, id)) {
            return Err(conflict(&format!(
                "Block {id} changed since the note was read. Read the note again."
            )));
        }
    }
    Ok(())
}
fn validate_file(app: &App, a: &Value) -> Result<()> {
    let m = crate::workspace::snapshot(app, a["folder_id"].as_str().context("Folder required")?)?;
    if a["revision"] != m["revision"] {
        return Err(conflict("Project changed. Refresh and retry."));
    }
    let op = a["op"].as_str().context("Operation required")?;
    if ["create", "folder", "rename"].contains(&op) {
        let name = a["name"].as_str().context("Name required")?;
        crate::workspace::safe_path(name)?;
        if name.contains('/') {
            bail!("Choose a name, not a path");
        }
    }
    if ["edit", "rename", "move"].contains(&op) {
        let id = a["id"].as_str().context("Entry id required")?;
        let entry = m["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == id && e["deleted"] != true)
            .context("Entry not found")?;
        if op == "edit" && (entry["kind"] != "file" || entry.get("legacy").is_some()) {
            bail!("Use edit_note for notes; legacy media are immutable");
        }
        if op == "edit" {
            let target = a["folder_id"].as_str().unwrap();
            let path = crate::workspace::file_path(app, target, entry)?;
            if std::fs::metadata(&path)?.len() > 2 << 20 {
                bail!("Text exceeds 2 MB");
            }
            let bytes = std::fs::read(path)?;
            if std::str::from_utf8(&bytes)
                .ok()
                .is_none_or(|s| s.contains('\0'))
            {
                bail!("Only UTF-8 text files can be edited with this tool");
            }
        }
    }
    if op == "edit" && a["text"].as_str().is_none() {
        bail!("edit requires text");
    }
    if op == "move" && a["parent"].as_str().is_none() {
        bail!("move requires parent (empty for root)");
    }
    let entries = m["entries"].as_array().unwrap();
    let existing = entries
        .iter()
        .find(|e| e["id"] == a["id"] && e["deleted"] != true);
    let parent = if op == "rename" || op == "edit" {
        existing.and_then(|e| e["parent"].as_str()).unwrap_or("")
    } else {
        a["parent"].as_str().unwrap_or("")
    };
    if ["move", "create", "folder"].contains(&op) && !parent.is_empty() {
        let mut current = parent;
        let mut seen = std::collections::HashSet::new();
        while !current.is_empty() {
            if a["id"] == current || !seen.insert(current) {
                bail!("A folder cannot contain itself");
            }
            let e = entries
                .iter()
                .find(|e| e["id"] == current && e["kind"] == "folder" && e["deleted"] != true)
                .context("Parent folder not found")?;
            current = e["parent"].as_str().unwrap_or("");
        }
    }
    let name = if op == "move" {
        existing.and_then(|e| e["name"].as_str())
    } else {
        a["name"].as_str()
    };
    if let Some(name) = name {
        if entries.iter().any(|e| {
            e["deleted"] != true
                && e["id"] != a["id"]
                && e["parent"].as_str().unwrap_or("") == parent
                && e["name"] == name
        }) {
            bail!("A file with that name already exists in this folder");
        }
    }
    if a["text"].as_str().is_some_and(|t| t.len() > 2 << 20) {
        bail!("Text exceeds 2 MB");
    }
    Ok(())
}
fn validate_create(app: &App, a: &Value) -> Result<()> {
    let m = crate::workspace::snapshot(app, a["folder_id"].as_str().context("Folder required")?)?;
    if a["revision"] != m["revision"] {
        return Err(conflict("Project changed. Refresh before creating a note."));
    }
    let title = a["title"].as_str().context("Title required")?;
    if title.trim().is_empty() || title.chars().count() > 200 {
        bail!("Choose a title of 1–200 characters");
    }
    if a["latex"].as_str().is_some_and(|s| s.len() > 100_000) {
        bail!("Initial note text exceeds 100000 bytes");
    }
    if let Some(parent) = a["parent"].as_str().filter(|p| !p.is_empty()) {
        if !m["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == parent && e["kind"] == "folder" && e["deleted"] != true)
        {
            bail!("Parent folder not found");
        }
    }
    Ok(())
}
fn perform(app: &App, name: &str, a: &Value) -> Result<Value> {
    match name {
        "edit_note" => {
            let (mut doc, edits) = edited_note(app, a)?;
            let target = a["folder_id"].as_str().unwrap();
            let id = a["note_id"].as_str().unwrap();
            let folder = app.library.folder_id(target)?;
            let updated = app.notes.save(&folder, id, doc.clone())?;
            doc["updated"] = json!(updated);
            app.notes.remember(&folder, id, &doc);
            Ok(
                json!({"status":"applied","note_id":id,"folder_id":target,"updated":updated,"edits":edits}),
            )
        }
        "create_note" => crate::workspace::create_note(app, a["folder_id"].as_str().unwrap(), a),
        "edit_project_file" => {
            validate_file(app, a)?;
            let target = a["folder_id"].as_str().unwrap();
            let before = crate::workspace::snapshot(app, target)?;
            let m = crate::workspace::change(app, target, a, None)?;
            let changed:Vec<Value>=m["entries"].as_array().unwrap().iter().filter(|e|a["id"]==e["id"]||!before["entries"].as_array().unwrap().iter().any(|old|old["id"]==e["id"])).map(|e|json!({"id":e["id"],"note_id":e["note"],"name":e["name"],"parent":e["parent"],"kind":e["kind"]})).collect();
            Ok(
                json!({"status":"applied","folder_id":target,"revision":m["revision"],"entries":changed,"bib_error":m["bib_error"]}),
            )
        }
        _ => bail!("Unsupported reviewed operation"),
    }
}
pub fn change(app: &App, name: &str, a: &Value, mode: &str, chat: Option<&str>) -> Result<Value> {
    let _gate = GATE.lock().unwrap();
    match name {
        "edit_note" => {
            edited_note(app, a)?;
        }
        "create_note" => validate_create(app, a)?,
        "edit_project_file" => validate_file(app, a)?,
        _ => bail!("Unknown edit tool"),
    }
    if mode == "direct" {
        let result = perform(app, name, a)?;
        notify(app, name, a, chat, &result);
        return Ok(result);
    }
    let id = crate::library::id("e");
    let p = json!({"id":id,"tool":name,"args":a,"status":"proposed","chat_id":chat});
    store(app, &p)?;
    app.ui(json!({"action":"agent_edit_proposal","proposal_id":id,"chat_id":chat}));
    Ok(summary(&p))
}
fn notify(app: &App, name: &str, a: &Value, chat: Option<&str>, result: &Value) {
    app.ui(json!({"action":if name=="edit_note"{"note_changed"}else{"workspace_changed"},"target":a["folder_id"],"note_id":a["note_id"],"updated":result["updated"],"chat_id":chat}));
}
pub async fn list(State(app): Shared) -> ApiResult {
    let mut proposals = Vec::new();
    if let Ok(files) = std::fs::read_dir(app.notes.root.join(".agent-edits")) {
        for f in files.flatten() {
            if f.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(p) = std::fs::read(f.path())
                .map_err(anyhow::Error::from)
                .and_then(|b| Ok(serde_json::from_slice::<Value>(&b)?))
            {
                if p["status"] == "proposed" {
                    proposals.push(summary(&p));
                }
            }
        }
    }
    proposals.sort_by_key(|p| p["proposal_id"].as_str().unwrap_or("").to_owned());
    Ok(Json(json!(proposals)))
}
pub async fn get(State(app): Shared, Path(id): Path<String>) -> ApiResult {
    let mut p = load(&app, &id)?;
    if p["tool"] == "edit_note" {
        let a = &p["args"];
        p["before"] = note_state(
            &app,
            a["folder_id"].as_str().unwrap(),
            a["note_id"].as_str().unwrap(),
        )?
        .0;
    }
    if p["tool"] == "edit_project_file" && p["args"]["id"].is_string() {
        let a = &p["args"];
        let m = crate::workspace::snapshot(&app, a["folder_id"].as_str().unwrap())?;
        p["before_entry"] = m["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == a["id"])
            .cloned()
            .unwrap_or(Value::Null);
        if p["args"]["op"] == "edit" {
            let target = p["args"]["folder_id"].as_str().unwrap();
            let entry = &p["before_entry"];
            let path = crate::workspace::file_path(&app, target, entry)?;
            if std::fs::metadata(&path)?.len() <= 2 << 20 {
                let bytes = std::fs::read(path)?;
                p["before_text"] = std::str::from_utf8(&bytes)
                    .ok()
                    .filter(|s| !s.contains('\0'))
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null);
            }
        }
    }
    if p["args"]["parent"].is_string() {
        let a = &p["args"];
        let m = crate::workspace::snapshot(&app, a["folder_id"].as_str().unwrap())?;
        p["destination_name"] = if a["parent"] == "" {
            json!("Project root")
        } else {
            m["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["id"] == a["parent"] && e["deleted"] != true)
                .map(|e| e["name"].clone())
                .unwrap_or(json!("Folder no longer available"))
        };
    }
    Ok(Json(p))
}
pub async fn decide(State(app): Shared, Path(id): Path<String>, Json(b): Json<Value>) -> ApiResult {
    let _gate = GATE.lock().unwrap();
    let mut p = load(&app, &id)?;
    if p["status"] != "proposed" {
        return Ok(Json(summary(&p)));
    }
    match b["action"].as_str() {
        Some("reject") => p["status"] = json!("rejected"),
        Some("accept") => {
            let result = perform(&app, p["tool"].as_str().unwrap(), &p["args"])?;
            notify(
                &app,
                p["tool"].as_str().unwrap(),
                &p["args"],
                p["chat_id"].as_str(),
                &result,
            );
            p["status"] = json!("applied");
            p["result"] = result;
        }
        _ => bail_api()?,
    }
    store(&app, &p)?;
    Ok(Json(summary(&p)))
}
fn bail_api() -> Result<()> {
    bail!("Choose accept or reject")
}
