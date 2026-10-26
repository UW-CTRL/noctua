//! Headless server and local lifecycle CLI. No desktop dependencies.
use anyhow::{Context, Result};
use noctua::{server, service};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    for (flag, variable) in [
        ("--data-dir", "NOCTUA_HOME"),
        ("--profile-dir", "NOCTUA_PROFILE_HOME"),
        ("--client-dir", "NOCTUA_CLIENT_HOME"),
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
        "describe"=>println!("{}",server::describe()?),
        "update-status"=>println!("{}",noctua::server_update::progress()),
        "update"=>{
            let seconds=|flag:&str,default:u64|->Result<u64>{let value=arguments.iter().position(|s|s==flag).map(|i|arguments.get(i+1).context("Missing update duration").and_then(|s|Ok(s.parse::<u64>()?))).transpose()?.unwrap_or(default);anyhow::ensure!(value<=86400,"Update duration must be at most one day");Ok(value)};
            let executable=arguments.iter().position(|s|s=="--server").map(|i|arguments.get(i+1).map(std::path::PathBuf::from).context("--server needs an executable path")).transpose()?.unwrap_or(std::env::current_exe()?);
            let executable=noctua::service::stage(&std::fs::canonicalize(executable)?)?;
            let value=noctua::server_update::run(&executable,port,arguments.iter().any(|s|s=="--force"),std::time::Duration::from_secs(seconds("--grace-seconds",30)?),std::time::Duration::from_secs(seconds("--timeout-seconds",1800)?)).await?;
            println!("{}",value);
        },
        "serve"=> {
            noctua::paths::adopt_shell_path();
            let (url,run)=noctua::start(noctua::ServeOptions{port}).await?;
            println!("Noctua server ready at {url}; authentication required. Closing a client does not stop this server.");run.await?;
        }
        "ensure"=> {let v=server::ensure(&std::env::current_exe()?,port).await?;println!("{}",serde_json::to_string_pretty(&v)?);}
        "status"=> {println!("{}",serde_json::to_string_pretty(&server::status(&noctua::paths::existing_data_dir()?).await?)?);}
        "stop"=>{server::stop(&noctua::paths::existing_data_dir()?).await?;println!("Server stopped safely");}
        "restart"=>{let value=server::restart(&std::env::current_exe()?,port).await?;println!("{}",serde_json::to_string_pretty(&value)?);}
        "service"=>{
            let _control=if arguments.get(2).is_some_and(|s|s!="status"){Some(server::control_lock_for_cli(&noctua::paths::existing_data_dir()?).await?)}else{None};
            match std::env::args().nth(2).as_deref() {
            Some("enable")=>{service::enable(&std::env::current_exe()?)?;println!("Login auto-start enabled; the existing server remains running");}
            Some("disable")=>{service::disable()?;println!("Login auto-start disabled; the current server remains running");}
            Some("start")=>{service::start()?;}
            Some("status")=>println!("{}",service::status()),
            _=>anyhow::bail!("Usage: noctua service enable|disable|start|status"),
        }},
        "token"=>{ // Only an explicitly requested terminal display, never included in normal status/logs.
            let data=noctua::paths::existing_data_dir()?;println!("{}",server::token(&data).context("Start the server before requesting its token")?);
        }
        _=>anyhow::bail!("Usage: noctua serve|ensure|status|stop|restart|update|describe|token|service [enable|disable|start|status]"),
    }
    Ok(())
}
