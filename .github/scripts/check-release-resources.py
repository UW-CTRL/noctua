"""Fail a release build if its installer omits essential runtime resources."""
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def validate(names):
    paths = [name.replace('\\', '/').lower() for name in names]
    required = {
        'server': r'(^|/)binaries/noctua-server(?:\.exe)?$',
        'Tectonic': r'(^|/)tectonic/.*/tectonic(?:\.exe)?$',
        'pdfLaTeX': r'(^|/)texlive/.*/(?:pdftex|pdflatex)(?:\.exe)?$',
        'BibTeX': r'(^|/)texlive/.*/bibtex(?:\.exe)?$',
        'TeX packages': r'(^|/)texlive/texmf-dist/tex/.+',
        'compiler notices': r'(^|/)tectonic/notices/.+',
    }
    missing = [label for label, pattern in required.items()
               if not any(re.search(pattern, path) for path in paths)]
    if missing:
        raise ValueError('Installer is missing: ' + ', '.join(missing))


def check(root, platform=sys.platform):
    if platform == 'darwin':
        packages = list(root.glob('target/**/release/bundle/macos/*.app.tar.gz'))
    elif platform == 'win32':
        packages = list(root.glob('target/**/release/bundle/nsis/*-setup.exe'))
    else:
        packages = list(root.glob('target/**/release/bundle/deb/*.deb'))
    if not packages:
        raise ValueError('No packaged installer found for resource verification.')
    for package in packages:
        if platform == 'darwin':
            with tarfile.open(package) as archive:
                names = [entry.name for entry in archive if entry.isfile() or entry.issym()]
        elif platform == 'win32':
            output = subprocess.check_output(['7z', 'l', '-slt', str(package)], text=True)
            names = [line.removeprefix('Path = ') for line in output.splitlines()
                     if line.startswith('Path = ')]
        else:
            output = subprocess.check_output(['dpkg-deb', '--contents', str(package)], text=True)
            names = [line.split(maxsplit=5)[-1].split(' -> ')[0]
                     for line in output.splitlines() if line and line[0] != 'd']
        validate(names)
        print(f'Packaged runtime resources verified: {package}')


if __name__ == '__main__':
    try:
        check(Path.cwd())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
