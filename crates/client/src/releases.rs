//! Signed standalone-server discovery and staging. Only the local client invokes this.
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, time::Duration};

const REPOSITORY: &str = "UW-CTRL/noctua";
const MAX_BINARY: usize = 512 * 1024 * 1024;

pub fn target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) { "aarch64-apple-darwin" }
    else if cfg!(all(windows, target_arch = "x86_64")) { "x86_64-pc-windows-msvc" }
    else if cfg!(all(target_os = "linux", target_arch = "x86_64")) { "x86_64-unknown-linux-gnu" }
    else { "unsupported" }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub version: String,
    pub target: String,
    pub api_version: u32,
    pub data_version: u32,
    pub binary: String,
    pub sha256: String,
    pub size: usize,
    pub paper_compilers: Value,
}

#[derive(Clone)]
pub struct Offer {
    pub manifest: Manifest,
    metadata: Vec<u8>,
    signature: String,
}

fn decode(value: &str) -> Result<String> {
    Ok(String::from_utf8(STANDARD.decode(value.trim())?)?)
}

fn authenticate(metadata: &[u8], signature: &str, public_key: &str) -> Result<Manifest> {
    let key = minisign_verify::PublicKey::decode(&decode(public_key)?)?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?)?;
    key.verify(metadata, &signature, false).context("Server update signature verification failed")?;
    Ok(serde_json::from_slice(metadata)?)
}

pub fn verify(metadata: &[u8], signature: &str, public_key: &str) -> Result<Manifest> {
    let manifest = authenticate(metadata, signature, public_key)?;
    let version = semver::Version::parse(&manifest.version)?;
    anyhow::ensure!(version.pre.is_empty() && version.build.is_empty(), "Only stable server updates are supported");
    anyhow::ensure!(manifest.target == target() && manifest.api_version == crate::server::API_VERSION
        && manifest.data_version == crate::server::DATA_VERSION, "Server release is incompatible with this client");
    anyhow::ensure!(manifest.binary == binary_name(&manifest.version, target())
        && manifest.size > 0 && manifest.size <= MAX_BINARY
        && manifest.sha256.len() == 64 && manifest.sha256.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid signed server metadata");
    Ok(manifest)
}

fn binary_name(version: &str, target: &str) -> String {
    format!("noctua-server-v{version}-{target}{}", if target.contains("windows") { ".exe" } else { "" })
}

fn asset_url(version: &str, name: &str) -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/server-v{version}/{name}")
}

async fn bytes(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    anyhow::ensure!(response.content_length().is_none_or(|n| n <= limit as u64), "Server update download is too large");
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(data.len() + chunk.len() <= limit, "Server update download is too large");
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().user_agent("Noctua component updater")
        .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(15 * 60)).build()?)
}

pub fn newest(releases: &[Value], current: &str) -> Result<Option<String>> {
    let current = semver::Version::parse(current)?;
    Ok(releases.iter().filter(|r| r["draft"] == false && r["prerelease"] == false)
        .filter_map(|r| r["tag_name"].as_str()?.strip_prefix("server-v"))
        .filter_map(|v| semver::Version::parse(v).ok())
        .filter(|v| v.pre.is_empty() && v.build.is_empty() && *v > current)
        .max().map(|v| v.to_string()))
}

pub async fn check(current: &str, public_key: &str, compilers: &Value) -> Result<Option<Offer>> {
    anyhow::ensure!(!public_key.trim().is_empty(), "This build has no server update verification key");
    anyhow::ensure!(target() != "unsupported", "Standalone server updates are unavailable on this architecture");
    let client = http()?;
    let mut releases = Vec::new();
    for page in 1..=10 {
        let data = bytes(&client, &format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=100&page={page}"), 8 * 1024 * 1024).await?;
        let batch: Vec<Value> = serde_json::from_slice(&data)?;
        let complete = batch.len() < 100;
        releases.extend(batch);
        if complete { break; }
    }
    let mut incompatible = false;
    while let Some(version) = newest(&releases, current)? {
        releases.retain(|release| release["tag_name"] != format!("server-v{version}"));
        let name = format!("server-update-{}.json", target());
        let metadata = bytes(&client, &asset_url(&version, &name), 64 * 1024).await?;
        let signature = String::from_utf8(bytes(&client, &asset_url(&version, &(name + ".sig")), 16 * 1024).await?)?;
        let manifest = authenticate(&metadata, &signature, public_key)?;
        anyhow::ensure!(manifest.version == version, "Server release tag and signed metadata disagree");
        if manifest.api_version != crate::server::API_VERSION || manifest.data_version != crate::server::DATA_VERSION || &manifest.paper_compilers != compilers {
            incompatible = true;
            continue;
        }
        let manifest = verify(&metadata, &signature, public_key)?;
        return Ok(Some(Offer { manifest, metadata, signature }));
    }
    anyhow::ensure!(!incompatible, "Newer server releases require a different API, data format or paper compilers. Install a compatible desktop release or deploy matching server resources manually");
    Ok(None)
}

fn validate_binary(manifest: &Manifest, data: &[u8]) -> Result<()> {
    anyhow::ensure!(data.len() == manifest.size && format!("{:x}", Sha256::digest(data)) == manifest.sha256,
        "Server executable does not match its signed metadata");
    Ok(())
}

fn selection() -> Result<PathBuf> { Ok(crate::client::config_dir()?.join("selected-server.json")) }

/// Verify the cached signature and bytes on every launch, before executing a cached server.
pub async fn selected(public_key: &str, bundled: &Path) -> Result<Option<PathBuf>> {
    let file = selection()?;
    if !file.exists() { return Ok(None) }
    let selection: Value = serde_json::from_slice(&fs::read(file)?)?;
    let metadata = STANDARD.decode(selection["metadata"].as_str().context("Cached server metadata missing")?)?;
    let manifest = verify(&metadata, selection["signature"].as_str().context("Cached server signature missing")?, public_key)?;
    let path = crate::client::config_dir()?.join("server-downloads").join(&manifest.sha256).join(if cfg!(windows) { "noctua.exe" } else { "noctua" });
    validate_binary(&manifest, &fs::read(&path)?)?;
    let bundled_metadata = crate::server_update::candidate(bundled).await?;
    if semver::Version::parse(&manifest.version)? <= semver::Version::parse(bundled_metadata["version"].as_str().context("Bundled server version missing")?)? {
        return Ok(None);
    }
    // A cached server retains the compiler generation verified when it was installed.
    // A later desktop may bundle different compilers without invalidating that server.
    Ok(Some(path))
}

pub async fn download(offer: &Offer, public_key: &str, bundled: &Path) -> Result<PathBuf> {
    let manifest = verify(&offer.metadata, &offer.signature, public_key)?;
    let bundled_metadata = crate::server_update::candidate(bundled).await?;
    anyhow::ensure!(manifest.paper_compilers == bundled_metadata["paper_compilers"], "Server compiler resources changed; check for updates again");
    let data = bytes(&http()?, &asset_url(&manifest.version, &manifest.binary), manifest.size).await?;
    validate_binary(&manifest, &data)?;
    let root = crate::client::config_dir()?.join("server-downloads").join(&manifest.sha256);
    fs::create_dir_all(&root)?;
    let binary = root.join(if cfg!(windows) { "noctua.exe" } else { "noctua" });
    if !binary.exists() {
        let temporary = root.join(format!(".download-{}", uuid::Uuid::new_v4()));
        fs::write(&temporary, &data)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))?;
        }
        fs::rename(&temporary, &binary)?;
    }
    validate_binary(&manifest, &fs::read(&binary)?)?;
    // Preserve the managed compiler trees rather than silently disabling paper builds.
    crate::server_resources::stage(bundled, &binary)?;
    let identity = crate::server_update::candidate(&binary).await?;
    anyhow::ensure!(identity["version"] == manifest.version && identity["paper_compilers"] == manifest.paper_compilers,
        "Signed server metadata does not describe the executable");
    crate::paths::write_private(&selection()?, &json!({"metadata":STANDARD.encode(&offer.metadata),"signature":offer.signature}).to_string())?;
    crate::service::stage(&binary)
}

/// Start the durable update worker and return before server HTTP requests drain.
pub fn begin(executable: &Path, port: u16) -> Result<Value> {
    let data = crate::paths::existing_data_dir()?;
    let staged = crate::service::stage(executable)?;
    crate::server::spawn_detached(&staged, &data, port, &["update"], None)?;
    Ok(json!({"status":"server_updating","message":"The local server is updating. Follow progress in Server & Connection."}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_ignores_desktop_drafts_prereleases_and_downgrades() {
        let releases = json!([
            {"tag_name":"v9.0.0","draft":false,"prerelease":false},
            {"tag_name":"server-v0.3.9","draft":false,"prerelease":false},
            {"tag_name":"server-v0.3.10","draft":false,"prerelease":false},
            {"tag_name":"server-v1.0.0","draft":true,"prerelease":false},
            {"tag_name":"server-v2.0.0","draft":false,"prerelease":true},
            {"tag_name":"server-v3.0.0-beta","draft":false,"prerelease":false}
        ]);
        assert_eq!(newest(releases.as_array().unwrap(), "0.3.5").unwrap(), Some("0.3.10".into()));
        assert_eq!(newest(releases.as_array().unwrap(), "0.3.10").unwrap(), None);
    }
    #[test]
    fn unsigned_metadata_cannot_be_installed() {
        assert!(verify(b"{}", "", "").is_err());
    }
    fn fixture() -> (&'static str, &'static str) {
        match target() {
            "aarch64-apple-darwin" => (include_str!("../testdata/aarch64-apple-darwin.json"), include_str!("../testdata/aarch64-apple-darwin.json.sig")),
            "x86_64-pc-windows-msvc" => (include_str!("../testdata/x86_64-pc-windows-msvc.json"), include_str!("../testdata/x86_64-pc-windows-msvc.json.sig")),
            _ => (include_str!("../testdata/x86_64-unknown-linux-gnu.json"), include_str!("../testdata/x86_64-unknown-linux-gnu.json.sig")),
        }
    }
    #[test]
    fn signed_metadata_binds_version_platform_and_executable_bytes() {
        let (metadata, signature) = fixture();
        let key = include_str!("../testdata/server.pub");
        let manifest = verify(metadata.as_bytes(), signature, key).unwrap();
        assert_eq!(manifest.version, "0.3.6");
        validate_binary(&manifest, b"fixture").unwrap();
        assert!(validate_binary(&manifest, b"changed").is_err());
        assert!(validate_binary(&manifest, b"fixture extra").is_err());
        assert!(verify(metadata.replace("0.3.6", "9.0.0").as_bytes(), signature, key).is_err());
        assert!(verify(metadata.as_bytes(), &(signature.to_owned() + "corrupt"), key).is_err());
        assert!(verify(metadata.as_bytes(), signature, &STANDARD.encode("invalid public key")).is_err());
    }
    #[test]
    fn valid_signature_for_another_platform_is_rejected() {
        let other = if target() == "aarch64-apple-darwin" {
            (include_str!("../testdata/x86_64-pc-windows-msvc.json"), include_str!("../testdata/x86_64-pc-windows-msvc.json.sig"))
        } else {
            (include_str!("../testdata/aarch64-apple-darwin.json"), include_str!("../testdata/aarch64-apple-darwin.json.sig"))
        };
        assert!(verify(other.0.as_bytes(), other.1, include_str!("../testdata/server.pub")).unwrap_err().to_string().contains("incompatible"));
    }
}
