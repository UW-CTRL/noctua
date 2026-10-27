//! Additional paper-search providers, normalized to the research UI's paper shape.
use crate::cache::Cache;
use anyhow::{bail, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{sync::Mutex, time::Instant};

pub struct SearchProviders {
    http: Client,
    cache: Arc<Cache>,
    arxiv_gate: Mutex<Instant>,
}
impl SearchProviders {
    pub fn new(cache: Arc<Cache>) -> Self {
        Self {
            http: Client::builder()
                .user_agent(concat!("Noctua/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("search HTTP client"),
            cache,
            arxiv_gate: Mutex::new(Instant::now()),
        }
    }
    pub async fn search(
        &self,
        engine: &str,
        q: &str,
        offset: u32,
        id: Option<&str>,
    ) -> Result<Value> {
        anyhow::ensure!(
            matches!(engine, "arxiv" | "openalex"),
            "Unknown paper search engine"
        );
        let key = format!(
            "provider:v2:{engine}:{offset}:{}:{}",
            q.trim(),
            id.unwrap_or("")
        );
        if let Some(value) = self.cache.get(&key, 86400) {
            return Ok(value);
        }
        let value = if engine == "arxiv" {
            // arXiv asks clients to leave at least three seconds between requests.
            let mut next = self.arxiv_gate.lock().await;
            tokio::time::sleep_until(*next).await;
            if let Some(value) = self.cache.get(&key, 86400) {
                return Ok(value);
            }
            let mut params = vec![("start", offset.to_string()), ("max_results", "30".into())];
            if let Some(arxiv) = id.and_then(|s| s.strip_prefix("ARXIV:")) {
                params.push(("id_list", arxiv.into()));
            } else if let Some(doi) = id.and_then(|s| s.strip_prefix("DOI:")) {
                params.push(("search_query", format!("doi:\"{doi}\"")));
            } else {
                params.push(("search_query", arxiv_query(q)));
            }
            let response = self
                .http
                .get("https://export.arxiv.org/api/query")
                .query(&params)
                .send()
                .await;
            *next = Instant::now() + Duration::from_secs(3);
            let response = response.context("arXiv search could not connect")?;
            if !response.status().is_success() {
                bail!(
                    "arXiv search returned {}. Try again shortly.",
                    response.status()
                );
            }
            parse_arxiv(&response.text().await?, offset)?
        } else {
            let mut params = vec![
                ("per-page", "30".into()),
                ("page", (offset / 30 + 1).to_string()),
                (
                    "select",
                    "id,doi,title,publication_year,authorships,primary_location,best_oa_location,cited_by_count"
                        .into(),
                ),
            ];
            if let Some(doi) = id.and_then(|s| s.strip_prefix("DOI:")) {
                params.push(("filter", format!("doi:https://doi.org/{doi}")));
            } else {
                params.push(("search", q.trim().into()));
            }
            let response = self
                .http
                .get("https://api.openalex.org/works")
                .query(&params)
                .send()
                .await
                .context("OpenAlex search could not connect")?;
            if !response.status().is_success() {
                bail!(
                    "OpenAlex search returned {}. Try again shortly.",
                    response.status()
                );
            }
            normalize_openalex(&response.json().await?, offset)
        };
        self.cache.put(&key, &value);
        Ok(value)
    }
}
fn arxiv_query(q: &str) -> String {
    // Keep field/Boolean queries available; ordinary words search all fields.
    if q.contains(':') {
        q.trim().into()
    } else {
        q.split_whitespace()
            .map(|word| format!("all:{word}"))
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}
fn page(data: Vec<Value>, total: u64, offset: u32) -> Value {
    let end = u64::from(offset) + data.len() as u64;
    let next = if !data.is_empty() && end < total {
        Some(end)
    } else {
        None
    };
    json!({"data":data,"total":total,"next":next})
}
fn normalize_openalex(value: &Value, offset: u32) -> Value {
    let data = value["results"].as_array().into_iter().flatten().map(|p| {
        let doi = p["doi"].as_str().and_then(|s| s.strip_prefix("https://doi.org/"));
        let authors: Vec<Value> = p["authorships"].as_array().into_iter().flatten()
            .map(|a| json!({"name":a["author"]["display_name"]})).collect();
        json!({"paperId":doi.map(|s|format!("DOI:{s}")), "title":p["title"],
            "year":p["publication_year"], "authors":authors,
            "venue":p["primary_location"]["source"]["display_name"],
            "citationCount":p["cited_by_count"], "openAccessPdf":{"url":p["best_oa_location"]["pdf_url"]}, "externalIds":{"DOI":doi},
            "url":p["primary_location"]["landing_page_url"].as_str().or(p["id"].as_str()), "searchProvider":"openalex"})
    }).collect();
    page(data, value["meta"]["count"].as_u64().unwrap_or(0), offset)
}
fn text(node: roxmltree::Node<'_, '_>, name: &str) -> String {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn parse_arxiv(body: &str, offset: u32) -> Result<Value> {
    let doc = roxmltree::Document::parse(body).context("Invalid arXiv response")?;
    let feed = doc.root_element();
    let total = text(feed, "totalResults").parse().unwrap_or(0);
    let mut data = Vec::new();
    for entry in feed
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "entry")
    {
        let url = text(entry, "id");
        if url.contains("/api/errors") {
            bail!("arXiv search: {}", text(entry, "summary"));
        }
        let Some(id) = url.split("/abs/").nth(1) else {
            continue;
        };
        let id = id
            .rsplit_once('v')
            .filter(|(_, v)| v.chars().all(|c| c.is_ascii_digit()))
            .map(|(id, _)| id)
            .unwrap_or(id);
        let authors: Vec<Value> = entry
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "author")
            .map(|a| json!({"name":text(a,"name")}))
            .collect();
        let doi = text(entry, "doi");
        data.push(json!({"paperId":format!("ARXIV:{id}"), "title":text(entry,"title"),
            "year":text(entry,"published").get(..4).and_then(|s|s.parse::<u32>().ok()),
            "authors":authors, "venue":"arXiv", "citationCount":null, "abstract":text(entry,"summary"),
            "externalIds":{"ArXiv":id,"DOI":if doi.is_empty(){None}else{Some(doi)}},
            "url":url, "searchProvider":"arxiv"}));
    }
    Ok(page(data, total, offset))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atom_namespaces_entities_and_pagination() {
        let body = r#"<feed xmlns="http://www.w3.org/2005/Atom" xmlns:os="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><os:totalResults>2</os:totalResults><entry><id>http://arxiv.org/abs/hep-th/9901001v2</id><title>A &amp; B
        networks</title><published>1999-01-01</published><author><name>Alice</name></author><summary>Abstract</summary><arxiv:doi>10.1/example</arxiv:doi></entry></feed>"#;
        let result = parse_arxiv(body, 0).unwrap();
        assert_eq!(result["data"][0]["paperId"], "ARXIV:hep-th/9901001");
        assert_eq!(result["data"][0]["title"], "A & B networks");
        assert_eq!(result["data"][0]["externalIds"]["DOI"], "10.1/example");
        assert!(result["data"][0]["citationCount"].is_null());
        assert_eq!(result["next"], 1);
        assert!(parse_arxiv("not xml", 0).is_err());
        assert!(parse_arxiv(r#"<feed><entry><id>http://arxiv.org/api/errors#bad</id><summary>Bad query</summary></entry></feed>"#,0).is_err());
    }
    #[test]
    fn openalex_optional_identifiers_and_final_page() {
        let result = normalize_openalex(
            &json!({"meta":{"count":31},"results":[{"title":"Paper","doi":null,"authorships":[],"publication_year":2026}]}),
            30,
        );
        assert!(result["next"].is_null());
        assert!(result["data"][0]["paperId"].is_null());
        let result = normalize_openalex(
            &json!({"meta":{"count":1},"results":[{"doi":"https://doi.org/10.1/test","best_oa_location":{"pdf_url":"https://example.org/paper.pdf"}}]}),
            0,
        );
        assert_eq!(result["data"][0]["paperId"], "DOI:10.1/test");
        assert_eq!(result["data"][0]["openAccessPdf"]["url"], "https://example.org/paper.pdf");
        assert_eq!(arxiv_query("graph networks"), "all:graph AND all:networks");
        assert_eq!(arxiv_query("ti:graph"), "ti:graph");
    }
}
