//! Authenticated server terminals. Agent commands use a separate approval broker.
use crate::{ApiResult, App, Shared};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path, State},
    Json,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

const BUFFER: usize = 1024 * 1024;
struct Output {
    bytes: VecDeque<u8>,
    offset: u64,
    ended: bool,
}
struct Session {
    owner: PathBuf,
    target: String,
    master: std::fs::File,
    child: Child,
    output: Arc<Mutex<Output>>,
    input: Arc<Mutex<VecDeque<u8>>>,
    last: Instant,
}
impl Drop for Session {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(Default::default)
}
pub fn busy() -> bool {
    !sessions().lock().unwrap().is_empty()
}
pub fn close_target(app: &App, target: &str) {
    sessions()
        .lock()
        .unwrap()
        .retain(|_, s| s.owner != app.data_dir || s.target != target);
}
pub fn close_all() {
    sessions().lock().unwrap().clear();
}
fn size(body: &Value) -> (u16, u16) {
    (
        body["cols"].as_u64().unwrap_or(100).clamp(20, 500) as u16,
        body["rows"].as_u64().unwrap_or(24).clamp(4, 200) as u16,
    )
}
#[cfg(target_os = "macos")]
fn spawn(app: &App, target: &str, body: &Value) -> Result<Value> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    };
    let root = crate::linked::root(app, target)?;
    let (cols, rows) = size(body);
    let mut master = -1;
    let mut slave = -1;
    let mut winsize = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    ensure!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut winsize,
            )
        } == 0,
        "Unable to create terminal"
    );
    let master = unsafe { std::fs::File::from_raw_fd(master) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave) };
    unsafe {
        libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(slave.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = Command::new(shell);
    command
        .arg("-l")
        .current_dir(&root)
        .env("TERM", "xterm-256color")
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    unsafe {
        libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
    }
    let mut reader = master.try_clone()?;
    let input = Arc::new(Mutex::new(VecDeque::<u8>::new()));
    let pending = input.clone();
    let output = Arc::new(Mutex::new(Output {
        bytes: VecDeque::new(),
        offset: 0,
        ended: false,
    }));
    let sink = output.clone();
    std::thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        loop {
            {
                let mut input = pending.lock().unwrap();
                if !input.is_empty() {
                    let bytes = input.iter().take(8192).copied().collect::<Vec<_>>();
                    match reader.write(&bytes) {
                        Ok(n) => {
                            input.drain(..n);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(_) => break,
                    }
                }
            }
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }
                Err(_) => break,
                Ok(n) => {
                    let mut o = sink.lock().unwrap();
                    o.bytes.extend(&bytes[..n]);
                    while o.bytes.len() > BUFFER {
                        o.bytes.pop_front();
                        o.offset += 1;
                    }
                }
            }
        }
        sink.lock().unwrap().ended = true;
    });
    let id = uuid::Uuid::new_v4().to_string();
    let mut all = sessions().lock().unwrap();
    all.retain(|_, s| s.last.elapsed().as_secs() < 24 * 60 * 60 && !s.output.lock().unwrap().ended);
    if all.len() >= 16 {
        drop(Session {
            owner: app.data_dir.clone(),
            target: target.into(),
            master,
            child,
            output,
            input,
            last: Instant::now(),
        });
        anyhow::bail!("Close an existing terminal before opening another");
    }
    all.insert(
        id.clone(),
        Session {
            owner: app.data_dir.clone(),
            target: target.into(),
            master,
            child,
            output,
            input,
            last: Instant::now(),
        },
    );
    Ok(
        json!({"id":id,"directory":root,"server":std::env::var("HOSTNAME").unwrap_or_else(|_|"Noctua server".into())}),
    )
}
#[cfg(not(target_os = "macos"))]
fn spawn(_: &App, _: &str, _: &Value) -> Result<Value> {
    anyhow::bail!("Terminals currently require a macOS server")
}
fn action(app: &App, target: &str, body: &Value) -> Result<Value> {
    if body["op"] == "create" {
        return spawn(app, target, body);
    }
    let id = body["id"].as_str().context("Terminal session required")?;
    let mut all = sessions().lock().unwrap();
    let s = all
        .get_mut(id)
        .context("Terminal session ended; open a new terminal")?;
    ensure!(
        s.owner == app.data_dir && s.target == target,
        "Terminal belongs to another project"
    );
    s.last = Instant::now();
    if body["op"] == "close" {
        all.remove(id);
        return Ok(json!({"closed":true}));
    }
    crate::linked::root(app, target)?;
    match body["op"].as_str().unwrap_or("poll") {
        "write" => {
            let input = body["input"].as_str().context("Input required")?;
            ensure!(input.len() <= 65536, "Terminal input is too large");
            let mut pending = s.input.lock().unwrap();
            ensure!(
                pending.len() + input.len() <= 262144,
                "Terminal input is backed up; wait before pasting again"
            );
            pending.extend(input.as_bytes());
        }
        "resize" => {
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                let (cols, rows) = size(body);
                let ws = libc::winsize {
                    ws_row: rows,
                    ws_col: cols,
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                ensure!(
                    unsafe { libc::ioctl(s.master.as_raw_fd(), libc::TIOCSWINSZ, &ws) } == 0,
                    "Unable to resize terminal"
                );
            }
        }
        "poll" => {}
        _ => anyhow::bail!("Unknown terminal action"),
    }
    let o = s.output.lock().unwrap();
    let requested = body["offset"].as_u64().unwrap_or(o.offset);
    let start = requested.max(o.offset).min(o.offset + o.bytes.len() as u64);
    let bytes = o
        .bytes
        .iter()
        .skip((start - o.offset) as usize)
        .take(65536)
        .copied()
        .collect::<Vec<_>>();
    Ok(
        json!({"output":base64::engine::general_purpose::STANDARD.encode(&bytes),"offset":start+bytes.len() as u64,"truncated":requested<o.offset,"ended":o.ended,"exit_code":s.child.try_wait()?.and_then(|s|s.code())}),
    )
}
pub async fn handle(
    State(app): Shared,
    Path(target): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    Ok(Json(action(&app, &target, &body)?))
}
