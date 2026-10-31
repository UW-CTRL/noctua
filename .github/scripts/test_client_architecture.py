"""Validate native build boundaries and independent release workflow wiring."""
from pathlib import Path
import tomllib
import unittest

ROOT = Path(__file__).parents[2]


class ClientArchitectureTests(unittest.TestCase):
    def test_desktop_has_no_research_backend_dependency(self):
        manifest = tomllib.loads((ROOT / 'app/Cargo.toml').read_text())
        self.assertEqual(manifest['dependencies']['noctua']['package'], 'noctua-client')
        client = tomllib.loads((ROOT / 'crates/client/Cargo.toml').read_text())
        for server_dependency in ['pdf-extract', 'html5ever', 'axum', 'zip']:
            self.assertNotIn(server_dependency, client['dependencies'])
        self.assertNotIn('noctua', client['dependencies'])

    def test_release_workflows_reuse_the_server_builder(self):
        for name in ['release.yml', 'release-server.yml']:
            workflow = (ROOT / '.github/workflows' / name).read_text()
            self.assertIn('uses: ./.github/workflows/build-server.yml', workflow)
        desktop = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertIn('configure-prebuilt-server.py', desktop)
        self.assertIn('needs: [prepare, server-build]', desktop)
        server = (ROOT / '.github/workflows/release-server.yml').read_text()
        self.assertLess(server.index('cargo tauri signer sign'), server.index('Publish server release'))


if __name__ == '__main__':
    unittest.main()
