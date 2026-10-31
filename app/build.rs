fn ui_files(root: &std::path::Path, dir: &std::path::Path, entries: &mut Vec<String>) {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .expect("Read desktop UI")
        .map(|e| e.unwrap().path())
        .collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            ui_files(root, &path, entries);
        } else if path.is_file() {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let output = std::path::Path::new("ui").join(&name);
            std::fs::create_dir_all(output.parent().unwrap()).unwrap();
            std::fs::copy(&path, output).unwrap();
            entries.push(format!(
                "({name:?}, include_bytes!({:?})),",
                std::fs::canonicalize(path).unwrap()
            ));
        }
    }
}
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
    println!("cargo:rerun-if-changed=../web");
    let _ = std::fs::remove_dir_all("ui");
    std::fs::create_dir_all("ui/app-icons").unwrap();
    let mut entries = Vec::new();
    ui_files(
        std::path::Path::new("../web"),
        std::path::Path::new("../web"),
        &mut entries,
    );
    for name in ["dark", "light"] {
        std::fs::copy(
            format!("icons/icon-{name}.svg"),
            format!("ui/app-icons/{name}.svg"),
        )
        .unwrap();
        entries.push(format!(
            "({:?}, include_bytes!({:?})),",
            format!("app-icons/{name}.svg"),
            std::fs::canonicalize(format!("icons/icon-{name}.svg")).unwrap()
        ));
    }
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("ui_assets.rs"),
        format!(
            "static UI_ASSETS: &[(&str, &[u8])] = &[{}];",
            entries.join("\n")
        ),
    )
    .unwrap();
    println!("cargo:rerun-if-env-changed=NOCTUA_UPDATER_PUBLIC_KEY");
    tauri_build::build()
}
