"""Exercise fast source-bundle cloning without relying on compiler downloads."""
import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import paper_fixture


class PaperFixtureTests(unittest.TestCase):
    def test_windows_verbatim_paths_normalize_for_fixture_ownership_checks(self):
        self.assertEqual(str(paper_fixture.native_path(r'\\?\C:\fixture\noctua.exe')), r'C:\fixture\noctua.exe')
        self.assertEqual(str(paper_fixture.native_path(r'\\?\UNC\host\share\noctua.exe')), r'\\host\share\noctua.exe')

    def test_clone_survives_source_removal_without_recopying_file_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'distribution'
            source.mkdir()
            binary = source / 'compiler'
            binary.write_bytes(b'compiler fixture')
            destination = root / 'bundle'
            with patch.object(paper_fixture.shutil, 'copy2', wraps=paper_fixture.shutil.copy2) as copy:
                paper_fixture.clone_distribution(source, destination)
            copy.assert_not_called()
            self.assertTrue(binary.samefile(destination / 'compiler'))
            paper_fixture.shutil.rmtree(source)
            self.assertEqual((destination / 'compiler').read_bytes(), b'compiler fixture')

    def test_clone_falls_back_to_copy_on_cross_volume_or_restricted_filesystems(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'compiler'
            binary.write_bytes(b'compiler fixture')
            destination = root / 'copy'
            with patch.object(paper_fixture.os, 'link', side_effect=OSError(errno.EXDEV, 'Different volumes')):
                paper_fixture.link_or_copy(binary, destination)
            self.assertEqual(destination.read_bytes(), binary.read_bytes())
            self.assertFalse(binary.samefile(destination))

    @unittest.skipIf(paper_fixture.os.name == 'nt', 'Windows distributions materialize links')
    def test_relative_compiler_links_keep_their_original_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'distribution'
            source.mkdir()
            (source / 'pdftex').write_text('engine')
            (source / 'pdflatex').symlink_to('pdftex')
            destination = root / 'copy'
            paper_fixture.clone_distribution(source, destination)
            self.assertEqual((destination / 'pdflatex').readlink(), Path('pdftex'))
            self.assertEqual((destination / 'pdflatex').read_text(), 'engine')


if __name__ == '__main__':
    unittest.main()
