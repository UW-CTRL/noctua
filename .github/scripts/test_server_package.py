"""Verify server archives, executable permissions, checksums and smoke-test failures."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).with_name("package-server.py")
SPEC = importlib.util.spec_from_file_location("server_package", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ServerPackageTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        for name in ("Cargo.toml", "Cargo.lock", "LICENSE"):
            shutil.copyfile(SCRIPT.parents[2] / name, self.root / name)
        import tomllib
        self.version = tomllib.loads((self.root / "Cargo.toml").read_text())["workspace"]["package"]["version"]
        self.tag = "server-v" + self.version

    def binary(self, target):
        binary = self.root / "target" / target / "release" / ("noctua.exe" if "windows" in target else "noctua")
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"server fixture")
        binary.chmod(0o755)
        return binary

    def test_platform_archives_and_checksums(self):
        for target in MODULE.TARGETS:
            with self.subTest(target=target):
                binary = self.binary(target)
                with patch.object(MODULE.subprocess, "check_output", return_value=json.dumps({"version": self.version, "api_version": 1, "data_version": 1, "paper_compilers": {"tectonic": "0.17.0", "texlive": "2026.10"}})) as smoke:
                    archive = MODULE.package(self.root, self.tag, target)
                smoke.assert_called_once_with([str(binary), "describe"], text=True, timeout=30)
                digest = hashlib.sha256(archive.read_bytes()).hexdigest()
                self.assertEqual(archive.with_name(archive.name + ".sha256").read_text(), f"{digest}  {archive.name}\n")
                if "windows" in target:
                    with zipfile.ZipFile(archive) as bundle:
                        self.assertEqual(set(bundle.namelist()), {"noctua.exe", "LICENSE"})
                        self.assertEqual(bundle.read("noctua.exe"), binary.read_bytes())
                else:
                    with tarfile.open(archive) as bundle:
                        self.assertEqual(set(bundle.getnames()), {"noctua", "LICENSE"})
                        self.assertTrue(bundle.getmember("noctua").mode & 0o111)
                        self.assertEqual(bundle.extractfile("noctua").read(), binary.read_bytes())
                metadata = json.loads((archive.parent / f"server-update-{target}.json").read_text())
                raw = archive.parent / metadata["binary"]
                self.assertEqual(metadata["sha256"], hashlib.sha256(raw.read_bytes()).hexdigest())
                self.assertEqual(metadata["version"], self.version)

    def test_wrong_binary_version_is_not_packaged(self):
        with patch.object(MODULE.subprocess, "check_output", return_value='{"version":"999.0.0"}'):
            with self.assertRaisesRegex(ValueError, "Built server version"):
                MODULE.package(self.root, self.tag, "aarch64-apple-darwin")
        self.assertFalse((self.root / "server-dist").exists())

    def test_failed_smoke_test_is_not_packaged(self):
        with patch.object(MODULE.subprocess, "check_output", side_effect=subprocess.CalledProcessError(1, "describe")):
            with self.assertRaises(subprocess.CalledProcessError):
                MODULE.package(self.root, self.tag, "x86_64-unknown-linux-gnu")
        self.assertFalse((self.root / "server-dist").exists())


if __name__ == "__main__":
    unittest.main()
