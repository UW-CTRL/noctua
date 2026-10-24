fn main() {
    println!("cargo:rerun-if-env-changed=NOCTUA_UPDATER_PUBLIC_KEY");
    tauri_build::build()
}
