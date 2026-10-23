// Embed the PDF renderer, fonts and codecs so desktop/browser builds are offline-capable.
use std::{env, fs, path::Path};
fn walk(root: &Path, dir: &Path, out: &mut String) {
    let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() { walk(root, &p, out); }
        else {
            let name = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push_str(&format!("({name:?}, include_bytes!({:?})),\n", fs::canonicalize(&p).unwrap()));
        }
    }
}
fn main() {
    println!("cargo:rerun-if-changed=web/vendor/pdfjs");
    let root = Path::new("web/vendor/pdfjs");
    let mut out = String::from("static PDF_ASSETS: &[(&str, &[u8])] = &[\n");
    walk(root, root, &mut out);
    out.push_str("];\n");
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("pdf_assets.rs"), out).unwrap();
}
