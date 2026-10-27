//! Optional read-only Zotero import source. No runtime connector dependency.

use std::{
    collections::HashMap,
    path::PathBuf,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all="snake_case")]
pub enum PdfMode { #[default] Link, Copy }

#[derive(serde::Deserialize)]
#[serde(default)]
pub struct ImportOptions {
    pub tags: bool,
    pub bibliography: bool,
    pub copy_pdfs: bool,
    pub copy_notes: bool,
    pub copy_annotations: bool,
    pub pdf_mode: Option<PdfMode>,
}
impl Default for ImportOptions {
    fn default() -> Self { Self { tags: true, bibliography: true, copy_pdfs: false, copy_notes: false, copy_annotations: false, pdf_mode: None } }
}

/// Bibliographic details retained alongside Noctua's common paper fields.
pub const BIBLIOGRAPHIC_FIELDS: &[&str] = &[
    "date", "publicationTitle", "proceedingsTitle", "bookTitle", "conferenceName",
    "repository", "websiteTitle", "volume", "issue", "pages", "publisher", "place",
    "edition", "series", "seriesTitle", "seriesText", "seriesNumber", "ISBN", "ISSN",
    "language", "shortTitle", "journalAbbreviation", "numPages", "numberOfVolumes",
];

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
            m.insert("tags".into(), json!([]));
            items.insert(item_id, m);
            order.push(item_id);
        }

        let mut stmt = db.prepare(&format!(
            "SELECT d.itemID, f.fieldName, v.value
             FROM itemData d
             JOIN fields f ON f.fieldID = d.fieldID
             JOIN itemDataValues v ON v.valueID = d.valueID
             WHERE d.itemID IN ({ids})"
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

        let mut stmt = db.prepare(&format!(
            "SELECT DISTINCT it.itemID, t.name
             FROM itemTags it JOIN tags t ON t.tagID = it.tagID
             WHERE it.itemID IN ({ids})
             ORDER BY it.itemID, t.name"
        ))?;
        let rows = stmt.query_map([id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            if let Some(Value::Array(tags)) = items.get_mut(&item_id).and_then(|m| m.get_mut("tags")) {
                tags.push(json!(tag));
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

    pub fn local_pdf_attachment(&self, library: &str, item_key: &str) -> Result<Option<(String,PathBuf)>> {
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
                self.db_path()?.parent().unwrap().join("storage").join(&key).join(rel)
            } else if std::path::Path::new(&path).is_absolute() { PathBuf::from(path) }
            else {continue};
            if file.is_file() {return Ok(Some((key,file)));}
        }
        Ok(None)
    }

    /// Child notes follow their paper's direct collections; standalone notes keep their own.
    pub fn notes(&self, library: &str) -> Result<Vec<Value>> {
        let library_id: i64 = library.strip_prefix('L').context("bad library id")?.parse()?;
        let db=self.open_db()?;
        let mut stmt=db.prepare("SELECT i.itemID,i.key,n.title,n.note,n.parentItemID
            FROM itemNotes n JOIN items i ON i.itemID=n.itemID JOIN itemTypes t ON t.itemTypeID=i.itemTypeID
            WHERE i.libraryID=?1 AND t.typeName='note'
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND (n.parentItemID IS NULL OR n.parentItemID NOT IN (SELECT itemID FROM deletedItems)) ORDER BY i.itemID")?;
        let rows=stmt.query_map([library_id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?.unwrap_or_default(),r.get::<_,Option<String>>(3)?.unwrap_or_default(),r.get::<_,Option<i64>>(4)?)))?;
        let mut out=Vec::new();
        for row in rows {
            let (id,key,title,html,parent)=row?;
            let mut collections=db.prepare("SELECT c.collectionID FROM collectionItems ci JOIN collections c ON c.collectionID=ci.collectionID WHERE ci.itemID=?1 AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections) ORDER BY c.collectionID")?;
            let mut targets=collections.query_map([parent.unwrap_or(id)],|r|Ok(format!("C{}",r.get::<_,i64>(0)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            if targets.is_empty(){targets.push(library.to_owned());}
            out.push(json!({"title":title,"html":html,"targets":targets,"source":format!("{library_id}:{key}")}));
        }
        Ok(out)
    }

    pub fn annotations(&self, library: &str, attachment: &str) -> Result<Vec<Value>> {
        let library_id: i64=library.strip_prefix('L').context("bad library id")?.parse()?;
        let db=self.open_db()?;
        let mut stmt=db.prepare("SELECT i.key,a.type,a.text,a.comment,a.color,a.pageLabel,a.position,a.authorName
            FROM itemAnnotations a JOIN items i ON i.itemID=a.itemID JOIN items p ON p.itemID=a.parentItemID
            WHERE p.libraryID=?1 AND p.key=?2 AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND p.itemID NOT IN (SELECT itemID FROM deletedItems) ORDER BY a.sortIndex,i.itemID")?;
        let rows=stmt.query_map(rusqlite::params![library_id,attachment],|r|Ok(json!({
            "source":format!("{library_id}:{}",r.get::<_,String>(0)?),"type":r.get::<_,i64>(1)?,
            "text":r.get::<_,Option<String>>(2)?.unwrap_or_default(),"comment":r.get::<_,Option<String>>(3)?.unwrap_or_default(),
            "color":r.get::<_,Option<String>>(4)?.unwrap_or_else(||"#ffd400".into()),"page_label":r.get::<_,Option<String>>(5)?,
            "position_json":r.get::<_,String>(6)?,"source_author":r.get::<_,Option<String>>(7)?
        })))?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn has_annotations(&self, library: &str, item_key: &str) -> Result<bool> {
        let library_id:i64=library.strip_prefix('L').context("bad library id")?.parse()?;
        Ok(self.open_db()?.query_row("SELECT EXISTS(SELECT 1 FROM itemAnnotations a
            JOIN itemAttachments att ON att.itemID=a.parentItemID
            JOIN items p ON p.itemID=COALESCE(att.parentItemID,att.itemID)
            WHERE p.libraryID=?1 AND p.key=?2 AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND att.itemID NOT IN (SELECT itemID FROM deletedItems))",
            rusqlite::params![library_id,item_key],|r|r.get(0))?)
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

/// Import HTML as inert text, decoding entities and retaining paragraph boundaries.
/// LaTeX metacharacters are escaped so a note cannot become executable note syntax.
pub fn note_text(html: &str) -> String {
    use std::cell::{Cell, RefCell};
    use html5ever::{tendril::StrTendril, tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer, TagKind}};
    struct Text { body:RefCell<String>, hidden:Cell<bool> }
    impl TokenSink for Text {
        type Handle=();
        fn process_token(&self, token:Token,_line:u64)->TokenSinkResult<()> {
            match token {
                Token::CharacterTokens(s) if !self.hidden.get()=>self.body.borrow_mut().push_str(&s),
                Token::TagToken(t)=>{
                    let tag=t.name.as_ref();
                    if ["script","style"].contains(&tag) { self.hidden.set(t.kind==TagKind::StartTag); }
                    if !self.hidden.get() && ["p","div","br","li","h1","h2","h3","blockquote","tr"].contains(&tag) {self.body.borrow_mut().push('\n');}
                    if tag=="img" {self.body.borrow_mut().push_str("[Image omitted]");}
                },
                _=>{},
            }
            TokenSinkResult::Continue
        }
    }
    let input=BufferQueue::default();input.push_back(StrTendril::from(html));
    let tokenizer=Tokenizer::new(Text{body:RefCell::new(String::new()),hidden:Cell::new(false)},Default::default());
    let _=tokenizer.feed(&input);tokenizer.end();
    let mut out=String::new();
    for c in tokenizer.sink.body.into_inner().trim().chars() {
        match c {
            '\\'=>out.push_str("\\textbackslash{}"),
            '$'|'%'|'&'|'#'|'_'|'{'|'}'|'^'|'~'=>{out.push('\\');out.push(c);},
            _=>out.push(c),
        }
    }
    out
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_notes_become_escaped_text_with_paragraphs() {
        let text=note_text("<div><p>한국어 &amp; &lt;text&gt;</p><p>$5 #1 50% a_b {x} ^ ~ \\cite{bad}</p><script>alert(1)</script><style>body{}</style><img src='x'></div>");
        assert!(text.contains("한국어 \\& <text>\n\n\\$5 \\#1 50\\% a\\_b \\{x\\} \\^ \\~ \\textbackslash{}cite\\{bad\\}"));
        assert!(!text.contains("alert")&&!text.contains("body"));
        assert!(text.contains("[Image omitted]"));
    }

    #[test]
    fn legacy_import_requests_keep_optional_content_off() -> Result<()> {
        let options:ImportOptions=serde_json::from_value(json!({"copy_pdfs":true}))?;
        assert!(options.copy_pdfs&&options.tags&&options.bibliography);
        assert!(!options.copy_notes&&!options.copy_annotations);
        Ok(())
    }
}
