//! Where Noctua keeps its data (a per-user folder, so `git pull` and app
//! updates never touch it), the one-time move of data out of a source
//! checkout, and finding agent CLIs when started from a desktop launcher.

use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::Result;

/// The platform's per-user data folder:
/// ~/Library/Application Support/Noctua, %APPDATA%\Noctua, ~/.local/share/noctua.
pub fn default_data_dir() -> PathBuf {
    if let Some(path)=env::var_os("NOCTUA_PROFILE_HOME").filter(|path|!path.is_empty()) {return path.into();}
    let name = if cfg!(target_os = "linux") { "noctua" } else { "Noctua" };
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join(name)
}

/// Environment overrides take precedence over the location saved in Settings.
pub fn data_dir() -> Result<PathBuf> {
    if let Some(h) = env::var_os("NOCTUA_HOME").filter(|h| !h.is_empty()) {
        return Ok(h.into());
    }
    crate::storage::resolve(&default_data_dir())
}

/// Inspect local state without applying a pending server storage migration.
pub fn existing_data_dir() -> Result<PathBuf> {
    if let Some(h) = env::var_os("NOCTUA_HOME").filter(|h|!h.is_empty()) { return Ok(h.into()) }
    crate::storage::current(&default_data_dir())
}

const LEGACY_DBS: [&str; 3] = ["noctua-cache.sqlite", "noctua-chats.sqlite", "noctua-projects.sqlite"];

/// Earlier versions kept everything in the source checkout. If `data` is
/// still empty and such a folder exists, copy its data over (the originals
/// stay where they are). Returns the folder copied from.
pub fn migrate_legacy(data: &Path) -> Result<Option<PathBuf>> {
    if data.join("key.txt").exists() || data.join("notes").exists() || data.join("noctua-chats.sqlite").exists() {
        return Ok(None);
    }
    let candidates = [env::current_dir().ok(), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().ok()];
    let Some(old) = candidates
        .into_iter()
        .flatten()
        .find(|d| d != data && (d.join("key.txt").is_file() || d.join("notes").is_dir()))
    else {
        return Ok(None);
    };
    fs::create_dir_all(data)?;
    if old.join("key.txt").is_file() {
        fs::copy(old.join("key.txt"), data.join("key.txt"))?;
        restrict(&data.join("key.txt"));
    }
    for db in LEGACY_DBS {
        for suffix in ["", "-wal", "-shm"] {
            let f = format!("{db}{suffix}");
            if old.join(&f).is_file() {
                fs::copy(old.join(&f), data.join(&f))?;
            }
        }
    }
    copy_dir(&old.join("notes"), &data.join("notes"))?;
    copy_dir(&old.join(".noctua-chat"), &data.join(".noctua-chat"))?;
    // Claude keeps resumable sessions per working directory; copy them so old
    // chats can still be continued from the new location.
    copy_agent_sessions(&old, data)?;
    Ok(Some(old))
}

pub(crate) fn copy_agent_sessions(old: &Path, data: &Path) -> Result<()> {
    if let Some(projects) = dirs::home_dir().map(|h| h.join(".claude").join("projects")) {
        let from = projects.join(claude_project_name(&old.join(".noctua-chat")));
        copy_dir(&from, &projects.join(claude_project_name(&data.join(".noctua-chat"))))?;
    }
    Ok(())
}

/// How Claude Code names a working directory's session folder.
fn claude_project_name(dir: &Path) -> String {
    dir.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst)?;
        } else if !dst.exists() {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Makes a file readable only by its owner (Unix; a no-op elsewhere, where
/// the per-user profile folder already is private).
pub fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    let _ = path;
}

/// Writes a private file atomically (temp file + rename).
pub fn write_private(path: &Path, body: &str) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body)?;
    restrict(&tmp);
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Apps started from Finder or a desktop launcher get a minimal PATH, so
/// programs installed for the user's shell (`claude`) aren't found. Adopt the
/// login shell's PATH. (macOS/Linux; a no-op on Windows.)
pub fn adopt_shell_path() {
    #[cfg(unix)]
    {
        use std::{io::Read, process::{Command, Stdio}};
        const MARK: &str = "__NOCTUA_PATH__";
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let Ok(mut child) = Command::new(shell)
            .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return;
        };
        let start = Instant::now();
        while child.try_wait().ok().flatten().is_none() {
            if start.elapsed() > Duration::from_secs(3) {
                let _ = child.kill();
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut out = String::new();
        let _ = child.stdout.take().map(|mut o| o.read_to_string(&mut out));
        let Some(shell_path) = out.split(MARK).nth(1).filter(|p| !p.is_empty()) else { return };
        let mut dirs: Vec<PathBuf> = env::split_paths(shell_path).collect();
        for d in env::split_paths(&env::var_os("PATH").unwrap_or_default()) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
        if let Ok(joined) = env::join_paths(dirs) {
            env::set_var("PATH", joined);
        }
    }
}

/// An agent CLI: its configured path, then NOCTUA_CLAUDE / NOCTUA_CODEX,
/// then PATH and the usual install locations.
pub fn cli_command(name: &str, configured: Option<&str>) -> tokio::process::Command {
    let prog = configured
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os(if name == "codex" { "NOCTUA_CODEX" } else { "NOCTUA_CLAUDE" }).map(PathBuf::from))
        .or_else(|| find_cli(name))
        .unwrap_or_else(|| PathBuf::from(name));
    #[allow(unused_mut)]
    let mut cmd = if cfg!(windows) && prog.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(&prog);
        c
    } else {
        tokio::process::Command::new(&prog)
    };
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    cmd
}

fn find_cli(name: &str) -> Option<PathBuf> {
    let names = if cfg!(windows) { vec![format!("{name}.exe"), format!("{name}.cmd")] } else { vec![name.to_string()] };
    let mut dirs: Vec<PathBuf> = env::var_os("PATH").map(|p| env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        dirs.extend([home.join(".local/bin"), home.join(".claude/local"), home.join(".npm-global/bin")]);
    }
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}
