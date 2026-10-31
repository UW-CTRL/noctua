"""Smoke-test and archive a native standalone server; no Tauri or TeX required."""

import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import tarfile
import zipfile

TARGETS = {
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
}


def package(root, tag, target):
    if target not in TARGETS:
        raise ValueError(f"Unsupported server target: {target}")
    # Reuse the version validator without importing the desktop configuration.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "release_version", Path(__file__).with_name("check-release-version.py"))
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    version = validator.validate(root, tag, server=True)
    windows = "windows" in target
    binary = root / "target" / target / "release" / ("noctua.exe" if windows else "noctua")
    identity = json.loads(subprocess.check_output([str(binary), "describe"], text=True, timeout=30))
    if identity.get("version") != version:
        raise ValueError("Built server version does not match release tag")
    output = root / "server-dist"
    output.mkdir(exist_ok=True)
    archive = output / f"noctua-{tag}-{target}{'.zip' if windows else '.tar.gz'}"
    files = [(binary, binary.name), (root / "LICENSE", "LICENSE")]
    ui = root / 'web'
    if not (ui / 'index.html').is_file():
        raise ValueError('Browser UI source is required for standalone packaging')
    files += [(path, 'ui/' + path.relative_to(ui).as_posix()) for path in sorted(ui.rglob('*')) if path.is_file()]
    files += [(root / f'app/icons/icon-{name}.svg', f'ui/app-icons/{name}.svg') for name in ['dark', 'light']]
    if windows:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for source, name in files:
                bundle.write(source, name)
    else:
        with tarfile.open(archive, "w:gz") as bundle:
            for source, name in files:
                bundle.add(source, arcname=name)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n")
    raw = output / f"noctua-{tag}-{target}{'.exe' if windows else ''}"
    shutil.copy2(binary, raw)
    metadata = {
        "version": version, "target": target,
        "api_version": identity["api_version"], "data_version": identity["data_version"],
        "paper_compilers": identity["paper_compilers"],
        "binary": raw.name, "sha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
        "size": raw.stat().st_size,
    }
    (output / f"server-update-{target}.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return archive


if __name__ == "__main__":
    import tomllib
    root = Path(__file__).resolve().parents[2]
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    version = manifest["package"]["version"]
    if isinstance(version, dict):
        version = manifest["workspace"]["package"]["version"]
    package(root, os.environ.get("RELEASE_TAG", "server-v" + version), os.environ["RELEASE_TARGET"])
