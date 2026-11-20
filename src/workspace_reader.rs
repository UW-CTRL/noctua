//! Reader metadata for project PDFs; source files are never rewritten.
use crate::{ApiResult, App, Shared};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex};
static GATE: Mutex<()> = Mutex::new(());
fn context(app: &App, target: &str, id: &str) -> Result<(Value, PathBuf)> {
    let manifest = crate::workspace::list(app, target)?;
    let entry = manifest["entries"]
        .as_array()
        .context("Missing files")?
        .iter()
        .find(|e| e["id"] == id && e["deleted"] != true && e["kind"] == "file")
        .context("PDF file not found")?;
    let name = entry["source_name"]
        .as_str()
        .or(entry["name"].as_str())
        .unwrap_or("");
    if crate::workspace::mime(name) != "application/pdf" {
        bail!("Choose a PDF file");
    }
    crate::workspace::file_path(app, target, entry)?;
    let identity = format!("{}:{}", id, entry["blob"]);
    let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let path = crate::workspace::dir(app, target)?
        .join(".workspace/reader")
        .join(format!("{hash}.json"));
    Ok((
        json!({"title":entry["name"],"has_pdf":true,"pdf_hash":entry["blob"],"project_file":true}),
        path,
    ))
}
fn read(path: &std::path::Path) -> Result<Value> {
    match std::fs::read(path) {
        Ok(data) => Ok(serde_json::from_slice(&data)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"annotations":[]})),
        Err(e) => Err(e.into()),
    }
}
fn save(path: &std::path::Path, value: &Value) -> Result<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec(value)?)?;
    std::fs::rename(temp, path)?;
    Ok(())
}
fn validate(a: &Value) -> Result<()> {
    if !["highlight", "comment", "ink"].contains(&a["kind"].as_str().unwrap_or("")) {
        bail!("Invalid annotation kind");
    }
    if a["page"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 10000)
        .is_none()
    {
        bail!("Invalid PDF page");
    }
    let color = a["color"].as_str().unwrap_or("");
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        bail!("Invalid annotation color");
    }
    if a["comment"].as_str().unwrap_or("").len() > 100000 {
        bail!("Comment is too long");
    }
    for (field, size, max) in [("rects", 4, 2000), ("points", 2, 20000)] {
        if let Some(values) = a[field].as_array() {
            if values.len() > max {
                bail!("Too many annotation coordinates");
            }
            for v in values {
                let coordinates = v.as_array().context("Invalid coordinates")?;
                if coordinates.len() != size && !(field == "points" && coordinates.len() == 3) {
                    bail!("Invalid coordinates");
                }
                for n in coordinates {
                    if !n.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)) {
                        bail!("Coordinates must be normalized");
                    }
                }
            }
        }
    }
    if a["kind"] == "highlight" && a["rects"].as_array().is_none_or(Vec::is_empty) {
        bail!("Select text to highlight");
    }
    if a["kind"] == "ink"
        && (a["points"].as_array().is_none_or(|p| p.len() < 2)
            || !a["width"]
                .as_f64()
                .is_some_and(|n| (0.0002..=0.03).contains(&n)))
    {
        bail!("Invalid drawing");
    }
    Ok(())
}
fn change(state: &mut Value, aid: Option<&str>, body: Value, delete: bool) -> Result<Value> {
    let list = state["annotations"]
        .as_array_mut()
        .context("Invalid reader data")?;
    if let Some(id) = aid {
        let index = list
            .iter()
            .position(|a| a["id"] == id)
            .context("Annotation not found")?;
        if list[index]["revision"] != body["revision"] {
            return Err(crate::Status(
                axum::http::StatusCode::CONFLICT,
                "Annotation changed. Reload before saving.".into(),
            )
            .into());
        }
        if delete {
            list.remove(index);
            return Ok(json!({"ok":true}));
        }
        let mut a = list[index].clone();
        for field in ["comment", "color"] {
            if let Some(value) = body.get(field) {
                a[field] = value.clone();
            }
        }
        validate(&a)?;
        a["revision"] = json!(a["revision"].as_u64().unwrap_or(0) + 1);
        list[index] = a.clone();
        Ok(a)
    } else {
        let mut a = body;
        validate(&a)?;
        a["id"] = json!(uuid::Uuid::new_v4().to_string());
        a["revision"] = json!(1);
        a["author"] = json!("user");
        a["status"] = json!("accepted");
        a["replies"] = json!([]);
        a["created"] = json!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis());
        list.push(a.clone());
        Ok(a)
    }
}
pub async fn metadata(State(app): Shared, Path((target, id)): Path<(String, String)>) -> ApiResult {
    Ok(Json(
        tokio::task::spawn_blocking(move || context(&app, &target, &id).map(|(value, _)| value))
            .await??,
    ))
}
pub async fn annotations(
    State(app): Shared,
    Path((target, id)): Path<(String, String)>,
) -> ApiResult {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            let _guard = GATE.lock().unwrap();
            let (_, path) = context(&app, &target, &id)?;
            Ok::<_, anyhow::Error>(read(&path)?["annotations"].clone())
        })
        .await??,
    ))
}
async fn mutate(
    app: std::sync::Arc<App>,
    target: String,
    id: String,
    aid: Option<String>,
    body: Value,
    delete: bool,
) -> ApiResult {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            let _guard = GATE.lock().unwrap();
            let (_, path) = context(&app, &target, &id)?;
            let mut state = read(&path)?;
            let result = change(&mut state, aid.as_deref(), body, delete)?;
            save(&path, &state)?;
            Ok::<_, anyhow::Error>(result)
        })
        .await??,
    ))
}
pub async fn create(
    State(app): Shared,
    Path((target, id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult {
    mutate(app, target, id, None, body, false).await
}
pub async fn update(
    State(app): Shared,
    Path((target, id, aid)): Path<(String, String, String)>,
    Json(body): Json<Value>,
) -> ApiResult {
    mutate(app, target, id, Some(aid), body, false).await
}
#[derive(Deserialize)]
pub struct Revision {
    revision: u64,
}
pub async fn delete(
    State(app): Shared,
    Path((target, id, aid)): Path<(String, String, String)>,
    Query(q): Query<Revision>,
) -> ApiResult {
    mutate(
        app,
        target,
        id,
        Some(aid),
        json!({"revision":q.revision}),
        true,
    )
    .await
}
pub async fn history() -> ApiResult {
    Ok(Json(json!({"undo":null,"redo":null})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn annotations_preserve_conflicts_and_validate_geometry() -> Result<()> {
        let mut s = json!({"annotations":[]});
        let a = change(
            &mut s,
            None,
            json!({"kind":"highlight","page":1,"color":"#ff0000","rects":[[0.1,0.2,0.3,0.1]],"comment":""}),
            false,
        )?;
        let id = a["id"].as_str().unwrap();
        let edited = change(
            &mut s,
            Some(id),
            json!({"revision":1,"comment":"note"}),
            false,
        )?;
        assert_eq!(edited["revision"], 2);
        assert!(change(
            &mut s,
            Some(id),
            json!({"revision":1,"comment":"stale"}),
            false
        )
        .is_err());
        assert_eq!(s["annotations"][0]["comment"], "note");
        assert!(change(
            &mut s,
            None,
            json!({"kind":"ink","page":1,"color":"#fff000","points":[[-1,0],[0,0]],"width":0.003}),
            false
        )
        .is_err());
        change(&mut s, Some(id), json!({"revision":2}), true)?;
        assert_eq!(s["annotations"], json!([]));
        Ok(())
    }
}
