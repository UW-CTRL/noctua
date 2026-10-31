//! Client protocol, credentials and local server lifecycle, independent of the research backend.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

pub mod client;
pub mod frontend;
pub mod paths;
pub mod server;
pub mod server_recovery;
pub mod server_resources;
pub mod server_update;
pub mod service;
pub mod storage;
pub mod releases;

#[derive(Debug, Serialize, Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppIcon {
    Dark,
    #[default]
    Light,
}

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

