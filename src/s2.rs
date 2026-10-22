//! Semantic Scholar client. Every outgoing request passes through a single
//! FIFO gate that enforces the 1 request/second limit (with a little margin),
//! and 429/5xx responses push the gate forward with exponential backoff.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Result};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::cache::Cache;

const GRAPH: &str = "https://api.semanticscholar.org/graph/v1";
const RECS: &str = "https://api.semanticscholar.org/recommendations/v1";

/// Fields fetched for every paper shown in the UI.
pub const FIELDS: &str = "paperId,title,year,authors,venue,citationCount,referenceCount,\
influentialCitationCount,externalIds,url,abstract,publicationTypes,journal,publicationDate,\
openAccessPdf,fieldsOfStudy";

/// 1 req/s is the documented limit; the extra 100ms avoids edge-of-window 429s.
const MIN_INTERVAL: Duration = Duration::from_millis(1100);
const MAX_ATTEMPTS: u32 = 5;
const BATCH_MAX: usize = 500;

const DAY: i64 = 86_400;
const TTL_SEARCH: i64 = DAY;
const TTL_PAPER: i64 = 7 * DAY;
const TTL_REFS: i64 = 30 * DAY;

#[derive(Debug)]
pub struct NotFound;

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("paper not found on Semantic Scholar")
    }
}

impl std::error::Error for NotFound {}

pub struct S2 {
    http: Client,
    /// The user's API key; swappable at runtime (Settings).
    key: std::sync::RwLock<Option<String>>,
    /// Earliest instant at which the next request may be sent.
    gate: Mutex<Instant>,
    pending: AtomicUsize,
    sent: AtomicUsize,
    cache: Arc<Cache>,
}

impl S2 {
    pub fn new(key: Option<String>, cache: Arc<Cache>) -> Self {
        let http = Client::builder()
            .user_agent(concat!("noctua/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("http client");
        Self {
            http,
            key: std::sync::RwLock::new(key),
            gate: Mutex::new(Instant::now()),
            pending: AtomicUsize::new(0),
            sent: AtomicUsize::new(0),
            cache,
        }
    }

    pub fn set_key(&self, key: Option<String>) {
        *self.key.write().unwrap() = key;
    }

    /// The last four characters of the key in use, if any (never the key itself).
    pub fn key_hint(&self) -> Option<String> {
        let k = self.key.read().unwrap();
        k.as_ref().map(|k| format!("…{}", &k[k.len().saturating_sub(4)..]))
    }

    /// Checks a key with one small request (through the rate gate, no retries).
    pub async fn test_key(&self, key: &str) -> Result<()> {
        {
            let mut next = self.gate.lock().await;
            let now = Instant::now();
            if *next > now {
                tokio::time::sleep(*next - now).await;
            }
            *next = Instant::now() + MIN_INTERVAL;
        }
        self.sent.fetch_add(1, Ordering::Relaxed);
        let resp = self
            .http
            .get(format!("{GRAPH}/paper/search"))
            .query(&[("query", "graph"), ("limit", "1"), ("fields", "title")])
            .header("x-api-key", key)
            .send()
            .await
            .map_err(|_| anyhow!("couldn't reach Semantic Scholar; check your connection and try again"))?;
        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => bail!("Semantic Scholar rejected this key"),
            StatusCode::TOO_MANY_REQUESTS => bail!("Semantic Scholar is rate-limiting right now; try again in a minute"),
            s => bail!("Semantic Scholar returned {s}; try again shortly"),
        }
    }

    /// (requests waiting for the gate, requests sent since startup)
    pub fn stats(&self) -> (usize, usize) {
        (self.pending.load(Ordering::Relaxed), self.sent.load(Ordering::Relaxed))
    }

    async fn send(&self, build: impl Fn(&Client) -> RequestBuilder) -> Result<Value> {
        self.pending.fetch_add(1, Ordering::Relaxed);
        let result = self.send_gated(build).await;
        self.pending.fetch_sub(1, Ordering::Relaxed);
        result
    }

    async fn send_gated(&self, build: impl Fn(&Client) -> RequestBuilder) -> Result<Value> {
        let mut backoff = Duration::from_secs(2);
        for attempt in 1..=MAX_ATTEMPTS {
            {
                // tokio's Mutex is fair, so waiters are served in arrival order.
                let mut next = self.gate.lock().await;
                let now = Instant::now();
                if *next > now {
                    tokio::time::sleep(*next - now).await;
                }
                *next = Instant::now() + MIN_INTERVAL;
            }

            let mut req = build(&self.http);
            if let Some(k) = self.key.read().unwrap().clone() {
                req = req.header("x-api-key", k);
            }
            let req = req.build()?;
            let path = req.url().path().replace("/graph/v1", "").replace("/recommendations/v1", "/recs");
            self.sent.fetch_add(1, Ordering::Relaxed);
            let started = Instant::now();
            let resp = self.http.execute(req).await?;
            let status = resp.status();
            eprintln!("s2 {path} -> {} ({:.1}s)", status.as_u16(), started.elapsed().as_secs_f32());

            if (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
                && attempt < MAX_ATTEMPTS
            {
                eprintln!("s2 backing off {}s", backoff.as_secs());
                *self.gate.lock().await = Instant::now() + backoff;
                backoff *= 2;
                continue;
            }
            if status == StatusCode::NOT_FOUND {
                return Err(NotFound.into());
            }
            if !status.is_success() {
                let text = resp.text().await.unwrap_or_default();
                bail!("Semantic Scholar returned {status}: {}", text.trim());
            }
            return Ok(resp.json().await?);
        }
        Err(anyhow!("Semantic Scholar kept rate-limiting; try again shortly"))
    }

    async fn cached(
        &self,
        key: String,
        ttl: i64,
        build: impl Fn(&Client) -> RequestBuilder,
    ) -> Result<Value> {
        if let Some(v) = self.cache.get(&key, ttl) {
            return Ok(v);
        }
        let v = self.send(build).await?;
        self.cache.put(&key, &v);
        Ok(v)
    }

    pub async fn search(&self, query: &str, offset: u32) -> Result<Value> {
        let url = format!("{GRAPH}/paper/search");
        let q = query.trim().to_string();
        self.cached(format!("search:{offset}:{q}"), TTL_SEARCH, |c| {
            c.get(&url).query(&[
                ("query", q.as_str()),
                ("offset", &offset.to_string()),
                ("limit", "30"),
                ("fields", FIELDS),
            ])
        })
        .await
    }

    /// Best title match, used for Zotero items that have no DOI or arXiv id.
    pub async fn match_title(&self, title: &str) -> Result<Value> {
        let url = format!("{GRAPH}/paper/search/match");
        let t = title.trim().to_string();
        let v = self
            .cached(format!("match:{t}"), TTL_PAPER, |c| {
                c.get(&url).query(&[("query", t.as_str()), ("fields", "paperId,title")])
            })
            .await?;
        v["data"].get(0).cloned().ok_or_else(|| NotFound.into())
    }

    /// `id` may be a paperId or a prefixed id such as `DOI:…` or `ARXIV:…`.
    pub async fn paper(&self, id: &str) -> Result<Value> {
        let url = format!("{GRAPH}/paper/{}", encode_id(id));
        let fields = format!("{FIELDS},tldr");
        self.cached(format!("paper:{id}"), TTL_PAPER, |c| {
            c.get(&url).query(&[("fields", fields.as_str())])
        })
        .await
    }

    /// Papers on one side of the citation relation. `kind` is "references"
    /// (papers this one cites) or "citations" (papers citing this one).
    /// Returns at most 1000 entries, each a paper object plus `influential`.
    async fn edges(&self, id: &str, kind: &str) -> Result<Vec<Value>> {
        let url = format!("{GRAPH}/paper/{id}/{kind}");
        let fields = format!("isInfluential,{FIELDS}");
        let v = self
            .cached(format!("{kind}:{id}"), TTL_PAPER, |c| {
                c.get(&url).query(&[("fields", fields.as_str()), ("limit", "1000")])
            })
            .await?;
        let inner = if kind == "references" { "citedPaper" } else { "citingPaper" };
        let out = v["data"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|e| {
                let mut p = e.get(inner)?.clone();
                p.get("paperId")?.as_str()?;
                p["influential"] = e["isInfluential"].clone();
                Some(p)
            })
            .collect();
        Ok(out)
    }

    /// Center paper plus its most-cited references and citations.
    pub async fn graph(&self, id: &str, limit: usize) -> Result<Value> {
        let center = self.paper(id).await?;
        let pid = center["paperId"]
            .as_str()
            .ok_or_else(|| anyhow!("paper has no id"))?
            .to_string();
        let refs = self.edges(&pid, "references").await?;
        let cites = self.edges(&pid, "citations").await?;
        let (total_refs, total_cites) = (refs.len(), cites.len());
        Ok(json!({
            "center": center,
            "references": top_cited(refs, limit),
            "citations": top_cited(cites, limit),
            "fetchedReferences": total_refs,
            "fetchedCitations": total_cites,
        }))
    }

    pub async fn similar(&self, id: &str, limit: usize) -> Result<Value> {
        let url = format!("{RECS}/papers/forpaper/{id}");
        let v = self
            .cached(format!("similar:{limit}:{id}"), TTL_PAPER, |c| {
                c.get(&url)
                    .query(&[("fields", FIELDS), ("limit", &limit.to_string())])
            })
            .await?;
        Ok(v["recommendedPapers"].clone())
    }

    /// Many papers at once, one request per 500 ids. Returns one entry per id
    /// (`Null` when Semantic Scholar doesn't know it). Reference lists fetched
    /// this way (`references.paperId`) are cached for `links`.
    pub async fn batch(&self, ids: &[String], fields: &str) -> Result<Vec<Value>> {
        let url = format!("{GRAPH}/paper/batch");
        let mut out = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(BATCH_MAX) {
            let body = json!({ "ids": chunk });
            let v = self
                .send(|c| c.post(&url).query(&[("fields", fields)]).json(&body))
                .await?;
            let got = v.as_array().map(|a| a.as_slice()).unwrap_or_default();
            for i in 0..chunk.len() {
                let p = got.get(i).cloned().unwrap_or(Value::Null);
                if let (Some(id), Some(refs)) = (p["paperId"].as_str(), p["references"].as_array()) {
                    let list: Vec<&str> = refs.iter().filter_map(|r| r["paperId"].as_str()).collect();
                    self.cache.put(&format!("refids:{id}"), &json!(list));
                }
                out.push(p);
            }
        }
        Ok(out)
    }

    /// Citation edges `(citing, cited)` among the given papers. Reference
    /// lists are cached per paper; missing ones are fetched with the batch
    /// endpoint (one request per 500 papers).
    pub async fn links(&self, ids: &[String]) -> Result<Vec<(String, String)>> {
        let mut refs: HashMap<String, Vec<String>> = HashMap::new();
        let mut missing = Vec::new();
        for id in ids {
            match self.cache.get(&format!("refids:{id}"), TTL_REFS) {
                Some(Value::Array(a)) => {
                    refs.insert(id.clone(), strings(&a));
                }
                _ => missing.push(id.clone()),
            }
        }

        let url = format!("{GRAPH}/paper/batch");
        for chunk in missing.chunks(BATCH_MAX) {
            let body = json!({ "ids": chunk });
            let v = self
                .send(|c| {
                    c.post(&url)
                        .query(&[("fields", "references.paperId")])
                        .json(&body)
                })
                .await?;
            for (id, entry) in chunk.iter().zip(v.as_array().map(|a| a.as_slice()).unwrap_or_default()) {
                let list: Vec<String> = entry["references"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|r| r["paperId"].as_str().map(String::from)).collect())
                    .unwrap_or_default();
                self.cache.put(&format!("refids:{id}"), &json!(list));
                refs.insert(id.clone(), list);
            }
        }

        let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for (src, targets) in &refs {
            for t in targets {
                if t != src && set.contains(t.as_str()) {
                    out.push((src.clone(), t.clone()));
                }
            }
        }
        Ok(out)
    }
}

fn strings(a: &[Value]) -> Vec<String> {
    a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
}

fn top_cited(mut papers: Vec<Value>, limit: usize) -> Vec<Value> {
    papers.sort_by_key(|p| std::cmp::Reverse(p["citationCount"].as_u64().unwrap_or(0)));
    papers.truncate(limit);
    papers
}

/// Percent-encodes a paper id for use as a path segment, keeping the `:` and
/// `/` that Semantic Scholar expects in ids like `DOI:10.1145/123`.
fn encode_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for b in id.trim().bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
