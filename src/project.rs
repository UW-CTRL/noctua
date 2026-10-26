//! Project graphs: how the papers of one Noctua collection cite each other.
//!
//! Papers are directly connected when one cites the other; clusters are the
//! connected components of that graph. Clusters are linked by the outside
//! papers they both cite (shared references).
//!
//! Each item's Semantic Scholar record (with its reference list) is saved
//! with the collection, keyed by native paper key. Reopening a project costs no
//! requests; when the collection changes only new or edited items are fetched,
//! with one batch request per 500 papers.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    s2::{NotFound, FIELDS, S2},
    App,
};

/// Most shared references shown in the graph.
const SHARED_MAX: usize = 40;
/// Most cluster-to-cluster connections reported.
const LINKS_MAX: usize = 40;

pub struct Projects {
    conn: Mutex<Connection>,
    /// One build at a time, so the UI and the chat never fetch the same papers twice.
    building: tokio::sync::Mutex<()>,
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    entries: HashMap<String, Entry>,
    /// Metadata of shared references, by paperId.
    ext: HashMap<String, Value>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    /// The identifiers the item was looked up with; a change triggers a new lookup.
    ident: String,
    paper: Option<Value>,
    refs: Vec<String>,
}

impl Projects {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS projects (
                 target  TEXT PRIMARY KEY,
                 data    TEXT NOT NULL,
                 updated INTEGER NOT NULL
             );",
        )?;
        Ok(Self { conn: Mutex::new(conn), building: tokio::sync::Mutex::new(()) })
    }

    fn load(&self, target: &str) -> Result<(Stored, i64)> {
        let conn = self.conn.lock().unwrap();
        let row: Option<(String, i64)> = conn
            .query_row("SELECT data, updated FROM projects WHERE target = ?1", params![target], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        Ok(match row {
            Some((data, updated)) => (serde_json::from_str(&data).unwrap_or_default(), updated),
            None => (Stored::default(), 0),
        })
    }

    fn save(&self, target: &str, st: &Stored) -> Result<i64> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO projects (target, data, updated) VALUES (?1, ?2, ?3)",
            params![target, serde_json::to_string(st)?, now],
        )?;
        Ok(now)
    }
}

/// An item that needs looking up: identifiers to try in order, then its title.
struct Todo {
    key: String,
    ident: String,
    ids: Vec<String>,
    title: String,
}

fn todo_of(it: &Value) -> Todo {
    let s = |k: &str| it[k].as_str().unwrap_or("").trim().to_string();
    let (s2, arxiv, doi, title) = (s("s2"), s("arxiv"), s("DOI"), s("title"));
    let mut ids = Vec::new();
    if !s2.is_empty() {
        ids.push(s2.clone());
    }
    if !arxiv.is_empty() {
        ids.push(format!("ARXIV:{arxiv}"));
    }
    if !doi.is_empty() && !doi.to_lowercase().starts_with("10.48550/arxiv.") {
        ids.push(format!("DOI:{doi}"));
    }
    Todo { key: s("key"), ident: format!("{s2}|{arxiv}|{doi}|{title}"), ids, title }
}

/// The project graph of a collection ("C3") or library ("L1"), updating the
/// saved copy first if the collection changed.
pub async fn graph(app: &App, target: &str) -> Result<Value> {
    let _one_at_a_time = app.projects.building.lock().await;
    let include = app.settings.lock().unwrap().library.include_subfolders;
    let all_items = app.library.items_scoped(target, true)?;
    let items = if include { all_items.clone() } else { app.library.items(target)? };
    let (mut st, mut updated) = app.projects.load(target)?;

    let present: HashSet<&str> = all_items.iter().filter_map(|it| it["key"].as_str()).collect();
    let before = st.entries.len();
    st.entries.retain(|k, _| present.contains(k.as_str()));
    let mut changed = st.entries.len() != before;

    let todo: Vec<Todo> = items
        .iter()
        .map(todo_of)
        .filter(|t| st.entries.get(&t.key).map_or(true, |e| e.ident != t.ident))
        .collect();
    let mut warning = None;
    let mut fetched = 0;
    if !todo.is_empty() {
        let (found, done, err) = resolve(&app.s2, &todo).await;
        let pending = done.iter().filter(|d| !**d).count();
        if let Some(e) = err {
            warning = Some(format!(
                "{pending} item(s) not looked up yet ({e:#}). They'll be retried next time you open this project."
            ));
        }
        for ((t, p), _) in todo.iter().zip(found).zip(done).filter(|(_, d)| *d) {
            fetched += 1;
            let refs = p.as_ref().map(|p| strings(&p["references"], "paperId")).unwrap_or_default();
            let paper = p.map(|mut p| {
                if let Some(o) = p.as_object_mut() {
                    o.remove("references");
                }
                p
            });
            st.entries.insert(t.key.clone(), Entry { ident: t.ident.clone(), paper, refs });
            changed = true;
        }
    }

    let mut out = analyze(&items, &st);

    // Titles etc. for shared references we haven't seen before.
    let shared_ids: Vec<String> = strings(&out["shared"], "paperId");
    let missing: Vec<String> = shared_ids.iter().filter(|id| !st.ext.contains_key(*id)).cloned().collect();
    if !missing.is_empty() && warning.is_none() {
        match app.s2.batch(&missing, "paperId,title,year,authors,venue,citationCount,externalIds,url").await {
            Ok(metas) => {
                for (id, m) in missing.iter().zip(metas) {
                    st.ext.insert(id.clone(), if m.is_object() { m } else { json!({ "paperId": id }) });
                }
                changed = true;
            }
            Err(e) => warning = Some(format!("Couldn't load shared-reference titles ({e:#}); retrying next time.")),
        }
    }
    let keep: HashSet<&String> = shared_ids.iter().collect();
    let before = st.ext.len();
    if include || target == "L1" { st.ext.retain(|id, _| keep.contains(id)); }
    changed |= st.ext.len() != before;
    for s in out["shared"].as_array_mut().into_iter().flatten() {
        if let Some(Value::Object(meta)) = s["paperId"].as_str().and_then(|id| st.ext.get(id)) {
            for (k, v) in meta {
                s[k] = v.clone();
            }
        }
    }

    if changed {
        updated = app.projects.save(target, &st)?;
    }
    out["target"] = json!(target);
    out["include_subfolders"] = json!(include);
    out["updated"] = json!(updated);
    out["fetched"] = json!(fetched);
    out["warning"] = json!(warning);
    Ok(out)
}

/// Finds each item on Semantic Scholar: by its ids (batched), then by title.
/// Returns what was found, which items are settled (found or known missing),
/// and the error that stopped the lookup early, if any. Unsettled items are
/// simply looked up again next time.
async fn resolve(s2: &S2, todo: &[Todo]) -> (Vec<Option<Value>>, Vec<bool>, Option<anyhow::Error>) {
    let mut found = vec![None; todo.len()];
    let mut done = vec![false; todo.len()];
    let err = lookup(s2, todo, &mut found, &mut done).await.err();
    (found, done, err)
}

async fn lookup(s2: &S2, todo: &[Todo], found: &mut [Option<Value>], done: &mut [bool]) -> Result<()> {
    let fields = format!("{FIELDS},references.paperId");
    // Each item's first identifier, then its second for those still missing, …
    for round in 0..3 {
        let want = (0..todo.len())
            .filter(|&i| found[i].is_none() && todo[i].ids.len() > round)
            .map(|i| (i, todo[i].ids[round].clone()))
            .collect();
        fetch_into(s2, &fields, found, want).await?;
    }

    // The rest by title, one request each (and cached).
    let mut want = Vec::new();
    for (i, t) in todo.iter().enumerate() {
        if found[i].is_some() || t.title.is_empty() {
            done[i] = true;
            continue;
        }
        match s2.match_title(&t.title).await {
            Ok(m) if titles_agree(&t.title, m["title"].as_str().unwrap_or("")) => {
                match m["paperId"].as_str() {
                    Some(id) => want.push((i, id.to_string())),
                    None => done[i] = true,
                }
            }
            Ok(_) => done[i] = true,
            Err(e) if e.is::<NotFound>() => done[i] = true,
            Err(e) => return Err(e),
        }
    }
    let matched: Vec<usize> = want.iter().map(|w| w.0).collect();
    fetch_into(s2, &fields, found, want).await?;
    for i in matched {
        done[i] = true;
    }
    Ok(())
}

/// Batch-fetches `(slot, id)` pairs into `found`, leaving unknown ids empty.
async fn fetch_into(s2: &S2, fields: &str, found: &mut [Option<Value>], want: Vec<(usize, String)>) -> Result<()> {
    if want.is_empty() {
        return Ok(());
    }
    let (idx, ids): (Vec<usize>, Vec<String>) = want.into_iter().unzip();
    for (i, p) in idx.into_iter().zip(s2.batch(&ids, fields).await?) {
        if p["paperId"].is_string() {
            found[i] = Some(p);
        }
    }
    Ok(())
}

/// Same rule as the Library tab: at least 70% of the shorter title's words shared.
fn titles_agree(a: &str, b: &str) -> bool {
    let words = |s: &str| -> HashSet<String> {
        s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
    };
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return false;
    }
    wa.intersection(&wb).count() as f64 / wa.len().min(wb.len()) as f64 >= 0.7
}

fn strings(v: &Value, field: &str) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x[field].as_str().map(String::from))
        .collect()
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Builds the graph, clusters and shared references from the saved entries.
fn analyze(items: &[Value], st: &Stored) -> Value {
    let mut papers: Vec<Value> = Vec::new();
    let mut refs: Vec<HashSet<&str>> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut unresolved = Vec::new();
    for it in items {
        let key = it["key"].as_str().unwrap_or("");
        let Some(e) = st.entries.get(key) else { continue };
        match e.paper.as_ref().and_then(|p| p["paperId"].as_str().map(|id| (p, id))) {
            Some((p, id)) => {
                // Two Zotero items can be the same paper.
                if let Some(&i) = index.get(id) {
                    papers[i]["keys"].as_array_mut().unwrap().push(json!(key));
                    continue;
                }
                let mut p = p.clone();
                p["keys"] = json!([key]);
                index.insert(id.to_string(), papers.len());
                papers.push(p);
                refs.push(e.refs.iter().map(String::as_str).collect());
            }
            None => unresolved.push(json!({ "key": key, "title": it["title"] })),
        }
    }
    let n = papers.len();

    // Direct citations, merged into clusters with union-find.
    let mut parent: Vec<usize> = (0..n).collect();
    let mut edges = Vec::new();
    let mut deg = vec![0usize; n];
    for i in 0..n {
        for r in &refs[i] {
            if let Some(&j) = index.get(*r) {
                if j != i {
                    edges.push((i, j));
                    deg[i] += 1;
                    deg[j] += 1;
                    let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                    parent[a] = b;
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(i);
    }
    let cites = |i: usize| papers[i]["citationCount"].as_u64().unwrap_or(0);
    let mut groups: Vec<Vec<usize>> = groups.into_values().collect();
    for g in &mut groups {
        g.sort_by_key(|&i| (std::cmp::Reverse(deg[i]), std::cmp::Reverse(cites(i))));
    }
    // Biggest clusters first; unconnected papers by citations.
    groups.sort_by_key(|g| (std::cmp::Reverse(g.len()), std::cmp::Reverse(cites(g[0]))));
    let mut cluster_of = vec![0usize; n];
    for (c, g) in groups.iter().enumerate() {
        for &i in g {
            cluster_of[i] = c + 1;
        }
    }

    // Outside papers cited from more than one cluster.
    let mut citers: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, rs) in refs.iter().enumerate() {
        for r in rs {
            if !index.contains_key(*r) {
                citers.entry(r).or_default().push(i);
            }
        }
    }
    let mut shared: Vec<(&str, Vec<usize>, Vec<usize>)> = citers
        .into_iter()
        .filter_map(|(r, cs)| {
            let mut cl: Vec<usize> = cs.iter().map(|&i| cluster_of[i]).collect();
            cl.sort_unstable();
            cl.dedup();
            (cl.len() >= 2).then_some((r, cl, cs))
        })
        .collect();
    shared.sort_by(|a, b| (b.1.len(), b.2.len(), a.0).cmp(&(a.1.len(), a.2.len(), b.0)));

    // Cluster pairs, counted over all shared references; examples from the top ones.
    let shown: HashSet<&str> = shared.iter().take(SHARED_MAX).map(|s| s.0).collect();
    let mut pairs: HashMap<(usize, usize), (usize, Vec<&str>)> = HashMap::new();
    for (r, cl, _) in &shared {
        for (x, &a) in cl.iter().enumerate() {
            for &b in &cl[x + 1..] {
                let e = pairs.entry((a, b)).or_default();
                e.0 += 1;
                if shown.contains(r) && e.1.len() < 5 {
                    e.1.push(r);
                }
            }
        }
    }
    let mut links: Vec<_> = pairs.into_iter().collect();
    links.sort_by(|a, b| (b.1 .0, a.0).cmp(&(a.1 .0, b.0)));
    links.truncate(LINKS_MAX);

    let id = |i: usize| papers[i]["paperId"].clone();
    let edges_out: Vec<Value> = edges.iter().map(|&(s, t)| json!([id(s), id(t)])).collect();
    let clusters: Vec<Value> = groups
        .iter()
        .enumerate()
        .map(|(c, g)| json!({ "id": c + 1, "size": g.len(), "papers": g.iter().map(|&i| id(i)).collect::<Vec<_>>() }))
        .collect();
    let shared_out: Vec<Value> = shared
        .iter()
        .take(SHARED_MAX)
        .map(|(r, cl, cs)| json!({ "paperId": r, "clusters": cl, "citedBy": cs.iter().map(|&i| id(i)).collect::<Vec<_>>() }))
        .collect();
    let links_out: Vec<Value> = links
        .iter()
        .map(|((a, b), (count, ex))| json!({ "a": a, "b": b, "shared": count, "refs": ex }))
        .collect();
    for i in 0..n {
        papers[i]["cluster"] = json!(cluster_of[i]);
        papers[i]["links"] = json!(deg[i]);
    }
    json!({
        "items": items.len(),
        "papers": papers,
        "edges": edges_out,
        "clusters": clusters,
        "shared": shared_out,
        "links": links_out,
        "unresolved": unresolved,
    })
}
