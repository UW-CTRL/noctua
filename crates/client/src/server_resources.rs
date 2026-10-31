//! Keep packaged compilers beside the independent server, outside the app bundle.
use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn bundled(executable: &Path) -> Option<PathBuf> {
    let parent = executable.parent()?;
    let staged = parent.join("paper-resources");
    if staged.is_dir() {
        return Some(staged);
    }
    if parent.file_name()?.to_str()? != "binaries" {
        return None;
    }
    let root = parent.parent()?;
    ["tectonic", "texlive"]
        .iter()
        .any(|name| root.join(name).is_dir())
        .then(|| root.to_owned())
}

pub fn root(executable: &Path) -> Option<PathBuf> { bundled(executable) }

fn copy(source: &Path, destination: &Path, root: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        anyhow::ensure!(
            fs::canonicalize(source)?.starts_with(root),
            "Compiler resource symlink leaves its distribution"
        );
        let link = fs::read_link(source)?;
        anyhow::ensure!(
            link.is_relative(),
            "Compiler resource links must be relative for relocatable packaging"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(link, destination)?;
            return Ok(());
        }
        #[cfg(not(unix))]
        anyhow::bail!("Compiler resources must be materialized before Windows packaging");
    }
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy(&entry.path(), &destination.join(entry.file_name()), root)?;
        }
    } else {
        anyhow::ensure!(metadata.is_file(), "Unsupported compiler resource type");
        fs::copy(source, destination)?;
    }
    Ok(())
}

/// Preserve the browser UI snapshot independently of the installed app bundle.
/// Existing snapshots are immutable while that server executable is in use.
fn stage_browser_ui(source: &Path, executable: &Path) -> Result<()> {
    let Some(parent) = executable.parent() else { return Ok(()); };
    let destination = parent.join("browser-ui");
    anyhow::ensure!(!destination.is_symlink(), "Refuse a browser UI staging symlink");
    if destination.is_dir() { return Ok(()); }
    let ui = source.parent().map(|p|p.join("browser-ui")).filter(|p|p.is_dir())
        .or_else(||bundled(source).map(|p|p.join("ui")).filter(|p|p.is_dir()));
    let Some(ui) = ui else { return Ok(()); };
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".ui-stage-{}",uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        copy(&ui, &temporary, &fs::canonicalize(&ui)?)?;
        if let Err(error) = fs::rename(&temporary,&destination) {
            if !destination.is_dir() { return Err(error.into()); }
        }
        Ok(())
    })();
    if temporary.exists() { let _ = fs::remove_dir_all(temporary); }
    result
}

pub fn stage(source: &Path, executable: &Path) -> Result<()> {
    stage_browser_ui(source, executable)?;
    let Some(root) = bundled(source) else {
        return Ok(());
    };
    let parent = executable
        .parent()
        .context("Server executable has no parent")?;
    let destination = parent.join("paper-resources");
    if destination.is_dir() {
        return Ok(());
    }
    let temporary = parent.join(format!(".paper-stage-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&temporary)?;
    let result = (|| -> Result<()> {
        let root = fs::canonicalize(root)?;
        for name in ["tectonic", "texlive"] {
            let source = root.join(name);
            if source.is_dir() {
                copy(&source, &temporary.join(name), &fs::canonicalize(&source)?)?;
            }
        }
        // Publish complete resource trees atomically, including under concurrent ensure.
        if let Err(error) = fs::rename(&temporary, &destination) {
            if !destination.is_dir() {
                return Err(error.into());
            }
        }
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_dir_all(temporary);
    }
    result
}

pub(crate) fn cleanup(parent: &Path) -> Result<()> {
    let ui = parent.join("browser-ui");
    if ui.exists() {
        anyhow::ensure!(!ui.is_symlink(), "Refuse cleanup of a browser UI symlink");
        fs::remove_dir_all(ui)?;
    }
    let resources = parent.join("paper-resources");
    if resources.exists() {
        anyhow::ensure!(
            !resources.is_symlink(),
            "Refuse cleanup of a compiler resource symlink"
        );
        fs::remove_dir_all(resources)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_ui_is_durable_immutable_and_carried_to_server_updates() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("app/binaries/server");
        fs::create_dir_all(source.parent().unwrap()).unwrap(); fs::write(&source,b"server").unwrap();
        fs::create_dir_all(root.path().join("app/ui")).unwrap();
        fs::write(root.path().join("app/ui/index.html"),"first UI").unwrap();
        fs::create_dir_all(root.path().join("app/tectonic")).unwrap();
        let target = root.path().join("staged/server"); fs::create_dir_all(target.parent().unwrap()).unwrap();
        stage(&source,&target).unwrap();
        fs::write(root.path().join("app/ui/index.html"),"new UI").unwrap();
        stage(&source,&target).unwrap();
        assert_eq!(fs::read_to_string(root.path().join("staged/browser-ui/index.html")).unwrap(),"first UI");
        let updated = root.path().join("updated/server"); fs::create_dir_all(updated.parent().unwrap()).unwrap();
        stage(&target,&updated).unwrap();
        fs::remove_dir_all(root.path().join("app")).unwrap();
        assert_eq!(fs::read_to_string(root.path().join("updated/browser-ui/index.html")).unwrap(),"first UI");
    }
    #[test]
    fn staged_compilers_survive_bundle_removal_and_leave_other_files_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let bundle = root.join("bundle");
        fs::create_dir_all(bundle.join("binaries")).unwrap();
        for name in ["tectonic", "texlive"] {
            fs::create_dir_all(bundle.join(name)).unwrap();
            fs::write(bundle.join(name).join("compiler"), name).unwrap();
        }
        let source = bundle.join("binaries/noctua-server");
        fs::write(&source, "server").unwrap();
        let target = root.join("managed/noctua");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "server").unwrap();
        stage(&source, &target).unwrap();
        fs::remove_dir_all(bundle).unwrap();
        stage(&target, &target).unwrap();
        for name in ["tectonic", "texlive"] {
            assert_eq!(
                fs::read_to_string(bundled(&target).unwrap().join(name).join("compiler")).unwrap(),
                name
            );
        }
        cleanup(target.parent().unwrap()).unwrap();
        assert!(target.is_file());
        assert!(bundled(&target).is_none());
    }
    #[cfg(unix)]
    #[test]
    fn external_compiler_links_are_not_copied() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let bundle = root.join("bundle");
        fs::create_dir_all(bundle.join("binaries")).unwrap();
        fs::create_dir(bundle.join("tectonic")).unwrap();
        fs::write(root.join("outside"), "private").unwrap();
        std::os::unix::fs::symlink(root.join("outside"), bundle.join("tectonic/link")).unwrap();
        let target = root.join("managed/noctua");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        assert!(stage(&bundle.join("binaries/noctua-server"), &target).is_err());
        assert!(!target.parent().unwrap().join("paper-resources").exists());
    }
}
