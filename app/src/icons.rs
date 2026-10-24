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
    *app.state::<Icons>().0.lock().unwrap() = icon;
    Ok(())
}
