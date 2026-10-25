//! Headless server and local lifecycle CLI. No desktop dependencies.
use anyhow::{Context, Result};
use noctua::{server, service};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    for (flag, variable) in [
        ("--data-dir", "NOCTUA_HOME"),
        ("--profile-dir", "NOCTUA_PROFILE_HOME"),
    ] {
        if let Some(index) = arguments.iter().position(|value| value == flag) {
            let directory = arguments
                .get(index + 1)
                .with_context(|| format!("{flag} needs an absolute folder"))?;
            anyhow::ensure!(
                std::path::Path::new(directory).is_absolute(),
                "{flag} needs an absolute folder"
            );
            std::env::set_var(variable, directory);
        }
    }
    let command = std::env::args().nth(1).unwrap_or_else(|| "ensure".into());
    let port = std::env::var("NOCTUA_PORT")
        .ok()
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(server::DEFAULT_PORT);
    match command.as_str() {
        "serve"=> {
            noctua::paths::adopt_shell_path();
            let (url,run)=noctua::start(noctua::ServeOptions{port}).await?;
            println!("Noctua server ready at {url}; authentication required. Closing a client does not stop this server.");run.await?;
        }
        "ensure"=> {let v=server::ensure(&std::env::current_exe()?,port).await?;println!("{}",serde_json::to_string_pretty(&v)?);}
        "status"=> {println!("{}",serde_json::to_string_pretty(&server::status(&noctua::paths::existing_data_dir()?).await?)?);}
        "stop"=>{server::stop(&noctua::paths::existing_data_dir()?).await?;println!("Server stopped safely");}
        "restart"=>{let value=server::restart(&std::env::current_exe()?,port).await?;println!("{}",serde_json::to_string_pretty(&value)?);}
        "service"=>match std::env::args().nth(2).as_deref() {
            Some("enable")=>{service::enable(&std::env::current_exe()?)?;println!("Login auto-start enabled; the existing server remains running");}
            Some("disable")=>{service::disable()?;println!("Login auto-start disabled; the current server remains running");}
            Some("start")=>{service::start()?;}
            Some("status")=>println!("{}",service::status()),
            _=>anyhow::bail!("Usage: noctua service enable|disable|start|status"),
        },
        "token"=>{ // Only an explicitly requested terminal display, never included in normal status/logs.
            let data=noctua::paths::existing_data_dir()?;println!("{}",server::token(&data).context("Start the server before requesting its token")?);
        }
        _=>anyhow::bail!("Usage: noctua serve|ensure|status|stop|restart|token|service [enable|disable|start|status]"),
    }
    Ok(())
}
