//! The Noctua desktop app: runs Noctua's local server and shows it in native
//! windows, each with its own tabs (web/shell.html), plus a native menu and an
//! app icon. Requests from the pages (new window, open a link in the browser,
//! pick a folder) arrive as `DesktopCmd`s.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicUsize, Ordering};

use noctua::{DesktopCmd, ServeOptions};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

mod updater;

/// A fixed port keeps the pages' origin (and so their saved tabs and layout)
/// the same between launches; another free port is used if it's taken.
const PORT: u16 = 47878;

struct Shell {
    url: String,
    windows: AtomicUsize,
}

fn main() {
    noctua::paths::adopt_shell_path(); // before any threads: finds `claude` when launched from Finder
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_window(app, None)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new()
            .pubkey(option_env!("NOCTUA_UPDATER_PUBLIC_KEY").unwrap_or("").trim())
            .build())
        .manage(updater::Updates::default())
        .setup(|app| {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let (url, server) = tauri::async_runtime::block_on(async {
                match noctua::start(ServeOptions { port: PORT, desktop: Some(tx.clone()) }).await {
                    Ok(s) => Ok(s),
                    Err(_) => noctua::start(ServeOptions { port: 0, desktop: Some(tx) }).await,
                }
            })?;
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server.await {
                    eprintln!("Noctua's server stopped: {e}");
                }
            });
            app.manage(Shell { url, windows: AtomicUsize::new(0) });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(cmd) = rx.recv().await {
                    run(&handle, cmd);
                }
            });
            app.set_menu(menu(app.handle())?)?;
            open_window(app.handle(), None);
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new_window" => open_window(app, None),
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
                    Some(w) => {
                        let _ = w.eval(&format!("window.noctuaShell && noctuaShell.cmd('{cmd}')"));
                    }
                    None if cmd == "newTab" || cmd == "settings" => open_window(app, None),
                    None => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Noctua");
}

fn run(app: &AppHandle, cmd: DesktopCmd) {
    match cmd {
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
        DesktopCmd::Update(action, reply) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = updater::run(&app, action).await.map_err(|e| e.to_string());
                let _ = reply.send(result);
            });
        }
    }
}

/// Opens a window (labels w1, w2, …); `open` is an app path for its first tab.
fn open_window(app: &AppHandle, open: Option<&str>) {
    let shell = app.state::<Shell>();
    let label = format!("w{}", shell.windows.fetch_add(1, Ordering::Relaxed) + 1);
    let mut url = format!("{}/shell?w={label}", shell.url);
    if let Some(o) = open {
        url.push_str("&open=");
        url.push_str(&encode(o));
    }
    let Ok(url) = url.parse() else { return };
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("Noctua")
        .inner_size(1440.0, 900.0)
        .min_inner_size(820.0, 520.0)
        .disable_drag_drop_handler() // let the page receive dropped images
        .build();
    if let Err(e) = built {
        eprintln!("couldn't open a window: {e}");
    }
}

fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

/// Percent-encodes a query value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, accel: &str| MenuItemBuilder::with_id(id, text).accelerator(accel).build(app);
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
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&reload)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

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
    menu.item(&file).item(&edit).item(&view).item(&window).build()
}
