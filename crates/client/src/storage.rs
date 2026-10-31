//! Storage selection is kept at a fixed location so it survives moving the data.
//! Copy on the next launch, before opening the library; never delete the source.
use std::{fs, path::{Path, PathBuf}};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths;

const CONFIG: &str = "storage-location.json";
static COPY_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn migration_error() -> Option<String> { COPY_ERROR.lock().unwrap().clone() }

/// Coordinate storage resolution with old apps. The data server upgrades this
/// lease to exclusive and retains it; clients probe the owner before taking it.
pub fn lease() -> Result<Option<fs::File>> {
    if std::env::var_os("NOCTUA_HOME").is_some_and(|s| !s.is_empty()) { return Ok(None); }
    let default = paths::default_data_dir();
    fs::create_dir_all(&default)?;
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(default.join("storage-location.lock"))?;
    if load(&default)?.pending.is_some() {
        file.try_lock().context("Quit all other Noctua apps and servers before changing storage")?;
    } else {
        file.try_lock_shared().context("Another Noctua process is copying storage. Wait for it to finish")?;
    }
    Ok(Some(file))
}

pub fn exclusive_lease(file: &Option<fs::File>) -> Result<()> {
    if let Some(file) = file { file.try_lock().context("Another app or server is using this storage. Quit older Noctua apps before switching to the independent server")?; }
    Ok(())
}

#[derive(Default, Deserialize, Serialize)]
struct Location {
    current: Option<PathBuf>,
    pending: Option<PathBuf>,
}

fn load(default: &Path) -> Result<Location> {
    let file = default.join(CONFIG);
    match fs::read_to_string(&file) {
        Ok(body) => serde_json::from_str(&body).with_context(|| format!("Cannot read {}", file.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Location::default()),
        Err(e) => Err(e.into()),
    }
}

fn save(default: &Path, location: &Location) -> Result<()> {
    fs::create_dir_all(default)?;
    paths::write_private(&default.join(CONFIG), &serde_json::to_string_pretty(location)?)
}

pub fn current(default: &Path) -> Result<PathBuf> { Ok(load(default)?.current.unwrap_or_else(||default.to_path_buf())) }

pub fn pending() -> Result<Option<PathBuf>> {
    Ok(load(&paths::default_data_dir())?.pending)
}

pub fn schedule(default: &Path, source: &Path, destination: Option<&Path>) -> Result<Option<PathBuf>> {
    let mut location = load(default)?;
    let source = fs::canonicalize(source)?;
    location.pending = match destination {
        Some(destination) => {
            if !destination.is_absolute() { bail!("Enter an absolute folder path, such as ~/Documents/Noctua."); }
            fs::create_dir_all(destination).context("Cannot create the storage folder")?;
            let destination = fs::canonicalize(destination)?;
            if destination == source {
                None
            } else {
                validate_destination(&source, &destination)?;
                // Check permissions now, before promising that the selection was saved.
                let probe = destination.join(format!(".noctua-write-{}", uuid::Uuid::new_v4()));
                fs::OpenOptions::new().write(true).create_new(true).open(&probe)?;
                fs::remove_file(probe)?;
                Some(destination)
            }
        }
        None => None,
    };
    location.current = Some(source);
    save(default, &location)?;
    *COPY_ERROR.lock().unwrap() = None;
    Ok(location.pending)
}

fn validate_destination(source: &Path, destination: &Path) -> Result<()> {
    if destination.starts_with(source) || source.starts_with(destination) {
        bail!("Choose a separate folder, outside the current data folder.");
    }
    if fs::read_dir(destination)?.next().is_some() {
        bail!("Choose an empty folder. Existing files and libraries will not be overwritten.");
    }
    Ok(())
}

pub fn resolve(default: &Path) -> Result<PathBuf> {
    let mut location = load(default)?;
    let source = location.current.clone().unwrap_or_else(|| default.to_path_buf());
    // A disconnected drive must not quietly become a new, empty library.
    if location.current.is_some() && !source.is_dir() {
        bail!("Noctua's storage folder is unavailable: {}. Reconnect it before starting Noctua.", source.display());
    }
    let Some(destination) = location.pending.clone() else { return Ok(source) };
    match relocate(default, &mut location, &source, &destination) {
        Ok(destination) => Ok(destination),
        Err(error) => {
            let message = format!("Could not switch storage: {error:#}. Original data is still at {}. Cancel or change the selection in Settings.", source.display());
            eprintln!("{message}");
            *COPY_ERROR.lock().unwrap() = Some(message);
            Ok(source)
        }
    }
}

fn relocate(default: &Path, location: &mut Location, source: &Path, destination: &Path) -> Result<PathBuf> {
    let source = fs::canonicalize(source)?;
    let owner = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(source.join("server-owner.lock"))?;
    owner.try_lock().context("The source data folder is still owned by a server. Stop that server before copying storage")?;
    let destination = fs::canonicalize(destination)
        .context("The selected storage folder is unavailable")?;
    validate_destination(&source, &destination)?;
    let staging = destination.with_file_name(format!(".noctua-copy-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        fs::create_dir(&staging)?;
        copy_data(&source, &staging)?;
        paths::copy_agent_sessions(&source, &destination)?;
        // remove_dir only removes an empty directory; concurrent additions are preserved.
        fs::remove_dir(&destination)?;
        fs::rename(&staging, &destination)?;
        location.current = Some(destination.clone());
        location.pending = None;
        save(default, location)?;
        Ok(())
    })();
    if result.is_err() && staging.exists() { let _ = fs::remove_dir_all(&staging); }
    result.with_context(|| format!("Could not switch storage. Original data is still at {}", source.display()))?;
    Ok(destination)
}

fn copy_data(source: &Path, destination: &Path) -> Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let shown = name.to_string_lossy();
        if shown == CONFIG || shown == "storage-location.lock" || matches!(shown.as_ref(), "server-owner.lock" | "server-start.lock" | "server-control") || shown == "server.json" || shown == "server.log" || shown.ends_with(".sqlite-wal") || shown.ends_with(".sqlite-shm") { continue; }
        let from = entry.path();
        let to = destination.join(&name);
        let kind = entry.file_type()?;
        if kind.is_symlink() { bail!("Cannot copy symbolic link {}. Original data has been kept.", from.display()); }
        if kind.is_dir() {
            fs::create_dir(&to)?;
            copy_data(&from, &to)?;
        } else if shown.ends_with(".sqlite") {
            // Include committed WAL contents in a consistent SQLite snapshot.
            let db = rusqlite::Connection::open_with_flags(&from, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            db.execute("VACUUM INTO ?1", [to.to_string_lossy().as_ref()])?;
        } else if kind.is_file() {
            fs::copy(&from, &to)?;
        } else { bail!("Cannot copy {}. Original data has been kept.", from.display()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("noctua-storage-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Folder { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn relocation_preserves_wal_notes_and_originals() -> Result<()> {
        let root = Folder::new();
        let source = root.0.join("original");
        let destination = root.0.join("selected");
        fs::create_dir_all(source.join("notes"))?;
        fs::write(source.join("notes/note.tex"), "Research")?;
        let db = rusqlite::Connection::open(source.join("library.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE papers (title TEXT); INSERT INTO papers VALUES ('Saved paper');")?;
        schedule(&source, &source, Some(&destination))?;
        assert_eq!(resolve(&source)?, fs::canonicalize(&destination)?);
        assert_eq!(fs::read_to_string(destination.join("notes/note.tex"))?, "Research");
        let copied = rusqlite::Connection::open(destination.join("library.sqlite"))?;
        assert_eq!(copied.query_row("SELECT title FROM papers", [], |r| r.get::<_, String>(0))?, "Saved paper");
        assert!(source.join("notes/note.tex").exists());
        assert_eq!(resolve(&source)?, fs::canonicalize(&destination)?);
        Ok(())
    }

    #[test]
    fn rejects_overwrite_nested_paths_and_missing_selected_storage() -> Result<()> {
        let root = Folder::new();
        let source = root.0.join("original");
        let destination = root.0.join("selected");
        fs::create_dir(&source)?;
        fs::create_dir(&destination)?;
        fs::write(destination.join("keep.txt"), "keep")?;
        assert!(schedule(&source, &source, Some(&destination)).is_err());
        assert!(schedule(&source, &source, Some(&source.join("nested"))).is_err());
        assert_eq!(fs::read_to_string(destination.join("keep.txt"))?, "keep");
        fs::remove_file(destination.join("keep.txt"))?;
        schedule(&source, &source, Some(&destination))?;
        assert_eq!(schedule(&source, &source, None)?, None);
        assert_eq!(resolve(&source)?, fs::canonicalize(&source)?);
        save(&source, &Location { current: Some(root.0.join("missing")), pending: None })?;
        assert!(resolve(&source).is_err());
        Ok(())
    }

    #[test]
    fn failed_copy_keeps_using_original_and_can_be_cancelled() -> Result<()> {
        let root = Folder::new();
        let source = root.0.join("original");
        let destination = root.0.join("selected");
        fs::create_dir(&source)?;
        fs::write(source.join("broken.sqlite"), "not a database")?;
        fs::write(source.join("note.tex"), "Keep my work")?;
        schedule(&source, &source, Some(&destination))?;
        assert_eq!(resolve(&source)?, fs::canonicalize(&source)?);
        assert!(fs::read_dir(&destination)?.next().is_none());
        assert_eq!(fs::read_to_string(source.join("note.tex"))?, "Keep my work");
        assert!(load(&source)?.pending.is_some());
        schedule(&source, &source, None)?;
        assert!(load(&source)?.pending.is_none());
        Ok(())
    }
    #[test]
    fn relocation_keeps_pending_selection_without_copying_a_live_owner() -> Result<()> {
        let root=Folder::new();let source=root.0.join("source");let destination=root.0.join("destination");
        fs::create_dir_all(&source)?;
        let _owner=crate::server::Owner::acquire(&source,"http://127.0.0.1:1")?;
        fs::write(source.join("research.txt"),"Keep this work")?;
        schedule(&source,&source,Some(&destination))?;
        assert_eq!(resolve(&source)?,fs::canonicalize(&source)?);
        assert!(fs::read_dir(&destination)?.next().is_none());
        assert!(load(&source)?.pending.is_some());
        assert_eq!(fs::read_to_string(source.join("research.txt"))?,"Keep this work");
        Ok(())
    }

}
