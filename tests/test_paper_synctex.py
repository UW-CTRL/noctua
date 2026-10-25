"""Cross-platform regression coverage for the real-compiler test's source lookup."""
import gzip
import importlib.util
from pathlib import Path
import tempfile
import unittest

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
