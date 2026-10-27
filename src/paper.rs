//! Managed, asynchronous TeX builds. Project blobs remain the source of truth.
use std::{collections::{HashMap, HashSet}, path::{Path as FsPath, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use anyhow::{bail, Context, Result};
use axum::{extract::{Path, State}, response::{IntoResponse, Response}, http::{header, StatusCode}, Json};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::{App, Shared, ApiResult, workspace};

pub const VERSION: &str = "0.17.0";
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();
/// Configured inside the independent server before handling compilation requests.
pub fn set_resources(path: PathBuf) { let _ = RESOURCES.set(path); }
fn tectonic_compiler() -> Result<PathBuf> {
    let arch = if cfg!(target_arch="aarch64") { "aarch64" } else { "x86_64" };
    let os = if cfg!(target_os="macos") { "apple-darwin" } else if cfg!(windows) { "pc-windows-msvc" } else { "unknown-linux-musl" };
    let name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
    let relative = PathBuf::from(format!("{arch}-{os}")).join(name);
    let mut roots = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/tectonic")];
    if let Some(root) = RESOURCES.get() { roots.insert(0, root.join("tectonic")); }
    roots.into_iter().map(|root|root.join(&relative)).find(|p|p.is_file())
        .context("Paper compiler is missing. Development builds: run python3 scripts/setup-tectonic.py. Packaged builds: reinstall Noctua.")
}
pub const PDFLATEX_VERSION: &str = "TeX Live 2026 / TinyTeX 2026.10";
#[derive(Clone, Copy, PartialEq, Debug)]
enum Compiler { Tectonic, PdfLatex }
impl Compiler {
    fn from_settings(settings:&Value)->Result<Self>{match settings["compiler"].as_str(){None|Some("tectonic")=>Ok(Self::Tectonic),Some("pdflatex")=>Ok(Self::PdfLatex),Some(_)=>bail!("Choose Tectonic or pdfLaTeX")}}
    fn id(self)->&'static str{match self{Self::Tectonic=>"tectonic",Self::PdfLatex=>"pdflatex"}}
    fn version(self)->&'static str{match self{Self::Tectonic=>VERSION,Self::PdfLatex=>PDFLATEX_VERSION}}
}
// Project settings are patched, not replaced: changing the main file must not
// silently reset the compiler (and choosing a compiler need not set a main file).
pub(crate) fn merge_settings(current:&Value,patch:&Value,entries:&[Value])->Result<Value>{
    let fields=patch.as_object().context("Paper settings must be an object")?;
    let mut result=if current.is_object(){current.clone()}else{json!({})};
    for (name,value) in fields {
        match name.as_str(){
            "main_file"=>{let id=value.as_str().context("Choose a main .tex file")?;anyhow::ensure!(entries.iter().any(|e|e["id"]==id&&e["kind"]=="file"&&e["deleted"]!=true&&e["name"].as_str().unwrap_or("").to_lowercase().ends_with(".tex")),"Choose an existing .tex file");},
            "compiler"=>{anyhow::ensure!(value.as_str().is_some_and(|s|["tectonic","pdflatex"].contains(&s)),"Choose Tectonic or pdfLaTeX");},
            "bibliographies"=>{anyhow::ensure!(value=="all"||value.as_array().is_some_and(|ids|ids.iter().all(|id|id.as_str().is_some_and(|id|entries.iter().any(|e|e["id"]==id&&e["kind"]=="file"&&e["deleted"]!=true&&e["name"].as_str().unwrap_or("").to_lowercase().ends_with(".bib"))))),"Choose all project bibliographies or existing .bib files");},
            "auto_compile"=>{anyhow::ensure!(value.is_boolean(),"Auto compile must be true or false");},
            _=>bail!("Unknown LaTeX setting: {name}"),
        }
        result[name]=value.clone();
    }
    Ok(result)
}
fn tex_program(name:&str)->Result<PathBuf>{
    let platform=if cfg!(target_os="macos"){"universal-darwin"}else if cfg!(windows){"windows"}else if cfg!(target_arch="aarch64"){"aarch64-linux"}else{"x86_64-linux"};
    let file=if cfg!(windows){format!("{name}.exe")}else{name.into()};
    let mut roots=vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/texlive")];
    if let Some(root)=RESOURCES.get(){roots.insert(0,root.join("texlive"));}
    roots.into_iter().map(|root|root.join("bin").join(platform).join(&file)).find(|p|p.is_file())
        .context("Bundled pdfLaTeX is missing. Development builds: run python3 scripts/setup-pdflatex.py. Packaged builds: reinstall Noctua.")
}
fn compiler(kind:Compiler)->Result<PathBuf>{match kind{Compiler::Tectonic=>tectonic_compiler(),Compiler::PdfLatex=>tex_program("pdflatex")}}
pub(crate) async fn compilers()->ApiResult{
    let entries=[Compiler::Tectonic,Compiler::PdfLatex].map(|kind|{
        let found=compiler(kind);json!({"id":kind.id(),"version":kind.version(),"available":found.is_ok(),"error":found.err().map(|e|e.to_string())})
    });
    Ok(Json(json!({"compilers":entries})))
}
#[derive(Clone)]
struct Input { path: String, source: PathBuf, id: String, blob: String }
#[derive(Clone)]
struct Snapshot { compiler: Compiler, files: Vec<Input>, bibliographies:Vec<String>, main: String, main_id: String, fingerprint: String, revision: Value }
fn logical_path(entries: &[Value], entry: &Value) -> Result<String> {
    let mut parts = vec![entry["name"].as_str().context("File name missing")?.to_owned()];
    let mut parent = entry["parent"].as_str().unwrap_or("");
    let mut seen = HashSet::new();
    while !parent.is_empty() {
        if !seen.insert(parent) { bail!("Folder cycle in paper project"); }
        let folder = entries.iter().find(|e|e["id"]==parent && e["kind"]=="folder" && e["deleted"]!=true).context("Paper folder is missing")?;
        parts.push(folder["name"].as_str().context("Folder name missing")?.to_owned());
        parent = folder["parent"].as_str().unwrap_or("");
    }
    parts.reverse(); let path=parts.join("/"); workspace::safe_path(&path)?; Ok(path)
}
fn snapshot(app: &App, target: &str, manifest: &Value) -> Result<Snapshot> {
    let kind=Compiler::from_settings(&manifest["paper"])?;
    let id=manifest["paper"]["main_file"].as_str().context("Choose a main .tex document first")?;
    let entries=manifest["entries"].as_array().context("Invalid project")?;
    let main=entries.iter().find(|e|e["id"]==id && e["kind"]=="file" && e["deleted"]!=true).context("The main document was removed. Choose another .tex file")?;
    anyhow::ensure!(main["name"].as_str().unwrap_or("").to_lowercase().ends_with(".tex"),"The main document must be a .tex file");
    let main_path=logical_path(entries,main)?;
    let mut files=Vec::new(); let mut names=HashSet::new(); let mut total=0u64;
    let mut hash=Sha256::new();hash.update(kind.id());hash.update(kind.version());hash.update("paper-pipeline-v4-auto-bibliography");hash.update(manifest["paper"]["bibliographies"].to_string());hash.update(id);hash.update(&main_path);
    let mut active:Vec<_>=entries.iter().filter(|e|e["kind"]=="file" && e["deleted"]!=true).collect();
    active.sort_by_key(|e|e["id"].as_str().unwrap_or(""));
    for e in active {
        let path=logical_path(entries,e)?;
        anyhow::ensure!(names.insert(path.to_lowercase()),"Paper filenames differ only by case: {path}");
        let source=workspace::file_path(app,target,e)?;let meta=std::fs::metadata(&source)?;
        total=total.saturating_add(meta.len());anyhow::ensure!(total<=512<<20,"Paper project exceeds the 512 MB build limit");
        hash.update(path.as_bytes());hash.update([0]);
        if let Some(blob)=e["blob"].as_str(){hash.update(blob);}else{
            // Legacy attachments are immutable through Noctua; avoid rereading large
            // videos on every preview-status poll. Skill edits migrate them to blobs.
            hash.update(e["legacy"].as_str().unwrap_or(""));hash.update(meta.len().to_le_bytes());
            hash.update(meta.modified()?.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos().to_le_bytes());
        }
        files.push(Input{path,source,id:e["id"].as_str().unwrap_or("").into(),blob:e["blob"].as_str().unwrap_or("").into()});
    }
    let selection=manifest["paper"]["bibliographies"].as_array();
    let bibliographies=files.iter().filter(|f|f.path.to_lowercase().ends_with(".bib")&&selection.is_none_or(|ids|ids.iter().any(|id|id==&f.id))).map(|f|f.path.clone()).collect();
    Ok(Snapshot{compiler:kind,files,bibliographies,main:main_path,main_id:id.into(),fingerprint:format!("{:x}",hash.finalize()),revision:manifest["revision"].clone()})
}
struct Job { status: Value, pending: Option<Snapshot>, running: bool, cancel: Arc<AtomicBool>, last: Option<Value> }
impl Default for Job { fn default()->Self {Self{status:json!({"state":"idle"}),pending:None,running:false,cancel:Arc::new(AtomicBool::new(false)),last:None}} }
static JOBS:OnceLock<Mutex<HashMap<PathBuf,Job>>>=OnceLock::new();
fn jobs()-> &'static Mutex<HashMap<PathBuf,Job>> {JOBS.get_or_init(||Mutex::new(HashMap::new()))}
pub(crate) fn busy()->bool{jobs().lock().unwrap().values().any(|job|job.running||job.pending.is_some())}
fn cache(app:&App,target:&str)->Result<PathBuf>{Ok(workspace::dir(app,target)?.join(".workspace/paper"))}
fn load_last(root:&FsPath)->Option<Value>{let v:Value=serde_json::from_slice(&std::fs::read(root.join("last.json")).ok()?).ok()?;let f=v["artifact"].as_str().or_else(||v["fingerprint"].as_str())?;if f.len()!=64||!f.bytes().all(|b|b.is_ascii_hexdigit())||!root.join(format!("{f}.pdf")).is_file(){return None;}Some(v)}
fn view(job:&Job)->Value{let mut v=job.status.clone();v["last_success"]=job.last.clone().unwrap_or(Value::Null);v}

pub(crate) async fn status(State(app):Shared,Path(target):Path<String>)->ApiResult{
    let root=cache(&app,&target)?;let manifest=workspace::paper_manifest(&app,&target)?;
    let current=snapshot(&app,&target,&manifest);
    let mut map=jobs().lock().unwrap();let job=map.entry(root.clone()).or_default();
    if job.last.is_none(){job.last=load_last(&root);}
    let mut v=view(job);v["compiler"]=json!(Compiler::from_settings(&manifest["paper"])?.id());v["current_revision"]=manifest["revision"].clone();
    if job.running{v["log"]=json!(read_log(&root.join("build.log")));}
    match current {Ok(s)=>{v["current_fingerprint"]=json!(s.fingerprint);v["main_file"]=json!(s.main_id);v["stale"]=json!(v["last_success"]["fingerprint"]!=v["current_fingerprint"]);},Err(e)=>{v["configuration_error"]=json!(e.to_string());v["stale"]=json!(true);}}
    Ok(Json(v))
}
pub(crate) async fn start(State(app):Shared,Path(target):Path<String>,Json(body):Json<Value>)->ApiResult{
    let manifest=workspace::paper_manifest(&app,&target)?;
    if body["revision"]!=manifest["revision"] {return Err(crate::Status(StatusCode::CONFLICT,"Project changed. Save or reload before compiling.".into()).into());}
    let source=snapshot(&app,&target,&manifest)?;let root=cache(&app,&target)?;compiler(source.compiler)?;
    let mut map=jobs().lock().unwrap();let job=map.entry(root.clone()).or_default();
    if job.last.is_none(){job.last=load_last(&root);}
    // Identical requests from other windows share one build.
    if job.running && !job.cancel.load(Ordering::SeqCst) && (job.pending.as_ref().map(|s|s.fingerprint.as_str())==Some(&source.fingerprint) || (job.pending.is_none() && job.status["fingerprint"]==source.fingerprint)) {return Ok(Json(view(job)));}
    if !job.running && job.last.as_ref().is_some_and(|last|last["fingerprint"]==source.fingerprint) && body["force"]!=true {
        job.status=json!({"state":"success","fingerprint":source.fingerprint,"main_file":source.main_id});return Ok(Json(view(job)));
    }
    job.pending=Some(source);
    if !job.running {job.running=true;job.cancel=Arc::new(AtomicBool::new(false));job.status=json!({"state":"queued"});
        let root=root.clone();tokio::spawn(async move{worker(root).await;});
    }else{job.status["queued"]=json!(true);}
    Ok(Json(view(job)))
}
pub(crate) async fn cancel(State(app):Shared,Path(target):Path<String>)->ApiResult{
    let root=cache(&app,&target)?;let mut map=jobs().lock().unwrap();let job=map.entry(root).or_default();job.pending=None;job.cancel.store(true,Ordering::SeqCst);if job.running{job.status["state"]=json!("cancelling");}Ok(Json(view(job)))
}
async fn worker(root:PathBuf){
    loop {
        let (source,cancel)={let mut map=jobs().lock().unwrap();let job=map.get_mut(&root).unwrap();
            let Some(s)=job.pending.take() else {if job.cancel.load(Ordering::SeqCst){job.status["state"]=json!("cancelled");}job.running=false;return;};
            job.cancel=Arc::new(AtomicBool::new(false));job.status=json!({"state":"building","fingerprint":s.fingerprint,"main_file":s.main_id,"revision":s.revision});(s,job.cancel.clone())};
        let began=std::time::Instant::now();let result=compile(&root,&source,&cancel).await;
        let mut map=jobs().lock().unwrap();let job=map.get_mut(&root).unwrap();
        let elapsed=began.elapsed().as_millis() as u64;
        match result {
            Ok(log)=>{
                // Superseded builds never become the displayed artifact.
                if job.pending.is_none() && !cancel.load(Ordering::SeqCst){
                    let mut last=json!({"fingerprint":source.fingerprint,"main_file":source.main_id,"revision":source.revision,"elapsed_ms":elapsed,"compiler":source.compiler.id()});
                    match publish(&root,&mut last,&source) {Ok(())=>{job.last=Some(last);job.status=json!({"state":"success","fingerprint":source.fingerprint,"main_file":source.main_id,"log":log,"elapsed_ms":elapsed});},Err(e)=>{job.status=json!({"state":"error","message":e.to_string()});}}
                }
            },
            Err(e)=>{job.status=json!({"state":if cancel.load(Ordering::SeqCst){"cancelled"}else{"error"},"fingerprint":source.fingerprint,"main_file":source.main_id,"message":e.to_string(),"log":read_log(&root.join("build.log")).replace(".noctua-paper.tex",&source.main),"elapsed_ms":elapsed});}
        }
    }
}
fn publish(root:&FsPath,last:&mut Value,s:&Snapshot)->Result<()> {
    let bytes=std::fs::read(root.join("out/.noctua-paper.pdf"))?;
    let artifact=format!("{:x}",Sha256::digest(&bytes));last["artifact"]=json!(artifact);
    let dest=root.join(format!("{artifact}.pdf"));
    if !dest.exists(){let temp=root.join("publishing.tmp");std::fs::write(&temp,bytes)?;std::fs::rename(temp,&dest)?;}
    let previous=load_last(root).and_then(|v|v["artifact"].as_str().or_else(||v["fingerprint"].as_str()).map(str::to_owned));
    let previous_sync=load_last(root).and_then(|v|v["fingerprint"].as_str().map(str::to_owned));
    publish_sync(root,last,s)?;
    crate::notes::write_atomic(&root.join("last.json"),&last.to_string())?;
    if let Ok(entries)=std::fs::read_dir(root.join("sync")){for e in entries.flatten(){let name=e.file_name().to_string_lossy().into_owned();if name!=s.fingerprint&&Some(&name)!=previous_sync.as_ref(){let _=std::fs::remove_dir_all(e.path());}}}
    for entry in std::fs::read_dir(root)?.flatten(){let path=entry.path();if path.extension().is_some_and(|e|e=="pdf")&&path!=dest&&previous.as_ref().is_none_or(|p|path!=root.join(format!("{p}.pdf"))){let _=std::fs::remove_file(path);}}
    Ok(())
}
fn read_log(path:&FsPath)->String {
    use std::io::{Read,Seek,SeekFrom};
    let Ok(mut file)=std::fs::File::open(path) else{return String::new()};
    let len=file.metadata().map(|m|m.len()).unwrap_or(0);let _=file.seek(SeekFrom::Start(len.saturating_sub(128*1024)));
    let mut bytes=Vec::new();let _=file.take(128*1024).read_to_end(&mut bytes);String::from_utf8_lossy(&bytes).into_owned()
}
fn directory_size(path:&FsPath)->u64 {std::fs::read_dir(path).into_iter().flatten().flatten().map(|e|e.metadata().map(|m|if m.is_dir(){directory_size(&e.path())}else{m.len()}).unwrap_or(0)).sum()}
fn automatic_bibliography_source(source:&str)->String{
    // Keep line numbers intact for SyncTeX. Only the disposable build input changes.
    let prefix=concat!(
        r"\newif\ifnoctuabibused\newif\ifnoctuabibstyle\newif\ifnoctuacited",
        r"\def\noctuatrackcitation#1{\ifcsname#1\endcsname\AddToHook{cmd/#1/before}{\global\noctuacitedtrue}\fi}",
        r"\let\noctuaoriginalstyle\bibliographystyle",
        r"\renewcommand{\bibliographystyle}[1]{\global\noctuabibstyletrue\noctuaoriginalstyle{#1}}",
        r"\AtBeginDocument{\noctuatrackcitation{cite}\noctuatrackcitation{nocite}",
        r"\noctuatrackcitation{citep}\noctuatrackcitation{citet}\noctuatrackcitation{citealt}\noctuatrackcitation{citealp}",
        r"\noctuatrackcitation{citeauthor}\noctuatrackcitation{citeyear}\noctuatrackcitation{citeyearpar}",
        r"\noctuatrackcitation{Citep}\noctuatrackcitation{Citet}\noctuatrackcitation{citenum}",
        r"\let\noctuaoriginalbib\bibliography",
        r"\renewcommand{\bibliography}[1]{\ifnoctuacited\ifnoctuabibused\else\global\noctuabibusedtrue",
        r"\ifnoctuabibstyle\else\bibliographystyle{plain}\fi\noctuaoriginalbib{.noctua-project-references}\fi\fi}}",
        r"\AtEndDocument{\ifnoctuacited\ifnoctuabibused\else\bibliography{}\fi\fi}"
    );
    format!("{prefix}{source}")
}
async fn compile(root:&FsPath,s:&Snapshot,cancel:&AtomicBool)->Result<String>{
    let executable=compiler(s.compiler)?;
    let work=root.join("work");let out=root.join("out");
    // Clear removed inputs; keep only bounded intermediates from this main document.
    if work.exists(){std::fs::remove_dir_all(&work)?;}
    let build_id=format!("{}:{}",s.main_id,s.compiler.id());
    if std::fs::read_to_string(root.join("main-id")).ok().as_deref()!=Some(&build_id) && out.exists(){std::fs::remove_dir_all(&out)?;}
    std::fs::create_dir_all(&work)?;std::fs::create_dir_all(&out)?;std::fs::write(root.join("main-id"),&build_id)?;
    for input in &s.files {let dest=work.join(&input.path);std::fs::create_dir_all(dest.parent().unwrap())?;std::fs::copy(&input.source,&dest)?;
        if s.compiler==Compiler::PdfLatex {std::fs::create_dir_all(out.join(&input.path).parent().unwrap())?;}
        // TEMPORARY: remove with bibliography::tectonic_string_spacing once an
        // upgraded compiler passes the original @string spacing regression.
        // The explicit version gate prevents carrying this into newer engines
        // without reassessment. Only disposable copies change, never blobs.
        if s.compiler==Compiler::Tectonic && VERSION == "0.17.0" && dest.extension().is_some_and(|e|e.eq_ignore_ascii_case("bib")) {
            if let Ok(source) = std::fs::read_to_string(&dest) {
                if let Ok(patched) = crate::bibliography::tectonic_string_spacing(&source) {
                    if patched != source { std::fs::write(&dest,patched)?; }
                }
            }
        }
    }
    // Tectonic anchors its input provider at the primary file's directory.
    // A private root copy gives every main file the same project-root semantics.
    if s.bibliographies.is_empty(){std::fs::copy(work.join(&s.main),work.join(".noctua-paper.tex"))?;}else{
        let mut bibliography=String::new();for path in &s.bibliographies{bibliography.push_str(&std::fs::read_to_string(work.join(path)).with_context(||format!("Bibliography must be UTF-8: {path}"))?);bibliography.push('\n');}
        std::fs::write(work.join(".noctua-project-references.bib"),bibliography)?;
        let source=std::fs::read_to_string(work.join(&s.main))?;
        anyhow::ensure!(!source.contains("{biblatex}"),"Automatic project bibliographies support BibTeX/natbib, not biblatex");
        std::fs::write(work.join(".noctua-paper.tex"),automatic_bibliography_source(&source))?;
    }
    // Never let an empty successful run reuse an earlier engine output.
    let native_pdf=out.join("noctua-paper.pdf");if native_pdf.exists(){std::fs::remove_file(native_pdf)?;}
    for name in ["noctua-paper.synctex.gz","noctua-paper.synctex",".noctua-paper.synctex.gz",".noctua-paper.synctex"]{let _=std::fs::remove_file(out.join(name));}
    let pdf=out.join(".noctua-paper.pdf");if pdf.exists(){std::fs::remove_file(&pdf)?;}
    use std::io::Write;
    let mut log=std::fs::File::create(root.join("build.log"))?;
    writeln!(log,"Compiler: {} ({})",s.compiler.id(),s.compiler.version())?;
    let began=std::time::Instant::now();
    if s.compiler==Compiler::Tectonic {
        let mut command=tokio::process::Command::new(&executable);
        command.args(["-X","compile","--untrusted","--keep-intermediates","--keep-logs","--print","--synctex"])
            .arg("--outdir").arg(&out).arg("./.noctua-paper.tex").current_dir(&work).env("TECTONIC_UNTRUSTED_MODE","1");
        run_command(command,root,&out,&log,cancel,began).await?;
    } else {
        // No shell or latexmkrc evaluation: Noctua owns the bounded TeX/BibTeX
        // pass loop. Compilation uses only the bundled distribution, not PATH.
        for pass in 0..6 {
            let before=aux_state(&out)?;
            let mut command=tokio::process::Command::new(&executable);
            command.args(["-synctex=1","-no-shell-escape","-interaction=nonstopmode","-halt-on-error","-file-line-error","-recorder","-fmt=pdflatex","-jobname=noctua-paper"])
                .arg(format!("-output-directory={}",out.display())).arg("./.noctua-paper.tex").current_dir(&work)
                .env("openout_any","p").env("shell_escape","f");
            run_command(command,root,&out,&log,cancel,began).await?;
            if pass==0 && before_bibtex(&out)? {
                let mut bib=tokio::process::Command::new(tex_program("bibtex")?);
                // Default search paths remain after the empty final component.
                let inputs=std::env::join_paths([work.as_path(),FsPath::new("")])?;
                bib.arg("noctua-paper").current_dir(&out).env("BIBINPUTS",&inputs).env("BSTINPUTS",&inputs).env("openout_any","p");
                run_command(bib,root,&out,&log,cancel,began).await?;
                continue;
            }
            if before==aux_state(&out)? {break;}
            if pass==5 {writeln!(log,"Warning: references have not stabilized after six pdfLaTeX passes; inspect the PDF and log.")?;}
        }
        std::fs::copy(out.join("noctua-paper.pdf"),&pdf).context("pdfLaTeX produced no PDF")?;
    }
    anyhow::ensure!(pdf.is_file(),"Compiler produced no PDF");
    Ok(read_log(&root.join("build.log")).replace(".noctua-paper.tex",&s.main))
}
fn aux_files(root:&FsPath)->Result<Vec<PathBuf>>{
    let mut files=Vec::new();
    for e in std::fs::read_dir(root)? {let e=e?;let path=e.path();if e.file_type()?.is_dir(){files.extend(aux_files(&path)?);}else if path.extension().and_then(|e|e.to_str()).is_some_and(|e|["aux","toc","out","lof","lot"].contains(&e)){files.push(path);}}
    files.sort();Ok(files)
}
fn aux_state(root:&FsPath)->Result<Vec<u8>>{let mut hash=Sha256::new();for p in aux_files(root)?{hash.update(p.to_string_lossy().as_bytes());hash.update(std::fs::read(p)?);}Ok(hash.finalize().to_vec())}
fn before_bibtex(root:&FsPath)->Result<bool>{for p in aux_files(root)?{if p.extension().is_some_and(|e|e=="aux")&&std::fs::read_to_string(p)?.contains("\\bibdata{"){return Ok(true);}}Ok(false)}
async fn run_command(mut command:tokio::process::Command,root:&FsPath,out:&FsPath,log:&std::fs::File,cancel:&AtomicBool,began:std::time::Instant)->Result<()> {
    anyhow::ensure!(!cancel.load(Ordering::SeqCst),"Compilation stopped");
    command.stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log.try_clone()?).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child=command.spawn().context("Could not launch the paper compiler")?;
    loop {
        if cancel.load(Ordering::SeqCst){let _=child.kill().await;bail!("Compilation stopped");}
        if began.elapsed()>Duration::from_secs(300){let _=child.kill().await;bail!("Compilation timed out after five minutes");}
        if directory_size(out)>128<<20 {let _=child.kill().await;let _=std::fs::remove_dir_all(out);bail!("Compiler output exceeded 128 MB");}
        if std::fs::metadata(root.join("build.log")).map(|m|m.len()>8<<20).unwrap_or(false){let _=child.kill().await;bail!("Compiler log exceeded 8 MB");}
        if let Some(status)=child.try_wait()?{anyhow::ensure!(status.success(),"Compilation failed. Check the compiler log below.");break;}
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

pub(crate) async fn pdf(State(app):Shared,Path((target,fingerprint)):Path<(String,String)>)->Result<Response,crate::ApiError>{
    if fingerprint.len()!=64||!fingerprint.bytes().all(|b|b.is_ascii_hexdigit()){return Err(anyhow::anyhow!("Invalid PDF identifier").into());}
    let root=cache(&app,&target)?;let bytes=tokio::fs::read(root.join(format!("{fingerprint}.pdf"))).await?;
    Ok((StatusCode::OK,[(header::CONTENT_TYPE,"application/pdf"),(header::CONTENT_DISPOSITION,"inline; filename=paper.pdf"),(header::CACHE_CONTROL,"private, max-age=31536000, immutable")],bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn sync_query_copies_each_format_and_cleans_up_without_changing_original() {
        for suffix in ["synctex.gz", "synctex"] {
            let root = tempfile::tempdir().unwrap();
            let folder = root.path().join("nested".repeat(20)).join("f".repeat(64));
            std::fs::create_dir_all(&folder).unwrap();
            let original = folder.join(format!("{}.{}", "a".repeat(64), suffix));
            let bytes = b"immutable mapping bytes";
            std::fs::write(&original, bytes).unwrap();
            let staged;
            {
                let first = stage_sync_query(&folder, &"a".repeat(64)).unwrap();
                let second = stage_sync_query(&folder, &"a".repeat(64)).unwrap();
                assert_ne!(first.path(), second.path());
                staged = first.path().to_owned();
                assert_eq!(std::fs::read(staged.join(format!("map.{suffix}"))).unwrap(), bytes);
                assert!(!staged.starts_with(&folder));
            }
            assert!(!staged.exists());
            assert_eq!(std::fs::read(original).unwrap(), bytes);
            assert!(stage_sync_query(&folder, "missing").is_err());
        }
    }
    #[test] fn project_settings_merge_without_resetting_other_choices(){
        let entries=vec![json!({"id":"main","kind":"file","name":"main.tex"}),json!({"id":"bib","kind":"file","name":"refs.bib"})];
        let original=json!({"main_file":"main","compiler":"pdflatex","auto_compile":false});
        assert_eq!(merge_settings(&json!({}),&json!({"bibliographies":"all"}),&entries).unwrap()["bibliographies"],"all");
        assert_eq!(merge_settings(&json!({}),&json!({"bibliographies":["bib"]}),&entries).unwrap()["bibliographies"],json!(["bib"]));
        assert!(merge_settings(&json!({}),&json!({"bibliographies":["main"]}),&entries).is_err());

        assert_eq!(merge_settings(&original,&json!({"main_file":"main"}),&entries).unwrap(),original);
        let changed=merge_settings(&original,&json!({"compiler":"tectonic"}),&entries).unwrap();
        assert_eq!(changed["main_file"],"main");assert_eq!(changed["auto_compile"],false);
        for patch in [json!({"compiler":"latexmk"}),json!({"auto_compile":"yes"}),json!({"main_file":"missing"}),json!({"arguments":"--shell-escape"})] {assert!(merge_settings(&original,&patch,&entries).is_err());}
        assert_eq!(Compiler::from_settings(&json!({})).unwrap(),Compiler::Tectonic);
    }
    #[test] fn logical_paths_follow_tree_and_reject_cycles(){
        let mut entries=vec![json!({"id":"a","name":"chapters","kind":"folder","parent":""}),json!({"id":"b","name":"intro.tex","kind":"file","parent":"a"})];
        assert_eq!(logical_path(&entries,&entries[1]).unwrap(),"chapters/intro.tex");
        entries[0]["parent"]=json!("a");assert!(logical_path(&entries,&entries[1]).is_err());
        entries[0]["parent"]=json!("");entries[1]["name"]=json!("../escape.tex");assert!(logical_path(&entries,&entries[1]).is_err());
    }
}

// SyncTeX data belongs to a particular successful build, not the mutable out/
// directory. Keeping it beside immutable source IDs prevents failed/new builds
// from silently sending clicks in the last-good PDF to unrelated source lines.
fn publish_sync(root:&FsPath,last:&mut Value,s:&Snapshot)->Result<()> {
    let stem=if s.compiler==Compiler::PdfLatex{"noctua-paper"}else{".noctua-paper"};
    let compressed=root.join("out").join(format!("{stem}.synctex.gz"));
    let plain=root.join("out").join(format!("{stem}.synctex"));
    let (input,suffix)=if compressed.is_file(){(compressed,"synctex.gz")}else if plain.is_file(){(plain,"synctex")}else{return Ok(());};
    let folder=root.join("sync").join(&s.fingerprint);std::fs::create_dir_all(&folder)?;
    std::fs::copy(input,folder.join(format!("{}.{}",last["artifact"].as_str().unwrap(),suffix)))?;
    let files:Vec<Value>=s.files.iter().map(|f|json!({"id":f.id,"path":f.path,"blob":f.blob})).collect();
    crate::notes::write_atomic(&folder.join("sources.json"),&json!({"artifact":last["artifact"],"main":s.main,"files":files}).to_string())?;
    last["synctex"]=json!(true);Ok(())
}

// Windows SyncTeX cannot read our deeply nested sidecars even when passed a
// basename with cwd set to their directory. CI probes confirmed the same bytes
// work from a short temporary directory for both engines and both map formats.
// Copy only the immutable map, not the PDF or project sources. SyncTeX needs the
// output stem to locate its sidecar, but does not open the PDF for a query.
// TempDir provides unique directories for concurrent requests and scoped cleanup
// on success/error. Keep the guard alive until the subprocess has finished.
fn stage_sync_query(folder: &FsPath, artifact: &str) -> Result<tempfile::TempDir> {
    let temp = tempfile::Builder::new().prefix("ns-").tempdir()?;
    for suffix in ["synctex.gz", "synctex"] {
        let source = folder.join(format!("{artifact}.{suffix}"));
        if source.is_file() {
            std::fs::copy(source, temp.path().join(format!("map.{suffix}")))?;
            return Ok(temp);
        }
    }
    bail!("Source mapping is missing; recompile this paper")
}

pub(crate) async fn source_location(State(app):Shared,Path(target):Path<String>,Json(body):Json<Value>)->ApiResult {
    Ok(Json(query_source(&app,&target,&body).await?))
}
async fn query_source(app:&App,target:&str,body:&Value)->Result<Value>{
    let fingerprint=body["fingerprint"].as_str().context("Missing build identifier")?;
    anyhow::ensure!(fingerprint.len()==64&&fingerprint.bytes().all(|b|b.is_ascii_hexdigit()),"Invalid build identifier");
    let page=body["page"].as_u64().filter(|n|*n>0&&*n<=100_000).context("Invalid page")?;
    let x=body["x"].as_f64().filter(|v|v.is_finite()&&*v>=0.0&&*v<=100_000.0).context("Invalid PDF coordinate")?;
    let y=body["y"].as_f64().filter(|v|v.is_finite()&&*v>=0.0&&*v<=100_000.0).context("Invalid PDF coordinate")?;
    let root=cache(&app,&target)?;let folder=root.join("sync").join(fingerprint);
    let map:Value=serde_json::from_slice(&std::fs::read(folder.join("sources.json")).context("Recompile this paper to enable PDF-to-source navigation")?)?;
    let artifact=map["artifact"].as_str().context("Missing PDF mapping")?;
    anyhow::ensure!(artifact.len()==64&&artifact.bytes().all(|b|b.is_ascii_hexdigit()),"Invalid PDF mapping");
    let mut command=tokio::process::Command::new(tex_program("synctex")?);
    // Never pass -x or inherit an editor command: this subprocess only reports
    // locations. No source-provided path is ever opened by this endpoint.
    let query = stage_sync_query(&folder, artifact)?;
    command.args(["edit","-o"]).arg(format!("{page}:{x}:{y}:map.pdf"))
        .env_remove("SYNCTEX_EDITOR").current_dir(query.path()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let output=tokio::time::timeout(Duration::from_secs(5),command.output()).await.context("Source lookup timed out")??;
    anyhow::ensure!(output.status.success(),"No source location found here; try nearby PDF text");
    let text=String::from_utf8_lossy(&output.stdout);
    let manifest=workspace::paper_manifest(&app,&target)?;
    let mut input=None;
    for line in text.lines(){
        if let Some(value)=line.strip_prefix("Input:"){input=Some(value.trim());}
        if let (Some(file),Some(number))=(input,line.strip_prefix("Line:").and_then(|n|n.trim().parse::<u64>().ok())) {
            if number==0 {continue;}
            let normalized=file.replace('\\',"/");let normalized=normalized.trim_start_matches("//?/");
            // Engines may canonicalize /var to /private/var on macOS. Resolve
            // only our known cache root, never a path supplied by SyncTeX.
            let work=root.canonicalize()?.join("work").to_string_lossy().replace('\\',"/");
            let lexical=root.join("work").to_string_lossy().replace('\\',"/");
            let relative=normalized.strip_prefix(&(work.trim_start_matches("//?/").to_owned()+"/")).or_else(||normalized.strip_prefix(&(lexical+"/"))).unwrap_or(normalized).trim_start_matches("./");
            let relative=if relative==".noctua-paper.tex"{map["main"].as_str().unwrap_or("")}else{relative};
            if let Some(record)=map["files"].as_array().and_then(|fs|fs.iter().find(|f|f["path"]==relative)) {
                let entry=manifest["entries"].as_array().and_then(|fs|fs.iter().find(|f|f["id"]==record["id"]&&f["deleted"]!=true)).context("Source file was removed; recompile the paper")?;
                anyhow::ensure!(record["blob"].as_str().is_some_and(|s|!s.is_empty())&&entry["blob"]==record["blob"],"Source changed since this PDF was built; recompile before navigating");
                return Ok(json!({"file_id":entry["id"],"line":number,"path":logical_path(manifest["entries"].as_array().unwrap(),entry)?,"blob":entry["blob"]}));
            }
        }
    }
    Err(anyhow::anyhow!("This PDF position has no editable project source (it may come from a generated bibliography or a compiler package)").into())
}
