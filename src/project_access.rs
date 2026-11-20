//! Persistent grants are issued only by authenticated user-facing endpoints.
use crate::{ApiResult, App, Shared};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
static GATE: Mutex<()> = Mutex::new(());
fn path(app: &App, target: &str) -> Result<PathBuf> {
    Ok(crate::linked::metadata_dir(app, target)?.join("grants.json"))
}
pub fn grants(app: &App, target: &str) -> Result<Vec<Value>> {
    let p = path(app, target)?;
    match std::fs::read(p) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}
pub fn allowed(app: &App, target: &str, key: &str) -> Result<bool> {
    let root = crate::linked::root(app, target)?;
    Ok(grants(app, target)?
        .iter()
        .any(|g| g["key"] == key && g["root"] == json!(root)))
}
pub fn remember(app: &App, target: &str, key: &str, label: &str) -> Result<()> {
    let _g = GATE.lock().unwrap();
    let root = crate::linked::root(app, target)?;
    let mut all = grants(app, target)?;
    all.retain(|g| g["key"] != key);
    all.push(json!({"key":key,"label":label,"root":root}));
    let p = path(app, target)?;
    std::fs::create_dir_all(p.parent().unwrap())?;
    crate::notes::write_atomic(&p, &serde_json::to_string(&all)?)?;
    Ok(())
}
pub fn file_key(args: &Value) -> String {
    json!([
        "file",
        args["folder_id"],
        args["op"]
            .as_str()
            .filter(|s| *s == "create" || *s == "folder")
            .map(|_| json!([args["parent"], args["name"]]))
            .unwrap_or_else(|| args["id"].clone())
    ])
    .to_string()
}
pub async fn list(State(app): Shared, Path(target): Path<String>) -> ApiResult {
    Ok(Json(json!({"grants":grants(&app,&target)?})))
}
pub async fn revoke(
    State(app): Shared,
    Path(target): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    let _g = GATE.lock().unwrap();
    let mut all = grants(&app, &target)?;
    all.retain(|g| g["key"] != body["key"]);
    let p = path(&app, &target)?;
    std::fs::create_dir_all(p.parent().unwrap())?;
    crate::notes::write_atomic(&p, &serde_json::to_string(&all)?)?;
    drop(_g);
    cancel_target(&app, &target);
    crate::chat_approval::revoke_linked(&app, &target);
    Ok(Json(json!({"grants":all})))
}
pub fn check_scope(app: &App, chat: Option<&str>, target: &str) -> Result<()> {
    let context =
        crate::skills::project_context(app, chat.context("An active project chat is required")?)?;
    ensure!(
        crate::linked::collection(&context) == crate::linked::collection(target),
        "Linked folder belongs to another collection"
    );
    crate::linked::root(app, target)?;
    Ok(())
}

struct Job {
    owner: PathBuf,
    target: String,
    chat: String,
    args: Value,
    status: Value,
    child: Option<Arc<Mutex<std::process::Child>>>,
    created: Instant,
}
static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    JOBS.get_or_init(Default::default)
}
fn stop(job: &mut Job) {
    if let Some(child) = &job.child {
        let mut c = child.lock().unwrap();
        #[cfg(unix)]
        unsafe {
            libc::kill(-(c.id() as i32), libc::SIGKILL);
        }
        let _ = c.kill();
    }
    job.status = json!({"state":"cancelled"});
}
pub fn cancel_target(app: &App, target: &str) {
    for j in jobs()
        .lock()
        .unwrap()
        .values_mut()
        .filter(|j| j.owner == app.data_dir && j.target == target)
    {
        stop(j);
    }
}
pub fn cancel_chat(app: &App, chat: &str) {
    for job in jobs().lock().unwrap().values_mut().filter(|j| {
        j.owner == app.data_dir
            && j.chat == chat
            && (j.status["state"] == "running" || j.status["state"] == "approval_required")
    }) {
        stop(job);
    }
}
pub fn close_all() {
    for j in jobs().lock().unwrap().values_mut() {
        stop(j);
    }
}
pub fn busy() -> bool {
    jobs()
        .lock()
        .unwrap()
        .values()
        .any(|j| j.status["state"] == "running")
}
fn command_key(args: &Value) -> String {
    format!("command:{:x}", Sha256::digest(args.to_string().as_bytes()))
}
fn repeatable(args: &Value) -> bool {
    // Shells, interpreters and executable project scripts can change behavior
    // without changing argv. Their approvals are deliberately single-use.
    let exe = args["executable"].as_str().unwrap_or("");
    let a = args["args"].as_array();
    exe == "/usr/bin/git"
        && a.and_then(|a| a.first())
            .and_then(Value::as_str)
            .is_some_and(|s| {
                [
                    "status", "diff", "log", "show", "fetch", "pull", "add", "commit",
                ]
                .contains(&s)
            })
        && a.is_some_and(|args| {
            !args.iter().filter_map(Value::as_str).any(|arg| {
                arg.starts_with('+')
                    || [
                        "--force",
                        "--force-with-lease",
                        "--hard",
                        "--amend",
                        "--delete",
                        "--prune",
                        "--output",
                    ]
                    .iter()
                    .any(|flag| arg == *flag || arg.starts_with(&format!("{flag}=")))
                    || ["-f", "-D"].contains(&arg)
            })
        })
        && args["repository_scope"] != true
}
pub fn request(app: &App, chat: Option<&str>, args: &Value, mode: &str) -> Result<Value> {
    ensure!(mode != "plan", "Plan mode cannot run project commands");
    let target = args["folder_id"]
        .as_str()
        .context("Linked workspace required")?;
    check_scope(app, chat, target)?;
    ensure!(
        cfg!(target_os = "macos"),
        "Agent command confinement requires macOS"
    );
    let exe = args["executable"]
        .as_str()
        .context("Absolute executable required")?;
    ensure!(
        std::path::Path::new(exe).is_absolute(),
        "Use an absolute executable path"
    );
    ensure!(
        args["args"].as_array().is_some_and(|a| a.len() <= 128
            && a.iter()
                .all(|v| v.as_str().is_some_and(|s| s.len() <= 8192))),
        "Provide at most 128 string arguments"
    );
    let root = crate::linked::root(app, target)?;
    let cwd = args["cwd"].as_str().filter(|s| *s != ".").unwrap_or("");
    ensure!(
        args["repository_scope"] != true || args["write"] == true,
        "Repository write scope requires write=true"
    );
    if !cwd.is_empty() {
        ensure!(
            crate::linked::resolve(&root, cwd)?.is_dir(),
            "Working directory is unavailable"
        );
    }
    let normalized = json!({"folder_id":target,"executable":exe,"args":args["args"],"cwd":cwd,"write":args["write"]==true,"network":args["network"]==true,"repository_scope":args["repository_scope"]==true,"root":root});
    let id = uuid::Uuid::new_v4().to_string();
    let key = command_key(&normalized);
    let remembered = repeatable(&normalized) && allowed(app, target, &key)?;
    let mut all = jobs().lock().unwrap();
    all.retain(|_, j| {
        j.created.elapsed() < Duration::from_secs(86400) || j.status["state"] == "running"
    });
    ensure!(
        all.len() < 128,
        "Too many command requests; restart after active commands finish"
    );
    all.insert(
        id.clone(),
        Job {
            owner: app.data_dir.clone(),
            target: target.into(),
            chat: chat.unwrap().into(),
            args: normalized.clone(),
            status: json!({"state":"approval_required"}),
            child: None,
            created: Instant::now(),
        },
    );
    drop(all);
    if remembered {
        start(app, &id)?;
    } else {
        app.ui(json!({"action":"project_command_approval","id":id,"chat_id":chat,"command":normalized,"rememberable":repeatable(&normalized)}));
    }
    Ok(
        json!({"id":id,"state":if remembered{"running"}else{"approval_required"},"command":normalized}),
    )
}
pub fn status(app: &App, chat: Option<&str>, id: &str) -> Result<Value> {
    let all = jobs().lock().unwrap();
    let j = all.get(id).context("Command not found")?;
    ensure!(
        j.owner == app.data_dir && Some(j.chat.as_str()) == chat,
        "Command belongs to another chat"
    );
    Ok(json!({"id":id,"command":j.args,"result":j.status}))
}
pub fn pending(app: &App, chat: &str) -> Vec<Value> {
    jobs().lock().unwrap().iter().filter(|(_,j)|j.owner==app.data_dir&&j.chat==chat&&j.status["state"]=="approval_required").map(|(id,j)|json!({"action":"project_command_approval","id":id,"chat_id":chat,"command":j.args,"rememberable":repeatable(&j.args)})).collect()
}
pub fn profile(paths: &[PathBuf], tmp: &std::path::Path, network: bool) -> String {
    // Default allow preserves compiler/tool reads and process execution, while
    // writes and network are denied unless explicitly granted by the user.
    let mut p = "(version 1) (allow default) (deny file-write*) (deny mach-lookup) (deny mach-register) (deny appleevent-send)".to_owned();
    if !network {
        p.push_str(" (deny network*)");
    }
    p.push_str(&format!(
        " (allow file-write* (subpath {}) (literal \"/dev/null\"))",
        json!(tmp.to_string_lossy())
    ));
    for path in paths {
        p.push_str(&format!(
            " (allow file-write* (subpath {}))",
            json!(path.to_string_lossy())
        ));
    }
    p
}
fn bounded_read(mut pipe: impl Read) -> String {
    let mut out = std::collections::VecDeque::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = pipe.read(&mut buf) {
        if n == 0 {
            break;
        }
        out.extend(&buf[..n]);
        while out.len() > 262144 {
            out.pop_front();
        }
    }
    String::from_utf8_lossy(&out.into_iter().collect::<Vec<_>>()).into_owned()
}
fn start(app: &App, id: &str) -> Result<()> {
    let mut all = jobs().lock().unwrap();
    let job = all.get_mut(id).context("Command not found")?;
    ensure!(
        job.owner == app.data_dir && job.status["state"] == "approval_required",
        "Command is no longer pending"
    );
    let root = crate::linked::root(app, &job.target)?;
    ensure!(
        job.args["root"] == json!(root),
        "Linked directory changed; request the command again"
    );
    let tmp = tempfile::tempdir()?;
    let temp = tmp.path().canonicalize()?;
    let cwd = job.args["cwd"].as_str().unwrap_or("");
    let cwd = if cwd.is_empty() {
        root.clone()
    } else {
        crate::linked::resolve(&root, cwd)?
    };
    let mut writable = vec![];
    if job.args["write"] == true {
        writable.push(root.clone());
    }
    if job.args["repository_scope"] == true {
        let git = crate::linked::git_status(&root);
        let repo = PathBuf::from(git["root"].as_str().context("No enclosing repository")?)
            .canonicalize()?;
        writable.push(repo);
        let out = Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .output()?;
        ensure!(out.status.success(), "Cannot locate repository metadata");
        writable.push(PathBuf::from(String::from_utf8(out.stdout)?.trim()).canonicalize()?);
    }
    let mut cmd = Command::new("/usr/bin/sandbox-exec");
    cmd.args([
        "-p",
        &profile(&writable, &temp, job.args["network"] == true),
        "--",
    ])
    .arg(job.args["executable"].as_str().unwrap())
    .args(
        job.args["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap()),
    )
    .current_dir(cwd)
    .env_clear()
    .env(
        "PATH",
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()),
    )
    .env("HOME", dirs::home_dir().unwrap_or_else(|| temp.clone()))
    .env("TMPDIR", &temp)
    .env("LANG", "en_US.UTF-8")
    .env("GIT_TERMINAL_PROMPT", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .context("Cannot launch confined command; no unrestricted fallback is permitted")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let child = Arc::new(Mutex::new(child));
    job.child = Some(child.clone());
    job.status = json!({"state":"running"});
    let id = id.to_owned();
    drop(all);
    std::thread::spawn(move || {
        let out = std::thread::spawn(move || bounded_read(stdout));
        let err = std::thread::spawn(move || bounded_read(stderr));
        let start = Instant::now();
        let result = loop {
            let mut c = child.lock().unwrap();
            match c.try_wait() {
                Ok(Some(s)) => break Ok(s.code()),
                Err(e) => break Err(e.to_string()),
                _ => {}
            }
            if start.elapsed() > Duration::from_secs(120) {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(c.id() as i32), libc::SIGKILL);
                }
                let _ = c.kill();
                let _ = c.wait();
                break Err("Command exceeded two minutes".into());
            }
            drop(c);
            std::thread::sleep(Duration::from_millis(100));
        };
        // Kill background descendants before joining pipe readers.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.lock().unwrap().id() as i32), libc::SIGKILL);
        }
        let stdout = out.join().unwrap_or_default();
        let stderr = err.join().unwrap_or_default();
        if let Some(j) = jobs().lock().unwrap().get_mut(&id) {
            if j.status["state"] != "cancelled" {
                j.status = match result {
                    Ok(code) => {
                        json!({"state":"finished","exit_code":code,"stdout":stdout,"stderr":stderr})
                    }
                    Err(e) => json!({"state":"error","error":e,"stdout":stdout,"stderr":stderr}),
                };
            }
            j.child = None;
        }
        drop(tmp);
    });
    Ok(())
}
fn decide(app: &App, id: &str, body: &Value) -> Result<Value> {
    let (target, args) = {
        let mut all = jobs().lock().unwrap();
        let j = all.get_mut(id).context("Command not found")?;
        ensure!(j.owner == app.data_dir, "Command belongs to another server");
        if body["op"] == "cancel" {
            stop(j);
            return Ok(j.status.clone());
        }
        ensure!(
            j.status["state"] == "approval_required",
            "Request is no longer pending"
        );
        if body["approve"] != true {
            j.status = json!({"state":"declined"});
            return Ok(j.status.clone());
        }
        (j.target.clone(), j.args.clone())
    };
    if body["remember"] == true {
        ensure!(
            repeatable(&args),
            "This command requires approval each time"
        );
        remember(
            app,
            &target,
            &command_key(&args),
            &format!("{} {}", args["executable"].as_str().unwrap(), args["args"]),
        )?;
    }
    start(app, id)?;
    Ok(json!({"state":"running"}))
}
pub async fn decision(
    State(app): Shared,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    Ok(Json(decide(&app, &id, &body)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shells_and_push_never_receive_reusable_grants() {
        for (exe, args) in [
            ("/bin/sh", json!(["-c", "git push"])),
            ("/usr/bin/git", json!(["push"])),
            ("/usr/bin/git", json!(["reset", "--hard"])),
        ] {
            assert!(!repeatable(&json!({"executable":exe,"args":args})));
        }
        assert!(repeatable(
            &json!({"executable":"/usr/bin/git","args":["status"]})
        ));
    }
}

pub async fn inspect(State(app): Shared, Path(id): Path<String>) -> ApiResult {
    let all = jobs().lock().unwrap();
    let j = all.get(&id).context("Command not found")?;
    if j.owner != app.data_dir {
        return Err(anyhow::anyhow!("Command belongs to another server").into());
    }
    Ok(Json(json!({"id":id,"command":j.args,"result":j.status})))
}

#[cfg(all(test, target_os = "macos"))]
mod confinement_tests {
    use super::*;
    #[test]
    fn linked_command_confines_children_and_symlinks() -> Result<()> {
        let root = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        let temp = tempfile::tempdir()?;
        let root = root.path().canonicalize()?;
        let outside = outside.path().canonicalize()?;
        let temp = temp.path().canonicalize()?;
        std::os::unix::fs::symlink(&outside, root.join("escape"))?;
        let script = r#"printf allowed > "$1/inside"; /bin/sh -c 'printf denied > "$1/outside"' sh "$2"; printf denied > "$1/escape/symlink""#;
        let out = Command::new("/usr/bin/sandbox-exec")
            .args([
                "-p",
                &profile(&[root.clone()], &temp, false),
                "/bin/sh",
                "-c",
                script,
                "sh",
            ])
            .arg(&root)
            .arg(&outside)
            .output()?;
        assert!(
            root.join("inside").exists(),
            "Sandbox could not start: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!outside.join("outside").exists());
        assert!(!outside.join("symlink").exists());
        Ok(())
    }
}
