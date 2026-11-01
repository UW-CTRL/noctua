//! Short, independent personal thoughts attached to a saved Library paper.
use super::*;
use crate::{ApiResult, Shared};
use axum::{
    extract::{Path, State},
    Json,
};

pub(super) fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS paper_memos(id TEXT PRIMARY KEY,paper TEXT NOT NULL REFERENCES papers(key) ON DELETE CASCADE,text TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1); CREATE INDEX IF NOT EXISTS paper_memos_paper ON paper_memos(paper,created);")?;
    Ok(())
}
fn active(c: &Connection, key: &str) -> Result<()> {
    if !c.query_row("SELECT EXISTS(SELECT 1 FROM papers WHERE key=?1 AND key NOT IN (SELECT id FROM library_trash WHERE kind='paper'))",[key],|r|r.get::<_,bool>(0))? {return Err(missing());}
    Ok(())
}
fn read(c: &Connection, key: &str) -> Result<Value> {
    active(c, key)?;
    let mut stmt=c.prepare("SELECT id,text,created,updated,revision FROM paper_memos WHERE paper=?1 ORDER BY created,rowid")?;
    let rows=stmt.query_map([key],|r|Ok(json!({"id":r.get::<_,String>(0)?,"text":r.get::<_,String>(1)?,"created":r.get::<_,i64>(2)?,"updated":r.get::<_,i64>(3)?,"revision":r.get::<_,i64>(4)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(rows))
}
impl Library {
    pub fn paper_memos(&self, key: &str) -> Result<Value> {
        read(&self.conn.lock().unwrap(), key)
    }
    pub fn change_paper_memo(&self, key: &str, body: &Value) -> Result<Value> {
        Ok(self.change_paper_memo_result(key, body)?.0)
    }
    /// Return both the UI list and the single affected memo for bounded agent replies.
    pub fn change_paper_memo_result(&self, key: &str, body: &Value) -> Result<(Value, Value)> {
        let _gate = self.edit_gate.lock().unwrap();
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        active(&tx, key)?;
        let op = text(body, "op");
        let content = if op == "delete" {
            ""
        } else {
            let content = body["text"].as_str().context("Enter a memo")?.trim();
            if content.is_empty() || content.chars().count() > 4000 {
                return Err(bad("Write a memo of 1–4000 characters"));
            }
            content
        };
        let changed_id;
        match op {
            "create" => {
                let count: i64 = tx.query_row(
                    "SELECT count(*) FROM paper_memos WHERE paper=?1",
                    [key],
                    |r| r.get(0),
                )?;
                if count >= 1000 {
                    return Err(bad("A paper can have at most 1000 memos"));
                }
                changed_id = id("memo-");
                tx.execute(
                    "INSERT INTO paper_memos(id,paper,text,created,updated) VALUES(?1,?2,?3,?4,?4)",
                    params![changed_id, key, content, now()],
                )?;
            }
            "edit" | "delete" => {
                let memo = body["id"].as_str().context("Choose a memo")?;
                changed_id = memo.to_owned();
                let revision = body["revision"]
                    .as_i64()
                    .context("Read the memo revision before editing")?;
                let changed = if op == "delete" {
                    tx.execute(
                        "DELETE FROM paper_memos WHERE id=?1 AND paper=?2 AND revision=?3",
                        params![memo, key, revision],
                    )?
                } else {
                    tx.execute("UPDATE paper_memos SET text=?1,updated=?2,revision=revision+1 WHERE id=?3 AND paper=?4 AND revision=?5",params![content,now(),memo,key,revision])?
                };
                if changed == 0 {
                    return Err(conflict(
                        "This memo changed in another window. Reload memos before trying again.",
                    ));
                }
            }
            _ => return Err(bad("Unknown memo action")),
        }
        let result = read(&tx, key)?;
        let changed = if op == "delete" {
            json!({"id":changed_id,"deleted":true})
        } else {
            result
                .as_array()
                .unwrap()
                .iter()
                .find(|memo| memo["id"] == changed_id)
                .context("Saved memo not found")?
                .clone()
        };
        tx.commit()?;
        Ok((result, changed))
    }
}
pub async fn list(State(app): Shared, Path(key): Path<String>) -> ApiResult {
    Ok(Json(app.library.paper_memos(&key)?))
}
pub async fn change(
    State(app): Shared,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    Ok(Json(app.library.change_paper_memo(&key, &body)?))
}
