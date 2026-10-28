//! Runtime app icons. macOS updates the Dock without modifying the signed bundle.
use std::sync::Mutex;
use noctua::AppIcon;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Icons(pub Mutex<AppIcon>);

fn bytes(icon: AppIcon) -> &'static [u8] {
    match icon {
        AppIcon::Dark => include_bytes!("../icons/icon-dark.png"),
        AppIcon::Light => include_bytes!("../icons/icon-light.png"),
    }
}

/// Called on the UI thread, including when a new window is opened.
pub fn apply(app: &AppHandle, icon: AppIcon) -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use objc2::{AnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;
        let main = MainThreadMarker::new().ok_or_else(|| anyhow::anyhow!("App icons must be updated on the main thread"))?;
        let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes(icon)))
            .ok_or_else(|| anyhow::anyhow!("Could not load the app icon"))?;
        // SAFETY: AppKit is accessed on its main thread and retains the supplied image.
        unsafe { NSApplication::sharedApplication(main).setApplicationIconImage(Some(&image)); }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let image = tauri::image::Image::from_bytes(bytes(icon))?;
        for window in app.webview_windows().into_values() { window.set_icon(image.clone())?; }
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = appimage::integrate(icon, bytes(icon)) {
        eprintln!("Could not register the AppImage launcher: {error}");
    }
    *app.state::<Icons>().0.lock().unwrap() = icon;
    Ok(())
}

/// Docks match windows to launchers by `StartupWMClass`, and GNOME on Wayland
/// ignores window icons, so an unregistered AppImage shows a generic icon.
/// Register a per-user launcher that points at the running AppImage.
#[cfg(target_os = "linux")]
mod appimage {
    use std::path::{Path, PathBuf};
    use noctua::AppIcon;

    const NAME: &str = "noctua-appimage";

    pub fn integrate(icon: AppIcon, png: &[u8]) -> anyhow::Result<()> {
        let Some(image) = std::env::var_os("APPIMAGE").map(PathBuf::from) else { return Ok(()) };
        let data = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
            Some(dir) if dir.is_absolute() => dir,
            _ => PathBuf::from(std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is not set"))?).join(".local/share"),
        };
        // GTK derives the window class and Wayland app ID from the executable name.
        let exe = std::env::current_exe()?;
        let class = exe.file_stem().and_then(|name| name.to_str()).ok_or_else(|| anyhow::anyhow!("Unnamed executable"))?;
        let icons = data.join("icons");
        let variant = match icon { AppIcon::Light => "light", AppIcon::Dark => "dark" };
        let icon_path = icons.join(format!("{NAME}-{variant}.png"));
        write_if_changed(&icon_path, png)?;
        let entry = desktop_entry(&image, class, &icon_path);
        write_if_changed(&data.join("applications").join(format!("{NAME}.desktop")), entry.as_bytes())
    }

    fn desktop_entry(image: &Path, class: &str, icon: &Path) -> String {
        format!(
            "[Desktop Entry]\nType=Application\nName=Noctua\nComment=Research-paper explorer with citation graphs and LaTeX notes\nExec={}\nIcon={}\nStartupWMClass={class}\nCategories=Education;\nTerminal=false\n",
            quote(&image.to_string_lossy()),
            icon.to_string_lossy(),
        )
    }

    /// Quotes an `Exec` argument per the Desktop Entry specification.
    fn quote(arg: &str) -> String {
        let mut out = String::from("\"");
        for c in arg.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') { out.push('\\'); }
            out.push(c);
        }
        out.push('"');
        // A literal `%` must be doubled, and desktop files unescape `\\` once more.
        out.replace('%', "%%").replace('\\', "\\\\")
    }

    fn write_if_changed(path: &Path, body: &[u8]) -> anyhow::Result<()> {
        if std::fs::read(path).is_ok_and(|old| old == body) { return Ok(()); }
        std::fs::create_dir_all(path.parent().unwrap())?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn launcher_quotes_the_appimage_path_and_names_the_window_class() {
            let entry = desktop_entry(Path::new("/home/a b/100% \"N$\".AppImage"), "noctua-app", Path::new("/i/noctua-appimage-light.png"));
            assert!(entry.contains("Exec=\"/home/a b/100%% \\\\\"N\\\\$\\\\\".AppImage\"\n"));
            assert!(entry.contains("StartupWMClass=noctua-app\n"));
            assert!(entry.contains("Icon=/i/noctua-appimage-light.png\n"));
        }
    }
}
