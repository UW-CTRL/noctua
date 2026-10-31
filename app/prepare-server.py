#!/usr/bin/env python3
"""Bundle a verified prebuilt server, or build it locally when none was supplied."""
import hashlib
import os
from pathlib import Path
import shutil
import struct
import subprocess


def binary_targets(path):
    """Read executable headers without executing a potentially foreign binary."""
    with Path(path).open('rb') as source:
        header = source.read(4096)
        if header[:4] == b'\x7fELF' and header[4:6] == b'\x02\x01':
            arch = {62: 'x86_64', 183: 'aarch64'}.get(struct.unpack_from('<H', header, 18)[0])
            return {f'{arch}-unknown-linux-gnu'} if arch else set()
        if header[:4] == b'\xcf\xfa\xed\xfe':
            arch = {0x01000007: 'x86_64', 0x0100000C: 'aarch64'}.get(struct.unpack_from('<I', header, 4)[0])
            return {f'{arch}-apple-darwin'} if arch else set()
        if header[:4] in (b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'):
            count = struct.unpack_from('>I', header, 4)[0]
            stride = 32 if header[3] == 0xbf else 20
            arches = {struct.unpack_from('>I', header, 8 + i * stride)[0] for i in range(min(count, 16))}
            return {f'{name}-apple-darwin' for code, name in ((0x01000007, 'x86_64'), (0x0100000C, 'aarch64')) if code in arches}
        if header[:2] == b'MZ':
            offset = struct.unpack_from('<I', header, 0x3c)[0]
            source.seek(offset)
            pe = source.read(6)
            if pe[:4] == b'PE\0\0' and pe[4:] == b'\x64\x86':
                return {'x86_64-pc-windows-msvc'}
    return set()


def prepare(root, target, prebuilt=None, checksum=None):
    output = root / 'app' / 'binaries'
    output.mkdir(exist_ok=True)
    destination = output / ('noctua-server.exe' if 'windows' in target else 'noctua-server')
    if prebuilt:
        source = Path(prebuilt).resolve(strict=True)
        if not checksum or hashlib.sha256(source.read_bytes()).hexdigest() != checksum.lower():
            raise ValueError('NOCTUA_SERVER_SHA256 must match the prebuilt executable')
        expected = {'aarch64-apple-darwin', 'x86_64-apple-darwin'} if target == 'universal-apple-darwin' else {target}
        if not expected.issubset(binary_targets(source)):
            raise ValueError(f'Prebuilt server does not match desktop target {target}')
        shutil.copy2(source, destination)
        if os.name != 'nt':
            destination.chmod(0o755)
        return destination

    def build(triple):
        subprocess.run(['cargo', 'build', '--locked', '--release', '-p', 'noctua', '--target', triple], cwd=root, check=True)
        build_root = Path(os.environ.get('CARGO_TARGET_DIR', root / 'target'))
        if not build_root.is_absolute():
            build_root = root / build_root
        return build_root / triple / 'release' / ('noctua.exe' if 'windows' in triple else 'noctua')

    if target == 'universal-apple-darwin':
        binaries = [build(t) for t in ['aarch64-apple-darwin', 'x86_64-apple-darwin']]
        subprocess.run(['lipo', '-create', *map(str, binaries), '-output', str(destination)], check=True)
    else:
        shutil.copy2(build(target), destination)
    return destination


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    target = os.environ.get('TAURI_ENV_TARGET_TRIPLE') or os.environ.get('CARGO_BUILD_TARGET')
    if not target:
        target = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ', 1)[1].splitlines()[0]
    prepare(root, target, os.environ.get('NOCTUA_SERVER_BINARY'), os.environ.get('NOCTUA_SERVER_SHA256'))
