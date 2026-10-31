import importlib.util
from pathlib import Path
import unittest
import tempfile
import io
import tarfile
from unittest.mock import patch

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location('resources', Path(__file__).with_name('check-release-resources.py'))
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)


class ReleaseResourceTests(unittest.TestCase):
    names = ['binaries/noctua-server', 'tectonic/x86_64-unknown-linux-musl/tectonic',
             'texlive/bin/x86_64-linux/pdftex', 'texlive/bin/x86_64-linux/bibtex',
             'texlive/texmf-dist/tex/latex/base/article.cls', 'tectonic/notices/LICENSE']

    def test_complete_packages_on_all_platforms(self):
        resources.validate(['usr/lib/Noctua/' + name for name in self.names])
        resources.validate(['Noctua.app/Contents/Resources/' + name for name in self.names])
        resources.validate([name.replace('/', '\\') + ('.exe' if i < 4 else '')
                            for i, name in enumerate(self.names)])

    def test_each_required_resource_is_checked(self):
        for index in range(len(self.names)):
            with self.subTest(index=index), self.assertRaises(ValueError):
                resources.validate(self.names[:index] + self.names[index + 1:])

    def test_empty_resource_trees_fail(self):
        with self.assertRaises(ValueError):
            resources.validate(['usr/bin/noctua-app'])

    def test_dmg_is_mounted_readonly_and_detached_even_if_validation_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            dmg = root / 'target/release/bundle/dmg/Noctua.dmg'
            dmg.parent.mkdir(parents=True)
            dmg.touch()
            with patch.object(resources.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'Installer is missing'):
                    resources.check(root, 'darwin')
                self.assertEqual(run.call_args_list[0].args[0][:4],
                                 ['hdiutil', 'attach', '-readonly', '-nobrowse'])
                self.assertEqual(run.call_args_list[-1].args[0][:2], ['hdiutil', 'detach'])

    def test_macos_updater_requires_signed_archive_with_runtime_resources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(ValueError, 'archive is required'):
                resources.check_macos_updater(root)
            archive = root / 'target/release/bundle/macos/Noctua.app.tar.gz'
            archive.parent.mkdir(parents=True)
            def write(names):
                with tarfile.open(archive, 'w:gz') as package:
                    for name in names:
                        info = tarfile.TarInfo('Noctua.app/Contents/Resources/' + name)
                        info.size = 1
                        package.addfile(info, io.BytesIO(b'x'))
            write(self.names)
            with self.assertRaisesRegex(ValueError, 'signature is required'):
                resources.check_macos_updater(root)
            archive.with_name(archive.name + '.sig').write_text('signed fixture')
            resources.check_macos_updater(root)
            write(self.names[1:])
            with self.assertRaisesRegex(ValueError, 'missing: server'):
                resources.check_macos_updater(root)

    def test_new_desktop_packages_keep_a_browser_ui_snapshot(self):
        import os
        with patch.dict(os.environ, {'NOCTUA_REQUIRE_BROWSER_UI': 'true'}):
            with self.assertRaisesRegex(ValueError, 'browser UI'):
                resources.validate(self.names)
            resources.validate(self.names + ['Noctua.app/Contents/Resources/ui/index.html'])

    def test_linux_requires_both_retained_packages(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            deb = root / 'target/release/bundle/deb/Noctua.deb'
            deb.parent.mkdir(parents=True)
            deb.touch()
            with self.assertRaisesRegex(ValueError, 'Both DEB and AppImage'):
                resources.check(root, 'linux')

    def test_release_restores_compilers_after_rust_cache_cleanup(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text().split('  build:', 1)[1]
        self.assertLess(workflow.index('uses: Swatinem/rust-cache@v2'),
                        workflow.index('name: Restore managed paper compilers'))
        self.assertIn('check-release-resources.py', workflow)


if __name__ == '__main__':
    unittest.main()
