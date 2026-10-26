#!/usr/bin/env python3
"""Prepare Noctua's relocatable pdfLaTeX/BibTeX distribution, without system installation."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

VERSION = '2026.10'
REPOSITORY = 'https://texlive.info/tlnet-archive/2026/10/01/tlnet'
# Official TinyTeX release digests; both Mac architectures share universal binaries.
ASSETS = {
    'Darwin': ('TinyTeX-darwin-v2026.10.tar.xz', '9962e445b56f06feb2c28f73561e523e89d550e98abf910ba60b0ffb3856921f'),
    'Linux-x86_64': ('TinyTeX-linux-x86_64-v2026.10.tar.xz', '54fec1c79ab437d2d52e2f918bdb738c85779d654a93e62cc44f022e227692b5'),
    'Linux-aarch64': ('TinyTeX-linux-arm64-v2026.10.tar.xz', 'e4caa195211d4ae8b557a52752c850f63027450065ed7db3d9350ba63e0e1aac'),
    'Windows': ('TinyTeX-v2026.10.zip', 'dc1d6e63b21af62130ede1dcc4113bffdc184544690a23e3f489d75340f4ff61'),
}
# TeX Live package metadata does not declare every runtime LaTeX dependency.
PACKAGES = ['jmlr', 'algorithm2e', 'ifoddpage', 'relsize', 'endfloat', 'tocbibind', 'synctex']

def prepare():
    root = Path(__file__).resolve().parents[1]
    system = platform.system()
    arch = 'aarch64' if platform.machine().lower() in ('aarch64', 'arm64') else 'x86_64'
    asset, digest = ASSETS[system if system != 'Linux' else system+'-'+arch]
    dest = root/'target/texlive'
    stamp = {'version':VERSION, 'sha256':digest, 'repository':REPOSITORY, 'packages':PACKAGES, 'layout':2}
    if (dest/'noctua-version.json').exists() and json.loads((dest/'noctua-version.json').read_text()) == stamp:
        print(f'pdfLaTeX ready: {dest}')
        return
    cache = root/'target/texlive-download'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache/asset
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
        subprocess.run(['curl','--fail','--location','--retry','3','--max-time','600',
                        f'https://github.com/rstudio/tinytex-releases/releases/download/v{VERSION}/{asset}',
                        '-o',str(archive)], check=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
        raise RuntimeError('TinyTeX archive checksum mismatch')
    with tempfile.TemporaryDirectory(dir=root/'target', prefix='texlive-prepare-') as temp:
        stage = Path(temp)
        if system == 'Windows':
            with zipfile.ZipFile(archive) as bundle:
                for name in bundle.namelist():
                    if not (stage/name).resolve().is_relative_to(stage.resolve()):
                        raise RuntimeError('Unsafe archive path')
                bundle.extractall(stage)
        else:
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    path = stage/member.name
                    if not path.resolve().is_relative_to(stage.resolve()):
                        raise RuntimeError('Unsafe archive path')
                    if member.issym() and not (path.parent/member.linkname).resolve().is_relative_to(stage.resolve()):
                        raise RuntimeError('Unsafe archive link')
                # The archive is pinned and validated above; older Python lacks filters.
                bundle.extractall(stage, **({'filter':'data'} if hasattr(tarfile,'data_filter') else {}))
        trees = [p for p in stage.iterdir() if (p/'texmf-dist').is_dir()]
        if len(trees) != 1:
            raise RuntimeError('Unexpected TinyTeX archive layout')
        tree = trees[0]
        bin_dir = next((tree/'bin').iterdir())
        # Install template dependencies from a fixed-date repository, never the
        # rolling TeX Live repository. No global PATH/registry changes are made.
        if system == 'Windows':
            perl = tree/'tlpkg/tlperl/bin/perl.exe'
            command = [str(perl),str(tree/'texmf-dist/scripts/texlive/tlmgr.pl')]
        else:
            command = [str(bin_dir/'tlmgr')]
        env = dict(os.environ)
        env['PATH'] = str(bin_dir)+os.pathsep+env.get('PATH','')
        subprocess.run(command+['--repository',REPOSITORY,'install']+PACKAGES, env=env, check=True)
        # Materialize just the compiler programs we use. This avoids symlink
        # handling differences across app installers and unnecessary engines.
        keep = {'pdflatex','pdftex','bibtex','kpsewhich','synctex'}
        programs = {}
        for path in bin_dir.iterdir():
            if path.stem in keep or path.suffix.lower() in ('.dll','.dylib','.so'):
                programs[path.name] = (path.read_bytes(),path.stat().st_mode)
        shutil.rmtree(bin_dir)
        bin_dir.mkdir()
        for name,(data,mode) in programs.items():
            path = bin_dir/name;path.write_bytes(data);path.chmod(mode)
        for name in ('pdflatex','bibtex','synctex'):
            if not (bin_dir/(name+('.exe' if system=='Windows' else ''))).exists():
                raise RuntimeError(f'Compiler missing from archive: {name}')
        shutil.copytree(root/'third-party/texlive', tree/'noctua-notices')
        (tree/'noctua-version.json').write_text(json.dumps(stamp,indent=2)+'\n')
        if dest.exists():shutil.rmtree(dest)
        shutil.move(str(tree),dest)
    print(f'Prepared bundled pdfLaTeX: {dest}')

if __name__ == '__main__':
    prepare()
