"""Validate release versions without changing files or creating tags (Python 3.11+)."""

import json
from pathlib import Path
import re
import sys
import tomllib


def validate(root, tag):
    # Numeric releases work consistently across the desktop installer formats.
    if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Use an existing vMAJOR.MINOR.PATCH tag, such as v0.1.0.")
    version = tag[1:]
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    if manifest["workspace"]["package"]["version"] != version:
        raise ValueError(f"{tag} does not match workspace.package.version in Cargo.toml.")
    for path in ("Cargo.toml", "app/Cargo.toml"):
        package = tomllib.loads((root / path).read_text())["package"]
        if package["version"] != {"workspace": True}:
            raise ValueError(f"{path} must inherit the workspace version.")
    config = json.loads((root / "app/tauri.conf.json").read_text())
    if config.get("version") is not None:
        raise ValueError("Remove the Tauri version override to inherit the Cargo version.")
    packages = tomllib.loads((root / "Cargo.lock").read_text())["package"]
    for name in ("noctua", "noctua-app"):
        versions = [p["version"] for p in packages if p["name"] == name]
        if versions != [version]:
            raise ValueError(f"Refresh Cargo.lock: {name} must have version {version}.")
    return version


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: python3 .github/scripts/check-release-version.py v0.1.0")
        version = validate(Path(__file__).resolve().parents[2], sys.argv[1])
        print(f"Release version validated: {version}")
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
