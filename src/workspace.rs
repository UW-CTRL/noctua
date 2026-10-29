//! Collection file trees. Logical names are independent of immutable stored blobs.
use std::{path::{Path as FsPath,PathBuf}, sync::Mutex};
use anyhow::{bail,Context,Result};
use axum::{extract::{Path,State,Query},body::Bytes,Json,response::{IntoResponse,Response},http::StatusCode};
use serde::Deserialize;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use crate::{App,Shared,ApiResult};
static GATE:Mutex<()>=Mutex::new(());
pub fn safe_path(s:&str)->Result<()> {
 if s.is_empty()||s.len()>500||s.contains(['\\','\0',':'])||s.split('/').any(|c|c.is_empty()||c=="."||c==".."||c.starts_with('.')) {bail!("Use a relative path without hidden or parent directories");} Ok(())
}
pub fn dir(app:&App,target:&str)->Result<PathBuf>{let folder=app.library.folder_id(target)?;crate::notes::check_id(&folder)?;Ok(app.notes.root.join(folder))}
/// Read-only diagnostics under a collection's internal workspace. Never expose a
/// general filesystem path or follow links out of this project. Reads are bounded
/// because compiler logs can grow while an agent is inspecting them.
pub fn inspect_internal(app:&App,target:&str,args:&Value)->Result<Value>{
 use std::io::{Read,Seek,SeekFrom};
 let requested=args.get("path").map(|v|v.as_str().context("path must be a string")).transpose()?.unwrap_or("");
 let path=if requested==".workspace"{""}else{requested.strip_prefix(".workspace/").unwrap_or(requested)};
 anyhow::ensure!(path.len()<=1000&&!path.contains(['\\','\0',':'])&&(path.is_empty()||path.split('/').all(|s|!s.is_empty()&&s!="."&&s!="..")),"Use a relative path inside .workspace without parent directories");
 anyhow::ensure!(path.split('/').next()!=Some("research"),"Research details are managed separately from project files");
 let offset=args.get("offset").map(|v|v.as_u64().context("offset must be a nonnegative integer")).transpose()?.unwrap_or(0);
 let tail=args.get("tail").map(|v|v.as_bool().context("tail must be a boolean")).transpose()?.unwrap_or(false);
 anyhow::ensure!(!tail||offset==0,"Choose tail or offset, not both");
 let project=dir(app,target)?;
 let root=project.join(".workspace");
 if !root.exists()&&path.is_empty(){return Ok(json!({"path":"","kind":"directory","exists":false,"entries":[]}));}
 let mut resolved=project;
 for part in std::iter::once(".workspace").chain(path.split('/').filter(|p|!p.is_empty())){
  resolved.push(part);
  let meta=std::fs::symlink_metadata(&resolved).context("Workspace path does not exist (a build may not have run yet)")?;
  anyhow::ensure!(!meta.file_type().is_symlink(),"Workspace symlinks cannot be inspected");
 }
 anyhow::ensure!(resolved.canonicalize()?.starts_with(root.canonicalize()?),"Path is outside the workspace");
 let meta=std::fs::metadata(&resolved)?;
 if meta.is_dir(){
  anyhow::ensure!(!tail,"tail applies only to files");
  let mut entries=Vec::new();
  for e in std::fs::read_dir(&resolved)? {let e=e?;let t=e.file_type()?;let name=e.file_name().to_string_lossy().into_owned();if path.is_empty()&&name=="research"{continue;}entries.push(json!({"name":name,"path":if path.is_empty(){name.clone()}else{format!("{path}/{name}")},"kind":if t.is_symlink(){"symlink"}else if t.is_dir(){"directory"}else if t.is_file(){"file"}else{"other"}}));}
  entries.sort_by(|a,b|a["name"].as_str().cmp(&b["name"].as_str()));
  let start=offset.min(entries.len() as u64) as usize;let end=(start+200).min(entries.len());
  return Ok(json!({"path":path,"kind":"directory","exists":true,"entries":entries[start..end],"total_entries":entries.len(),"next_offset":if end<entries.len(){Some(end)}else{None}}));
 }
 anyhow::ensure!(meta.is_file(),"Only regular files and directories can be inspected");
 let mut file=std::fs::File::open(&resolved)?;
 let size=file.metadata()?.len();let start=if tail{size.saturating_sub(64*1024)}else{offset.min(size)};
 file.seek(SeekFrom::Start(start))?;let mut bytes=Vec::new();file.take(64*1024).read_to_end(&mut bytes)?;
 // PDF/images are visible in listings, but returning binary bytes as tool text
 // is neither useful nor safe for context budgets. UTF-8 boundary fragments in
 // paginated text are replaced; offsets always count original bytes.
 let binary=path.to_lowercase().ends_with(".pdf")||bytes.iter().any(|b|*b<32&&!matches!(*b,b'\n'|b'\r'|b'\t'|12));
 let end=start+bytes.len() as u64;
 Ok(json!({"path":path,"kind":"file","size_bytes":size,"offset":start,"end_offset":end,"truncated":start>0||end<size,"next_offset":if end<size{Some(end)}else{None},"binary":binary,"text":if binary{None}else{Some(String::from_utf8_lossy(&bytes).into_owned())},"note":if binary{"Binary file; content is not returned"}else{"Build files can change during compilation; this is a read-only snapshot"}}))
}

fn manifest_path(app:&App,target:&str)->Result<PathBuf>{Ok(dir(app,target)?.join(".workspace").join("manifest.json"))}
fn load(app:&App,target:&str)->Result<Value>{let p=manifest_path(app,target)?;if p.exists(){Ok(serde_json::from_slice(&std::fs::read(p)?)?)}else{Ok(json!({"revision":0,"entries":[],"bibliographies":[],"skills":[]}))}}
/// Agent reads discover legacy entries in memory, without organizing or saving them.
pub fn snapshot(app:&App,target:&str)->Result<Value>{let _g=GATE.lock().unwrap();let mut m=load(app,target)?;discover(app,target,&mut m)?;auto_bibliographies(&mut m);Ok(m)}
pub fn create_note(app:&App,target:&str,b:&Value)->Result<Value>{
 let _g=GATE.lock().unwrap();let mut m=load(app,target)?;
 if b["revision"]!=m["revision"]{return Err(crate::Status(StatusCode::CONFLICT,"Project changed. Refresh before creating a note.".into()).into());}
 let parent=b["parent"].as_str().unwrap_or("");
 if !parent.is_empty()&&!m["entries"].as_array().unwrap().iter().any(|e|e["id"]==parent&&e["kind"]=="folder"&&e["deleted"]!=true){bail!("Parent folder not found");}
 let title=b["title"].as_str().context("Title required")?;
 if title.trim().is_empty()||title.chars().count()>200{bail!("Choose a title of 1–200 characters");}
 let text=b["latex"].as_str().unwrap_or("");if text.len()>100_000{bail!("Initial note text exceeds 100000 bytes");}
 discover(app,target,&mut m)?;
 let folder=app.library.folder_id(target)?;let mut doc=app.notes.create(&folder,title)?;
 let id=doc["id"].as_str().unwrap().to_owned();
 let result=(||->Result<Value>{
  if !text.is_empty(){doc["blocks"][0]["src"]=json!(text);doc["updated"]=json!(app.notes.save(&folder,&id,doc.clone())?);}
  let before=history_content(m.clone());discover(app,target,&mut m)?;
  let e=m["entries"].as_array_mut().unwrap().iter_mut().find(|e|e["note"]==id).context("Created note missing from workspace")?;e["parent"]=json!(parent);let entry_id=e["id"].clone();
  validate(&m)?;m["revision"]=json!(m["revision"].as_u64().unwrap_or(0)+1);save(app,target,&m)?;
  crate::editing::journals().lock().unwrap().entry(key(app,target)).or_default().record(before,history_content(m.clone()),"Create note");
  Ok(json!({"status":"applied","note_id":id,"entry_id":entry_id,"folder_id":target,"updated":doc["updated"],"revision":m["revision"]}))
 })();
 if result.is_err(){let _=app.notes.delete(&folder,&id);}result
}
pub(crate) fn paper_manifest(app:&App,target:&str)->Result<Value>{let _gate=GATE.lock().unwrap();load(app,target)}
fn save(app:&App,target:&str,v:&Value)->Result<()>{let p=manifest_path(app,target)?;std::fs::create_dir_all(p.parent().unwrap())?;crate::notes::write_atomic(&p,&v.to_string())}
fn history_content(v:Value)->Value{let mut v=crate::editing::content(v);if let Some(entries)=v["entries"].as_array_mut(){entries.retain(|e|e["deleted"]!=true);}v}
fn file_content(e:&Value)->Value{json!({"blob":e["blob"],"size":e["size"]})}
fn file_key(app:&App,target:&str,id:&str)->String{format!("{}:file:{target}:{id}",app.notes.root.display())}
fn record_file_changes(app:&App,target:&str,before:&Value,after:&Value,hs:&mut std::collections::HashMap<String,crate::editing::Journal>){
 for e in after["entries"].as_array().unwrap(){if e["kind"]!="file"{continue;}if let Some(old)=before["entries"].as_array().unwrap().iter().find(|old|old["id"]==e["id"]){let id=e["id"].as_str().unwrap();hs.entry(file_key(app,target,id)).or_default().record(file_content(old),file_content(e),&format!("Edit {}",e["name"].as_str().unwrap_or("file")));}}
}
fn key(app:&App,target:&str)->String{format!("{}:workspace:{target}",app.notes.root.display())}
fn blob(app:&App,target:&str,bytes:&[u8])->Result<String>{let hash=format!("{:x}",Sha256::digest(bytes));let d=dir(app,target)?.join(".files");std::fs::create_dir_all(&d)?;let path=d.join(&hash);if !path.exists(){std::fs::write(path,bytes)?;}Ok(hash)}
pub fn file_path(app:&App,target:&str,e:&Value)->Result<PathBuf>{
 if let Some(p)=e["legacy"].as_str(){safe_path(p)?;if !p.starts_with("media/")&&!p.starts_with("images/"){bail!("Invalid attachment path");}return Ok(dir(app,target)?.join(p));}
 let h=e["blob"].as_str().context("Not a file")?;if h.len()!=64||!h.bytes().all(|c|c.is_ascii_hexdigit()){bail!("Invalid stored file");}Ok(dir(app,target)?.join(".files").join(h))
}
pub fn bytes(app:&App,target:&str,e:&Value)->Result<Vec<u8>>{Ok(std::fs::read(file_path(app,target,e)?)?)}
fn discover(app:&App,target:&str,m:&mut Value)->Result<()> {
 let folder=app.library.folder_id(target)?;
 let entries=m["entries"].as_array_mut().context("Invalid workspace")?;
 for n in app.notes.list(&folder)?.as_array().unwrap(){if !entries.iter().any(|e|e["note"]==n["id"]){entries.push(json!({"id":format!("note-{}",n["id"].as_str().unwrap()),"note":n["id"],"name":format!("{}-{}",n["title"].as_str().unwrap_or("Note").chars().map(|c|if "/\\:\0".contains(c){'_'}else{c}).collect::<String>().trim_start_matches('.'),n["id"].as_str().unwrap()),"kind":"note","parent":"","deleted":false}));}}
 for prefix in ["images","media"] {let Ok(files)=std::fs::read_dir(dir(app,target)?.join(prefix))else{continue};
  for f in files.flatten(){if !f.file_type()?.is_file(){continue;}let name=f.file_name().to_string_lossy().to_string();if name.starts_with('.') {continue;}let path=format!("{prefix}/{name}");if !entries.iter().any(|e|e["legacy"]==path){entries.push(json!({"id":format!("f{}",&format!("{:x}",Sha256::digest(path.as_bytes()))[..32]),"name":format!("{prefix}-{name}"),"parent":"","kind":"file","source_name":name,"legacy":path,"size":f.metadata()?.len(),"deleted":false}));}}
 } Ok(())
}
// Organize each attachment once, preserving subsequent user moves and stable references.
fn organize_media(m:&mut Value) {
 let entries=m["entries"].as_array_mut().unwrap();
 let media=|e:&Value| {let kind=mime(e["source_name"].as_str().or(e["name"].as_str()).unwrap_or(""));e["kind"]=="file"&&e["deleted"]!=true&&e["media_organized"]!=true&&(e.get("legacy").is_some()||kind.starts_with("image/")||kind.starts_with("video/"))};
 let roots:Vec<usize>=entries.iter().enumerate().filter(|(_,e)|media(e)&&e["parent"].as_str().unwrap_or("").is_empty()).map(|(i,_)|i).collect();
 if !roots.is_empty(){
  let existing=entries.iter().find(|e|e["kind"]=="folder"&&e["deleted"]!=true&&(e["managed_media"]==true||(e["name"]=="Media"&&e["parent"]==""))).map(|e|e["id"].clone());
  let id=existing.unwrap_or_else(||{
   let mut name="Media".to_owned();let mut suffix=2;
   while entries.iter().any(|e|e["deleted"]!=true&&e["parent"]==""&&e["name"]==name){name=format!("Media {suffix}");suffix+=1;}
   let id=json!(crate::library::id("f"));entries.push(json!({"id":id,"name":name,"parent":"","kind":"folder","managed_media":true,"deleted":false}));id
  });
  for i in roots {entries[i]["parent"]=id.clone();}
 }
 for e in entries.iter_mut(){if media(e){e["media_organized"]=json!(true);}}
 m["media_layout"]=json!(1);
}
fn auto_bibliographies(m:&mut Value){m["bibliographies"]=json!(m["entries"].as_array().unwrap().iter().filter(|e|e["kind"]=="file"&&e["deleted"]!=true&&e["name"].as_str().unwrap_or("").to_ascii_lowercase().ends_with(".bib")).map(|e|e["id"].clone()).collect::<Vec<_>>());}
pub fn list(app:&App,target:&str)->Result<Value>{let _g=GATE.lock().unwrap();let mut m=load(app,target)?;let old=m.clone();discover(app,target,&mut m)?;organize_media(&mut m);auto_bibliographies(&mut m);if old!=m {m["revision"]=json!(m["revision"].as_u64().unwrap_or(0)+1);save(app,target,&m)?;if old["revision"].as_u64().unwrap_or(0)>0&&old["media_layout"]==1{crate::editing::journals().lock().unwrap().entry(key(app,target)).or_default().record(history_content(old),history_content(m.clone()),"Import notes or media");}}m["history"]=crate::editing::journals().lock().unwrap().entry(key(app,target)).or_default().status();
 match crate::bibliography::index(app,target,&m){Ok(index)=>{m["bib_index"]=json!(index);m["bib_error"]=Value::Null;},Err(e)=>m["bib_error"]=json!(format!("{e:#}"))}
 let folder=app.library.folder_id(target)?;let mut notes=Vec::new();
 for n in app.notes.list(&folder)?.as_array().unwrap(){if let Some(id)=n["id"].as_str(){if let Some(doc)=app.notes.get(&folder,id)?{let text=doc["blocks"].as_array().map(|a|a.iter().filter_map(|b|b["src"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();notes.push((id.to_owned(),n["title"].clone(),text));}}}
 for e in m["entries"].as_array_mut().unwrap(){if e["kind"]=="file"{let token=e["legacy"].as_str().map(str::to_owned).unwrap_or_else(||format!("files/{}",e["id"].as_str().unwrap()));e["references"]=json!(notes.iter().filter(|(_,_,text)|text.contains(&token)).map(|(id,title,_)|json!({"id":id,"title":title})).collect::<Vec<_>>());}}
 Ok(m)}
pub fn read(app:&App,target:&str,id:&str)->Result<Value>{let m=list(app,target)?;let e=m["entries"].as_array().unwrap().iter().find(|e|e["id"]==id&&e["deleted"]!=true).context("File not found")?;let b=if std::fs::metadata(file_path(app,target,e)?)?.len()<=2<<20{bytes(app,target,e)?}else{Vec::new()};let text=std::str::from_utf8(&b).ok().filter(|_|!b.is_empty()||e["size"].as_u64()==Some(0)).filter(|s|!s.contains('\0')&&s.len()<=2<<20);Ok(json!({"entry":e,"text":text,"revision":m["revision"],"history":crate::editing::journals().lock().unwrap().entry(file_key(app,target,id)).or_default().status()}))}
fn validate(m:&Value)->Result<()> {
 let entries=m["entries"].as_array().context("Invalid entries")?;
 for e in entries.iter().filter(|e|e["deleted"]!=true){let name=e["name"].as_str().context("Name required")?;safe_path(name)?;if name.contains('/') {bail!("Choose a name, not a path");}
  let id=e["id"].as_str().context("Missing id")?;let mut parent=e["parent"].as_str().unwrap_or("");let mut seen=std::collections::HashSet::new();seen.insert(id);
  while !parent.is_empty(){if !seen.insert(parent){bail!("A folder cannot contain itself");}let p=entries.iter().find(|p|p["id"]==parent&&p["kind"]=="folder"&&p["deleted"]!=true).context("Parent folder not found")?;parent=p["parent"].as_str().unwrap_or("");}
  if entries.iter().any(|p|p["deleted"]!=true&&p["id"]!=e["id"]&&p["name"]==e["name"]&&p["parent"]==e["parent"]){bail!("A file with that name already exists in this folder");}
 } Ok(())
}
fn stamp_deletions(previous:&Value,next:&mut Value){
 let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
 let last=previous["entries"].as_array().unwrap().iter().filter_map(|e|e["deleted_at"].as_u64()).max().unwrap_or(0);
 let timestamp=now.max(last.saturating_add(1));
 for e in next["entries"].as_array_mut().unwrap(){
  if e["deleted"]==true&& !previous["entries"].as_array().unwrap().iter().any(|old|old["id"]==e["id"]&&old["deleted"]==true){e["deleted_at"]=json!(timestamp);}
  else if e["deleted"]!=true{e.as_object_mut().unwrap().remove("deleted_at");}
 }
}
// Resolve only sibling-name collisions. Replacements stay recoverable in Trash.
fn resolve_move_name(m:&mut Value,entry:&Value,parent:&str,choice:&str)->Result<Option<String>>{
 let name=entry["name"].as_str().context("Name required")?;
 let conflict=m["entries"].as_array().unwrap().iter().find(|e|e["deleted"]!=true&&e["id"]!=entry["id"]&&e["name"]==name&&e["parent"].as_str().unwrap_or("")==parent).cloned();
 let Some(conflict)=conflict else{return Ok(Some(name.to_owned()));};
 match choice{
  "skip"=>Ok(None),
  "number"=>{
   let split=if entry["kind"]!="file"{None}else{name.rfind('.').filter(|i|*i>0)};
   let (stem,ext)=split.map(|i|(&name[..i],&name[i..])).unwrap_or((name,""));
   for n in 2.. {let candidate=format!("{stem} ({n}){ext}");if !m["entries"].as_array().unwrap().iter().any(|e|e["deleted"]!=true&&e["name"]==candidate&&e["parent"].as_str().unwrap_or("")==parent){return Ok(Some(candidate));}}
   unreachable!()
  },
  "overwrite"=>{
   let mut ids=std::collections::HashSet::from([conflict["id"].as_str().unwrap().to_owned()]);
   loop{let old=ids.len();for e in m["entries"].as_array().unwrap(){if ids.contains(e["parent"].as_str().unwrap_or("")){ids.insert(e["id"].as_str().unwrap().to_owned());}}if ids.len()==old{break;}}
   anyhow::ensure!(!ids.contains(entry["id"].as_str().unwrap()),"Cannot replace a folder containing the entry being moved");
   for e in m["entries"].as_array_mut().unwrap(){if ids.contains(e["id"].as_str().unwrap()){e["deleted"]=json!(true);}}
   Ok(Some(name.to_owned()))
  },
  _=>bail!("A file with that name already exists in this folder"),
 }
}
// Cross-project moves publish the destination before hiding the source. Immutable
// source data remains available to Trash; failures never discard the source.
fn transfer(app:&App,target:&str,b:&Value,mut source:Value)->Result<Value>{
 let destination=b["destination"].as_str().context("Destination required")?;
 anyhow::ensure!(dir(app,target)?!=dir(app,destination)?,"Choose another project");
 let mut dest=load(app,destination)?;discover(app,destination,&mut dest)?;let previous_dest=dest.clone();let previous_source=source.clone();
 anyhow::ensure!(b["destination_revision"]==dest["revision"],"Destination changed. Retry the move");
 let id=b["id"].as_str().context("Entry required")?;
 let entries=source["entries"].as_array().unwrap();
 anyhow::ensure!(entries.iter().any(|e|e["id"]==id&&e["deleted"]!=true),"Entry not found");
 let mut ids=std::collections::HashSet::from([id.to_owned()]);
 loop{let old=ids.len();for e in entries.iter().filter(|e|e["deleted"]!=true){if ids.contains(e["parent"].as_str().unwrap_or("")){ids.insert(e["id"].as_str().unwrap().to_owned());}}if ids.len()==old{break;}}
 let mut moved:Vec<Value>=entries.iter().filter(|e|e["deleted"]!=true&&ids.contains(e["id"].as_str().unwrap())).cloned().collect();
 for e in &mut moved{
  anyhow::ensure!(!dest["entries"].as_array().unwrap().iter().any(|d|d["id"]==e["id"]),"This entry already exists in the destination");
  if e["id"]==id{e["parent"]=json!("");}
 }
 let root=moved.iter_mut().find(|e|e["id"]==id).unwrap();
 let Some(name)=resolve_move_name(&mut dest,root,"",b["conflict"].as_str().unwrap_or(""))? else{return Ok(source);};if root["name"]!=name{root["renamed"]=json!(true);}root["name"]=json!(name);
 dest["entries"].as_array_mut().unwrap().extend(moved.clone());validate(&dest)?;
 // Copy content before either manifest is committed.
 let mut notes_to_write=Vec::new();
 for e in &mut moved{
  if e["kind"]=="file"{let data=bytes(app,target,e)?;let hash=blob(app,destination,&data)?;
   let copied=dest["entries"].as_array_mut().unwrap().iter_mut().find(|d|d["id"]==e["id"]).unwrap();copied["blob"]=json!(hash);copied.as_object_mut().unwrap().remove("legacy");
  }else if e["kind"]=="note"{
   let note=e["note"].as_str().context("Note id missing")?;crate::notes::check_id(note)?;
   let doc=std::fs::read_to_string(dir(app,target)?.join(format!("{note}.json")))?;
   // File-ID references need their target entries, not just the note JSON.
   for dependency in source["entries"].as_array().unwrap().iter().filter(|d|d["kind"]=="file"&&d["deleted"]!=true){
    let key=format!("files/{}",dependency["id"].as_str().unwrap());
    anyhow::ensure!(!doc.contains(&key)||ids.contains(dependency["id"].as_str().unwrap()),"Move the note and its referenced files together in a folder");
   }
   for prefix in ["images","media"]{let root=dir(app,target)?.join(prefix);if root.exists(){for file in std::fs::read_dir(root)?{let file=file?;if !file.file_type()?.is_file(){continue;}let name=file.file_name();let relative=format!("{prefix}/{}",name.to_string_lossy());if !doc.contains(&relative){continue;}let out=dir(app,destination)?.join(prefix).join(&name);let data=std::fs::read(file.path())?;if out.exists(){anyhow::ensure!(std::fs::read(&out)?==data,"An attachment with the same name exists in the destination");}else{std::fs::create_dir_all(out.parent().unwrap())?;std::fs::write(out,data)?;}}}}
   let out=dir(app,destination)?.join(format!("{note}.json"));anyhow::ensure!(!out.exists(),"Note already exists in destination");std::fs::create_dir_all(out.parent().unwrap())?;notes_to_write.push((out,doc));
  }
 }
 for e in source["entries"].as_array_mut().unwrap(){if ids.contains(e["id"].as_str().unwrap()){e["deleted"]=json!(true);}}
 stamp_deletions(&previous_dest,&mut dest);stamp_deletions(&previous_source,&mut source);
 dest["revision"]=json!(dest["revision"].as_u64().unwrap_or(0)+1);source["revision"]=json!(source["revision"].as_u64().unwrap_or(0)+1);
 let published=(||->Result<()>{for (path,doc) in &notes_to_write{crate::notes::write_atomic(path,doc)?;}save(app,destination,&dest)})();
 if let Err(error)=published{for (path,_) in &notes_to_write{let _=std::fs::remove_file(path);}return Err(error);}
 save(app,target,&source)?;
 Ok(source)
}
pub fn change(app:&App,target:&str,b:&Value,upload:Option<&[u8]>)->Result<Value>{
 let _g=GATE.lock().unwrap();let mut m=load(app,target)?;let rev=m["revision"].as_u64().unwrap_or(0);
 if b["revision"].as_u64()!=Some(rev){return Err(crate::Status(StatusCode::CONFLICT,"Project files changed. Refresh and retry.".into()).into());}
 discover(app,target,&mut m)?;
 let before=history_content(m.clone());let op=b["op"].as_str().unwrap_or("");
 if op=="transfer"{return transfer(app,target,b,m);}
 if op=="purge"{
  let requested=b["ids"].as_array().context("Choose entries to delete")?;
  anyhow::ensure!(!requested.is_empty(),"Choose entries to delete");
  let mut ids:std::collections::HashSet<String>=requested.iter().map(|id|id.as_str().map(str::to_owned).context("Invalid entry id")).collect::<Result<_>>()?;
  for id in &ids{anyhow::ensure!(m["entries"].as_array().unwrap().iter().any(|e|e["id"]==*id&&e["deleted"]==true&&e["purged"]!=true),"Only trashed entries can be permanently deleted");}
  loop{let old=ids.len();for e in m["entries"].as_array().unwrap(){if ids.contains(e["parent"].as_str().unwrap_or("")){anyhow::ensure!(e["deleted"]==true,"Restore or move active children before deleting this folder");ids.insert(e["id"].as_str().unwrap().to_owned());}}if ids.len()==old{break;}}
  for e in m["entries"].as_array_mut().unwrap(){if ids.contains(e["id"].as_str().unwrap()){e["purged"]=json!(true);}}
  m["revision"]=json!(rev+1);save(app,target,&m)?;
  let project_key=key(app,target);let file_keys:std::collections::HashSet<String>=ids.iter().map(|id|file_key(app,target,id)).collect();crate::editing::journals().lock().unwrap().retain(|k,_|k!=&project_key&&!file_keys.contains(k));
  for e in m["entries"].as_array().unwrap().iter().filter(|e|ids.contains(e["id"].as_str().unwrap())){
   let path=if let Some(note)=e["note"].as_str(){crate::notes::check_id(note)?;Some(dir(app,target)?.join(format!("{note}.json")))}else if e["kind"]=="file"&&!m["entries"].as_array().unwrap().iter().any(|other|other["purged"]!=true&&other["id"]!=e["id"]&&((e["blob"].is_string()&&other["blob"]==e["blob"])||(e["legacy"].is_string()&&other["legacy"]==e["legacy"]))){Some(file_path(app,target,e)?)}else{None};
   if let Some(path)=path{if path.exists(){std::fs::remove_file(path)?;}}
  }
  return Ok(m);
 }

 if op=="move"{
  let entry=m["entries"].as_array().unwrap().iter().find(|e|e["id"]==b["id"]&&e["deleted"]!=true).context("Entry not found")?.clone();
  let Some(name)=resolve_move_name(&mut m,&entry,b["parent"].as_str().unwrap_or(""),b["conflict"].as_str().unwrap_or(""))? else{return Ok(m);};
  let e=m["entries"].as_array_mut().unwrap().iter_mut().find(|e|e["id"]==entry["id"]).unwrap();if e["name"]!=name{e["renamed"]=json!(true);}e["name"]=json!(name);
 }
 match op {
  "create"|"folder"=>{let id=crate::library::id("f");let name=b["name"].as_str().context("Name required")?;let mut e=json!({"id":id,"name":name,"parent":b["parent"].as_str().unwrap_or(""),"kind":if op=="folder"{"folder"}else{"file"},"source_name":name,"deleted":false});if op=="create"{let data=upload.unwrap_or_else(||b["text"].as_str().unwrap_or("").as_bytes());e["blob"]=json!(blob(app,target,data)?);e["size"]=json!(data.len());}m["entries"].as_array_mut().unwrap().push(e);},
  "restore"=>{let id=b["id"].as_str().context("File id required")?;let entries=m["entries"].as_array_mut().unwrap();let parent=entries.iter().find(|e|e["id"]==id&&e["deleted"]==true&&e["purged"]!=true).context("Trashed entry not found")?["parent"].as_str().unwrap_or("").to_owned();let parent_active=parent.is_empty()||entries.iter().any(|e|e["id"]==parent&&e["deleted"]!=true);let e=entries.iter_mut().find(|e|e["id"]==id).unwrap();e["deleted"]=json!(false);if !parent_active{e["parent"]=json!("");}},
  "edit"|"rename"|"move"|"delete"=>{
   let id=b["id"].as_str().context("File id required")?;
   let e=m["entries"].as_array_mut().unwrap().iter_mut().find(|e|e["id"]==id&&e["deleted"]!=true).context("File not found")?;
   match op {"edit"=>{if e["kind"]!="file"||e.get("legacy").is_some(){bail!("Use the note editor for notes; managed media are immutable");}let data=b["text"].as_str().context("Text required")?.as_bytes();if data.len()>2<<20{bail!("Text exceeds 2 MB");}e["blob"]=json!(blob(app,target,data)?);e["size"]=json!(data.len());},"rename"=>{e["name"]=b["name"].clone();e["renamed"]=json!(true);},"move"=>e["parent"]=b["parent"].clone(),_=>e["deleted"]=json!(true)}
   if op=="delete" {loop{let gone:Vec<Value>=m["entries"].as_array().unwrap().iter().filter(|e|e["deleted"]==true).map(|e|e["id"].clone()).collect();let mut changed=false;for e in m["entries"].as_array_mut().unwrap(){if e["deleted"]!=true&&gone.contains(&e["parent"]){e["deleted"]=json!(true);changed=true;}}if !changed{break;}}}
  },
  "config"=>{if let Some(paper)=b.get("paper"){m["paper"]=crate::paper::merge_settings(&m["paper"],paper,m["entries"].as_array().unwrap())?;}for field in ["bibliographies","skills"]{if let Some(v)=b.get(field){if !v.is_array(){bail!("Expected a list");}m[field]=v.clone();}}},
  _=>bail!("Unknown file operation"),
 }
 if op=="create"{organize_media(&mut m);}
 validate(&m)?;auto_bibliographies(&mut m);
 match crate::bibliography::index(app,target,&m){Ok(index)=>{m["bib_index"]=json!(index);m["bib_error"]=Value::Null;},Err(e)=>{if op=="config"&&b.get("bibliographies").is_some(){return Err(e);}m["bib_error"]=json!(format!("{e:#}"));}}
 stamp_deletions(&load(app,target)?,&mut m);
 m["revision"]=json!(rev+1);save(app,target,&m)?;
 let mut hs=crate::editing::journals().lock().unwrap();record_file_changes(app,target,&before,&m,&mut hs);let h=hs.entry(key(app,target)).or_default();h.record(before,history_content(m.clone()),&format!("{op} project file"));m["history"]=h.status();Ok(m)
}
pub fn history(app:&App,target:&str,b:&Value)->Result<Value>{let _g=GATE.lock().unwrap();let current=load(app,target)?;if b["revision"]!=current["revision"]{bail!("Project changed. Refresh before undoing");}let mut hs=crate::editing::journals().lock().unwrap();let h=hs.entry(key(app,target)).or_default();let redo=b["redo"]==true;let mut m=h.pending(redo,&history_content(current.clone()))?;
 for e in current["entries"].as_array().unwrap(){if !m["entries"].as_array().unwrap().iter().any(|a|a["id"]==e["id"]){let mut tombstone=e.clone();tombstone["deleted"]=json!(true);m["entries"].as_array_mut().unwrap().push(tombstone);}}
 stamp_deletions(&current,&mut m);m["revision"]=json!(current["revision"].as_u64().unwrap_or(0)+1);save(app,target,&m)?;h.finish(redo);m["history"]=h.status();record_file_changes(app,target,&current,&m,&mut hs);Ok(m)}
pub async fn get(State(app):Shared,Path(target):Path<String>)->ApiResult{Ok(Json(list(&app,&target)?))}
pub async fn edit(State(app):Shared,Path(target):Path<String>,Json(b):Json<Value>)->ApiResult{Ok(Json(change(&app,&target,&b,None)?))}
pub async fn undo(State(app):Shared,Path(target):Path<String>,Json(b):Json<Value>)->ApiResult{Ok(Json(history(&app,&target,&b)?))}
pub async fn text(State(app):Shared,Path((target,id)):Path<(String,String)>)->ApiResult{Ok(Json(read(&app,&target,&id)?))}
#[derive(Deserialize)]pub struct Upload {name:String,#[serde(default)]parent:String,revision:u64}
pub async fn upload(State(app):Shared,Path(target):Path<String>,Query(q):Query<Upload>,b:Bytes)->ApiResult{Ok(Json(change(&app,&target,&json!({"op":"create","name":q.name,"parent":q.parent,"revision":q.revision}),Some(&b))?))}
pub fn mime(name:&str)-> &'static str{match FsPath::new(name).extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase().as_str(){"png"=>"image/png","jpg"|"jpeg"=>"image/jpeg","gif"=>"image/gif","webp"=>"image/webp","svg"=>"image/svg+xml","mp4"|"m4v"=>"video/mp4","mov"=>"video/quicktime","webm"=>"video/webm","pdf"=>"application/pdf",_=>"application/octet-stream"}}
pub async fn download(State(app):Shared,Path((target,id)):Path<(String,String)>,headers:axum::http::HeaderMap)->Response{
 let result=(||->Result<_>{let m=list(&app,&target)?;let e=m["entries"].as_array().unwrap().iter().find(|e|e["id"]==id&&e["deleted"]!=true).context("File not found")?;Ok((file_path(&app,&target,e)?,mime(e["source_name"].as_str().or(e["name"].as_str()).unwrap_or(""))))})();
 match result{Ok((path,mime))=>{let mut r=crate::media::serve(path,mime,headers).await;r.headers_mut().insert("cache-control",axum::http::HeaderValue::from_static("no-store"));r.headers_mut().insert("content-security-policy",axum::http::HeaderValue::from_static("sandbox"));r},Err(e)=>crate::ApiError(e).into_response()}
}

/// Apply reviewed script output as one revision-checked, undoable manifest transaction.
pub fn apply_skill(app:&App,target:&str,run:&Value)->Result<Value>{
 use base64::Engine;
 let _g=GATE.lock().unwrap();let mut m=load(app,target)?;if m["revision"]!=run["revision"]{return Err(crate::Status(StatusCode::CONFLICT,"Project changed while the script ran. Request a new run rather than overwriting newer files.".into()).into());}
 let before=history_content(m.clone());
 for change in run["changes"].as_array().context("Missing reviewed changes")?{
  let path=change["path"].as_str().context("Missing output path")?;safe_path(path)?;
  if let Some(id)=change["id"].as_str(){let e=m["entries"].as_array_mut().unwrap().iter_mut().find(|e|e["id"]==id&&e["deleted"]!=true).context("Input file disappeared")?;
   if change["deleted"]==true{e["deleted"]=json!(true);}else{let data=base64::engine::general_purpose::STANDARD.decode(change["data"].as_str().context("Output missing")?)?;e["blob"]=json!(blob(app,target,&data)?);e.as_object_mut().unwrap().remove("legacy");e["size"]=json!(data.len());}
  }else{
   let mut parts=path.split('/').peekable();let mut parent=String::new();
   while let Some(name)=parts.next(){if parts.peek().is_some(){let found=m["entries"].as_array().unwrap().iter().find(|e|e["parent"]==parent&&e["name"]==name&&e["deleted"]!=true).cloned();if let Some(e)=found{if e["kind"]!="folder"{bail!("An output directory conflicts with an existing file");}parent=e["id"].as_str().unwrap().into();}else{let id=crate::library::id("f");m["entries"].as_array_mut().unwrap().push(json!({"id":id,"name":name,"parent":parent,"kind":"folder","deleted":false}));parent=id;}}else{let data=base64::engine::general_purpose::STANDARD.decode(change["data"].as_str().context("Output missing")?)?;let hash=blob(app,target,&data)?;m["entries"].as_array_mut().unwrap().push(json!({"id":crate::library::id("f"),"name":name,"parent":parent,"kind":"file","source_name":name,"blob":hash,"size":data.len(),"deleted":false}));}}
  }
 }
 validate(&m)?;match crate::bibliography::index(app,target,&m){Ok(index)=>{m["bib_index"]=json!(index);m["bib_error"]=Value::Null;},Err(e)=>m["bib_error"]=json!(format!("{e:#}"))}
 m["revision"]=json!(m["revision"].as_u64().unwrap_or(0)+1);save(app,target,&m)?;let mut hs=crate::editing::journals().lock().unwrap();record_file_changes(app,target,&before,&m,&mut hs);let h=hs.entry(key(app,target)).or_default();h.record(before,history_content(m.clone()),"Apply skill output");m["history"]=h.status();Ok(m)
}

// File-editor history is independent of the workspace's structural/batch history.
pub async fn file_undo(State(app):Shared,Path((target,id)):Path<(String,String)>,Json(b):Json<Value>)->ApiResult{
 let _gate=GATE.lock().unwrap();let mut m=load(&app,&target)?;
 if m["revision"]!=b["revision"]{return Err(crate::Status(StatusCode::CONFLICT,"Project changed. Reload this file before undoing.".into()).into());}
 let before=history_content(m.clone());let e=m["entries"].as_array_mut().unwrap().iter_mut().find(|e|e["id"]==id&&e["deleted"]!=true).context("File not found")?;
 let mut hs=crate::editing::journals().lock().unwrap();let h=hs.entry(file_key(&app,&target,&id)).or_default();let redo=b["redo"]==true;let desired=h.pending(redo,&file_content(e))?;
 e["blob"]=desired["blob"].clone();e["size"]=desired["size"].clone();
 match crate::bibliography::index(&app,&target,&m){Ok(index)=>{m["bib_index"]=json!(index);m["bib_error"]=Value::Null;},Err(e)=>m["bib_error"]=json!(format!("{e:#}"))}
 m["revision"]=json!(m["revision"].as_u64().unwrap_or(0)+1);save(&app,&target,&m)?;h.finish(redo);
 let h=hs.entry(key(&app,&target)).or_default();h.record(before,history_content(m.clone()),if redo{"Redo file edit"}else{"Undo file edit"});m["history"]=h.status();Ok(Json(m))
}

#[cfg(test)]
mod media_layout_tests {
 use super::*;
 #[test]
 fn deletion_times_preserve_old_entries_and_advance_on_redelete(){
  let before=json!({"entries":[{"id":"old","deleted":true,"deleted_at":12},{"id":"new","deleted":false}]});
  let mut after=before.clone();after["entries"][1]["deleted"]=json!(true);stamp_deletions(&before,&mut after);
  assert_eq!(after["entries"][0]["deleted_at"],12);let first=after["entries"][1]["deleted_at"].as_u64().unwrap();assert!(first>12);
  let mut restored=after.clone();restored["entries"][1]["deleted"]=json!(false);stamp_deletions(&after,&mut restored);assert!(restored["entries"][1].get("deleted_at").is_none());
  restored["entries"][0]["deleted_at"]=json!(first+10);let mut again=restored.clone();again["entries"][1]["deleted"]=json!(true);stamp_deletions(&restored,&mut again);assert!(again["entries"][1]["deleted_at"].as_u64().unwrap()>first+10);
 }
 #[test]
 fn move_conflicts_keep_extensions_and_trash_subtrees(){
  let entry=json!({"id":"incoming","kind":"file","name":"draft.tex","parent":"elsewhere"});
  let mut m=json!({"entries":[{"id":"old","kind":"folder","name":"draft.tex","parent":""},{"id":"child","kind":"file","name":"data.txt","parent":"old"},{"id":"taken","kind":"file","name":"draft (2).tex","parent":""}]});
  let original=m.clone();assert_eq!(resolve_move_name(&mut m,&entry,"","skip").unwrap(),None);assert_eq!(m,original);
  assert_eq!(resolve_move_name(&mut m,&entry,"","number").unwrap(),Some("draft (3).tex".into()));assert_eq!(m,original);
  assert_eq!(resolve_move_name(&mut m,&entry,"","overwrite").unwrap(),Some("draft.tex".into()));assert_eq!(m["entries"][0]["deleted"],true);assert_eq!(m["entries"][1]["deleted"],true);assert_ne!(m["entries"][2]["deleted"],true);
 }
 #[test]
 fn media_grouping_preserves_references_and_manual_moves(){
  let mut m=json!({"entries":[
   {"id":"image","kind":"file","name":"images-a.png","legacy":"images/a.png","parent":""},
   {"id":"video","kind":"file","name":"clip.mp4","parent":"custom"},
   {"id":"custom","kind":"folder","name":"Custom","parent":""},
   {"id":"bib","kind":"file","name":"references.bib","parent":""}
  ]});
  organize_media(&mut m);validate(&m).unwrap();
  let folder=m["entries"][0]["parent"].clone();assert_ne!(folder,json!(""));
  assert_eq!(m["entries"][0]["legacy"],"images/a.png");assert_eq!(m["entries"][1]["parent"],"custom");assert_eq!(m["entries"][3]["parent"],"");
  m["entries"][0]["parent"]=json!("");let old=m.clone();organize_media(&mut m);assert_eq!(old,m);
  m["entries"].as_array_mut().unwrap().push(json!({"id":"new","kind":"file","name":"new.mp4","parent":""}));organize_media(&mut m);assert_eq!(m["entries"].as_array().unwrap().last().unwrap()["parent"],folder);
 }
 #[test]
 fn media_folder_avoids_name_conflicts_and_deleted_entries(){
  let mut m=json!({"entries":[{"id":"taken","kind":"file","name":"Media","parent":""},{"id":"image","kind":"file","name":"a.png","parent":""},{"id":"trash","kind":"file","name":"b.png","parent":"","deleted":true}]});
  organize_media(&mut m);validate(&m).unwrap();assert_eq!(m["entries"][3]["name"],"Media 2");assert_eq!(m["entries"][2]["parent"],"");
 }
}
