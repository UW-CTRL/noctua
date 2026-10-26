#!/usr/bin/env python3
"""Fetch the pinned paper compiler into target/tectonic (no system installation)."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

VERSION = '0.17.0'
ASSETS = {
    'aarch64-apple-darwin': 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667',
    'x86_64-apple-darwin': '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80',
    'x86_64-pc-windows-msvc': 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f',
    'x86_64-unknown-linux-musl': '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7',
    'aarch64-unknown-linux-musl': 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8',
}

def install(target, dest):
    windows = 'windows' in target
    suffix = 'zip' if windows else 'tar.gz'
    executable = 'tectonic.exe' if windows else 'tectonic'
    path = dest / target / executable
    stamp = path.parent / 'version.json'
    if path.exists() and stamp.exists() and json.loads(stamp.read_text()).get('sha256') == ASSETS[target]:
        print(f'Compiler ready: {path}')
        return
    url = f'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40{VERSION}/tectonic-{VERSION}-{target}.{suffix}'
    with tempfile.TemporaryDirectory() as directory:
        archive = Path(directory) / ('compiler.' + suffix)
        subprocess.run(['curl', '--fail', '--location', '--retry', '3', '--max-time', '300', url, '-o', str(archive)], check=True)
        data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != ASSETS[target]:
            raise RuntimeError('Compiler archive checksum mismatch')
        if windows:
            with zipfile.ZipFile(io.BytesIO(data)) as bundle:
                candidates = [n for n in bundle.namelist() if Path(n).name == executable]
                if len(candidates) != 1:
                    raise RuntimeError('Unexpected compiler archive')
                binary = bundle.read(candidates[0])
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as bundle:
                candidates = [m for m in bundle.getmembers() if Path(m.name).name == executable and m.isfile()]
                if len(candidates) != 1:
                    raise RuntimeError('Unexpected compiler archive')
                binary = bundle.extractfile(candidates[0]).read()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.download')
        temporary.write_bytes(binary)
        temporary.chmod(0o755)
        os.replace(temporary, path)
        stamp.write_text(json.dumps({'version': VERSION, 'sha256': ASSETS[target]}) + '\n')
        print(f'Installed {path}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--universal', action='store_true', help='Include both macOS architectures')
    args = parser.parse_args()
    machine = 'aarch64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x86_64'
    system = platform.system()
    targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'] if args.universal else [machine + {'Darwin': '-apple-darwin', 'Linux': '-unknown-linux-musl', 'Windows': '-pc-windows-msvc'}[system]]
    root = Path(__file__).resolve().parents[1]
    notices = root / 'target' / 'tectonic' / 'notices'
    shutil.copytree(root / 'third-party' / 'tectonic', notices, dirs_exist_ok=True)
    for target in targets:
        install(target, root / 'target' / 'tectonic')
