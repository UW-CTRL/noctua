#!/usr/bin/env python3
"""Actual macOS app upgrade worker smoke; unique app ID, temporary data, no services."""
import hashlib,http.client,json,os,pathlib,shutil,subprocess,sys,tempfile,time,uuid
assert sys.platform=='darwin','Native update smoke is verified on macOS only'
repo=pathlib.Path(__file__).resolve().parent.parent
server=repo/'target/debug/noctua';previous=repo/'target/debug/noctua-previous-fixture';desktop=repo/'target/debug/noctua-app'
assert previous.is_file(),'Run python3 tests/build-update-fixture.py --previous first'
with tempfile.TemporaryDirectory(prefix='noctua-desktop-update-') as tmp:
    root=pathlib.Path(tmp);client=root/'client';client.mkdir()
    env={k:v for k,v in os.environ.items() if not k.startswith('NOCTUA_') and k!='ZOTERO_DATA_DIR'}
    env.update(NOCTUA_TEST_INSTANCE=uuid.uuid4().hex,NOCTUA_HOME=str(root/'data'),NOCTUA_CLIENT_HOME=str(client),NOCTUA_SERVICE_HOME=str(root/'services'),NOCTUA_PORT='0',NOCTUA_CLAUDE='/usr/bin/false',NOCTUA_CODEX='/usr/bin/false')
    digest=hashlib.sha256(previous.read_bytes()).hexdigest();old=client/'servers'/('previous-'+digest[:16])/'noctua';old.parent.mkdir(parents=True);shutil.copy2(previous,old)
    initial=json.loads(subprocess.check_output([str(old),'ensure'],env=env,text=True));old=pathlib.Path(initial['executable'])
    # The old desktop closes during installation; its presence lease must expire
    # during the maintenance notice instead of blocking every first upgrade.
    connection=http.client.HTTPConnection('127.0.0.1',int(initial['url'].rsplit(':',1)[1]))
    connection.request('GET','/api/server',headers={'Authorization':'Bearer '+(root/'data/server-token').read_text(),'X-Noctua-Editor':'exiting-desktop'})
    assert connection.getresponse().status==200;connection.close()
    config=client/'connection.json';config.write_text(json.dumps({'mode':'local','address':'','server_id':''}))
    current=json.loads(subprocess.check_output([str(server),'describe'],env=env,text=True))
    log=(root/'desktop.log').open('w');app=None
    def wait(test,timeout=70):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                result=test()
                if result:return result
            except (OSError,ValueError,subprocess.CalledProcessError):pass
            time.sleep(.1)
        raise AssertionError('Native update timed out: '+(root/'desktop.log').read_text())
    def status():
        proc=subprocess.run([str(server),'status'],env=env,text=True,capture_output=True,timeout=10)
        return json.loads(proc.stdout) if proc.returncode==0 else {}
    try:
        app=subprocess.Popen([str(desktop)],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        wait(lambda:(p:=client/'server-update.json').exists() and json.loads(p.read_text())['phase']=='announcing',90)
        app.terminate();app.wait(timeout=10)
        upgraded=wait(lambda:(value if (value:=status()).get('version')==current['version'] else None))
        wait(lambda:json.loads((client/'server-update.json').read_text())['phase']=='complete')
        assert upgraded['server_id']==initial['server_id'] and upgraded['instance_id']!=initial['instance_id']
        assert upgraded['executable_hash']==current['executable_hash'] and not old.exists()
        # Reopening authenticates the actual WebView to the replacement and reuses it.
        app=subprocess.Popen([str(desktop)],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        wait(lambda:json.loads(config.read_text())['server_id']==initial['server_id'],35)
        assert status()['instance_id']==upgraded['instance_id']
        print('PASS: native automatic release update, detached worker survives app exit, previous executable cleanup, WebView reauthentication and one replacement owner')
    finally:
        if app and app.poll() is None:app.terminate();app.wait(timeout=10)
        log.close()
        for attempt in range(30):
            stopped=subprocess.run([str(server),'stop'],env=env,capture_output=True,timeout=40)
            if stopped.returncode==0:break
            time.sleep(.1)
