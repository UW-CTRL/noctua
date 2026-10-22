//! On-disk response cache so repeated lookups never spend Semantic Scholar quota.

use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub struct Cache {
    conn: Mutex<Connection>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Cache {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS cache (
                 key     TEXT PRIMARY KEY,
                 body    TEXT NOT NULL,
                 fetched INTEGER NOT NULL
             );",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Returns the cached value if it is younger than `ttl_secs`.
    pub fn get(&self, key: &str, ttl_secs: i64) -> Option<Value> {
        let conn = self.conn.lock().ok()?;
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT body, fetched FROM cache WHERE key = ?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()?;
        let (body, fetched) = row?;
        if now() - fetched > ttl_secs {
            return None;
        }
        serde_json::from_str(&body).ok()
    }

    pub fn put(&self, key: &str, value: &Value) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO cache (key, body, fetched) VALUES (?1, ?2, ?3)",
                params![key, value.to_string(), now()],
            );
        }
    }
}
