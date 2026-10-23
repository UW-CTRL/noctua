//! Optional read-only Zotero import source. No runtime connector dependency.

use std::{
    collections::HashMap,
    path::PathBuf,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

pub struct Zotero {
    /// `<Zotero data folder>/zotero.sqlite`; None when Zotero isn't set up.
    db_path: std::sync::RwLock<Option<PathBuf>>,
}

impl Zotero {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            db_path: std::sync::RwLock::new(data_dir.map(|d| d.join("zotero.sqlite"))),
        }
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

    pub fn import_collections(&self) -> Result<Vec<Value>> { self.collections_from_db() }

    pub fn local_pdf(&self, library: &str, item_key: &str) -> Result<Option<PathBuf>> {
        let library_id: i64 = library.strip_prefix('L').context("bad library id")?.parse()?;
        let db = self.open_db()?;
        let mut stmt = db.prepare("SELECT child.key,a.path FROM itemAttachments a
            JOIN items parent ON parent.itemID=COALESCE(a.parentItemID,a.itemID) JOIN items child ON child.itemID=a.itemID
            WHERE parent.key=?1 AND parent.libraryID=?2 AND a.contentType='application/pdf'
            AND child.itemID NOT IN (SELECT itemID FROM deletedItems) ORDER BY a.itemID")?;
        let rows = stmt.query_map(rusqlite::params![item_key,library_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?;
        for row in rows {
            let (key,Some(path)) = row? else {continue};
            let file = if let Some(name) = path.strip_prefix("storage:") {
                let rel = std::path::Path::new(name);
                if rel.components().any(|c| !matches!(c,std::path::Component::Normal(_))) {continue;}
                self.db_path()?.parent().unwrap().join("storage").join(key).join(rel)
            } else if std::path::Path::new(&path).is_absolute() { PathBuf::from(path) }
            else {continue};
            if file.is_file() {return Ok(Some(file));}
        }
        Ok(None)
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
