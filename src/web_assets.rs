//! Optional browser UI files. Desktop windows serve their own bundled UI.
//! None of these files are compiled into the independent server.
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use std::path::{Path, PathBuf};
fn root() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NOCTUA_UI_DIR") {
        return Some(PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe() {
        for name in ["browser-ui", "ui"] {
            let path = executable.parent()?.join(name);
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("web");
    development.is_dir().then_some(development)
}
pub(crate) fn read(name: &str) -> Option<Vec<u8>> {
    read_from(&root()?, name)
}
fn read_from(root: &Path, name: &str) -> Option<Vec<u8>> {
    if name.starts_with('/')
        || name.contains('\\')
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    let root = root.canonicalize().ok()?;
    if Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("web")
        .canonicalize()
        .ok()
        .as_ref()
        == Some(&root)
    {
        if let Some(icon) = name.strip_prefix("app-icons/").and_then(|name| match name {
            "dark.svg" => Some("icon-dark.svg"),
            "light.svg" => Some("icon-light.svg"),
            _ => None,
        }) {
            return std::fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("app/icons")
                    .join(icon),
            )
            .ok();
        }
    }
    let path = root.join(name).canonicalize().ok()?;
    if !path.starts_with(&root) || !path.is_file() {
        return None;
    }
    std::fs::read(path).ok()
}
pub(crate) fn response(name: &str) -> Response {
    match read(name) {
        Some(bytes) => ([(header::CONTENT_TYPE, noctua_client::frontend::mime(name)),
            (header::CACHE_CONTROL, "no-cache"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "Browser UI files are unavailable. Install the Desktop release's UI files beside this server, or set NOCTUA_UI_DIR. Server APIs remain available.").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_assets_change_without_rebuilding_and_cannot_escape_the_ui_root() {
        let dir = tempfile::tempdir().unwrap();
        let ui = dir.path().join("ui");
        std::fs::create_dir(&ui).unwrap();
        std::fs::write(ui.join("index.html"), "old").unwrap();
        assert_eq!(read_from(&ui, "index.html").unwrap(), b"old");
        std::fs::write(ui.join("index.html"), "new").unwrap();
        assert_eq!(read_from(&ui, "index.html").unwrap(), b"new");
        std::fs::write(dir.path().join("secret"), "private").unwrap();
        for path in [
            "../secret",
            "/secret",
            "folder/../../secret",
            "folder\\secret",
        ] {
            assert!(read_from(&ui, path).is_none());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret"), ui.join("link")).unwrap();
            assert!(read_from(&ui, "link").is_none());
        }
    }
}
