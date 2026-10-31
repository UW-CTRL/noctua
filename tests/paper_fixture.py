"""One real resource-staging regression shared by the paper API scenarios."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def isolated_environment(root):
    env = {key: value for key, value in os.environ.items() if not key.startswith('NOCTUA_')}
    env.update(NOCTUA_HOME=str(root / 'data'), NOCTUA_CLIENT_HOME=str(root / 'client'),
               NOCTUA_PROFILE_HOME=str(root / 'profile'), NOCTUA_SERVICE_HOME=str(root / 'services'),
               NOCTUA_PORT='0', PATH='')
    return env


def link_or_copy(source, destination):
    """Avoid a redundant data copy; production staging still makes a real copy."""
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)
    return destination


def clone_distribution(source, destination):
    shutil.copytree(source, destination, symlinks=True, copy_function=link_or_copy)


def native_path(value):
    # Rust canonical paths use the Windows verbatim prefix; normalize it only
    # for comparing fixture ownership, without changing production server paths.
    value = str(value)
    if value.startswith('\\\\?\\UNC\\'):
        value = '\\\\' + value[8:]
    elif value.startswith('\\\\?\\'):
        value = value[4:]
    return Path(value)


@contextmanager
def staged_server(repo):
    # Use the workspace volume so Windows can hard-link the disposable source
    # bundle. No permissions or contents of the original distributions change.
    with tempfile.TemporaryDirectory(prefix='pr-', dir=repo / 'target') as temporary:
        root = Path(temporary)
        bundle = root / 'bundle'
        bundle.mkdir()
        name = 'noctua.exe' if os.name == 'nt' else 'noctua'
        binary = bundle / name
        shutil.copy2(repo / 'target/debug' / name, binary)
        for distribution in ('tectonic', 'texlive'):
            print(f'Staging fixture: preparing {distribution} source tree', flush=True)
            clone_distribution(repo / 'target' / distribution, bundle / 'paper-resources' / distribution)
        env = isolated_environment(root)
        stopped = False
        try:
            print('Staging fixture: copying both distributions through production ensure', flush=True)
            result = subprocess.run([str(binary), 'ensure'], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=180)
            assert result.returncode == 0, result.stderr
            record = json.loads(result.stdout)
            staged = native_path(record['executable'])
            assert staged != binary and staged.is_relative_to(root / 'client/servers'), record
            result = subprocess.run([str(staged), 'stop'], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=60)
            assert result.returncode == 0, result.stderr
            stopped = True
            shutil.rmtree(bundle)
            for distribution in ('tectonic', 'texlive'):
                resources = staged.parent / 'paper-resources' / distribution
                assert resources.is_dir() and not resources.is_symlink(), resources
                original = next(path for path in (repo / 'target' / distribution).rglob('*')
                                if path.is_file() and not path.is_symlink())
                copied = resources / original.relative_to(repo / 'target' / distribution)
                assert not original.samefile(copied), 'Production staging must make independent files'
            print('PASS: production-staged server and both compiler trees survive source-bundle removal', flush=True)
            yield staged
        finally:
            if not stopped and (root / 'data/server.json').exists():
                subprocess.run([str(binary), 'stop'], cwd=root, env=env,
                               capture_output=True, text=True, timeout=60)
