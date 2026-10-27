//! Read-only discovery and recovery advice. Never stop a process or trust a PID/port.
use crate::server;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    path::Path,
};

fn held(path: &Path) -> bool {
    let Ok(file) = OpenOptions::new().read(true).write(true).open(path) else {
        return false;
    };
    matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock))
}

fn manual(kind: &str, message: &str, data: &Path, identity: Option<&Value>) -> Value {
    let mut value = json!({
        "kind":kind,"message":message,"data_dir":data,
        "steps":[
            "Save changes in every older Noctua window and let AI and compilation jobs finish.",
            "Quit the older desktop app completely. Closing a browser or a window alone may leave its server running.",
            "If you started the old server in a terminal, press Ctrl+C in that same terminal. Otherwise use that version's safe-stop command when available.",
            "Return here and choose Retry connection. Do not delete lock files or force-kill a process."
        ]
    });
    if let Some(identity) = identity {
        for key in ["version", "url", "executable"] {
            value[key] = identity[key].clone();
        }
    }
    value
}

fn unsupported(data: &Path, identity: &Value) -> Value {
    manual("legacy", "An older Noctua server is running but cannot coordinate an automatic upgrade. Save work, stop the older server using the instructions below, then retry.", data, Some(identity))
}

/// Inspect only the selected data and this client's recorded owner. No process scan,
/// unauthenticated legacy API probe, configuration change, or data-folder switch.
pub async fn inspect(data: &Path) -> Option<Value> {
    if let Ok(identity) = server::status_any_for_update(data).await {
        return (identity["capabilities"]["server_updates"] != true)
            .then(|| unsupported(data, &identity));
    }
    let client = crate::client::config_dir().ok()?;
    let progress = crate::server_update::progress();
    if matches!(
        progress["phase"].as_str(),
        Some("announcing" | "draining" | "backing_up" | "service" | "starting" | "cleanup")
    ) && held(&client.join("server-update-worker.lock"))
    {
        return None;
    }
    if held(&client.join("server-machine.lock")) {
        if let Ok(bytes) = fs::read(client.join("active-server.json")) {
            if let Ok(record) = serde_json::from_slice::<server::Record>(&bytes) {
                if server::validate_local_record(&record).is_ok() {
                    if let Ok(identity) = server::status_any_for_update(&record.data_dir).await {
                        if identity["server_id"] == record.server_id
                            && identity["instance_id"] == record.instance_id
                        {
                            let same = fs::canonicalize(data)
                                .ok()
                                .zip(fs::canonicalize(&record.data_dir).ok())
                                .is_some_and(|(a, b)| a == b);
                            if !same {
                                let mut help=manual("other_data", "Another Noctua server is using a different data folder. Its data will not be switched or upgraded automatically. Reuse that server explicitly, or stop it safely before retrying this folder.", &record.data_dir, Some(&identity));
                                help["requested_data_dir"] = json!(data);
                                if identity["capabilities"]["server_updates"] == true
                                    && identity["executable"] == json!(record.executable)
                                    && identity["executable_hash"] == record.executable_hash
                                    && server::executable_hash(&record.executable).ok().as_deref()
                                        == Some(record.executable_hash.as_str())
                                {
                                    help["stop_command"] = json!(stop_command(
                                        &record.data_dir,
                                        &client,
                                        &record.executable
                                    ));
                                }
                                help["steps"]=json!([
                                    "Save work and finish active tasks on the server shown below.",
                                    "Run the safe-stop command shown below in a terminal on this computer, if available. Otherwise use the older app's own shutdown path or its original terminal. The current connection's Stop button may address a different folder.",
                                    "Alternatively choose Connect to another computer and enter the shown local address and its token to reuse that data explicitly.",
                                    "Retry connection after stopping it. Do not delete lock files or force-kill a process."
                                ]);
                                return Some(help);
                            }
                            return Some(unsupported(data, &identity));
                        }
                    }
                }
            }
        }
        return Some(manual("unverified", "A local server or update worker owns this user profile, but its identity could not be verified. Wait for any update to finish; otherwise save work and stop the older server explicitly before retrying. No process was stopped.", data, None));
    }
    let migration = std::env::var_os("NOCTUA_HOME").is_none()
        && held(&crate::paths::default_data_dir().join("storage-location.lock"));
    if migration
        || held(&data.join("storage-location.lock"))
        || held(&data.join("server-owner.lock"))
    {
        return Some(manual("legacy", "An older app/server or storage operation is holding this data folder. Automatic handover is unavailable. Wait for any storage move to finish, or save work and quit the older app/server before retrying.", data, None));
    }
    None
}

fn stop_command(data: &Path, client: &Path, executable: &Path) -> String {
    #[cfg(not(windows))]
    {
        let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        format!(
            "NOCTUA_HOME={} NOCTUA_CLIENT_HOME={} {} stop",
            quote(data),
            quote(client),
            quote(executable)
        )
    }
    #[cfg(windows)]
    {
        let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "''"));
        format!(
            "$env:NOCTUA_HOME={}; $env:NOCTUA_CLIENT_HOME={}; & {} stop",
            quote(data),
            quote(client),
            quote(executable)
        )
    }
}

pub fn error(help: &Value) -> String {
    let mut message = help["message"]
        .as_str()
        .unwrap_or("An older server needs attention")
        .to_owned();
    if let Some(data) = help["data_dir"].as_str() {
        message.push_str(&format!("\nData folder: {data}"));
    }
    if let Some(command) = help["stop_command"].as_str() {
        message.push_str(&format!("\nSafe-stop command: {command}"));
    }
    if let Some(steps) = help["steps"].as_array() {
        for step in steps {
            if let Some(step) = step.as_str() {
                message.push_str(&format!("\n- {step}"));
            }
        }
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn authenticated_protocol_detection_never_requests_shutdown() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for coordinated in [true, false] {
            let data =
                std::env::temp_dir().join(format!("noctua-recovery-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&data).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let mut identity = json!({"product":"noctua","server_id":"test-owner","instance_id":"test-instance","api_version":1,"version":"0.2.8","data_dir":fs::canonicalize(&data).unwrap(),"url":url,"pid":1,"ready":true,"capabilities":{"server_updates":coordinated}});
            fs::write(data.join("server.json"), identity.to_string()).unwrap();
            fs::write(data.join("server-token"), "test-secret-not-for-logs").unwrap();
            let response = identity.take().to_string();
            let task = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let n = stream.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..n]);
                assert!(request.starts_with("GET /api/server "));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-secret-not-for-logs"));
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).as_bytes()).await.unwrap();
            });
            let help = inspect(&data).await;
            task.await.unwrap();
            if coordinated {
                assert!(help.is_none());
            } else {
                let help = help.unwrap();
                assert_eq!(help["kind"], "legacy");
                assert!(!error(&help).contains("test-secret-not-for-logs"));
            }
            assert!(!data.join("server-format.json").exists());
            fs::remove_dir_all(data).unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn displayed_stop_command_preserves_quoted_paths() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("noctua recovery's {}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let executable = root.join("old server's script");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$NOCTUA_HOME\" \"$NOCTUA_CLIENT_HOME\" \"$1\"\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let data = root.join("data's folder");
        let client = root.join("client's folder");
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &stop_command(&data, &client, &executable)])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n{}\nstop\n", data.display(), client.display())
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn discovery_does_not_create_missing_locks() {
        let root = std::env::temp_dir().join(format!("noctua-recovery-{}", uuid::Uuid::new_v4()));
        assert!(!held(&root.join("absent.lock")));
        assert!(!root.exists());
    }
    #[test]
    fn detects_real_locks_and_clears_after_release() {
        let path = std::env::temp_dir().join(format!("noctua-recovery-{}", uuid::Uuid::new_v4()));
        let owner = fs::File::create(&path).unwrap();
        owner.lock().unwrap();
        assert!(held(&path));
        drop(owner);
        assert!(!held(&path));
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn legacy_guidance_never_suggests_force_or_automatic_shutdown() {
        let advice = unsupported(Path::new("/old data"), &json!({"version":"0.2.4"}));
        assert_eq!(advice["version"], "0.2.4");
        let text = error(&advice);
        assert!(
            text.contains("Ctrl+C")
                && text.contains("Save changes")
                && text.contains("Do not delete lock files")
        );
        assert!(!text.contains("kill -") && !text.contains("rm "));
    }
}
