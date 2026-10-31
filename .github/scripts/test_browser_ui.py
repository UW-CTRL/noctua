import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('browser_ui', Path(__file__).with_name('package-browser-ui.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BrowserUITests(unittest.TestCase):
    def test_browser_ui_ships_as_part_of_the_desktop_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'web').mkdir()
            for name in ['index.html', 'shell.html', 'app.js', 'connection.js', 'pdf.js']:
                (root / 'web' / name).write_text('UI fixture')
            (root / 'app/icons').mkdir(parents=True)
            for name in ['dark', 'light']:
                (root / f'app/icons/icon-{name}.svg').write_text('<svg/>')
            archive = module.package(root, '0.4.0')
            self.assertEqual(archive.name, 'Noctua_0.4.0_browser-ui.tar.gz')
            with tarfile.open(archive) as bundle:
                self.assertIn('app-icons/dark.svg', bundle.getnames())
                self.assertIn('index.html', bundle.getnames())
                self.assertEqual(json.load(bundle.extractfile('noctua-ui.json')),
                                 {'desktop_version': '0.4.0', 'api_versions': [1, 2], 'data_version': 1})
            self.assertEqual(archive.with_name(archive.name + '.sha256').read_text(),
                             hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')

    def test_missing_ui_does_not_produce_an_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'Missing browser UI'):
                module.package(Path(directory), '0.4.0')
