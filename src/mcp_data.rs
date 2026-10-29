//! Agent-facing schemas and bounded views; UI APIs keep their full models.
use crate::App;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
pub fn string() -> Value {
    json!({"type":"string"})
}
fn boolean() -> Value {
    json!({"type":"boolean"})
}
fn integer(min: u64, max: u64) -> Value {
    json!({"type":"integer","minimum":min,"maximum":max})
}
fn strings() -> Value {
    json!({"type":"array","items":{"type":"string"},"maxItems":100})
}
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}
pub fn catalog(list: &mut Value) {
    let tools = list.as_array_mut().unwrap();
    tools.extend([
  tool("search_library","Search saved local papers without a Semantic Scholar request. Includes direct collection IDs; descendant scope is explicit.",json!({"query":string(),"folder_id":string(),"has_pdf":boolean(),"include_subfolders":boolean()}),&[]),
  tool("update_paper_memberships","Add/remove existing paper keys in multiple collections. Each paper is atomic; returns per-paper partial failures. Never deletes a Library paper. Library organization applies immediately in Suggest and Direct.",json!({"paper_keys":strings(),"add":strings(),"remove":strings()}),&["paper_keys"]),
  tool("edit_collection","Create a collection with parent/name, or rename folder_id with name. Applies immediately in Suggest and Direct. Does not move, merge or delete collections.",json!({"op":{"type":"string","enum":["create","rename"]},"parent":string(),"folder_id":string(),"name":string()}),&["op","name"]),
  tool("create_note","Create a block note, optionally with initial LaTeX and a parent workspace folder. Read list_project_files for revision first. Suggest stores a reviewable proposal; Direct saves immediately.",json!({"folder_id":string(),"revision":integer(0,u64::MAX),"parent":string(),"title":string(),"latex":string()}),&["folder_id","revision","title"]),
  tool("get_edit_proposal","Read an assistant change's proposed/applied/rejected status. Only the app's review UI can accept/reject it.",json!({"proposal_id":string()}),&["proposal_id"]),
  tool("read_pdf_outline","Read the saved AI outline without generating analysis. Reports unavailable when no saved AI outline exists; does not read embedded PDF bookmarks.",json!({"paper_key":string()}),&["paper_key"]),
  tool("get_paper_relations","Read references, citations or similar papers without changing the app view. Relationships are a bounded upstream snapshot, not the entire citation corpus.",json!({"paper_id":string(),"relation":{"type":"string","enum":["references","citations","similar"]}}),&["paper_id","relation"]),
  tool("view_note_drawing","View a saved handwriting block as PNG. Cached previews work independently; uncached previews require an active Noctua chat to render. Does not transcribe or edit strokes.",json!({"folder_id":string(),"note_id":string(),"block_id":string()}),&["folder_id","note_id","block_id"]),
 ]);
    for t in tools {
        let name = t["name"].as_str().unwrap().to_owned();
        let mut props = t["inputSchema"]["properties"].as_object().unwrap().clone();
        if super::mcp::WRITE_TOOLS.contains(&name.as_str()) {
            props.insert("request_id".into(),json!({"type":"string","minLength":1,"maxLength":100,"description":"Optional retry ID. Same arguments reuse a successful result for this backend session; changed arguments are rejected."}));
        }
        let paged = [
            "search_papers",
            "search_library",
            "list_folder_items",
            "list_notes",
            "list_project_files",
            "list_pdf_annotations",
            "get_project_graph",
            "read_pdf_outline",
            "get_paper_relations",
            "get_skill_run",
            "read_skill",
        ];
        if paged.contains(&name.as_str()) {
            props.insert("offset".into(), integer(0, u32::MAX as u64));
            props.insert(
                "limit".into(),
                integer(1, if name == "search_papers" { 30 } else { 100 }),
            );
        }
        for field in ["page", "start_page", "end_page"] {
            if props.contains_key(field) {
                props.get_mut(field).unwrap()["maximum"] = json!(10000);
            }
        }
        match name.as_str() {
            "search_papers" => {
                props.insert("include_abstract".into(), json!({"type":"boolean","description":"Include up to 2000 characters of each abstract; omitted by default."}));
                t["description"]=json!("Search Semantic Scholar with paginated results: 10 by default, up to 30 per call. Basic metadata is returned unless include_abstract is requested.");
            }
            "get_paper" => {
                props.insert("char_offset".into(), integer(0, u32::MAX as u64));
                props.insert("max_chars".into(), integer(1, 40000));
                props.insert("paper_key".into(), string());
                t["inputSchema"]["required"] = json!([]);
                t["description"]=json!("Read local details with paper_key OR remote Semantic Scholar details with paper_id, exactly one. Local results include citation keys, revision, PDF status and direct memberships.");
            }
            "show_graph" => {
                props.insert("include_summary".into(), boolean());
                t["description"]=json!("Request the paper's graph in Noctua. Returns ui_requested, not confirmation of display. Optional include_summary returns bounded citation previews.");
            }
            "list_folder_items" => {
                props.insert("query".into(), string());
                props.insert("include_subfolders".into(), boolean());
                props.insert("has_pdf".into(), boolean());
            }
            "list_notes" => {
                props.insert("query".into(), string());
                props.insert("include_trashed".into(), boolean());
                t["inputSchema"]["required"] = json!([]);
                t["description"]=json!("Search active saved notes in folder_id, or across all collections when omitted. Returns stable note/entry IDs, document title, tree display name, updated version and a bounded matching excerpt. Trash requires include_trashed.");
            }
            "read_note" => {
                props.insert(
                    "view".into(),
                    json!({"type":"string","enum":["blocks","preamble"]}),
                );
                props.insert("offset".into(), integer(0, u32::MAX as u64));
                props.insert("limit".into(), integer(1, 100));
                props.insert("block_ids".into(), strings());
                props.insert("char_offset".into(), integer(0, u32::MAX as u64));
                props.insert("max_chars".into(), integer(1, 40000));
                t["description"]=json!("Read saved LaTeX blocks with note_id/folder_id/updated and trash state. Keep preamble and block IDs for safe editing. Bounded by max_chars; resume using next_offset/next_char_offset. Drawing blocks are markers; view_note_drawing views them.");
            }
            "edit_note" => {
                props.insert("updated".into(), integer(0, u64::MAX));
                props.insert("title".into(), string());
                props.insert("preamble".into(), string());
                props.get_mut("edits").unwrap()["maxItems"] = json!(100);
                props.get_mut("edits").unwrap()["items"]["properties"]["op"]["enum"] =
                    json!(["replace", "insert_after", "delete", "move"]);
                props.get_mut("edits").unwrap()["items"]["properties"]["after_block_id"] = json!({"type":"string","description":"For move: destination block ID, empty for first"});
                props.get_mut("edits").unwrap()["items"]["additionalProperties"] = json!(false);
                t["inputSchema"]["required"] = json!(["folder_id", "note_id", "updated"]);
                t["description"]=json!("Apply targeted block edits and/or title/preamble with updated from read_note. replace/delete/move require block_id; insert_after may omit it for first. move requires after_block_id (empty for first). Replacing ink preserves it and inserts text below. Direct persists atomically before applied; Suggest stores a durable proposal for app review. Unknown blocks fail. After a newer save, edits still apply if the blocks, title or preamble they touch are unchanged since that read; otherwise read again.");
            }
            "save_to_library" => {
                props.insert("download_pdf".into(), json!({"type":"boolean","description":"Defaults to true. Set false to save metadata/membership without attempting a PDF download."}));
            }
            "list_project_files" => {
                props.insert("include_trashed".into(), boolean());
                props.insert("include_bibliography".into(), boolean());
                props.insert("query".into(), string());
                t["description"]=json!("Read a bounded workspace snapshot without auto-organizing it. Returns stable file/note IDs, paths, revision, automatically indexed bibliography IDs/counts and skills. include_bibliography adds paged citation metadata; default omits full indexes and internal blob/history fields.");
            }
            "read_project_file" | "read_skill" => {
                props.insert("char_offset".into(), integer(0, u32::MAX as u64));
                props.insert("max_chars".into(), integer(1, 40000));
                if name == "read_skill" {
                    props.insert("include_files".into(), boolean());
                }
            }
            "get_project_graph" => {
                props.insert("cluster_id".into(), integer(1, u32::MAX as u64));
            }
            "get_skill_run" => {
                t["description"]=json!("Read bounded run status and change metadata by default. view=stdout/stderr reads a log range; view=diff requires path and returns bounded before/after text. Does not return script source or base64 outputs. Applied status confirms user-approved output was saved.");
                props.insert(
                    "view".into(),
                    json!({"type":"string","enum":["summary","stdout","stderr","diff"]}),
                );
                props.insert("path".into(), string());
                props.insert("char_offset".into(), integer(0, u32::MAX as u64));
                props.insert("max_chars".into(), integer(1, 20000));
            }
            "read_pdf" => {
                t["description"]=json!("Read saved PDF text, defaulting to up to 5 pages and 12000 characters. Each call is capped at 20 pages and 40000 characters. Continue with next_page and next_char_offset. Empty text may indicate a scan.");
                props.insert("char_offset".into(), integer(0, u32::MAX as u64));
                props.insert("max_chars".into(), integer(1, 40000));
            }
            "search_pdf" => {
                props.insert("offset".into(), integer(0, u32::MAX as u64));
                props.insert("limit".into(), integer(1, 100));
            }
            "list_pdf_annotations" => {
                props.insert("annotation_id".into(), string());
                props.insert("char_offset".into(), integer(0, u32::MAX as u64));
                props.insert("max_chars".into(), integer(1, 4000));
                props.insert("reply_offset".into(), integer(0, u32::MAX as u64));
                props.insert("page".into(), integer(1, 10000));
                props.insert(
                    "kind".into(),
                    json!({"type":"string","enum":["highlight","comment","ink"]}),
                );
                props.insert(
                    "status".into(),
                    json!({"type":"string","enum":["pending","accepted"]}),
                );
                props.insert("include_geometry".into(), boolean());
                props.insert("include_replies".into(), boolean());
            }
            _ => {}
        }
        if name == "annotate_pdf" {
            props.get_mut("comment").unwrap()["maxLength"] = json!(100000);
            props.get_mut("quote").unwrap()["maxLength"] = json!(4000);
        }
        for (field,description) in [
            ("offset","Zero-based result or block offset; follow the returned next_offset."),
            ("limit","Maximum items in a result page; inspect has_more and continuation fields."),
            ("char_offset","Zero-based Unicode character offset within the current text, PDF page, or note block."),
            ("max_chars","Maximum Unicode characters per text range; use continuation metadata to read the remainder."),
            ("updated","Saved note version from read_note. Required for edits; edits conflict only where that version differs from the latest save."),
            ("revision","Workspace version from list_project_files/read_project_file. Stale versions are rejected."),
        ] {
            if let Some(property)=props.get_mut(field){property["description"]=json!(description);}
        }
        t["inputSchema"]["properties"] = json!(props);
        t["inputSchema"]["additionalProperties"] = json!(false);
    }
}
/// Validate the schema subset actually used in our catalog, including nested edit fields.
pub fn validate(schema: &Value, v: &Value) -> Result<()> {
    if let Some(kind) = schema["type"].as_str() {
        let valid = match kind {
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "integer" => v.as_u64().is_some(),
            "boolean" => v.is_boolean(),
            _ => false,
        };
        if !valid {
            bail!("Expected {kind}");
        }
    }
    if let Some(values) = schema["enum"].as_array() {
        if !values.contains(v) {
            bail!("Unsupported value: {v}");
        }
    }
    if let Some(n) = v.as_u64() {
        if schema["minimum"].as_u64().is_some_and(|min| n < min)
            || schema["maximum"].as_u64().is_some_and(|max| n > max)
        {
            bail!("Integer outside supported range");
        }
    }
    if let Some(s) = v.as_str() {
        if schema["minLength"]
            .as_u64()
            .is_some_and(|n| (s.chars().count() as u64) < n)
        {
            bail!("Text argument is too short");
        }
        if s.len() > 2 << 20
            || schema["maxLength"]
                .as_u64()
                .is_some_and(|n| s.chars().count() as u64 > n)
        {
            bail!("Text argument exceeds limit");
        }
        if schema["pattern"].is_string() && !crate::library::valid_color(s) {
            bail!("Invalid annotation color");
        }
    }
    if let Some(a) = v.as_array() {
        if a.len() > schema["maxItems"].as_u64().unwrap_or(1000) as usize {
            bail!("Too many array entries");
        }
        if let Some(items) = schema.get("items") {
            for x in a {
                validate(items, x)?;
            }
        }
    }
    if let Some(o) = v.as_object() {
        for field in schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !o.contains_key(field) {
                bail!("Missing argument: {field}");
            }
        }
        if let Some(props) = schema["properties"].as_object() {
            for (k, v) in o {
                if let Some(s) = props.get(k) {
                    validate(s, v).with_context(|| format!("Invalid {k}"))?;
                } else if schema["additionalProperties"] == false {
                    bail!("Unknown argument: {k}");
                }
            }
        }
    }
    Ok(())
}
pub fn number(a: &Value, key: &str, default: usize) -> usize {
    a[key].as_u64().unwrap_or(default as u64) as usize
}
pub fn page(items: Vec<Value>, a: &Value, default: usize) -> Value {
    let total = items.len();
    let offset = number(a, "offset", 0);
    let limit = number(a, "limit", default).min(100);
    let data: Vec<_> = items.into_iter().skip(offset).take(limit).collect();
    let next = offset.saturating_add(data.len());
    json!({"items":data,"total":total,"offset":offset,"returned_count":next.saturating_sub(offset),"has_more":next<total,"next_offset":if next<total{Some(next)}else{None}})
}
pub fn text(source: &str, a: &Value) -> Value {
    let offset = number(a, "char_offset", 0);
    let max = number(a, "max_chars", 12000).min(40000);
    let total = source.chars().count();
    let text: String = source.chars().skip(offset).take(max).collect();
    let next = offset + text.chars().count();
    json!({"text":text,"char_offset":offset,"total_chars":total,"truncated":next<total,"next_char_offset":if next<total{Some(next)}else{None}})
}
/// A bounded exact excerpt with a Unicode-safe character offset into the source.
pub fn excerpt(source: &str, query: &str, max: usize) -> (usize, String) {
    let at = source.to_lowercase().find(query).unwrap_or(0);
    let mut lowered = 0;
    let mut matched = 0;
    for (i, c) in source.chars().enumerate() {
        if lowered >= at {
            matched = i;
            break;
        }
        lowered += c.to_lowercase().map(char::len_utf8).sum::<usize>();
        matched = i + 1;
    }
    let start = matched.saturating_sub(80);
    (start, source.chars().skip(start).take(max).collect())
}
pub fn pick(v: &Value, fields: &[&str]) -> Value {
    let mut o = serde_json::Map::new();
    for f in fields {
        if let Some(value) = v.get(*f) {
            o.insert((*f).into(), value.clone());
        }
    }
    Value::Object(o)
}
pub fn range_metadata(v: &Value) -> Value {
    pick(
        v,
        &[
            "char_offset",
            "total_chars",
            "truncated",
            "next_char_offset",
        ],
    )
}
pub fn annotation(v: &Value, options: &Value) -> Value {
    let text_options = json!({"char_offset":number(options,"char_offset",0),"max_chars":number(options,"max_chars",2000).min(4000)});
    let mut out = pick(
        v,
        &[
            "id", "paper", "kind", "page", "quote", "comment", "category", "color", "author",
            "status", "revision",
        ],
    );
    if let Some(comment) = v["comment"].as_str() {
        let range = text(comment, &text_options);
        out["comment"] = range["text"].clone();
        out["comment_range"] = range_metadata(&range);
    }
    if let Some(quote) = v["quote"].as_str() {
        let range = text(quote, &json!({"max_chars":4000}));
        out["quote"] = range["text"].clone();
        out["quote_truncated"] = range["truncated"].clone();
    }
    out["reply_count"] = json!(v["replies"].as_array().map_or(0, Vec::len));
    if options["include_replies"] == true {
        out["replies"] = page(
            v["replies"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| {
                    let mut out = pick(r, &["id", "author", "created", "status"]);
                    out["comment_range"] = text(r["comment"].as_str().unwrap_or(""), &text_options);
                    out["comment"] = out["comment_range"]["text"].clone();
                    out["comment_range"] = range_metadata(&out["comment_range"]);
                    out
                })
                .collect(),
            &json!({"offset":number(options,"reply_offset",0),"limit":10}),
            10,
        );
    }
    if options["include_geometry"] == true {
        for f in ["points", "rects", "width"] {
            if let Some(x) = v.get(f) {
                out[f] = x.clone();
            }
        }
    }
    out
}
pub fn skill_run(r: &Value, a: &Value) -> Result<Value> {
    let mut out = pick(
        r,
        &[
            "status", "target", "skill_id", "script", "error", "revision",
        ],
    );
    out["run_id"] = r["id"].clone();
    out["input_count"] = json!(r["files"].as_array().map_or(0, Vec::len));
    out["changes"] = page(
        r["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| json!({"path":c["path"],"id":c["id"],"deleted":c["deleted"]==true}))
            .collect(),
        a,
        20,
    );
    match a["view"].as_str().unwrap_or("summary") {
        "stdout" | "stderr" => {
            let view = a["view"].as_str().unwrap();
            out["log"] = text(r[view].as_str().unwrap_or(""), a);
        }
        "diff" => {
            let path = a["path"].as_str().context("diff requires path")?;
            let change = r["changes"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|c| c["path"] == path)
                .context("Changed file not found")?;
            out["path"] = json!(path);
            out["before"] = text(change["before"].as_str().unwrap_or(""), a);
            out["after"] = text(change["text"].as_str().unwrap_or(""), a);
            out["binary"] = json!(change["text"].is_null() && change["deleted"] != true);
        }
        _ => {}
    }
    Ok(out)
}
pub fn local_paper(app: &App, p: &Value, detail: bool) -> Result<Value> {
    let mut out = pick(
        p,
        &[
            "title", "year", "creators", "arxiv", "has_pdf", "revision", "venue",
        ],
    );
    out["paper_key"] = p["key"].clone();
    out["paper_id"] = p["s2"].clone();
    out["doi"] = p["DOI"].clone();
    out["direct_collections"] = json!(app
        .library
        .memberships(p["key"].as_str().context("Paper key missing")?)?);
    if detail {
        out["abstract"] = p["abstractNote"].clone();
        out["cite_keys"] = p["cite_keys"].clone();
        out["url"] = p["url"].clone();
    }
    Ok(out)
}
pub fn library(app: &App, a: &Value) -> Result<Value> {
    let target = a["folder_id"].as_str().unwrap_or("L1");
    let include = a["include_subfolders"]
        .as_bool()
        .unwrap_or_else(|| app.settings.lock().unwrap().library.include_subfolders);
    let query = a["query"].as_str().unwrap_or("").trim().to_lowercase();
    let items = app.library.items_scoped(target, include)?;
    let mut out = Vec::new();
    for p in items {
        let mut fields: Vec<_> = [
            "title",
            "DOI",
            "arxiv",
            "s2",
            "key",
            "venue",
            "abstractNote",
        ]
        .iter()
        .filter_map(|field| p[*field].as_str())
        .collect();
        fields.extend(
            p["creators"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        );
        fields.extend(
            p["cite_keys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        );
        if !query.is_empty() && !fields.join(" ").to_lowercase().contains(&query) {
            continue;
        }
        if a["has_pdf"].as_bool().is_some_and(|v| p["has_pdf"] != v) {
            continue;
        }
        out.push(local_paper(app, &p, false)?);
    }
    let mut result = page(out, a, 25);
    result["folder_id"] = json!(target);
    result["include_subfolders"] = json!(include);
    Ok(result)
}
pub fn notes(app: &App, a: &Value) -> Result<Value> {
    let targets = if let Some(t) = a["folder_id"].as_str() {
        vec![t.to_owned()]
    } else {
        app.library.collections()?["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["id"].as_str().map(str::to_owned))
            .collect()
    };
    let query = a["query"].as_str().unwrap_or("").trim().to_lowercase();
    let mut out = Vec::new();
    for target in targets {
        let folder = app.library.folder_id(&target)?;
        let m = crate::workspace::snapshot(app, &target)?;
        for n in app.notes.list(&folder)?.as_array().unwrap() {
            let Some(id) = n["id"].as_str() else { continue };
            let Some(entry) = m["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["note"] == id)
            else {
                continue;
            };
            if entry["deleted"] == true && a["include_trashed"] != true {
                continue;
            }
            let doc = app.notes.get(&folder, id)?.context("Note disappeared")?;
            let body = doc["blocks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| b["src"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let searchable = format!("{} {} {}", n["title"], entry["name"], body).to_lowercase();
            if !query.is_empty() && !searchable.contains(&query) {
                continue;
            }
            let excerpt = if query.is_empty() {
                String::new()
            } else {
                excerpt(&body, &query, 240).1
            };
            out.push(json!({"note_id":id,"entry_id":entry["id"],"folder_id":target,"title":n["title"],"display_name":if entry["renamed"]==true{entry["name"].clone()}else{n["title"].clone()},"updated":n["updated"],"trashed":entry["deleted"]==true,"excerpt":excerpt}));
        }
    }
    out.sort_by(|a, b| {
        b["updated"]
            .as_u64()
            .cmp(&a["updated"].as_u64())
            .then(a["note_id"].as_str().cmp(&b["note_id"].as_str()))
    });
    Ok(page(out, a, 25))
}
pub fn read_note(app: &App, a: &Value) -> Result<Value> {
    let target = a["folder_id"].as_str().context("Folder required")?;
    let id = a["note_id"].as_str().context("Note required")?;
    let (doc, entry) = crate::mcp_edits::note_state(app, target, id)?;
    if a["view"] == "preamble" {
        let mut out = text(doc["preamble"].as_str().unwrap_or(""), a);
        out["note_id"] = json!(id);
        out["folder_id"] = json!(target);
        out["updated"] = doc["updated"].clone();
        out["trashed"] = json!(entry["deleted"] == true);
        return Ok(out);
    }
    if let Some(ids) = a["block_ids"].as_array() {
        for id in ids {
            if !doc["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["id"] == *id)
            {
                bail!("Requested block not found");
            }
        }
    }
    let preamble = text(
        doc["preamble"].as_str().unwrap_or(""),
        &json!({"max_chars":4000}),
    );
    let blocks: Vec<_> = doc["blocks"]
        .as_array()
        .context("Invalid blocks")?
        .iter()
        .filter(|b| {
            a["block_ids"]
                .as_array()
                .is_none_or(|ids| ids.contains(&b["id"]))
        })
        .collect();
    let offset = number(a, "offset", 0);
    let limit = number(a, "limit", 25).min(100);
    let mut budget = number(a, "max_chars", 12000).min(40000);
    let mut result = Vec::new();
    let mut next_offset = offset;
    let mut next_char = 0;
    for (index, b) in blocks.iter().enumerate().skip(offset).take(limit) {
        let mut item = pick(b, &["id", "type"]);
        if let Some(src) = b["src"].as_str() {
            let start = if index == offset {
                number(a, "char_offset", 0)
            } else {
                0
            };
            if start > src.chars().count() {
                bail!("Character offset is outside the block");
            }
            let text: String = src.chars().skip(start).take(budget).collect();
            let end = start + text.chars().count();
            budget -= text.chars().count();
            item["src"] = json!(text);
            item["char_offset"] = json!(start);
            item["total_chars"] = json!(src.chars().count());
            result.push(item);
            if end < src.chars().count() {
                next_offset = index;
                next_char = end;
                break;
            }
        } else {
            item["drawing"] = json!(true);
            result.push(item);
        }
        next_offset = index + 1;
        if budget == 0 {
            break;
        }
    }
    let more = next_offset < blocks.len();
    Ok(
        json!({"note_id":id,"folder_id":target,"title":doc["title"],"preamble":preamble["text"],"preamble_range":range_metadata(&preamble),"updated":doc["updated"],"trashed":entry["deleted"]==true,"blocks":result,"total_blocks":blocks.len(),"has_more":more,"next_offset":if more{Some(next_offset)}else{None},"next_char_offset":if more{Some(next_char)}else{None}}),
    )
}
pub fn workspace(app: &App, a: &Value) -> Result<Value> {
    let target = a["folder_id"].as_str().context("Folder required")?;
    let m = crate::workspace::snapshot(app, target)?;
    let query = a["query"].as_str().unwrap_or("").trim().to_lowercase();
    let entries: Vec<_> = m["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| {
            (a["include_trashed"] == true || e["deleted"] != true)
                && (query.is_empty()
                    || e["name"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query))
        })
        .map(|e| {
            let mut out = pick(
                e,
                &["id", "name", "parent", "kind", "size", "deleted", "legacy"],
            );
            if e.get("note").is_some() {
                out["note_id"] = e["note"].clone();
            }
            let mut parts = vec![e["name"].as_str().unwrap_or("")];
            let mut parent = e["parent"].as_str().unwrap_or("");
            let mut seen = std::collections::HashSet::new();
            while !parent.is_empty() && seen.insert(parent) {
                let Some(p) = m["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["id"] == parent)
                else {
                    break;
                };
                parts.push(p["name"].as_str().unwrap_or(""));
                parent = p["parent"].as_str().unwrap_or("");
            }
            parts.reverse();
            out["path"] = json!(parts.join("/"));
            out
        })
        .collect();
    let mut out = page(entries, a, 50);
    out["folder_id"] = json!(target);
    out["revision"] = m["revision"].clone();
    out["bibliographies"] = m["bibliographies"].clone();
    out["skills"] = m["skills"].clone();
    match crate::bibliography::index(app, target, &m) {
        Ok(index) => {
            out["citation_count"] = json!(index.len());
            if a["include_bibliography"] == true {
                out["citations"] = page(
                    index
                        .iter()
                        .map(|e| {
                            pick(
                                e,
                                &[
                                    "key",
                                    "title",
                                    "creators",
                                    "year",
                                    "doi",
                                    "file_id",
                                    "library_key",
                                ],
                            )
                        })
                        .collect(),
                    a,
                    50,
                );
            }
        }
        Err(e) => out["bib_error"] = json!(e.to_string()),
    }
    Ok(out)
}
