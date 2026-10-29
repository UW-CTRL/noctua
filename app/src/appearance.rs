//! Cosmetic preferences only: remote pages cannot use this channel for native operations.
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn valid(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields.len() == 4
        && matches!(value["theme"].as_str(), Some("system" | "light" | "dark"))
        && matches!(
            value["font_id"].as_str(),
            Some("system" | "arial" | "helvetica" | "georgia" | "times" | "mono" | "custom")
        )
        && value["font_name"]
            .as_str()
            .is_some_and(|name| name.chars().count() <= 100 && !name.chars().any(char::is_control))
        && value["font_size"]
            .as_u64()
            .is_some_and(|size| (11..=18).contains(&size))
}

fn apply_script(value: &Value) -> String {
    format!(
        r#"try {{
        const appearance = {value};
        localStorage.setItem('noctua.theme', appearance.theme);
        localStorage.setItem('noctua.font.ui', JSON.stringify({{id:appearance.font_id,name:appearance.font_name}}));
        localStorage.setItem('noctua.font.uiSize', String(appearance.font_size));
        if (document.documentElement) document.documentElement.dataset.theme = appearance.theme;
        window.dispatchEvent(new StorageEvent('storage', {{key:null}}));
    }} catch {{ /* system appearance when storage is unavailable */ }}"#
    )
}

pub fn local_script() -> String {
    noctua::client::config_dir()
        .ok()
        .and_then(|dir| std::fs::read(dir.join("appearance.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(valid)
        .map(|value| apply_script(&value))
        .unwrap_or_default()
}

// Native injection only; ordinary browsers never navigate to this callback.
// The top shell receives storage events when Appearance changes in a tab.
pub const CONTENT_SCRIPT: &str = r#"
window.noctuaDesktopClient = true;
if (window.top === window) {
    window.noctuaSetAppIcon = icon => new Promise((resolve, reject) => {
        if (!['light', 'dark'].includes(icon)) { reject(new Error('Invalid app icon')); return; }
        const request = crypto.randomUUID();
        const done = event => {
            if (event.detail.request !== request) return;
            clearTimeout(timer); window.removeEventListener('noctua-app-icon', done);
            if (event.detail.error) reject(new Error(event.detail.error));
            else resolve({app_icon:event.detail.icon});
        };
        const timer = setTimeout(() => {
            window.removeEventListener('noctua-app-icon', done);
            reject(new Error('App icon update did not complete'));
        }, 10000);
        window.addEventListener('noctua-app-icon', done);
        location.href = 'https://noctua.invalid/app-icon?icon=' + icon + '&request=' + request;
    });
    window.noctuaDesktopUpdate = (action, version) => new Promise((resolve, reject) => {
        if (!['check', 'install', 'restart'].includes(action)) { reject(new Error('Invalid update action')); return; }
        const request = crypto.randomUUID();
        const done = event => {
            if (event.detail.request !== request) return;
            clearTimeout(timer); window.removeEventListener('noctua-update-result', done);
            if (event.detail.error) reject(new Error(event.detail.error)); else resolve(event.detail.result);
        };
        const timer = setTimeout(() => { window.removeEventListener('noctua-update-result', done); reject(new Error('Update request timed out')); }, 20 * 60 * 1000);
        window.addEventListener('noctua-update-result', done);
        location.href = 'https://noctua.invalid/desktop-update?' + new URLSearchParams({action, request, version:version || ''});
    });
    let lastAppearance;
    function publishAppearance() {
        if (location.pathname !== '/shell') return;
        try {
            const font = JSON.parse(localStorage.getItem('noctua.font.ui') || 'null') || {id:'system',name:''};
            const value = JSON.stringify({theme:localStorage.getItem('noctua.theme') || 'system',font_id:font.id,font_name:font.name || '',font_size:Number(localStorage.getItem('noctua.font.uiSize') || 14)});
            if (value === lastAppearance) return;
            lastAppearance = value;
            location.href = 'https://noctua.invalid/appearance?value=' + encodeURIComponent(value);
        } catch { /* retain the last device-local appearance */ }
    }
    window.addEventListener('storage', publishAppearance);
    window.addEventListener('DOMContentLoaded', publishAppearance);
}
"#;

// Accept only artwork choices; this channel cannot invoke server or updater commands.
pub fn icon_request(url: &tauri::Url) -> Option<(noctua::AppIcon, String)> {
    if url.scheme() != "https" || url.host_str() != Some("noctua.invalid") || url.path() != "/app-icon" { return None; }
    let fields: Vec<_> = url.query_pairs().collect();
    if fields.len() != 2 { return None; }
    let icon = fields.iter().find(|(key,_)|key=="icon")?.1.as_ref();
    let icon = serde_json::from_value(serde_json::json!(icon)).ok()?;
    let request = fields.iter().find(|(key,_)|key=="request")?.1.to_string();
    uuid::Uuid::parse_str(&request).ok()?;
    Some((icon,request))
}

pub fn remember(app: &AppHandle, url: &tauri::Url) {
    let Some((_, text)) = url.query_pairs().find(|(key, _)| key == "value") else {
        return;
    };
    if text.len() > 2048 {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if !valid(&value) {
        return;
    }
    let Ok(dir) = noctua::client::config_dir() else {
        return;
    };
    let path = dir.join("appearance.json");
    let body = value.to_string();
    if std::fs::read_to_string(&path).ok().as_deref() != Some(&body) {
        if noctua::paths::write_private(&path, &body).is_err() {
            return;
        }
    }
    let script = apply_script(&value);
    for window in app
        .webview_windows()
        .into_values()
        .filter(|w| w.label().starts_with('w'))
    {
        let _ = window.eval(&script);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn icon_channel_accepts_only_artwork_and_a_request_id() {
        let request = "12345678-1234-4234-8234-123456789012";
        let url = format!("https://noctua.invalid/app-icon?icon=dark&request={request}");
        assert_eq!(icon_request(&tauri::Url::parse(&url).unwrap()),Some((noctua::AppIcon::Dark,request.into())));
        for bad in [url.replace("icon=dark","icon=stop"),url.replace(request,"bad"),url.replace("https:","http:"),format!("{url}&command=stop"),url.replace("noctua.invalid","other.invalid")] {
            assert!(icon_request(&tauri::Url::parse(&bad).unwrap()).is_none());
        }
    }
    #[test]
    fn accept_only_bounded_cosmetic_preferences() {
        let good = json!({"theme":"dark","font_id":"custom","font_name":"My Font","font_size":16});
        assert!(valid(&good));
        for (key, value) in [
            ("theme", json!("unknown")),
            ("font_id", json!("file:///secret")),
            ("font_name", json!("bad\nfont")),
            ("font_name", json!("x".repeat(101))),
            ("font_size", json!(19)),
            ("font_size", json!(11.5)),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            assert!(!valid(&bad));
        }
        let mut bad = good.clone();
        bad["command"] = json!("stop");
        assert!(!valid(&bad));
        assert!(apply_script(&good).contains("noctua.font.uiSize"));
    }
}
