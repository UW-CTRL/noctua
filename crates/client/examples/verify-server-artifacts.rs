//! Verify existing signed server releases without compiling the research backend.
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 3,
        "Expected artifact directory and pinned server version"
    );
    let root = std::path::Path::new(&args[1]);
    let key =
        std::env::var("NOCTUA_UPDATER_PUBLIC_KEY").context("Missing server verification key")?;
    for target in [
        "aarch64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "x86_64-unknown-linux-gnu",
    ] {
        let metadata = std::fs::read(root.join(format!("server-update-{target}.json")))?;
        let signature =
            std::fs::read_to_string(root.join(format!("server-update-{target}.json.sig")))?;
        let manifest = noctua_client::releases::verify_target(&metadata, &signature, &key, target)?;
        anyhow::ensure!(
            manifest.version == args[2],
            "Published server does not match pinned version"
        );
        let bytes = std::fs::read(root.join(&manifest.binary))?;
        anyhow::ensure!(
            bytes.len() == manifest.size
                && format!("{:x}", Sha256::digest(&bytes)) == manifest.sha256,
            "Published server checksum mismatch"
        );
    }
    println!("Verified all three pinned server binaries and metadata signatures");
    Ok(())
}
