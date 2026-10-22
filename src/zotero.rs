//! Zotero integration.
//!
//! * Writing goes through the Zotero desktop app's local connector server
//!   (the same API the browser extension uses), so no web API key is needed
//!   but Zotero must be running.
//! * Reading collections prefers the connector (always current) and falls
//!   back to reading `zotero.sqlite` read-only when Zotero is closed.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use reqwest::Client;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

const CONNECTOR: &str = "http://127.0.0.1:23119/connector";

pub struct Zotero {
    http: Client,
    /// `<Zotero data folder>/zotero.sqlite`; None when Zotero isn't set up.
    db_path: std::sync::RwLock<Option<PathBuf>>,
    /// Semantic Scholar ids saved during this run (the sqlite snapshot can lag).
    added: Mutex<HashSet<String>>,
}

impl Zotero {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client");
        Self {
            http,
            db_path: std::sync::RwLock::new(data_dir.map(|d| d.join("zotero.sqlite"))),
            added: Mutex::new(HashSet::new()),
        }
    }

    async fn connector(&self, endpoint: &str, body: &Value) -> Result<reqwest::Response> {
        let resp = self
            .http
            .post(format!("{CONNECTOR}/{endpoint}"))
            .header("X-Zotero-Connector-API-Version", "3")
            .json(body)
            .send()
            .await
            .context("Zotero is not running (could not reach its connector on port 23119)")?;
        Ok(resp)
    }

    /// Libraries and collections as a flat, depth-annotated list:
    /// `{ live, selected, targets: [{ id: "L1" | "C42", name, level, count }] }`.
    /// `live` is false when read from the database snapshot.
    pub async fn collections(&self) -> Result<Value> {
        self.db_path()?;  // not set up (or turned off in Settings)
        let mut out = None;
        if let Ok(resp) = self.connector("getSelectedCollection", &json!({})).await {
            if resp.status().is_success() {
                let v: Value = resp.json().await?;
                let targets: Vec<Value> = v["targets"]
                    .as_array()
                    .map(|a| a.as_slice())
                    .unwrap_or_default()
                    .iter()
                    .map(|t| json!({ "id": t["id"], "name": t["name"], "level": t["level"] }))
                    .collect();
                let selected = match v["id"].as_u64() {
                    Some(id) => format!("C{id}"),
                    None => format!("L{}", v["libraryID"].as_u64().unwrap_or(1)),
                };
                out = Some(json!({ "live": true, "selected": selected, "targets": targets }));
            }
        }
        let mut out = match out {
            Some(v) => v,
            None => json!({ "live": false, "selected": null, "targets": self.collections_from_db()? }),
        };
        if let (Ok(counts), Some(targets)) = (self.item_counts(), out["targets"].as_array_mut()) {
            for t in targets {
                if let Some(n) = t["id"].as_str().and_then(|id| counts.get(id)) {
                    t["count"] = json!(n);
                }
            }
        }
        Ok(out)
    }

    /// Number of top-level items per target id ("L1", "C42").
    fn item_counts(&self) -> Result<HashMap<String, i64>> {
        let db = self.open_db()?;
        let mut counts = HashMap::new();
        let queries = [
            ("C", format!("SELECT ci.collectionID, count(*) FROM collectionItems ci WHERE ci.itemID IN ({TOP_LEVEL}) GROUP BY 1")),
            ("L", format!("SELECT i.libraryID, count(*) FROM items i WHERE i.itemID IN ({TOP_LEVEL}) GROUP BY 1")),
        ];
        for (prefix, sql) in queries {
            let mut stmt = db.prepare(&sql)?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
            for (id, n) in rows.flatten() {
                counts.insert(format!("{prefix}{id}"), n);
            }
        }
        Ok(counts)
    }

    /// Top-level items directly in a collection ("C42") or anywhere in a
    /// library ("L1"), with the identifiers needed to find them on
    /// Semantic Scholar.
    pub fn items(&self, target: &str) -> Result<Vec<Value>> {
        let (kind, id) = target.split_at(1.min(target.len()));
        let id: i64 = id.parse().context("bad target id")?;
        let scope = match kind {
            "C" => "SELECT itemID FROM collectionItems WHERE collectionID = ?1",
            "L" => "SELECT itemID FROM items WHERE libraryID = ?1",
            _ => bail!("target must start with C or L"),
        };
        let ids = format!("SELECT itemID FROM items WHERE itemID IN ({scope}) AND itemID IN ({TOP_LEVEL})");
        let db = self.open_db()?;

        let mut items: HashMap<i64, serde_json::Map<String, Value>> = HashMap::new();
        let mut order = Vec::new();
        let mut stmt = db.prepare(&format!(
            "SELECT i.itemID, i.key, t.typeName, i.dateAdded, g.groupID
             FROM items i
             JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
             LEFT JOIN groups g ON g.libraryID = i.libraryID
             WHERE i.itemID IN ({ids})"
        ))?;
        let rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<i64>>(4)?,
            ))
        })?;
        for (item_id, key, item_type, added, group) in rows.flatten() {
            let lib = group.map_or("library".to_string(), |g| format!("groups/{g}"));
            let mut m = serde_json::Map::new();
            m.insert("key".into(), json!(key));
            m.insert("itemType".into(), json!(item_type));
            m.insert("dateAdded".into(), json!(added));
            m.insert("zoteroUrl".into(), json!(format!("zotero://select/{lib}/items/{key}")));
            m.insert("creators".into(), json!([]));
            items.insert(item_id, m);
            order.push(item_id);
        }

        let mut stmt = db.prepare(&format!(
            "SELECT d.itemID, f.fieldName, v.value
             FROM itemData d
             JOIN fields f ON f.fieldID = d.fieldID
             JOIN itemDataValues v ON v.valueID = d.valueID
             WHERE d.itemID IN ({ids})
               AND f.fieldName IN ('title', 'date', 'DOI', 'url', 'extra', 'publicationTitle',
                                   'proceedingsTitle', 'bookTitle', 'conferenceName',
                                   'repository', 'archiveID', 'websiteTitle', 'abstractNote')"
        ))?;
        let rows = stmt.query_map([id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        for (item_id, field, value) in rows.flatten() {
            if let Some(m) = items.get_mut(&item_id) {
                m.insert(field, json!(value));
            }
        }

        let mut stmt = db.prepare(&format!(
            "SELECT ic.itemID, c.firstName, c.lastName
             FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
             WHERE ic.itemID IN ({ids})
             ORDER BY ic.itemID, ic.orderIndex"
        ))?;
        let rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        })?;
        for (item_id, first, last) in rows.flatten() {
            if let Some(Value::Array(a)) = items.get_mut(&item_id).and_then(|m| m.get_mut("creators")) {
                a.push(json!(format!("{first} {last}").trim()));
            }
        }

        Ok(order
            .into_iter()
            .filter_map(|i| items.remove(&i))
            .map(|mut m| {
                let get = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let (date, doi, extra, url, archive) =
                    (get("date"), get("DOI"), get("extra"), get("url"), get("archiveID"));
                let venue = ["publicationTitle", "proceedingsTitle", "bookTitle", "conferenceName", "repository", "websiteTitle"]
                    .iter()
                    .map(|k| get(k))
                    .find(|v| !v.is_empty());
                if let Some(y) = year_of(&date) {
                    m.insert("year".into(), json!(y));
                }
                m.insert("venue".into(), json!(venue));
                m.insert("s2".into(), json!(s2_id_of(&extra)));
                m.insert("arxiv".into(), json!(arxiv_of(&doi, &extra, &archive, &url)));
                Value::Object(m)
            })
            .collect())
    }

    /// A folder id that survives renames: "L1" for a library root,
    /// "<libraryID>-<collection key>" for a collection.
    pub fn folder_id(&self, target: &str) -> Result<String> {
        let (kind, id) = target.split_at(1.min(target.len()));
        let id: i64 = id.parse().context("bad target id")?;
        match kind {
            "L" => Ok(format!("L{id}")),
            "C" => {
                let (lib, key): (i64, String) = self
                    .open_db()?
                    .query_row("SELECT libraryID, key FROM collections WHERE collectionID = ?1", [id], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .context("no such Zotero folder")?;
                Ok(format!("{lib}-{key}"))
            }
            _ => bail!("target must start with C or L"),
        }
    }

    /// The target ("C42" / "L1") of a folder id from `folder_id`, if the folder still exists.
    pub fn folder_target(&self, folder: &str) -> Option<String> {
        if folder.starts_with('L') {
            return Some(folder.to_string());
        }
        let (lib, key) = folder.split_once('-')?;
        let lib: i64 = lib.parse().ok()?;
        let id: i64 = self
            .open_db()
            .ok()?
            .query_row("SELECT collectionID FROM collections WHERE libraryID = ?1 AND key = ?2", rusqlite::params![lib, key], |r| r.get(0))
            .ok()?;
        Some(format!("C{id}"))
    }

    /// Switches to another Zotero data folder (or none).
    pub fn set_data_dir(&self, dir: Option<PathBuf>) {
        *self.db_path.write().unwrap() = dir.map(|d| d.join("zotero.sqlite"));
    }

    /// Checks that the database can be opened and read.
    pub fn probe(&self) -> Result<()> {
        self.open_db()?
            .query_row("SELECT count(*) FROM collections", [], |_| Ok(()))
            .context("couldn't read zotero.sqlite")?;
        Ok(())
    }

    fn db_path(&self) -> Result<PathBuf> {
        self.db_path
            .read()
            .unwrap()
            .clone()
            .context("Zotero isn't set up; choose its data folder in Settings (⚙)")
    }

    fn open_db(&self) -> Result<Connection> {
        let db_path = self.db_path()?;
        if !db_path.exists() {
            bail!("Zotero database not found at {}", db_path.display());
        }
        let path = db_path.to_string_lossy().replace(' ', "%20").replace('?', "%3F");
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
        // Zotero holds an exclusive lock while running; `immutable=1` reads the
        // main file without locking (it may miss the last few unsynced writes).
        if let Ok(c) = Connection::open_with_flags(format!("file:{path}?mode=ro"), flags) {
            c.busy_timeout(Duration::from_millis(100))?;
            if c.query_row("SELECT 1 FROM collections LIMIT 1", [], |_| Ok(())).is_ok()
                || c.query_row("SELECT count(*) FROM libraries", [], |_| Ok(())).is_ok()
            {
                return Ok(c);
            }
        }
        Ok(Connection::open_with_flags(format!("file:{path}?immutable=1"), flags)?)
    }

    fn collections_from_db(&self) -> Result<Vec<Value>> {
        let db = self.open_db()?;
        let mut libs: Vec<(i64, String)> = db
            .prepare(
                "SELECT l.libraryID, COALESCE(g.name, 'My Library')
                 FROM libraries l LEFT JOIN groups g ON g.libraryID = l.libraryID
                 WHERE l.type IN ('user', 'group') ORDER BY l.libraryID",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        if libs.is_empty() {
            libs.push((1, "My Library".into()));
        }
        let cols: Vec<(i64, String, Option<i64>, i64)> = db
            .prepare(
                "SELECT c.collectionID, c.collectionName, c.parentCollectionID, c.libraryID
                 FROM collections c
                 WHERE c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)
                 ORDER BY c.collectionName COLLATE NOCASE",
            )
            .or_else(|_| {
                db.prepare(
                    "SELECT collectionID, collectionName, parentCollectionID, libraryID
                     FROM collections ORDER BY collectionName COLLATE NOCASE",
                )
            })?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;

        fn walk(
            out: &mut Vec<Value>,
            cols: &[(i64, String, Option<i64>, i64)],
            lib: i64,
            parent: Option<i64>,
            level: u32,
        ) {
            for (id, name, p, l) in cols {
                if *l == lib && *p == parent {
                    out.push(json!({ "id": format!("C{id}"), "name": name, "level": level }));
                    walk(out, cols, lib, Some(*id), level + 1);
                }
            }
        }

        let mut out = Vec::new();
        for (lib, name) in libs {
            out.push(json!({ "id": format!("L{lib}"), "name": name, "level": 0 }));
            walk(&mut out, &cols, lib, None, 1);
        }
        Ok(out)
    }

    /// Opens zotero.sqlite for writing. Zotero must be closed: it holds an
    /// exclusive lock while running. The database is backed up to
    /// `zotero.sqlite.noctua-bak` first.
    async fn open_for_write(&self, what: &str) -> Result<Connection> {
        if self.http.get(format!("{CONNECTOR}/ping")).send().await.is_ok() {
            bail!("Close Zotero first — folders can only be {what} while Zotero is closed");
        }
        let db_path = self.db_path()?;
        let db = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .with_context(|| format!("could not open {}", db_path.display()))?;
        db.query_row("SELECT count(*) FROM collections", [], |_| Ok(()))
            .context("could not read the Zotero database (is Zotero still running?)")?;
        let backup = db_path.with_extension("sqlite.noctua-bak");
        let _ = std::fs::remove_file(&backup);
        db.execute("VACUUM INTO ?1", [backup.to_string_lossy()])
            .context("could not back up the Zotero database (is Zotero still running?)")?;
        Ok(db)
    }

    /// Renames a collection ("C42") by writing to zotero.sqlite (see `open_for_write`).
    pub async fn rename(&self, target: &str, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            bail!("folder name can't be empty");
        }
        let id: i64 = target
            .strip_prefix('C')
            .and_then(|s| s.parse().ok())
            .context("only folders can be renamed")?;
        let db = self.open_for_write("renamed").await?;
        let n = db.execute(
            "UPDATE collections
             SET collectionName = ?1, clientDateModified = CURRENT_TIMESTAMP, synced = 0
             WHERE collectionID = ?2",
            rusqlite::params![name, id],
        )?;
        if n == 0 {
            bail!("folder not found");
        }
        Ok(())
    }

    /// Creates a folder inside `parent` (a library "L1" or a folder "C42") by
    /// writing to zotero.sqlite (see `open_for_write`). Returns its target id.
    /// It's marked unsynced, so Zotero uploads it on its next sync.
    pub async fn create_collection(&self, parent: &str, name: &str) -> Result<String> {
        let name = name.trim();
        if name.is_empty() {
            bail!("folder name can't be empty");
        }
        let (kind, id) = parent.split_at(1.min(parent.len()));
        let id: i64 = id.parse().context("bad parent id")?;
        let db = self.open_for_write("created").await?;
        let (lib, parent_col): (i64, Option<i64>) = match kind {
            "L" => (id, None),
            "C" => (
                db.query_row("SELECT libraryID FROM collections WHERE collectionID = ?1", [id], |r| r.get(0))
                    .ok()
                    .context("parent folder not found")?,
                Some(id),
            ),
            _ => bail!("parent must start with C or L"),
        };
        let editable: bool = db
            .query_row("SELECT editable FROM libraries WHERE libraryID = ?1", [lib], |r| r.get(0))
            .ok()
            .context("library not found")?;
        if !editable {
            bail!("that library is read-only");
        }
        // Zotero's object keys: 8 characters from this alphabet, unique per library.
        const ALPHABET: &[u8] = b"23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
        let key = loop {
            let bytes: Vec<u8> = db.query_row("SELECT randomblob(8)", [], |r| r.get(0))?;
            let key: String = bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
            let taken: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE libraryID = ?1 AND key = ?2)",
                rusqlite::params![lib, key],
                |r| r.get(0),
            )?;
            if !taken {
                break key;
            }
        };
        db.execute(
            "INSERT INTO collections (collectionName, parentCollectionID, libraryID, key, synced)
             VALUES (?1, ?2, ?3, ?4, 0)",
            rusqlite::params![name, parent_col, lib, key],
        )?;
        Ok(format!("C{}", db.last_insert_rowid()))
    }

    /// Which of the given papers are already in the library, matched by DOI
    /// or normalized title. Input: `[{ id, doi, title }]`; output: ids.
    pub fn check(&self, papers: &[Value]) -> Result<Vec<String>> {
        let db = self.open_db()?;
        let mut dois = HashSet::new();
        let mut titles = HashSet::new();
        let mut stmt = db.prepare(
            "SELECT f.fieldName, v.value
             FROM itemData d
             JOIN itemDataValues v ON v.valueID = d.valueID
             JOIN fields f ON f.fieldID = d.fieldID
             WHERE f.fieldName IN ('DOI', 'title')
               AND d.itemID NOT IN (SELECT itemID FROM deletedItems)",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows.flatten() {
            match row.0.as_str() {
                "DOI" => dois.insert(row.1.trim().to_lowercase()),
                _ => titles.insert(norm_title(&row.1)),
            };
        }
        let added = self.added.lock().map(|a| a.clone()).unwrap_or_default();
        Ok(papers
            .iter()
            .filter_map(|p| {
                let id = p["id"].as_str()?;
                let doi_hit = p["doi"]
                    .as_str()
                    .is_some_and(|d| dois.contains(&d.trim().to_lowercase()));
                let title_hit = p["title"].as_str().is_some_and(|t| {
                    let n = norm_title(t);
                    n.len() > 12 && titles.contains(&n)
                });
                (doi_hit || title_hit || added.contains(id)).then(|| id.to_string())
            })
            .collect())
    }

    /// Saves a Semantic Scholar paper into Zotero, optionally into a target
    /// collection ("C<id>") or library ("L<id>").
    pub async fn add(&self, paper: &Value, target: Option<&str>, attach_pdf: bool) -> Result<()> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let session = format!("noctua-{nanos}");
        let item = to_zotero_item(paper, attach_pdf, &format!("noctua-item-{nanos}"));

        let resp = self
            .connector(
                "saveItems",
                &json!({
                    "sessionID": session,
                    "uri": item["url"],
                    "items": [item],
                }),
            )
            .await?;
        if !resp.status().is_success() {
            let s = resp.status();
            bail!("Zotero rejected the item ({s}): {}", resp.text().await.unwrap_or_default());
        }

        if let Some(target) = target.filter(|t| !t.is_empty()) {
            let resp = self
                .connector(
                    "updateSession",
                    &json!({ "sessionID": session, "target": target, "tags": "" }),
                )
                .await?;
            if !resp.status().is_success() {
                let s = resp.status();
                bail!(
                    "Saved, but Zotero could not move it into the folder ({s}): {}",
                    resp.text().await.unwrap_or_default()
                );
            }
        }

        if let (Some(id), Ok(mut added)) = (paper["paperId"].as_str(), self.added.lock()) {
            added.insert(id.to_string());
        }
        Ok(())
    }
}

/// Regular items plus standalone attachments: no notes, annotations,
/// child attachments or trashed items.
const TOP_LEVEL: &str = "SELECT i.itemID FROM items i
     JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
     WHERE t.typeName NOT IN ('note', 'annotation')
       AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
       AND i.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL)";

/// First four-digit run in a Zotero date ("2017-06-12 2017-06-12" → 2017).
fn year_of(date: &str) -> Option<u32> {
    let b = date.as_bytes();
    (0..b.len().saturating_sub(3))
        .find(|&i| b[i..i + 4].iter().all(u8::is_ascii_digit))
        .and_then(|i| date[i..i + 4].parse().ok())
}

/// The "Semantic Scholar: <id>" line Noctua writes into `extra`.
fn s2_id_of(extra: &str) -> Option<String> {
    extra.lines().find_map(|l| {
        let id = l.trim().strip_prefix("Semantic Scholar:")?.trim();
        (id.len() == 40 && id.bytes().all(|b| b.is_ascii_hexdigit())).then(|| id.to_string())
    })
}

/// arXiv id from an arXiv DOI, an `arXiv:` line in extra, archiveID or URL.
fn arxiv_of(doi: &str, extra: &str, archive: &str, url: &str) -> Option<String> {
    let clean = |s: &str| {
        let s = s.split_whitespace().next().unwrap_or("");
        let s = s.trim_end_matches(".pdf").trim_end_matches('/');
        let s = match s.rfind('v') {
            Some(i) if i > 0 && s[i + 1..].bytes().all(|b| b.is_ascii_digit()) && !s[i + 1..].is_empty() => &s[..i],
            _ => s,
        };
        (!s.is_empty()).then(|| s.to_string())
    };
    let lower = doi.to_lowercase();
    if let Some(rest) = lower.strip_prefix("10.48550/arxiv.") {
        return clean(rest);
    }
    for l in extra.lines().chain(std::iter::once(archive)) {
        let l = l.trim();
        if let Some(rest) = l.get(..6).filter(|p| p.eq_ignore_ascii_case("arxiv:")).map(|_| &l[6..]) {
            return clean(rest);
        }
    }
    for marker in ["arxiv.org/abs/", "arxiv.org/pdf/"] {
        if let Some(i) = url.find(marker) {
            return clean(url[i + marker.len()..].split(['?', '#']).next().unwrap_or(""));
        }
    }
    None
}

fn norm_title(t: &str) -> String {
    t.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Maps a Semantic Scholar paper object onto Zotero's connector item format.
fn to_zotero_item(p: &Value, attach_pdf: bool, item_id: &str) -> Value {
    let ext = &p["externalIds"];
    let doi = ext["DOI"].as_str();
    let arxiv = ext["ArXiv"].as_str();
    let types: Vec<&str> = p["publicationTypes"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let journal = p["journal"]["name"].as_str().filter(|s| !s.is_empty());
    let venue = p["venue"].as_str().filter(|s| !s.is_empty());
    let container = journal.or(venue);

    let item_type = if types.contains(&"Conference") {
        "conferencePaper"
    } else if types.contains(&"JournalArticle") || types.contains(&"Review") || journal.is_some() {
        "journalArticle"
    } else if arxiv.is_some() {
        "preprint"
    } else {
        "journalArticle"
    };

    let creators: Vec<Value> = p["authors"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|a| a["name"].as_str())
        .map(|name| match name.trim().rsplit_once(' ') {
            Some((first, last)) => {
                json!({ "creatorType": "author", "firstName": first, "lastName": last })
            }
            None => json!({ "creatorType": "author", "lastName": name, "firstName": "" }),
        })
        .collect();

    let mut extra = vec![format!("Semantic Scholar: {}", p["paperId"].as_str().unwrap_or(""))];
    if let Some(a) = arxiv {
        extra.push(format!("arXiv: {a}"));
    }

    let url = match (doi, arxiv) {
        (Some(d), _) => format!("https://doi.org/{d}"),
        (None, Some(a)) => format!("https://arxiv.org/abs/{a}"),
        _ => p["url"].as_str().unwrap_or("").to_string(),
    };

    let mut item = json!({
        "id": item_id,
        "itemType": item_type,
        "title": p["title"],
        "creators": creators,
        "date": p["publicationDate"].as_str().map(Value::from).unwrap_or_else(|| p["year"].clone()),
        "abstractNote": p["abstract"].as_str().unwrap_or(""),
        "url": url,
        "extra": extra.join("\n"),
        "tags": [],
        "attachments": [],
    });
    let obj = item.as_object_mut().expect("object");
    if let Some(d) = doi {
        obj.insert("DOI".into(), d.into());
    }
    match item_type {
        "conferencePaper" => {
            if let Some(c) = container {
                obj.insert("proceedingsTitle".into(), c.into());
            }
        }
        "preprint" => {
            obj.insert("repository".into(), "arXiv".into());
            if let Some(a) = arxiv {
                obj.insert("archiveID".into(), format!("arXiv:{a}").into());
            }
        }
        _ => {
            if let Some(c) = container {
                obj.insert("publicationTitle".into(), c.into());
            }
            for (src, dst) in [("volume", "volume"), ("pages", "pages")] {
                if let Some(v) = p["journal"][src].as_str() {
                    obj.insert(dst.into(), v.trim().into());
                }
            }
        }
    }

    if attach_pdf {
        let oa = p["openAccessPdf"]["url"].as_str().filter(|u| !u.is_empty());
        let pdf = oa
            .map(String::from)
            .or_else(|| arxiv.map(|a| format!("https://arxiv.org/pdf/{a}")));
        if let Some(pdf) = pdf {
            obj.insert(
                "attachments".into(),
                json!([{ "title": "Full Text PDF", "url": pdf, "mimeType": "application/pdf" }]),
            );
        }
    }
    item
}
