fn main() {
    // Keep the serverless manager and server pages on the same source styles.
    for name in [
        "ui.css",
        "connection.css",
        "appearance.js",
        "fonts.js",
        "select.js",
        "update-dialogs.js",
    ] {
        let source = format!("../web/{name}");
        println!("cargo:rerun-if-changed={source}");
        std::fs::copy(&source, format!("dist/{name}")).expect("Bundle shared offline UI asset");
    }
    println!("cargo:rerun-if-env-changed=NOCTUA_UPDATER_PUBLIC_KEY");
    tauri_build::build()
}
