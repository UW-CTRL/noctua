//! Bounded agent access to saved-paper information and personal memos.
use crate::App;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub fn run(app: &App, name: &str, args: &Value) -> Result<Value> {
    let key = || {
        args["paper_key"]
            .as_str()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .context("Choose a saved local paper")
    };
    match name {
        "edit_paper_info" => {
            let fields = args["fields"]
                .as_object()
                .filter(|fields| !fields.is_empty())
                .context("Choose at least one field to edit")?;
            let mut patch = json!({"revision":args["revision"]});
            for (field, value) in fields {
                if field == "tags"
                    && value
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|tag| tag.as_str().unwrap().trim().is_empty())
                {
                    bail!("Tag names cannot be blank");
                }
                patch[match field.as_str() {
                    "doi" => "DOI",
                    "abstract" => "abstractNote",
                    field => field,
                }] = value.clone();
            }
            let saved = app.library.edit(key()?, &patch)?;
            Ok(
                json!({"status":"applied","paper_key":key()?,"revision":saved["revision"],"changed_fields":fields.keys().collect::<Vec<_>>()}),
            )
        }
        "list_paper_memos" => {
            let memos = app.library.paper_memos(key()?)?;
            let items = memos
                .as_array()
                .unwrap()
                .iter()
                .filter(|memo| args.get("memo_id").is_none_or(|id| memo["id"] == *id))
                .cloned()
                .collect();
            let mut page = crate::mcp_data::page(items, args, 10);
            page["paper_key"] = json!(key()?);
            Ok(page)
        }
        "edit_paper_memo" => {
            let op = args["op"].as_str().context("Choose a memo operation")?;
            let mut body = json!({"op":op});
            match op {
                "create" => {
                    if args.get("memo_id").is_some() || args.get("revision").is_some() {
                        bail!("New memos do not have a memo_id or revision");
                    }
                    body["text"] = json!(args["text"].as_str().context("Enter memo text")?);
                }
                "edit" | "delete" => {
                    body["id"] = json!(args["memo_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .context("Read the memo_id first")?);
                    body["revision"] = json!(args["revision"]
                        .as_i64()
                        .context("Read the memo revision first")?);
                    if op == "edit" {
                        body["text"] = json!(args["text"]
                            .as_str()
                            .context("Enter replacement memo text")?);
                    } else if args.get("text").is_some() {
                        bail!("Delete does not accept replacement text");
                    }
                }
                _ => bail!("Unknown memo operation"),
            }
            let (_, memo) = app.library.change_paper_memo_result(key()?, &body)?;
            Ok(json!({"status":"applied","paper_key":key()?,"memo":memo}))
        }
        "get_paper_info_layout" => {
            Ok(json!({"sections":app.settings.lock().unwrap().library.paper_info_sections}))
        }
        "set_paper_info_layout" => crate::settings::set_paper_info_layout(
            app,
            crate::settings::parse_paper_info_sections(&args["sections"])?,
            crate::settings::parse_paper_info_sections(&args["previous_sections"])?,
        ),
        _ => bail!("Unknown Paper Info operation"),
    }
}
