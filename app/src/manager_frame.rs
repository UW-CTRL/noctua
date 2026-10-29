//! Origin-isolated management iframe served only on loopback. The parent server
//! can embed the UI, but cannot read its DOM, token, logs, or command responses.
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct Frame {
    app: AppHandle,
    parent: String,
    worker: String,
    ticket: String,
    origin: String,
    ancestor: String,
}
fn authorized(headers: &HeaderMap, origin: &str) -> bool {
    headers.get("origin").and_then(|v| v.to_str().ok()) == Some(origin)
        && headers
            .get("x-noctua-manager")
            .and_then(|v| v.to_str().ok())
            == Some("1")
        && headers.get("host").and_then(|v| v.to_str().ok()) == origin.strip_prefix("http://")
}
fn response(frame: &Frame, mime: &str, body: Vec<u8>) -> Response {
    let mut response = ([("content-type", mime)], body).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    let csp=format!("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors {}",frame.ancestor);
    response
        .headers_mut()
        .insert("content-security-policy", csp.parse().unwrap());
    response
}
async fn asset(
    State(frame): State<Frame>,
    Path((ticket, file)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if ticket != frame.ticket
        || headers.get("host").and_then(|v| v.to_str().ok()) != frame.origin.strip_prefix("http://")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if file == "index.html" {
        let bridge = r#"<script>window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{const r=await fetch('invoke',{method:'POST',headers:{'Content-Type':'application/json','X-Noctua-Manager':'1'},body:JSON.stringify({command,args})});const result=await r.json();if(!r.ok)throw Error(result.error||'Server settings unavailable');return result;}};</script>"#;
        return response(
            &frame,
            "text/html; charset=utf-8",
            include_str!("../dist/index.html")
                .replacen(
                    "<head>",
                    &format!(r#"<head>{bridge}<script src="preferences.js"></script>"#),
                    1,
                )
                .into_bytes(),
        );
    }
    if file == "preferences.js" {
        return response(
            &frame,
            "text/javascript",
            super::appearance::local_script().into_bytes(),
        );
    }
    let (mime, bytes): (&str, &[u8]) = match file.as_str() {
        "client.js" => ("text/javascript", include_bytes!("../dist/client.js")),
        "appearance.js" => ("text/javascript", include_bytes!("../../web/appearance.js")),
        "fonts.js" => ("text/javascript", include_bytes!("../../web/fonts.js")),
        "select.js" => ("text/javascript", include_bytes!("../../web/select.js")),
        "update-dialogs.js" => (
            "text/javascript",
            include_bytes!("../../web/update-dialogs.js"),
        ),
        "connection.css" => ("text/css", include_bytes!("../../web/connection.css")),
        "ui.css" => ("text/css", include_bytes!("../../web/ui.css")),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    response(&frame, mime, bytes.to_vec())
}
async fn invoke(
    State(frame): State<Frame>,
    Path(ticket): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if ticket != frame.ticket || !authorized(&headers, &frame.origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if frame.app.get_webview_window(&frame.parent).is_none() {
        return StatusCode::GONE.into_response();
    }
    let result: Result<Value, String> = async {
        let worker: tauri::Webview = frame
            .app
            .get_webview_window(&frame.worker)
            .ok_or("The local manager is unavailable")?
            .as_ref()
            .clone();
        let args = &body["args"];
        let text = |key: &str| args[key].as_str().unwrap_or_default().to_string();
        let optional = |key: &str| args[key].as_str().map(str::to_string);
        match body["command"].as_str().unwrap_or_default() {
            "client_state" => super::client_state(frame.app.clone(), worker).await,
            "local_server" => super::local_server(frame.app.clone(), worker, text("action")).await,
            "clear_connection" => super::clear_connection(frame.app.clone(), worker)
                .await
                .map(|_| json!({})),
            "connect_server" => {
                super::connect_server(
                    frame.app.clone(),
                    worker,
                    text("mode"),
                    text("address"),
                    text("secret"),
                    args["testOnly"].as_bool().unwrap_or(false),
                    Some(false),
                    None,
                    optional("expectedServerId"),
                    args["deferServerUpdate"].as_bool(),
                )
                .await
            }
            "present_client" | "dismiss_connection" => Ok(json!({})),
            _ => Err("Unknown management command".into()),
        }
    }
    .await;
    let mut reply = match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
    };
    reply
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    reply
}
pub fn start(
    app: &AppHandle,
    parent: &str,
    worker: &str,
    ancestor: &str,
) -> anyhow::Result<String> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    let frame = Frame {
        app: app.clone(),
        parent: parent.into(),
        worker: worker.into(),
        ticket: ticket.clone(),
        origin: origin.clone(),
        ancestor: ancestor.into(),
    };
    let router = Router::new()
        .route("/{ticket}/invoke", post(invoke))
        .route("/{ticket}/{file}", get(asset))
        .with_state(frame.clone());
    tauri::async_runtime::spawn(async move {
        let shutdown = async move {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            while frame.app.get_webview_window(&frame.parent).is_some() {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
    });
    Ok(format!("{origin}/{ticket}/index.html?overlay=1"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_require_exact_local_origin_and_custom_header() {
        let mut h = HeaderMap::new();
        h.insert("host", "127.0.0.1:1234".parse().unwrap());
        h.insert("origin", "https://remote.example".parse().unwrap());
        h.insert("x-noctua-manager", "1".parse().unwrap());
        assert!(!authorized(&h, "http://127.0.0.1:1234"));
        h.insert("origin", "http://127.0.0.1:1234".parse().unwrap());
        assert!(authorized(&h, "http://127.0.0.1:1234"));
        h.insert("host", "attacker.example:1234".parse().unwrap());
        assert!(!authorized(&h, "http://127.0.0.1:1234"));
        h.insert("host", "127.0.0.1:1234".parse().unwrap());
        h.insert("origin", "null".parse().unwrap());
        assert!(!authorized(&h, "http://127.0.0.1:1234"));
        h.remove("origin");
        assert!(!authorized(&h, "http://127.0.0.1:1234"));
        h.insert("origin", "http://127.0.0.1:1234".parse().unwrap());
        h.remove("x-noctua-manager");
        assert!(!authorized(&h, "http://127.0.0.1:1234"));
    }
}
