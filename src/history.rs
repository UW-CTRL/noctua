//! Saved chat conversations, so they can be reopened and continued.

use std::{path::Path, sync::Mutex};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub struct History {
    conn: Mutex<Connection>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl History {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS chats (
                 id       TEXT PRIMARY KEY,
                 title    TEXT NOT NULL,
                 session  TEXT,
                 messages TEXT NOT NULL,
                 updated  INTEGER NOT NULL
             );",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Most recently used first.
    pub fn list(&self) -> Result<Value> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT id, title, updated FROM chats ORDER BY updated DESC LIMIT 200")?;
        let rows = st.query_map([], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "updated": r.get::<_, i64>(2)? }))
        })?;
        Ok(json!(rows.collect::<rusqlite::Result<Vec<_>>>()?))
    }

    pub fn get(&self, id: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT title, messages, updated FROM chats WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
            )
            .optional()?;
        Ok(row.map(|(title, messages, updated)| {
            json!({
                "id": id, "title": title, "updated": updated,
                "messages": serde_json::from_str::<Value>(&messages).unwrap_or(json!([])),
            })
        }))
    }

    /// The Claude session to resume for this chat, if any.
    pub fn session(&self, id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT session FROM chats WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .flatten()
    }

    /// Appends one user/assistant exchange, creating the chat if needed.
    pub fn append(&self, id: &str, session: Option<&str>, user: Value, assistant: Value) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let old: Option<String> = conn
            .query_row("SELECT messages FROM chats WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        let mut msgs: Vec<Value> = old.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or_default();
        let title: String = user["text"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
        let title = match title.char_indices().nth(60) {
            Some((i, _)) => format!("{}…", &title[..i]),
            None => title,
        };
        msgs.push(user);
        msgs.push(assistant);
        conn.execute(
            "INSERT INTO chats (id, title, session, messages, updated) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET session = COALESCE(?3, session), messages = ?4, updated = ?5",
            params![id, title, session, json!(msgs).to_string(), now()],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM chats WHERE id = ?1", params![id])?;
        Ok(())
    }
}
