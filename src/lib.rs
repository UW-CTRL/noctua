//! Noctua: a local research app for exploring Semantic Scholar citation
//! graphs, native Library collections and LaTeX notes. `start` runs the local web server;
//! the browser binary (`src/main.rs`) and the desktop app (`app/`) both use it.

mod agent;
mod cache;
mod chat;
mod chat_files;
mod history;
mod library;
mod reader;
mod pdf_outline;
mod pdf_agent;
mod pdf_autohighlight;
mod media;
mod mcp;
mod mcp_data;
mod mcp_edits;
mod notes;
mod editing;
mod workspace;
mod bibliography;
mod skills;
pub mod paths;
mod project;
mod s2;
mod settings;
mod storage;
mod threads;
mod zotero;

use std::{env, future::{Future, IntoFuture}, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::{cache::Cache, history::History, notes::Notes, project::Projects, s2::S2, settings::Settings, zotero::Zotero};

pub use settings::AppIcon;

/// Requests from the page to the desktop app (absent in browser mode).
pub enum DesktopCmd {
    /// Apply the selected running-app icon, optionally acknowledging the result.
    SetAppIcon(AppIcon, Option<oneshot::Sender<Result<(), String>>>),
    /// Open a new window showing this app URL (path and #hash).
    NewWindow(String),
    /// Open an external link in the system browser.
    OpenExternal(String),
    /// Show a native folder picker; replies with the chosen path.
    PickFolder(oneshot::Sender<Option<String>>),
    /// Close a window (its last tab was closed).
    CloseWindow(String),
    /// Check, install, or restart after a signed desktop update.
    Update(UpdateAction, Option<String>, oneshot::Sender<Result<Value, String>>),
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateAction { Check, StartupCheck, Install, Restart }

pub struct ServeOptions {
    /// 0 picks a free port.
    pub port: u16,
    pub desktop: Option<mpsc::UnboundedSender<DesktopCmd>>,
}

/// An error with a specific HTTP status and a message for the user.
#[derive(Debug)]
pub(crate) struct Status(pub StatusCode, pub String);

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.1)
    }
}

impl std::error::Error for Status {}


struct App {
    s2: S2,
    zotero: Zotero,
    library: library::Library,
    /// UI commands from the chat assistant's tools, forwarded to the browser.
    actions: broadcast::Sender<Value>,
    base_url: String,
    chat_dir: PathBuf,
    history: History,
    projects: Projects,
    notes: Notes,
    data_dir: PathBuf,
    _storage_lease: Option<std::fs::File>,
    settings: std::sync::Mutex<Settings>,
    desktop: Option<mpsc::UnboundedSender<DesktopCmd>>,
    login_gate: tokio::sync::Mutex<()>,
    chat_jobs: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl App {
    fn library_items(&self, target: &str) -> anyhow::Result<Vec<Value>> {
        let include = self.settings.lock().unwrap().library.include_subfolders;
        self.library.items_scoped(target, include)
    }
    fn library_collections(&self) -> anyhow::Result<Value> {
        let include = self.settings.lock().unwrap().library.include_subfolders;
        if include { self.library.collections_scoped(true) } else { self.library.collections() }
    }
    fn ui(&self, action: Value) {
        let _ = self.actions.send(action);
    }
}

type Shared = State<Arc<App>>;

struct ApiError(anyhow::Error);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = if let Some(s) = self.0.downcast_ref::<Status>() {
            s.0
        } else if self.0.is::<s2::NotFound>() {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_GATEWAY
        };
        (status, Json(json!({ "error": format!("{:#}", self.0) }))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

type ApiResult = Result<Json<Value>, ApiError>;

#[derive(Deserialize)]
struct SearchQ {
    q: String,
    #[serde(default)]
    offset: u32,
}

#[derive(Deserialize)]
struct IdQ {
    id: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct LinksBody {
    ids: Vec<String>,
}

#[derive(Deserialize)]
struct CheckBody {
    papers: Vec<Value>,
}

#[derive(Deserialize)]
struct AddBody {
    paper: Value,
    target: Option<String>,
    #[serde(default)]
    attach_pdf: bool,
}

async fn search(State(app): Shared, Query(q): Query<SearchQ>) -> ApiResult {
    Ok(Json(app.s2.search(&q.q, q.offset).await?))
}

async fn paper(State(app): Shared, Query(q): Query<IdQ>) -> ApiResult {
    Ok(Json(app.s2.paper(&q.id).await?))
}

async fn graph(State(app): Shared, Query(q): Query<IdQ>) -> ApiResult {
    let limit = q.limit.unwrap_or(60).clamp(5, 300);
    Ok(Json(app.s2.graph(&q.id, limit).await?))
}

async fn similar(State(app): Shared, Query(q): Query<IdQ>) -> ApiResult {
    let limit = q.limit.unwrap_or(30).clamp(1, 100);
    Ok(Json(app.s2.similar(&q.id, limit).await?))
}

async fn links(State(app): Shared, Json(b): Json<LinksBody>) -> ApiResult {
    let edges = app.s2.links(&b.ids).await?;
    Ok(Json(json!(edges)))
}

async fn status(State(app): Shared) -> Json<Value> {
    let (pending, sent) = app.s2.stats();
    Json(json!({ "pending": pending, "sent": sent }))
}

async fn library_collections(State(app): Shared) -> ApiResult {
    Ok(Json(app.library_collections()?))
}

#[derive(Deserialize)]
struct TargetQ {
    target: String,
}

#[derive(Deserialize)]
struct TitleQ {
    title: String,
}

async fn match_title(State(app): Shared, Query(q): Query<TitleQ>) -> ApiResult {
    Ok(Json(app.s2.match_title(&q.title).await?))
}

async fn library_items(State(app): Shared, Query(q): Query<TargetQ>) -> ApiResult {
    Ok(Json(json!(app.library_items(&q.target)?)))
}

async fn project_graph(State(app): Shared, Query(q): Query<TargetQ>) -> ApiResult {
    Ok(Json(project::graph(&app, &q.target).await?))
}

async fn library_check(State(app): Shared, Json(b): Json<CheckBody>) -> ApiResult {
    Ok(Json(json!(app.library.check(&b.papers)?)))
}

#[derive(Deserialize)]
struct RenameBody {
    target: String,
    name: String,
}

async fn library_rename(State(app): Shared, Json(b): Json<RenameBody>) -> ApiResult {
    app.library.rename(&b.target, &b.name)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NewFolderBody {
    parent: String,
    name: String,
}

async fn library_new_folder(State(app): Shared, Json(b): Json<NewFolderBody>) -> ApiResult {
    let id = app.library.create_collection(&b.parent, &b.name)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct ModeQ {
    #[serde(default)]
    mode: String,
    chat_id: Option<String>,
}

async fn mcp_endpoint(State(app): Shared, Query(q): Query<ModeQ>, Json(req): Json<Value>) -> Response {
    match mcp::handle(&app, &req, chat::mode_or_default(&q.mode), q.chat_id.as_deref()).await {
        Some(resp) => Json(resp).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn chat_endpoint(State(app): Shared, Json(b): Json<chat::ChatBody>) -> Result<Response, ApiError> {
    Ok(([(header::CONTENT_TYPE, "application/x-ndjson")], chat::stream(app, b)?).into_response())
}

#[derive(Deserialize, Default)]
struct AgentQuery { provider: Option<agent::Provider> }
impl AgentQuery {
    fn provider(&self, app: &App) -> agent::Provider { self.provider.unwrap_or_else(|| app.settings.lock().unwrap().agent) }
}

async fn chats_list(State(app): Shared, Query(q): Query<AgentQuery>) -> ApiResult {
    Ok(Json(app.history.list(q.provider(&app))?))
}

async fn chats_get(State(app): Shared, Path(id): Path<String>, Query(q): Query<AgentQuery>) -> Response {
    match app.history.get(&id, q.provider(&app)) {
        Ok(Some(mut c)) => { c["busy"] = json!(app.chat_jobs.lock().unwrap().contains(&id)); Json(c).into_response() },
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "no such chat" }))).into_response(),
        Err(e) => ApiError(e).into_response(),
    }
}

async fn chats_delete(State(app): Shared, Path(id): Path<String>, Query(q): Query<AgentQuery>) -> ApiResult {
    if app.chat_jobs.lock().unwrap().contains(&id) { return Err(Status(StatusCode::CONFLICT, "Stop this chat before deleting it.".into()).into()); }
    app.history.delete(&id, q.provider(&app))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NewNote {
    target: String,
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
struct ThreadsBody {
    #[serde(flatten)]
    req: threads::Request,
    provider: Option<agent::Provider>,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    cache_only: bool,
}

#[derive(Deserialize)]
struct InkBody {
    png: String,
    provider: Option<agent::Provider>,
}

async fn notes_list(State(app): Shared, Query(q): Query<TargetQ>) -> ApiResult {
    let folder = app.library.folder_id(&q.target)?;
    let mut list=app.notes.list(&folder)?;
    let workspace=workspace::snapshot(&app,&q.target)?;
    list.as_array_mut().unwrap().retain(|n|!workspace["entries"].as_array().unwrap().iter().any(|e|e["note"]==n["id"]&&e["deleted"]==true));
    Ok(Json(list))
}

/// All notes across folders, for @-mentions and note links.
async fn notes_all(State(app): Shared) -> ApiResult {
    let mut out = Vec::new();
    for (folder, list) in app.notes.list_all()? {
        let target = app.library.folder_target(&folder);
        let workspace=target.as_deref().map(|t|workspace::snapshot(&app,t)).transpose()?;
        for mut n in list.as_array().cloned().unwrap_or_default() {
            if workspace.as_ref().is_some_and(|m|m["entries"].as_array().unwrap().iter().any(|e|e["note"]==n["id"]&&e["deleted"]==true)){continue;}
            n["folder"] = json!(folder);
            n["target"] = json!(target);
            out.push(n);
        }
    }
    Ok(Json(json!(out)))
}

async fn notes_create(State(app): Shared, Json(b): Json<NewNote>) -> ApiResult {
    let folder = app.library.folder_id(&b.target)?;
    Ok(Json(app.notes.create(&folder, &b.title)?))
}

async fn notes_get(State(app): Shared, Path((target, id)): Path<(String, String)>) -> Response {
    let res = app.library.folder_id(&target).and_then(|f| app.notes.get(&f, &id));
    match res {
        Ok(Some(n)) => Json(n).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "no such note" }))).into_response(),
        Err(e) => ApiError(e).into_response(),
    }
}

async fn notes_save(State(app): Shared, Path((target, id)): Path<(String, String)>, Json(doc): Json<Value>) -> ApiResult {
    let folder = app.library.folder_id(&target)?;
    Ok(Json(json!({ "updated": app.notes.save(&folder, &id, doc)? })))
}

async fn notes_history(State(app):Shared,Path((target,id)):Path<(String,String)>)->ApiResult {Ok(Json(app.notes.history(&app.library.folder_id(&target)?,&id,None,None)?))}
async fn notes_undo(State(app):Shared,Path((target,id)):Path<(String,String)>,Json(b):Json<Value>)->ApiResult {Ok(Json(app.notes.history(&app.library.folder_id(&target)?,&id,Some(b["redo"]==true),b["updated"].as_u64())?))}

async fn notes_delete(State(app): Shared, Path((target, id)): Path<(String, String)>) -> ApiResult {
    let folder = app.library.folder_id(&target)?;
    app.notes.delete(&folder, &id)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ImageNameQ {
    #[serde(default)]
    name: String,
}

async fn note_image_upload(
    State(app): Shared,
    Path(target): Path<String>,
    Query(q): Query<ImageNameQ>,
    body: axum::body::Bytes,
) -> ApiResult {
    let folder = app.library.folder_id(&target)?;
    Ok(Json(json!({ "path": app.notes.save_image(&folder, &q.name, &body)? })))
}

async fn note_image_get(State(app): Shared, Path((target, file)): Path<(String, String)>) -> Response {
    let found = app
        .library
        .folder_id(&target)
        .and_then(|f| app.notes.image_path(&f, &file))
        .and_then(|(path, mime)| Ok((std::fs::read(path)?, mime)));
    match found {
        Ok((bytes, mime)) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CACHE_CONTROL, "max-age=31536000, immutable"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "no such image" }))).into_response(),
    }
}

async fn ink_latex(State(app): Shared, Json(b): Json<InkBody>) -> ApiResult {
    Ok(Json(json!({ "latex": notes::ink_to_latex(&app, b.provider.unwrap_or_else(|| app.settings.lock().unwrap().agent), &b.png).await? })))
}

async fn explain_threads(State(app): Shared, Json(b): Json<ThreadsBody>) -> ApiResult {
    let provider = b.provider.unwrap_or_else(|| app.settings.lock().unwrap().agent);
    Ok(Json(threads::explain(&app, provider, b.req, b.force, b.cache_only).await?))
}

async fn library_add(State(app): Shared, Json(b): Json<AddBody>) -> ApiResult {
    let key = app.library.save(&b.paper, b.target.as_deref().unwrap_or("L1"))?;
    let warning = if b.attach_pdf { app.library.download(&key).await.err().map(|e| format!("{e:#}")) } else { None };
    Ok(Json(json!({ "ok": true, "key": key, "paper": app.library.paper(&key)?, "warning": warning })))
}

fn asset(body: &'static str, mime: &'static str) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, mime)], body)
}

/// KaTeX's math fonts, embedded so notes typeset offline.
const KATEX_FONTS: &[(&str, &[u8])] = &[
    ("KaTeX_AMS-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_AMS-Regular.woff2")),
    ("KaTeX_Caligraphic-Bold.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2")),
    ("KaTeX_Caligraphic-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2")),
    ("KaTeX_Fraktur-Bold.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2")),
    ("KaTeX_Fraktur-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2")),
    ("KaTeX_Main-Bold.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Main-Bold.woff2")),
    ("KaTeX_Main-BoldItalic.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2")),
    ("KaTeX_Main-Italic.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Main-Italic.woff2")),
    ("KaTeX_Main-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Main-Regular.woff2")),
    ("KaTeX_Math-BoldItalic.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2")),
    ("KaTeX_Math-Italic.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Math-Italic.woff2")),
    ("KaTeX_SansSerif-Bold.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2")),
    ("KaTeX_SansSerif-Italic.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2")),
    ("KaTeX_SansSerif-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2")),
    ("KaTeX_Script-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Script-Regular.woff2")),
    ("KaTeX_Size1-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Size1-Regular.woff2")),
    ("KaTeX_Size2-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Size2-Regular.woff2")),
    ("KaTeX_Size3-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Size3-Regular.woff2")),
    ("KaTeX_Size4-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Size4-Regular.woff2")),
    ("KaTeX_Typewriter-Regular.woff2", include_bytes!("../web/vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2")),
];

async fn katex_font(Path(name): Path<String>) -> Response {
    match KATEX_FONTS.iter().find(|(n, _)| *n == name) {
        Some((_, bytes)) => (
            [(header::CONTENT_TYPE, "font/woff2"), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
            *bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct UrlBody {
    url: String,
}

fn desktop(app: &App) -> Result<&mpsc::UnboundedSender<DesktopCmd>, ApiError> {
    app.desktop
        .as_ref()
        .ok_or_else(|| ApiError(Status(StatusCode::NOT_FOUND, "only available in the desktop app".into()).into()))
}

async fn desktop_window(State(app): Shared, Json(b): Json<UrlBody>) -> ApiResult {
    if !b.url.starts_with('/') {
        return Err(ApiError(Status(StatusCode::BAD_REQUEST, "expected an app path".into()).into()));
    }
    let _ = desktop(&app)?.send(DesktopCmd::NewWindow(b.url));
    Ok(Json(json!({ "ok": true })))
}

async fn desktop_open(State(app): Shared, Json(b): Json<UrlBody>) -> ApiResult {
    if !(b.url.starts_with("https://") || b.url.starts_with("http://") || b.url.starts_with("mailto:")) {
        return Err(ApiError(Status(StatusCode::BAD_REQUEST, "only web links can be opened".into()).into()));
    }
    let _ = desktop(&app)?.send(DesktopCmd::OpenExternal(b.url));
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct WindowBody {
    window: String,
}

async fn desktop_close(State(app): Shared, Json(b): Json<WindowBody>) -> ApiResult {
    let _ = desktop(&app)?.send(DesktopCmd::CloseWindow(b.window));
    Ok(Json(json!({ "ok": true })))
}

async fn desktop_pick_folder(State(app): Shared) -> ApiResult {
    let (tx, rx) = oneshot::channel();
    let _ = desktop(&app)?.send(DesktopCmd::PickFolder(tx));
    Ok(Json(json!({ "path": rx.await.ok().flatten() })))
}

#[derive(Deserialize)]
struct UpdateBody { action: UpdateAction, version: Option<String> }

async fn desktop_update(State(app): Shared, Json(body): Json<UpdateBody>) -> ApiResult {
    let (tx, rx) = oneshot::channel();
    desktop(&app)?.send(DesktopCmd::Update(body.action, body.version, tx))
        .map_err(|_| anyhow::anyhow!("The desktop app is unavailable."))?;
    let result = rx.await.map_err(|_| anyhow::anyhow!("The desktop updater stopped."))?
        .map_err(anyhow::Error::msg)?;
    Ok(Json(result))
}

/// Only this server's own pages (and local tools like `claude`) may use it:
/// the Host must be our address (stops DNS rebinding), and a write from a
/// page must come from our own origin (stops other websites posting to it).
async fn guard(State(hosts): State<Arc<Vec<String>>>, req: Request, next: Next) -> Response {
    if env::var_os("NOCTUA_DEBUG").is_some() {
        eprintln!("{} {}", req.method(), req.uri());
    }
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !hosts.iter().any(|h| h == host) {
        return (StatusCode::FORBIDDEN, "unexpected Host").into_response();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
            if !hosts.iter().any(|h| origin == format!("http://{h}")) {
                return (StatusCode::FORBIDDEN, "cross-origin request refused").into_response();
            }
        }
    }
    next.run(req).await
}

/// Sets up the data folder and starts the server on 127.0.0.1. Returns its
/// URL and the future that runs it.
pub async fn start(opts: ServeOptions) -> anyhow::Result<(String, impl Future<Output = std::io::Result<()>>)> {
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], opts.port))).await?;
    let storage_lease = storage::lease()?;
    let data = paths::data_dir()?;
    storage::share_lease(&storage_lease)?;
    std::fs::create_dir_all(&data)?;
    let migrated = paths::migrate_legacy(&data)?;
    let mut settings = Settings::load(&data);
    if let Some(old) = &migrated {
        println!("Moved Noctua's data from {} to {} (the old files were left in place).", old.display(), data.display());
        if settings.zotero_dir.is_none() {
            settings.zotero_dir = settings::zotero_suggestion().map(|d| d.to_string_lossy().into_owned());
            settings.save(&data)?;
        }
    }
    let key = settings::load_key(&data);
    if key.is_none() {
        println!("No Semantic Scholar key yet: Noctua will ask for one in its window.");
    }

    let port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{port}");
    let hosts = Arc::new(vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")]);

    let cache = Arc::new(Cache::open(&data.join("noctua-cache.sqlite"))?);
    let app = Arc::new(App {
        s2: S2::new(key, cache),
        zotero: Zotero::new(settings::zotero_dir(&settings)),
        library: library::Library::open(data.join("library"))?,
        actions: broadcast::channel(32).0,
        base_url: url.clone(),
        chat_dir: data.join(".noctua-chat"),
        history: History::open(&data.join("noctua-chats.sqlite"))?,
        projects: Projects::open(&data.join("noctua-projects.sqlite"))?,
        notes: Notes::new(env::var("NOCTUA_NOTES").map(PathBuf::from).unwrap_or_else(|_| data.join("notes"))),
        data_dir: data,
        _storage_lease: storage_lease,
        settings: std::sync::Mutex::new(settings),
        desktop: opts.desktop,
        login_gate: tokio::sync::Mutex::new(()),
        chat_jobs: std::sync::Mutex::new(Default::default()),
    });

    if let Some(desktop) = &app.desktop {
        let icon = app.settings.lock().unwrap().app_icon;
        let _ = desktop.send(DesktopCmd::SetAppIcon(icon, None));
    }
    Ok((url, axum::serve(listener, router(app, hosts)).into_future()))
}

fn router(app: Arc<App>, hosts: Arc<Vec<String>>) -> Router {
    Router::new()
        .route("/", get(|| async { asset(include_str!("../web/index.html"), "text/html; charset=utf-8") }))
        .route("/app.js", get(|| async { asset(include_str!("../web/app.js"), "text/javascript; charset=utf-8") }))
        .route("/chat-render.js", get(|| async { asset(include_str!("../web/chat-render.js"), "text/javascript; charset=utf-8") }))
        .route("/vendor/highlight/highlight.min.js", get(|| async { asset(include_str!("../web/vendor/highlight/highlight.min.js"), "text/javascript; charset=utf-8") }))
        .route("/vendor/highlight/latex.min.js", get(|| async { asset(include_str!("../web/vendor/highlight/latex.min.js"), "text/javascript; charset=utf-8") }))
        .route("/vendor/mermaid/mermaid.min.js", get(|| async { asset(include_str!("../web/vendor/mermaid/mermaid.min.js"), "text/javascript; charset=utf-8") }))
        .route("/icons.css", get(|| async { asset(include_str!("../web/icons.css"), "text/css; charset=utf-8") }))
        .route("/style.css", get(|| async { asset(include_str!("../web/style.css"), "text/css; charset=utf-8") }))
        .route("/latex.js", get(|| async { asset(include_str!("../web/latex.js"), "text/javascript; charset=utf-8") }))
        .route("/ink.js", get(|| async { asset(include_str!("../web/ink.js"), "text/javascript; charset=utf-8") }))
        .route("/notes.js", get(|| async { asset(include_str!("../web/notes.js"), "text/javascript; charset=utf-8") }))
        .route("/chat-files.js", get(|| async { asset(include_str!("../web/chat-files.js"), "text/javascript; charset=utf-8") }))
        .route("/chat-selections.js", get(|| async { asset(include_str!("../web/chat-selections.js"), "text/javascript; charset=utf-8") }))
        .route("/pdf-objects.js", get(|| async { asset(include_str!("../web/pdf-objects.js"), "text/javascript; charset=utf-8") }))
        .route("/mentions.js", get(|| async { asset(include_str!("../web/mentions.js"), "text/javascript; charset=utf-8") }))
        .route("/shell", get(|| async { asset(include_str!("../web/shell.html"), "text/html; charset=utf-8") }))
        .route("/shell.js", get(|| async { asset(include_str!("../web/shell.js"), "text/javascript; charset=utf-8") }))
        .route("/fonts.js", get(|| async { asset(include_str!("../web/fonts.js"), "text/javascript; charset=utf-8") }))
        .route("/select.js", get(|| async { asset(include_str!("../web/select.js"), "text/javascript; charset=utf-8") }))
        .route("/setup.js", get(|| async { asset(include_str!("../web/setup.js"), "text/javascript; charset=utf-8") }))
        .route("/edit-history.js",get(||async{asset(include_str!("../web/edit-history.js"),"text/javascript; charset=utf-8")}))
        .route("/workspace.js",get(||async{asset(include_str!("../web/workspace.js"),"text/javascript; charset=utf-8")}))
        .route("/figures.js", get(|| async { asset(include_str!("../web/figures.js"), "text/javascript; charset=utf-8") }))
        .route("/lineage.js", get(|| async { asset(include_str!("../web/lineage.js"), "text/javascript; charset=utf-8") }))
        .route("/vendor/katex/katex.min.js", get(|| async { asset(include_str!("../web/vendor/katex/katex.min.js"), "text/javascript; charset=utf-8") }))
        .route("/vendor/katex/katex.min.css", get(|| async { asset(include_str!("../web/vendor/katex/katex.min.css"), "text/css; charset=utf-8") }))
        .route("/vendor/katex/fonts/{name}", get(katex_font))
        .route("/api/search", get(search))
        .route("/api/paper", get(paper))
        .route("/api/graph", get(graph))
        .route("/api/similar", get(similar))
        .route("/api/links", post(links))
        .route("/api/status", get(status))
        .route("/api/library/collections", get(library_collections))
        .route("/api/library/items", get(library_items))
        .route("/api/library/check", post(library_check))
        .route("/api/library/add", post(library_add))
        .route("/api/library/rename", post(library_rename))
        .route("/api/library/folder", post(library_new_folder))
        .route("/api/match", get(match_title))
        .route("/api/project", get(project_graph))
        .route("/api/threads", post(explain_threads))
        .route("/api/chat-files", post(chat_files::upload).layer(DefaultBodyLimit::max(56 << 20)))
        .route("/api/chat-files/{id}", get(chat_files::download))
        .route("/api/chat", post(chat_endpoint))
        .route("/api/notes", get(notes_list).post(notes_create))
        .route("/api/notes/all", get(notes_all))
        .route(
            "/api/notes/{target}/{id}",
            get(notes_get).put(notes_save).delete(notes_delete).layer(DefaultBodyLimit::max(32 << 20)),
        )
        .route("/api/skills",get(skills::get).post(skills::upload).layer(DefaultBodyLimit::max(48 << 20)))
        .route("/api/skills/import-zip",post(skills::upload_zip).layer(DefaultBodyLimit::max(32 << 20)))
        .route("/api/skills/{id}/files/{*path}",get(skills::resource))
        .route("/api/skill-runs/{id}",get(skills::run_status).post(skills::decide))
        .route("/api/workspaces/{target}",get(workspace::get).post(workspace::edit))
        .route("/api/workspaces/{target}/history",post(workspace::undo))
        .route("/api/workspaces/{target}/upload",post(workspace::upload).layer(DefaultBodyLimit::max(32 << 20)))
        .route("/api/workspaces/{target}/files/{id}",get(workspace::text))
        .route("/api/workspaces/{target}/files/{id}/content",get(workspace::download))
        .route("/api/workspaces/{target}/files/{id}/history",post(workspace::file_undo))
        .route("/api/notes/{target}/{id}/history",get(notes_history).post(notes_undo))
        .route("/api/note-media/{target}", post(media::upload).layer(DefaultBodyLimit::disable()))
        .route("/api/note-media/{target}/{file}", get(media::get))
        .route("/api/note-images/{target}", post(note_image_upload).layer(DefaultBodyLimit::max(32 << 20)))
        .route("/api/note-images/{target}/{file}", get(note_image_get))
        .route("/api/ink-latex", post(ink_latex).layer(DefaultBodyLimit::max(16 << 20)))
        .route("/api/chats", get(chats_list))
        .route("/api/chats/{id}", get(chats_get).delete(chats_delete))
        .route("/api/agent-edits", get(mcp_edits::list))
        .route("/api/agent-edits/{id}", get(mcp_edits::get).post(mcp_edits::decide))
        .route("/mcp", post(mcp_endpoint))
        .route("/app-icons/dark.svg", get(|| async { asset(include_str!("../app/icons/icon-dark.svg"), "image/svg+xml") }))
        .route("/app-icons/light.svg", get(|| async { asset(include_str!("../app/icons/icon-light.svg"), "image/svg+xml") }))
        .route("/api/settings", get(settings::get))
        .route("/api/settings/app-icon", post(settings::set_app_icon))
        .route("/api/settings/library", post(settings::set_library))
        .route("/api/settings/storage", post(settings::set_storage))
        .route("/api/settings/agent", post(settings::set_agent))
        .route("/api/settings/highlight-colors", post(settings::set_highlight_colors))
        .route("/api/settings/highlight-palette", post(settings::set_highlight_palette))
        .route("/api/agents/{provider}", get(agent::status))
        .route("/api/agents/{provider}/models", get(agent::models))
        .route("/api/agents/{provider}/login", post(agent::login))
        .route("/api/settings/key", post(settings::set_key).delete(settings::delete_key))
        .route("/api/settings/skip", post(settings::skip_key))
        .route("/api/settings/zotero", post(settings::set_zotero))
        .route("/api/desktop/window", post(desktop_window))
        .route("/api/desktop/open", post(desktop_open))
        .route("/api/desktop/pick-folder", post(desktop_pick_folder))
        .route("/api/desktop/close", post(desktop_close))
        .route("/api/desktop/update", post(desktop_update))
        .merge(reader::routes())
        .with_state(app)
        .layer(middleware::from_fn_with_state(hosts, guard))
}
