//! Optional collection research data. Durable, revisioned, and outside the file tree.
use crate::{ApiResult, Shared};
use anyhow::{Context, Result};
use axum::{
    extract::{Path as RoutePath, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

static GATE: Mutex<()> = Mutex::new(());

#[derive(Clone, Default, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TargetDate {
    pub title: String,
    /// A personal calendar date, not an official deadline or UTC timestamp.
    pub date: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Research {
    #[serde(default = "legacy_project", skip_serializing)]
    pub is_project: bool,
    pub version: u32,
    pub revision: u64,
    pub goal: String,
    pub progress: u8,
    pub dates: Vec<TargetDate>,
}
fn legacy_project() -> bool {
    true
}
impl Default for Research {
    fn default() -> Self {
        Self {
            is_project: false,
            version: 1,
            revision: 0,
            goal: String::new(),
            progress: 0,
            dates: vec![],
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    #[serde(default = "legacy_project")]
    pub is_project: bool,
    pub revision: u64,
    pub goal: String,
    pub progress: u8,
    pub dates: Vec<TargetDate>,
}
fn bad(message: &str) -> anyhow::Error {
    crate::Status(StatusCode::BAD_REQUEST, message.into()).into()
}
fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap();
    let month: u32 = date[5..7].parse().unwrap();
    let day: u32 = date[8..].parse().unwrap();
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    year > 0 && day > 0 && day <= days
}
fn validate(goal: &str, progress: u8, dates: &[TargetDate]) -> Result<()> {
    if goal.len() > 20_000 {
        return Err(bad("Goal must be at most 20,000 bytes."));
    }
    if progress > 100 {
        return Err(bad("Progress must be between 0 and 100."));
    }
    if dates.len() > 50 {
        return Err(bad("Use at most 50 personal target dates."));
    }
    for target in dates {
        if target.title.trim().is_empty() || target.title.len() > 300 || !valid_date(&target.date) {
            return Err(bad(
                "Each target needs a title (up to 300 bytes) and a valid YYYY-MM-DD date.",
            ));
        }
    }
    Ok(())
}
/// Check each owned component; never follow a collection/workspace/file symlink.
fn path(collection: &Path) -> Result<PathBuf> {
    named_path(collection, "state.json")
}
fn named_path(collection: &Path, filename: &str) -> Result<PathBuf> {
    let mut current = collection.to_path_buf();
    for part in ["", ".workspace", "research", filename] {
        if !part.is_empty() {
            current.push(part);
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                anyhow::ensure!(
                    !meta.file_type().is_symlink(),
                    "Research storage cannot use symlinks."
                );
                anyhow::ensure!(
                    if part == filename {
                        meta.is_file()
                    } else {
                        meta.is_dir()
                    },
                    "Invalid research storage path."
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(current)
}
fn read(collection: &Path) -> Result<Research> {
    let active = path(collection)?;
    let is_project = active.is_file();
    let file = if is_project { active } else { named_path(collection, "inactive.json")? };
    let content = match fs::read(&file) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Research::default()),
        Err(e) => return Err(e.into()),
    };
    let mut state: Research = serde_json::from_slice(&content)
        .context("Cannot read collection research data; existing data was preserved")?;
    anyhow::ensure!(
        state.version == 1,
        "Unsupported collection research format; existing data was preserved."
    );
    state.is_project = is_project;
    validate(&state.goal, state.progress, &state.dates)?;
    Ok(state)
}
fn save(collection: &Path, edit: Edit) -> Result<Research> {
    let _gate = GATE.lock().unwrap();
    validate(&edit.goal, edit.progress, &edit.dates)?;
    let current = read(collection)?;
    if current.revision != edit.revision {
        return Err(crate::Status(StatusCode::CONFLICT, "Research details changed on another device. Your edits are still here. Reopen Research details to load the saved version before trying again.".into()).into());
    }
    let state = Research {
        is_project: edit.is_project,
        version: 1,
        revision: current
            .revision
            .checked_add(1)
            .context("Research revision exhausted")?,
        goal: edit.goal,
        progress: edit.progress,
        dates: edit.dates,
    };
    let active = path(collection)?;
    let inactive = named_path(collection, "inactive.json")?;
    let file = if state.is_project { &active } else { &inactive };
    fs::create_dir_all(file.parent().unwrap())?;
    // A uniquely named temporary file avoids following a pre-existing .tmp symlink.
    let mut temporary = tempfile::NamedTempFile::new_in(file.parent().unwrap())?;
    use std::io::Write;
    temporary.write_all(serde_json::to_string_pretty(&state)?.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(file).map_err(|e| e.error)?;
    if state.is_project && inactive.exists() {
        fs::remove_file(inactive)?;
    }
    if !state.is_project && active.exists() {
        fs::remove_file(active)?;
    }
    Ok(state)
}
pub fn collection_kind(app: &crate::App, target: &str) -> Result<bool> {
    let _gate = GATE.lock().unwrap();
    Ok(path(&crate::workspace::dir(app, target)?)?.is_file())
}
pub fn initialize_project(app: &crate::App, target: &str) -> Result<()> {
    save(
        &crate::workspace::dir(app, target)?,
        Edit {
            is_project: true,
            revision: 0,
            goal: String::new(),
            progress: 0,
            dates: vec![],
        },
    )?;
    Ok(())
}
fn response(state: Research) -> serde_json::Value {
    let mut value = json!(state);
    value["is_project"] = json!(state.is_project);
    value
}
pub async fn get(State(app): Shared, RoutePath(target): RoutePath<String>) -> ApiResult {
    let _gate = GATE.lock().unwrap();
    Ok(Json(response(read(&crate::workspace::dir(&app, &target)?)?)))
}
pub async fn edit(
    State(app): Shared,
    RoutePath(target): RoutePath<String>,
    Json(edit): Json<Edit>,
) -> ApiResult {
    Ok(Json(response(save(
        &crate::workspace::dir(&app, &target)?,
        edit
    )?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edit(revision: u64) -> Edit {
        Edit {
            is_project: true,
            revision,
            goal: "Evaluate world models".into(),
            progress: 35,
            dates: vec![TargetDate {
                title: "First draft".into(),
                date: "2028-02-29".into(),
            }],
        }
    }
    #[test]
    fn persistence_isolation_and_conflicts() -> Result<()> {
        let root = tempfile::tempdir()?;
        let a = root.path().join("C1");
        let b = root.path().join("C2");
        assert_eq!(read(&a)?, Research::default());
        assert!(!a.exists(), "Reading must not migrate or create folders");
        let first = save(&a, edit(0))?;
        assert_eq!(first, read(&a)?);
        assert_eq!(first.revision, 1);
        assert_eq!(read(&b)?, Research::default());
        let conflict = save(&a, edit(0)).unwrap_err();
        assert_eq!(
            conflict.downcast_ref::<crate::Status>().unwrap().0,
            StatusCode::CONFLICT
        );
        assert_eq!(read(&a)?, first);
        fs::rename(&a, &b)?;
        assert_eq!(
            read(&b)?,
            first,
            "Collection storage moves must preserve metadata"
        );
        assert_eq!(save(&b, edit(1))?.revision, 2);
        assert_eq!(
            crate::notes::Notes::new(root.path().into()).list("C2")?,
            json!([])
        );
        assert!(crate::workspace::safe_path(".workspace/research/state.json").is_err());
        Ok(())
    }
    #[test]
    fn project_activation_uses_file_presence() -> Result<()> {
        let root = tempfile::tempdir()?;
        let first = save(root.path(), edit(0))?;
        let active = path(root.path())?;
        let persisted: serde_json::Value = serde_json::from_slice(&fs::read(&active)?)?;
        assert!(persisted.get("is_project").is_none());
        let mut disabled = edit(first.revision);
        disabled.is_project = false;
        let inactive = save(root.path(), disabled)?;
        assert!(!active.exists());
        assert!(!read(root.path())?.is_project);
        assert_eq!(read(root.path())?.goal, first.goal);
        let restored = save(root.path(), edit(inactive.revision))?;
        assert!(active.is_file());
        assert!(read(root.path())?.is_project);
        assert_eq!(restored.goal, first.goal);
        fs::remove_file(active)?;
        assert_eq!(read(root.path())?, Research::default());
        Ok(())
    }
    #[test]
    fn invalid_and_future_data_are_preserved() -> Result<()> {
        let root = tempfile::tempdir()?;
        let first = save(root.path(), edit(0))?;
        let mut invalid = edit(1);
        invalid.progress = 101;
        assert!(save(root.path(), invalid).is_err());
        for date in [
            "2027-02-29",
            "2028-04-31",
            "0000-01-01",
            "2028-13-01",
            "2028-01-00",
            "é202-01-01",
        ] {
            assert!(!valid_date(date));
        }
        let file = path(root.path())?;
        fs::write(&file, "{broken")?;
        assert!(save(root.path(), edit(1)).is_err());
        assert_eq!(fs::read_to_string(&file)?, "{broken");
        let mut future = first;
        future.version = 2;
        fs::write(&file, serde_json::to_vec(&future)?)?;
        assert!(save(root.path(), edit(1)).is_err());
        assert_eq!(
            serde_json::from_slice::<Research>(&fs::read(file)?)?,
            future
        );
        Ok(())
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_redirect_research_storage() -> Result<()> {
        let root = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        std::os::unix::fs::symlink(outside.path(), root.path().join(".workspace"))?;
        assert!(save(root.path(), edit(0)).is_err());
        assert_eq!(fs::read_dir(outside.path())?.count(), 0);
        Ok(())
    }
}
