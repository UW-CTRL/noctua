"""Fail a release build if its installer omits essential runtime resources."""
from pathlib import Path
import re
import os
import tarfile
import subprocess
import sys
import tempfile


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
    if os.environ.get('NOCTUA_REQUIRE_BROWSER_UI') == 'true':
        required['browser UI'] = r'(^|/)ui/index\.html$'
    missing = [label for label, pattern in required.items()
               if not any(re.search(pattern, path) for path in paths)]
    if missing:
        raise ValueError('Installer is missing: ' + ', '.join(missing))


def check_macos_updater(root):
    archives = list(root.glob('target/**/release/bundle/macos/*.app.tar.gz'))
    if not archives:
        raise ValueError('Signed macOS updater archive is required.')
    for archive in archives:
        signature = archive.with_name(archive.name + '.sig')
        if not signature.is_file() or not signature.read_text().strip():
            raise ValueError('macOS updater signature is required.')
        with tarfile.open(archive) as package:
            validate(package.getnames())


def check(root, platform=sys.platform):
    if platform == 'darwin':
        if os.environ.get('NOCTUA_REQUIRE_MACOS_UPDATER') == 'true':
            check_macos_updater(root)
        packages = list(root.glob('target/**/release/bundle/dmg/*.dmg'))
    elif platform == 'win32':
        packages = list(root.glob('target/**/release/bundle/nsis/*-setup.exe'))
    else:
        packages = list(root.glob('target/**/release/bundle/deb/*.deb'))
        images = list(root.glob('target/**/release/bundle/appimage/*.AppImage'))
        if not packages or not images:
            raise ValueError('Both DEB and AppImage are required for resource verification.')
        packages += images
    if not packages:
        raise ValueError('No packaged installer found for resource verification.')
    for package in packages:
        if platform == 'darwin':
            with tempfile.TemporaryDirectory(prefix='noctua-dmg-') as mount:
                subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse',
                                '-mountpoint', mount, str(package)], check=True)
                try:
                    names = [str(path.relative_to(mount)) for path in Path(mount).rglob('*')
                             if path.is_file() or path.is_symlink()]
                    validate(names)
                finally:
                    subprocess.run(['hdiutil', 'detach', mount], check=True)
        elif platform == 'win32':
            output = subprocess.check_output(['7z', 'l', '-slt', str(package)], text=True)
            names = [line.removeprefix('Path = ') for line in output.splitlines()
                     if line.startswith('Path = ')]
        elif package.suffix == '.AppImage':
            with tempfile.TemporaryDirectory(prefix='noctua-appimage-') as folder:
                subprocess.run([str(package.resolve()), '--appimage-extract'],
                               cwd=folder, check=True, stdout=subprocess.DEVNULL)
                names = [str(path.relative_to(folder)) for path in Path(folder).rglob('*')
                         if path.is_file() or path.is_symlink()]
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
