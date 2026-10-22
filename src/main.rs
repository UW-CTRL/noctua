//! Noctua in a browser: runs the local server and opens it in the default
//! browser. (The desktop app in `app/` runs the same server in its own windows.)

use std::env;

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let port = env::var("NOCTUA_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7878);
    let (url, server) = noctua::start(noctua::ServeOptions { port, desktop: None }).await?;
    println!("Noctua running at {url}  (Ctrl-C to quit)");
    if env::var_os("NOCTUA_NO_OPEN").is_none() {
        open_browser(&url);
    }
    server.await?;
    Ok(())
}

fn open_browser(url: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    } else {
        std::process::Command::new("xdg-open")
    };
    let _ = cmd.arg(url).spawn();
}
