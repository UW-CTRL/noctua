//! Noctua's own library. Zotero is only an optional, read-only import source.
//! Metadata/collections/annotations live in SQLite; PDFs are immutable files by SHA-256.
use std::{collections::HashSet, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const PDF_LIMIT: usize = 128 << 20;
pub const COLORS: [&str; 6] = ["#ffd400", "#5fb236", "#2ea8e5", "#e56eee", "#a28ae5", "#ff6666"];
pub const HIGHLIGHT_CATEGORIES:[&str;4]=["novelty","method","results","limitations"];
pub fn category_color(category:&str)->Option<&'static str> {
    match category {"novelty"=>Some("#ff6666"),"method"=>Some("#5fb236"),"results"=>Some("#a28ae5"),"limitations"=>Some("#ffd400"),_=>None}
}
pub fn valid_color(color:&str)->bool {color.len()==7&&color.starts_with('#')&&color[1..].bytes().all(|c|c.is_ascii_hexdigit())}
pub fn id(prefix: &str) -> String { format!("{prefix}{}", uuid::Uuid::new_v4().simple()) }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn bad(message: &str) -> anyhow::Error { crate::Status(axum::http::StatusCode::BAD_REQUEST, message.into()).into() }
fn conflict(message: &str) -> anyhow::Error { crate::Status(axum::http::StatusCode::CONFLICT, message.into()).into() }
fn missing() -> anyhow::Error { crate::Status(axum::http::StatusCode::NOT_FOUND, "Paper or collection not found".into()).into() }
fn norm(s: &str) -> String { s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect() }
fn text<'a>(v: &'a Value, key: &str) -> &'a str { v[key].as_str().unwrap_or("") }

pub struct Library { edit_gate: Mutex<()>, conn: Mutex<Connection>, root: PathBuf }
impl Library {
    pub fn open(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(root.join("pdfs"))?;
        let conn = Connection::open(root.join("library.sqlite"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT REFERENCES collections(id), notes_folder TEXT NOT NULL UNIQUE);
            INSERT OR IGNORE INTO collections VALUES ('L1','Noctua Library',NULL,'L1');
            CREATE TABLE IF NOT EXISTS papers (key TEXT PRIMARY KEY, s2 TEXT NOT NULL DEFAULT '', doi TEXT NOT NULL DEFAULT '', arxiv TEXT NOT NULL DEFAULT '', title_norm TEXT NOT NULL, data TEXT NOT NULL, pdf_hash TEXT, revision INTEGER NOT NULL DEFAULT 1);
            CREATE INDEX IF NOT EXISTS papers_s2 ON papers(s2); CREATE INDEX IF NOT EXISTS papers_doi ON papers(doi);
            CREATE INDEX IF NOT EXISTS papers_hash ON papers(pdf_hash);
            CREATE TABLE IF NOT EXISTS memberships (collection TEXT REFERENCES collections(id), paper TEXT REFERENCES papers(key), PRIMARY KEY(collection,paper));
            CREATE TABLE IF NOT EXISTS pdf_index (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pdf_outlines (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pdf_auto_highlights (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS page_images (hash TEXT NOT NULL, page INTEGER NOT NULL, png BLOB NOT NULL, PRIMARY KEY(hash,page));
            CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY, paper TEXT NOT NULL REFERENCES papers(key), data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self { edit_gate:Mutex::new(()), conn: Mutex::new(conn), root })
    }
    pub fn collections(&self) -> Result<Value> { self.collections_scoped(false) }
    /// Folder counts deduplicate papers across descendants when enabled.
    pub fn collections_scoped(&self, include_subfolders: bool) -> Result<Value> {
        let c = self.conn.lock().unwrap();
        let sql = if include_subfolders {
            "WITH RECURSIVE descendants(root,id) AS (SELECT id,id FROM collections UNION SELECT d.root,c.id FROM descendants d JOIN collections c ON c.parent=d.id) SELECT id,name,parent,(SELECT count(DISTINCT m.paper) FROM memberships m JOIN descendants d ON m.collection=d.id WHERE d.root=collections.id) FROM collections ORDER BY name COLLATE NOCASE"
        } else {
            "SELECT id,name,parent,(SELECT count(*) FROM memberships WHERE collection=collections.id) FROM collections ORDER BY name COLLATE NOCASE"
        };
        let mut stmt = c.prepare(sql)?;
        let rows: Vec<(String,String,Option<String>,i64)> = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect::<rusqlite::Result<_>>()?;
        let total: i64 = c.query_row("SELECT count(*) FROM papers", [], |r| r.get(0))?;
        fn walk(rows: &[(String,String,Option<String>,i64)], parent: Option<&str>, depth: usize, out: &mut Vec<Value>) {
            for (id,name,p,count) in rows.iter().filter(|r| r.2.as_deref()==parent) {
                out.push(json!({"id":id,"name":name,"parent":p,"level":depth,"count":count}));
                walk(rows,Some(id),depth+1,out);
            }
        }
        let mut targets=Vec::new(); walk(&rows,None,0,&mut targets);
        if let Some(root)=targets.iter_mut().find(|t|t["id"]=="L1") { root["count"]=json!(total); }
        Ok(json!({"live":true,"native":true,"selected":"L1","targets":targets}))
    }
    pub fn folder_id(&self, target: &str) -> Result<String> {
        self.conn.lock().unwrap().query_row("SELECT notes_folder FROM collections WHERE id=?1", [target], |r|r.get(0)).optional()?.ok_or_else(missing)
    }
    pub fn folder_target(&self, folder: &str) -> Option<String> {
        self.conn.lock().unwrap().query_row("SELECT id FROM collections WHERE notes_folder=?1", [folder], |r|r.get(0)).optional().ok().flatten()
    }
    pub fn create_collection(&self, parent: &str, name: &str) -> Result<String> {
        self.folder_id(parent)?;
        let name=name.trim(); if name.is_empty() || name.len()>200 { return Err(bad("Choose a collection name (1–200 characters)")); }
        let key=id("C");
        self.conn.lock().unwrap().execute("INSERT INTO collections VALUES (?1,?2,?3,?1)",params![key,name,parent])?;
        Ok(key)
    }
    pub fn rename(&self, target: &str, name: &str) -> Result<()> {
        let name=name.trim(); if name.is_empty() || name.len()>200 { return Err(bad("Choose a collection name (1–200 characters)")); }
        if self.conn.lock().unwrap().execute("UPDATE collections SET name=?1 WHERE id=?2",params![name,target])?==0 { return Err(missing()); }
        Ok(())
    }
    pub fn items(&self, target: &str) -> Result<Vec<Value>> { self.items_scoped(target, false) }
    /// The library root always contains all papers; collections optionally include descendants.
    pub fn items_scoped(&self, target: &str, include_subfolders: bool) -> Result<Vec<Value>> {
        self.folder_id(target)?;
        let c=self.conn.lock().unwrap();
        let mut stmt=c.prepare("WITH RECURSIVE scope(id) AS (SELECT ?1 UNION SELECT c.id FROM collections c JOIN scope s ON c.parent=s.id WHERE ?2) SELECT data,pdf_hash,revision FROM papers WHERE ?1='L1' OR key IN (SELECT paper FROM memberships WHERE collection IN (SELECT id FROM scope)) ORDER BY key")?;
        let rows=stmt.query_map(params![target,include_subfolders], |r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?)))?;
        rows.map(|r| { let (s,h,revision)=r?; let mut v:Value=serde_json::from_str(&s)?;v["has_pdf"]=json!(h.is_some());v["pdf_hash"]=json!(h);v["revision"]=json!(revision);Ok(v) }).collect()
    }
    pub fn paper(&self, key: &str) -> Result<Value> {
        let c=self.conn.lock().unwrap();
        let row:Option<(String,Option<String>,i64)>=c.query_row("SELECT data,pdf_hash,revision FROM papers WHERE key=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (s,h,r)=row.ok_or_else(missing)?;let mut p:Value=serde_json::from_str(&s)?;
        p["has_pdf"]=json!(h.is_some());p["pdf_hash"]=json!(h);p["revision"]=json!(r);
        Ok(p)
    }
    /// Direct memberships, independent of the UI's descendant setting.
    pub fn memberships(&self, key: &str) -> Result<Vec<String>> {
        self.paper(key)?;
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare("SELECT collection FROM memberships WHERE paper=?1 ORDER BY collection")?;
        let rows = stmt.query_map([key], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
    /// One paper's membership changes are atomic; a batch can report per-paper failures.
    pub fn update_memberships(&self, key: &str, add: &[String], remove: &[String]) -> Result<Value> {
        self.paper(key)?;
        for target in add.iter().chain(remove) { self.folder_id(target)?; }
        if remove.iter().any(|t| t == "L1") { return Err(bad("The Library always contains every paper")); }
        if add.iter().any(|t| remove.contains(t)) { return Err(bad("Cannot add and remove the same collection")); }
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        let mut added = Vec::new(); let mut removed = Vec::new();
        for target in add { if tx.execute("INSERT OR IGNORE INTO memberships VALUES(?1,?2)", params![target,key])? > 0 { added.push(target); } }
        for target in remove { if tx.execute("DELETE FROM memberships WHERE collection=?1 AND paper=?2", params![target,key])? > 0 { removed.push(target); } }
        let direct:Vec<String>={let mut stmt=tx.prepare("SELECT collection FROM memberships WHERE paper=?1 ORDER BY collection")?;let rows=stmt.query_map([key],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;rows};
        tx.commit()?;
        Ok(json!({"paper_key":key,"status":"applied","added":added,"removed":removed,"direct_collections":direct}))
    }
    pub fn save(&self, source: &Value, target: &str) -> Result<String> { Ok(self.save_report(source,target)?.0) }
    pub fn save_report(&self, source: &Value, target: &str) -> Result<(String,bool,bool)> {
        self.folder_id(target)?;
        let mut p=normalize_paper(source);
        if text(&p,"title").trim().is_empty() { return Err(bad("A paper needs a title")); }
        let (s2,doi,arxiv,title)=(text(&p,"s2").to_string(),text(&p,"DOI").trim().to_lowercase(),text(&p,"arxiv").to_lowercase(),norm(text(&p,"title")));
        let mut c=self.conn.lock().unwrap();let tx=c.transaction()?;
        let existing:Option<(String,String)>=tx.query_row("SELECT key,data FROM papers WHERE (?1<>'' AND s2=?1) OR (?2<>'' AND doi=?2) OR (?3<>'' AND arxiv=?3) OR (?4<>'' AND length(?4)>12 AND title_norm=?4) OR (key=?5 AND title_norm=?6) LIMIT 1",params![s2,doi,arxiv,if source["_new_pdf"]==true{""}else{&title},text(source,"key"),title],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let created=existing.is_none();
        let key=if let Some((key,body))=existing {
            let mut old:Value=serde_json::from_str(&body)?;
            let incoming=p.as_object().unwrap();
            for (k,v) in incoming { if old[k].is_null() || old[k]=="" { old[k]=v.clone(); } }
            let mut aliases:HashSet<String>=old["cite_keys"].as_array().into_iter().flatten().filter_map(|v|v.as_str().map(String::from)).collect();
            aliases.extend(p["cite_keys"].as_array().into_iter().flatten().filter_map(|v|v.as_str().map(String::from)));
            old["cite_keys"]=json!(aliases);old["key"]=json!(key);
            tx.execute("UPDATE papers SET data=?1,s2=?2,doi=?3,arxiv=?4,revision=revision+1 WHERE key=?5",params![old.to_string(),text(&old,"s2"),text(&old,"DOI").to_lowercase(),text(&old,"arxiv").to_lowercase(),key])?;
            key
        } else {
            let preferred=text(source,"key");
            let available=!preferred.is_empty() && preferred.len()<60 && preferred.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_') && !tx.query_row("SELECT EXISTS(SELECT 1 FROM papers WHERE key=?1)",[preferred],|r|r.get::<_,bool>(0))?;
            let key=if available {preferred.to_string()} else {id("p")};
            p["key"]=json!(key);
            if p["dateAdded"].as_str().is_none_or(str::is_empty) { p["dateAdded"]=json!(tx.query_row("SELECT datetime('now')",[],|r|r.get::<_,String>(0))?); }
            tx.execute("INSERT INTO papers(key,s2,doi,arxiv,title_norm,data) VALUES(?1,?2,?3,?4,?5,?6)",params![key,s2,doi,arxiv,title,p.to_string()])?;
            key
        };
        let linked=tx.execute("INSERT OR IGNORE INTO memberships VALUES(?1,?2)",params![target,key])?>0;tx.commit()?;Ok((key,created,linked))
    }
    pub fn edit(&self, key: &str, data: &Value) -> Result<Value> {
        let mut p=self.paper(key)?;
        let revision=data["revision"].as_i64().context("Missing paper revision")?;
        for k in ["title","creators","year","DOI","arxiv","s2","venue","abstractNote","pdf_url"] { if let Some(v)=data.get(k) {
            let valid=match k { "creators"=>v.as_array().is_some_and(|a|a.iter().all(Value::is_string)),"year"=>v.is_null()||v.as_u64().is_some_and(|y|y<=9999),_=>v.is_string() };
            if !valid{return Err(bad(&format!("Invalid {k}")));} p[k]=v.clone();
        } }
        if text(&p,"title").trim().is_empty() { return Err(bad("A paper needs a title")); }
        let n=self.conn.lock().unwrap().execute("UPDATE papers SET data=?1,s2=?2,doi=?3,arxiv=?4,title_norm=?5,revision=revision+1 WHERE key=?6 AND revision=?7",params![p.to_string(),text(&p,"s2"),text(&p,"DOI").to_lowercase(),text(&p,"arxiv").to_lowercase(),norm(text(&p,"title")),key,revision])?;
        if n==0 {return Err(conflict("This paper was edited in another tab. Reload its details and try again."));}self.paper(key)
    }
    pub fn add_membership(&self,key:&str,target:&str)->Result<()> {
        self.paper(key)?;self.folder_id(target)?;
        self.conn.lock().unwrap().execute("INSERT OR IGNORE INTO memberships VALUES(?1,?2)",params![target,key])?;Ok(())
    }
    pub fn remove_membership(&self,key:&str,target:&str)->Result<()> {
        if target=="L1" {return Err(bad("Choose a collection to remove this paper from"));}
        self.conn.lock().unwrap().execute("DELETE FROM memberships WHERE paper=?1 AND collection=?2",params![key,target])?;Ok(())
    }
    pub fn check(&self,papers:&[Value])->Result<Vec<String>> {
        let all=self.items("L1")?;let mut out=Vec::new();
        for p in papers { if all.iter().any(|a| (!text(p,"id").is_empty()&&a["s2"]==p["id"]) || (!text(p,"doi").is_empty()&&text(a,"DOI").eq_ignore_ascii_case(text(p,"doi"))) || (norm(text(p,"title")).len()>12&&norm(text(a,"title"))==norm(text(p,"title")))) { if let Some(id)=p["id"].as_str(){out.push(id.into());} } }
        Ok(out)
    }
    pub fn attach_pdf(&self,key:&str,bytes:&[u8])->Result<()> {
        if bytes.len()>PDF_LIMIT {return Err(bad("PDFs must be smaller than 128 MB"));}
        if !bytes.iter().take(1024).copied().collect::<Vec<_>>().windows(5).any(|w|w==b"%PDF-") {return Err(bad("The downloaded file is not a PDF. Attach a PDF file instead."));}
        let hash=format!("{:x}",Sha256::digest(bytes));let current=self.paper(key)?;
        if current["pdf_hash"].as_str().is_some_and(|h|h!=hash) {return Err(conflict("This paper already has a different PDF. Import the new version as a separate paper to preserve annotations."));}
        let path=self.root.join("pdfs").join(format!("{hash}.pdf"));
        if !path.exists() {let tmp=self.root.join("pdfs").join(id("upload-"));std::fs::write(&tmp,bytes)?;std::fs::rename(tmp,path)?;}
        let changed=self.conn.lock().unwrap().execute("UPDATE papers SET pdf_hash=?1,revision=revision+1 WHERE key=?2 AND (pdf_hash IS NULL OR pdf_hash=?1)",params![hash,key])?;if changed==0{return Err(conflict("A different PDF was attached in another tab"));}Ok(())
    }
    pub fn upload(&self,target:&str,name:&str,bytes:&[u8])->Result<String> {
        self.folder_id(target)?;
        let hash=format!("{:x}",Sha256::digest(bytes));
        let known:Option<String>=self.conn.lock().unwrap().query_row("SELECT key FROM papers WHERE pdf_hash=?1",[hash],|r|r.get(0)).optional()?;
        if let Some(key)=known { self.conn.lock().unwrap().execute("INSERT OR IGNORE INTO memberships VALUES(?1,?2)",params![target,key])?;return Ok(key); }
        // Validate before saving metadata so a rejected upload leaves no empty paper.
        if bytes.len()>PDF_LIMIT || !bytes.iter().take(1024).copied().collect::<Vec<_>>().windows(5).any(|w|w==b"%PDF-") {return Err(bad("Choose a PDF smaller than 128 MB"));}
        let title=Path::new(name).file_stem().and_then(|s|s.to_str()).filter(|s|!s.is_empty()).unwrap_or("Untitled paper");
        let key=self.save(&json!({"title":title,"_new_pdf":true}),target)?;self.attach_pdf(&key,bytes)?;Ok(key)
    }
    fn hash(&self,key:&str)->Result<String> {self.paper(key)?["pdf_hash"].as_str().map(String::from).context("No PDF attached to this paper")}
    pub fn pdf_path(&self,key:&str)->Result<PathBuf> {Ok(self.root.join("pdfs").join(format!("{}.pdf",self.hash(key)?)))}
    pub async fn download(&self,key:&str)->Result<()> {self.download_from(key,None).await}
    pub async fn download_from(&self,key:&str,source:Option<&str>)->Result<()> {
        let p=self.paper(key)?;if p["has_pdf"]==true {return Ok(());}
        let url=source.unwrap_or_else(||text(&p,"pdf_url"));if url.is_empty(){bail!("No open-access PDF URL is available. Attach a PDF from your computer.");}
        let parsed=reqwest::Url::parse(url)?;if !["http","https"].contains(&parsed.scheme()){return Err(bad("PDF URL must use HTTP or HTTPS"));}
        let mut response=reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).user_agent(concat!("Noctua/", env!("CARGO_PKG_VERSION"))).build()?.get(parsed).send().await?.error_for_status()?;
        if response.content_length().is_some_and(|s|s>PDF_LIMIT as u64){return Err(bad("PDF exceeds 128 MB"));}
        let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await?{if bytes.len()+chunk.len()>PDF_LIMIT{return Err(bad("PDF exceeds 128 MB"));}bytes.extend_from_slice(&chunk);}
        self.attach_pdf(key,&bytes)
    }
    pub fn index(&self,key:&str)->Result<Option<Value>> {
        let hash=self.hash(key)?;
        let body:Option<String>=self.conn.lock().unwrap().query_row("SELECT data FROM pdf_index WHERE hash=?1",[hash],|r|r.get(0)).optional()?;
        let index:Option<Value>=body.map(|s|serde_json::from_str(&s)).transpose()?;
        Ok(index.filter(|v|v["version"]==2))
    }
    pub fn outline(&self,key:&str)->Result<Option<Value>> {
        let hash=self.hash(key)?;
        let body:Option<String>=self.conn.lock().unwrap().query_row("SELECT data FROM pdf_outlines WHERE hash=?1",[hash],|r|r.get(0)).optional()?;
        body.map(|s|serde_json::from_str(&s).map_err(Into::into)).transpose()
    }
    pub fn delete_outline(&self,key:&str)->Result<()> {
        let hash=self.hash(key)?;
        self.conn.lock().unwrap().execute("DELETE FROM pdf_outlines WHERE hash=?1",[hash])?;
        Ok(())
    }
    pub fn save_outline(&self,key:&str,outline:&Value)->Result<()> {
        let hash=self.hash(key)?;
        if outline["hash"]!=hash {return Err(conflict("PDF changed while generating its outline"));}
        self.conn.lock().unwrap().execute("INSERT OR REPLACE INTO pdf_outlines VALUES(?1,?2)",params![hash,outline.to_string()])?;
        Ok(())
    }
    pub fn auto_highlights(&self,key:&str)->Result<Option<Value>> {
        let hash=self.hash(key)?;
        let body:Option<String>=self.conn.lock().unwrap().query_row("SELECT data FROM pdf_auto_highlights WHERE hash=?1",[hash],|r|r.get(0)).optional()?;
        body.map(|s|serde_json::from_str(&s).map_err(Into::into)).transpose()
    }
    fn save_auto_highlights_inner(&self,key:&str,analysis:&Value,colors:&crate::settings::HighlightColors)->Result<Value> {
        let hash=self.hash(key)?;if analysis["hash"]!=hash {return Err(conflict("PDF changed during auto-highlight analysis"));}
        let bodies=analysis["highlights"].as_array().filter(|a|a.len()<=48).context("Invalid auto-highlight analysis")?;
        // Validate the whole result before opening a transaction or writing any annotations.
        let mut prepared=Vec::new();
        for body in bodies {
            if body["source"]!="auto-highlight"||body["kind"]!="highlight"||category_color(text(body,"category")).is_none() {return Err(bad("Invalid auto-highlight category"));}
            let mut body=body.clone();body["color"]=json!(colors.color(text(&body,"category")).unwrap());
            let mut a=self.prepare_annotation(key,&body,"assistant",false)?;
            let quote=text(&a,"quote").split_whitespace().collect::<Vec<_>>().join(" ");
            a["auto_key"]=json!(format!("{:x}",Sha256::digest(format!("{}|{}|{}",a["page"],a["occurrence"],quote))));
            prepared.push(a);
        }
        let mut conn=self.conn.lock().unwrap();let tx=conn.transaction()?;
        let (mut created,mut existing)=(0,0);
        for a in prepared {
            let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM annotations WHERE paper=?1 AND json_extract(data,'$.auto_key')=?2)",params![key,text(&a,"auto_key")],|r|r.get(0))?;
            if duplicate {existing+=1;continue;}
            tx.execute("INSERT INTO annotations(id,paper,data) VALUES(?1,?2,?3)",params![text(&a,"id"),key,a.to_string()])?;created+=1;
        }
        tx.execute("INSERT OR REPLACE INTO pdf_auto_highlights VALUES(?1,?2)",params![hash,analysis.to_string()])?;tx.commit()?;
        Ok(json!({"created":created,"existing":existing,"total":created+existing}))
    }
    pub fn save_index(&self,key:&str,index:&Value)->Result<()> {
        if index["version"]!=2{return Err(bad("PDF text index is outdated. Reload Noctua to rebuild it."));}
        let hash=self.hash(key)?;if index["hash"]!=hash{return Err(conflict("PDF changed while indexing"));}
        let pages=index["pages"].as_array().context("Missing PDF pages")?;
        if pages.is_empty() || pages.len()>10000 {return Err(bad("Invalid PDF page count"));}
        for (i,page) in pages.iter().enumerate(){
            if page["page"].as_u64()!=Some(i as u64+1)||!page["text"].is_string(){return Err(bad("Invalid PDF text index"));}
            for word in page["words"].as_array().into_iter().flatten(){validate_rect(&word["rect"])?;}
        }
        // Repair quote-anchored assistant highlights made by the old offscreen layout.
        // Keep comments, replies, acceptance state and user-drawn/selected geometry intact.
        let mut conn=self.conn.lock().unwrap();let tx=conn.transaction()?;
        let rows:Vec<(String,String,i64)>={let mut stmt=tx.prepare("SELECT id,data,revision FROM annotations WHERE paper IN (SELECT key FROM papers WHERE pdf_hash=?1)")?;
            let rows=stmt.query_map([&hash],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;rows.collect::<rusqlite::Result<_>>()?};
        for (aid,data,revision) in rows {
            let mut a:Value=serde_json::from_str(&data)?;
            if a["author"]!="assistant" || a["kind"]!="highlight" || a["anchor_version"].as_u64().unwrap_or(0)>=2 {continue;}
            let Some(page)=a["page"].as_u64().and_then(|p|p.checked_sub(1)).and_then(|p|pages.get(p as usize)) else {continue};
            if let Ok(rects)=quote_rects(page,text(&a,"quote"),a["occurrence"].as_u64().unwrap_or(0) as usize) {
                a["rects"]=rects;a["anchor_version"]=json!(2);a["revision"]=json!(revision+1);
                tx.execute("UPDATE annotations SET data=?1,revision=revision+1 WHERE id=?2",params![a.to_string(),aid])?;
            }
        }
        tx.execute("INSERT OR REPLACE INTO pdf_index VALUES(?1,?2)",params![hash,index.to_string()])?;tx.commit()?;Ok(())
    }
    pub fn page_image(&self,key:&str,page:u32)->Result<Option<Vec<u8>>> {
        let hash=self.hash(key)?;
        Ok(self.conn.lock().unwrap().query_row("SELECT png FROM page_images WHERE hash=?1 AND page=?2",params![hash,page],|r|r.get(0)).optional()?)
    }
    pub fn save_page_image(&self,key:&str,page:u32,bytes:&[u8])->Result<()> {
        if page==0||page>10000||bytes.len()>5<<20||!bytes.starts_with(b"\x89PNG\r\n\x1a\n"){return Err(bad("Invalid page preview (PNG, up to 5 MB)"));}
        let hash=self.hash(key)?;self.conn.lock().unwrap().execute("INSERT OR REPLACE INTO page_images VALUES(?1,?2,?3)",params![hash,page,bytes])?;Ok(())
    }
    pub fn annotations(&self,key:&str)->Result<Vec<Value>> {
        self.paper(key)?;let c=self.conn.lock().unwrap();let mut stmt=c.prepare("SELECT data,revision FROM annotations WHERE paper=?1 ORDER BY json_extract(data,'$.created'),id")?;
        let rows=stmt.query_map([key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?;
        rows.map(|r|{let (s,rev)=r?;let mut v:Value=serde_json::from_str(&s)?;v["revision"]=json!(rev);Ok(v)}).collect()
    }
    fn annotate_inner(&self,key:&str,body:&Value,author:&str,pending:bool)->Result<Value> {
        let a=self.prepare_annotation(key,body,author,pending)?;
        self.conn.lock().unwrap().execute("INSERT INTO annotations(id,paper,data) VALUES(?1,?2,?3)",params![text(&a,"id"),key,a.to_string()])?;Ok(a)
    }
    fn prepare_annotation(&self,key:&str,body:&Value,author:&str,pending:bool)->Result<Value> {
        self.hash(key)?;let mut a=body.clone();if !a.is_object(){return Err(bad("Invalid annotation"));}
        let kind=text(&a,"kind");if !["highlight","ink","comment"].contains(&kind){return Err(bad("Choose highlight, ink, or comment"));}
        let page=a["page"].as_u64().filter(|p|*p>0&&*p<=10000).context("Choose a PDF page")?;
        if let Some(index)=self.index(key)? {if page as usize>index["pages"].as_array().map_or(0,Vec::len){return Err(bad("Page is outside the PDF"));}}
        let default_color=if a["category"].is_null(){COLORS[0]}else{
            if kind!="highlight" {return Err(bad("Only highlights can have a category"));}
            category_color(text(&a,"category")).ok_or_else(||bad("Unknown highlight category"))?
        };
        if a["color"].is_null(){a["color"]=json!(default_color);}if !valid_color(text(&a,"color")){return Err(bad("Use a six-digit hex annotation color"));}
        if a["kind"]=="highlight" && a["rects"].as_array().is_none_or(Vec::is_empty) {
            let quote=text(&a,"quote");if quote.trim().is_empty(){return Err(bad("A highlight needs selected text or rectangles"));}
            let index=self.index(key)?.context("Open the PDF first so its text can be indexed")?;
            a["rects"]=quote_rects(&index["pages"][page as usize-1],quote,a["occurrence"].as_u64().unwrap_or(0) as usize)?;
        }
        if let Some(rects)=a["rects"].as_array(){if rects.len()>2000{return Err(bad("Too many highlight rectangles"));}for r in rects{validate_rect(r)?;}}
        if a["kind"]=="ink" {
            let points=a["points"].as_array().filter(|p|p.len()>=2&&p.len()<=20000).context("A drawing needs 2–20000 points")?;
            for p in points {let xy=p.as_array().filter(|p|p.len()==2||p.len()==3).context("Invalid drawing point")?;for v in xy {unit(v)?;}}
            let width=a["width"].as_f64().unwrap_or(0.003);if !(0.0002..=0.03).contains(&width){return Err(bad("Invalid pen width"));}a["width"]=json!(width);
        }
        if text(&a,"comment").len()>100000{return Err(bad("Comment is too long"));}
        if author=="assistant" && a["kind"]=="highlight" {a["anchor_version"]=json!(2);}
        a["id"]=json!(id("a"));a["paper"]=json!(key);a["author"]=json!(author);a["created"]=json!(now());a["status"]=json!(if pending{"pending"}else{"accepted"});a["replies"]=json!([]);a["revision"]=json!(1);
        Ok(a)
    }
    pub fn recolor_ai_highlights(&self,colors:&std::collections::BTreeMap<String,String>)->Result<usize> {
        let _gate=self.edit_gate.lock().unwrap();
        let mut connection=self.conn.lock().unwrap();let tx=connection.transaction()?;let mut count=0;
        for (category,color) in colors {
            if category_color(category).is_none()||!valid_color(color){return Err(bad("Invalid AI highlight color"));}
            count+=tx.execute("UPDATE annotations SET data=json_set(data,'$.color',?1,'$.revision',revision+1),revision=revision+1 WHERE json_extract(data,'$.author')='assistant' AND json_extract(data,'$.kind')='highlight' AND json_extract(data,'$.category')=?2 AND json_extract(data,'$.color')<>?1",params![color,category])?;
        }
        tx.commit()?;Ok(count)
    }
    fn update_annotation_inner(&self,key:&str,aid:&str,body:&Value)->Result<Value> {
        let mut c=self.conn.lock().unwrap();let tx=c.transaction()?;
        let (s,rev):(String,i64)=tx.query_row("SELECT data,revision FROM annotations WHERE id=?1 AND paper=?2",params![aid,key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(missing)?;
        if body["revision"].as_i64()!=Some(rev){return Err(conflict("This annotation changed in another tab. Reload it before saving."));}
        let mut a:Value=serde_json::from_str(&s)?;
        if let Some(v)=body.get("comment"){if !v.is_string()||v.as_str().unwrap().len()>100000{return Err(bad("Invalid comment"));}a["comment"]=v.clone();a["comment_author"]=json!("user");}
        if let Some(v)=body.get("color"){if !valid_color(v.as_str().unwrap_or("")){return Err(bad("Use a six-digit hex annotation color"));}a["color"]=v.clone();}
        if let Some(v)=body.get("status"){if v!="accepted"{return Err(bad("Only pending suggestions can be accepted"));}a["status"]=v.clone();}
        a["revision"]=json!(rev+1);tx.execute("UPDATE annotations SET data=?1,revision=revision+1 WHERE id=?2",params![a.to_string(),aid])?;tx.commit()?;Ok(a)
    }
    fn reply_inner(&self,key:&str,aid:&str,comment:&str,author:&str,pending:bool)->Result<Value> {
        if comment.trim().is_empty()||comment.len()>100000{return Err(bad("Write a comment (up to 100000 characters)"));}
        let mut c=self.conn.lock().unwrap();let tx=c.transaction()?;
        let (s,rev):(String,i64)=tx.query_row("SELECT data,revision FROM annotations WHERE id=?1 AND paper=?2",params![aid,key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(missing)?;
        let mut a:Value=serde_json::from_str(&s)?;
        a["replies"].as_array_mut().context("Invalid comment thread")?.push(json!({"id":id("r"),"comment":comment,"author":author,"created":now(),"status":if pending{"pending"}else{"accepted"}}));
        a["revision"]=json!(rev+1);tx.execute("UPDATE annotations SET data=?1,revision=revision+1 WHERE id=?2",params![a.to_string(),aid])?;tx.commit()?;Ok(a)
    }
    fn resolve_reply_inner(&self,key:&str,aid:&str,rid:&str,accept:bool)->Result<Value> {
        let mut c=self.conn.lock().unwrap();let tx=c.transaction()?;
        let (s,rev):(String,i64)=tx.query_row("SELECT data,revision FROM annotations WHERE id=?1 AND paper=?2",params![aid,key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(missing)?;
        let mut a:Value=serde_json::from_str(&s)?;let replies=a["replies"].as_array_mut().context("Invalid thread")?;
        let i=replies.iter().position(|r|r["id"]==rid&&r["status"]=="pending").context("No pending reply with this ID")?;
        if accept{replies[i]["status"]=json!("accepted");}else{replies.remove(i);}
        a["revision"]=json!(rev+1);tx.execute("UPDATE annotations SET data=?1,revision=revision+1 WHERE id=?2",params![a.to_string(),aid])?;tx.commit()?;Ok(a)
    }
    fn delete_annotation_inner(&self,key:&str,aid:&str,revision:i64)->Result<()> {
        let n=self.conn.lock().unwrap().execute("DELETE FROM annotations WHERE id=?1 AND paper=?2 AND revision=?3",params![aid,key,revision])?;
        if n==0{return Err(conflict("Annotation changed or was already removed. Refresh before trying again."));}Ok(())
    }
    pub fn annotate(&self,key:&str,body:&Value,author:&str,pending:bool)->Result<Value>{
        let _gate=self.edit_gate.lock().unwrap();
        let before=self.annotation_content(key)?;
        let result=self.annotate_inner(key,body,author,pending)?;
        let after=self.annotation_content(key)?;
        crate::editing::journals().lock().unwrap().entry(self.annotation_history_key(key)).or_default().record(before,after,"Add annotation");
        Ok(result)
    }
    pub fn update_annotation(&self,key:&str,aid:&str,body:&Value)->Result<Value>{
        let _gate=self.edit_gate.lock().unwrap();
        let before=self.annotation_content(key)?;
        let result=self.update_annotation_inner(key,aid,body)?;
        let after=self.annotation_content(key)?;
        crate::editing::journals().lock().unwrap().entry(self.annotation_history_key(key)).or_default().record(before,after,"Edit annotation");
        Ok(result)
    }
    pub fn reply(&self,key:&str,aid:&str,comment:&str,author:&str,pending:bool)->Result<Value>{
        let _gate=self.edit_gate.lock().unwrap();
        let before=self.annotation_content(key)?;
        let result=self.reply_inner(key,aid,comment,author,pending)?;
        let after=self.annotation_content(key)?;
        crate::editing::journals().lock().unwrap().entry(self.annotation_history_key(key)).or_default().record(before,after,"Reply to annotation");
        Ok(result)
    }
    pub fn resolve_reply(&self,key:&str,aid:&str,rid:&str,accept:bool)->Result<Value>{
        let _gate=self.edit_gate.lock().unwrap();
        let before=self.annotation_content(key)?;
        let result=self.resolve_reply_inner(key,aid,rid,accept)?;
        let after=self.annotation_content(key)?;
        crate::editing::journals().lock().unwrap().entry(self.annotation_history_key(key)).or_default().record(before,after,"Resolve reply");
        Ok(result)
    }
    pub fn delete_annotation(&self,key:&str,aid:&str,revision:i64)->Result<()>{
        let _gate=self.edit_gate.lock().unwrap();
        let before=self.annotation_content(key)?;
        let result=self.delete_annotation_inner(key,aid,revision)?;
        let after=self.annotation_content(key)?;
        crate::editing::journals().lock().unwrap().entry(self.annotation_history_key(key)).or_default().record(before,after,"Delete annotation");
        Ok(result)
    }
    pub fn save_auto_highlights(&self,key:&str,analysis:&Value,colors:&crate::settings::HighlightColors)->Result<Value>{
        let _gate=self.edit_gate.lock().unwrap();
        let before=self.annotation_content(key)?;
        let result=self.save_auto_highlights_inner(key,analysis,colors)?;
        let after=self.annotation_content(key)?;
        crate::editing::journals().lock().unwrap().entry(self.annotation_history_key(key)).or_default().record(before,after,"Auto-highlight paper");
        Ok(result)
    }
    fn annotation_history_key(&self,key:&str)->String{format!("{}:paper:{key}",self.root.display())}
    fn annotation_content(&self,key:&str)->Result<Value>{let mut list=self.annotations(key)?;list.sort_by_key(|a|a["id"].as_str().unwrap_or("").to_owned());Ok(json!(list.into_iter().map(crate::editing::content).collect::<Vec<_>>()))}
    pub fn annotation_history(&self,key:&str,request:Option<&Value>)->Result<Value>{
        let _gate=self.edit_gate.lock().unwrap();
        let current=self.annotation_content(key)?;
        let mut hs=crate::editing::journals().lock().unwrap();let h=hs.entry(self.annotation_history_key(key)).or_default();
        if let Some(b)=request {
            if b["expected"]!=json!(self.annotations(key)?){return Err(conflict("Annotations changed in another window. Refresh before undoing."));}
            let redo=b["redo"]==true;let desired=h.pending(redo,&current)?;let minimum=(now() as i64).max(self.annotations(key)?.iter().filter_map(|a|a["revision"].as_i64()).max().unwrap_or(0)+1);
            static RESTORED_REVISION:std::sync::atomic::AtomicI64=std::sync::atomic::AtomicI64::new(0);
            RESTORED_REVISION.fetch_max(minimum,std::sync::atomic::Ordering::SeqCst);
            let next_revision=RESTORED_REVISION.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
            let mut c=self.conn.lock().unwrap();let tx=c.transaction()?;
            let latest={let mut query=tx.prepare("SELECT data,revision FROM annotations WHERE paper=?1 ORDER BY json_extract(data,'$.created'),id")?;let rows=query.query_map([key],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)))?;let mut out=Vec::new();for row in rows{let (data,rev)=row?;let mut a:Value=serde_json::from_str(&data)?;a["revision"]=json!(rev);out.push(a);}out};
            if json!(latest)!=b["expected"]{return Err(conflict("Annotations changed during undo. Refresh and try again."));}
            tx.execute("DELETE FROM annotations WHERE paper=?1",[key])?;
            for item in desired.as_array().context("Invalid annotation history")? {let mut a=item.clone();let revision=next_revision;a["revision"]=json!(revision);tx.execute("INSERT INTO annotations(id,paper,data,revision) VALUES(?1,?2,?3,?4)",params![text(&a,"id"),key,a.to_string(),revision])?;}
            tx.commit()?;h.finish(redo);
        }
        Ok(h.status())
    }
    pub fn import_zotero(&self,zotero:&crate::zotero::Zotero,copy_pdfs:bool)->Result<Value> {
        let targets=zotero.import_collections()?;let mut stack:Vec<String>=Vec::new();let mut roots=Vec::new();
        // Preserve Zotero target ids and permanent note-folder ids. New Noctua
        // ids are UUIDs, so they cannot collide with Zotero's numeric ids.
        for t in targets {
            let target=text(&t,"id");let level=t["level"].as_u64().unwrap_or(0) as usize;
            if level==0{stack.clear();roots.push(target.to_string());}
            let parent=if target=="L1"{None}else{Some(if level==0{"L1"}else{stack.get(level-1).map(String::as_str).unwrap_or("L1")})};
            let notes=zotero.folder_id(target)?;
            self.conn.lock().unwrap().execute("INSERT OR IGNORE INTO collections(id,name,parent,notes_folder) VALUES(?1,?2,?3,?4)",params![target,text(&t,"name"),parent,notes])?;
            stack.truncate(level);stack.push(target.to_string());
        }
        let mut imported=0;let mut pdfs=0;let mut warnings=Vec::new();
        for root in roots {
            for item in zotero.items(&root)? {
                let key=self.save(&item,&root)?;imported+=1;
                if copy_pdfs && self.paper(&key)?["has_pdf"]!=true {
                    if let Some(path)=zotero.local_pdf(&root,text(&item,"key"))? {
                        match std::fs::metadata(&path).context("PDF file missing").and_then(|m|if m.len()>PDF_LIMIT as u64{bail!("PDF exceeds 128 MB")}else{Ok(())}).and_then(|_|Ok(std::fs::read(path)?)).and_then(|b|self.attach_pdf(&key,&b)) {
                            Ok(())=>pdfs+=1,Err(e)=>if warnings.len()<20{warnings.push(format!("{}: {e}",text(&item,"title")));},
                        }
                    }
                }
            }
        }
        // Use each collection's own items to preserve multi-collection membership.
        for t in zotero.import_collections()? {let target=text(&t,"id");if target.starts_with('C'){for item in zotero.items(target)?{self.save(&item,target)?;}}}
        Ok(json!({"papers":imported,"pdfs":pdfs,"warnings":warnings}))
    }
}

fn normalize_paper(p:&Value)->Value {
    let s2=p["paperId"].as_str().unwrap_or_else(||text(p,"s2"));
    let doi=p["externalIds"]["DOI"].as_str().unwrap_or_else(||text(p,"DOI"));
    let arxiv=p["externalIds"]["ArXiv"].as_str().unwrap_or_else(||text(p,"arxiv"));
    let creators=p["creators"].as_array().cloned().unwrap_or_else(||p["authors"].as_array().into_iter().flatten().filter_map(|a|a["name"].as_str().map(|s|json!(s))).collect());
    let pdf=p["openAccessPdf"]["url"].as_str().filter(|s|!s.is_empty()).or_else(||p["pdf_url"].as_str().filter(|s|!s.is_empty())).map(String::from).unwrap_or_else(||if arxiv.is_empty(){String::new()}else{format!("https://arxiv.org/pdf/{arxiv}")});
    let mut aliases=p["cite_keys"].as_array().cloned().unwrap_or_default();if !text(p,"key").is_empty(){aliases.push(json!(text(p,"key")));}
    json!({"title":p["title"],"creators":creators,"year":p["year"],"venue":p["venue"],"DOI":doi,"arxiv":arxiv,"s2":s2,"url":p["url"],"pdf_url":pdf,"abstractNote":p["abstract"].as_str().unwrap_or_else(||text(p,"abstractNote")),"dateAdded":p["dateAdded"],"itemType":"paper","cite_keys":aliases})
}
fn unit(v:&Value)->Result<f64>{let n=v.as_f64().filter(|n|n.is_finite()&&(0.0..=1.0).contains(n)).ok_or_else(||bad("Annotation coordinates must be between 0 and 1"))?;Ok(n)}
fn validate_rect(v:&Value)->Result<()> {let r=v.as_array().filter(|r|r.len()==4).ok_or_else(||bad("Invalid highlight rectangle"))?;for n in r{unit(n)?;}if r[0].as_f64().unwrap()+r[2].as_f64().unwrap()>1.001||r[1].as_f64().unwrap()+r[3].as_f64().unwrap()>1.001{return Err(bad("Highlight rectangle lies outside the page"));}Ok(())}
pub(crate) fn quote_rects(page:&Value,quote:&str,occurrence:usize)->Result<Value> {
    // Browser indexes offsets in UTF-16 code units (JavaScript string offsets).
    let content=text(page,"text");let (start,_)=content.match_indices(quote).nth(occurrence).context("That exact quote was not found on this page. Use read_pdf to copy the text, or select it in the reader.")?;
    let a=content[..start].encode_utf16().count();let b=a+quote.encode_utf16().count();
    let rects:Vec<Value>=page["words"].as_array().into_iter().flatten().filter(|w|w["end"].as_u64().unwrap_or(0)>a as u64&&w["start"].as_u64().unwrap_or(u64::MAX)<b as u64).map(|w|w["rect"].clone()).collect();
    if rects.is_empty(){return Err(bad("No text positions are available for that quote"));}Ok(json!(rects))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Drop for Temp {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
    fn fixture()->(Temp,Library){let root=std::env::temp_dir().join(id("noctua-library-test-"));let lib=Library::open(root.clone()).unwrap();(Temp(root),lib)}
    #[test]
    fn persistent_collections_pdfs_and_memberships()->Result<()> {
        let (temp,lib)=fixture();let parent=lib.create_collection("L1","Physics")?;let child=lib.create_collection(&parent,"Quantum")?;
        let key=lib.save(&json!({"paperId":"s2-1","title":"A sufficiently long paper title","externalIds":{"DOI":"10.123/ABC"}}),&parent)?;
        assert_eq!(key,lib.save(&json!({"title":"Other title","DOI":"10.123/abc"}),&child)?);
        lib.attach_pdf(&key,b"%PDF-1.7\nfirst")?;assert!(lib.attach_pdf(&key,b"%PDF-1.7\nsecond").is_err());
        assert_eq!(lib.upload(&child,"same.pdf",b"%PDF-1.7\nfirst")?,key);
        assert!(lib.upload("L1","invalid.pdf",b"<html>not PDF").is_err());
        lib.remove_membership(&key,&parent)?;assert!(lib.items(&parent)?.is_empty());
        drop(lib);let lib=Library::open(temp.0.clone())?;
        assert_eq!(lib.items("L1")?.len(),1);assert_eq!(lib.items(&child)?.len(),1);assert_eq!(std::fs::read(lib.pdf_path(&key)?)?,b"%PDF-1.7\nfirst");
        let targets=lib.collections()?;assert_eq!(targets["targets"].as_array().unwrap().iter().find(|t|t["id"]==child).unwrap()["level"],2);
        Ok(())
    }
    #[test]
    fn zotero_import_copies_tree_files_and_stable_note_keys()->Result<()> {
        let (temp,lib)=fixture();let source=temp.0.join("zotero");std::fs::create_dir_all(source.join("storage/ATTACH"))?;
        let db=Connection::open(source.join("zotero.sqlite"))?;
        db.execute_batch("CREATE TABLE libraries(libraryID INTEGER,type TEXT); INSERT INTO libraries VALUES(1,'user');
            CREATE TABLE groups(libraryID INTEGER,groupID INTEGER,name TEXT);
            CREATE TABLE collections(collectionID INTEGER,collectionName TEXT,parentCollectionID INTEGER,libraryID INTEGER,key TEXT);
            INSERT INTO collections VALUES(10,'Physics',NULL,1,'PHYSICS'),(11,'Quantum',10,1,'QUANTUM');
            CREATE TABLE deletedCollections(collectionID INTEGER); CREATE TABLE deletedItems(itemID INTEGER);
            CREATE TABLE itemTypes(itemTypeID INTEGER,typeName TEXT); INSERT INTO itemTypes VALUES(1,'journalArticle'),(2,'attachment');
            CREATE TABLE items(itemID INTEGER,key TEXT,itemTypeID INTEGER,dateAdded TEXT,libraryID INTEGER);
            INSERT INTO items VALUES(1,'PAPER',1,'2026',1),(2,'ATTACH',2,'2026',1);
            CREATE TABLE itemAttachments(itemID INTEGER,parentItemID INTEGER,contentType TEXT,path TEXT);
            INSERT INTO itemAttachments VALUES(2,1,'application/pdf','storage:paper.pdf');
            CREATE TABLE collectionItems(collectionID INTEGER,itemID INTEGER); INSERT INTO collectionItems VALUES(10,1),(11,1);
            CREATE TABLE fields(fieldID INTEGER,fieldName TEXT); INSERT INTO fields VALUES(1,'title');
            CREATE TABLE itemData(itemID INTEGER,fieldID INTEGER,valueID INTEGER); INSERT INTO itemData VALUES(1,1,1);
            CREATE TABLE itemDataValues(valueID INTEGER,value TEXT); INSERT INTO itemDataValues VALUES(1,'Short');
            CREATE TABLE itemCreators(itemID INTEGER,creatorID INTEGER,orderIndex INTEGER);
            CREATE TABLE creators(creatorID INTEGER,firstName TEXT,lastName TEXT);")?;drop(db);
        std::fs::write(source.join("storage/ATTACH/paper.pdf"),b"%PDF-1.7\nimported")?;
        let original=std::fs::read(source.join("zotero.sqlite"))?;
        let zotero=crate::zotero::Zotero::new(Some(source.clone()));
        let result=lib.import_zotero(&zotero,true)?;assert_eq!(result["pdfs"],1);
        lib.import_zotero(&zotero,true)?;
        assert_eq!(lib.items("L1")?.len(),1);assert_eq!(lib.items("C10")?.len(),1);assert_eq!(lib.items("C11")?.len(),1);
        assert_eq!(lib.folder_id("C11")?,"1-QUANTUM");assert_eq!(lib.paper("PAPER")?["has_pdf"],true);
        assert_eq!(std::fs::read(source.join("zotero.sqlite"))?,original);
        std::fs::remove_dir_all(&source)?;assert_eq!(std::fs::read(lib.pdf_path("PAPER")?)?,b"%PDF-1.7\nimported");
        Ok(())
    }
    #[test]
    fn reindex_repairs_only_legacy_agent_highlights()->Result<()> {
        let (_temp,lib)=fixture();let key=lib.upload("L1","paper.pdf",b"%PDF-1.7\nrepair")?;let hash=lib.paper(&key)?["pdf_hash"].clone();
        let index=json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"energy","words":[{"start":0,"end":6,"rect":[0.1,0.2,0.12,0.03]}]}]});
        let tiny=json!([[0.1,0.2,0.0001,0.03]]);
        let user=lib.annotate(&key,&json!({"kind":"highlight","page":1,"rects":tiny,"quote":"energy"}),"user",false)?;
        let mut old=lib.annotate(&key,&json!({"kind":"highlight","page":1,"rects":tiny,"quote":"energy","comment":"$E$"}),"assistant",true)?;
        old.as_object_mut().unwrap().remove("anchor_version");
        {let c=lib.conn.lock().unwrap();c.execute("UPDATE annotations SET data=?1 WHERE id=?2",params![old.to_string(),old["id"].as_str().unwrap()])?;
        let mut legacy=index.clone();legacy.as_object_mut().unwrap().remove("version");
        c.execute("INSERT INTO pdf_index VALUES(?1,?2)",params![hash.as_str().unwrap(),legacy.to_string()])?;}
        assert!(lib.index(&key)?.is_none(),"legacy geometry must be rebuilt");
        lib.save_index(&key,&index)?;
        let all=lib.annotations(&key)?;let repaired=all.iter().find(|a|a["id"]==old["id"]).unwrap();
        assert_eq!(repaired["rects"][0][2],0.12);assert_eq!(repaired["comment"],"$E$");assert_eq!(repaired["status"],"pending");assert_eq!(repaired["revision"],2);
        assert_eq!(all.iter().find(|a|a["id"]==user["id"]).unwrap()["rects"],tiny);
        lib.save_index(&key,&index)?;assert_eq!(lib.annotations(&key)?.iter().find(|a|a["id"]==old["id"]).unwrap()["revision"],2,"repair must be idempotent");
        assert!(lib.update_annotation(&key,old["id"].as_str().unwrap(),&json!({"revision":1,"comment":"stale"})).is_err());
        Ok(())
    }
    #[test]
    fn annotation_anchors_suggestions_and_conflicts()->Result<()> {
        let (_temp,lib)=fixture();let key=lib.upload("L1","math.pdf",b"%PDF-1.7\nmath")?;let hash=lib.paper(&key)?["pdf_hash"].clone();
        lib.save_index(&key,&json!({"version":2,"hash":hash,"pages":[{"page":1,"text":"😀 energy energy","words":[{"start":3,"end":9,"rect":[0.1,0.2,0.2,0.03]},{"start":10,"end":16,"rect":[0.4,0.2,0.2,0.03]}]}]}))?;
        let a=lib.annotate(&key,&json!({"kind":"highlight","page":1,"quote":"energy","occurrence":1,"comment":"$E=mc^2$"}),"assistant",true)?;
        assert_eq!(a["rects"][0][0],0.4);assert_eq!(a["status"],"pending");
        let aid=a["id"].as_str().unwrap();let accepted=lib.update_annotation(&key,aid,&json!({"revision":1,"status":"accepted"}))?;assert_eq!(accepted["status"],"accepted");assert!(accepted.get("comment_author").is_none(),"accepting a suggestion does not make its comment user-authored");
        assert!(lib.update_annotation(&key,aid,&json!({"revision":1,"comment":"stale"})).is_err());
        let reply=lib.reply(&key,aid,"$$\\hbar\\omega$$","assistant",true)?;assert_eq!(reply["revision"],3);
        let r=reply["replies"][0]["id"].as_str().unwrap();let final_a=lib.resolve_reply(&key,aid,r,true)?;assert_eq!(final_a["replies"][0]["status"],"accepted");
        assert!(lib.annotate(&key,&json!({"kind":"highlight","page":1,"quote":"missing"}),"assistant",false).is_err());
        assert!(lib.annotate(&key,&json!({"kind":"highlight","page":2,"rects":[[0.1,0.2,0.3,0.4]]}),"user",false).is_err());
        assert!(lib.annotate(&key,&json!({"kind":"ink","page":1,"points":[[0.1,0.2],[1.2,0.5]]}),"user",false).is_err());
        assert!(lib.delete_annotation(&key,aid,1).is_err());lib.delete_annotation(&key,aid,4)?;assert!(lib.annotations(&key)?.is_empty());
        Ok(())
    }
}
