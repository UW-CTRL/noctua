use anyhow::{Context, Result};
use serde_json::{json, Value};
use noctua_client::server_update::{SAFE_ENV, SECRET_ENV, absolute};

/// Only the private local control endpoint exports this; ordinary API/browser clients cannot.
pub(crate) fn launch_environment(app: &crate::App) -> Result<Value> {
    let mut environment = serde_json::Map::new();
    for key in SAFE_ENV.iter().chain(SECRET_ENV.iter()) {
        if let Ok(value) = std::env::var(key) {
            environment.insert((*key).into(), json!(value));
        }
    }
    let runtime = app.runtime.as_ref().context("Server control unavailable")?;
    environment.insert(
        "NOCTUA_ORIGINS".into(),
        json!(runtime
            .origins
            .iter()
            .filter(|value| value.starts_with("https://"))
            .cloned()
            .collect::<Vec<_>>()
            .join(",")),
    );
    environment.insert("NOCTUA_NOTES".into(), json!(absolute(&app.notes.root)?));
    environment.insert(
        "NOCTUA_LAUNCH_PATH".into(),
        json!(std::env::var("PATH").unwrap_or_default()),
    );
    Ok(Value::Object(environment))
}
