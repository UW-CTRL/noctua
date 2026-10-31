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
        for server_dependency in ['pdf-extract', 'html5ever', 'zip']:
            self.assertNotIn(server_dependency, client['dependencies'])
        self.assertNotIn('noctua', client['dependencies'])

    def test_desktop_reuses_verified_published_servers(self):
        desktop = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertNotIn('uses: ./.github/workflows/build-server.yml', desktop)
        self.assertIn('configure-prebuilt-server.py', desktop)
        self.assertIn('needs: [prepare, server-artifacts]', desktop)
        self.assertIn('verify-server-artifacts', desktop)
        self.assertIn('gh release download', desktop)
        self.assertIn('uses: ./.github/workflows/build-server.yml', (ROOT / '.github/workflows/release-server.yml').read_text())
        server = (ROOT / '.github/workflows/release-server.yml').read_text()
        self.assertLess(server.index('cargo tauri signer sign'), server.index('Publish server release'))


if __name__ == '__main__':
    unittest.main()
