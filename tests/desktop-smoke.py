#!/usr/bin/env python3
"""macOS native WebView smoke; isolated data only, no resident service registration."""
import json, os, pathlib, signal, subprocess, sys, tempfile, time, uuid
if sys.platform!='darwin':
    raise SystemExit('This native smoke is verified on macOS only')
repo=pathlib.Path(__file__).resolve().parent.parent
server=repo/'target/debug/noctua';desktop=repo/'target/debug/noctua-app'
with tempfile.TemporaryDirectory(prefix='noctua-desktop-smoke-') as tmp:
    root=pathlib.Path(tmp);client=root/'client';client.mkdir()
    config=client/'connection.json';config.write_text(json.dumps({'mode':'local','address':'','server_id':''}))
    clean_env={key:value for key,value in os.environ.items() if not key.startswith('NOCTUA_') and key!='ZOTERO_DATA_DIR'}
    env={**clean_env,'NOCTUA_TEST_INSTANCE':uuid.uuid4().hex,'NOCTUA_HOME':str(root/'data'),'NOCTUA_CLIENT_HOME':str(client),'NOCTUA_SERVICE_HOME':str(root/'services'),'NOCTUA_CLAUDE':'/usr/bin/false','NOCTUA_CODEX':'/usr/bin/false'}
    with (root/'desktop.log').open('w') as log:
        app=subprocess.Popen([str(desktop)],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        try:
            deadline=time.monotonic()+45
            while time.monotonic()<deadline:
                if app.poll() is not None: raise AssertionError('Desktop exited before connecting: '+(root/'desktop.log').read_text())
                value=json.loads(config.read_text())
                if value['server_id']:break
                time.sleep(.1)
            else:raise AssertionError('WebView authentication/readiness timed out: '+(root/'desktop.log').read_text())
            # Preferences are saved only after a fetch in the real WebView verifies identity.
            before=json.loads(subprocess.check_output([str(server),'status'],env=env,text=True))
            assert value['server_id']==before['server_id']
            appearance=client/'appearance.json'
            deadline=time.monotonic()+10
            while not appearance.exists() and time.monotonic()<deadline:time.sleep(.1)
            assert appearance.exists(), 'Native shell did not persist offline connection-screen appearance'
            saved_appearance=json.loads(appearance.read_text())
            assert saved_appearance['theme'] in ['system','light','dark']
            assert saved_appearance['font_id']=='system' and saved_appearance['font_size']==14
            app.terminate();app.wait(timeout=10)
            after=json.loads(subprocess.check_output([str(server),'status'],env=env,text=True))
            assert after['instance_id']==before['instance_id']
            print('PASS: native local screen, WebView authentication/readiness, saved connection/appearance, detached server survives desktop exit')
        finally:
            if app.poll() is None:app.terminate();app.wait(timeout=10)
            for attempt in range(20):
                result=subprocess.run([str(server),'stop'],env=env,capture_output=True,timeout=40)
                if result.returncode==0:break
                if not (root/'data/server.json').exists():break
                time.sleep(.1)
