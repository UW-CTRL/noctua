//! Server-side helpers; client/lifecycle operations live in noctua-client.
use anyhow::Result;
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}};
pub use noctua_client::server::*;

pub fn describe() -> Result<Value> {
    Ok(
        json!({"product":"noctua","version":env!("CARGO_PKG_VERSION"),"api_version":API_VERSION,"data_version":DATA_VERSION,"paper_compilers":{"tectonic":crate::paper::VERSION,"texlive":crate::paper::PDFLATEX_VERSION},"executable_hash":executable_hash(&std::env::current_exe()?)?}),
    )
}

pub fn backup(data: &Path) -> Result<()> {
    fn collect(root: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_symlink() {
                continue;
            }
            if entry.file_type()?.is_dir() && entry.file_name() != "backups" {
                collect(&path, paths)?;
            } else if path.extension().is_some_and(|e| e == "sqlite") {
                paths.push(path);
            }
        }
        Ok(())
    }
    let mut names = Vec::new();
    collect(data, &mut names)?;
    if names.is_empty() {
        return Ok(());
    }
    let destination = data.join("backups").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&destination)?;
    for source in names {
        let target = destination.join(source.strip_prefix(data)?);
        fs::create_dir_all(target.parent().unwrap())?;
        let db = rusqlite::Connection::open_with_flags(
            &source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn future_format_is_not_opened_and_nested_wal_is_snapshotted() -> Result<()> {
        let f = tempfile::tempdir()?;
        fs::create_dir(f.path().join("library"))?;
        let db = rusqlite::Connection::open(f.path().join("library/library.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE research (title TEXT); INSERT INTO research VALUES ('Kept');")?;
        let owner = Owner::acquire_with_machine(f.path(), "http://127.0.0.1:1", None, env!("CARGO_PKG_VERSION"), backup)?;
        drop(owner);
        let snapshot = fs::read_dir(f.path().join("backups"))?
            .next()
            .unwrap()?
            .path()
            .join("library/library.sqlite");
        let copied = rusqlite::Connection::open(snapshot)?;
        assert_eq!(
            copied.query_row("SELECT title FROM research", [], |r| r.get::<_, String>(0))?,
            "Kept"
        );
        fs::write(
            f.path().join("server-format.json"),
            json!({"server_id":"keep","data_version":999}).to_string(),
        )?;
        assert!(Owner::acquire_with_machine(f.path(), "http://127.0.0.1:1", None, env!("CARGO_PKG_VERSION"), backup).is_err());
        assert!(fs::read_to_string(f.path().join("server-format.json"))?.contains("999"));
        Ok(())
    }
}
