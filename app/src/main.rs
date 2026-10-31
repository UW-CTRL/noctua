//! Local connection manager and native desktop controls. Data servers run separately.
//! Only bundled app content may invoke management commands; server windows have no
//! native management privileges. Browser transport readiness is checked before switching.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use noctua::DesktopCmd;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

mod appearance;
mod manager_frame;
mod icons;
mod updater;
mod frontend;

/// A fixed port keeps the pages' origin (and so their saved tabs and layout)
/// the same between launches; another free port is used if it's taken.
const PORT: u16 = 47878;

struct PendingReply {
    window: String,
    purpose: &'static str,
    sender: tokio::sync::oneshot::Sender<bool>,
}

struct Shell {
    connected: Mutex<Option<(String, String, String)>>,
    connection_gate: tokio::sync::Mutex<()>,
    flush: Mutex<std::collections::HashMap<String, PendingReply>>,
    windows: AtomicUsize,
}

fn main() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    if let Some(instance) = std::env::var_os("NOCTUA_TEST_INSTANCE") {
        #[cfg(not(debug_assertions))]
        {
            let _ = instance;
            eprintln!("Isolated test instances require a debug build");
            return;
        }
        #[cfg(debug_assertions)]
        {
            let instance = instance.to_string_lossy();
            assert!(
                instance.len() == 32 && instance.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "Invalid isolated test identifier"
            );
            for key in ["NOCTUA_HOME", "NOCTUA_CLIENT_HOME", "NOCTUA_SERVICE_HOME"] {
                let path = std::path::PathBuf::from(
                    std::env::var_os(key)
                        .expect("Isolated tests require explicit data, client and service folders"),
                );
                assert!(
                    path.is_absolute() && path.starts_with(std::env::temp_dir()),
                    "Isolated test folders must be under the OS temporary directory"
                );
            }
            context.config_mut().identifier = format!("app.noctua.desktop.test.t{instance}");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_window(app, Some("/"))
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(
                    option_env!("NOCTUA_UPDATER_PUBLIC_KEY")
                        .unwrap_or("")
                        .trim(),
                )
                .build(),
        )
        .manage(updater::Updates::default())
        .manage(frontend::Frontends::default())
        .manage(icons::Icons::default())
        .invoke_handler(tauri::generate_handler![
            client_state,
            connect_server,
            local_server,
            desktop_action,
            clear_connection,
            dismiss_connection,
            present_client
        ])
        .setup(|app| {
            app.manage(Shell {
                connected: Mutex::new(None),
                connection_gate: tokio::sync::Mutex::new(()),
                flush: Mutex::new(Default::default()),
                windows: AtomicUsize::new(0),
            });
            app.set_menu(menu(app.handle())?)?;
            open_window(app.handle(), None);
            // Replace an already-running local owner after an app release update,
            // even when this client currently connects remotely. Never start a local
            // data server merely because a remote client opened the desktop app.
            let update_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Local startup already waits for the same update in connect_server.
                if noctua::client::load().is_ok_and(|connection| connection.mode == "local") {
                    return;
                }
                if let Ok(data) = noctua::paths::existing_data_dir() {
                    if noctua::server::status_any_for_update(&data).await.is_ok() {
                        if let Ok(binary) = server_executable(&update_app).await {
                            if let Err(error) =
                                noctua::server_update::ensure_current(&binary, PORT).await
                            {
                                eprintln!("Local server update: {error:#}");
                            }
                        }
                    }
                }
            });
            let path = noctua::client::config_dir()?.join("app-icon.json");
            if let Ok(body) = std::fs::read_to_string(path) {
                if let Ok(icon) = serde_json::from_str(&body) {
                    let _ = icons::apply(app.handle(), icon);
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new_window" => open_window(app, Some("/")),
            "close_window" => {
                if let Some(w) = focused(app) {
                    let _ = w.close();
                }
            }
            id => {
                let cmd = match id {
                    "new_tab" => "newTab",
                    "close_tab" => "closeTab",
                    "next_tab" => "nextTab",
                    "prev_tab" => "prevTab",
                    "reload" => "reload",
                    "settings" => "settings",
                    _ => return,
                };
                match focused(app) {
                    Some(w) if cmd == "settings" && w.label().starts_with("content") => {
                        let _ = w.eval("window.noctuaShell && noctuaShell.cmd('settings')");
                    }
                    Some(_) if cmd == "settings" => open_settings_section(app, "local"),
                    Some(w) => {
                        let _ = w.eval(&format!("window.noctuaShell && noctuaShell.cmd('{cmd}')"));
                    }
                    None if cmd == "newTab" || cmd == "settings" => open_window(app, None),
                    None => {}
                }
            }
        })
        .run(context)
        .expect("error while running Noctua");
}

fn run(app: &AppHandle, cmd: DesktopCmd) {
    match cmd {
        DesktopCmd::SetAppIcon(icon, reply) => {
            let handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                let result = icons::apply(&handle, icon).map_err(|e| e.to_string());
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                } else if let Err(error) = result {
                    eprintln!("Could not restore app icon: {error}");
                }
            }) {
                eprintln!("Could not schedule app icon update: {error}");
            }
        }
        DesktopCmd::NewWindow(url) => open_window(app, Some(&url)),
        DesktopCmd::OpenExternal(url) => {
            let _ = app.opener().open_url(url, None::<&str>);
        }
        DesktopCmd::PickFolder(reply) => app.dialog().file().pick_folder(move |p| {
            let _ = reply.send(p.map(|p| p.to_string()));
        }),
        DesktopCmd::CloseWindow(label) => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
        }
        DesktopCmd::Update(action, version, reply) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = updater::run(&app, action, version)
                    .await
                    .map_err(|e| e.to_string());
                let _ = reply.send(result);
            });
        }
    }
}

/// Opens a window (labels w1, w2, …); `open` is an app path for its first tab.
fn manager_path(open: Option<&str>) -> String {
    let Some(open) = open else {
        return "index.html".into();
    };
    let mut query = tauri::Url::parse("http://client/").unwrap();
    query
        .query_pairs_mut()
        .append_pair("new", "1")
        .append_pair("open", open);
    format!("index.html?{}", query.query().unwrap())
}
fn content_shell_url(
    address: &str,
    window: &str,
    fresh: bool,
    open: Option<&str>,
) -> anyhow::Result<tauri::Url> {
    let mut url = tauri::Url::parse(&format!("{address}/shell"))?;
    url.query_pairs_mut().append_pair("w", window);
    if fresh {
        url.query_pairs_mut().append_pair("fresh", "1");
    }
    if let Some(open) = open {
        anyhow::ensure!(
            open.starts_with('/')
                && !open.starts_with("//")
                && !open.starts_with("/shell")
                && !open.contains('\\')
                && !open.contains('\0'),
            "Expected a safe app path for the new window"
        );
        url.query_pairs_mut().append_pair("open", open);
    }
    Ok(url)
}

fn open_window(app: &AppHandle, open: Option<&str>) {
    let shell = app.state::<Shell>();
    let label = format!("w{}", shell.windows.fetch_add(1, Ordering::Relaxed) + 1);
    let manager_path = manager_path(open);
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(manager_path.into()))
        .initialization_script(&appearance::local_script())
        .title("Noctua")
        .visible(false)
        .inner_size(1440.0, 900.0)
        .min_inner_size(820.0, 520.0)
        .disable_drag_drop_handler() // let the page receive dropped images
        .build();
    match built {
        Ok(_) => {
            let icon = *app.state::<icons::Icons>().0.lock().unwrap();
            if let Err(error) = icons::apply(app, icon) {
                eprintln!("Could not apply app icon: {error}");
            }
        }
        Err(e) => eprintln!("couldn't open a window: {e}"),
    }
}

fn local_only(window: &Webview) -> Result<(), String> {
    if !window.label().starts_with('w') {
        return Err("Native management is restricted to the local connection screen".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    if !((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none()))
    {
        return Err("Native management is restricted to local app content".into());
    }
    Ok(())
}
fn open_settings_section(app: &AppHandle, section: &str) {
    if let Some(w) = app
        .webview_windows()
        .into_values()
        .find(|w| w.label().starts_with('w'))
    {
        let section = match section { "local" => "local", _ => "connection" };
        let _ = w.eval(&format!("window.openClientSettings?.('{section}')"));
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        open_window(app, None);
    }
}

fn bundled_server_executable(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    let name = if cfg!(windows) {
        "noctua-server.exe"
    } else {
        "noctua-server"
    };
    let packaged = app.path().resource_dir()?.join("binaries").join(name);
    let sibling = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "noctua.exe"
    } else {
        "noctua"
    });
    let path = if cfg!(debug_assertions) && sibling.is_file() {
        sibling
    } else {
        packaged
    };
    anyhow::ensure!(path.is_file(),"Server executable missing. Build `cargo build -p noctua` for development, or reinstall the desktop app");
    Ok(path)
}
async fn server_executable(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    let bundled = bundled_server_executable(app)?;
    let key = option_env!("NOCTUA_UPDATER_PUBLIC_KEY").unwrap_or("").trim();
    let selected = noctua::releases::selected(key, &bundled).await?.unwrap_or(bundled);
    noctua::service::stage(&selected)
}

#[tauri::command]
fn present_client(window: Webview) -> Result<(), String> {
    local_only(&window)?;
    window.window().show().map_err(|e|e.to_string())?;
    window.show().map_err(|e|e.to_string())?;
    window.set_focus().map_err(|e|e.to_string())
}
#[tauri::command]
fn dismiss_connection(app: AppHandle, window: Webview) -> Result<(), String> {
    local_only(&window)?;
    if let Some(content) = app.webview_windows().into_values().find(|w| w.label().starts_with("content")) {
        let _ = content.show();
        let _ = content.set_focus();
        let _ = window.window().hide();
    }
    Ok(())
}
#[tauri::command]
async fn clear_connection(app: AppHandle, window: Webview) -> Result<(), String> {
    local_only(&window)?;
    let shell = app.state::<Shell>();
    let _gate = shell
        .connection_gate
        .try_lock()
        .map_err(|_| "Another connection change is in progress".to_string())?;
    noctua::client::save(&noctua::client::Connection::default()).map_err(|e| e.to_string())
}
#[tauri::command]
async fn client_state(app: AppHandle, window: Webview) -> Result<Value, String> {
    local_only(&window)?;
    let connection = noctua::client::load().map_err(|e| e.to_string())?;
    let local = match noctua::paths::existing_data_dir() {
        Ok(data) => noctua::server::status(&data)
            .await
            .map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let recovery=match noctua::paths::existing_data_dir() {
        Ok(data) if local.as_ref().map_or(true,|identity|identity["capabilities"]["server_updates"]!=true)=>noctua::server_recovery::inspect(&data).await,
        _=>None,
    };
    let active = app.state::<Shell>().connected.lock().unwrap().clone();
    let current = if let Some((address, id, secret)) = active {
        match noctua::server::probe(&address, &secret).await {
            Ok(identity) if identity["server_id"] == id => {
                json!({"reachable":true,"identity":identity,"address":address})
            }
            Ok(_) => {
                json!({"reachable":false,"error":"The server identity changed. Reconnect explicitly."})
            }
            Err(error) => json!({"reachable":false,"error":error.to_string()}),
        }
    } else {
        json!({"reachable":false})
    };
    Ok(
        json!({"connection":connection,"local":local.as_ref().ok(),"local_error":local.as_ref().err(),"server_recovery":recovery,"current":current,"service":noctua::service::status(),"server_update":noctua::server_update::progress(),"version":env!("CARGO_PKG_VERSION")}),
    )
}
struct ProvisionalWindow {
    app: AppHandle,
    label: String,
    ticket: String,
    committed: bool,
}
impl Drop for ProvisionalWindow {
    fn drop(&mut self) {
        self.app
            .state::<Shell>()
            .flush
            .lock()
            .unwrap()
            .remove(&self.ticket);
        if !self.committed {
            if let Some(window) = self.app.get_webview_window(&self.label) {
                let _ = window.close();
            }
        }
    }
}
struct SwitchGuard(AppHandle);
impl Drop for SwitchGuard {
    fn drop(&mut self) {
        for window in self
            .0
            .webview_windows()
            .into_values()
            .filter(|w| w.label().starts_with("content"))
        {
            let _ = window.eval("window.noctuaShell?.endSwitch()");
        }
    }
}

async fn request_client(
    app: &AppHandle,
    window: &WebviewWindow,
    purpose: &'static str,
    operation: &str,
) -> Result<(), String> {
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.state::<Shell>().flush.lock().unwrap().insert(
        ticket.clone(),
        PendingReply {
            window: window.label().into(),
            purpose,
            sender,
        },
    );
    let script=format!("(async()=>{{let ok=false;try{{if(!window.noctuaShell)throw Error('Page not ready');await window.noctuaShell.{operation}();ok=true}}catch(e){{console.error('Connection change blocked: '+e.message)}}location.href='https://noctua.invalid/{purpose}/{ticket}/'+ok}})()");
    let evaluation = window.eval(&script);
    let result = if evaluation.is_ok() {
        tokio::time::timeout(std::time::Duration::from_secs(30), receiver)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    app.state::<Shell>().flush.lock().unwrap().remove(&ticket);
    if result == Some(true) {
        Ok(())
    } else {
        Err("Save failed or a tab is not ready. The current connection and edits were kept. Resolve unsaved edits before switching".into())
    }
}
async fn flush_clients(app: &AppHandle, skip: &str) -> Result<(), String> {
    let windows = app
        .webview_windows()
        .into_values()
        .filter(|w| w.label().starts_with("content") && w.label() != skip)
        .collect::<Vec<_>>();
    // Freeze every editor before saving the first one. They stay frozen until
    // the connection commits or SwitchGuard restores them after any failure.
    for window in &windows {
        request_client(app, window, "prepare", "beginSwitch").await?;
    }
    for window in &windows {
        request_client(app, window, "flush", "flush").await?;
    }
    Ok(())
}
fn verify_tested_server(identity: &Value, expected: Option<&str>) -> anyhow::Result<()> {
    if let Some(expected) = expected {
        anyhow::ensure!(identity["server_id"].as_str() == Some(expected), "The tested server identity changed. Go back and test the connection again before saving");
    }
    Ok(())
}
#[tauri::command]
async fn connect_server(
    app: AppHandle,
    window: Webview,
    mode: String,
    address: String,
    secret: String,
    test_only: bool,
    new_window: Option<bool>,
    open_path: Option<String>,
    expected_server_id: Option<String>,
    defer_server_update: Option<bool>,
) -> Result<Value, String> {
    local_only(&window)?;
    let shell = app.state::<Shell>();
    let _gate = shell
        .connection_gate
        .try_lock()
        .map_err(|_| "Another connection change is in progress. Retry shortly".to_string())?;
    let result: anyhow::Result<Value>=async {
        anyhow::ensure!(mode=="local"||mode=="remote","Choose this computer or a remote server");
        let (address,secret)=if mode=="local" {
            let v=if defer_server_update.unwrap_or(false) {noctua::server::status(&noctua::paths::existing_data_dir()?).await?}else{noctua::server_update::ensure_current(&server_executable(&app).await?,PORT).await?};
            (v["url"].as_str().ok_or_else(||anyhow::anyhow!("Invalid local identity"))?.to_owned(),noctua::server::token(&noctua::paths::existing_data_dir()?)?)
        }else{let address=noctua::server::validate_url(&address)?.origin().ascii_serialization();
            let secret=if secret.is_empty(){noctua::client::read_secret(&address)?}else{secret};(address,secret)};
        let identity=noctua::server::probe(&address,&secret).await?;
        verify_tested_server(&identity,expected_server_id.as_deref())?;
        let old=noctua::client::load()?;
        anyhow::ensure!(old.address!=address||old.server_id.is_empty()||old.server_id==identity["server_id"],"The server identity at this address changed. Choose a different address or clear the saved connection before accepting new data");
        let same_connection=shell.connected.lock().unwrap().as_ref().is_some_and(|(old_address,id,_)|old_address==&address&&Some(id.as_str())==identity["server_id"].as_str());
        let keep_windows=new_window.unwrap_or(false)&&same_connection;
        let cached=app.state::<frontend::Frontends>().0.lock().unwrap().get(&address).cloned();
        let ui=if let Some(ui)=cached {ui.authenticate(secret.clone(),identity["server_id"].as_str().unwrap().into());ui}
        else {
            let ui=noctua::frontend::start(&address,secret.clone(),identity["server_id"].as_str().unwrap().into(),frontend::asset,&noctua::client::config_dir()?.join("ui-ports")).await?;
            app.state::<frontend::Frontends>().0.lock().unwrap().insert(address.clone(),ui.clone());ui
        };
        let ui_address=ui.origin.clone();
        let destination=content_shell_url(&ui_address,window.label(),new_window.unwrap_or(false),open_path.as_deref())?;
        let parsed=tauri::Url::parse(&ui_address)?;
        let cookie=tauri::webview::Cookie::build((ui.cookie_name,ui.cookie_value)).domain(parsed.host_str().unwrap_or_default().to_string()).path("/").http_only(true).same_site(tauri::webview::cookie::SameSite::Strict).build();
        if same_connection {
            for old_window in app.webview_windows().into_values().filter(|w|w.label().starts_with("content")){old_window.set_cookie(cookie.clone())?;}
        }
        let label=format!("content{}",app.state::<Shell>().windows.fetch_add(1,Ordering::Relaxed));
        let manager_url=manager_frame::start(&app,&label,window.label(),&ui_address)?;
        let manager_origin=tauri::Url::parse(&manager_url)?.origin().ascii_serialization();
        let callback_app=app.clone();
        let callback_label=label.clone();
        let navigation_origin=ui_address.clone();
        let opener_app=app.clone();
        let opener_origin=ui_address.clone();
        let ready_ticket=uuid::Uuid::new_v4().simple().to_string();
        let (ready_tx,ready_rx)=tokio::sync::oneshot::channel();
        shell.flush.lock().unwrap().insert(ready_ticket.clone(),PendingReply{window:label.clone(),purpose:"ready",sender:ready_tx});
        let ready_origin=ui_address.clone();
        let ready_once=std::sync::atomic::AtomicBool::new(false);
        let expected_id=identity["server_id"].clone();
        let ready_script=format!("(async()=>{{let ok=false;try{{const r=await fetch('/api/server');const s=await r.json();ok=r.ok&&[1,2].includes(s.api_version)&&s.ready&&s.server_id==={}}}catch{{}}location.href='https://noctua.invalid/ready/{}/'+ok}})()",expected_id,ready_ticket);
        let mut provisional=ProvisionalWindow{app:app.clone(),label:label.clone(),ticket:ready_ticket.clone(),committed:false};
        let w=WebviewWindowBuilder::new(&app,&label,WebviewUrl::App("loading.html".into()))
            .initialization_script(appearance::CONTENT_SCRIPT)
            .initialization_script(format!("window.noctuaServerAddress={};",serde_json::to_string(&address)?))
            .initialization_script(format!("window.noctuaManagerUrl={};",serde_json::to_string(&manager_url)?))
            .initialization_script(format!("window.noctuaAppIcon = {}; window.noctuaAppVersion = {};",serde_json::to_string(&*app.state::<icons::Icons>().0.lock().unwrap()).unwrap(),serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap()))
            .visible(false)
            .on_page_load(move |window,payload| {
                if payload.event()==tauri::webview::PageLoadEvent::Finished && payload.url().origin().ascii_serialization()==ready_origin && !ready_once.swap(true,Ordering::SeqCst) {let _=window.eval(&ready_script);}
            })
            .on_new_window(move|url,_|{
                if url.origin().ascii_serialization()==opener_origin {
                    let mut path=url.path().to_string();
                    if let Some(query)=url.query(){path.push('?');path.push_str(query);}
                    if let Some(fragment)=url.fragment(){path.push('#');path.push_str(fragment);}
                    open_window(&opener_app,Some(&path));
                }else if matches!(url.scheme(),"https"|"http"|"mailto") {let _=opener_app.opener().open_url(url.as_str(),None::<&str>);}
                tauri::webview::NewWindowResponse::Deny
            })
            .title("Noctua").inner_size(1440.,900.).min_inner_size(820.,520.).disable_drag_drop_handler()
            .on_navigation(move|url|{
                if url.host_str()==Some("noctua.invalid") {
                    if url.path()=="/appearance" {appearance::remember(&callback_app,url);return false;}
                    if url.path()=="/app-icon" {
                        if let Some((icon,request))=appearance::icon_request(url) {
                                let app=callback_app.clone();
                                tauri::async_runtime::spawn(async move {
                                    let result=set_local_app_icon(&app,icon).await;
                                    let detail=json!({"request":request,"icon":icon,"error":result.err()});
                                    let script=format!("if(!{detail}.error)window.noctuaAppIcon={detail}.icon;window.dispatchEvent(new CustomEvent('noctua-app-icon',{{detail:{detail}}}));");
                                    for window in app.webview_windows().into_values().filter(|w|w.label().starts_with("content")) {let _=window.eval(&script);}
                                });
                        }
                        return false;
                    }
                    if url.path()=="/desktop-update" {
                        let fields: std::collections::HashMap<_,_> = url.query_pairs().into_owned().collect();
                        let action = fields.get("action").cloned().unwrap_or_default();
                        let request = fields.get("request").cloned().unwrap_or_default();
                        let version = fields.get("version").cloned().filter(|v| !v.is_empty());
                        if uuid::Uuid::parse_str(&request).is_ok() && matches!(action.as_str(), "check" | "install" | "restart") {
                            let app=callback_app.clone();
                            let label=callback_label.clone();
                            tauri::async_runtime::spawn(async move {
                                let result=update_from_content(&app,&action,version).await;
                                if let Some(window)=app.get_webview_window(&label) {
                                    let detail=match result { Ok(result)=>json!({"request":request,"result":result}), Err(error)=>json!({"request":request,"error":error}) };
                                    let _=window.eval(&format!("window.dispatchEvent(new CustomEvent('noctua-update-result',{{detail:{detail}}}));"));
                                }
                            });
                        }
                        return false;
                    }
                    let parts=url.path().split('/').collect::<Vec<_>>();
                    if parts.len()==4 {
                        let shell=callback_app.state::<Shell>();
                        let mut replies=shell.flush.lock().unwrap();
                        let matches=replies.get(parts[2]).is_some_and(|reply|reply.window==callback_label&&reply.purpose==parts[1]);
                        if matches {if let Some(reply)=replies.remove(parts[2]){let _=reply.sender.send(parts[3]=="true");}}
                    }return false
                }
                let loading=(url.scheme()=="tauri" && url.host_str()==Some("localhost") || matches!(url.scheme(),"http"|"https") && url.host_str()==Some("tauri.localhost")) && url.path()=="/loading.html";
                loading || url.origin().ascii_serialization()==navigation_origin || url.origin().ascii_serialization()==manager_origin
            }).build()?;

        w.set_cookie(cookie)?;
        // Check transport on a read-only document before loading any editor/draft UI.
        w.navigate(tauri::Url::parse(&format!("{ui_address}/api/server"))?)?;
        let ready=tokio::time::timeout(std::time::Duration::from_secs(30),ready_rx).await;
        shell.flush.lock().unwrap().remove(&ready_ticket);
        if !matches!(ready,Ok(Ok(true))) {let _=w.close();anyhow::bail!("The desktop browser could not authenticate or load this server. Saved connection kept; retry or change settings")}
        if test_only {let _=w.close();return Ok(identity)}
        let _switch_guard=SwitchGuard(app.clone());
        if !keep_windows {if let Err(error)=flush_clients(&app,w.label()).await {let _=w.close();return Err(anyhow::Error::msg(error))}}
        frontend::migrate_storage(&app,&w,&address,identity["server_id"].as_str().unwrap()).await?;
        if mode=="remote" {if let Err(error)=noctua::client::store_secret(&address,&secret){let _=w.close();return Err(error)}}
        w.navigate(destination)?;
        w.show()?;w.set_focus()?;
        noctua::client::save(&noctua::client::Connection{mode,address:address.clone(),server_id:identity["server_id"].as_str().unwrap().into()})?;
        if !keep_windows {for old_window in app.webview_windows().into_values().filter(|x|x.label().starts_with("content")&&x.label()!=w.label()){let _=old_window.close();}}
        *app.state::<Shell>().connected.lock().unwrap()=Some((address,identity["server_id"].as_str().unwrap().into(),secret));
        provisional.committed=true;
        let _=window.window().hide();
        Ok(identity)
    }.await;
    result.map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn local_server(
    app: AppHandle,
    window: Webview,
    action: String,
) -> Result<Value, String> {
    local_only(&window)?;
    let shell = app.state::<Shell>();
    let _gate = shell
        .connection_gate
        .try_lock()
        .map_err(|_| "Another connection or server operation is in progress".to_string())?;
    let result:anyhow::Result<Value>=async{
        match action.as_str(){
            "start"=>{return noctua::server_update::ensure_current(&server_executable(&app).await?,PORT).await},
            "stop"=>{noctua::server::stop(&noctua::paths::existing_data_dir()?).await?;},
            "restart"=>{return noctua::server::restart(&server_executable(&app).await?,PORT).await},
            "update"=>{
                let data=noctua::paths::existing_data_dir()?;
                let old=serde_json::to_value(noctua::server::record(&data)?)?;
                let reconnect=app.state::<Shell>().connected.lock().unwrap().as_ref().is_some_and(|(address,id,_)|Some(address.as_str())==old["url"].as_str()&&Some(id.as_str())==old["server_id"].as_str());
                let ready=noctua::server_update::retry_current(&server_executable(&app).await?,PORT).await?;
                return Ok(json!({"server":ready,"reconnect_local":reconnect}));
            },
            "enable"=>{let _control=noctua::server::control_lock_for_cli(&noctua::paths::existing_data_dir()?).await?;noctua::service::enable(&server_executable(&app).await?)?;},
            "disable"=>{let _control=noctua::server::control_lock_for_cli(&noctua::paths::existing_data_dir()?).await?;noctua::service::disable()?;},
            "token" | "copy-token"=>{
                let data=noctua::paths::existing_data_dir()?;
                let token=noctua::server::token(&data).map_err(|_| anyhow::anyhow!("Local server token unavailable. Start this computer’s server first."))?;
                if action=="copy-token" {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    app.clipboard().write_text(token)?;
                    return Ok(json!({"copied":true}));
                }
                return Ok(json!({"token":token}));
            },
            "logs"=>{let path=noctua::paths::existing_data_dir()?.join("server.log");let text=std::fs::read_to_string(path)?;return Ok(json!({"log":text.chars().rev().take(20000).collect::<String>().chars().rev().collect::<String>()}))},
            _=>anyhow::bail!("Unknown local server action"),
        }Ok(noctua::service::status())
    }.await;
    result.map_err(|e| format!("{e:#}"))
}
// Server pages can request an update, but installation and restart require a
// native confirmation so a remote server cannot silently control this app.
async fn update_from_content(app: &AppHandle, action: &str, version: Option<String>) -> Result<Value, String> {
    let replacing = matches!(action, "install" | "restart");
    if action == "install" && version.as_deref().and_then(|v| semver::Version::parse(v).ok()).is_none() {
        return Err("Check for an update before installing".into());
    }
    if replacing {
        let text = if action == "install" { format!("Install the offered Noctua updates for version {}? This may update the desktop and this computer’s local server. Save your work; the app may close or restart.", version.as_deref().unwrap_or_default()) } else { "Restart Noctua now?".into() };
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().message(text).title("Noctua update")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
            .show(move |confirmed| { let _ = tx.send(confirmed); });
        if !rx.await.unwrap_or(false) { return Err("Update cancelled".into()); }
    }
    let shell=app.state::<Shell>();
    let _gate=if replacing { Some(shell.connection_gate.try_lock().map_err(|_| "Another connection or server operation is in progress".to_string())?) } else { None };
    let _guard=if replacing { Some(SwitchGuard(app.clone())) } else { None };
    if replacing { flush_clients(app, "").await?; }
    let action=serde_json::from_value(json!(action)).map_err(|_| "Unknown update action".to_string())?;
    updater::run(app, action, version).await.map_err(|e| e.to_string())
}

async fn set_local_app_icon(app: &AppHandle, icon: noctua::AppIcon) -> Result<(), String> {
    let previous = *app.state::<icons::Icons>().0.lock().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel();
    run(app, DesktopCmd::SetAppIcon(icon, Some(tx)));
    rx.await.map_err(|_| "App icon operation did not complete".to_string())??;
    let saved = (|| -> anyhow::Result<()> {
        noctua::paths::write_private(
            &noctua::client::config_dir()?.join("app-icon.json"),
            &serde_json::to_string(&icon)?,
        )
    })();
    if let Err(error) = saved {
        let (tx, rx) = tokio::sync::oneshot::channel();
        run(app, DesktopCmd::SetAppIcon(previous, Some(tx)));
        let _ = rx.await;
        return Err(error.to_string());
    }
    Ok(())
}
#[tauri::command]
async fn desktop_action(
    app: AppHandle,
    window: Webview,
    action: String,
    version: Option<String>,
) -> Result<Value, String> {
    local_only(&window)?;
    if action == "light" || action == "dark" {
        let icon = if action == "dark" { noctua::AppIcon::Dark } else { noctua::AppIcon::Light };
        set_local_app_icon(&app, icon).await?;
        return Ok(json!({"status":"applied"}));
    }
    let action =
        serde_json::from_value(json!(action)).map_err(|_| "Unknown desktop action".to_string())?;
    let replacing = matches!(
        action,
        noctua::UpdateAction::Install | noctua::UpdateAction::Restart
    );
    let shell = app.state::<Shell>();
    let _gate = if replacing {
        Some(
            shell
                .connection_gate
                .try_lock()
                .map_err(|_| "Another connection or server operation is in progress".to_string())?,
        )
    } else {
        None
    };
    let _guard = if replacing {
        Some(SwitchGuard(app.clone()))
    } else {
        None
    };
    if replacing {
        flush_clients(&app, "").await?;
    }
    updater::run(&app, action, version)
        .await
        .map_err(|e| e.to_string())
}

fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, accel: &str| {
        MenuItemBuilder::with_id(id, text)
            .accelerator(accel)
            .build(app)
    };
    let new_tab = item("new_tab", "New Tab", "CmdOrCtrl+T")?;
    let new_window = item("new_window", "New Window", "CmdOrCtrl+N")?;
    let close_tab = item("close_tab", "Close Tab", "CmdOrCtrl+W")?;
    let close_window = item("close_window", "Close Window", "CmdOrCtrl+Shift+W")?;
    let settings = item("settings", "Settings…", "CmdOrCtrl+,")?;
    let reload = item("reload", "Reload Tab", "CmdOrCtrl+R")?;
    let next_tab = item("next_tab", "Next Tab", "Ctrl+Tab")?;
    let prev_tab = item("prev_tab", "Previous Tab", "Ctrl+Shift+Tab")?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&new_window)
        .separator()
        .item(&close_tab)
        .item(&close_window);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&settings).separator().quit();
    let file = file.build()?;
    // Without an Edit menu, copy/paste/undo shortcuts don't reach the page on macOS.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&reload)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    let menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::new(app, "Noctua")
            .about(None)
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?,
    );
    menu.item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .build()
}

#[cfg(test)]
mod connection_tests {
    #[test]
    fn changed_server_cannot_replace_the_reviewed_connection() {
        let server = serde_json::json!({"server_id":"tested-server"});
        assert!(super::verify_tested_server(&server, Some("tested-server")).is_ok());
        assert!(super::verify_tested_server(&server, Some("another-server")).is_err());
        assert!(super::verify_tested_server(&server, None).is_ok());
    }
    use super::*;
    #[test]
    fn new_windows_preserve_paths_and_isolate_query_values() {
        let open = "/#pdf=paper-1&page=3";
        let manager =
            tauri::Url::parse(&format!("http://client/{}", manager_path(Some(open)))).unwrap();
        assert!(manager
            .query_pairs()
            .any(|(key, value)| key == "open" && value == open));
        let shell = content_shell_url("https://server.example", "w3", true, Some(open)).unwrap();
        assert_eq!(
            shell.origin().ascii_serialization(),
            "https://server.example"
        );
        assert!(shell
            .query_pairs()
            .any(|(key, value)| key == "open" && value == open));
        assert!(shell
            .query_pairs()
            .any(|(key, value)| key == "fresh" && value == "1"));
    }
    #[test]
    fn remote_paths_cannot_escape_the_server_or_nest_shells() {
        for path in [
            "https://other.example",
            "//other.example/path",
            "/\\other.example",
            "/shell?open=/",
            "/bad\0path",
        ] {
            assert!(
                content_shell_url("https://server.example", "w1", false, Some(path)).is_err(),
                "{path:?}"
            );
        }
    }
}
