"""Exercise the production release-config script against isolated tagged checkouts."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[2]


def configure_script():
    lines = (ROOT / '.github/workflows/release.yml').read_text().splitlines()
    start = next(i for i, line in enumerate(lines)
                 if line.strip() == 'const fs = require(\'node:fs\');')
    script = []
    for line in lines[start:]:
        if line.strip() and not line.startswith('            '):
            break
        script.append(line[12:])
    return '\n'.join(script)


class ReleaseBuildHookTests(unittest.TestCase):
    def configure(self, independent, platform='Linux'):
        with tempfile.TemporaryDirectory(prefix='noctua build ') as folder:
            root = Path(folder)
            app = root / 'app'
            app.mkdir()
            config = {'bundle': {'createUpdaterArtifacts': True}}
            (app / 'tauri.release.conf.json').write_text(json.dumps(config))
            if independent:
                (app / 'prepare-server.py').write_text('print("bundled server hook found")\n')
            env = dict(os.environ, RELEASE_PLATFORM=platform, NOCTUA_UPDATER_PUBLIC_KEY='dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q=')
            subprocess.run(['node', '-e', configure_script()], cwd=root, env=env, check=True)
            result = json.loads((app / 'tauri.release.conf.json').read_text())
            self.assertEqual(result['plugins']['updater']['pubkey'], env['NOCTUA_UPDATER_PUBLIC_KEY'])
            self.assertTrue(result['bundle']['createUpdaterArtifacts'])
            self.assertEqual(result['bundle']['targets'], {'macOS': ['app', 'dmg'], 'Windows': ['nsis'], 'Linux': ['appimage', 'deb']}[platform])
            if independent:
                hook = result['build']['beforeBuildCommand']
                self.assertEqual(Path(hook['cwd']).resolve(), app.resolve())
                # The same script must execute successfully from the configured cwd.
                output = subprocess.check_output(['python3', 'prepare-server.py'], cwd=hook['cwd'], text=True)
                self.assertIn('bundled server hook found', output)
            return result

    def test_independent_server_hook_uses_native_directory_with_spaces(self):
        self.configure(True)

    def test_legacy_tag_without_server_keeps_existing_build_behavior(self):
        self.assertNotIn('build', self.configure(False))

    def test_platform_bundle_selection(self):
        for platform in ['macOS', 'Windows', 'Linux']:
            self.configure(True, platform)

    def test_local_builds_select_only_retained_installers(self):
        base = json.loads((ROOT / 'app/tauri.conf.json').read_text())
        self.assertEqual(base['bundle']['targets'], [])
        for platform, targets in [('macos', ['dmg']), ('windows', ['nsis']),
                                  ('linux', ['appimage', 'deb'])]:
            config = json.loads((ROOT / f'app/tauri.{platform}.conf.json').read_text())
            self.assertEqual(config['bundle']['targets'], targets)
        release = json.loads((ROOT / 'app/tauri.release.conf.json').read_text())
        self.assertFalse(release['bundle']['createUpdaterArtifacts'])

    def test_local_hook_uses_native_cli_working_directory(self):
        hook = json.loads((ROOT / 'app/tauri.conf.json').read_text())['build']['beforeBuildCommand']
        self.assertEqual(hook, {'script': 'python3 prepare-server.py', 'cwd': '.'})
        self.assertTrue((ROOT / 'app' / hook['cwd'] / 'prepare-server.py').is_file())


if __name__ == '__main__':
    unittest.main()
