"""Validate release versions without changing files or creating tags (Python 3.11+)."""

import json
from pathlib import Path
import re
import sys
import tomllib


def validate(root, tag, *, server=False):
    # Numeric releases work consistently across the desktop installer formats.
    prefix = "server-v" if server else "v"
    if not re.fullmatch(prefix + r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError(f"Use an existing {prefix}MAJOR.MINOR.PATCH tag.")
    version = tag[len(prefix):]
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    server_version = manifest["package"]["version"]
    if isinstance(server_version, dict):
        server_version = manifest["workspace"]["package"]["version"]
    expected = server_version if server else manifest["workspace"]["package"]["version"]
    if expected != version:
        raise ValueError(f"{tag} does not match the {'server package' if server else 'workspace desktop'} version in Cargo.toml.")
    for path in (() if server else ("app/Cargo.toml",)):
        package = tomllib.loads((root / path).read_text())["package"]
        if package["version"] != {"workspace": True}:
            raise ValueError(f"{path} must inherit the workspace version.")
    if not server:
        config = json.loads((root / "app/tauri.conf.json").read_text())
        if config.get("version") is not None:
            raise ValueError("Remove the Tauri version override to inherit the Cargo version.")
    packages = tomllib.loads((root / "Cargo.lock").read_text())["package"]
    for name in (("noctua",) if server else ("noctua-app",)):
        versions = [p["version"] for p in packages if p["name"] == name]
        if versions != [version]:
            raise ValueError(f"Refresh Cargo.lock: {name} must have version {version}.")
    return version


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--server"):
            raise ValueError("Usage: python3 .github/scripts/check-release-version.py TAG [--server]")
        version = validate(Path(__file__).resolve().parents[2], sys.argv[1], server=len(sys.argv) == 3)
        print(f"Release version validated: {version}")
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
