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
        .route("/api/library/papers/{key}/outline",get(outline).post(generate_outline))
        .route("/api/library/papers/{key}/auto-highlight",post(auto_highlight))
        .route("/api/library/papers/{key}/page-image/{page}",post(page_image).layer(DefaultBodyLimit::max(5<<20)))
        .route("/api/library/papers/{key}/annotations",get(annotations).post(annotate))
        .route("/api/library/papers/{key}/annotations/{id}",axum::routing::put(update_annotation).delete(delete_annotation))
        .route("/api/library/papers/{key}/annotations/{id}/reply",post(reply))
        .route("/api/library/papers/{key}/annotations/{id}/resolve-reply",post(resolve_reply))
}
async fn pdf_asset(Path(file):Path<String>)->Response {
    let Some((_,bytes))=PDF_ASSETS.iter().find(|(name,_)|*name==file) else{return StatusCode::NOT_FOUND.into_response()};
    let mime=if file.ends_with(".mjs")||file.ends_with(".js"){"text/javascript"}else if file.ends_with(".wasm"){"application/wasm"}else if file.ends_with(".ttf"){"font/ttf"}else{"application/octet-stream"};
    ([(header::CONTENT_TYPE,mime),(header::X_CONTENT_TYPE_OPTIONS,"nosniff"),(header::CACHE_CONTROL,"public, max-age=86400")],*bytes).into_response()
}
#[derive(Deserialize)]struct Import {#[serde(default)] copy_pdfs:bool}
async fn import_zotero(State(app):Shared,Json(b):Json<Import>)->ApiResult {
    let result=tokio::task::spawn_blocking(move||app.library.import_zotero(&app.zotero,b.copy_pdfs)).await.map_err(|e|ApiError(e.into()))??;Ok(Json(result))
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
    let chat_id=chat_id.context("Open this PDF in Noctua to prepare its text for the assistant")?;
    app.ui(json!({"action":"pdf_index","key":key,"chat_id":chat_id}));
    for _ in 0..300 {tokio::time::sleep(std::time::Duration::from_millis(200)).await;if let Some(index)=app.library.index(key)?{return Ok(index);}}
    bail!("PDF text is not ready yet. Open the paper in the reader and try again; encrypted PDFs need to be unlocked there first.")
}
pub async fn page_for_agent(app:&App,key:&str,page:u32,chat_id:Option<&str>)->Result<Value> {
    use base64::Engine;
    let index=ensure_index(app,key,chat_id).await?;
    if page==0||page as usize>index["pages"].as_array().map_or(0,Vec::len){bail!("Page is outside the PDF");}
    if app.library.page_image(key,page)?.is_none(){app.ui(json!({"action":"pdf_page","key":key,"page":page,"chat_id":chat_id}));}
    for _ in 0..300 {
        if let Some(png)=app.library.page_image(key,page)?{return Ok(json!([
            {"type":"image","data":base64::engine::general_purpose::STANDARD.encode(png),"mimeType":"image/png"},
            {"type":"text","text":format!("PDF {key}, page {page}")}
        ]));}
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    bail!("Could not render the PDF page. Open it in the reader and try again.")
}
