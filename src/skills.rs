//! Imported and locally installed skill packages, with individually approved script runs.
use std::io::Read;
use std::{collections::HashMap,path::{Path as FsPath,PathBuf},sync::{Mutex,OnceLock,Arc}};
use anyhow::{bail,Context,Result};
use axum::{body::Bytes,extract::{State,Path},Json};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use base64::{Engine,engine::general_purpose::STANDARD};
use tokio::io::AsyncReadExt;
use crate::{App,Shared,ApiResult};
const LIMIT:usize=32<<20;
#[derive(Clone,serde::Serialize,serde::Deserialize)]
pub struct SkillProject {pub id:String,pub name:String,pub skill_ids:Vec<String>}
fn global_location(app:&App)->Option<PathBuf>{
 app.settings.lock().unwrap().skills_location.as_ref().map(PathBuf::from).or_else(||app.shared_skills_dir.clone())
}
pub async fn configuration(State(app):Shared)->ApiResult{
 let location=global_location(&app);let projects=app.settings.lock().unwrap().skill_projects.clone();
 Ok(Json(json!({"location":location,"default_location":app.shared_skills_dir,"projects":projects})))
}
pub async fn set_location(State(app):Shared,Json(body):Json<Value>)->ApiResult{
 let value=body.get("location").context("Location is required; use null to restore the default")?;
 let location=if value.is_null(){None}else{
  let text=value.as_str().context("Location must be a folder path")?.trim();
  let path=if text=="~"||text.starts_with("~/"){dirs::home_dir().context("Home folder is unavailable")?.join(text.trim_start_matches('~').trim_start_matches('/'))}else{PathBuf::from(text)};
  if !path.is_absolute()||!path.is_dir(){bail_api("Choose an existing absolute folder path")?;}
  std::fs::read_dir(&path).context("The skills folder cannot be read")?;
  Some(path.canonicalize()?.to_string_lossy().into_owned())
 };
 crate::settings::update(&app,|s|s.skills_location=location)?;
 configuration(State(app)).await
}
fn root(app:&App)->PathBuf{app.data_dir.join("skills")}
fn local_id(name:&str)->String{format!("local_{:x}",Sha256::digest(name.as_bytes()))[..38].to_owned()}
fn local_packages(app:&App)->Vec<(String,PathBuf)>{
 let Some(dir)=global_location(app) else{return Vec::new()};
 let Ok(entries)=std::fs::read_dir(&dir) else{return Vec::new()};
 entries.flatten().filter_map(|entry|{
  let name=entry.file_name().into_string().ok()?;
  // Resolve CLI link-mode installs once; internal resource symlinks remain unsupported.
  let path=entry.path().canonicalize().ok()?;
  (path.is_dir()&&path.join("SKILL.md").is_file()).then(||(local_id(&format!("{}:{name}",dir.display())),path))
 }).collect()
}
fn package(app:&App,id:&str)->Result<PathBuf>{
 crate::notes::check_id(id)?;
 if id.starts_with("local_"){return local_packages(app).into_iter().find(|(key,_)|key==id).map(|(_,path)|path).context("Local skill is no longer installed");}
 Ok(root(app).join(id))
}
fn runs()->&'static Mutex<HashMap<String,Value>>{static M:OnceLock<Mutex<HashMap<String,Value>>>=OnceLock::new();M.get_or_init(Default::default)}
fn cancellations()->&'static Mutex<HashMap<String,Arc<tokio::sync::Notify>>>{static M:OnceLock<Mutex<HashMap<String,Arc<tokio::sync::Notify>>>>=OnceLock::new();M.get_or_init(Default::default)}
fn contexts()->&'static Mutex<HashMap<String,Value>>{static M:OnceLock<Mutex<HashMap<String,Value>>>=OnceLock::new();M.get_or_init(Default::default)}
fn context_key(app:&App,chat:&str)->String{format!("{}:{chat}",app.data_dir.display())}
fn walk(dir:&FsPath,base:&FsPath,out:&mut Vec<(String,Vec<u8>)>)->Result<()> {
 if !dir.exists(){return Ok(());}for entry in std::fs::read_dir(&dir)?{let e=entry?;let t=e.file_type()?;if t.is_symlink(){bail!("Symlinks are not supported");}if t.is_dir(){walk(&e.path(),base,out)?;}else if t.is_file(){if e.metadata()?.len()>LIMIT as u64{bail!("File exceeds 32 MB");}let rel=e.path().strip_prefix(base)?.to_string_lossy().replace('\\',"/");crate::workspace::safe_path(&rel)?;out.push((rel,std::fs::read(e.path())?));if out.len()>512||out.iter().map(|(_,b)|b.len()).sum::<usize>()>LIMIT{bail!("Package exceeds 512 files or 32 MB");}}}Ok(())
}
fn digest(files:&[(String,Vec<u8>)])->String{let mut files=files.to_vec();files.sort_by(|a,b|a.0.cmp(&b.0));let mut h=Sha256::new();for(p,b)in files{h.update((p.len()as u64).to_le_bytes());h.update(p);h.update((b.len()as u64).to_le_bytes());h.update(b);}format!("{:x}",h.finalize())}
pub fn list(app:&App)->Result<Value>{
 let mut packages=Vec::new();
 if let Ok(entries)=std::fs::read_dir(root(app)){for entry in entries.flatten(){
  let id=entry.file_name().to_string_lossy().into_owned();
  if crate::notes::check_id(&id).is_ok(){packages.push((id,entry.path(),"imported"));}
 }}
 packages.extend(local_packages(app).into_iter().map(|(id,path)|(id,path,"local")));
 let projects=app.settings.lock().unwrap().skill_projects.clone();
 let mut out=Vec::new();
 for(id,path,source_kind)in packages{
  let file=path.join("SKILL.md");
  if !std::fs::symlink_metadata(&file).is_ok_and(|m|m.is_file()&&m.len()<=256<<10){continue;}
  let Ok(source)=std::fs::read_to_string(&file) else{continue};
  if source.trim().is_empty(){continue;}
  let name=source.lines().find_map(|l|l.strip_prefix("name:"))
   .or_else(||source.lines().find_map(|l|l.strip_prefix("# "))).unwrap_or("Skill").trim().trim_matches('"');
  let description=source.lines().find_map(|l|l.strip_prefix("description:")).unwrap_or("").trim();
  let project=projects.iter().find(|p|p.skill_ids.contains(&id));
  out.push(json!({"id":id,"name":name,"description":description,"source":source_kind,"project_id":project.map(|p|&p.id),"project_name":project.map(|p|&p.name)}));
 }
 out.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));
 Ok(json!(out))
}
pub fn read(app:&App,id:&str,path:&str)->Result<Value>{crate::workspace::safe_path(path)?;let dir=package(app,id)?;let mut files=Vec::new();walk(&dir,&dir,&mut files)?;let (_,bytes)=files.iter().find(|(p,_)|p==path).context("Skill file not found")?;Ok(json!({"id":id,"path":path,"text":std::str::from_utf8(bytes).context("This resource is binary")?,"files":files.iter().map(|(p,_)|p).collect::<Vec<_>>(),"hash":digest(&files)}))}
fn import(app:&App,mut files:Vec<(String,Vec<u8>)>)->Result<Value>{
 if files.len()>512||files.iter().map(|(_,b)|b.len()).sum::<usize>()>LIMIT{bail!("Skills support at most 512 files and 32 MB");}
 if !files.iter().any(|(p,_)|p=="SKILL.md") {let skills:Vec<_>=files.iter().filter(|(p,_)|p.ends_with("/SKILL.md")).collect();if skills.len()!=1{bail!("Choose one skill directory containing SKILL.md");}let prefix=skills[0].0.strip_suffix("SKILL.md").unwrap().to_owned();if !files.iter().all(|(p,_)|p.starts_with(&prefix)){bail!("ZIP must contain a single skill folder");}for(p,_)in &mut files{*p=p.strip_prefix(&prefix).unwrap().into();}}
 let source=&files.iter().find(|(p,_)|p=="SKILL.md").context("SKILL.md is required")?.1;let source=std::str::from_utf8(source).context("SKILL.md must be UTF-8")?;if source.trim().is_empty()||source.len()>256<<10{bail!("SKILL.md must contain instructions under 256 KB");}
 let mut names=std::collections::HashSet::new();for(p,_)in &files{crate::workspace::safe_path(p)?;if !names.insert(p.to_lowercase()){bail!("Duplicate package path");}}
 let id=crate::library::id("s");let dir=package(app,&id)?;std::fs::create_dir_all(&dir)?;
 let result=(||->Result<_>{for(p,b)in &files{let path=dir.join(p);std::fs::create_dir_all(path.parent().unwrap())?;std::fs::write(path,b)?;}Ok(json!({"id":id,"hash":digest(&files)}))})();if result.is_err(){let _=std::fs::remove_dir_all(dir);}result
}
pub async fn get(State(app):Shared)->ApiResult{Ok(Json(list(&app)?))}
fn disconnect_copies(app:&App,ids:&[String],project_id:Option<&str>)->Result<()> {
 let pending_runs=runs().lock().unwrap();
 if pending_runs.values().any(|r|r["root"]==json!(app.data_dir)&&r["skill_id"].as_str().is_some_and(|id|ids.iter().any(|s|s==id))&&r["status"]=="running"){
  bail!("Stop this project's running skill scripts before disconnecting");
 }
 let staging=app.data_dir.join(".skill-disconnect").join(crate::library::id("d"));
 std::fs::create_dir_all(&staging)?;let mut moved=Vec::new();
 let result=(||->Result<()>{
  for id in ids{
   crate::notes::check_id(id)?;if id.starts_with("local_"){bail!("Global installations cannot be disconnected here");}
   let source=root(app).join(id);
   match std::fs::rename(&source,staging.join(id)){Ok(())=>moved.push(id.clone()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(e.into())}
  }
  crate::settings::update(app,|s|{
   for p in &mut s.skill_projects{p.skill_ids.retain(|id|!ids.contains(id));}
   s.skill_projects.retain(|p|!p.skill_ids.is_empty()&&Some(p.id.as_str())!=project_id);
  })?;Ok(())
 })();
 if result.is_err(){
  for id in &moved{if let Err(error)=std::fs::rename(staging.join(id),root(app).join(id)){
   return Err(error).context(format!("Could not restore disconnected copies; recovery files remain at {}",staging.display()));
  }}
 }
 let _=std::fs::remove_dir_all(&staging);result
}
/// Disconnect only Noctua's uploaded copies. Original projects are never accessed.
pub async fn disconnect(State(app):Shared,Path(id):Path<String>)->ApiResult {
 crate::notes::check_id(&id)?;
 if !list(&app)?.as_array().unwrap().iter().any(|s|s["id"]==id&&s["source"]=="imported"){bail_api("Imported skill not found")?;}
 disconnect_copies(&app,&[id.clone()],None)?;
 Ok(Json(json!({"disconnected":id})))
}
pub async fn disconnect_project(State(app):Shared,Path(id):Path<String>)->ApiResult{
 crate::notes::check_id(&id)?;
 let project=app.settings.lock().unwrap().skill_projects.iter().find(|p|p.id==id).cloned().context("Imported project not found")?;
 disconnect_copies(&app,&project.skill_ids,Some(&id))?;
 Ok(Json(json!({"disconnected":id})))
}
fn decode_files(body:&Value)->Result<Vec<(String,Vec<u8>)>>{
 body["files"].as_array().context("Files required")?.iter().map(|f|Ok((f["path"].as_str().context("Path required")?.into(),STANDARD.decode(f["data"].as_str().context("Base64 data required")?)?))).collect()
}
pub async fn upload_project(State(app):Shared,Json(body):Json<Value>)->ApiResult{
 let name=body["name"].as_str().context("Project name required")?.trim();
 if name.is_empty()||name.len()>200{bail_api("Use a project name between 1 and 200 characters")?;}
 let packages=body["packages"].as_array().context("Skill packages required")?;
 if packages.is_empty()||packages.len()>100{bail_api("Import between 1 and 100 skills per project")?;}
 let decoded=packages.iter().map(decode_files).collect::<Result<Vec<_>>>()?;
 if decoded.iter().map(|p|p.len()).sum::<usize>()>512||decoded.iter().flatten().map(|(_,b)|b.len()).sum::<usize>()>LIMIT{bail_api("Project skill imports support at most 512 files and 32 MB")?;}
 let mut ids=Vec::new();
 let result=(||->Result<SkillProject>{
  for files in decoded{ids.push(import(&app,files)?["id"].as_str().unwrap().to_owned());}
  let project=SkillProject{id:crate::library::id("p"),name:name.into(),skill_ids:ids.clone()};
  crate::settings::update(&app,|s|s.skill_projects.push(project.clone()))?;Ok(project)
 })();
 match result{Ok(project)=>Ok(Json(json!(project))),Err(e)=>{for id in ids{let _=std::fs::remove_dir_all(root(&app).join(id));}Err(e.into())}}
}
pub async fn upload(State(app):Shared,Json(b):Json<Value>)->ApiResult{Ok(Json(import(&app,decode_files(&b)?)?))}
pub async fn upload_zip(State(app):Shared,b:Bytes)->ApiResult{let mut zip=zip::ZipArchive::new(std::io::Cursor::new(b))?;if zip.len()>512{bail_api("ZIP contains too many entries")?;}let mut files=Vec::new();let mut total=0;for i in 0..zip.len(){let mut f=zip.by_index(i)?;if f.is_dir(){continue;}if f.unix_mode().is_some_and(|m|m&0o170000==0o120000){bail_api("ZIP symlinks are not allowed")?;}let name=f.name()?.into_owned();if name.split('/').any(|s|s==".DS_Store"||s=="__MACOSX"){continue;}crate::workspace::safe_path(&name)?;total+=f.size();if total>LIMIT as u64{bail_api("Expanded ZIP exceeds 32 MB")?;}let mut data=Vec::new();std::io::Read::take(&mut f,(LIMIT+1)as u64).read_to_end(&mut data)?;files.push((name,data));}Ok(Json(import(&app,files)?))}
fn bail_api(message:&str)->Result<()>{bail!("{message}")}
pub async fn resource(State(app):Shared,Path((id,path)):Path<(String,String)>)->ApiResult{Ok(Json(read(&app,&id,&path)?))}
pub fn set_context(app:&App,chat:&str,target:Option<&str>,additional_ids:Option<&Vec<String>>)->Result<Value>{
 let mut ids=if let Some(t)=target{crate::workspace::list(app,t)?["skills"].as_array().cloned().unwrap_or_default()}else{Vec::new()};
 if let Some(extra)=additional_ids{for id in extra{let id=json!(id);if !ids.contains(&id){ids.push(id);}}}
 let known=list(app)?;let enabled:Vec<Value>=known.as_array().unwrap().iter().filter(|s|ids.contains(&s["id"])).cloned().collect();
 contexts().lock().unwrap().insert(context_key(app,chat),json!({"target":target,"skills":enabled.iter().map(|s|&s["id"]).collect::<Vec<_>>()}));Ok(json!(enabled))
}
pub fn enabled(app:&App,chat:Option<&str>,id:&str)->Result<()> {let context=contexts().lock().unwrap().get(&context_key(app,chat.context("Active chat required")?)).cloned().unwrap_or(Value::Null);if !context["skills"].as_array().is_some_and(|v|v.iter().any(|s|s==id)){bail!("This skill is not enabled for the active project/chat");}if !package(app,id)?.join("SKILL.md").is_file(){bail!("This skill is no longer available");}Ok(())}
pub fn request(app:&App,chat:Option<&str>,b:&Value)->Result<Value>{let skill=b["skill_id"].as_str().context("Skill id required")?;enabled(app,chat,skill)?;let script=b["script"].as_str().context("Script path required")?;let info=read(app,skill,script)?;let target=b["folder_id"].as_str().context("Project required")?;let m=crate::workspace::list(app,target)?;let ids=b["files"].as_array().context("Select project input file IDs")?;for id in ids{if !m["entries"].as_array().unwrap().iter().any(|e|e["id"]==*id&&e["kind"]=="file"&&e["deleted"]!=true){bail!("Input file not found");}}
 if ids.len()>512||ids.iter().filter_map(|id|m["entries"].as_array().unwrap().iter().find(|e|e["id"]==*id)).map(|e|e["size"].as_u64().unwrap_or(0)).sum::<u64>()>LIMIT as u64 {bail!("Selected inputs exceed 512 files or 32 MB");}
 let interpreter=match FsPath::new(script).extension().and_then(|s|s.to_str()){Some("py")=>"python3",Some("js")|Some("mjs")|Some("cjs")=>"node",Some("sh")=>"sh",_=>bail!("Scripts must be .py, .js, .mjs, .cjs, or .sh")};let args=b["args"].as_array().context("Arguments must be a list")?;if args.len()>100||args.iter().any(|a|a.as_str().is_none_or(|s|s.len()>4096||s.contains('\0'))){bail!("Invalid script arguments");}
 let id=crate::library::id("run");let run=json!({"id":id,"root":app.data_dir,"chat_id":chat,"target":target,"skill_id":skill,"script":script,"script_text":info["text"],"hash":info["hash"],"interpreter":interpreter,"args":args,"files":ids,"input_paths":ids.iter().filter_map(|id|m["entries"].as_array().unwrap().iter().find(|e|e["id"]==*id)).map(|e|logical(&m,e).map(|p|p.to_string_lossy().into_owned())).collect::<Result<Vec<_>>>()?,"revision":m["revision"],"status":"approval_required"});runs().lock().unwrap().insert(id.clone(),run.clone());app.ui(json!({"action":"skill_run","chat_id":chat,"id":id}));Ok(run)
}
pub fn status(app:&App,id:&str)->Result<Value>{let r=runs().lock().unwrap().get(id).cloned().context("Run not found")?;if r["root"]!=json!(app.data_dir){bail!("Run not found");}Ok(r)}
pub async fn run_status(State(app):Shared,Path(id):Path<String>)->ApiResult{Ok(Json(status(&app,&id)?))}
fn set(id:&str,key:&str,value:Value){if let Some(r)=runs().lock().unwrap().get_mut(id){r[key]=value;}}
fn logical(m:&Value,e:&Value)->Result<PathBuf>{let mut parts=vec![e["name"].as_str().context("Missing filename")?.to_owned()];let mut parent=e["parent"].as_str().unwrap_or("");let mut seen=std::collections::HashSet::new();while !parent.is_empty(){if !seen.insert(parent){bail!("Invalid folder cycle");}let p=m["entries"].as_array().unwrap().iter().find(|e|e["id"]==parent).context("Missing folder")?;parts.push(p["name"].as_str().unwrap().into());parent=p["parent"].as_str().unwrap_or("");}parts.reverse();let path=parts.join("/");crate::workspace::safe_path(&path)?;Ok(PathBuf::from(path))}
async fn log(mut stream:impl tokio::io::AsyncRead+Unpin)->Result<String>{let mut out=Vec::new();let mut b=[0;8192];loop{let n=stream.read(&mut b).await?;if n==0{break;}let keep=n.min((256usize<<10).saturating_sub(out.len()));out.extend_from_slice(&b[..keep]);}Ok(String::from_utf8_lossy(&out).into_owned())}
async fn execute(app:Arc<App>,id:String,cancel:Arc<tokio::sync::Notify>)->Result<()> {
 let r=status(&app,&id)?;if r["status"]!="running"{bail!("Script cancelled before execution");}let target=r["target"].as_str().unwrap();let m=crate::workspace::list(&app,target)?;if m["revision"]!=r["revision"]{bail!("Project changed since approval was requested. Request a new run.");}let skill=r["skill_id"].as_str().unwrap();let script=r["script"].as_str().unwrap();let mut files=Vec::new();walk(&package(&app,skill)?,&package(&app,skill)?,&mut files)?;if json!(digest(&files))!=r["hash"]{bail!("Skill contents changed. Request a new run.");}
 let job=app.data_dir.join(".skill-runs").join(&id);let work=job.join("project");std::fs::create_dir_all(&work)?;let skill_dir=job.join("skill");for(p,b)in files{let path=skill_dir.join(p);std::fs::create_dir_all(path.parent().unwrap())?;std::fs::write(path,b)?;}
 let mut originals=serde_json::Map::new();for file in r["files"].as_array().unwrap(){let e=m["entries"].as_array().unwrap().iter().find(|e|e["id"]==*file).unwrap();let path=logical(&m,e)?;let data=crate::workspace::bytes(&app,target,e)?;let dest=work.join(&path);std::fs::create_dir_all(dest.parent().unwrap())?;std::fs::write(dest,&data)?;originals.insert(path.to_string_lossy().replace('\\',"/"),json!({"id":file,"data":STANDARD.encode(data)}));}
 let mut cmd=tokio::process::Command::new(r["interpreter"].as_str().unwrap());cmd.arg(skill_dir.join(script)).args(r["args"].as_array().unwrap().iter().map(|s|s.as_str().unwrap())).current_dir(&work).env_clear().env("PATH",std::env::var_os("PATH").unwrap_or_default()).env("HOME",&job).env("TMPDIR",&job).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
 #[cfg(unix)] {use std::os::unix::process::CommandExt;cmd.as_std_mut().process_group(0);}
 let mut child=cmd.spawn().context("Could not start interpreter. Install the required runtime yourself and request a new run.")?;
 let _process_group=ProcessGroup(child.id());
 let stdout=child.stdout.take().unwrap();let stderr=child.stderr.take().unwrap();
 let running=async {let (exit,out,err)=tokio::join!(child.wait(),log(stdout),log(stderr));Ok::<_,anyhow::Error>((exit?,out?,err?))};
 let (exit,out,err)=tokio::select!{r=tokio::time::timeout(std::time::Duration::from_secs(120),running)=>r.context("Script timed out after 120 seconds")??,_=cancel.notified()=>bail!("Script cancelled")};
 drop(_process_group);
 set(&id,"stdout",json!(out));set(&id,"stderr",json!(err));if !exit.success(){bail!("Script exited with {exit}");}
 let mut generated=Vec::new();walk(&work,&work,&mut generated)?;let mut changes=Vec::new();for(p,b)in generated{let data=STANDARD.encode(&b);let old=originals.remove(&p);if old.as_ref().is_some_and(|v|v["data"]==data){continue;}changes.push(json!({"path":p,"id":old.as_ref().map(|v|&v["id"]),"before":old.as_ref().and_then(|v|STANDARD.decode(v["data"].as_str().unwrap()).ok()).and_then(|v|String::from_utf8(v).ok()),"text":std::str::from_utf8(&b).ok(),"data":data}));}
 for(p,old)in originals{changes.push(json!({"path":p,"id":old["id"],"deleted":true,"before":String::from_utf8(STANDARD.decode(old["data"].as_str().unwrap())?).ok()}));}
 set(&id,"changes",json!(changes));set(&id,"status",json!("review_required"));Ok(())
}
pub async fn decide(State(app):Shared,Path(id):Path<String>,Json(b):Json<Value>)->ApiResult {
 let r=status(&app,&id)?;match b["action"].as_str().unwrap_or("") {
 "approve"=>{if r["status"]!="approval_required"{bail_api("Run is no longer awaiting approval")?;} // Atomic claim prevents duplicate execution.
 {let mut rs=runs().lock().unwrap();let stored=rs.get_mut(&id).unwrap();if stored["status"]!="approval_required"{bail_api("Run already started")?;}stored["status"]=json!("running");}
 let cancel=Arc::new(tokio::sync::Notify::new());cancellations().lock().unwrap().insert(id.clone(),cancel.clone());let app=app.clone();let id=id.clone();tokio::spawn(async move{if let Err(e)=execute(app.clone(),id.clone(),cancel).await{set(&id,"error",json!(format!("{e:#}")));set(&id,"status",json!("failed"));}cancellations().lock().unwrap().remove(&id);let _=std::fs::remove_dir_all(app.data_dir.join(".skill-runs").join(&id));});},
 "reject"|"cancel"=>{if let Some(c)=cancellations().lock().unwrap().get(&id){c.notify_one();}else{set(&id,"status",json!("rejected"));}},
 "apply"=>{if r["status"]!="review_required"{bail_api("No result awaiting review")?;}let result=crate::workspace::apply_skill(&app,r["target"].as_str().unwrap(),&r)?;set(&id,"status",json!("applied"));return Ok(Json(result));},
 _=>bail_api("Unknown run action")?,
 }Ok(Json(status(&app,&id)?))
}

// Scripts receive their own Unix process group so cancellation also stops spawned children.
struct ProcessGroup(Option<u32>);
impl Drop for ProcessGroup {fn drop(&mut self){
    #[cfg(unix)] if let Some(id)=self.0 {unsafe extern "C" {fn kill(pid:i32,sig:i32)->i32;}
        // SAFETY: this PID belongs to the process group created for this invocation.
        unsafe {kill(-(id as i32),9);}
    }
}}
