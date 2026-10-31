"""Exercise release validation against isolated copies of the real configuration."""

import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("check-release-version.py")
SPEC = importlib.util.spec_from_file_location("release_version", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseVersionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("Cargo.toml", "app/Cargo.toml", "app/tauri.conf.json", "Cargo.lock"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SCRIPT.parents[2] / name, target)
        manifest = MODULE.tomllib.loads((self.root / "Cargo.toml").read_text())
        self.version = manifest["workspace"]["package"]["version"]
        self.tag = "v" + self.version

    def test_current_version_is_valid(self):
        self.assertEqual(MODULE.validate(self.root, self.tag), self.version)

    def test_server_tag_needs_no_desktop_configuration(self):
        shutil.rmtree(self.root / "app")
        self.assertEqual(MODULE.validate(self.root, "server-" + self.tag, server=True), self.version)

    def test_release_channels_reject_each_others_tags(self):
        with self.assertRaises(ValueError):
            MODULE.validate(self.root, self.tag, server=True)
        with self.assertRaises(ValueError):
            MODULE.validate(self.root, "server-" + self.tag)

    def test_server_rejects_stale_lockfile(self):
        path = self.root / "Cargo.lock"
        path.write_text(path.read_text().replace(
            f'name = "noctua"\nversion = "{self.version}"',
            'name = "noctua"\nversion = "999.999.999"',
        ))
        with self.assertRaisesRegex(ValueError, "Refresh Cargo.lock"):
            MODULE.validate(self.root, "server-" + self.tag, server=True)

    def test_stable_version_uses_the_same_validation(self):
        for name in ("Cargo.toml", "Cargo.lock"):
            path = self.root / name
            path.write_text(path.read_text().replace(
                f'version = "{self.version}"', 'version = "1.0.0"',
            ))
        self.assertEqual(MODULE.validate(self.root, "v1.0.0"), "1.0.0")

    def test_server_and_desktop_versions_advance_independently(self):
        manifest = self.root / "Cargo.toml"
        manifest.write_text(manifest.read_text().replace(
            f'version = "{self.version}"', 'version = "0.9.0"', 1))
        lock = self.root / "Cargo.lock"
        lock.write_text(lock.read_text().replace(
            f'name = "noctua"\nversion = "{self.version}"',
            'name = "noctua"\nversion = "0.9.0"'))
        self.assertEqual(MODULE.validate(self.root, self.tag), self.version)
        self.assertEqual(MODULE.validate(self.root, "server-v0.9.0", server=True), "0.9.0")
        with self.assertRaises(ValueError):
            MODULE.validate(self.root, "server-" + self.tag, server=True)

    def test_numeric_release_tags_only(self):
        for tag in ("main", "0.1.0", "v01.0.0", "v1.0", "v1.0.0-rc.1", "v1.0.0+build"):
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "vMAJOR"):
                MODULE.validate(self.root, tag)

    def test_mismatched_tag(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            MODULE.validate(self.root, "v999.999.999")

    def test_stale_lockfile(self):
        path = self.root / "Cargo.lock"
        path.write_text(path.read_text().replace(
            f'name = "noctua-app"\nversion = "{self.version}"',
            'name = "noctua-app"\nversion = "999.999.999"',
        ))
        with self.assertRaisesRegex(ValueError, "Refresh Cargo.lock"):
            MODULE.validate(self.root, self.tag)

    def test_tauri_override_is_rejected(self):
        path = self.root / "app/tauri.conf.json"
        config = MODULE.json.loads(path.read_text())
        config["version"] = self.version
        path.write_text(MODULE.json.dumps(config))
        with self.assertRaisesRegex(ValueError, "Tauri version override"):
            MODULE.validate(self.root, self.tag)

    def test_manual_package_version_is_rejected(self):
        path = self.root / "app/Cargo.toml"
        path.write_text(path.read_text().replace(
            "version.workspace = true", f'version = "{self.version}"',
        ))
        with self.assertRaisesRegex(ValueError, "must inherit"):
            MODULE.validate(self.root, self.tag)


if __name__ == "__main__":
    unittest.main()
