//! Persistent tag identities and digit shortcuts shared by papers and notes.
//! Note assignments live outside editor documents so draft saves cannot lose tags.
use super::*;
use axum::{
    extract::{Path, State},
    Json,
};
use std::sync::Arc;

pub(super) fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS tags(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS tag_shortcuts(digit TEXT PRIMARY KEY,tag TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS note_tags(folder TEXT NOT NULL,note TEXT NOT NULL,tag TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,PRIMARY KEY(folder,note,tag));
        CREATE TABLE IF NOT EXISTS tag_state(id INTEGER PRIMARY KEY);")?;
    let has_enabled = c
        .prepare("PRAGMA table_info(tag_shortcuts)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|name| name == "enabled");
    if !has_enabled {
        let tx = c.unchecked_transaction()?;
        tx.execute(
            "ALTER TABLE tag_shortcuts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
        // Adopt the smaller default set on upgrade without disabling custom mappings.
        tx.execute("UPDATE tag_shortcuts SET enabled=0 WHERE digit IN ('4','5','6','7','8','9','0') AND tag IN (SELECT id FROM tags WHERE name=digit || '️⃣')", [])?;
        tx.commit()?;
    }
    sync_papers(c)?;
    if c.query_row("SELECT count(*) FROM tag_state", [], |r| r.get::<_, i64>(0))? == 0 {
        let tx = c.unchecked_transaction()?;
        for digit in ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] {
            let tag = ensure(&tx, &format!("{digit}\u{fe0f}\u{20e3}"))?;
            tx.execute(
                "INSERT INTO tag_shortcuts(digit,tag,enabled) VALUES(?1,?2,?3)",
                params![digit.to_string(), tag, matches!(digit, '1' | '2' | '3')],
            )?;
        }
        tx.execute("INSERT INTO tag_state VALUES(1)", [])?;
        tx.commit()?;
    }
    Ok(())
}
fn ensure(c: &Connection, name: &str) -> Result<String> {
    c.execute(
        "INSERT OR IGNORE INTO tags VALUES(?1,?2)",
        params![id("t"), name],
    )?;
    Ok(c.query_row("SELECT id FROM tags WHERE name=?1", [name], |r| r.get(0))?)
}
fn sync_papers(c: &Connection) -> Result<()> {
    let mut stmt=c.prepare("SELECT DISTINCT j.value FROM papers p,json_each(p.data,'$.tags') j WHERE j.type='text' AND trim(j.value)<>''")?;
    for name in stmt.query_map([], |r| r.get::<_, String>(0))? {
        ensure(c, &name?)?;
    }
    Ok(())
}
impl Library {
    pub fn note_tags(&self, folder: &str, note: &str) -> Result<Value> {
        let c = self.conn.lock().unwrap();
        let mut s=c.prepare("SELECT t.name FROM note_tags n JOIN tags t ON t.id=n.tag WHERE n.folder=?1 AND n.note=?2 ORDER BY t.name")?;
        let names = s
            .query_map(params![folder, note], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!(names))
    }
    pub fn set_note_tag(&self, folder: &str, note: &str, name: &str, remove: bool) -> Result<()> {
        let _gate = self.edit_gate.lock().unwrap();
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        let tag = ensure(&tx, name)?;
        if remove {
            tx.execute(
                "DELETE FROM note_tags WHERE folder=?1 AND note=?2 AND tag=?3",
                params![folder, note, tag],
            )?;
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO note_tags VALUES(?1,?2,?3)",
                params![folder, note, tag],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    /// Publish the same tags with a transferred note, while retaining the
    /// source assignments so restoring its source Trash also restores tags.
    pub fn copy_note_tags(&self, source: &str, destination: &str, notes: &[String]) -> Result<()> {
        if notes.is_empty() {
            return Ok(());
        }
        anyhow::ensure!(source != destination, "Choose another note folder");
        let _gate = self.edit_gate.lock().unwrap();
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        for note in notes {
            // A failed publication may leave destination metadata. Replace that
            // baseline instead of reviving tags removed before the retry.
            tx.execute(
                "DELETE FROM note_tags WHERE folder=?1 AND note=?2",
                params![destination, note],
            )?;
            tx.execute("INSERT INTO note_tags(folder,note,tag) SELECT ?1,note,tag FROM note_tags WHERE folder=?2 AND note=?3", params![destination, source, note])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn tag_list(&self) -> Result<Value> {
        let c = self.conn.lock().unwrap();
        sync_papers(&c)?;
        let mut s=c.prepare("SELECT t.id,t.name,s.digit,COALESCE(s.enabled,0) FROM tags t LEFT JOIN tag_shortcuts s ON s.tag=t.id ORDER BY CASE WHEN s.digit='0' THEN '9z' ELSE COALESCE(s.digit,'z') END,t.name")?;
        let rows=s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"digit":r.get::<_,Option<String>>(2)?,"enabled":r.get::<_,bool>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!(rows))
    }
    pub fn change_tag(&self, b: &Value) -> Result<()> {
        let _gate = self.edit_gate.lock().unwrap();
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        sync_papers(&tx)?;
        if b["op"] == "shortcut" {
            let digit = b["digit"]
                .as_str()
                .filter(|s| s.len() == 1 && s.as_bytes()[0].is_ascii_digit())
                .context("Choose a digit from 0 to 9")?;
            let name = b["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= 200)
                .context("Enter a tag name")?;
            let existing: Option<String> = tx
                .query_row("SELECT id FROM tags WHERE name=?1", [name], |r| r.get(0))
                .optional()?;
            let old: Option<String> = tx
                .query_row(
                    "SELECT tag FROM tag_shortcuts WHERE digit=?1",
                    [digit],
                    |r| r.get(0),
                )
                .optional()?;
            let tag = if let Some(existing) = existing {
                existing
            } else if let Some(old) = old {
                rename_paper_tags(&tx, &old, Some(name))?;
                tx.execute("UPDATE tags SET name=?1 WHERE id=?2", params![name, old])?;
                old
            } else {
                ensure(&tx, name)?
            };
            let enabled = b
                .get("enabled")
                .map(|v| {
                    v.as_bool()
                        .context("Choose whether the shortcut is enabled")
                })
                .transpose()?;
            tx.execute(
                "INSERT INTO tag_shortcuts(digit,tag,enabled) VALUES(?1,?2,COALESCE(?3,1)) ON CONFLICT(digit) DO UPDATE SET tag=excluded.tag,enabled=COALESCE(?3,tag_shortcuts.enabled)",
                params![digit, tag, enabled],
            )?;
        } else if b["op"] == "delete" {
            let tag = b["id"].as_str().context("Choose a tag")?;
            rename_paper_tags(&tx, tag, None)?;
            tx.execute("DELETE FROM tags WHERE id=?1", [tag])?;
        } else {
            bail!("Unknown tag action");
        }
        // Fence existing bulk-operation baselines after global metadata changes.
        tx.execute(
            "UPDATE library_state SET revision=revision+1 WHERE id=1",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
}
fn rename_paper_tags(c: &Connection, tag: &str, name: Option<&str>) -> Result<()> {
    let old: String = c.query_row("SELECT name FROM tags WHERE id=?1", [tag], |r| r.get(0))?;
    let mut s=c.prepare("SELECT key,data FROM papers WHERE EXISTS(SELECT 1 FROM json_each(data,'$.tags') WHERE value=?1)")?;
    let rows = s
        .query_map([&old], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (key, body) in rows {
        let mut p: Value = serde_json::from_str(&body)?;
        let tags = p["tags"]
            .as_array()
            .context("Invalid tags")?
            .iter()
            .filter_map(|v| {
                if v == &old {
                    name.map(|s| json!(s))
                } else {
                    Some(v.clone())
                }
            })
            .collect::<Vec<_>>();
        p["tags"] = json!(tags);
        c.execute(
            "UPDATE papers SET data=?1,revision=revision+1 WHERE key=?2",
            params![p.to_string(), key],
        )?;
    }
    Ok(())
}
pub async fn list(State(app): State<Arc<crate::App>>) -> crate::ApiResult {
    Ok(Json(app.library.tag_list()?))
}
pub async fn change(State(app): State<Arc<crate::App>>, Json(b): Json<Value>) -> crate::ApiResult {
    app.library.change_tag(&b)?;
    Ok(Json(app.library.tag_list()?))
}
pub async fn note(
    State(app): State<Arc<crate::App>>,
    Path((target, note)): Path<(String, String)>,
    Json(b): Json<Value>,
) -> crate::ApiResult {
    let folder = app.library.folder_id(&target)?;
    if app.notes.get(&folder, &note)?.is_none() {
        return Err(
            crate::Status(axum::http::StatusCode::NOT_FOUND, "Note not found".into()).into(),
        );
    }
    let name = b["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 200)
        .context("Enter a tag name")?;
    app.library
        .set_note_tag(&folder, &note, name, b["remove"] == true)?;
    Ok(Json(app.library.note_tags(&folder, &note)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcut_defaults_disable_and_restart() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let lib = Library::open(dir.path().into())?;
        let tags = lib.tag_list()?;
        let active: Vec<_> = tags
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["enabled"] == true)
            .map(|t| t["digit"].as_str().unwrap())
            .collect();
        assert_eq!(active, ["1", "2", "3"]);
        assert_eq!(tags[0]["name"], "1️⃣");
        lib.set_note_tag("L1", "n1", "1️⃣", false)?;
        lib.change_tag(&json!({"op":"shortcut","digit":"1","name":"1️⃣","enabled":false}))?;
        assert_eq!(lib.note_tags("L1", "n1")?, json!(["1️⃣"]));
        // Renaming a disabled mapping must not implicitly enable it.
        lib.change_tag(&json!({"op":"shortcut","digit":"1","name":"Reading"}))?;
        assert_eq!(lib.tag_list()?[0]["enabled"], false);
        lib.change_tag(&json!({"op":"shortcut","digit":"4","name":"4️⃣","enabled":true}))?;
        let before = lib.tag_list()?;
        drop(lib);
        assert_eq!(Library::open(dir.path().into())?.tag_list()?, before);
        Ok(())
    }
    #[test]
    fn migrate_existing_shortcuts_without_resetting_them() -> Result<()> {
        let c = Connection::open_in_memory()?;
        c.execute_batch("CREATE TABLE papers(data TEXT); CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE); CREATE TABLE tag_shortcuts(digit TEXT PRIMARY KEY,tag TEXT NOT NULL REFERENCES tags(id)); CREATE TABLE tag_state(id INTEGER PRIMARY KEY); INSERT INTO tags VALUES('custom','Custom'); INSERT INTO tag_shortcuts VALUES('7','custom'); INSERT INTO tag_state VALUES(1);")?;
        initialize(&c)?;
        initialize(&c)?;
        let mapping: (String, String, bool) =
            c.query_row("SELECT digit,tag,enabled FROM tag_shortcuts", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
        assert_eq!(mapping, ("7".into(), "custom".into(), true));
        Ok(())
    }
    #[test]
    fn migrate_numeric_defaults_to_three_enabled_keys() -> Result<()> {
        let c = Connection::open_in_memory()?;
        c.execute_batch("CREATE TABLE papers(data TEXT); CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE); CREATE TABLE tag_shortcuts(digit TEXT PRIMARY KEY,tag TEXT NOT NULL REFERENCES tags(id)); CREATE TABLE tag_state(id INTEGER PRIMARY KEY); INSERT INTO tag_state VALUES(1); INSERT INTO tags VALUES('one','1️⃣'),('four','4️⃣'); INSERT INTO tag_shortcuts VALUES('1','one'),('4','four');")?;
        initialize(&c)?;
        assert!(c.query_row(
            "SELECT enabled FROM tag_shortcuts WHERE digit='1'",
            [],
            |r| r.get::<_, bool>(0)
        )?);
        assert!(!c.query_row(
            "SELECT enabled FROM tag_shortcuts WHERE digit='4'",
            [],
            |r| r.get::<_, bool>(0)
        )?);
        // A later explicit opt-in survives subsequent starts.
        c.execute("UPDATE tag_shortcuts SET enabled=1 WHERE digit='4'", [])?;
        initialize(&c)?;
        assert!(c.query_row(
            "SELECT enabled FROM tag_shortcuts WHERE digit='4'",
            [],
            |r| r.get::<_, bool>(0)
        )?);
        Ok(())
    }
    #[test]
    fn identities_reuse_rename_delete_and_restart() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let lib = Library::open(dir.path().into())?;
        let key = lib.save(&json!({"title":"Tagged paper","tags":["🟡","other"]}), "L1")?;
        lib.set_note_tag("L1", "n1", "🟡", false)?;
        lib.change_tag(&json!({"op":"shortcut","digit":"1","name":"🟡"}))?;
        let tags = lib.tag_list()?;
        let tag = tags
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["digit"] == "1")
            .unwrap()["id"]
            .clone();
        assert_eq!(
            tags.as_array()
                .unwrap()
                .iter()
                .filter(|t| t["name"] == "🟡")
                .count(),
            1
        );
        lib.change_tag(&json!({"op":"shortcut","digit":"1","name":"🔵"}))?;
        assert_eq!(lib.note_tags("L1", "n1")?, json!(["🔵"]));
        assert_eq!(lib.paper(&key)?["tags"], json!(["🔵", "other"]));
        lib.set_note_tag("L1", "n1", "🔵", true)?;
        assert_eq!(lib.note_tags("L1", "n1")?, json!([]));
        lib.set_note_tag("L1", "n1", "🔵", false)?;
        lib.change_tag(&json!({"op":"shortcut","digit":"2","name":"other"}))?;
        lib.change_tag(&json!({"op":"shortcut","digit":"1","name":"other"}))?;
        assert_eq!(
            lib.note_tags("L1", "n1")?,
            json!(["🔵"]),
            "Reuse must not migrate assignments"
        );
        lib.change_tag(&json!({"op":"delete","id":tag}))?;
        assert_eq!(lib.paper(&key)?["tags"], json!(["other"]));
        assert_eq!(lib.note_tags("L1", "n1")?, json!([]));
        let before = lib.tag_list()?;
        drop(lib);
        let reopened = Library::open(dir.path().into())?;
        assert_eq!(reopened.tag_list()?, before);
        assert_eq!(reopened.paper(&key)?["title"], "Tagged paper");
        Ok(())
    }
}
