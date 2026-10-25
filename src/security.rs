//! Host/origin validation, bearer authentication and expiring browser sessions.
use crate::server::Owner;
use axum::{
    extract::{Request, State},
    http::{header, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub struct Runtime {
    pub owner: Owner,
    pub shutdown: tokio::sync::Notify,
    pub draining: AtomicBool,
    pub requests: AtomicUsize,
    pub admission: Mutex<()>,
    sessions: Mutex<HashMap<String, Instant>>,
    session_cookie: String,
    pub hosts: Vec<String>,
    pub origins: Vec<String>,
}
impl Runtime {
    pub fn new(owner: Owner, hosts: Vec<String>, origins: Vec<String>) -> Self {
        use sha2::{Digest, Sha256};
        let digest = format!("{:x}", Sha256::digest(owner.record.server_id.as_bytes()));
        let session_cookie = format!("noctua_session_{}", &digest[..16]);
        Self {
            owner,
            session_cookie,
            hosts,
            origins,
            shutdown: tokio::sync::Notify::new(),
            draining: AtomicBool::new(false),
            requests: AtomicUsize::new(0),
            admission: Mutex::new(()),
            sessions: Mutex::new(HashMap::new()),
        }
    }
    pub fn cookie_name(&self) -> &str {
        &self.session_cookie
    }
    pub fn session(&self) -> String {
        let value = uuid::Uuid::new_v4().simple().to_string();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, expiry| *expiry > Instant::now());
        if sessions.len() >= 256 {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, expiry)| **expiry)
                .map(|(id, _)| id.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(
            value.clone(),
            Instant::now() + Duration::from_secs(12 * 3600),
        );
        value
    }
    fn cookie_valid(&self, request: &Request) -> bool {
        let cookie = request
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let value = cookie
            .split(';')
            .filter_map(|c| c.trim().strip_prefix(&format!("{}=", self.session_cookie)))
            .next();
        value.is_some_and(|v| {
            self.sessions
                .lock()
                .unwrap()
                .get(v)
                .is_some_and(|t| *t > Instant::now())
        })
    }
    pub fn identity(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(&self.owner.record).unwrap();
        v["name"] =
            json!(std::env::var("NOCTUA_SERVER_NAME").unwrap_or_else(|_| "Noctua server".into()));
        v["ready"] = json!(!self.draining.load(Ordering::SeqCst));
        v["capabilities"] = json!({"note_versions":true,"browser_sessions":true,"mcp_bearer":true,"native_management":false});
        v
    }
}
struct RequestCount(Arc<Runtime>);
impl Drop for RequestCount {
    fn drop(&mut self) {
        self.0.requests.fetch_sub(1, Ordering::SeqCst);
    }
}
// Compare fixed-length secrets without early exit.
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |n, (a, b)| n | (a ^ b)) == 0
}
pub async fn guard(
    State(state): State<(Arc<Vec<String>>, Option<Arc<Runtime>>)>,
    request: Request,
    next: Next,
) -> Response {
    let (fallback, runtime) = state;
    let hosts = runtime
        .as_ref()
        .map(|r| r.hosts.as_slice())
        .unwrap_or(&fallback);
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !hosts.iter().any(|v| v == host) {
        return (StatusCode::FORBIDDEN, "Unexpected Host").into_response();
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if let Some(origin) = origin {
        let valid = runtime
            .as_ref()
            .map(|r| r.origins.iter().any(|v| v == origin))
            .unwrap_or_else(|| hosts.iter().any(|h| origin == format!("http://{h}")));
        if !valid {
            return (StatusCode::FORBIDDEN, "Unexpected Origin").into_response();
        }
    }
    let Some(runtime) = runtime else {
        return next.run(request).await;
    };
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|v| equal(v, &runtime.owner.token));
    let cookie = runtime.cookie_valid(&request);
    let path = request.uri().path();
    if path == "/auth/login" && request.method() == Method::POST {
        if !bearer {
            return (StatusCode::UNAUTHORIZED, "Authentication failed").into_response();
        }
        let secure = origin.is_some_and(|o| o.starts_with("https://"));
        return (
            [
                (
                    header::SET_COOKIE,
                    format!(
                        "{}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200{}",
                        runtime.cookie_name(),
                        runtime.session(),
                        if secure { "; Secure" } else { "" }
                    ),
                ),
                (header::CACHE_CONTROL, "no-store".into()),
            ],
            Json(json!({"ok":true})),
        )
            .into_response();
    }
    if !bearer && !cookie {
        if request.method() == Method::GET && !path.starts_with("/api/") && path != "/mcp" {
            return (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                include_str!("../web/login.html"),
            )
                .into_response();
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Authentication required. Reconnect to this server."})),
        )
            .into_response();
    }
    if request
        .headers()
        .get("x-noctua-server")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|id| id != runtime.owner.record.server_id)
    {
        return (StatusCode::CONFLICT,Json(json!({"error":"Server identity changed. Local drafts are preserved; reopen Server & connection before saving."}))).into_response();
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD) && !bearer {
        // SameSite cookie alone is insufficient: require exact Origin and a non-simple header.
        if origin.is_none()
            || request
                .headers()
                .get("x-noctua-client")
                .and_then(|v| v.to_str().ok())
                != Some("1")
        {
            return (StatusCode::FORBIDDEN, "CSRF validation failed").into_response();
        }
        if request
            .headers()
            .get("x-noctua-server")
            .and_then(|v| v.to_str().ok())
            != Some(runtime.owner.record.server_id.as_str())
        {
            return (StatusCode::CONFLICT,Json(json!({"error":"Server identity is required before saving. Reconnect to this server."}))).into_response();
        }
    }
    if path == "/api/server/stop" {
        if !bearer {
            return (StatusCode::FORBIDDEN, "Use the local server manager").into_response();
        }
        // Stop is authorized only with the current instance proof read from a local private record.
        if !request
            .headers()
            .get("x-noctua-control")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| equal(v, &runtime.owner.control))
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    {
        let _admission = runtime.admission.lock().unwrap();
        if runtime.draining.load(Ordering::SeqCst) {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "Server is draining; reconnect shortly",
            )
                .into_response();
        }
        runtime.requests.fetch_add(1, Ordering::SeqCst);
    }
    // A disconnected HTTP subscriber must not drop a server-side write/AI future.
    // The admitted task owns its counter until completion, even if this response is abandoned.
    let count = RequestCount(runtime);
    let task = tokio::spawn(async move {
        use tokio_stream::StreamExt;
        let response = next.run(request).await;
        let (parts, body) = response.into_parts();
        let stream = body.into_data_stream().map(move |chunk| {
            let _keep_alive = &count;
            chunk
        });
        Response::from_parts(parts, axum::body::Body::from_stream(stream))
    });
    let mut response = match task.await {
        Ok(response) => response,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Server request failed").into_response()
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::post, Router};
    use tower::ServiceExt;
    #[tokio::test]
    async fn lost_client_does_not_cancel_an_admitted_server_job() {
        let root =
            std::env::temp_dir().join(format!("noctua-request-test-{}", uuid::Uuid::new_v4()));
        let owner = Owner::acquire(&root, "http://127.0.0.1:1").unwrap();
        let token = owner.token.clone();
        let runtime = Arc::new(Runtime::new(
            owner,
            vec!["127.0.0.1:1".into()],
            vec!["http://127.0.0.1:1".into()],
        ));
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let finished = Arc::new(AtomicBool::new(false));
        let (s, r, f) = (started.clone(), release.clone(), finished.clone());
        let router = Router::new()
            .route(
                "/job",
                post(move || {
                    let (s, r, f) = (s.clone(), r.clone(), f.clone());
                    async move {
                        s.notify_one();
                        r.notified().await;
                        f.store(true, Ordering::SeqCst);
                        StatusCode::OK
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                (Arc::new(vec!["127.0.0.1:1".into()]), Some(runtime.clone())),
                guard,
            ));
        let request = Request::builder()
            .uri("/job")
            .method("POST")
            .header("host", "127.0.0.1:1")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let client = tokio::spawn(router.oneshot(request));
        started.notified().await;
        client.abort();
        let _ = client.await;
        assert_eq!(runtime.requests.load(Ordering::SeqCst), 1);
        release.notify_one();
        for _ in 0..50 {
            if finished.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(finished.load(Ordering::SeqCst));
        assert_eq!(runtime.requests.load(Ordering::SeqCst), 0);
        drop(runtime);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use axum::{body::Body, routing::get, Router};
    use tower::ServiceExt;
    #[tokio::test]
    async fn response_stream_retains_request_ownership_until_dropped() {
        let root =
            std::env::temp_dir().join(format!("noctua-stream-test-{}", uuid::Uuid::new_v4()));
        let owner = Owner::acquire(&root, "http://127.0.0.1:1").unwrap();
        let token = owner.token.clone();
        let runtime = Arc::new(Runtime::new(owner, vec!["127.0.0.1:1".into()], vec![]));
        let router = Router::new()
            .route(
                "/stream",
                get(|| async {
                    Body::from_stream(
                        tokio_stream::pending::<Result<&'static str, std::io::Error>>(),
                    )
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                (Arc::new(vec![]), Some(runtime.clone())),
                guard,
            ));
        let request = Request::builder()
            .uri("/stream")
            .header("host", "127.0.0.1:1")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(
            runtime.requests.load(Ordering::SeqCst),
            1,
            "An unfinished response must prevent safe shutdown"
        );
        drop(response);
        assert_eq!(runtime.requests.load(Ordering::SeqCst), 0);
        drop(runtime);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn sessions_of_distinct_servers_can_coexist_on_one_loopback_host() {
        let root =
            std::env::temp_dir().join(format!("noctua-cookie-test-{}", uuid::Uuid::new_v4()));
        let first = Runtime::new(
            Owner::acquire(&root.join("first"), "http://127.0.0.1:1").unwrap(),
            vec![],
            vec![],
        );
        let second = Runtime::new(
            Owner::acquire(&root.join("second"), "http://127.0.0.1:2").unwrap(),
            vec![],
            vec![],
        );
        assert_ne!(first.cookie_name(), second.cookie_name());
        let a = first.session();
        let b = second.session();
        let request = Request::builder()
            .uri("/")
            .header(
                "cookie",
                format!("{}={a}; {}={b}", first.cookie_name(), second.cookie_name()),
            )
            .body(Body::empty())
            .unwrap();
        assert!(first.cookie_valid(&request));
        assert!(second.cookie_valid(&request));
        let wrong = Request::builder()
            .uri("/")
            .header("cookie", format!("{}={b}", first.cookie_name()))
            .body(Body::empty())
            .unwrap();
        assert!(!first.cookie_valid(&wrong));
        drop((first, second));
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn session_capacity_does_not_log_out_every_existing_client() {
        let root =
            std::env::temp_dir().join(format!("noctua-session-test-{}", uuid::Uuid::new_v4()));
        let owner = Owner::acquire(&root, "http://127.0.0.1:1").unwrap();
        let runtime = Runtime::new(owner, vec![], vec![]);
        for _ in 0..256 {
            runtime.session();
        }
        let newest = runtime.session();
        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(sessions.len(), 256);
        assert!(sessions.contains_key(&newest));
        drop(sessions);
        drop(runtime);
        let _ = std::fs::remove_dir_all(root);
    }
}
