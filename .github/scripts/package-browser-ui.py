"""Package browser files under the Desktop version, without compiling the server."""
from pathlib import Path
import hashlib
import json
import re
import tarfile


def package(root, version):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('Expected a stable Desktop version')
    web = root / 'web'
    for name in ['index.html', 'shell.html', 'app.js', 'connection.js', 'pdf.js']:
        if not (web / name).is_file():
            raise ValueError(f'Missing browser UI file: {name}')
    output = root / 'browser-dist'
    output.mkdir(exist_ok=True)
    manifest = output / 'noctua-ui.json'
    manifest.write_text(json.dumps({'desktop_version': version, 'api_versions': [1, 2], 'data_version': 1}) + '\n')
    archive = output / f'Noctua_{version}_browser-ui.tar.gz'
    files = [(path, path.relative_to(web).as_posix()) for path in sorted(web.rglob('*')) if path.is_file()]
    files += [(root / f'app/icons/icon-{name}.svg', f'app-icons/{name}.svg') for name in ['dark', 'light']]
    files.append((manifest, 'noctua-ui.json'))
    with tarfile.open(archive, 'w:gz') as bundle:
        for path, name in files:
            if path.is_symlink():
                raise ValueError('Browser UI archives cannot contain symlinks')
            bundle.add(path, arcname=name, recursive=False)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + '.sha256').write_text(f'{digest}  {archive.name}\n')
    manifest.unlink()
    return archive


if __name__ == '__main__':
    import os
    package(Path(__file__).resolve().parents[2], os.environ['RELEASE_TAG'].removeprefix('v'))
