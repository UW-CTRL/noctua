"""Reject wrong-platform or damaged prebuilt servers without invoking Cargo."""
import hashlib
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[2] / 'app/prepare-server.py'
SPEC = importlib.util.spec_from_file_location('prepare_server', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrebuiltServerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='prebuilt server ')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / 'app').mkdir()
        self.binary = self.root / 'noctua'
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', header, 18, 62)
        self.binary.write_bytes(header)
        self.digest = hashlib.sha256(header).hexdigest()

    def test_native_prebuilt_skips_cargo_and_preserves_executable_mode(self):
        with patch.object(MODULE.subprocess, 'run') as run:
            result = MODULE.prepare(self.root, 'x86_64-unknown-linux-gnu', self.binary, self.digest)
        run.assert_not_called()
        self.assertEqual(result.read_bytes(), self.binary.read_bytes())
        self.assertTrue(result.stat().st_mode & 0o111)

    def test_checksum_and_platform_fail_before_copy(self):
        for target, digest in [('x86_64-unknown-linux-gnu', '0' * 64), ('x86_64-pc-windows-msvc', self.digest)]:
            with self.subTest(target=target), self.assertRaises(ValueError):
                MODULE.prepare(self.root, target, self.binary, digest)
        self.assertFalse((self.root / 'app/binaries/noctua-server').exists())

    def test_macos_and_windows_headers(self):
        macho = bytearray(64)
        macho[:4] = b'\xcf\xfa\xed\xfe'
        struct.pack_into('<I', macho, 4, 0x0100000C)
        self.binary.write_bytes(macho)
        self.assertEqual(MODULE.binary_targets(self.binary), {'aarch64-apple-darwin'})
        pe = bytearray(128)
        pe[:2] = b'MZ'
        struct.pack_into('<I', pe, 0x3c, 64)
        pe[64:70] = b'PE\0\0\x64\x86'
        self.binary.write_bytes(pe)
        self.assertEqual(MODULE.binary_targets(self.binary), {'x86_64-pc-windows-msvc'})

    def test_default_still_builds_server(self):
        built = self.root / 'target/x86_64-unknown-linux-gnu/release/noctua'
        built.parent.mkdir(parents=True)
        built.write_bytes(self.binary.read_bytes())
        with patch.object(MODULE.subprocess, 'run') as run:
            MODULE.prepare(self.root, 'x86_64-unknown-linux-gnu')
        self.assertEqual(run.call_args.args[0], ['cargo', 'build', '--locked', '--release', '-p', 'noctua', '--target', 'x86_64-unknown-linux-gnu'])


if __name__ == '__main__':
    unittest.main()
