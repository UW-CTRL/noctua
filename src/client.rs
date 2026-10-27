//! Machine-local connection preferences; never stored in the research data folder.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
#[cfg(target_os = "linux")]
use std::{
    io::Write,
    process::{Command, Stdio},
};

pub fn config_dir() -> Result<PathBuf> {
    let root = std::env::var_os("NOCTUA_CLIENT_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::config_dir().map(|p| p.join("NoctuaClient")))
        .context("Client configuration directory unavailable")?;
    fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    }
    Ok(fs::canonicalize(root)?)
}
#[derive(Default, Serialize, Deserialize)]
pub struct Connection {
    pub mode: String,
    pub address: String,
    pub server_id: String,
}
pub fn load() -> Result<Connection> {
    let p = config_dir()?.join("connection.json");
    if !p.exists() {
        return Ok(Connection::default());
    }
    Ok(serde_json::from_slice(&fs::read(p)?)?)
}
pub fn save(connection: &Connection) -> Result<()> {
    crate::paths::write_private(
        &config_dir()?.join("connection.json"),
        &serde_json::to_string(connection)?,
    )
}
fn account(address: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(address.as_bytes()))
}
/// Secrets go through OS tools' stdin, never shell interpolation, argv, URLs or logs.
/// macOS security lacks stdin password input, so use Keychain's native API below.
#[cfg(target_os = "macos")]
mod keychain {
    use std::ffi::c_void;
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainAddGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            password_len: u32,
            password: *const u8,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainFindGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            password_len: *mut u32,
            password: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item: *mut c_void,
            attrs: *const c_void,
            len: u32,
            data: *const u8,
        ) -> i32;
        fn SecKeychainItemFreeContent(attrs: *mut c_void, data: *mut c_void) -> i32;
        fn CFRelease(item: *const c_void);
    }
    const SERVICE: &[u8] = b"app.noctua.connection";
    pub fn store(account: &str, secret: &str) -> anyhow::Result<()> {
        unsafe {
            let mut item = std::ptr::null_mut();
            let found = SecKeychainFindGenericPassword(
                std::ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut item,
            );
            let code = if found == 0 {
                let r = SecKeychainItemModifyAttributesAndData(
                    item,
                    std::ptr::null(),
                    secret.len() as u32,
                    secret.as_ptr(),
                );
                CFRelease(item);
                r
            } else {
                SecKeychainAddGenericPassword(
                    std::ptr::null(),
                    SERVICE.len() as u32,
                    SERVICE.as_ptr(),
                    account.len() as u32,
                    account.as_ptr(),
                    secret.len() as u32,
                    secret.as_ptr(),
                    std::ptr::null_mut(),
                )
            };
            anyhow::ensure!(
                code == 0,
                "Keychain could not save the credential (OS status {code})"
            );
            Ok(())
        }
    }
    pub fn read(account: &str) -> anyhow::Result<String> {
        unsafe {
            let mut len = 0;
            let mut data = std::ptr::null_mut();
            let code = SecKeychainFindGenericPassword(
                std::ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                &mut len,
                &mut data,
                std::ptr::null_mut(),
            );
            anyhow::ensure!(
                code == 0,
                "Keychain credential unavailable (OS status {code}); enter it again"
            );
            let result = String::from_utf8(
                std::slice::from_raw_parts(data as *const u8, len as usize).to_vec(),
            );
            SecKeychainItemFreeContent(std::ptr::null_mut(), data);
            Ok(result?)
        }
    }
}
#[cfg(windows)]
mod credential {
    use std::ffi::c_void;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target: *mut u16,
        comment: *mut u16,
        modified: FileTime,
        size: u32,
        blob: *mut u8,
        persist: u32,
        count: u32,
        attributes: *mut c_void,
        alias: *mut u16,
        user: *mut u16,
    }
    #[link(name = "Advapi32")]
    unsafe extern "system" {
        fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
        fn CredReadW(
            target: *const u16,
            kind: u32,
            flags: u32,
            credential: *mut *mut Credential,
        ) -> i32;
        fn CredFree(buffer: *mut c_void);
    }
    fn target(account: &str) -> Vec<u16> {
        format!("Noctua/{account}")
            .encode_utf16()
            .chain(Some(0))
            .collect()
    }
    pub fn store(account: &str, secret: &str) -> anyhow::Result<()> {
        let mut target = target(account);
        let mut bytes = secret.as_bytes().to_vec();
        let credential = Credential {
            flags: 0,
            kind: 1,
            target: target.as_mut_ptr(),
            comment: std::ptr::null_mut(),
            modified: FileTime { low: 0, high: 0 },
            size: bytes.len() as u32,
            blob: bytes.as_mut_ptr(),
            persist: 2,
            count: 0,
            attributes: std::ptr::null_mut(),
            alias: std::ptr::null_mut(),
            user: std::ptr::null_mut(),
        };
        anyhow::ensure!(
            unsafe { CredWriteW(&credential, 0) } != 0,
            "Windows Credential Manager could not save the credential"
        );
        Ok(())
    }
    pub fn read(account: &str) -> anyhow::Result<String> {
        unsafe {
            let target = target(account);
            let mut credential = std::ptr::null_mut();
            anyhow::ensure!(
                CredReadW(target.as_ptr(), 1, 0, &mut credential) != 0,
                "Windows credential unavailable; enter it again"
            );
            let bytes = std::slice::from_raw_parts((*credential).blob, (*credential).size as usize)
                .to_vec();
            CredFree(credential as *mut c_void);
            Ok(String::from_utf8(bytes)?)
        }
    }
}
pub fn store_secret(address: &str, secret: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        keychain::store(&account(address), secret)?;
    }
    #[cfg(target_os = "linux")]
    {
        let mut child = Command::new("secret-tool")
            .args([
                "store",
                "--label=Noctua server",
                "application",
                "noctua",
                "account",
                &account(address),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("Install a Secret Service keyring and secret-tool to save credentials")?;
        child.stdin.take().unwrap().write_all(secret.as_bytes())?;
        anyhow::ensure!(
            child.wait()?.success(),
            "OS keyring could not save the credential"
        );
    }
    #[cfg(windows)]
    {
        credential::store(&account(address), secret)?;
    }
    Ok(())
}
pub fn read_secret(address: &str) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        return keychain::read(&account(address));
    }
    #[cfg(target_os = "linux")]
    {
        let out = Command::new("secret-tool")
            .args([
                "lookup",
                "application",
                "noctua",
                "account",
                &account(address),
            ])
            .output()
            .context("OS keyring unavailable")?;
        anyhow::ensure!(
            out.status.success(),
            "Credential unavailable; enter it again"
        );
        return Ok(String::from_utf8(out.stdout)?.trim_end().into());
    }
    #[cfg(windows)]
    {
        return credential::read(&account(address));
    }
}
