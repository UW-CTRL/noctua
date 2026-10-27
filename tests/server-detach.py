#!/usr/bin/env python3
"""Captured ensure must close its pipes while its isolated server remains alive."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
binary = ROOT/'target/debug'/('noctua.exe' if os.name == 'nt' else 'noctua')
with tempfile.TemporaryDirectory(prefix='noctua-detach-test-') as temporary:
    root = Path(temporary)
    env = {k: v for k, v in os.environ.items() if not k.startswith('NOCTUA_')}
    env.update(NOCTUA_HOME=str(root/'data'), NOCTUA_CLIENT_HOME=str(root/'client'),
               NOCTUA_PROFILE_HOME=str(root/'profile'), NOCTUA_SERVICE_HOME=str(root/'services'),
               NOCTUA_PORT='0')
    process = subprocess.Popen([str(binary), 'ensure'], cwd=root, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        process.wait(timeout=90)
        try:
            output, error = process.communicate(timeout=10)
        except subprocess.TimeoutExpired as failure:
            raise AssertionError('Detached server retains the exited ensure process output pipes') from failure
        assert process.returncode == 0, error
        owner = json.loads(output)
        status = subprocess.run([str(binary), 'status'], cwd=root, env=env,
                                capture_output=True, text=True, timeout=30)
        assert status.returncode == 0, status.stderr
        assert json.loads(status.stdout)['instance_id'] == owner['instance_id']
        print('PASS: captured ensure exits and closes both pipes while the detached owner remains ready')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        # Release any inherited pipe before joining Python's Windows reader threads.
        subprocess.run([str(binary), 'stop'], cwd=root, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=40)
        process.communicate(timeout=10)
