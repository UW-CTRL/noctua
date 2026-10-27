#!/usr/bin/env python3
"""Build the headless server bundled with the desktop app (including universal macOS)."""
import os, pathlib, platform, shutil, subprocess
root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'app' / 'binaries'
out.mkdir(exist_ok=True)
target = os.environ.get('TAURI_ENV_TARGET_TRIPLE') or os.environ.get('CARGO_BUILD_TARGET')
if not target:
    target = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ', 1)[1].splitlines()[0]
def build(triple):
    subprocess.run(['cargo', 'build', '--locked', '--release', '-p', 'noctua', '--target', triple], cwd=root, check=True)
    return root / 'target' / triple / 'release' / ('noctua.exe' if 'windows' in triple else 'noctua')
if target == 'universal-apple-darwin':
    binaries = [build(t) for t in ['aarch64-apple-darwin', 'x86_64-apple-darwin']]
    subprocess.run(['lipo', '-create', *map(str, binaries), '-output', str(out / 'noctua-server')], check=True)
else:
    shutil.copy2(build(target), out / ('noctua-server.exe' if 'windows' in target else 'noctua-server'))
