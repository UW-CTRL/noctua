//! Transactional Library management. Trash keeps stable paper, annotation and folder IDs.
use super::*;
use axum::{extract::State, Json};
use crate::{ApiResult, Shared};

fn strings(v:&Value)->Result<Vec<String>> {
    let values=v.as_array().context("Choose at least one item")?;
    if values.is_empty()||values.len()>1000{return Err(bad("Choose 1–1000 items"));}
    let mut out=Vec::new();
    for value in values {let s=value.as_str().context("Invalid item ID")?.to_string();if !out.contains(&s){out.push(s);}}
    Ok(out)
}
fn active_folder(c:&Connection,id:&str)->Result<()> {
    if !c.query_row("SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1 AND id NOT IN (SELECT id FROM library_trash WHERE kind='collection'))",[id],|r|r.get::<_,bool>(0))?{return Err(missing());}Ok(())
}
fn active_paper(c:&Connection,key:&str)->Result<(Value,Option<String>,i64)> {
    let row:Option<(String,Option<String>,i64)>=c.query_row("SELECT data,pdf_hash,revision FROM papers WHERE key=?1 AND key NOT IN (SELECT id FROM library_trash WHERE kind='paper')",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (s,h,r)=row.ok_or_else(missing)?;Ok((serde_json::from_str(&s)?,h,r))
}
fn subtree(c:&Connection,id:&str)->Result<Vec<String>> {
    let mut stmt=c.prepare("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT c.id FROM collections c JOIN tree t ON c.parent=t.id) SELECT id FROM tree")?;
    let rows=stmt.query_map([id],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;Ok(rows)
}
fn restore(c:&Connection,kind:&str,ids:&[String])->Result<()> {
    for id in ids {
        if !c.query_row("SELECT EXISTS(SELECT 1 FROM library_trash WHERE kind=?1 AND id=?2)",params![kind,id],|r|r.get::<_,bool>(0))?{return Err(missing());}
        let merged:Option<Option<String>>=c.query_row("SELECT merged_into FROM library_trash WHERE kind=?1 AND id=?2",params![kind,id],|r|r.get(0)).optional()?;
        if merged.flatten().is_some(){return Err(bad("Merged source papers cannot be restored separately; their annotations now belong to the retained paper."));}
        if kind=="collection" {
            let parent:Option<String>=c.query_row("SELECT parent FROM collections WHERE id=?1",[id],|r|r.get(0)).optional()?.flatten();
            if let Some(parent)=parent {if !ids.contains(&parent)&&active_folder(c,&parent).is_err(){c.execute("UPDATE collections SET parent='L1' WHERE id=?1",[id])?;}}
        }
        c.execute("DELETE FROM library_trash WHERE kind=?1 AND id=?2",params![kind,id])?;
    }Ok(())
}
impl Library {
    pub fn management_state(&self)->Result<Value> {
        let c=self.conn.lock().unwrap();
        let revision:i64=c.query_row("SELECT revision FROM library_state WHERE id=1",[],|r|r.get(0))?;
        let mut stmt=c.prepare("SELECT t.kind,t.id,t.batch,t.deleted,t.merged_into,CASE WHEN t.kind='paper' THEN (SELECT data FROM papers WHERE key=t.id) ELSE (SELECT json_object('name',name,'parent',parent) FROM collections WHERE id=t.id) END FROM library_trash t ORDER BY t.deleted DESC,t.id")?;
        let trash=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?)))?.map(|r|{let(k,id,b,d,m,s)=r?;Ok(json!({"kind":k,"id":id,"batch":b,"deleted":d,"merged_into":m,"data":serde_json::from_str::<Value>(&s)?}))}).collect::<Result<Vec<_>>>()?;
        let undo:Option<String>=c.query_row("SELECT id FROM library_undo WHERE undone=0 ORDER BY rowid DESC LIMIT 1",[],|r|r.get(0)).optional()?;
        Ok(json!({"revision":revision,"trash":trash,"undo":undo}))
    }
    pub fn cleanup_purged_folders(&self,notes_root:&Path)->Vec<String>{
        let result=(||->Result<Vec<String>>{let c=self.conn.lock().unwrap();let mut stmt=c.prepare("SELECT folder FROM library_cleanup")?;let rows=stmt.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;Ok(rows)})();
        let folders=match result{Ok(v)=>v,Err(e)=>return vec![e.to_string()]};let mut warnings=Vec::new();
        for folder in folders{
            if folder.is_empty()||Path::new(&folder).components().count()!=1||!matches!(Path::new(&folder).components().next(),Some(std::path::Component::Normal(_))){warnings.push("Invalid project storage path; cleanup skipped".into());continue;}
            let path=notes_root.join(&folder);let result=match std::fs::symlink_metadata(&path){Ok(m)if m.file_type().is_symlink()=>std::fs::remove_file(&path),Ok(_)=>std::fs::remove_dir_all(&path),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(e)=>Err(e)};
            match result{Ok(())=>{if let Err(e)=self.conn.lock().unwrap().execute("DELETE FROM library_cleanup WHERE folder=?1",[folder]){warnings.push(e.to_string());}},Err(e)=>warnings.push(format!("Project files could not be removed: {e}"))}
        }warnings
    }
    pub fn manage(&self,b:&Value)->Result<Value> {
        let _gate=self.edit_gate.lock().unwrap();let mut c=self.conn.lock().unwrap();let tx=c.transaction()?;
        let rev:i64=tx.query_row("SELECT revision FROM library_state WHERE id=1",[],|r|r.get(0))?;
        if b["revision"].as_i64()!=Some(rev){return Err(conflict("Library changed. Refresh the management view and try again."));}
        let op=text(b,"op");let batch=id("undo-");let mut undo=None;
        match op {
            "trash"|"membership"|"tags"=>{
                let chosen=b["papers"].as_array().filter(|a|!a.is_empty()&&a.len()<=1000).context("Choose 1–1000 papers")?;
                let mut keys=Vec::new();
                for item in chosen {let key=text(item,"key");let(p,_,r)=active_paper(&tx,key)?;if item["revision"].as_i64()!=Some(r){return Err(conflict("A selected paper changed. Refresh before trying again."));}keys.push((key.to_string(),p));}
                if op=="trash" {
                    let ids:Vec<_>=keys.iter().map(|(k,_)|k.clone()).collect();
                    for key in &ids{tx.execute("INSERT INTO library_trash(kind,id,batch,deleted) VALUES('paper',?1,?2,?3)",params![key,batch,now()])?;}
                    undo=Some(json!({"kind":"paper","ids":ids}));
                } else if op=="membership" {
                    let dest=text(b,"target");active_folder(&tx,dest)?;
                    let mode=text(b,"mode");
                    if !["add","remove","move"].contains(&mode){return Err(bad("Invalid membership action"));}
                    if mode=="remove"&&dest=="L1"{return Err(bad("Library always contains every paper. Use Move to trash to delete."));}
                    for(key,_)in &keys {
                        if mode!="remove"{tx.execute("INSERT OR IGNORE INTO memberships VALUES(?1,?2)",params![dest,key])?;}
                        if mode=="remove"{tx.execute("DELETE FROM memberships WHERE collection=?1 AND paper=?2",params![dest,key])?;}
                        // Older clients may send move; collections are links, so retain the source.
                    }
                } else {
                    let tags=strings(&b["tags"])?;
                    if tags.iter().any(|t|t.trim().is_empty()||t.len()>200)||tags.len()>100{return Err(bad("Use at most 100 tags of 1–200 bytes"));}
                    if !["add","remove"].contains(&text(b,"mode")){return Err(bad("Invalid tag action"));}
                    for(key,mut p)in keys {
                        let mut current=p["tags"].as_array().cloned().unwrap_or_default();
                        for tag in &tags{let tag=json!(tag.trim());if text(b,"mode")=="remove"{current.retain(|t|*t!=tag);}else if !current.contains(&tag){current.push(tag);}}
                        p["tags"]=json!(current);tx.execute("UPDATE papers SET data=?1,revision=revision+1 WHERE key=?2",params![p.to_string(),key])?;
                    }
                }
            }
            "folder_move"=>{
                let target=text(b,"target");let parent=text(b,"parent");active_folder(&tx,target)?;active_folder(&tx,parent)?;
                if target=="L1"||subtree(&tx,target)?.iter().any(|id|id==parent){return Err(bad("A folder cannot move into itself or its descendants"));}
                let position=text(b,"position");let anchor=text(b,"anchor");
                let mut ordered=None;
                if !position.is_empty(){
                    if !["before","after"].contains(&position)||anchor==target{return Err(bad("Choose a different folder and a valid drop position"));}
                    active_folder(&tx,anchor)?;
                    let anchor_parent:Option<String>=tx.query_row("SELECT parent FROM collections WHERE id=?1",[anchor],|r|r.get(0))?;
                    if anchor_parent.as_deref()!=Some(parent){return Err(conflict("The drop destination moved. Refresh and try again."));}
                    let mut stmt=tx.prepare("SELECT id FROM collections WHERE parent=?1 AND id<>?2 AND id NOT IN (SELECT id FROM library_trash WHERE kind='collection') ORDER BY COALESCE((SELECT position FROM collection_order WHERE collection_order.id=collections.id),2147483647),name COLLATE NOCASE")?;
                    let mut ids:Vec<String>=stmt.query_map(params![parent,target],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;
                    let at=ids.iter().position(|id|id==anchor).context("Drop destination not found")?+usize::from(position=="after");
                    ids.insert(at,target.to_string());ordered=Some(ids);
                }
                tx.execute("UPDATE collections SET parent=?1 WHERE id=?2",params![parent,target])?;
                tx.execute("DELETE FROM collection_order WHERE id=?1",[target])?;
                if let Some(ids)=ordered{for(i,id)in ids.iter().enumerate(){tx.execute("INSERT OR REPLACE INTO collection_order VALUES(?1,?2)",params![id,i as i64])?;}}

            }
            "folder_order"=>{
                let parent=text(b,"parent");active_folder(&tx,parent)?;let ids=strings(&b["ids"])?;
                let existing:HashSet<String>={let mut stmt=tx.prepare("SELECT id FROM collections WHERE parent=?1 AND id NOT IN (SELECT id FROM library_trash WHERE kind='collection')")?;let rows=stmt.query_map([parent],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;rows};
                if existing!=ids.iter().cloned().collect(){return Err(conflict("Folder order changed. Refresh first."));}
                for(i,id)in ids.iter().enumerate(){tx.execute("INSERT OR REPLACE INTO collection_order VALUES(?1,?2)",params![id,i as i64])?;}
            }
            "folder_trash"=>{
                let target=text(b,"target");active_folder(&tx,target)?;if target=="L1"{return Err(bad("The Library root cannot be deleted"));}
                let ids=subtree(&tx,target)?;let mut marked=Vec::new();
                for key in ids{if tx.execute("INSERT OR IGNORE INTO library_trash(kind,id,batch,deleted) VALUES('collection',?1,?2,?3)",params![key,batch,now()])?>0{marked.push(key);}}
                undo=Some(json!({"kind":"collection","ids":marked}));
            }
            "purge"=>{
                let entries=b["entries"].as_array().filter(|a|!a.is_empty()&&a.len()<=1000).context("Choose 1–1000 trash items")?;
                let mut papers=HashSet::new();let mut folders=HashSet::new();
                for entry in entries {
                    let kind=text(entry,"kind");let id=text(entry,"id");
                    if !["paper","collection"].contains(&kind)||!tx.query_row("SELECT EXISTS(SELECT 1 FROM library_trash WHERE kind=?1 AND id=?2)",params![kind,id],|r|r.get::<_,bool>(0))?{return Err(bad("Only items already in Trash can be permanently deleted"));}
                    if kind=="paper"{papers.insert(id.to_string());}else{for child in subtree(&tx,id)?{if child=="L1"||!tx.query_row("SELECT EXISTS(SELECT 1 FROM library_trash WHERE kind='collection' AND id=?1)",[&child],|r|r.get::<_,bool>(0))?{return Err(bad("Restore active descendants before permanently deleting a folder"));}folders.insert(child);}}
                }
                for key in &papers{
                    tx.execute("DELETE FROM zotero_imports WHERE kind='annotation' AND target IN (SELECT id FROM annotations WHERE paper=?1)",[key])?;
                    tx.execute("DELETE FROM annotations WHERE paper=?1",[key])?;tx.execute("DELETE FROM memberships WHERE paper=?1",[key])?;
                    tx.execute("DELETE FROM zotero_imports WHERE kind='paper' AND target=?1",[key])?;tx.execute("DELETE FROM papers WHERE key=?1",[key])?;
                    tx.execute("DELETE FROM library_trash WHERE kind='paper' AND id=?1",[key])?;
                }
                // Remove child rows before parents; queue owned project storage for cleanup.
                let mut pending=folders.clone();while !pending.is_empty(){let mut changed=false;for id in pending.clone(){
                    let has_child:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collections WHERE parent=?1)",[&id],|r|r.get(0))?;if has_child{continue;}
                    let folder:String=tx.query_row("SELECT notes_folder FROM collections WHERE id=?1",[&id],|r|r.get(0))?;
                    tx.execute("INSERT OR IGNORE INTO library_cleanup VALUES(?1)",[folder])?;
                    tx.execute("DELETE FROM memberships WHERE collection=?1",[&id])?;tx.execute("DELETE FROM collection_order WHERE id=?1",[&id])?;
                    tx.execute("DELETE FROM zotero_imports WHERE kind='collection' AND target=?1",[&id])?;
                    tx.execute("DELETE FROM collections WHERE id=?1",[&id])?;tx.execute("DELETE FROM library_trash WHERE kind='collection' AND id=?1",[&id])?;
                    pending.remove(&id);changed=true;
                }if !changed{return Err(bad("Cannot delete folders with active descendants"));}}
                let undos:Vec<(String,String)>={let mut stmt=tx.prepare("SELECT id,data FROM library_undo WHERE undone=0")?;let rows=stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;rows};
                for(id,data)in undos{let data:Value=serde_json::from_str(&data)?;let removed=if text(&data,"kind")=="paper"{&papers}else{&folders};if data["ids"].as_array().into_iter().flatten().any(|id|id.as_str().is_some_and(|id|removed.contains(id))){tx.execute("UPDATE library_undo SET undone=1 WHERE id=?1",[id])?;}}
            }
            "restore"=>{
                let kind=text(b,"kind");if !["paper","collection"].contains(&kind){return Err(bad("Invalid trash kind"));}
                let ids=strings(&b["ids"])?;
                for id in &ids{if !tx.query_row("SELECT EXISTS(SELECT 1 FROM library_trash WHERE kind=?1 AND id=?2)",params![kind,id],|r|r.get::<_,bool>(0))?{return Err(missing());}}
                // Restore the whole original folder-deletion batch to avoid orphan descendants.
                let ids=if kind=="collection"{let mut all=HashSet::new();for id in ids{let batch:Option<String>=tx.query_row("SELECT batch FROM library_trash WHERE kind='collection' AND id=?1",[id],|r|r.get(0)).optional()?;if let Some(batch)=batch{let mut stmt=tx.prepare("SELECT id FROM library_trash WHERE kind='collection' AND batch=?1")?;for id in stmt.query_map([batch],|r|r.get::<_,String>(0))?{all.insert(id?);}}}all.into_iter().collect()}else{ids};
                restore(&tx,kind,&ids)?;
            }
            "undo"=>{
                let id=text(b,"id");let data:Option<String>=tx.query_row("SELECT data FROM library_undo WHERE id=?1 AND undone=0",[id],|r|r.get(0)).optional()?;
                let data:Value=serde_json::from_str(&data.ok_or_else(||conflict("Nothing left to undo"))?)?;
                restore(&tx,text(&data,"kind"),&strings(&data["ids"])?)?;
                tx.execute("UPDATE library_undo SET undone=1 WHERE id=?1",[id])?;
            }
            "merge"=>{
                let target=text(b,"target");let source=text(b,"source");if source==target{return Err(bad("Choose two different papers"));}
                let(mut retained,hash,rev)=active_paper(&tx,target)?;let(incoming,other_hash,other_rev)=active_paper(&tx,source)?;
                if b["target_revision"].as_i64()!=Some(rev)||b["source_revision"].as_i64()!=Some(other_rev){return Err(conflict("A duplicate candidate changed. Review again."));}
                if hash.is_some()&&other_hash.is_some()&&hash!=other_hash{return Err(bad("These papers have different PDFs. Keep them separate to preserve page anchors and annotations."));}
                for(k,v)in incoming.as_object().unwrap(){if k!="key"&&(retained[k].is_null()||retained[k]==""||retained[k].as_array().is_some_and(Vec::is_empty)){retained[k]=v.clone();}}
                for field in ["tags","cite_keys"]{let mut values=retained[field].as_array().cloned().unwrap_or_default();for value in incoming[field].as_array().into_iter().flatten().cloned().chain(if field=="cite_keys"{Some(json!(source))}else{None}){if !values.contains(&value){values.push(value);}}retained[field]=json!(values);}
                retained["key"]=json!(target);
                tx.execute("UPDATE papers SET data=?1,s2=?2,doi=?3,arxiv=?4,title_norm=?5,pdf_hash=?6,revision=revision+1 WHERE key=?7",params![retained.to_string(),text(&retained,"s2"),text(&retained,"DOI").to_lowercase(),text(&retained,"arxiv").to_lowercase(),norm(text(&retained,"title")),hash.clone().or(other_hash.clone()),target])?;
                if hash.is_none()&&other_hash.is_some(){tx.execute("INSERT OR REPLACE INTO pdf_links SELECT ?1,path FROM pdf_links WHERE paper=?2",params![target,source])?;}
                tx.execute("INSERT OR IGNORE INTO memberships SELECT collection,?1 FROM memberships WHERE paper=?2",params![target,source])?;
                let annotations:Vec<(String,String)>={let mut stmt=tx.prepare("SELECT id,data FROM annotations WHERE paper=?1")?;let rows=stmt.query_map([source],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;rows};
                for(id,s)in annotations{let mut data:Value=serde_json::from_str(&s)?;data["paper"]=json!(target);tx.execute("UPDATE annotations SET paper=?1,data=?2,revision=revision+1 WHERE id=?3",params![target,data.to_string(),id])?;}
                tx.execute("UPDATE zotero_imports SET target=?1 WHERE kind='paper' AND target=?2 AND NOT EXISTS(SELECT 1 FROM zotero_imports z WHERE z.kind='paper' AND z.source=zotero_imports.source AND z.target=?1)",params![target,source])?;
                tx.execute("INSERT INTO library_trash(kind,id,batch,deleted,merged_into) VALUES('paper',?1,?2,?3,?4)",params![source,batch,now(),target])?;
            }
            _=>return Err(bad("Unknown Library management operation")),
        }
        if let Some(data)=undo{tx.execute("INSERT INTO library_undo(id,data) VALUES(?1,?2)",params![batch,data.to_string()])?;}
        tx.execute("UPDATE library_state SET revision=revision+1 WHERE id=1",[])?;tx.commit()?;
        Ok(json!({"ok":true,"revision":rev+1,"undo":if op=="trash"||op=="folder_trash"{Some(batch)}else{None}}))
    }
}
pub async fn get(State(app):Shared)->ApiResult{Ok(Json(app.library.management_state()?))}
pub async fn post(State(app):Shared,Json(b):Json<Value>)->ApiResult{let mut result=app.library.manage(&b)?;result["warnings"]=json!(app.library.cleanup_purged_folders(&app.notes.root));Ok(Json(result))}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->Result<(tempfile::TempDir,Library)>{let dir=tempfile::tempdir()?;let lib=Library::open(dir.path().into())?;Ok((dir,lib))}
    fn apply(lib:&Library,mut b:Value)->Result<Value>{b["revision"]=lib.management_state()?["revision"].clone();lib.manage(&b)}
    fn chosen(lib:&Library,ids:&[&str])->Result<Value>{Ok(json!(ids.iter().map(|key|Ok(json!({"key":key,"revision":lib.paper(key)?["revision"]}))).collect::<Result<Vec<_>>>()?))}
    #[test]
    fn batch_memberships_tags_and_atomic_stale_rejection()->Result<()> {
        let(_d,lib)=fixture()?;let a=lib.create_collection("L1","A")?;let b=lib.create_collection("L1","B")?;
        let p=lib.save(&json!({"title":"First management paper"}),&a)?;let q=lib.save(&json!({"title":"Second management paper"}),&a)?;
        let papers=chosen(&lib,&[&p,&q])?;
        apply(&lib,json!({"op":"membership","mode":"move","source":a,"target":b,"papers":papers}))?;
        assert_eq!(lib.items(&a)?.len(),2);assert_eq!(lib.items(&b)?.len(),2);assert_eq!(lib.items("L1")?.len(),2);
        apply(&lib,json!({"op":"tags","mode":"add","tags":["review","method"],"papers":papers}))?;
        assert_eq!(lib.paper(&p)?["tags"],json!(["review","method"]));
        assert!(apply(&lib,json!({"op":"trash","papers":papers})).is_err());assert_eq!(lib.items("L1")?.len(),2);
        let fresh=chosen(&lib,&[&p,&q])?;
        apply(&lib,json!({"op":"tags","mode":"remove","tags":["review"],"papers":fresh}))?;
        assert_eq!(lib.paper(&q)?["tags"],json!(["method"]));
        let fresh=chosen(&lib,&[&p,&q])?;
        apply(&lib,json!({"op":"membership","mode":"remove","target":b,"papers":fresh}))?;
        assert!(lib.items(&b)?.is_empty());assert_eq!(lib.items("L1")?.len(),2);
        assert!(lib.management_state()?["trash"].as_array().unwrap().is_empty(),"Removing collection membership must never trash a paper");

        Ok(())
    }
    #[test]
    fn trash_restore_and_undo_keep_annotation_ids_and_memberships()->Result<()> {
        let(_d,lib)=fixture()?;let a=lib.create_collection("L1","A")?;
        let p=lib.save(&json!({"title":"Paper to restore"}),&a)?;let papers=chosen(&lib,&[&p])?;
        lib.conn.lock().unwrap().execute("INSERT INTO annotations VALUES('original',?1,'{\"id\":\"original\"}',1)",[&p])?;
        let result=apply(&lib,json!({"op":"trash","papers":papers}))?;
        assert!(lib.items("L1")?.is_empty());assert!(lib.paper(&p).is_err());assert_eq!(lib.management_state()?["trash"].as_array().unwrap().len(),1);
        apply(&lib,json!({"op":"undo","id":result["undo"]}))?;
        assert_eq!(lib.items(&a)?.len(),1);assert_eq!(lib.annotations(&p)?[0]["id"],"original");
        assert!(apply(&lib,json!({"op":"undo","id":result["undo"]})).is_err());
        lib.delete_paper(&p,lib.paper(&p)?["revision"].as_i64().unwrap())?;
        apply(&lib,json!({"op":"restore","kind":"paper","ids":[p]}))?;assert_eq!(lib.items(&a)?.len(),1);
        Ok(())
    }
    #[test]
    fn folder_move_order_trash_and_restore_preserve_storage_ids()->Result<()> {
        let(d,lib)=fixture()?;let a=lib.create_collection("L1","A")?;let b=lib.create_collection("L1","B")?;let child=lib.create_collection(&a,"Child")?;
        let p=lib.save(&json!({"title":"Folder retained paper"}),&child)?;
        let folder=lib.folder_id(&child)?;std::fs::create_dir_all(d.path().join(&folder))?;std::fs::write(d.path().join(&folder).join("keep.txt"),"keep")?;
        assert!(apply(&lib,json!({"op":"folder_move","target":a,"parent":child})).is_err());
        assert!(apply(&lib,json!({"op":"folder_trash","target":"L1"})).is_err());
        apply(&lib,json!({"op":"folder_order","parent":"L1","ids":[b,a]}))?;
        assert_eq!(lib.collections()?["targets"][1]["id"],b);
        apply(&lib,json!({"op":"folder_move","target":child,"parent":b}))?;
        let result=apply(&lib,json!({"op":"folder_trash","target":b}))?;
        assert!(lib.folder_id(&child).is_err());assert!(lib.items_scoped(&a,true)?.is_empty());assert!(lib.paper(&p).is_ok());
        assert_eq!(std::fs::read_to_string(d.path().join(&folder).join("keep.txt"))?,"keep");
        apply(&lib,json!({"op":"undo","id":result["undo"]}))?;
        assert_eq!(lib.folder_id(&child)?,folder);assert_eq!(lib.items_scoped(&b,true)?.len(),1);
        Ok(())
    }
    #[test]
    fn edge_drop_moves_across_parents_and_orders_atomically()->Result<()> {
        let(_d,lib)=fixture()?;let a=lib.create_collection("L1","A")?;let b=lib.create_collection("L1","B")?;let child=lib.create_collection(&a,"Child")?;
        apply(&lib,json!({"op":"folder_move","target":child,"parent":"L1","anchor":b,"position":"before"}))?;
        let targets=lib.collections()?["targets"].as_array().unwrap().clone();let roots:Vec<_>=targets.iter().filter(|t|t["parent"]=="L1").map(|t|t["id"].clone()).collect();
        assert_eq!(roots,json!([a,child,b]).as_array().unwrap().clone());
        assert!(apply(&lib,json!({"op":"folder_move","target":child,"parent":a,"anchor":b,"position":"after"})).is_err());
        assert_eq!(lib.collections()?["targets"][2]["id"],child);
        apply(&lib,json!({"op":"folder_move","target":a,"parent":"L1","anchor":b,"position":"after"}))?;
        let targets=lib.collections()?["targets"].as_array().unwrap().clone();let roots:Vec<_>=targets.iter().filter(|t|t["parent"]=="L1").map(|t|t["id"].clone()).collect();assert_eq!(roots,json!([child,b,a]).as_array().unwrap().clone());
        assert!(apply(&lib,json!({"op":"folder_move","target":b,"parent":"L1","anchor":b,"position":"before"})).is_err());Ok(())
    }
    #[test]
    fn merge_preserves_metadata_tags_memberships_and_annotation_ids()->Result<()> {
        let(_d,lib)=fixture()?;let a=lib.create_collection("L1","A")?;let b=lib.create_collection("L1","B")?;
        let p=lib.save(&json!({"title":"Retained duplicate record","tags":["first"]}),&a)?;
        let q=lib.save(&json!({"title":"Source duplicate record","creators":["Source Author"],"tags":["second"],"DOI":"10.1/source"}),&b)?;
        lib.attach_pdf(&q,b"%PDF-1.7\nshared")?;
        lib.conn.lock().unwrap().execute("INSERT INTO annotations VALUES('keep-anchor',?1,?2,1)",params![q,json!({"paper":q,"id":"keep-anchor"}).to_string()])?;
        apply(&lib,json!({"op":"merge","target":p,"source":q,"target_revision":lib.paper(&p)?["revision"],"source_revision":lib.paper(&q)?["revision"]}))?;
        assert!(lib.paper(&q).is_err());assert_eq!(lib.paper(&p)?["title"],"Retained duplicate record");
        assert_eq!(lib.paper(&p)?["tags"],json!(["first","second"]));assert_eq!(lib.paper(&p)?["DOI"],"10.1/source");assert_eq!(lib.paper(&p)?["creators"],json!(["Source Author"]));
        assert_eq!(lib.items(&b)?[0]["key"],p);assert_eq!(lib.annotations(&p)?[0]["id"],"keep-anchor");assert_eq!(lib.annotations(&p)?[0]["paper"],p);
        assert!(lib.paper(&p)?["cite_keys"].as_array().unwrap().contains(&json!(q)));
        assert!(apply(&lib,json!({"op":"restore","kind":"paper","ids":[q]})).is_err());
        Ok(())
    }
    #[test]
    fn trash_survives_reopen_and_reimport_does_not_reuse_hidden_papers()->Result<()> {
        let(dir,lib)=fixture()?;let p=lib.upload("L1","original.pdf",b"%PDF-1.7\npersistent")?;
        lib.delete_paper(&p,lib.paper(&p)?["revision"].as_i64().unwrap())?;drop(lib);
        let lib=Library::open(dir.path().into())?;
        assert_eq!(lib.management_state()?["trash"][0]["id"],p);
        let imported=lib.upload("L1","again.pdf",b"%PDF-1.7\npersistent")?;assert_ne!(p,imported);
        apply(&lib,json!({"op":"restore","kind":"paper","ids":[p]}))?;
        assert_eq!(lib.items("L1")?.len(),2);Ok(())
    }
    #[test]
    fn permanent_purge_requires_trash_and_cannot_be_restored()->Result<()> {
        let(_d,lib)=fixture()?;let p=lib.save(&json!({"title":"Permanently deleted paper"}),"L1")?;
        assert!(apply(&lib,json!({"op":"purge","entries":[{"kind":"paper","id":p}]})).is_err());assert!(lib.paper(&p).is_ok());
        lib.conn.lock().unwrap().execute("INSERT INTO annotations VALUES('purged-anchor',?1,'{}',1)",[&p])?;
        let deleted=apply(&lib,json!({"op":"trash","papers":chosen(&lib,&[&p])?}))?;
        apply(&lib,json!({"op":"purge","entries":[{"kind":"paper","id":p}]}))?;
        assert!(lib.management_state()?["trash"].as_array().unwrap().is_empty());
        assert!(apply(&lib,json!({"op":"restore","kind":"paper","ids":[p]})).is_err());
        assert!(apply(&lib,json!({"op":"undo","id":deleted["undo"]})).is_err());
        assert_eq!(lib.conn.lock().unwrap().query_row("SELECT count(*) FROM annotations",[],|r|r.get::<_,i64>(0))?,0);Ok(())
    }
    #[test]
    fn permanent_folder_purge_removes_owned_files_but_keeps_papers_and_other_folders()->Result<()> {
        let(_d,lib)=fixture()?;let notes=tempfile::tempdir()?;let parent=lib.create_collection("L1","Delete")?;let child=lib.create_collection(&parent,"Child")?;
        let p=lib.save(&json!({"title":"Paper retained in Library"}),&child)?;
        let storage=lib.folder_id(&child)?;std::fs::create_dir_all(notes.path().join(&storage))?;std::fs::write(notes.path().join(&storage).join("note.tex"),"private project source")?;
        std::fs::create_dir_all(notes.path().join("keep"))?;std::fs::write(notes.path().join("keep/safe.txt"),"keep")?;
        apply(&lib,json!({"op":"folder_trash","target":parent}))?;
        apply(&lib,json!({"op":"purge","entries":[{"kind":"collection","id":parent}]}))?;
        assert!(lib.cleanup_purged_folders(notes.path()).is_empty());assert!(!notes.path().join(storage).exists());assert!(notes.path().join("keep/safe.txt").exists());assert!(lib.paper(&p).is_ok());
        assert!(apply(&lib,json!({"op":"restore","kind":"collection","ids":[parent]})).is_err());Ok(())
    }
    #[test]
    fn merge_refuses_different_pdfs_and_stale_requests_atomically()->Result<()> {
        let(_d,lib)=fixture()?;let p=lib.upload("L1","a.pdf",b"%PDF-1.7\na")?;let q=lib.upload("L1","b.pdf",b"%PDF-1.7\nb")?;
        assert!(apply(&lib,json!({"op":"merge","target":p,"source":q,"target_revision":lib.paper(&p)?["revision"],"source_revision":lib.paper(&q)?["revision"]})).is_err());
        assert_eq!(lib.items("L1")?.len(),2);assert!(lib.management_state()?["trash"].as_array().unwrap().is_empty());
        let mut b=json!({"op":"folder_trash","target":"L1","revision":-1});assert!(lib.manage(&b).is_err());b["revision"]=lib.management_state()?["revision"].clone();assert!(lib.manage(&b).is_err());Ok(())
    }
}
