//! Desktop-owned UI and a fixed-upstream, authenticated streaming API gateway.
//! No research backend or remote HTML is loaded into a desktop window.
use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

pub type Assets = fn(&str) -> Option<&'static [u8]>;
#[derive(Clone)]
pub struct Frontend {
    pub origin: String,
    pub cookie_name: String,
    pub cookie_value: String,
    credentials: Arc<Mutex<(String, String)>>,
}
#[derive(Clone)]
struct Gateway {
    frontend: Frontend,
    upstream: String,
    client: reqwest::Client,
    assets: Assets,
}
impl Frontend {
    pub fn authenticate(&self, secret: String, server_id: String) {
        *self.credentials.lock().unwrap() = (secret, server_id);
    }
}
/// Keep a stable origin per server so browser storage and crash-recovery drafts
/// survive app restarts. Never silently change origins when a saved port is busy.
pub async fn start(
    address: &str,
    secret: String,
    server_id: String,
    assets: Assets,
    ports: &Path,
) -> Result<Frontend> {
    let upstream = crate::server::validate_url(address)?
        .origin()
        .ascii_serialization();
    std::fs::create_dir_all(ports)?;
    let key = format!("{:x}", Sha256::digest(upstream.as_bytes()));
    let file = ports.join(format!("{key}.port"));
    let port: u16 = match std::fs::read_to_string(&file) {
        Ok(text) => text
            .trim()
            .parse()
            .context("Invalid saved desktop UI port")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };
    let socket = tokio::net::TcpSocket::new_v4()?;
    #[cfg(unix)]
    socket.set_reuseaddr(true)?;
    socket.bind(std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)))
        .context("The saved desktop UI port is in use. Close the conflicting process and retry; your drafts were kept")?;
    let listener = socket.listen(128)
        .context("The saved desktop UI port is in use. Close the conflicting process and retry; your drafts were kept")?;
    let port = listener.local_addr()?.port();
    crate::paths::write_private(&file, &port.to_string())?;
    let frontend = Frontend {
        origin: format!("http://127.0.0.1:{port}"),
        cookie_name: format!("noctua_ui_{}", &key[..16]),
        cookie_value: uuid::Uuid::new_v4().simple().to_string(),
        credentials: Arc::new(Mutex::new((secret, server_id))),
    };
    let gateway = Gateway {
        frontend: frontend.clone(),
        upstream,
        client: reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()?,
        assets,
    };
    let router = Router::new().fallback(handle).with_state(gateway);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(frontend)
}
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |n, (a, b)| n | (a ^ b)) == 0
}
async fn handle(State(gateway): State<Gateway>, request: Request) -> Response {
    let frontend = &gateway.frontend;
    let headers = request.headers();
    if headers.get(header::HOST).and_then(|v| v.to_str().ok())
        != frontend.origin.strip_prefix("http://")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let read = matches!(*request.method(), Method::GET | Method::HEAD);
    if origin.is_some_and(|v| v != frontend.origin)
        || (!read && origin != Some(frontend.origin.as_str()))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cookie = format!("{}={}", frontend.cookie_name, frontend.cookie_value);
    if !headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').any(|part| equal(part.trim(), &cookie)))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let path = request.uri().path();
    if path.starts_with("/api/") {
        let expected = frontend.credentials.lock().unwrap().1.clone();
        if headers
            .get("x-noctua-server")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|id| id != expected)
        {
            return (StatusCode::CONFLICT, axum::Json(serde_json::json!({"error":"Server identity changed. Local drafts were kept; reconnect before saving."}))).into_response();
        }
        return match forward(&gateway, request).await {
            Ok(response) => response,
            Err(_) => (StatusCode::BAD_GATEWAY, axum::Json(serde_json::json!({"error":"Server disconnected; reconnect through Server & connection"}))).into_response(),
        };
    }
    if !read {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let file = match path {
        "/" => "index.html",
        "/shell" => "shell.html",
        _ => path.trim_start_matches('/'),
    };
    let Some(bytes) = (gateway.assets)(file) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let bytes = if file.ends_with(".html") {
        let id = frontend.credentials.lock().unwrap().1.clone();
        let escaped = id
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;");
        String::from_utf8_lossy(bytes)
            .replacen(
                "<head>",
                &format!("<head><meta name=\"noctua-server-id\" content=\"{escaped}\">"),
                1,
            )
            .into_bytes()
    } else {
        bytes.to_vec()
    };
    let mut response = (
        [
            (header::CONTENT_TYPE, mime(file)),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::HeaderName::from_static("x-frame-options"),
                "SAMEORIGIN",
            ),
        ],
        if request.method() == Method::HEAD {
            Vec::new()
        } else {
            bytes
        },
    )
        .into_response();
    response.headers_mut().remove(header::SET_COOKIE);
    response
}
async fn forward(gateway: &Gateway, request: Request) -> Result<Response> {
    let (parts, body) = request.into_parts();
    let has_body = !matches!(parts.method, Method::GET | Method::HEAD);
    let path = parts
        .uri
        .path_and_query()
        .context("Missing API path")?
        .as_str();
    anyhow::ensure!(
        path.starts_with("/api/") && !path.starts_with("//"),
        "Invalid API path"
    );
    let (secret, server_id) = gateway.frontend.credentials.lock().unwrap().clone();
    let mut upstream = gateway
        .client
        .request(parts.method, format!("{}{path}", gateway.upstream))
        .bearer_auth(secret)
        .header(header::ORIGIN, &gateway.upstream)
        .header("x-noctua-server", server_id)
        .header("x-noctua-client", "1");
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::ACCEPT,
        header::RANGE,
        header::IF_RANGE,
        header::IF_NONE_MATCH,
        header::IF_MATCH,
        header::HeaderName::from_static("x-noctua-editor"),
    ] {
        if let Some(value) = parts.headers.get(&name) {
            upstream = upstream.header(name, value);
        }
    }
    let upstream = if has_body {
        upstream
            .body(reqwest::Body::wrap_stream(body.into_data_stream()))
            .send()
            .await?
    } else {
        upstream.send().await?
    };
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_DISPOSITION,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::CACHE_CONTROL,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = headers.get(&name) {
            response.headers_mut().insert(name, value.clone());
        }
    }
    Ok(response)
}
pub fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::DefaultBodyLimit,
        routing::{get, post},
        Json,
    };
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn ui(path: &str) -> Option<&'static [u8]> {
        match path {
            "index.html" | "shell.html" => Some(b"<head></head><body>Desktop UI</body>"),
            "ui.js" => Some(b"own UI"),
            _ => None,
        }
    }
    async fn backend(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        url
    }
    fn request(
        client: &reqwest::Client,
        frontend: &Frontend,
        path: &str,
    ) -> reqwest::RequestBuilder {
        client.get(format!("{}{path}", frontend.origin)).header(
            header::COOKIE,
            format!("{}={}", frontend.cookie_name, frontend.cookie_value),
        )
    }
    #[tokio::test]
    async fn desktop_assets_are_local_and_requests_keep_native_credentials_private() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let upstream = backend(Router::new().route("/api/server", get(move |headers: axum::http::HeaderMap| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { Json(json!({"auth":headers["authorization"].to_str().unwrap(),"origin":headers["origin"].to_str().unwrap(),"cookie":headers.get("cookie").is_some(),"id":headers["x-noctua-server"].to_str().unwrap()})) }
        }))).await;
        let ports = tempfile::tempdir().unwrap();
        let frontend = start(
            &upstream,
            "secret".into(),
            "identity".into(),
            ui,
            ports.path(),
        )
        .await
        .unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let html = request(&client, &frontend, "/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(html.contains("Desktop UI") && html.contains("content=\"identity\""));
        assert!(!html.contains("secret"));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let result: Value = request(&client, &frontend, "/api/server")
            .header("authorization", "Bearer injected")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({"auth":"Bearer secret","origin":upstream,"cookie":false,"id":"identity"})
        );
        frontend.authenticate("rotated".into(), "identity".into());
        let result: Value = request(&client, &frontend, "/api/server")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["auth"], "Bearer rotated");
        assert_eq!(
            request(&client, &frontend, "/missing.js")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(&client, &frontend, "/api/server")
                .header("x-noctua-server", "other")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(start(
            &upstream,
            "secret".into(),
            "identity".into(),
            ui,
            ports.path()
        )
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("port is in use"));
    }
    #[tokio::test]
    async fn sessions_hosts_and_origins_are_required_and_redirects_do_not_receive_credentials() {
        let target_calls = Arc::new(AtomicUsize::new(0));
        let calls = target_calls.clone();
        let target = backend(Router::new().route(
            "/api/secret",
            get(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { "leaked" }
            }),
        ))
        .await;
        let upstream = backend(
            Router::new()
                .route(
                    "/api/redirect",
                    get(move || {
                        let target = target.clone();
                        async move {
                            axum::response::Redirect::temporary(&format!("{target}/api/secret"))
                        }
                    }),
                )
                .route("/api/write", post(|| async { "ok" })),
        )
        .await;
        let ports = tempfile::tempdir().unwrap();
        let frontend = start(&upstream, "secret".into(), "id".into(), ui, ports.path())
            .await
            .unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        assert_eq!(
            client.get(&frontend.origin).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        for (header, value) in [
            ("host", "attacker.example"),
            ("origin", "https://attacker.example"),
        ] {
            assert_eq!(
                request(&client, &frontend, "/api/write")
                    .header(header, value)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        let cookie = format!("{}={}", frontend.cookie_name, frontend.cookie_value);
        assert_eq!(
            client
                .post(format!("{}/api/write", frontend.origin))
                .header("cookie", &cookie)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .post(format!("{}/api/write", frontend.origin))
                .header("cookie", &cookie)
                .header("origin", &frontend.origin)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(request(&client, &frontend, "/api/redirect")
            .send()
            .await
            .unwrap()
            .status()
            .is_redirection());
        assert_eq!(target_calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn api_uploads_and_event_responses_stream_without_buffering_or_default_body_limits() {
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
        let receiver = Arc::new(Mutex::new(Some(rx)));
        let upstream = backend(
            Router::new()
                .route(
                    "/api/upload",
                    post(|bytes: axum::body::Bytes| async move { bytes.len().to_string() })
                        .layer(DefaultBodyLimit::disable()),
                )
                .route(
                    "/api/events",
                    get(move || {
                        let rx = receiver.lock().unwrap().take().unwrap();
                        async move {
                            (
                                [(header::CONTENT_TYPE, "text/event-stream")],
                                Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)),
                            )
                        }
                    }),
                ),
        )
        .await;
        let ports = tempfile::tempdir().unwrap();
        let frontend = start(&upstream, "secret".into(), "id".into(), ui, ports.path())
            .await
            .unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let cookie = format!("{}={}", frontend.cookie_name, frontend.cookie_value);
        let size = 3 * 1024 * 1024;
        let result = client
            .post(format!("{}/api/upload", frontend.origin))
            .header("origin", &frontend.origin)
            .header("cookie", cookie)
            .body(vec![1u8; size])
            .send()
            .await
            .unwrap();
        assert_eq!(result.text().await.unwrap(), size.to_string());
        tx.send(Ok(b"data: first\n\n".to_vec())).await.unwrap();
        let mut response = request(&client, &frontend, "/api/events")
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream"
        );
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first.as_ref(), b"data: first\n\n");
        tx.send(Ok(b"data: second\n\n".to_vec())).await.unwrap();
        drop(tx);
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            b"data: second\n\n"
        );
    }
}
