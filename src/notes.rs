//! Notes attached to Noctua collections: one JSON file per note under
//! `notes/<folder id>/<note id>.json`, where a note is a list of typed-LaTeX
//! and handwriting blocks. Workspace trash is tracked in the project manifest;
//! legacy note deletion moves files to `notes/.trash/`.
//! Also turns handwriting (a PNG) into LaTeX with the selected CLI backend.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::{agent::{self, Provider}, App};

pub struct Notes {
    pub(crate) root: PathBuf,
}

fn seen_versions() -> &'static Mutex<HashMap<String, VecDeque<Value>>> {
    static SEEN: OnceLock<Mutex<HashMap<String, VecDeque<Value>>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Ids become file and directory names, so only allow a safe alphabet.
pub(crate) fn check_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 40 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        bail!("invalid id");
    }
    Ok(())
}

/// Writes via a temporary file so a crash never leaves half a note.
pub(crate) fn write_atomic(path: &Path, body: &str) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

impl Notes {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self, folder: &str, id: &str) -> Result<PathBuf> {
        check_id(folder)?;
        check_id(id)?;
        Ok(self.root.join(folder).join(format!("{id}.json")))
    }

    /// `[{ id, title, created, updated }]`, most recently edited first.
    pub fn list(&self, folder: &str) -> Result<Value> {
        check_id(folder)?;
        let mut out = Vec::new();
        let Ok(dir) = std::fs::read_dir(self.root.join(folder)) else { return Ok(json!([])) };
        for entry in dir.flatten() {
            let p = entry.path();
            if p.file_stem().and_then(|s|s.to_str()).is_none_or(|s|check_id(s).is_err()) || p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(doc) = std::fs::read_to_string(&p).map_err(anyhow::Error::from).and_then(|s| Ok(serde_json::from_str::<Value>(&s)?)) else {
                continue;
            };
            out.push(json!({ "id": doc["id"], "title": doc["title"], "created": doc["created"], "updated": doc["updated"] }));
        }
        out.sort_by_key(|n| std::cmp::Reverse(n["updated"].as_u64().unwrap_or(0)));
        Ok(json!(out))
    }

    /// Every note in every folder: `[(folder id, [{ id, title, created, updated }])]`.
    pub fn list_all(&self) -> Result<Vec<(String, Value)>> {
        let mut out = Vec::new();
        let Ok(dir) = std::fs::read_dir(&self.root) else { return Ok(out) };
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_dir() && check_id(&name).is_ok() {
                out.push((name.clone(), self.list(&name)?));
            }
        }
        Ok(out)
    }

    pub fn get(&self, folder: &str, id: &str) -> Result<Option<Value>> {
        match std::fs::read_to_string(self.path(folder, id)?) {
            Ok(s) => {
                let doc: Value = serde_json::from_str(&s)?;
                self.remember(folder, id, &doc);
                Ok(Some(doc))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Keeps recent versions handed to readers (session only), so an edit
    /// based on one can still be checked block by block after later saves.
    pub fn remember(&self, folder: &str, id: &str, doc: &Value) {
        let Some(updated) = doc["updated"].as_u64() else { return };
        let key = format!("{}:{folder}:{id}", self.root.display());
        let mut seen = seen_versions().lock().unwrap();
        if seen.len() >= 256 && !seen.contains_key(&key) {
            if let Some(old) = seen.keys().next().cloned() {
                seen.remove(&old);
            }
        }
        let versions = seen.entry(key).or_default();
        if versions.iter().any(|d| d["updated"].as_u64() == Some(updated)) {
            return;
        }
        versions.push_back(doc.clone());
        while versions.len() > 16 {
            versions.pop_front();
        }
    }

    /// A version previously returned by `get` or recorded with `remember`.
    pub fn version(&self, folder: &str, id: &str, updated: u64) -> Option<Value> {
        let key = format!("{}:{folder}:{id}", self.root.display());
        seen_versions().lock().unwrap().get(&key)?.iter().find(|d| d["updated"].as_u64() == Some(updated)).cloned()
    }

    pub fn create(&self, folder: &str, title: &str) -> Result<Value> {
        let t = now_ms();
        let id = crate::library::id("n");
        let title = match title.trim() {
            "" => "Untitled note",
            t => t,
        };
        let doc = json!({
            "version": 1, "id": id, "title": title, "created": t, "updated": t,
            "blocks": [{ "id": format!("b{t:x}"), "type": "text", "src": "" }],
        });
        let path = self.path(folder, &id)?;
        std::fs::create_dir_all(path.parent().unwrap())?;
        write_atomic(&path, &doc.to_string())?;
        Ok(doc)
    }

    /// Stable source IDs and baselines support explicit sync or overwrite on re-import.
    pub fn import_zotero(&self, folder: &str, note: &Value,mode:crate::zotero::ImportMode) -> Result<(bool,Vec<String>)> {
        use std::io::Write;
        use sha2::{Digest,Sha256};
        let source=note["source"].as_str().context("Missing Zotero note source")?;
        // Copies in different collections must keep globally distinct note-reference IDs.
        let digest=format!("{:x}",Sha256::digest(format!("{folder}:{source}").as_bytes()));
        let id=format!("z{}",&digest[..32]);
        let path=self.path(folder,&id)?;
        std::fs::create_dir_all(path.parent().unwrap())?;
        let t=now_ms();
        let title=note["title"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or("Zotero note");
        let mut doc=json!({"version":1,"id":id,"title":title,"created":t,"updated":t,
            "zotero_source":note["source"],"zotero_html":note["html"],
            "blocks":[{"id":"imported","type":"text","src":crate::zotero::note_text(note["html"].as_str().unwrap_or(""))}]});
        let incoming=json!({"title":doc["title"],"blocks":doc["blocks"]});
        doc["zotero_base"]=incoming.clone();
        if let Some(mut existing)=self.get(folder,&id)? {
            let current=json!({"title":existing["title"],"blocks":existing["blocks"]});
            let legacy=json!({"blocks":[{"id":"imported","type":"text","src":crate::zotero::note_text(existing["zotero_html"].as_str().unwrap_or(""))}]});
            let baseline=existing.get("zotero_base").filter(|v|v.is_object()).unwrap_or(&legacy);
            let (merged,base,conflicts)=crate::zotero::reconcile(&current,&incoming,Some(baseline),mode);
            let changed=merged!=current;
            let save=changed||existing["zotero_base"]!=base||existing["zotero_html"]!=note["html"];
            existing["title"]=merged["title"].clone();existing["blocks"]=merged["blocks"].clone();
            existing["zotero_base"]=base;existing["zotero_html"]=note["html"].clone();
            if save {self.save(folder,&id,existing)?;}
            return Ok((changed,conflicts));
        }
        let mut temp=tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        temp.write_all(doc.to_string().as_bytes())?;
        match temp.persist_noclobber(path) {
            Ok(_)=>Ok((true,Vec::new())),
            Err(e) if e.error.kind()==std::io::ErrorKind::AlreadyExists=>Ok((false,vec!["note created concurrently; retry import".into()])),
            Err(e)=>Err(e.error.into()),
        }
    }

    /// Replaces the note's contents. Returns the new `updated` time. If the
    /// doc carries the `updated` time it was based on and the file has been
    /// saved since (another tab or window), nothing is written: 409.
    pub fn save(&self, folder: &str, id: &str, mut doc: Value) -> Result<u64> {
        let mut journals=crate::editing::journals().lock().unwrap();
        let journal=journals.entry(format!("{}:note:{folder}:{id}",self.root.display())).or_default();
        let path = self.path(folder, id)?;
        let Ok(current) = std::fs::read_to_string(&path) else {
            bail!("note not found (was it deleted?)");
        };
        if let Some(base) = doc["updated"].as_u64() {
            let on_disk = serde_json::from_str::<Value>(&current).ok().and_then(|d| d["updated"].as_u64());
            if on_disk.is_some_and(|t| t != base) {
                return Err(crate::Status(
                    axum::http::StatusCode::CONFLICT,
                    "this note was changed in another tab or window".into(),
                )
                .into());
            }
        }
        if !doc["blocks"].is_array() {
            bail!("a note needs a blocks list");
        }
        let previous:Value=serde_json::from_str(&current)?;
        let frames=doc.as_object_mut().unwrap().remove("_history");
        let t = now_ms().max(previous["updated"].as_u64().unwrap_or(0)+1);
        doc["id"] = json!(id);
        doc["version"] = json!(1);
        doc["updated"] = json!(t);
        write_atomic(&path, &doc.to_string())?;
        let mut before=crate::editing::content(previous);
        if let Some(frames)=frames.and_then(|v|v.as_array().cloned()) {
            if frames.len()<=200 {
                for frame in frames { let after=crate::editing::content(frame["doc"].clone());
                    if after.is_object() && after["id"]==doc["id"] && after["blocks"].is_array() {
                        journal.record(before.clone(),after.clone(),frame["label"].as_str().unwrap_or("Edit note"));before=after;
                    }
                }
            }
        }
        journal.record(before,crate::editing::content(doc),"Edit note");
        Ok(t)
    }

    pub fn history(&self,folder:&str,id:&str,redo:Option<bool>,expected:Option<u64>)->Result<Value>{
        let mut journals=crate::editing::journals().lock().unwrap();
        let journal=journals.entry(format!("{}:note:{folder}:{id}",self.root.display())).or_default();
        if let Some(redo)=redo {
            let path=self.path(folder,id)?;
            let current:Value=serde_json::from_str(&std::fs::read_to_string(&path)?)?;
            if expected!=current["updated"].as_u64(){return Err(crate::Status(axum::http::StatusCode::CONFLICT,"Note changed in another window".into()).into());}
            let mut doc=journal.pending(redo,&crate::editing::content(current.clone()))?;
            doc["updated"]=json!(now_ms().max(current["updated"].as_u64().unwrap_or(0)+1));
            write_atomic(&path,&doc.to_string())?;journal.finish(redo);
            return Ok(json!({"doc":doc,"history":journal.status()}));
        }
        Ok(journal.status())
    }

/// Stores an image in `<folder>/images/` and returns its note-relative path
    /// (`images/<stem>-<hash>.<ext>`). The name includes a hash of the
    /// contents, so adding the same image twice reuses one file.
    pub fn save_image(&self, folder: &str, name_hint: &str, bytes: &[u8]) -> Result<String> {
        check_id(folder)?;
        let ext = image_ext(bytes).context("only PNG, JPEG, GIF or WebP images can be added")?;
        let stem: String = Path::new(name_hint)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .take(40)
            .collect();
        let stem = stem.trim_matches('_');
        let stem = if stem.is_empty() { "image" } else { stem };
        let mut h = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hasher::write(&mut h, bytes);
        let file = format!("{stem}-{:08x}.{ext}", std::hash::Hasher::finish(&h) as u32);
        let dir = self.root.join(folder).join("images");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(&file);
        if !path.exists() {
            let tmp = dir.join(format!(".{file}.tmp"));
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, &path)?;
        }
        Ok(format!("images/{file}"))
    }

    /// The path of a stored image and its content type. `file` is a bare file
    /// name as returned by `save_image` (no directories).
    pub fn image_path(&self, folder: &str, file: &str) -> Result<(PathBuf, &'static str)> {
        check_id(folder)?;
        let (stem, ext) = file.rsplit_once('.').context("invalid image name")?;
        let mime = match ext {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => bail!("invalid image name"),
        };
        if stem.is_empty() || stem.len() > 60 || !stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            bail!("invalid image name");
        }
        Ok((self.root.join(folder).join("images").join(file), mime))
    }

    pub fn delete(&self, folder: &str, id: &str) -> Result<()> {
        let path = self.path(folder, id)?;
        let trash = self.root.join(".trash");
        std::fs::create_dir_all(&trash)?;
        std::fs::rename(&path, trash.join(format!("{folder}--{id}--{}.json", now_ms()))).context("note not found")?;
        Ok(())
    }
}

/// File extension for an image, judged by its first bytes (not its name).
fn image_ext(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("gif")
    } else if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

const INK_PROMPT: &str = include_str!("prompts/handwriting.md");

/// Handwriting (base64 PNG) to LaTeX source, via the selected CLI backend.
/// Saves each fenced ```svg diagram in a transcription as note media of the
/// collection and refers to it from the LaTeX; unusable ones become placeholders.
pub(crate) fn place_diagrams(app: &App, target: Option<&str>, text: &str) -> Result<String> {
    let folder = target.map(|t| app.library.folder_id(t)).transpose()?;
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("```svg") {
        let body = start + "```svg".len();
        let Some(len) = rest[body..].find("```") else { break };
        let svg = rest[body..body + len].trim();
        out.push_str(&rest[..start]);
        let saved = folder.as_deref().filter(|_| svg.len() <= 200_000).and_then(|f| crate::media::save(&app.notes.root, f, svg.as_bytes()).ok());
        out.push_str(&match saved {
            Some(path) => format!("\\includegraphics[width=0.7\\textwidth]{{{path}}}"),
            None => "[diagram]".to_owned(),
        });
        rest = &rest[body + len + 3..];
    }
    out.push_str(rest);
    Ok(out)
}

pub async fn ink_to_latex(app: &App, provider: Provider, png_b64: &str, target: Option<&str>) -> Result<String> {
    use base64::Engine;
    let data = png_b64.trim().trim_start_matches("data:image/png;base64,");
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).context("invalid drawing image")?;
    if image_ext(&bytes) != Some("png") { bail!("drawing must be a PNG image"); }
    std::fs::create_dir_all(&app.chat_dir)?;
    // Codex accepts local image attachments. Remove the private temporary file
    // on success, failure, timeout, or cancellation.
    struct Drawing(PathBuf);
    impl Drop for Drawing { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
    let drawing = Drawing(app.chat_dir.join(format!("ink-{}.png", SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos())));
    let (cmd, input) = if provider == Provider::Codex {
        std::fs::write(&drawing.0, &bytes)?;
        crate::paths::restrict(&drawing.0);
        let mut c = agent::codex_command(app, None, INK_PROMPT);
        c.arg("--ephemeral").arg("--image").arg(&drawing.0).arg("-");
        (c, INK_PROMPT.to_string())
    } else {
        let mut c = provider.command(app);
        provider.configure(app, &mut c);
        c.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
            .args(["--tools", "", "--strict-mcp-config", "--no-session-persistence"]);
        let msg = json!({ "type": "user", "message": { "role": "user", "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": data } },
            { "type": "text", "text": INK_PROMPT },
        ] } });
        (c, format!("{msg}\n"))
    };
    let text = agent::one_shot(app, provider, cmd, &input, "transcribe the drawing").await?;
    let text = place_diagrams(app, target, &text)?;
    Ok(text.trim().trim_start_matches("```latex").trim_start_matches("```").trim_end_matches("```").trim().to_string())
}
