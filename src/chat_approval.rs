//! File-edit permission is scoped to one file in one running prompt.
//! Only the user-facing decision endpoint grants it. A chat reply cannot grant it.
use std::{collections::HashMap, path::PathBuf, sync::{Mutex, OnceLock}, time::Duration};
use anyhow::{Context, Result};
use axum::{extract::{Path, State}, Json};
use serde_json::{json, Value};
use crate::{App, Shared, ApiResult};

struct FileApproval { id: String, decision: Option<bool>, changes: Vec<Value> }
struct Approval { root: PathBuf, chat: String, files: HashMap<String, FileApproval> }
static TURNS: OnceLock<Mutex<HashMap<String, Approval>>> = OnceLock::new();
fn turns() -> &'static Mutex<HashMap<String, Approval>> { TURNS.get_or_init(Default::default) }

pub struct Turn(pub String);
impl Turn {
    pub fn begin(app: &App, chat: &str) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        turns().lock().unwrap().insert(id.clone(), Approval { root: app.data_dir.clone(), chat: chat.into(), files: HashMap::new() });
        Self(id)
    }
}
// Includes errors, Stop, disconnection, and unwinding: old MCP URLs cannot reuse approval.
impl Drop for Turn { fn drop(&mut self) { turns().lock().unwrap().remove(&self.0); } }
fn check<'a>(map: &'a mut HashMap<String, Approval>, app: &App, id: &str, chat: Option<&str>) -> Result<&'a mut Approval> {
    let a = map.get_mut(id).context("This prompt has finished; edit permission expired")?;
    anyhow::ensure!(a.root == app.data_dir && chat == Some(a.chat.as_str()), "Approval belongs to another chat");
    Ok(a)
}

// Existing files use stable IDs, so renaming/moving never requests permission
// again. New entries use their parent/name until the successful create returns
// a stable ID. Project IDs are part of every key: equal filenames do not share grants.
fn file_key(args: &Value) -> Result<String> {
    let target=args["folder_id"].as_str().context("Missing folder_id")?;
    let op=args["op"].as_str().context("Missing op")?;
    anyhow::ensure!(["edit","create","folder","rename","move"].contains(&op), "Unsupported file operation");
    Ok(if op=="create" || op=="folder" {
        json!([target,"new",args["parent"].as_str().unwrap_or(""),args["name"].as_str().context("Missing name")?]).to_string()
    } else { json!([target,"id",args["id"].as_str().context("Missing file id")?]).to_string() })
}

// Bind a newly created entry to its permission before the agent can edit it.
// Failed creates never grant permission to an unrelated, already-existing file.
pub fn created(app: &App, turn: &str, chat: Option<&str>, args: &Value, response: &Value) {
    if !["create","folder"].contains(&args["op"].as_str().unwrap_or("")) || response["result"]["isError"]==true { return; }
    let Some(text)=response["result"]["content"][0]["text"].as_str() else {return};
    let Ok(manifest)=serde_json::from_str::<Value>(text) else {return};
    let Some(entry)=manifest["entries"].as_array().and_then(|entries|entries.iter().find(|e|e["name"]==args["name"] && e["parent"].as_str().unwrap_or("")==args["parent"].as_str().unwrap_or("") && e["deleted"]!=true)) else {return};
    let Ok(old)=file_key(args) else {return};
    let mut edited=args.clone();edited["op"]=json!("edit");edited["id"]=entry["id"].clone();
    let Ok(new)=file_key(&edited) else {return};
    let mut map=turns().lock().unwrap();
    if let Ok(a)=check(&mut map,app,turn,chat) { if let Some(permission)=a.files.remove(&old) { a.files.insert(new,permission); } }
}

pub async fn authorize(app: &App, id: &str, chat: Option<&str>, args: &Value) -> Result<()> {
    let key=file_key(args)?;
    // Read and validate the snapshot before displaying it. Execution still uses
    // workspace::change's original revision check after approval, so a user's
    // intervening edits can never be silently overwritten.
    {
        let mut map = turns().lock().unwrap();
        match check(&mut map, app, id, chat)?.files.get(&key).and_then(|f|f.decision) {
            Some(true) => return Ok(()),
            Some(false) => anyhow::bail!("User declined edits to this file for this prompt"),
            None => {}
        }
    }
    let target = args["folder_id"].as_str().context("Missing folder_id")?;
    let op = args["op"].as_str().context("Missing op")?;
    anyhow::ensure!(["edit", "create", "folder", "rename", "move"].contains(&op), "Unsupported file operation");
    let manifest = crate::workspace::list(app, target)?;
    anyhow::ensure!(manifest["revision"] == args["revision"], "Project changed. Read the project again before proposing edits");
    let entry = manifest["entries"].as_array().unwrap().iter().find(|e|e["id"]==args["id"] && e["deleted"]!=true);
    let before = if op == "edit" { crate::workspace::read(app, target, args["id"].as_str().context("Missing file id")?)?["text"].clone() } else { Value::Null };
    let proposal = json!({"target":target,"op":op,"name":entry.map(|e|&e["name"]).unwrap_or(&args["name"]),"before":before,"after":args["text"],"new_name":args["name"],"parent":args["parent"]});
    let approval_id = {
        let mut map = turns().lock().unwrap();
        let a = check(&mut map, app, id, chat)?;
        anyhow::ensure!(a.files.contains_key(&key) || a.files.len()<100, "Too many pending files");
        let file=a.files.entry(key.clone()).or_insert_with(||FileApproval {id:uuid::Uuid::new_v4().to_string(),decision:None,changes:vec![]});
        if file.decision.is_none() {
            anyhow::ensure!(file.changes.len()<100, "Too many pending edits");
            file.changes.push(proposal);
            app.ui(json!({"action":"file_edit_approval","chat_id":chat,"turn_id":id,"approval_id":file.id,"changes":file.changes}));
        }
        file.id.clone()
    };
    // Parallel calls for the same file share a decision; different files do not.
    // No mutex is held while waiting. Normal revision checks still apply.
    let began = std::time::Instant::now();
    loop {
        {
            let mut map = turns().lock().unwrap();
            match check(&mut map, app, id, chat)?.files.values().find(|f|f.id==approval_id).and_then(|f|f.decision) {
                Some(true) => return Ok(()),
                Some(false) => anyhow::bail!("User declined edits to this file for this prompt"),
                None => {}
            }
        }
        anyhow::ensure!(began.elapsed()<Duration::from_secs(300), "File edit approval timed out; no permission granted");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn decide(State(app): Shared, Path(id): Path<String>, Json(body): Json<Value>) -> ApiResult {
    let mut map = turns().lock().unwrap();
    let a = check(&mut map, &app, &id, body["chat_id"].as_str())?;
    let file=a.files.values_mut().find(|f|Some(f.id.as_str())==body["approval_id"].as_str()).context("Unknown file approval")?;
    if file.changes.is_empty() || file.decision.is_some() { return Err(anyhow::anyhow!("This approval is no longer pending").into()); }
    file.decision = Some(body["approve"].as_bool().context("Missing approval decision")?);
    Ok(Json(json!({"approved":file.decision})))
}
