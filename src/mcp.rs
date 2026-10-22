//! A minimal MCP server (JSON-RPC over HTTP, JSON responses only) that lets
//! the chat assistant use Noctua: search Semantic Scholar, drive the graph UI
//! and save papers to Zotero.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::App;

/// Handles one JSON-RPC message. Returns `None` for notifications. `mode` is
/// the chat mode the assistant runs in: "suggest", "plan" or "direct".
pub async fn handle(app: &App, req: &Value, mode: &str) -> Option<Value> {
    let id = req.get("id")?.clone();
    let method = req["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "noctua", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools(mode) })),
        "tools/call" => Ok(call(app, &req["params"], mode).await),
        _ => Err(json!({ "code": -32601, "message": format!("unknown method {method}") })),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    })
}

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required },
    })
}

/// Tools that change things; hidden in plan mode.
const WRITE_TOOLS: [&str; 2] = ["add_to_zotero", "edit_note"];

fn tools(mode: &str) -> Value {
    let paper_id = json!({ "type": "string", "description": "Semantic Scholar paperId, or DOI:<doi> / ARXIV:<id>" });
    let folder_id = json!({ "type": "string", "description": "Zotero target id such as \"C3\" (folder) or \"L1\" (library root)" });
    let mut list = json!([
        tool("search_papers", "Search Semantic Scholar. Returns up to 10 papers.",
             json!({ "query": { "type": "string" } }), &["query"]),
        tool("get_paper", "Full details of one paper, including abstract and TL;DR.",
             json!({ "paper_id": paper_id }), &["paper_id"]),
        tool("show_graph", "Build and show this paper's citation graph in the Noctua window. Returns its top references and citations.",
             json!({ "paper_id": paper_id }), &["paper_id"]),
        tool("select_paper", "Highlight a paper in the Noctua window. If it isn't in the current graph, its own graph is opened instead.",
             json!({ "paper_id": paper_id }), &["paper_id"]),
        tool("list_zotero_folders", "List the user's Zotero libraries and folders with their ids.",
             json!({}), &[]),
        tool("list_folder_items", "List the papers in a Zotero folder or library.",
             json!({ "folder_id": folder_id }), &["folder_id"]),
        tool("get_project_graph", "Citation structure of a Zotero folder's papers: clusters of papers connected by direct citations, unconnected papers, and the references that link clusters. Uses the saved copy; only new or changed items are looked up.",
             json!({ "folder_id": folder_id }), &["folder_id"]),
        tool("show_project_graph", "Show a Zotero folder's project graph in the Noctua window.",
             json!({ "folder_id": folder_id }), &["folder_id"]),
        tool("list_notes", "List the user's notes attached to a Zotero folder.",
             json!({ "folder_id": folder_id }), &["folder_id"]),
        tool("read_note", "Read one of the user's notes: its LaTeX text, with handwritten drawings shown as [drawing].",
             json!({ "folder_id": folder_id, "note_id": { "type": "string" } }), &["folder_id", "note_id"]),
        tool("view_note_image", "Look at an image in one of the user's notes: a path from \\includegraphics{images/…} in the note's text. Returns the image itself, so you can read, transcribe or interpret it (e.g. into LaTeX for edit_note).",
             json!({ "folder_id": folder_id, "path": { "type": "string", "description": "The image path as written in the note, e.g. images/plot-1a2b3c4d.png" } }), &["folder_id", "path"]),
        tool("add_to_zotero", "Save a paper into a Zotero folder (skipped if it's already in the library).",
             json!({ "paper_id": paper_id, "folder_id": folder_id }), &["paper_id", "folder_id"]),
        tool("edit_note",
             if mode == "direct" {
                 "Edit one of the user's notes. The edits are applied in the editor immediately (the user can undo). Block ids come from the note text ([block <id> · text])."
             } else {
                 "Propose edits to one of the user's notes. Each edit appears in the editor as a suggestion the user accepts or rejects; nothing changes until they accept. Block ids come from the note text ([block <id> · text])."
             },
             json!({
                 "folder_id": folder_id,
                 "note_id": { "type": "string" },
                 "summary": { "type": "string", "description": "One line describing the change" },
                 "edits": { "type": "array", "items": { "type": "object", "properties": {
                     "op": { "type": "string", "enum": ["replace", "insert_after", "delete"] },
                     "block_id": { "type": "string", "description": "Block to replace/delete, or to insert after (omit to insert at the top)" },
                     "latex": { "type": "string", "description": "New LaTeX source for replace / insert_after (Noctua's LaTeX subset)" },
                     "reason": { "type": "string" },
                 }, "required": ["op"] } },
             }),
             &["folder_id", "note_id", "edits"]),
    ]);
    if mode == "plan" {
        if let Some(a) = list.as_array_mut() {
            a.retain(|t| !WRITE_TOOLS.contains(&t["name"].as_str().unwrap_or("")));
        }
    }
    list
}

async fn call(app: &App, params: &Value, mode: &str) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    if name == "view_note_image" {
        return match view_image(app, &params["arguments"]) {
            Ok(content) => json!({ "content": content }),
            Err(e) => json!({ "content": [{ "type": "text", "text": format!("Error: {e:#}") }], "isError": true }),
        };
    }
    match run(app, name, &params["arguments"], mode).await {
        Ok(v) => {
            let text = v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
            json!({ "content": [{ "type": "text", "text": text }] })
        }
        Err(e) => json!({ "content": [{ "type": "text", "text": format!("Error: {e:#}") }], "isError": true }),
    }
}

/// Images larger than this are refused (the model's per-image limit is about 5 MB).
const MAX_IMAGE_BYTES: usize = 5 << 20;

/// MCP content for `view_note_image`: the image, then its path.
fn view_image(app: &App, args: &Value) -> Result<Value> {
    let folder = args["folder_id"].as_str().ok_or_else(|| anyhow!("missing argument `folder_id`"))?;
    let path = args["path"].as_str().map(str::trim).ok_or_else(|| anyhow!("missing argument `path`"))?;
    let file = path.strip_prefix("images/").unwrap_or(path);
    let (full, mime) = app.notes.image_path(&app.zotero.folder_id(folder)?, file)?;
    let bytes = std::fs::read(&full).map_err(|_| anyhow!("no image {path} in this folder"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        bail!("{path} is {:.1} MB; images over 5 MB can't be viewed", bytes.len() as f64 / 1048576.0);
    }
    Ok(json!([
        { "type": "image", "data": base64(&bytes), "mimeType": mime },
        { "type": "text", "text": format!("Image {path}") },
    ]))
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The `images/…` paths a block's LaTeX includes with \includegraphics.
fn image_paths(src: &str) -> Vec<&str> {
    src.match_indices("\\includegraphics")
        .filter_map(|(i, _)| {
            let rest = &src[i..];
            let open = rest.find('{')?;
            let close = open + rest[open..].find('}')?;
            Some(rest[open + 1..close].trim()).filter(|p| p.starts_with("images/"))
        })
        .collect()
}

async fn run(app: &App, name: &str, args: &Value, mode: &str) -> Result<Value> {
    if mode == "plan" && WRITE_TOOLS.contains(&name) {
        bail!("plan mode is read-only: describe the change instead of making it");
    }
    let arg = |k: &str| {
        args[k]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| anyhow!("missing argument `{k}`"))
    };
    match name {
        "search_papers" => {
            let r = app.s2.search(arg("query")?, 0).await?;
            let papers: Vec<Value> = r["data"].as_array().into_iter().flatten().take(10).map(brief).collect();
            Ok(json!(papers))
        }
        "get_paper" => {
            let p = app.s2.paper(arg("paper_id")?).await?;
            let mut d = brief(&p);
            d["abstract"] = p["abstract"].clone();
            d["tldr"] = p["tldr"]["text"].clone();
            d["referenceCount"] = p["referenceCount"].clone();
            d["doi"] = p["externalIds"]["DOI"].clone();
            d["arxiv"] = p["externalIds"]["ArXiv"].clone();
            Ok(d)
        }
        "show_graph" => {
            let g = app.s2.graph(arg("paper_id")?, 60).await?;
            app.ui(json!({ "action": "graph", "id": g["center"]["paperId"] }));
            let top = |k: &str| -> Vec<Value> {
                g[k].as_array().into_iter().flatten().take(10).map(brief).collect()
            };
            Ok(json!({
                "center": brief(&g["center"]),
                "top_references": top("references"),
                "top_citations": top("citations"),
            }))
        }
        "select_paper" => {
            let p = app.s2.paper(arg("paper_id")?).await?;
            app.ui(json!({ "action": "select", "id": p["paperId"] }));
            Ok(json!("Selected in the Noctua window."))
        }
        "list_zotero_folders" => Ok(app.zotero.collections().await?["targets"].clone()),
        "list_folder_items" => {
            let items = app.zotero.items(arg("folder_id")?)?;
            Ok(json!(items
                .iter()
                .map(|it| json!({
                    "title": it["title"], "year": it["year"], "creators": it["creators"],
                    "doi": it["DOI"], "arxiv": it["arxiv"],
                }))
                .collect::<Vec<_>>()))
        }
        "get_project_graph" => Ok(project_summary(&crate::project::graph(app, arg("folder_id")?).await?)),
        "show_project_graph" => {
            let folder = arg("folder_id")?;
            crate::project::graph(app, folder).await?;
            app.ui(json!({ "action": "project", "target": folder }));
            Ok(json!("Project graph shown in the Noctua window."))
        }
        "list_notes" => Ok(app.notes.list(&app.zotero.folder_id(arg("folder_id")?)?)?),
        "read_note" => {
            let folder = app.zotero.folder_id(arg("folder_id")?)?;
            let note = app.notes.get(&folder, arg("note_id")?)?.ok_or_else(|| anyhow!("no such note"))?;
            Ok(json!(note_text(&note)))
        }
        "edit_note" => {
            let folder = arg("folder_id")?;
            let note_id = arg("note_id")?;
            app.notes.get(&app.zotero.folder_id(folder)?, note_id)?.ok_or_else(|| anyhow!("no such note"))?;
            let edits = args["edits"].as_array().filter(|a| !a.is_empty()).ok_or_else(|| anyhow!("missing `edits`"))?;
            for e in edits {
                match e["op"].as_str() {
                    Some("replace") | Some("insert_after") if e["latex"].is_string() => {}
                    Some("delete") if e["block_id"].is_string() => {}
                    Some("replace") if !e["block_id"].is_string() => bail!("replace needs a block_id"),
                    _ => bail!("each edit needs an op (replace/insert_after/delete), latex for replace/insert_after, and block_id for replace/delete"),
                }
            }
            app.ui(json!({
                "action": "note_edit", "folder": folder, "note_id": note_id,
                "edits": edits, "summary": args["summary"], "mode": mode,
            }));
            Ok(json!(if mode == "direct" {
                format!("Applied {} edit(s) in the editor; the user can undo.", edits.len())
            } else {
                format!("Sent {} suggested edit(s) to the editor. The user will accept or reject them; don't assume they were applied.", edits.len())
            }))
        }
        "add_to_zotero" => {
            let p = app.s2.paper(arg("paper_id")?).await?;
            let folder = arg("folder_id")?;
            let id = p["paperId"].as_str().unwrap_or_default();
            let key = json!([{ "id": id, "doi": p["externalIds"]["DOI"], "title": p["title"] }]);
            if !app.zotero.check(key.as_array().unwrap()).unwrap_or_default().is_empty() {
                return Ok(json!(format!("“{}” is already in the Zotero library; not added again.", p["title"].as_str().unwrap_or(""))));
            }
            app.zotero.add(&p, Some(folder), true).await?;
            app.ui(json!({ "action": "library" }));
            Ok(json!(format!("Added “{}” to Zotero.", p["title"].as_str().unwrap_or(""))))
        }
        _ => bail!("unknown tool {name}"),
    }
}

fn brief(p: &Value) -> Value {
    let authors: Vec<&str> = p["authors"].as_array().into_iter().flatten().filter_map(|a| a["name"].as_str()).collect();
    let authors = match authors.len() {
        0..=3 => authors.join(", "),
        n => format!("{} et al. ({n} authors)", authors[..2].join(", ")),
    };
    json!({
        "paperId": p["paperId"], "title": p["title"], "year": p["year"],
        "authors": authors, "venue": p["venue"], "citationCount": p["citationCount"],
    })
}

/// A compact view of a project graph for the assistant.
fn project_summary(g: &Value) -> Value {
    let papers: std::collections::HashMap<&str, &Value> = g["papers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["paperId"].as_str()?, p)))
        .collect();
    let line = |p: &Value| format!("{} ({}) [{}]", p["title"].as_str().unwrap_or("?"), p["year"], p["paperId"].as_str().unwrap_or(""));
    let by_id = |id: &Value| id.as_str().and_then(|i| papers.get(i)).map(|p| line(p)).unwrap_or_default();
    let clusters = g["clusters"].as_array().map(|a| a.as_slice()).unwrap_or_default();
    let shared: std::collections::HashMap<&str, &Value> = g["shared"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| Some((s["paperId"].as_str()?, s)))
        .collect();
    // Singleton clusters are named by their paper.
    let name = |c: &Value| {
        let c = c.as_u64().unwrap_or(0) as usize;
        match clusters.get(c.wrapping_sub(1)) {
            Some(cl) if cl["size"].as_u64() == Some(1) => format!("unconnected paper {}", by_id(&cl["papers"][0])),
            _ => format!("cluster {c}"),
        }
    };
    json!({
        "zotero_items": g["items"],
        "found_on_semantic_scholar": papers.len(),
        "direct_citation_links": g["edges"].as_array().map_or(0, Vec::len),
        "clusters": clusters.iter().filter(|c| c["size"].as_u64() > Some(1)).map(|c| json!({
            "cluster": c["id"],
            "papers": c["papers"].as_array().into_iter().flatten().map(by_id).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "unconnected_papers": clusters.iter().filter(|c| c["size"].as_u64() == Some(1)).map(|c| by_id(&c["papers"][0])).collect::<Vec<_>>(),
        "connections_between_clusters": g["links"].as_array().into_iter().flatten().take(20).map(|l| json!({
            "between": [name(&l["a"]), name(&l["b"])],
            "shared_references": l["shared"],
            "examples": l["refs"].as_array().into_iter().flatten()
                .filter_map(|r| shared.get(r.as_str()?).map(|s| line(s))).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "most_shared_references": g["shared"].as_array().into_iter().flatten().take(15).map(|s| json!({
            "paper": line(s), "cited_from_clusters": s["clusters"], "cited_by_project_papers": s["citedBy"].as_array().map_or(0, Vec::len),
        })).collect::<Vec<_>>(),
        "not_found_on_semantic_scholar": g["unresolved"].as_array().into_iter().flatten().map(|u| u["title"].clone()).collect::<Vec<_>>(),
        "warning": g["warning"],
    })
}

/// A note as plain text for the assistant: title, then each block's id and LaTeX.
pub fn note_text(note: &Value) -> String {
    let mut out = format!("Title: {}\n\n", note["title"].as_str().unwrap_or(""));
    if let Some(pre) = note["preamble"].as_str().filter(|p| !p.trim().is_empty()) {
        out.push_str(&format!("[preamble · not a block; its \\newcommand etc. apply to the whole note]\n{pre}\n\n"));
    }
    for b in note["blocks"].as_array().into_iter().flatten() {
        match b["type"].as_str() {
            Some("text") => {
                out.push_str(&format!("[block {} · text]\n", b["id"].as_str().unwrap_or("")));
                let src = b["src"].as_str().unwrap_or("");
                out.push_str(src);
                let images = image_paths(src);
                if !images.is_empty() {
                    out.push_str(&format!("\n[images in this block: {} · view_note_image shows them]", images.join(", ")));
                }
            }
            Some("ink") => out.push_str(&format!("[block {} · drawing]", b["id"].as_str().unwrap_or(""))),
            _ => continue,
        }
        out.push_str("\n\n");
    }
    out
}
