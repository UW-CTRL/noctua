//! Saved chat conversations, so they can be reopened and continued.

use std::{path::Path, sync::Mutex};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::agent::Provider;

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
        let has_provider = conn.prepare("PRAGMA table_info(chats)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?.iter().any(|n| n == "provider");
        if !has_provider { conn.execute("ALTER TABLE chats ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'", [])?; }
        conn.execute("CREATE INDEX IF NOT EXISTS chats_provider_updated ON chats(provider, updated)", [])?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Reserve ownership before starting a turn, including conversations that
    /// are interrupted before the CLI emits a session id.
    pub fn reserve(&self, id: &str, provider: Provider) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT OR IGNORE INTO chats (id,title,messages,updated,provider) VALUES (?1,'','[]',?2,?3)", params![id, now(), provider.key()])?;
        let owner: String = conn.query_row("SELECT provider FROM chats WHERE id=?1", [id], |r| r.get(0))?;
        if owner != provider.key() { anyhow::bail!("This conversation belongs to another backend. Start a new chat."); }
        Ok(())
    }

    /// Most recently used first.
    pub fn list(&self, provider: Provider) -> Result<Value> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT id, title, updated FROM chats WHERE provider = ?1 ORDER BY updated DESC LIMIT 200")?;
        let rows = st.query_map([provider.key()], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "updated": r.get::<_, i64>(2)? }))
        })?;
        Ok(json!(rows.collect::<rusqlite::Result<Vec<_>>>()?))
    }

    pub fn get(&self, id: &str, provider: Provider) -> Result<Option<Value>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT title, messages, updated FROM chats WHERE id = ?1 AND provider = ?2",
                params![id, provider.key()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
            )
            .optional()?;
        Ok(row.map(|(title, messages, updated)| {
            json!({
                "id": id, "provider": provider, "title": title, "updated": updated,
                "messages": serde_json::from_str::<Value>(&messages).unwrap_or(json!([])),
            })
        }))
    }

    /// The provider session to resume for this chat, if any.
    pub fn session(&self, id: &str, provider: Provider) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT session FROM chats WHERE id = ?1 AND provider = ?2", params![id, provider.key()], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .flatten()
    }

    /// Appends one user/assistant exchange, creating the chat if needed.
    pub fn append(&self, id: &str, provider: Provider, session: Option<&str>, user: Value, assistant: Value) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let owner: Option<String> = conn.query_row("SELECT provider FROM chats WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        if owner.as_deref().is_some_and(|p| p != provider.key()) { anyhow::bail!("This conversation belongs to another backend. Start a new chat."); }
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
            "INSERT INTO chats (id, title, session, messages, updated, provider) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET title = CASE WHEN chats.title = '' THEN excluded.title ELSE chats.title END, session = COALESCE(?3, session), messages = ?4, updated = ?5",
            params![id, title, session, json!(msgs).to_string(), now(), provider.key()],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str, provider: Provider) -> Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM chats WHERE id = ?1 AND provider = ?2", params![id, provider.key()])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_chats_migrate_and_provider_sessions_stay_separate() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("noctua-history-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("history.sqlite");
        {
            let db = Connection::open(&path)?;
            db.execute_batch("CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, session TEXT, messages TEXT NOT NULL, updated INTEGER NOT NULL);
                INSERT INTO chats VALUES ('legacy', 'Old research', 'claude-old', '[{\"role\":\"user\",\"text\":\"Existing\"}]', 1);")?;
        }
        {
            let h = History::open(&path)?;
            assert_eq!(h.list(Provider::Claude)?.as_array().unwrap().len(), 1);
            assert!(h.list(Provider::Codex)?.as_array().unwrap().is_empty());
            assert_eq!(h.session("legacy", Provider::Claude).as_deref(), Some("claude-old"));
            assert!(h.get("legacy", Provider::Codex)?.is_none());
            assert!(h.reserve("legacy", Provider::Codex).is_err());
            assert!(h.append("legacy", Provider::Codex, Some("wrong"), json!({}), json!({})).is_err());
            h.reserve("codex-chat", Provider::Codex)?;
            h.append("codex-chat", Provider::Codex, Some("codex-session"), json!({"role":"user","text":"New research"}), json!({"role":"assistant","text":"Partial","stopped":true}))?;
            // An interrupted turn without a new session id preserves its old one.
            h.append("codex-chat", Provider::Codex, None, json!({"role":"user","text":"Continue"}), json!({"role":"assistant","text":"Done"}))?;
            h.delete("codex-chat", Provider::Claude)?;
        }
        {
            let h = History::open(&path)?; // migration is idempotent, data survives restart
            assert_eq!(h.session("codex-chat", Provider::Codex).as_deref(), Some("codex-session"));
            let c = h.get("codex-chat", Provider::Codex)?.unwrap();
            assert_eq!(c["title"], "New research");
            assert_eq!(c["messages"].as_array().unwrap().len(), 4);
            assert_eq!(h.get("legacy", Provider::Claude)?.unwrap()["messages"][0]["text"], "Existing");
        }
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}
