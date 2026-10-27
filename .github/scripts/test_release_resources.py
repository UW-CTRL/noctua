import importlib.util
from pathlib import Path
import unittest

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

    def test_release_restores_compilers_after_rust_cache_cleanup(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text().split('  build:', 1)[1]
        self.assertLess(workflow.index('uses: Swatinem/rust-cache@v2'),
                        workflow.index('name: Restore managed paper compilers'))
        self.assertIn('check-release-resources.py', workflow)


if __name__ == '__main__':
    unittest.main()
