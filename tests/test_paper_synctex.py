"""Cross-platform regression coverage for the real-compiler test's source lookup."""
import gzip
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('paper_integration', Path(__file__).with_name('paper-integration.py'))
paper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paper)


class RecordedSourceTests(unittest.TestCase):
    def test_preserves_compiler_paths_in_plain_and_compressed_maps(self):
        for name in ('./sections/intro.tex', '/tmp/project/work/sections/intro.tex',
                     r'C:\Users\Test User\work\sections\intro.tex',
                     '//?/C:/Users/Test User/work/sections/intro.tex'):
            for compressed in (True, False):
                with self.subTest(name=name, compressed=compressed), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    content = f'SyncTeX Version:1\nInput:1:{name}\nContent:\n'.encode()
                    (root / ('paper.synctex.gz' if compressed else 'paper.synctex')).write_bytes(
                        gzip.compress(content) if compressed else content)
                    self.assertEqual(paper.recorded_source(root, 'paper', 'sections/intro.tex'), name)

    def test_diagnostics_preserve_maps_and_continue_after_probe_error(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raw = b'SyncTeX Version:1\nInput:1:C:/work/intro.tex\nContent:\n'
            original = gzip.compress(raw)
            (root/'paper.synctex.gz').write_bytes(original)
            formats = set()
            commands = []
            def probe(command, cwd, **kwargs):
                commands.append(command)
                sidecar = next(Path(cwd).glob('probe.synctex*'))
                formats.add(sidecar.suffix)
                payload = sidecar.read_bytes()
                self.assertEqual(gzip.decompress(payload) if sidecar.suffix == '.gz' else payload, raw)
                if len(commands) == 1:
                    raise subprocess.TimeoutExpired(command, 10)
                return subprocess.CompletedProcess(command, 0, 'probe result', '')
            with patch.object(paper.platform, 'platform', return_value='test platform'), \
                    patch.object(paper.subprocess, 'run', side_effect=probe):
                report = paper.synctex_diagnostics(Path('synctex'), root, 'paper',
                                                   'C:/work/intro.tex', 'intro.tex', 1)
            self.assertEqual(formats, {'.gz', '.synctex'})
            self.assertTrue(any(command[1] == 'edit' for command in commands))
            self.assertIn('TimeoutExpired', report)
            self.assertIn('probe result', report)
            self.assertEqual((root/'paper.synctex.gz').read_bytes(), original)

    def test_rejects_missing_or_ambiguous_sources(self):
        for names in (['other.tex'], ['/one/sections/intro.tex', '/two/sections/intro.tex']):
            with self.subTest(names=names), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / 'paper.synctex').write_text(''.join(
                    f'Input:{index}:{name}\n' for index, name in enumerate(names)))
                with self.assertRaisesRegex(AssertionError, 'Expected one SyncTeX Input'):
                    paper.recorded_source(root, 'paper', 'sections/intro.tex')


if __name__ == '__main__':
    unittest.main()
