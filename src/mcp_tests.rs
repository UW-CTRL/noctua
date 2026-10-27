// Included in agent::tests to share the isolated app/router fixture.
#[tokio::test]
async fn zotero_pdf_storage_preference_defaults_to_link_and_persists()->Result<()> {
    let f=Fixture::new()?;
    assert_eq!(f.json("/api/settings",None).await["zotero_pdf_mode"],"link");
    let saved=f.json("/api/settings/zotero-pdf",Some(json!({"pdf_mode":"copy"}))).await;
    assert_eq!(saved["zotero_pdf_mode"],"copy");
    assert_eq!(crate::settings::Settings::load(&f.root).zotero_pdf_mode,crate::zotero::PdfMode::Copy);
    assert_eq!(f.request("/api/settings/zotero-pdf",Some(json!({"pdf_mode":"invalid"})),None).await.status(),StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(f.json("/api/settings",None).await["zotero_pdf_mode"],"copy");
    let source=f.root.join("configured-zotero");std::fs::create_dir_all(&source)?;
    let db=rusqlite::Connection::open(source.join("zotero.sqlite"))?;
    db.execute_batch("CREATE TABLE collections(collectionID INTEGER); INSERT INTO collections VALUES(1);")?;drop(db);
    f.json("/api/settings/zotero",Some(json!({"dir":source}))).await;
    let settings=f.json("/api/settings",None).await;
    assert_eq!(settings["zotero_dir"],source.to_string_lossy().as_ref());assert_eq!(settings["zotero_pdf_mode"],"copy");
    f.json("/api/settings/zotero-pdf",Some(json!({"pdf_mode":"link"}))).await;
    assert_eq!(crate::settings::Settings::load(&f.root).zotero_pdf_mode,crate::zotero::PdfMode::Link);
    Ok(())
}

async fn mcp_value(f: &Fixture, name: &str, args: Value, mode: &str) -> Value {
    let r=crate::mcp::handle(&f.app,&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}),mode,None).await.unwrap();
    let mut v: Value =
        serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    if r["result"]["isError"] == true {
        v["isError"] = json!(true);
    }
    v
}
#[tokio::test]
async fn mcp_note_edits_persist_atomically_check_versions_and_can_be_undone() -> Result<()> {
    let f = Fixture::new()?;
    let mut doc = f.app.notes.create("L1", "Before")?;
    let id = doc["id"].as_str().unwrap().to_owned();
    doc["blocks"] = json!([{"id":"a","type":"text","src":"original"},{"id":"ink","type":"ink","strokes":[{"p":[[1,2,1]],"w":2,"c":"#000000"}]}]);
    doc["updated"] = json!(f.app.notes.save("L1", &id, doc.clone())?);
    let base = json!({"folder_id":"L1","note_id":id,"updated":doc["updated"],"edits":[{"op":"replace","latex":"invalid"}]});
    assert_eq!(
        mcp_value(&f, "edit_note", base, "direct").await["isError"],
        true
    );
    let invalid = json!({"folder_id":"L1","note_id":id,"updated":doc["updated"],"edits":[{"op":"replace","block_id":"a","latex":"partial"},{"op":"delete","block_id":"missing"}]});
    assert_eq!(
        mcp_value(&f, "edit_note", invalid, "direct").await["isError"],
        true
    );
    assert_eq!(
        f.app.notes.get("L1", &id)?.unwrap()["blocks"][0]["src"],
        "original"
    );
    let args = json!({"folder_id":"L1","note_id":id,"updated":doc["updated"],"title":"After","preamble":"\\newcommand{\\R}{\\mathbb R}","request_id":"note-edit","edits":[{"op":"replace","block_id":"ink","latex":"transcription"},{"op":"move","block_id":"a","after_block_id":"ink"}]});
    let result = mcp_value(&f, "edit_note", args.clone(), "direct").await;
    assert_eq!(result["status"], "applied");
    let stored = f.app.notes.get("L1", &id)?.unwrap();
    assert_eq!(stored["title"], "After");
    assert_eq!(stored["blocks"][0]["id"], "ink");
    assert_eq!(stored["blocks"][1]["id"], "a");
    assert_eq!(stored["blocks"][2]["src"], "transcription");
    assert!(result["updated"].as_u64() > doc["updated"].as_u64());
    assert_eq!(
        mcp_value(&f, "edit_note", args.clone(), "direct").await,
        result
    );
    let mut changed = args.clone();
    changed["title"] = json!("Different");
    assert_eq!(
        mcp_value(&f, "edit_note", changed, "direct").await["isError"],
        true
    );
    let mut stale = args;
    stale.as_object_mut().unwrap().remove("request_id");
    assert_eq!(
        mcp_value(&f, "edit_note", stale, "direct").await["code"],
        "CONFLICT"
    );
    let undone = f
        .app
        .notes
        .history("L1", &id, Some(false), stored["updated"].as_u64())?;
    assert_eq!(undone["doc"]["title"], "Before");
    assert_eq!(undone["doc"]["blocks"], doc["blocks"]);
    Ok(())
}
#[tokio::test]
async fn mcp_proposals_are_reviewable_and_trash_is_consistent() -> Result<()> {
    let f = Fixture::new()?;
    let doc = f.app.notes.create("L1", "Review")?;
    let id = doc["id"].as_str().unwrap();
    let args = json!({"folder_id":"L1","note_id":id,"updated":doc["updated"],"title":"Accepted"});
    let p = mcp_value(&f, "edit_note", args, "suggest").await;
    assert_eq!(p["status"], "proposed");
    assert_eq!(f.app.notes.get("L1", id)?.unwrap()["title"], "Review");
    let pid = p["proposal_id"].as_str().unwrap();
    assert!(f
        .json("/api/agent-edits", None)
        .await
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["proposal_id"] == pid));
    let result = f
        .json(
            &format!("/api/agent-edits/{pid}"),
            Some(json!({"action":"accept"})),
        )
        .await;
    assert_eq!(result["status"], "applied");
    assert_eq!(f.app.notes.get("L1", id)?.unwrap()["title"], "Accepted");
    assert_eq!(
        f.json(
            &format!("/api/agent-edits/{pid}"),
            Some(json!({"action":"accept"}))
        )
        .await,
        result
    );
    let current = f.app.notes.get("L1", id)?.unwrap();
    let pending=mcp_value(&f,"edit_note",json!({"folder_id":"L1","note_id":id,"updated":current["updated"],"title":"Stale proposal"}),"suggest").await;
    let mut newer = current.clone();
    newer["title"] = json!("Human edit");
    f.app.notes.save("L1", id, newer)?;
    assert_eq!(
        f.request(
            &format!(
                "/api/agent-edits/{}",
                pending["proposal_id"].as_str().unwrap()
            ),
            Some(json!({"action":"accept"})),
            None
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let m = crate::workspace::list(&f.app, "L1")?;
    let entry = m["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["note"] == id)
        .unwrap();
    crate::workspace::change(
        &f.app,
        "L1",
        &json!({"revision":m["revision"],"op":"delete","id":entry["id"]}),
        None,
    )?;
    assert_eq!(
        mcp_value(&f, "list_notes", json!({}), "plan").await["total"],
        0
    );
    assert!(f
        .json("/api/notes?target=L1", None)
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert!(f
        .json("/api/notes/all", None)
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        mcp_value(&f, "list_notes", json!({"include_trashed":true}), "plan").await["items"][0]
            ["trashed"],
        true
    );
    assert_eq!(
        mcp_value(
            &f,
            "read_note",
            json!({"folder_id":"L1","note_id":id}),
            "plan"
        )
        .await["trashed"],
        true
    );
    assert_eq!(
        mcp_value(
            &f,
            "edit_note",
            json!({"folder_id":"L1","note_id":id,"updated":current["updated"],"title":"No"}),
            "direct"
        )
        .await["isError"],
        true
    );
    Ok(())
}
#[tokio::test]
async fn mcp_organizes_native_papers_without_remote_lookup() -> Result<()> {
    let f = Fixture::new()?;
    let parent = f.app.library.create_collection("L1", "Parent")?;
    let child = f.app.library.create_collection(&parent, "Child")?;
    let other = f.app.library.create_collection("L1", "Other")?;
    let key = f.app.library.save(
        &json!({"title":"Native quantum paper","DOI":"10.test/native"}),
        &child,
    )?;
    assert_eq!(
        mcp_value(&f, "search_library", json!({"query":"itemType"}), "plan").await["total"],
        0
    );
    let local = mcp_value(&f, "get_paper", json!({"paper_key":key}), "plan").await;
    assert_eq!(local["direct_collections"], json!([child]));
    assert_eq!(
        mcp_value(
            &f,
            "search_library",
            json!({"folder_id":parent,"query":"quantum","include_subfolders":false}),
            "plan"
        )
        .await["total"],
        0
    );
    assert_eq!(
        mcp_value(
            &f,
            "search_library",
            json!({"folder_id":parent,"query":"quantum","include_subfolders":true}),
            "plan"
        )
        .await["items"][0]["paper_key"],
        key
    );
    let result = mcp_value(
        &f,
        "update_paper_memberships",
        json!({"paper_keys":[key,"missing"],"add":[other],"remove":[child]}),
        "direct",
    )
    .await;
    assert_eq!(result["status"], "partial_failure");
    assert_eq!(result["failed_count"], 1);
    assert_eq!(f.app.library.memberships(&key)?, vec![other.clone()]);
    assert_eq!(f.app.library.items("L1")?.len(), 1);
    let invalid = mcp_value(
        &f,
        "update_paper_memberships",
        json!({"paper_keys":[key],"add":[child,"missing"],"remove":[other]}),
        "direct",
    )
    .await;
    assert_eq!(invalid["failed_count"], 1);
    assert_eq!(f.app.library.memberships(&key)?, vec![other]);
    assert_eq!(f.app.s2.stats().1, 0);
    Ok(())
}
#[tokio::test]
async fn mcp_creation_retries_and_compact_file_mutations() -> Result<()> {
    let f = Fixture::new()?;
    let collection = mcp_value(
        &f,
        "edit_collection",
        json!({"op":"create","parent":"L1","name":"Project","request_id":"collection"}),
        "direct",
    )
    .await;
    let target = collection["collection_id"].as_str().unwrap();
    let m = mcp_value(
        &f,
        "list_project_files",
        json!({"folder_id":target}),
        "plan",
    )
    .await;
    let folder = mcp_value(
        &f,
        "edit_project_file",
        json!({"folder_id":target,"revision":m["revision"],"op":"folder","name":"Notes"}),
        "direct",
    )
    .await;
    let parent = folder["entries"][0]["id"].as_str().unwrap();
    let a = json!({"folder_id":target,"revision":folder["revision"],"title":"Created","parent":parent,"latex":"$x^2$","request_id":"new-note"});
    let created = mcp_value(&f, "create_note", a.clone(), "direct").await;
    assert_eq!(created["status"], "applied");
    assert_eq!(mcp_value(&f, "create_note", a, "direct").await, created);
    assert_eq!(
        f.app
            .notes
            .list(&f.app.library.folder_id(target)?)?
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut m = crate::workspace::snapshot(&f.app, target)?;
    let note_entry = m["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["note"] == created["note_id"])
        .unwrap();
    assert_eq!(note_entry["parent"], parent);
    for i in 0..15 {
        let result=mcp_value(&f,"edit_project_file",json!({"folder_id":target,"revision":m["revision"],"op":"create","name":format!("{i}.md"),"text":"hello"}),"direct").await;
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
        assert!(result.to_string().len() < 800);
        m = crate::workspace::snapshot(&f.app, target)?;
    }
    let last = m["entries"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|e| e["kind"] == "file")
        .unwrap();
    let proposal=mcp_value(&f,"edit_project_file",json!({"folder_id":target,"revision":m["revision"],"op":"edit","id":last["id"],"text":"reviewed source"}),"suggest").await;
    let review = f
        .json(
            &format!(
                "/api/agent-edits/{}",
                proposal["proposal_id"].as_str().unwrap()
            ),
            None,
        )
        .await;
    assert_eq!(review["before_text"], "hello");
    assert_eq!(review["before_entry"]["id"], last["id"]);
    let list = mcp_value(
        &f,
        "list_project_files",
        json!({"folder_id":target,"limit":3}),
        "plan",
    )
    .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 3);
    assert_eq!(list["has_more"], true);
    assert!(list.get("history").is_none());
    assert!(list["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e.get("blob").is_none()));
    Ok(())
}
#[tokio::test]
async fn mcp_pdf_pagination_preserves_every_character_and_hit() -> Result<()> {
    let f = Fixture::new()?;
    let key = f
        .app
        .library
        .upload("L1", "pages.pdf", b"%PDF-1.7\nMCP pages")?;
    let hash = f.app.library.paper(&key)?["pdf_hash"].clone();
    let pages: Vec<_> = (1..=55)
        .map(|n| json!({"page":n,"text":format!("αβ {n} needle\nneedle second\n"),"words":[]}))
        .collect();
    f.app
        .library
        .save_index(&key, &json!({"version":2,"hash":hash,"pages":pages}))?;
    let (mut page, mut offset, mut reconstructed) = (1, 0, String::new());
    loop {
        let r=mcp_value(&f,"read_pdf",json!({"paper_key":key,"start_page":page,"end_page":55,"char_offset":offset,"max_chars":7}),"plan").await;
        for p in r["pages"].as_array().unwrap() {
            reconstructed.push_str(p["text"].as_str().unwrap());
        }
        if r["has_more"] == false {
            break;
        }
        page = r["next_page"].as_u64().unwrap();
        offset = r["next_char_offset"].as_u64().unwrap();
    }
    assert_eq!(
        reconstructed,
        pages
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect::<String>()
    );
    let (mut offset, mut hits) = (0, Vec::new());
    loop {
        let r = mcp_value(
            &f,
            "search_pdf",
            json!({"paper_key":key,"query":"needle","offset":offset,"limit":7}),
            "plan",
        )
        .await;
        hits.extend(r["items"].as_array().unwrap().clone());
        if r["has_more"] == false {
            break;
        }
        offset = r["next_offset"].as_u64().unwrap();
    }
    assert_eq!(hits.len(), 110);
    let unique: std::collections::HashSet<_> = hits
        .iter()
        .map(|h| (h["page"].as_u64(), h["line"].as_u64()))
        .collect();
    assert_eq!(unique.len(), 110);
    let unavailable = mcp_value(&f, "read_pdf_outline", json!({"paper_key":key}), "plan").await;
    assert_eq!(unavailable["status"], "unavailable");
    f.app.library.save_outline(
        &key,
        &json!({"hash":hash,"entries":[{"title":"Intro","page":1}]}),
    )?;
    assert_eq!(
        mcp_value(&f, "read_pdf_outline", json!({"paper_key":key}), "plan").await["items"][0]
            ["title"],
        "Intro"
    );
    Ok(())
}
#[tokio::test]
async fn mcp_skill_and_annotation_views_exclude_internal_payloads() -> Result<()> {
    let f = Fixture::new()?;
    let script = format!("# {}", "large script ".repeat(5000));
    let b64 = |s: &str| {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(s)
    };
    let imported=f.json("/api/skills",Some(json!({"files":[{"path":"SKILL.md","data":b64("# Test")},{"path":"run.py","data":b64(&script)}]}))).await;
    let skill = imported["id"].as_str().unwrap();
    crate::skills::set_context(&f.app, "chat", Some("L1"), Some(&vec![skill.into()]))?;
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_skill_run","arguments":{"folder_id":"L1","skill_id":skill,"script":"run.py","args":[],"files":[]}}});
    let r = crate::mcp::handle(&f.app, &request, "direct", Some("chat"))
        .await
        .unwrap();
    assert!(r.to_string().len() < 1500);
    let value: Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap())?;
    assert_eq!(value["status"], "approval_required");
    let mut get = request;
    get["params"] = json!({"name":"get_skill_run","arguments":{"run_id":value["run_id"]}});
    let r = crate::mcp::handle(&f.app, &get, "plan", Some("chat"))
        .await
        .unwrap();
    assert!(r.to_string().len() < 1500);
    assert!(!r.to_string().contains("script_text"));
    assert!(!f.root.join(".skill-runs").exists());
    let run = json!({"id":"run","status":"review_required","script_text":script,"root":"private","changes":[{"path":"out.png","data":"A".repeat(100000),"text":null},{"path":"out.md","text":"after".repeat(10000),"before":"before".repeat(10000),"data":"private"}],"stdout":"log".repeat(10000)});
    let summary = crate::mcp_data::skill_run(&run, &json!({}))?;
    assert!(summary.to_string().len() < 1000);
    let diff =
        crate::mcp_data::skill_run(&run, &json!({"view":"diff","path":"out.md","max_chars":50}))?;
    assert!(diff.to_string().len() < 1500);
    assert_eq!(diff["after"]["truncated"], true);
    let key = f.app.library.upload("L1", "ink.pdf", b"%PDF-1.7\nink")?;
    f.app.library.annotate(
        &key,
        &json!({"kind":"ink","page":1,"points":vec![json!([0.1,0.2]);2000],"comment":"drawing"}),
        "user",
        false,
    )?;
    let list = mcp_value(&f, "list_pdf_annotations", json!({"paper_key":key}), "plan").await;
    assert!(list.to_string().len() < 1500);
    assert!(list["items"][0].get("points").is_none());
    let geometry = mcp_value(
        &f,
        "list_pdf_annotations",
        json!({"paper_key":key,"include_geometry":true}),
        "plan",
    )
    .await;
    assert_eq!(
        geometry["items"][0]["points"].as_array().unwrap().len(),
        2000
    );
    Ok(())
}
#[tokio::test]
async fn mcp_catalog_validates_all_writes_and_rejects_hidden_arguments() -> Result<()> {
    let f = Fixture::new()?;
    let direct = f
        .json(
            "/mcp?mode=direct",
            Some(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})),
        )
        .await;
    let plan = f
        .json(
            "/mcp?mode=plan",
            Some(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})),
        )
        .await;
    for t in direct["result"]["tools"].as_array().unwrap() {
        let name = t["name"].as_str().unwrap();
        if crate::mcp::WRITE_TOOLS.contains(&name) {
            assert!(!plan["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["name"] == name));
            assert_eq!(
                mcp_value(&f, name, json!({}), "plan").await["isError"],
                true
            );
        }
    }
    for a in [
        json!({"paper_key":"x","page":1,"kind":"ink","comment":"x"}),
        json!({"paper_key":"x","page":1,"quote":"q","comment":"x","rects":[[0,0,1,1]]}),
    ] {
        assert_eq!(
            mcp_value(&f, "annotate_pdf", a, "direct").await["isError"],
            true
        );
    }
    assert_eq!(
        mcp_value(&f, "search_library", json!({"limit":0}), "plan").await["isError"],
        true
    );
    let key = f
        .app
        .library
        .upload("L1", "uncached.pdf", b"%PDF-1.7\nuncached")?;
    let r = mcp_value(&f, "read_pdf", json!({"paper_key":key}), "plan").await;
    assert_eq!(r["code"], "UI_REQUIRED");
    Ok(())
}

#[tokio::test]
async fn mcp_note_source_ranges_and_read_only_legacy_discovery() -> Result<()> {
    let f = Fixture::new()?;
    let mut note = f.app.notes.create("L1", "Unicode")?;
    let id = note["id"].as_str().unwrap().to_owned();
    let block = note["blocks"][0]["id"].clone();
    note["preamble"] = json!("\\newcommand{\\α}{β}".repeat(400));
    note["blocks"][0]["src"] = json!("αβ🌙 source".repeat(30));
    note["updated"] = json!(f.app.notes.save("L1", &id, note.clone())?);
    let (mut offset, mut chars, mut source) = (0, 0, String::new());
    loop {
        let r=mcp_value(&f,"read_note",json!({"folder_id":"L1","note_id":id,"offset":offset,"char_offset":chars,"max_chars":13}),"plan").await;
        for b in r["blocks"].as_array().unwrap() {
            source.push_str(b["src"].as_str().unwrap());
        }
        if r["has_more"] == false {
            break;
        }
        offset = r["next_offset"].as_u64().unwrap();
        chars = r["next_char_offset"].as_u64().unwrap();
    }
    assert_eq!(source, note["blocks"][0]["src"].as_str().unwrap());
    let view = mcp_value(
        &f,
        "read_note",
        json!({"folder_id":"L1","note_id":id,"block_ids":[block]}),
        "plan",
    )
    .await;
    assert_eq!(view["preamble_range"]["truncated"], true);
    let mut source = String::new();
    let mut offset = 0;
    loop {
        let r=mcp_value(&f,"read_note",json!({"folder_id":"L1","note_id":id,"view":"preamble","char_offset":offset,"max_chars":1000}),"plan").await;
        source.push_str(r["text"].as_str().unwrap());
        if r["truncated"] == false {
            break;
        }
        offset = r["next_char_offset"].as_u64().unwrap();
    }
    assert_eq!(source, note["preamble"].as_str().unwrap());
    f.app
        .notes
        .save_image("L1", "legacy", b"\x89PNG\r\n\x1a\nfixture")?;
    let first = mcp_value(&f, "list_project_files", json!({"folder_id":"L1"}), "plan").await;
    let second = mcp_value(&f, "list_project_files", json!({"folder_id":"L1"}), "plan").await;
    assert_eq!(first, second);
    assert_eq!(first["revision"], 0);
    assert!(!f
        .app
        .notes
        .root
        .join("L1/.workspace/manifest.json")
        .exists());
    let entry = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["note_id"] == id)
        .unwrap();
    let moved = mcp_value(
        &f,
        "edit_project_file",
        json!({"folder_id":"L1","revision":0,"op":"rename","id":entry["id"],"name":"Tree label"}),
        "direct",
    )
    .await;
    assert_eq!(moved["status"], "applied");
    assert_eq!(f.app.notes.get("L1", &id)?.unwrap()["title"], "Unicode");
    Ok(())
}
#[tokio::test]
async fn mcp_remote_queries_are_paged_and_display_requests_are_honest() -> Result<()> {
    let f = Fixture::new()?;
    let paper = |n: usize| json!({"paperId":format!("remote-{n}"),"title":format!("Remote {n}"),"authors":[{"name":"Author"}],"abstract":"abstract ".repeat(1000),"externalIds":{"DOI":format!("10.test/{n}")}});
    f.app.s2.cache().put("paper:remote-0", &paper(0));
    for offset in [0, 7, 14, 21, 28] {
        let data: Vec<_> = (offset..30).map(paper).collect();
        f.app.s2.cache().put(
            &format!("search:{offset}:query"),
            &json!({"total":30,"data":data}),
        );
    }
    let mut ids = Vec::new();
    let mut offset = 0;
    loop {
        let r = mcp_value(
            &f,
            "search_papers",
            json!({"query":"query","offset":offset,"limit":7}),
            "plan",
        )
        .await;
        ids.extend(
            r["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["paperId"].as_str().unwrap().to_owned()),
        );
        if r["has_more"] == false {
            break;
        }
        offset = r["next_offset"].as_u64().unwrap();
    }
    assert_eq!(ids.len(), 30);
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        30
    );
    let detail = mcp_value(
        &f,
        "get_paper",
        json!({"paper_id":"remote-0","max_chars":50}),
        "plan",
    )
    .await;
    assert_eq!(detail["abstract_range"]["truncated"], true);
    assert!(detail.to_string().len() < 1000);
    f.app.s2.cache().put(
        "references:remote-0",
        &json!({"data":[{"citedPaper":paper(1)}]}),
    );
    let relation = mcp_value(
        &f,
        "get_paper_relations",
        json!({"paper_id":"remote-0","relation":"references"}),
        "plan",
    )
    .await;
    assert_eq!(relation["items"][0]["paperId"], "remote-1");
    assert_eq!(relation["exhaustive"], false);
    assert_eq!(
        mcp_value(&f, "show_graph", json!({"paper_id":"remote-0"}), "plan").await["status"],
        "ui_requested"
    );
    let saved = mcp_value(
        &f,
        "save_to_library",
        json!({"paper_id":"remote-0","folder_id":"L1","download_pdf":false}),
        "direct",
    )
    .await;
    assert_eq!(saved["paper_status"], "created");
    assert_eq!(saved["pdf_status"], "not_requested");
    assert!(saved.get("paper").is_none());
    let again = mcp_value(
        &f,
        "save_to_library",
        json!({"paper_id":"remote-0","folder_id":"L1","download_pdf":false}),
        "direct",
    )
    .await;
    assert_eq!(again["paper_status"], "existing");
    assert_eq!(again["membership"]["status"], "already_present");
    assert_eq!(f.app.s2.stats().1, 0);
    Ok(())
}
#[tokio::test]
async fn mcp_drawing_previews_are_versioned_and_require_a_renderer_only_when_uncached() -> Result<()>
{
    let f = Fixture::new()?;
    let mut note = f.app.notes.create("L1", "Drawing")?;
    let id = note["id"].as_str().unwrap().to_owned();
    note["blocks"] =
        json!([{"id":"ink","type":"ink","strokes":[{"p":[[1,2,1]],"w":2,"c":"#000000"}]}]);
    let updated = f.app.notes.save("L1", &id, note.clone())?;
    let args = json!({"folder_id":"L1","note_id":id,"block_id":"ink"});
    assert!(crate::reader::drawing_for_agent(&f.app, &args, None)
        .await
        .unwrap_err()
        .to_string()
        .contains("UI_REQUIRED"));
    let png = b"\x89PNG\r\n\x1a\nfixture";
    let req = Request::builder()
        .uri(format!("/api/note-drawings/L1/{id}/ink/{updated}"))
        .method("POST")
        .header("host", "127.0.0.1:7878")
        .body(Body::from(png.to_vec()))?;
    assert_eq!(
        f.router.clone().oneshot(req).await?.status(),
        StatusCode::OK
    );
    let content = crate::reader::drawing_for_agent(&f.app, &args, None).await?;
    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["mimeType"], "image/png");
    let mut changed = f.app.notes.get("L1", &id)?.unwrap();
    changed["title"] = json!("New version");
    f.app.notes.save("L1", &id, changed)?;
    assert!(crate::reader::drawing_for_agent(&f.app, &args, None)
        .await
        .unwrap_err()
        .to_string()
        .contains("UI_REQUIRED"));
    Ok(())
}

#[tokio::test]
async fn mcp_new_note_undo_preserves_existing_legacy_notes_and_invalid_proposals_fail_early(
) -> Result<()> {
    let f = Fixture::new()?;
    let old = f.app.notes.create("L1", "Existing")?;
    let created = mcp_value(
        &f,
        "create_note",
        json!({"folder_id":"L1","revision":0,"title":"New"}),
        "direct",
    )
    .await;
    assert_eq!(created["status"], "applied");
    let undone = crate::workspace::history(
        &f.app,
        "L1",
        &json!({"revision":created["revision"],"redo":false}),
    )?;
    assert_eq!(
        undone["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["note"] == old["id"])
            .unwrap()["deleted"],
        false
    );
    assert_eq!(
        undone["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["note"] == created["note_id"])
            .unwrap()["deleted"],
        true
    );
    let folder = mcp_value(
        &f,
        "edit_project_file",
        json!({"folder_id":"L1","revision":undone["revision"],"op":"folder","name":"Parent"}),
        "direct",
    )
    .await;
    let id = folder["entries"][0]["id"].clone();
    let bad = mcp_value(
        &f,
        "edit_project_file",
        json!({"folder_id":"L1","revision":folder["revision"],"op":"move","id":id,"parent":id}),
        "suggest",
    )
    .await;
    assert_eq!(bad["isError"], true);
    assert!(f
        .json("/api/agent-edits", None)
        .await
        .as_array()
        .unwrap()
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn removed_zotero_aliases_do_not_resolve_to_native_library_actions() -> Result<()> {
    let f = Fixture::new()?;
    for name in ["add_to_zotero", "list_zotero_folders"] {
        let result = mcp_value(&f, name, json!({}), "direct").await;
        assert_eq!(result["isError"], true);
        assert!(result["message"].as_str().unwrap().contains("Unknown tool"));
    }
    for (path, method) in [
        ("collections", "GET"),
        ("items", "GET"),
        ("check", "POST"),
        ("add", "POST"),
        ("rename", "POST"),
        ("folder", "POST"),
    ] {
        let body = if method == "POST" {
            Some(json!({}))
        } else {
            None
        };
        assert_eq!(
            f.request(&format!("/api/zotero/{path}"), body, Some(method))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        f.request("/api/library/collections", None, None)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        f.request("/api/library/items?target=L1", None, None)
            .await
            .status(),
        StatusCode::OK
    );
    assert!(f
        .json(
            "/api/library/folder",
            Some(json!({"parent":"L1","name":"Current API"}))
        )
        .await["id"]
        .is_string());
    Ok(())
}

#[tokio::test]
async fn annotation_reply_views_share_bounded_text_and_geometry_options() -> Result<()> {
    let f = Fixture::new()?;
    let key = f
        .app
        .library
        .upload("L1", "reply.pdf", b"%PDF-1.7\nreply views")?;
    let annotation = f.app.library.annotate(
        &key,
        &json!({"kind":"ink","page":1,"points":[[0.1,0.2],[0.3,0.4]],"comment":"abcdefgh"}),
        "user",
        false,
    )?;
    let id = annotation["id"].as_str().unwrap();
    for _ in 0..12 {
        f.app.library.reply(&key, id, "αβγδεζηθ", "user", false)?;
    }
    let result=mcp_value(&f,"list_pdf_annotations",json!({"paper_key":key,"annotation_id":id,"include_replies":true,"reply_offset":10,"char_offset":2,"max_chars":3}),"plan").await;
    let item = &result["items"][0];
    assert_eq!(item["comment"], "cde");
    assert_eq!(item["comment_range"]["next_char_offset"], 5);
    assert!(item.get("points").is_none());
    assert_eq!(item["replies"]["total"], 12);
    assert_eq!(item["replies"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(item["replies"]["items"][0]["comment"], "γδε");
    assert_eq!(
        item["replies"]["items"][0]["comment_range"]["next_char_offset"],
        5
    );
    assert!(item["replies"]["items"][0]["comment_range"]
        .get("text")
        .is_none());
    Ok(())
}
