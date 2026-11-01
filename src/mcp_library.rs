//! Agent-facing Library organization uses the same atomic, revision-checked
//! operations as the UI. Project-file Trash remains a separate workspace feature.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::App;

fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .with_context(|| format!("Missing argument: {key}"))
}

pub fn list(app: &App, args: &Value) -> Result<Value> {
    let state = app.library.management_state()?;
    let query = args["query"].as_str().unwrap_or("").trim().to_lowercase();
    let items = state["trash"].as_array().unwrap().iter()
        .filter(|entry| args.get("kind").is_none_or(|kind| entry["kind"] == *kind))
        .filter_map(|entry| {
            let title = entry["data"]["title"].as_str().or(entry["data"]["name"].as_str()).unwrap_or("");
            if !query.is_empty() && !format!("{} {title}", entry["id"].as_str().unwrap_or("")).to_lowercase().contains(&query) { return None; }
            Some(json!({"kind":entry["kind"],"id":entry["id"],"title":title.chars().take(2000).collect::<String>(),"deleted":entry["deleted"],"batch":entry["batch"],"merged_into":entry["merged_into"],"restorable":entry["merged_into"].is_null()}))
        }).collect();
    let mut out = crate::mcp_data::page(items, args, 50);
    out["library_revision"] = state["revision"].clone();
    Ok(out)
}

pub fn change(app: &App, name: &str, args: &Value) -> Result<Value> {
    if name == "edit_collection" && matches!(arg(args, "op")?, "create" | "rename") {
        let id = if args["op"] == "create" {
            app.library
                .create_collection(arg(args, "parent")?, arg(args, "name")?)?
        } else {
            let id = arg(args, "folder_id")?;
            app.library.rename(id, arg(args, "name")?)?;
            id.to_owned()
        };
        return Ok(
            json!({"status":"applied","collection_id":id,"name":arg(args,"name")?,"library_revision":app.library.collections()?["library_revision"]}),
        );
    }
    let revision = args["library_revision"]
        .as_i64()
        .context("Read the current library_revision before changing Library organization")?;
    let mut body = json!({"revision":revision});
    match name {
        "trash_papers" => {
            let papers = args["papers"]
                .as_array()
                .filter(|p| !p.is_empty())
                .context("Choose at least one paper")?;
            body["op"] = json!("trash");
            body["papers"] = json!(papers
                .iter()
                .map(|p| json!({"key":p["paper_key"],"revision":p["revision"]}))
                .collect::<Vec<_>>());
        }
        "restore_library_trash" => {
            body["op"] = json!("restore");
            body["kind"] = args["kind"].clone();
            body["ids"] = args["ids"].clone();
        }
        "purge_library_trash" => {
            if args["confirm"] != true {
                bail!("Permanent deletion requires confirm=true");
            }
            body["op"] = json!("purge");
            body["entries"] = args["entries"].clone();
        }
        "edit_collection" => match arg(args, "op")? {
            "move" => {
                body["op"] = json!("folder_move");
                body["target"] = json!(arg(args, "folder_id")?);
                body["parent"] = json!(arg(args, "parent")?);
                if args.get("anchor").is_some() != args.get("position").is_some() {
                    bail!("Supply anchor and position together");
                }
                if args.get("anchor").is_some() {
                    body["anchor"] = json!(arg(args, "anchor")?);
                    body["position"] = json!(arg(args, "position")?);
                }
            }
            "reorder" => {
                body["op"] = json!("folder_order");
                body["parent"] = json!(arg(args, "parent")?);
                body["ids"] = args["folder_ids"].clone();
            }
            "trash" => {
                body["op"] = json!("folder_trash");
                body["target"] = json!(arg(args, "folder_id")?);
            }
            _ => bail!("Unsupported collection operation"),
        },
        _ => bail!("Unsupported Library operation"),
    }
    let mut result = app.library.manage(&body)?;
    result["status"] = json!("applied");
    result["library_revision"] = result["revision"].take();
    result.as_object_mut().unwrap().remove("revision");
    if name == "purge_library_trash" {
        result["warnings"] = json!(app.library.cleanup_purged_folders(&app.notes.root));
    }
    Ok(result)
}
