//! Shared, content-addressed note attachments. Video responses support seeking.
use std::path::PathBuf;
use anyhow::{bail, Context, Result};
use axum::{body::Body, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_stream::StreamExt;
use crate::{ApiResult, Shared};

const MAX_BYTES: usize = 512 << 20;

/// SVG is text: skip a BOM, whitespace, an XML declaration, comments and a
/// doctype, then require the root `<svg` element.
fn is_svg(b: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(&b[..b.len().min(4096)]).or_else(|e| std::str::from_utf8(&b[..e.valid_up_to()])) else { return false };
    let mut rest = text.trim_start_matches('\u{feff}');
    loop {
        rest = rest.trim_start();
        let skip = |rest: &str, open: &str, close: &str| rest.strip_prefix(open).and_then(|r| r.find(close).map(|i| r[i + close.len()..].to_owned()));
        if let Some(r) = skip(rest, "<?xml", "?>").or_else(|| skip(rest, "<!--", "-->")).or_else(|| skip(rest, "<!DOCTYPE", ">")) {
            let start = text.len() - r.len();
            rest = &text[start..];
            continue;
        }
        return rest.starts_with("<svg") && rest[4..].starts_with(|c: char| c.is_whitespace() || c == '>');
    }
}

fn identify(b: &[u8]) -> Option<&'static str> {
    if is_svg(b) { return Some("svg"); }
    if b.starts_with(b"\x89PNG\r\n\x1a\n") { return Some("png"); }
    if b.starts_with(b"\xff\xd8\xff") { return Some("jpg"); }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") { return Some("gif"); }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") { return Some("webp"); }
    if b.starts_with(b"\x1a\x45\xdf\xa3") && b.windows(4).any(|w| w == b"webm") { return Some("webm"); }
    if b.get(4..8) == Some(b"ftyp") {
        let brand = b.get(8..12)?;
        if brand == b"qt  " { return Some("mov"); }
        if [b"isom", b"iso2", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"MSNV", b"dash"].contains(&brand.try_into().ok()?) { return Some("mp4"); }
    }
    None
}

pub(crate) fn path(root: &std::path::Path, folder: &str, file: &str) -> Result<(PathBuf, &'static str)> {
    crate::notes::check_id(folder)?;
    let (stem, ext) = file.rsplit_once('.').context("invalid media filename")?;
    if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) { bail!("invalid media filename"); }
    let mime = match ext {
        "png" => "image/png", "jpg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", "svg" => "image/svg+xml",
        "mp4" => "video/mp4", "mov" => "video/quicktime", "webm" => "video/webm", _ => bail!("unsupported media"),
    };
    Ok((root.join(folder).join("media").join(file), mime))
}

// Also cleans up if the request future is cancelled mid-upload.
struct Temporary(PathBuf);
impl Drop for Temporary { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

/// Stores generated media (such as a diagram) and returns its note path.
pub(crate) fn save(root: &std::path::Path, folder: &str, bytes: &[u8]) -> Result<String> {
    crate::notes::check_id(folder)?;
    let ext = identify(bytes).context("unsupported media")?;
    let dir = root.join(folder).join("media");
    std::fs::create_dir_all(&dir)?;
    let file = format!("{:x}.{ext}", Sha256::digest(bytes));
    crate::notes::write_atomic(&dir.join(&file), std::str::from_utf8(bytes).context("generated media must be text")?)?;
    Ok(format!("media/{file}"))
}

pub(crate) async fn upload(State(app): Shared, Path(target): Path<String>, body: Body) -> ApiResult {
    let folder = app.library.folder_id(&target)?;
    crate::notes::check_id(&folder)?;
    let dir = app.notes.root.join(&folder).join("media");
    tokio::fs::create_dir_all(&dir).await?;
    let tmp = Temporary(dir.join(format!(".{}.upload", uuid::Uuid::new_v4())));
    let mut output = tokio::fs::File::create(&tmp.0).await?;
    let mut stream = body.into_data_stream();
    let mut size = 0usize;
    let mut head = Vec::new();
    let mut hash = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(anyhow::Error::from)?;
        size += chunk.len();
        if size > MAX_BYTES { return Err(crate::Status(StatusCode::PAYLOAD_TOO_LARGE, "Media must be at most 512 MB".into()).into()); }
        let n = chunk.len().min(8192 - head.len());
        head.extend_from_slice(&chunk[..n]);
        hash.update(&chunk);
        output.write_all(&chunk).await?;
    }
    let ext = identify(&head).ok_or_else(|| crate::Status(StatusCode::BAD_REQUEST, "Use PNG, JPEG, GIF, WebP, SVG, MP4, MOV or WebM media".into()))?;
    if ["png", "jpg", "gif", "webp", "svg"].contains(&ext) && size > 32 << 20 {
        return Err(crate::Status(StatusCode::PAYLOAD_TOO_LARGE, "Images must be at most 32 MB".into()).into());
    }
    output.flush().await?;
    drop(output);
    let file = format!("{:x}.{ext}", hash.finalize());
    tokio::fs::rename(&tmp.0, dir.join(&file)).await?;
    Ok(Json(json!({"path": format!("media/{file}"), "kind": if ["mp4", "mov", "webm"].contains(&ext) { "video" } else { "image" }})))
}

fn range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if size == 0 { return None; }
    if start.is_empty() {
        let n = end.parse::<u64>().ok()?;
        return (n > 0).then(|| (size.saturating_sub(n), size - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() { size - 1 } else { end.parse::<u64>().ok()?.min(size - 1) };
    (start < size && end >= start).then_some((start, end))
}

pub(crate) async fn get(State(app): Shared, Path((target, file)): Path<(String, String)>, headers: HeaderMap) -> Response {
    let found = app.library.folder_id(&target).and_then(|f| path(&app.notes.root, &f, &file));
    let Ok((path, mime)) = found else { return StatusCode::NOT_FOUND.into_response() };
    serve(path,mime,headers).await
}

pub(crate) async fn serve(path:PathBuf,mime:&'static str,headers:HeaderMap)->Response {
    let Ok(mut file) = tokio::fs::File::open(path).await else { return StatusCode::NOT_FOUND.into_response() };
    let Ok(meta) = file.metadata().await else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let size = meta.len();
    let mut builder = Response::builder().header("Content-Type", mime).header("X-Content-Type-Options", "nosniff")
        // Opened directly, an SVG would run as a page; sandbox it like project files.
        .header("Content-Security-Policy", "sandbox")
        .header("Accept-Ranges", "bytes").header("Cache-Control", "max-age=31536000, immutable");
    let (start, length) = if let Some(value) = headers.get("range") {
        let Some((start, end)) = value.to_str().ok().and_then(|v| range(v, size)) else {
            return (StatusCode::RANGE_NOT_SATISFIABLE, [("Content-Range", format!("bytes */{size}"))]).into_response();
        };
        builder = builder.status(StatusCode::PARTIAL_CONTENT).header("Content-Range", format!("bytes {start}-{end}/{size}"));
        (start, end - start + 1)
    } else { (0, size) };
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    let (tx, rx) = tokio::sync::mpsc::channel(2);
    tokio::spawn(async move {
        let mut reader = file.take(length);
        loop {
            let mut buffer = vec![0u8; 64 * 1024];
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => { buffer.truncate(n); if tx.send(Ok::<_, std::io::Error>(buffer)).await.is_err() { break; } }
                Err(e) => { let _ = tx.send(Err(e)).await; break; }
            }
        }
    });
    builder.header("Content-Length", length).body(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx))).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_ranges_and_validation() {
        assert_eq!(range("bytes=3-5", 10), Some((3, 5)));
        assert_eq!(range("bytes=7-", 10), Some((7, 9)));
        assert_eq!(range("bytes=-4", 10), Some((6, 9)));
        assert_eq!(range("bytes=0-99", 10), Some((0, 9)));
        for v in ["bytes=10-", "bytes=6-3", "bytes=-0", "bytes=0-1,3-4"] { assert_eq!(range(v, 10), None); }
        assert_eq!(range("bytes=0-", 0), None);
        assert_eq!(identify(b"\0\0\0\x18ftypmp42"), Some("mp4"));
        assert_eq!(identify(b"\0\0\0\x18ftypavif"), None);
        assert_eq!(identify(b"<script>alert(1)</script>"), None);
        assert_eq!(identify(b"\xef\xbb\xbf<?xml version=\"1.0\"?>\n<!-- d -->\n<!DOCTYPE svg>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), Some("svg"));
        assert_eq!(identify(b"<svgx/>"), None);
        assert_eq!(identify(b"<html><svg></svg></html>"), None);
        assert_eq!(path(std::path::Path::new("/tmp"), "folder", &format!("{}.svg", "a".repeat(64))).unwrap().1, "image/svg+xml");
        assert!(path(std::path::Path::new("/tmp"), "../outside", &format!("{}.mp4", "a".repeat(64))).is_err());
        assert!(path(std::path::Path::new("/tmp"), "folder", "../secret.mp4").is_err());
    }
}
