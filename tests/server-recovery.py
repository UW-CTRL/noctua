#!/usr/bin/env python3
"""Previous-server discovery/recovery using temporary profiles only; never kill a PID."""
import contextlib, json, os, pathlib, subprocess, sys, tempfile
binary=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'target/debug/noctua').resolve()

@contextlib.contextmanager
def owned(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('w+b') as lock:
        lock.write(b'\0');lock.flush();lock.seek(0)
        if sys.platform=='win32':
            import msvcrt
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:yield
        finally:
            if sys.platform=='win32':
                lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)

with tempfile.TemporaryDirectory(prefix='noctua-recovery-') as folder:
    root=pathlib.Path(folder);data=root/'requested data';client=root/'client';data.mkdir()
    env={k:v for k,v in os.environ.items() if not k.startswith('NOCTUA_') and k!='ZOTERO_DATA_DIR'}
    env.update(NOCTUA_HOME=str(data),NOCTUA_CLIENT_HOME=str(client),NOCTUA_PROFILE_HOME=str(root/'profile'),NOCTUA_SERVICE_HOME=str(root/'services'),NOCTUA_PORT='0')
    def cli(*args,ok=True,home=data):
        p=subprocess.run([str(binary),*args],env={**env,'NOCTUA_HOME':str(home)},capture_output=True,text=True,timeout=60)
        assert (p.returncode==0)==ok,(args,p.stdout,p.stderr)
        return p
    try:
        sentinel=data/'saved-work.txt';sentinel.write_text('Keep all research')
        # A pre-protocol server has no identity or stop endpoint, only its old lease.
        legacy=data/'storage-location.lock'
        with owned(legacy):
            failed=cli('ensure',ok=False)
            assert 'older app/server' in failed.stderr and 'Ctrl+C' in failed.stderr and 'Do not delete lock files' in failed.stderr
            assert not (data/'server-format.json').exists() and legacy.exists()
            assert sentinel.read_text()=='Keep all research'
        # Retry after an explicitly stopped legacy owner starts the normal new server.
        first=json.loads(cli('ensure').stdout);assert pathlib.Path(first['data_dir'])==data.resolve()
        assert sentinel.read_text()=='Keep all research';cli('stop')
        # A healthy server for another data folder must not be silently adopted/upgraded.
        other=root/'other data';other.mkdir();(other/'other-work.txt').write_text('Keep other library')
        owner=json.loads(cli('ensure',home=other).stdout)
        refused=cli('ensure',ok=False)
        assert 'different data folder' in refused.stderr and str(other.resolve()) in refused.stderr
        assert 'Safe-stop command:' in refused.stderr and 'NOCTUA_HOME=' in refused.stderr
        unchanged=json.loads(cli('status',home=other).stdout)
        assert unchanged['instance_id']==owner['instance_id'] and unchanged['server_id']==owner['server_id']
        assert (other/'other-work.txt').read_text()=='Keep other library'
        cli('stop',home=other)
        restored=json.loads(cli('ensure').stdout);assert restored['server_id']==first['server_id']
        cli('stop')
        print('PASS: live legacy lease detection, actionable shutdown advice, no data conversion under old ownership, explicit retry, authenticated other-folder discovery, safe-stop guidance and no automatic data switch/shutdown')
    finally:
        for home in [data,root/'other data']:
            subprocess.run([str(binary),'stop'],env={**env,'NOCTUA_HOME':str(home)},capture_output=True,timeout=40)
