//! Native library/PDF HTTP API and the bridge from MCP to the browser's PDF renderer.
use std::sync::Arc;
use anyhow::{bail, Context, Result};
use axum::{body::Bytes, extract::{DefaultBodyLimit, Path, Query, State}, http::{header, StatusCode}, response::{IntoResponse, Response}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::{App, ApiResult, ApiError, Shared, library::PDF_LIMIT};
include!(concat!(env!("OUT_DIR"), "/pdf_assets.rs"));

pub fn routes()->Router<Arc<App>> {
    Router::new()
        .route("/pdf.js",get(||async{crate::asset(include_str!("../web/pdf.js"),"text/javascript; charset=utf-8")}))
        .route("/library.js",get(||async{crate::asset(include_str!("../web/library.js"),"text/javascript; charset=utf-8")}))
        .route("/pdf.css",get(||async{crate::asset(include_str!("../web/pdf.css"),"text/css; charset=utf-8")}))
        .route("/vendor/pdfjs/{*file}",get(pdf_asset))
        .route("/api/library/import-zotero",post(import_zotero))
        .route("/api/library/import-pdf",post(import_pdf).layer(DefaultBodyLimit::max(PDF_LIMIT)))
        .route("/api/library/papers/{key}",get(paper).put(edit_paper))
        .route("/api/library/papers/{key}/membership",post(membership))
        .route("/api/library/papers/{key}/download",post(download))
        .route("/api/library/papers/{key}/pdf",get(pdf).put(attach_pdf).layer(DefaultBodyLimit::max(PDF_LIMIT)))
        .route("/api/library/papers/{key}/index",get(index).put(save_index).layer(DefaultBodyLimit::max(64<<20)))
        .route("/api/library/papers/{key}/outline",get(outline).post(generate_outline).delete(delete_outline))
        .route("/api/library/papers/{key}/auto-highlight",post(auto_highlight))
        .route("/api/library/papers/{key}/page-image/{page}",post(page_image).layer(DefaultBodyLimit::max(5<<20)))
        .route("/api/library/papers/{key}/annotation-history",get(annotation_history).post(annotation_undo))
        .route("/api/library/papers/{key}/annotations",get(annotations).post(annotate))
        .route("/api/library/papers/{key}/annotations/{id}",axum::routing::put(update_annotation).delete(delete_annotation))
        .route("/api/library/papers/{key}/annotations/{id}/reply",post(reply))
        .route("/api/library/papers/{key}/annotations/{id}/resolve-reply",post(resolve_reply))
        .route("/api/note-drawings/{target}/{note}/{block}/{updated}",post(save_drawing).layer(DefaultBodyLimit::max(5<<20)))
}
async fn pdf_asset(Path(file):Path<String>)->Response {
    let Some((_,bytes))=PDF_ASSETS.iter().find(|(name,_)|*name==file) else{return StatusCode::NOT_FOUND.into_response()};
    let mime=if file.ends_with(".mjs")||file.ends_with(".js"){"text/javascript"}else if file.ends_with(".wasm"){"application/wasm"}else if file.ends_with(".ttf"){"font/ttf"}else{"application/octet-stream"};
    ([(header::CONTENT_TYPE,mime),(header::X_CONTENT_TYPE_OPTIONS,"nosniff"),(header::CACHE_CONTROL,"public, max-age=86400")],*bytes).into_response()
}
async fn import_zotero(State(app):Shared,Json(mut b):Json<crate::zotero::ImportOptions>)->ApiResult {
    if b.pdf_mode.is_none() { b.pdf_mode=Some(app.settings.lock().unwrap().zotero_pdf_mode); }
    let result=tokio::task::spawn_blocking(move||app.library.import_zotero(&app.zotero,&app.notes,&b)).await.map_err(|e|ApiError(e.into()))??;Ok(Json(result))
}
#[derive(Deserialize)]struct Upload {target:Option<String>,#[serde(default)]name:String}
async fn import_pdf(State(app):Shared,Query(q):Query<Upload>,body:Bytes)->ApiResult {
    let key=app.library.upload(q.target.as_deref().unwrap_or("L1"),&q.name,&body)?;Ok(Json(app.library.paper(&key)?))
}
async fn paper(State(app):Shared,Path(key):Path<String>)->ApiResult {Ok(Json(app.library.paper(&key)?))}
async fn edit_paper(State(app):Shared,Path(key):Path<String>,Json(b):Json<Value>)->ApiResult {Ok(Json(app.library.edit(&key,&b)?))}
#[derive(Deserialize)]struct Membership {target:String,#[serde(default)]remove:bool}
async fn membership(State(app):Shared,Path(key):Path<String>,Json(b):Json<Membership>)->ApiResult {
    if b.remove{app.library.remove_membership(&key,&b.target)?;}else{app.library.add_membership(&key,&b.target)?;}Ok(Json(json!({"ok":true})))
}
async fn download(State(app):Shared,Path(key):Path<String>)->ApiResult {app.library.download(&key).await?;Ok(Json(app.library.paper(&key)?))}
async fn pdf(State(app):Shared,Path(key):Path<String>)->Result<Response,ApiError> {
    let bytes=std::fs::read(app.library.pdf_path(&key)?)?;
    Ok(([(header::CONTENT_TYPE,"application/pdf"),(header::X_CONTENT_TYPE_OPTIONS,"nosniff"),(header::CONTENT_DISPOSITION,"inline"),(header::CACHE_CONTROL,"private, max-age=86400")],bytes).into_response())
}
async fn attach_pdf(State(app):Shared,Path(key):Path<String>,body:Bytes)->ApiResult {app.library.attach_pdf(&key,&body)?;Ok(Json(app.library.paper(&key)?))}
async fn index(State(app):Shared,Path(key):Path<String>)->ApiResult {Ok(Json(app.library.index(&key)?.unwrap_or(Value::Null)))}
async fn save_index(State(app):Shared,Path(key):Path<String>,Json(b):Json<Value>)->ApiResult {app.library.save_index(&key,&b)?;Ok(Json(json!({"ok":true})))}
async fn outline(State(app):Shared,Path(key):Path<String>)->ApiResult {Ok(Json(json!(app.library.outline(&key)?)))}
async fn delete_outline(State(app):Shared,Path(key):Path<String>)->ApiResult {
    crate::pdf_outline::delete(&app,&key).await?;Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]struct OutlineRequest {#[serde(default)] regenerate:bool}
async fn generate_outline(State(app):Shared,Path(key):Path<String>,Json(body):Json<OutlineRequest>)->ApiResult {
    Ok(Json(crate::pdf_outline::generate(&app,&key,body.regenerate).await?))
}
async fn auto_highlight(State(app):Shared,Path(key):Path<String>)->ApiResult {
    Ok(Json(crate::pdf_autohighlight::generate(&app,&key).await?))
}
async fn page_image(State(app):Shared,Path((key,page)):Path<(String,u32)>,body:Bytes)->ApiResult {app.library.save_page_image(&key,page,&body)?;Ok(Json(json!({"ok":true})))}
async fn annotations(State(app):Shared,Path(key):Path<String>)->ApiResult {Ok(Json(json!(app.library.annotations(&key)?)))}
async fn annotate(State(app):Shared,Path(key):Path<String>,Json(mut b):Json<Value>)->ApiResult {
    if b["color"].is_null() {if let Some(color)=app.settings.lock().unwrap().highlight_colors.color(b["category"].as_str().unwrap_or("")) {b["color"]=json!(color);}}
    Ok(Json(app.library.annotate(&key,&b,"user",false)?))
}
async fn update_annotation(State(app):Shared,Path((key,id)):Path<(String,String)>,Json(b):Json<Value>)->ApiResult {Ok(Json(app.library.update_annotation(&key,&id,&b)?))}
#[derive(Deserialize)]struct Revision {revision:i64}
async fn delete_annotation(State(app):Shared,Path((key,id)):Path<(String,String)>,Query(q):Query<Revision>)->ApiResult {app.library.delete_annotation(&key,&id,q.revision)?;Ok(Json(json!({"ok":true})))}
#[derive(Deserialize)]struct Reply {comment:String}
async fn reply(State(app):Shared,Path((key,id)):Path<(String,String)>,Json(b):Json<Reply>)->ApiResult {Ok(Json(app.library.reply(&key,&id,&b.comment,"user",false)?))}
#[derive(Deserialize)]struct ResolveReply {reply_id:String,accept:bool}
async fn resolve_reply(State(app):Shared,Path((key,id)):Path<(String,String)>,Json(b):Json<ResolveReply>)->ApiResult {Ok(Json(app.library.resolve_reply(&key,&id,&b.reply_id,b.accept)?))}

/// PDF.js indexes documents locally in the active chat's page. This also works
/// for PDFs that are not open in the reader; the UI does the work in the background.
pub async fn ensure_index(app:&App,key:&str,chat_id:Option<&str>)->Result<Value> {
    if let Some(index)=app.library.index(key)?{return Ok(index);}
    let chat_id=active_chat(app,chat_id)?;
    app.ui(json!({"action":"pdf_index","key":key,"chat_id":chat_id}));
    for _ in 0..300 {active_chat(app,Some(chat_id))?;tokio::time::sleep(std::time::Duration::from_millis(200)).await;if let Some(index)=app.library.index(key)?{return Ok(index);}}
    bail!("PDF text is not ready yet. Open the paper in the reader and try again; encrypted PDFs need to be unlocked there first.")
}
pub async fn page_for_agent(app:&App,key:&str,page:u32,chat_id:Option<&str>)->Result<Value> {
    use base64::Engine;
    let index=ensure_index(app,key,chat_id).await?;
    if page==0||page as usize>index["pages"].as_array().map_or(0,Vec::len){bail!("Page is outside the PDF");}
    if app.library.page_image(key,page)?.is_none(){let chat=active_chat(app,chat_id)?;app.ui(json!({"action":"pdf_page","key":key,"page":page,"chat_id":chat}));}
    for _ in 0..300 {
        if let Some(png)=app.library.page_image(key,page)?{return Ok(json!([
            {"type":"image","data":base64::engine::general_purpose::STANDARD.encode(png),"mimeType":"image/png"},
            {"type":"text","text":format!("PDF {key}, page {page}")}
        ]));}
        active_chat(app,chat_id)?;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    bail!("Could not render the PDF page. Open it in the reader and try again.")
}

fn active_chat<'a>(app:&App,chat:Option<&'a str>)->Result<&'a str>{
 let id=chat.context("UI_REQUIRED: open a Noctua chat to prepare uncached PDF text or images")?;
 if !app.chat_jobs.lock().unwrap().contains(id){bail!("UI_REQUIRED: no active Noctua chat renderer; open the PDF or drawing in the app first");}Ok(id)
}
fn drawing_path(app:&App,target:&str,note:&str,block:&str,updated:u64)->Result<std::path::PathBuf>{
 crate::notes::check_id(note)?;crate::notes::check_id(block)?;let folder=app.library.folder_id(target)?;
 Ok(app.notes.root.join(folder).join(".drawing-previews").join(format!("{note}-{block}-{updated}.png")))
}
async fn save_drawing(State(app):Shared,Path((target,note,block,updated)):Path<(String,String,String,u64)>,bytes:Bytes)->ApiResult{
 let(doc,entry)=crate::mcp_edits::note_state(&app,&target,&note)?;
 if entry["deleted"]==true||doc["updated"]!=updated||!doc["blocks"].as_array().unwrap().iter().any(|b|b["id"]==block&&b["type"]=="ink"){return Err(crate::Status(StatusCode::CONFLICT,"Drawing changed. Read the note again.".into()).into());}
 if !bytes.starts_with(b"\x89PNG\r\n\x1a\n"){return Err(crate::Status(StatusCode::BAD_REQUEST,"Expected a PNG preview".into()).into());}
 let path=drawing_path(&app,&target,&note,&block,updated)?;std::fs::create_dir_all(path.parent().unwrap())?;std::fs::write(path,bytes)?;Ok(Json(json!({"status":"cached"})))
}
pub async fn drawing_for_agent(app:&App,a:&Value,chat:Option<&str>)->Result<Value>{
 use base64::{Engine,engine::general_purpose::STANDARD};
 let target=a["folder_id"].as_str().context("Folder required")?;let note=a["note_id"].as_str().context("Note required")?;let block=a["block_id"].as_str().context("Block required")?;
 let(doc,entry)=crate::mcp_edits::note_state(app,target,note)?;if entry["deleted"]==true{bail!("Restore the note before viewing its drawing");}
 let ink=doc["blocks"].as_array().unwrap().iter().find(|b|b["id"]==block&&b["type"]=="ink").context("Drawing block not found")?;
 if ink["strokes"].as_array().is_none_or(Vec::is_empty){bail!("Drawing block is empty");}
 let path=drawing_path(app,target,note,block,doc["updated"].as_u64().unwrap())?;
 if !path.exists(){let chat=active_chat(app,chat)?;app.ui(json!({"action":"note_drawing","folder_id":target,"note_id":note,"block_id":block,"updated":doc["updated"],"chat_id":chat}));
  for _ in 0..100{if path.exists(){break;}tokio::time::sleep(std::time::Duration::from_millis(100)).await;}
 }
 let bytes=std::fs::read(path).context("UI_REQUIRED: drawing preview is not ready; retry from an active Noctua chat")?;
 if bytes.len()>5<<20{bail!("Drawing preview exceeds 5 MB");}
 Ok(json!([{"type":"image","data":STANDARD.encode(bytes),"mimeType":"image/png"},{"type":"text","text":format!("Note {note}, block {block}, updated {}",doc["updated"])}]))
}

async fn annotation_history(State(app):Shared,Path(key):Path<String>)->ApiResult{Ok(Json(app.library.annotation_history(&key,None)?))}
async fn annotation_undo(State(app):Shared,Path(key):Path<String>,Json(b):Json<Value>)->ApiResult{Ok(Json(app.library.annotation_history(&key,Some(&b))?))}
