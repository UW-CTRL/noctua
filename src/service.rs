//! Explicit user-login services. Merely ensuring a server never installs one.
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command};
const LABEL: &str = "app.noctua.server";
fn home() -> Result<PathBuf> {
    dirs::home_dir().context("User home directory unavailable")
}
fn file() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("NOCTUA_SERVICE_HOME") {
        return Ok(PathBuf::from(root).join(if cfg!(target_os = "macos") {
            "app.noctua.server.plist"
        } else if cfg!(windows) {
            "noctua-task.xml"
        } else {
            "noctua.service"
        }));
    }
    if cfg!(target_os = "macos") {
        Ok(home()?.join("Library/LaunchAgents/app.noctua.server.plist"))
    } else if cfg!(target_os = "linux") {
        Ok(home()?.join(".config/systemd/user/noctua.service"))
    } else if cfg!(windows) {
        Ok(crate::client::config_dir()?.join("noctua-task.xml"))
    } else {
        anyhow::bail!("Login service management is not supported on this platform")
    }
}
fn manager(name: &str) -> Command {
    Command::new(std::env::var_os("NOCTUA_SERVICE_MANAGER").unwrap_or_else(|| name.into()))
}
fn checked(command: &mut Command) -> Result<()> {
    let output = command
        .output()
        .context("Cannot execute user service manager")?;
    anyhow::ensure!(
        output.status.success(),
        "User service manager failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}
#[cfg(target_os = "macos")]
fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}
pub fn installed() -> Result<bool> {
    Ok(file()?.is_file())
}
pub fn status() -> Value {
    let result: Result<Value> = (|| {
        let installed = installed()?;
        if !installed {
            return Ok(
                json!({"supported":true,"installed":false,"enabled":false,"scope":"user login"}),
            );
        }
        #[cfg(target_os = "macos")]
        let enabled = {
            let out = manager("launchctl")
                .args(["print-disabled", &domain()])
                .output()?;
            anyhow::ensure!(out.status.success(), "Cannot read launchd auto-start state");
            let text = String::from_utf8_lossy(&out.stdout);
            !text
                .lines()
                .any(|line| line.contains(LABEL) && line.contains("=> true"))
        };
        #[cfg(target_os = "linux")]
        let enabled = {
            let out = manager("systemctl")
                .args(["--user", "is-enabled", "noctua.service"])
                .output()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let text = text.trim();
            anyhow::ensure!(
                matches!(
                    text,
                    "enabled" | "enabled-runtime" | "disabled" | "static" | "masked"
                ),
                "Cannot verify systemd login auto-start state"
            );
            matches!(text, "enabled" | "enabled-runtime")
        };
        #[cfg(windows)]
        let enabled = {
            let out = manager("schtasks.exe")
                .args(["/Query", "/TN", LABEL, "/XML"])
                .output()?;
            anyhow::ensure!(out.status.success(), "Cannot read user login task state");
            let text = if out.stdout.get(1) == Some(&0) || out.stdout.starts_with(&[0xff, 0xfe]) {
                String::from_utf16_lossy(
                    &out.stdout
                        .chunks_exact(2)
                        .map(|b| u16::from_le_bytes([b[0], b[1]]))
                        .collect::<Vec<_>>(),
                )
            } else {
                String::from_utf8_lossy(&out.stdout).to_string()
            };
            anyhow::ensure!(
                text.contains("<Task") && text.contains("<Enabled>"),
                "Cannot verify Windows login task state"
            );
            !text.contains("<Enabled>false</Enabled>")
        };
        Ok(
            json!({"supported":true,"installed":true,"enabled":enabled,"definition":file()?,"scope":"user login"}),
        )
    })();
    result.unwrap_or_else(|e|json!({"supported":cfg!(any(target_os="macos",target_os="linux",windows)),"installed":null,"enabled":null,"error":e.to_string()}))
}
fn service_path(path: &std::path::Path) -> String {
    let path = path.to_string_lossy();
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
    }
}
fn validate_service_path(path: &std::path::Path) -> Result<()> {
    anyhow::ensure!(
        !path.to_string_lossy().chars().any(char::is_control),
        "User service paths cannot contain control characters"
    );
    Ok(())
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
/// Installs a durable copy, so application replacement cannot remove a running binary.
pub fn stage(executable: &std::path::Path) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(fs::read(executable)?));
    let root = crate::client::config_dir()?.join("servers").join(format!(
        "{}-{}",
        env!("CARGO_PKG_VERSION"),
        &digest[..16]
    ));
    fs::create_dir_all(&root)?;
    let target = root.join(if cfg!(windows) {
        "noctua.exe"
    } else {
        "noctua"
    });
    if !target.exists() {
        let temp = root.join(format!(".stage-{}", uuid::Uuid::new_v4()));
        fs::copy(executable, &temp)?;
        if let Err(error) = fs::rename(&temp, &target) {
            if !target.is_file() || crate::server::executable_hash(&target)? != digest {
                return Err(error.into());
            }
            let _ = fs::remove_file(temp);
        }
    }
    anyhow::ensure!(
        crate::server::executable_hash(&target)? == digest,
        "The staged server executable does not match its content hash; reinstall the application"
    );
    Ok(target)
}
pub fn enable(executable: &std::path::Path) -> Result<()> {
    let executable = stage(executable)?;
    let path = file()?;
    let data = crate::paths::existing_data_dir()?;
    fs::create_dir_all(&data)?;
    let data = fs::canonicalize(data)?;
    for path in [&data, &executable, &path] {
        validate_service_path(path)?;
    }
    let (environment_key, environment_value, argument) =
        if std::env::var_os("NOCTUA_HOME").is_some_and(|value| !value.is_empty()) {
            ("NOCTUA_HOME", data.clone(), "--data-dir")
        } else {
            (
                "NOCTUA_PROFILE_HOME",
                fs::canonicalize(crate::paths::default_data_dir())?,
                "--profile-dir",
            )
        };
    validate_service_path(&environment_value)?;
    // Repoint only after proving the prior data owner has stopped. Disabling
    // login alone intentionally leaves that server alive and is not sufficient.
    let registration = path.with_extension("registration.json");
    if registration.exists() {
        let previous: Value = serde_json::from_slice(&fs::read(&registration)?)?;
        if let Some(previous) = previous["data_dir"]
            .as_str()
            .map(PathBuf::from)
            .filter(|p| *p != fs::canonicalize(&data).unwrap_or(data.clone()))
        {
            let lease = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(previous.join("server-owner.lock"))?;
            lease.try_lock().context("The previous service data folder is still in use. Safely stop that server before repointing login auto-start")?;
            #[cfg(target_os = "macos")]
            {
                let target = format!("{}/{LABEL}", domain());
                if manager("launchctl")
                    .args(["print", &target])
                    .output()?
                    .status
                    .success()
                {
                    checked(manager("launchctl").args(["bootout", &target]))?;
                }
            }
            #[cfg(target_os = "linux")]
            checked(manager("systemctl").args(["--user", "stop", "noctua.service"]))?;
        }
    }
    let log = data.join("server.log");
    let body = if cfg!(target_os = "macos") {
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{LABEL}</string><key>ProgramArguments</key><array><string>{}</string><string>serve</string></array><key>WorkingDirectory</key><string>{}</string><key>EnvironmentVariables</key><dict><key>{}</key><string>{}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",xml(&service_path(&executable)),xml(&service_path(&data)),environment_key,xml(&service_path(&environment_value)),xml(&service_path(&log)),xml(&service_path(&log)))
    } else if cfg!(windows) {
        let user = format!(
            "{}\\{}",
            std::env::var("USERDOMAIN").unwrap_or_default(),
            std::env::var("USERNAME").unwrap_or_default()
        );
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{}</UserId></LogonTrigger></Triggers><Principals><Principal id=\"Author\"><UserId>{}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context=\"Author\"><Exec><Command>{}</Command><Arguments>serve {} &quot;{}&quot;</Arguments><WorkingDirectory>{}</WorkingDirectory></Exec></Actions></Task>",xml(&user),xml(&user),xml(&service_path(&executable)),argument,xml(&service_path(&environment_value)),xml(&service_path(&data)))
    } else {
        // systemd quoted values escape backslashes, quotes and specifier expansion.
        let quote = |p: &std::path::Path| {
            format!(
                "\"{}\"",
                p.to_string_lossy()
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
                    .replace('\n', "\\n")
            )
        };
        format!("[Unit]\nDescription=Noctua user server\n[Service]\nType=simple\nExecStart={} serve\nWorkingDirectory={}\nEnvironment=\"{}={}\"\nStandardOutput=append:{}\nStandardError=append:{}\n[Install]\nWantedBy=default.target\n",quote(&executable),quote(&data),environment_key,service_path(&environment_value).replace('\\',"\\\\").replace('"',"\\\"").replace('%',"%%"),quote(&log),quote(&log))
    };
    let client = crate::client::config_dir()?;
    validate_service_path(&client)?;
    let body = if cfg!(target_os = "macos") {
        body.replace(
            "</dict><key>RunAtLoad",
            &format!(
                "<key>NOCTUA_CLIENT_HOME</key><string>{}</string></dict><key>RunAtLoad",
                xml(&service_path(&client))
            ),
        )
    } else if cfg!(windows) {
        body.replace(
            "<Arguments>serve ",
            &format!(
                "<Arguments>serve --client-dir &quot;{}&quot; ",
                xml(&service_path(&client))
            ),
        )
    } else {
        body.replace(
            "StandardOutput=",
            &format!(
                "Environment=\"NOCTUA_CLIENT_HOME={}\"\nStandardOutput=",
                service_path(&client)
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
            ),
        )
    };
    fs::create_dir_all(path.parent().unwrap())?;
    crate::paths::write_private(&path, &body)?;
    #[cfg(target_os = "macos")]
    {
        checked(manager("launchctl").args(["enable", &format!("{}/{LABEL}", domain())]))?;
        // Registration alone never starts a server. Login loads this definition;
        // an explicit start/ensure bootstraps it when needed.
    }
    #[cfg(target_os = "linux")]
    {
        checked(manager("systemctl").args(["--user", "daemon-reload"]))?;
        checked(manager("systemctl").args(["--user", "enable", "noctua.service"]))?;
    }
    #[cfg(windows)]
    checked(
        manager("schtasks.exe")
            .args(["/Create", "/TN", LABEL, "/XML"])
            .arg(&path)
            .arg("/F"),
    )?;
    crate::paths::write_private(
        &path.with_extension("registration.json"),
        &json!({"data_dir":fs::canonicalize(data)?,"executable":executable}).to_string(),
    )?;
    Ok(())
}
pub fn disable() -> Result<()> {
    let path = file()?;
    #[cfg(target_os = "macos")]
    checked(manager("launchctl").args(["disable", &format!("{}/{LABEL}", domain())]))?;
    #[cfg(target_os = "linux")]
    checked(manager("systemctl").args(["--user", "disable", "noctua.service"]))?;
    #[cfg(windows)]
    checked(manager("schtasks.exe").args(["/Delete", "/TN", LABEL, "/F"]))?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    let metadata = file()?.with_extension("registration.json");
    if metadata.exists() {
        let mut value: Value = serde_json::from_slice(&fs::read(&metadata)?)?;
        value["disabled"] = json!(true);
        crate::paths::write_private(&metadata, &value.to_string())?;
    }
    Ok(()) // Deliberately no bootout/stop: current work keeps running.
}
pub fn start() -> Result<()> {
    anyhow::ensure!(installed()?, "No login service is registered");
    #[cfg(target_os = "macos")]
    {
        let target = format!("{}/{LABEL}", domain());
        if !manager("launchctl")
            .args(["print", &target])
            .output()?
            .status
            .success()
        {
            checked(
                manager("launchctl")
                    .arg("bootstrap")
                    .arg(domain())
                    .arg(file()?),
            )?;
        } else {
            checked(manager("launchctl").args(["kickstart", &target]))?;
        }
    }
    #[cfg(target_os = "linux")]
    checked(manager("systemctl").args(["--user", "start", "noctua.service"]))?;
    #[cfg(windows)]
    checked(manager("schtasks.exe").args(["/Run", "/TN", LABEL]))?;
    Ok(())
}

/// Called only after an explicit, successful safe stop; never by normal app startup.
pub fn refresh(executable: &std::path::Path, data: &std::path::Path) -> Result<()> {
    if !installed()? {
        return Ok(());
    }
    anyhow::ensure!(
        matches_data(data)?,
        "The login service belongs to a different data folder; no service was changed"
    );
    let owner = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("server-owner.lock"))?;
    owner
        .try_lock()
        .context("A server acquired this data folder during restart; no service was unloaded")?;
    #[cfg(target_os = "macos")]
    {
        let target = format!("{}/{LABEL}", domain());
        if manager("launchctl")
            .args(["print", &target])
            .output()?
            .status
            .success()
        {
            checked(manager("launchctl").args(["bootout", &target]))?;
        }
    }
    drop(owner);
    #[cfg(target_os = "linux")]
    checked(manager("systemctl").args(["--user", "stop", "noctua.service"]))?;
    enable(executable)
}

pub fn matches_data(data: &std::path::Path) -> Result<bool> {
    let registration: Value = serde_json::from_slice(
        &fs::read(file()?.with_extension("registration.json"))
            .context("Service registration metadata missing; register the service again")?,
    )?;
    Ok(registration["data_dir"] == json!(fs::canonicalize(data)?))
}
pub fn registered_executable() -> Result<Option<PathBuf>> {
    let metadata = file()?.with_extension("registration.json");
    if !metadata.exists() {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(&fs::read(metadata)?)?;
    if value["disabled"] == true && !file()?.exists() {
        return Ok(None);
    }
    Ok(value["executable"].as_str().map(PathBuf::from))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_paths_do_not_inject_units_or_use_windows_verbatim_prefixes() {
        for value in [
            "/data/Noctua\nExecStartPre=/bin/false",
            "/data/Noctua\rBad",
            "/data/Noctua\tBad",
        ] {
            assert!(validate_service_path(std::path::Path::new(value)).is_err());
        }
        assert!(validate_service_path(std::path::Path::new("/data/Noctua research")).is_ok());
        assert_eq!(
            service_path(std::path::Path::new(r"\\?\C:\Users\Research\Noctua")),
            r"C:\Users\Research\Noctua"
        );
        assert_eq!(
            service_path(std::path::Path::new(r"\\?\UNC\host\share\Noctua")),
            r"\\host\share\Noctua"
        );
    }
}
