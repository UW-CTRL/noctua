//! Names and explains the citation threads found by the Lineage view, using
//! the selected CLI backend. Threads themselves are computed in the browser
//! (main-path analysis over the citation graph); this only labels them.

use std::collections::HashMap;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{agent::{self, Provider}, App};

const TTL: i64 = 180 * 24 * 3600;
const RELATIONS: [&str; 6] = ["extends", "refines", "challenges", "applies", "combines", "surveys"];

#[derive(Deserialize)]
pub struct Paper {
    id: String,
    #[serde(default)]
    title: String,
    year: Option<i64>,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(default, rename = "abstract")]
    abstract_: Option<String>,
}

#[derive(Deserialize)]
pub struct Thread {
    id: String,
    papers: Vec<Paper>,
    #[serde(default)]
    steps: Vec<(String, String)>,
}

#[derive(Deserialize)]
pub struct Request {
    threads: Vec<Thread>,
    #[serde(default)]
    others: Vec<String>,
}

const PROMPT: &str = include_str!("prompts/lineage.md");

fn clip(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s,
    }
}

fn prompt(req: &Request) -> String {
    let mut out = String::from(PROMPT);
    for t in &req.threads {
        out.push_str(&format!("## Thread {}\nPapers:\n", t.id));
        for p in &t.papers {
            let authors = p.authors.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            out.push_str(&format!("- id {} | {} | {} | {}\n", p.id, p.year.map(|y| y.to_string()).unwrap_or_else(|| "n.d.".into()), clip(&p.title, 200), authors));
            if let Some(a) = p.abstract_.as_deref().filter(|a| !a.trim().is_empty()) {
                out.push_str(&format!("  Abstract: {}\n", clip(a, 600)));
            }
        }
        out.push_str("Steps (earlier -> later):\n");
        for (a, b) in &t.steps { out.push_str(&format!("- {a} -> {b}\n")); }
        out.push('\n');
    }
    if !req.others.is_empty() {
        out.push_str("Other papers in view, not on any thread (context only):\n");
        for title in req.others.iter().take(40) { out.push_str(&format!("- {}\n", clip(title, 160))); }
    }
    out
}

fn cache_key(req: &Request, provider: Provider) -> String {
    let mut h = Sha256::new();
    h.update("v3"); // bump when the prompt changes, so older answers are not reused
    h.update(provider.key());
    for t in &req.threads {
        h.update(format!("|{}:", t.id));
        let mut ids: Vec<&str> = t.papers.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        h.update(ids.join(","));
        let mut steps: Vec<String> = t.steps.iter().map(|(a, b)| format!("{a}>{b}")).collect();
        steps.sort();
        h.update(steps.join(","));
    }
    format!("threads:{:x}", h.finalize())
}

/// The JSON object in a reply that may be wrapped in code fences or prose.
pub fn extract_json(text: &str) -> Result<Value> {
    let start = text.find('{').context("the reply contained no JSON")?;
    let end = text.rfind('}').context("the reply contained no JSON")?;
    if end < start { bail!("the reply contained no JSON"); }
    serde_json::from_str(&text[start..=end]).context("the reply was not valid JSON")
}

fn text(v: &Value, max: usize) -> String {
    clip(v.as_str().unwrap_or(""), max)
}

/// Keeps only threads, key papers and steps that were asked about, with
/// bounded text. Key papers follow the thread's order and always include its
/// first and last paper; a step must go forward along the thread.
fn sanitize(req: &Request, raw: &Value) -> Value {
    let asked: HashMap<&str, &Thread> = req.threads.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut threads = Vec::new();
    for t in raw["threads"].as_array().into_iter().flatten() {
        let Some(id) = t["id"].as_str() else { continue };
        let Some(&want) = asked.get(id) else { continue };
        let pos: HashMap<&str, usize> = want.papers.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
        let mut key: Vec<usize> = t["key"].as_array().into_iter().flatten()
            .filter_map(|k| pos.get(k.as_str()?).copied())
            .chain([0, want.papers.len().saturating_sub(1)])
            .collect();
        key.sort_unstable();
        key.dedup();
        let key: Vec<&str> = key.into_iter().filter_map(|i| want.papers.get(i).map(|p| p.id.as_str())).collect();
        let steps: Vec<Value> = t["steps"].as_array().into_iter().flatten()
            .filter_map(|s| {
                let (from, to) = (s["from"].as_str()?, s["to"].as_str()?);
                if pos.get(from)? >= pos.get(to)? { return None; }
                let rel = s["relation"].as_str().unwrap_or("").to_lowercase();
                let relation = if RELATIONS.contains(&rel.as_str()) { rel } else { "builds on".into() };
                Some(json!({ "from": from, "to": to, "relation": relation, "note": text(&s["note"], 180) }))
            })
            .collect();
        threads.push(json!({
            "id": id,
            "name": text(&t["name"], 140),
            "problem": text(&t["problem"], 300),
            "summary": text(&t["summary"], 600),
            "key": key,
            "steps": steps,
        }));
    }
    json!({ "common": text(&raw["common"], 400), "threads": threads })
}

/// With `cache_only`, returns saved labels or an empty answer without running the CLI.
pub async fn explain(app: &App, provider: Provider, req: Request, force: bool, cache_only: bool) -> Result<Value> {
    if req.threads.is_empty() { bail!("there are no threads to explain"); }
    let key = cache_key(&req, provider);
    if !force {
        if let Some(mut v) = app.s2.cache().get(&key, TTL) {
            v["cached"] = json!(true);
            return Ok(v);
        }
    }
    if cache_only { return Ok(json!({ "common": "", "threads": [], "cached": false })); }
    let reply = agent::ask_text(app, provider, &prompt(&req), "explain the threads").await?;
    let out = sanitize(&req, &extract_json(&reply)?);
    if out["threads"].as_array().map_or(true, |t| t.is_empty()) {
        bail!("{} did not describe any of the threads", provider.label());
    }
    app.s2.cache().put(&key, &out);
    let mut out = out;
    out["cached"] = json!(false);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_from_fences_and_prose() {
        let v = extract_json("Sure, here it is:\n```json\n{\"common\": \"x\", \"threads\": [{\"id\": \"t1\"}]}\n```\nDone.").unwrap();
        assert_eq!(v["threads"][0]["id"], "t1");
        assert!(extract_json("no json here").is_err());
        assert!(extract_json("} backwards {").is_err());
    }

    #[test]
    fn sanitize_orders_key_papers_and_drops_unknown_threads_and_steps() {
        let req: Request = serde_json::from_value(json!({ "threads": [{ "id": "t1",
            "papers": [{ "id": "a" }, { "id": "b" }, { "id": "c" }, { "id": "d" }],
            "steps": [["a", "b"], ["b", "c"], ["c", "d"]] }] })).unwrap();
        let raw = json!({ "common": "c", "threads": [
            { "id": "t1", "name": "N", "key": ["c", "zzz", "c", "a"], "steps": [
                { "from": "a", "to": "c", "relation": "Extends", "note": "adds" },
                { "from": "c", "to": "d", "relation": "invented" },
                { "from": "a", "to": "zzz", "relation": "extends" },
                { "from": "d", "to": "a", "relation": "extends" } ] },
            { "id": "t9", "name": "unasked" } ] });
        let out = sanitize(&req, &raw);
        let threads = out["threads"].as_array().unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0]["key"], json!(["a", "c", "d"]), "thread order, endpoints forced, no duplicates or unknown ids");
        let steps = threads[0]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2, "unknown and backward steps are dropped");
        assert_eq!(steps[0]["relation"], "extends");
        assert_eq!(steps[1]["relation"], "builds on");
    }
}
