//! Live directories remain owned by the user. Only configuration and recoverable
//! trash live in Noctua storage; the ordinary workspace API adapts their files.
use crate::{ApiResult, App, Shared};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path as FsPath, PathBuf},
    sync::{Mutex, OnceLock},
};

static GATE: Mutex<()> = Mutex::new(());
pub fn collection(target: &str) -> &str {
    target
        .strip_prefix("linked~")
        .and_then(|s| s.split_once('~'))
        .map_or(target, |p| p.0)
}
pub fn is_linked(target: &str) -> bool {
    target.starts_with("linked~")
}
fn parts(target: &str) -> Result<(&str, &str)> {
    let (collection, id) = target
        .strip_prefix("linked~")
        .and_then(|s| s.split_once('~'))
        .context("Invalid linked workspace")?;
    crate::notes::check_id(collection)?;
    crate::notes::check_id(id)?;
    Ok((collection, id))
}
fn registry(app: &App, target: &str) -> Result<PathBuf> {
    Ok(crate::workspace::dir(app, collection(target))?.join(".workspace/links.json"))
}
fn read_json(path: &FsPath, default: Value) -> Result<Value> {
    match fs::read(path) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(e) => Err(e.into()),
    }
}
fn save_json(path: &FsPath, value: &Value) -> Result<()> {
    fs::create_dir_all(path.parent().context("Missing parent")?)?;
    crate::notes::write_atomic(path, &value.to_string())
}
pub fn metadata_dir(app: &App, target: &str) -> Result<PathBuf> {
    let (c, id) = parts(target)?;
    Ok(crate::workspace::dir(app, c)?
        .join(".workspace/linked")
        .join(id))
}
fn identity(path: &FsPath) -> Result<Value> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(path)?;
        return Ok(json!({"device":m.dev(),"inode":m.ino()}));
    }
    #[cfg(not(unix))]
    {
        Ok(json!(path.canonicalize()?))
    }
}
pub fn root(app: &App, target: &str) -> Result<PathBuf> {
    let (_, id) = parts(target)?;
    let links = read_json(&registry(app, target)?, json!([]))?;
    let link = links
        .as_array()
        .context("Invalid linked folders")?
        .iter()
        .find(|l| l["id"] == id)
        .context("Directory is no longer linked")?;
    let path = PathBuf::from(link["path"].as_str().context("Missing linked path")?);
    ensure!(
        path.is_dir(),
        "Linked directory is unavailable. Relink it or reconnect its volume."
    );
    ensure!(
        link["identity"].is_null() || link["identity"] == identity(&path)?,
        "Linked directory was replaced; relink it to grant access again"
    );
    ensure!(
        path.canonicalize()? == path,
        "Linked directory moved or became a symbolic link; relink it explicitly"
    );
    Ok(path)
}
/// Reject symlinks at every component, including a missing destination's parent.
/// A linked root never exposes Git's internal administrative files.
pub fn resolve(root: &FsPath, relative: &str) -> Result<PathBuf> {
    ensure!(!relative.is_empty(), "Choose a project path");
    let mut path = root.to_path_buf();
    for part in FsPath::new(relative).components() {
        let Component::Normal(name) = part else {
            bail!("Use a relative project path without parent components")
        };
        ensure!(
            !name.to_string_lossy().eq_ignore_ascii_case(".git"),
            "Git internals are not editable project files"
        );
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(m) => ensure!(
                !m.file_type().is_symlink(),
                "Symbolic links are not editable project paths"
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    ensure!(path.starts_with(root), "Path is outside the linked folder");
    Ok(path)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn entry_id(path: &str) -> String {
    format!("x{}", digest(path.as_bytes()))
}
fn git(root: &FsPath, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim_end().to_owned())
}
pub fn git_status(root: &FsPath) -> Value {
    let Some(repo) = git(root, &["rev-parse", "--show-toplevel"]) else {
        return Value::Null;
    };
    json!({"root":repo,"branch":git(root,&["symbolic-ref","--short","-q","HEAD"]).or_else(||git(root,&["rev-parse","--short","HEAD"])),"status":git(root,&["status","--porcelain=v1","--untracked-files=normal","--","."])})
}
pub fn descriptors(app: &App, target: &str) -> Result<Value> {
    let mut links = read_json(&registry(app, target)?, json!([]))?;
    for link in links.as_array_mut().context("Invalid links")? {
        link["target"] = json!(format!(
            "linked~{}~{}",
            collection(target),
            link["id"].as_str().unwrap_or("")
        ));
    }
    Ok(links)
}
pub async fn links(State(app): Shared, Path(target): Path<String>) -> ApiResult {
    let mut links = read_json(&registry(&app, &target)?, json!([]))?;
    for link in links.as_array_mut().context("Invalid links")? {
        let path = PathBuf::from(link["path"].as_str().unwrap_or(""));
        link["available"] = json!(path.is_dir());
        link["target"] = json!(format!(
            "linked~{}~{}",
            collection(&target),
            link["id"].as_str().unwrap_or("")
        ));
    }
    Ok(Json(
        json!({"supported":cfg!(target_os="macos"),"links":links}),
    ))
}
pub async fn manage(
    State(app): Shared,
    Path(target): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    Ok(Json(manage_sync(&app, &target, &body)?))
}
fn manage_sync(app: &App, target: &str, body: &Value) -> Result<Value> {
    ensure!(
        cfg!(target_os = "macos"),
        "Linked workspaces currently require a macOS server"
    );
    let _gate = GATE.lock().unwrap();
    let path = registry(&app, &target)?;
    let mut links = read_json(&path, json!([]))?;
    let items = links.as_array_mut().context("Invalid links")?;
    let op = body["op"].as_str().unwrap_or("link");
    if op == "unlink" {
        let id = body["id"].as_str().context("Missing link")?;
        crate::project_terminal::close_target(app, &format!("linked~{}~{id}", collection(target)));
        crate::project_access::cancel_target(app, &format!("linked~{}~{id}", collection(target)));
        crate::chat_approval::revoke_linked(app, &format!("linked~{}~{id}", collection(target)));
        items.retain(|l| l["id"] != id);
    } else {
        ensure!(op == "link" || op == "relink", "Unknown link operation");
        let input = FsPath::new(
            body["path"]
                .as_str()
                .context("Choose a directory on the server")?,
        );
        ensure!(
            input.is_absolute(),
            "Enter an absolute directory path on the server"
        );
        let root = input.canonicalize()?;
        ensure!(root.is_dir(), "Choose a directory");
        ensure!(
            !root.starts_with(app.data_dir.canonicalize()?),
            "Choose a directory outside Noctua storage"
        );
        ensure!(
            !items
                .iter()
                .any(|l| l["path"].as_str() == root.to_str() && l["id"] != body["id"]),
            "This directory is already linked"
        );
        let id = if op == "relink" {
            body["id"].as_str().context("Missing link")?.to_owned()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        if op == "relink" {
            crate::project_terminal::close_target(
                app,
                &format!("linked~{}~{id}", collection(target)),
            );
            crate::project_access::cancel_target(
                app,
                &format!("linked~{}~{id}", collection(target)),
            );
            crate::chat_approval::revoke_linked(
                app,
                &format!("linked~{}~{id}", collection(target)),
            );
            ensure!(items.iter().any(|l| l["id"] == id), "Link not found");
            let meta = metadata_dir(&app, &format!("linked~{}~{id}", collection(&target)))?;
            save_json(&meta.join("grants.json"), &json!([]))?;
            save_json(&meta.join("settings.json"), &json!({}))?;
        }
        items.retain(|l| l["id"] != id);
        items.push(json!({"id":id,"path":root,"identity":identity(&root)?,"name":root.file_name().unwrap_or_default().to_string_lossy()}));
    }
    save_json(&path, &links)?;
    Ok(json!({"links":links}))
}
type Stamp = (u64, std::time::SystemTime, u64, i64, i64);
fn stamp(meta: &fs::Metadata) -> Stamp {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (
            meta.len(),
            meta.modified().unwrap_or(std::time::UNIX_EPOCH),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec(),
        )
    }
    #[cfg(not(unix))]
    {
        (
            meta.len(),
            meta.modified().unwrap_or(std::time::UNIX_EPOCH),
            0,
            0,
            0,
        )
    }
}
fn file_hash(path: &FsPath) -> Result<String> {
    static HASHES: OnceLock<Mutex<HashMap<PathBuf, (Stamp, String)>>> = OnceLock::new();
    let cache = HASHES.get_or_init(Default::default);
    let before = stamp(&fs::metadata(path)?);
    if let Some((_, hash)) = cache
        .lock()
        .unwrap()
        .get(path)
        .filter(|(s, _)| *s == before)
    {
        return Ok(hash.clone());
    }
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    ensure!(
        stamp(&fs::metadata(path)?) == before,
        "Project changed while reading files; retry"
    );
    let hash = format!("{:x}", hash.finalize());
    let mut cache = cache.lock().unwrap();
    if cache.len() > 25000 {
        cache.clear();
    }
    cache.insert(path.to_owned(), (before, hash.clone()));
    Ok(hash)
}
fn scan(
    root: &FsPath,
    relative: &str,
    entries: &mut Vec<Value>,
    total: &mut u64,
    ignored: &[String],
    show_ignored: bool,
) -> Result<()> {
    let folder = if relative.is_empty() {
        root.to_path_buf()
    } else {
        resolve(root, relative)?
    };
    let mut files = fs::read_dir(folder)?.collect::<std::io::Result<Vec<_>>>()?;
    files.sort_by_key(|e| e.file_name());
    for file in files {
        let name = file
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("Project filenames must be UTF-8"))?;
        if name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let is_ignored = ignored.iter().any(|p| {
            p == &path
                || p.strip_suffix('/')
                    .is_some_and(|p| path == p || path.starts_with(&format!("{p}/")))
        });
        if is_ignored && !show_ignored {
            continue;
        }
        let meta = fs::symlink_metadata(file.path())?;
        if meta.file_type().is_symlink() || (!meta.is_dir() && !meta.is_file()) {
            continue;
        }
        ensure!(
            entries.len() < 20_000,
            "Linked folder exceeds 20,000 visible entries; link a smaller directory"
        );
        let mut entry = json!({"id":entry_id(&path),"name":name,"path":path,"parent":if relative.is_empty(){String::new()}else{entry_id(relative)},"kind":if meta.is_dir(){"folder"}else{"file"},"size":meta.len(),"ignored":is_ignored,"deleted":false});
        if meta.is_file() {
            *total += meta.len();
            ensure!(*total<=512<<20,"Linked folder exceeds 512 MB of visible files; ignore generated files or link a smaller directory");
            entry["blob"] = json!(file_hash(&resolve(root, &path)?)?);
        }
        entries.push(entry);
        if meta.is_dir() {
            scan(root, &path, entries, total, ignored, show_ignored)?;
        }
    }
    Ok(())
}
pub fn snapshot(app: &App, target: &str) -> Result<Value> {
    let root = root(app, target)?;
    let meta = metadata_dir(app, target)?;
    let settings = read_json(&meta.join("settings.json"), json!({}))?;
    let ignored = git(
        &root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )
    .unwrap_or_default()
    .split('\0')
    .filter(|s| !s.is_empty())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let mut entries = Vec::new();
    scan(
        &root,
        "",
        &mut entries,
        &mut 0,
        &ignored,
        settings["show_ignored"] == true,
    )?;
    for entry in &mut entries {
        let p = entry["path"].as_str().unwrap().to_owned();
        entry["id"] = settings["ids"]
            .get(&p)
            .cloned()
            .unwrap_or_else(|| json!(entry_id(&p)));
        let parent = FsPath::new(&p).parent().unwrap().to_str().unwrap();
        entry["parent"] = if parent.is_empty() {
            json!("")
        } else {
            settings["ids"]
                .get(parent)
                .cloned()
                .unwrap_or_else(|| json!(entry_id(parent)))
        };
    }
    let mut m = json!({"entries":entries,"paper":settings["paper"],"skills":[],"linked":true,"root":root,"collection":collection(target),"history":{},"show_ignored":settings["show_ignored"]==true});
    let hash = Sha256::digest(m.to_string().as_bytes());
    let mut revision = [0u8; 8];
    revision[2..].copy_from_slice(&hash[..6]);
    m["revision"] = json!(u64::from_be_bytes(revision));
    m["bibliographies"] = json!(entries
        .iter()
        .filter(|e| e["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .ends_with(".bib"))
        .map(|e| e["id"].clone())
        .collect::<Vec<_>>());
    Ok(m)
}
pub fn list(app: &App, target: &str) -> Result<Value> {
    let mut m = snapshot(app, target)?;
    m["git"] = git_status(&root(app, target)?);
    match crate::bibliography::index(app, target, &m) {
        Ok(index) => m["bib_index"] = json!(index),
        Err(e) => m["bib_error"] = json!(e.to_string()),
    };
    Ok(m)
}
pub fn file_path(app: &App, target: &str, entry: &Value) -> Result<PathBuf> {
    resolve(
        &root(app, target)?,
        entry["path"].as_str().context("Missing linked path")?,
    )
}
fn stale() -> anyhow::Error {
    crate::Status(
        axum::http::StatusCode::CONFLICT,
        "Files changed on disk. Compare your draft with the current file before saving.".into(),
    )
    .into()
}
pub fn change(app: &App, target: &str, body: &Value, upload: Option<&[u8]>) -> Result<Value> {
    let _gate = GATE.lock().unwrap();
    let m = snapshot(app, target)?;
    if body["revision"] != m["revision"] {
        return Err(stale());
    }
    let root = root(app, target)?;
    let meta = metadata_dir(app, target)?;
    let entries = m["entries"].as_array().unwrap();
    let op = body["op"].as_str().unwrap_or("");
    let entry = entries.iter().find(|e| e["id"] == body["id"]);
    let parent = |id: &str| -> Result<String> {
        if id.is_empty() {
            return Ok(String::new());
        }
        Ok(entries
            .iter()
            .find(|e| e["id"] == id && e["kind"] == "folder")
            .context("Folder not found")?["path"]
            .as_str()
            .unwrap()
            .to_owned())
    };
    let destination = |parent: &str, name: &str| -> Result<PathBuf> {
        ensure!(
            !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != "..",
            "Choose a filename"
        );
        resolve(
            &root,
            &if parent.is_empty() {
                name.to_owned()
            } else {
                format!("{parent}/{name}")
            },
        )
    };
    match op {
        "config" => {
            let mut s = read_json(&meta.join("settings.json"), json!({}))?;
            if let Some(p) = body.get("paper") {
                s["paper"] = crate::paper::merge_settings(&s["paper"], p, entries)?;
            }
            if let Some(v) = body.get("show_ignored") {
                ensure!(v.is_boolean(), "Expected a visibility boolean");
                s["show_ignored"] = v.clone();
            }
            save_json(&meta.join("settings.json"), &s)?;
        }
        "create" | "folder" => {
            let p = parent(body["parent"].as_str().unwrap_or(""))?;
            let dest = destination(&p, body["name"].as_str().context("Name required")?)?;
            if op == "folder" {
                fs::create_dir(dest)?;
            } else {
                let bytes =
                    upload.unwrap_or_else(|| body["text"].as_str().unwrap_or("").as_bytes());
                ensure!(bytes.len() <= 32 << 20, "File exceeds 32 MB");
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dest)?;
                file.write_all(bytes)?;
            }
        }
        "edit" => {
            let e = entry.context("File not found")?;
            ensure!(e["kind"] == "file", "Choose a file");
            let path = file_path(app, target, e)?;
            let text = body["text"].as_str().context("Text required")?;
            ensure!(text.len() <= 2 << 20, "Text exceeds 2 MB");
            let mut tmp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
            tmp.as_file()
                .set_permissions(fs::metadata(&path)?.permissions())?;
            tmp.write_all(text.as_bytes())?;
            tmp.as_file().sync_all()?;
            if digest(&fs::read(&path)?) != e["blob"].as_str().unwrap() {
                return Err(stale());
            }
            tmp.persist(&path)?;
        }
        "rename" | "move" => {
            let e = entry.context("Entry not found")?;
            let old = e["path"].as_str().unwrap();
            let p = if op == "move" {
                parent(body["parent"].as_str().unwrap_or(""))?
            } else {
                FsPath::new(old)
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            };
            let name = if op == "rename" {
                body["name"].as_str().context("Name required")?
            } else {
                e["name"].as_str().unwrap()
            };
            let dest = destination(&p, name)?;
            ensure!(!dest.exists(), "Destination already exists");
            let source = file_path(app, target, e)?;
            ensure!(
                !dest.starts_with(&source),
                "Cannot move a folder into itself"
            );
            fs::rename(&source, &dest)?;
            let new = dest
                .strip_prefix(&root)?
                .to_str()
                .context("Invalid filename")?;
            let mut settings = read_json(&meta.join("settings.json"), json!({}))?;
            if !settings["ids"].is_object() {
                settings["ids"] = json!({});
            }
            for moved in entries.iter().filter(|i| {
                i["path"]
                    .as_str()
                    .is_some_and(|p| p == old || p.starts_with(&format!("{old}/")))
            }) {
                let old_path = moved["path"].as_str().unwrap();
                settings["ids"].as_object_mut().unwrap().remove(old_path);
                settings["ids"][format!("{new}{}", &old_path[old.len()..])] = moved["id"].clone();
            }
            save_json(&meta.join("settings.json"), &settings)?;
        }
        "delete" => {
            let e = entry.context("Entry not found")?;
            let source = file_path(app, target, e)?;
            let id = uuid::Uuid::new_v4().to_string();
            let trash = meta.join("trash").join(&id);
            fs::create_dir_all(&trash)?;
            save_json(&trash.join("entry.json"), e)?;
            copy_tree(&source, &trash.join("content"))?;
            if snapshot(app, target)?["revision"] != m["revision"] {
                return Err(stale());
            }
            if source.is_dir() {
                fs::remove_dir_all(source)?;
            } else {
                fs::remove_file(source)?;
            }
        }
        "restore" => {
            let id = body["id"].as_str().context("Trash id required")?;
            crate::notes::check_id(id)?;
            let trash = meta.join("trash").join(id);
            let e = read_json(&trash.join("entry.json"), Value::Null)?;
            let dest = resolve(&root, e["path"].as_str().context("Trash entry not found")?)?;
            ensure!(!dest.exists(), "Restore destination already exists");
            ensure!(
                dest.parent().unwrap().is_dir(),
                "Restore the parent folder first"
            );
            copy_tree(&trash.join("content"), &dest)?;
            fs::remove_dir_all(trash)?;
        }
        _ => bail!("This operation is not supported for linked files"),
    }
    list(app, target)
}
fn copy_tree(from: &FsPath, to: &FsPath) -> Result<()> {
    let meta = fs::symlink_metadata(from)?;
    ensure!(
        !meta.file_type().is_symlink(),
        "Cannot copy a symbolic link"
    );
    if meta.is_dir() {
        fs::create_dir(to)?;
        for e in fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
    } else {
        ensure!(meta.is_file(), "Only regular files can be copied");
        fs::copy(from, to)?;
    }
    Ok(())
}
pub async fn trash(State(app): Shared, Path(target): Path<String>) -> ApiResult {
    let dir = metadata_dir(&app, &target)?.join("trash");
    let mut entries = vec![];
    if dir.exists() {
        for e in fs::read_dir(dir)? {
            let e = e?;
            let mut v = read_json(&e.path().join("entry.json"), Value::Null)?;
            v["trash_id"] = json!(e.file_name().to_string_lossy());
            entries.push(v);
        }
    }
    Ok(Json(json!({"entries":entries})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linked_git_detects_parent_repository_and_ignored_files() -> Result<()> {
        let d = tempfile::tempdir()?;
        let init = std::process::Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(d.path())
            .status()?;
        ensure!(init.success(), "git init failed");
        fs::create_dir(d.path().join("paper"))?;
        fs::write(d.path().join(".gitignore"), "*.aux\n")?;
        fs::write(d.path().join("paper/main.tex"), "source")?;
        fs::write(d.path().join("paper/main.aux"), "generated")?;
        let root = d.path().join("paper");
        let info = git_status(&root);
        assert_eq!(
            PathBuf::from(info["root"].as_str().unwrap()).canonicalize()?,
            d.path().canonicalize()?
        );
        let ignored = git(
            &root,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
        )
        .unwrap();
        assert!(ignored.contains("main.aux"));
        let mut entries = vec![];
        scan(
            &root,
            "",
            &mut entries,
            &mut 0,
            &ignored.split('\0').map(str::to_owned).collect::<Vec<_>>(),
            false,
        )?;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "main.tex");
        Ok(())
    }

    #[test]
    fn paths_cannot_escape_or_access_git() {
        let d = tempfile::tempdir().unwrap();
        for path in [
            "../other",
            "/tmp/other",
            ".git/config",
            "x/../../other",
            "x/.GIT/config",
        ] {
            assert!(resolve(d.path(), path).is_err(), "{path}");
        }
        assert!(resolve(d.path(), "chapter/main.tex").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_parent_and_file() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("escape")).unwrap();
        assert!(resolve(d.path(), "escape/new.tex").is_err());
    }
    #[test]
    fn scan_detects_same_length_external_changes() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("main.tex"), "one").unwrap();
        let mut first = vec![];
        scan(d.path(), "", &mut first, &mut 0, &[], false).unwrap();
        fs::write(d.path().join("main.tex"), "two").unwrap();
        let mut second = vec![];
        scan(d.path(), "", &mut second, &mut 0, &[], false).unwrap();
        assert_eq!(first[0]["id"], second[0]["id"]);
        assert_ne!(first[0]["blob"], second[0]["blob"]);
    }
}
