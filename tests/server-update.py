#!/usr/bin/env python3
"""Isolated update, task-drain, ownership, backup and failure regression. No real services."""
import concurrent.futures, hashlib, http.client, json, os, pathlib, shutil, subprocess, sys, tempfile, time, threading
repo=pathlib.Path(__file__).resolve().parent.parent
binary=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else repo/'target/debug/noctua').resolve()
candidate=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else repo/'target/debug/noctua-update-fixture').resolve()
assert candidate.is_file(),'Run python3 tests/build-update-fixture.py first'
with tempfile.TemporaryDirectory(prefix='noctua-update-test-') as tmp:
    root=pathlib.Path(tmp);data=root/'data';client=root/'client';service=root/'service'
    env={k:v for k,v in os.environ.items() if not k.startswith('NOCTUA_') and k!='ZOTERO_DATA_DIR'}
    env.update(NOCTUA_HOME=str(data),NOCTUA_CLIENT_HOME=str(client),NOCTUA_PROFILE_HOME=str(root/'profile'),NOCTUA_SERVICE_HOME=str(service),NOCTUA_PORT='0')
    agent=root/'fake-claude'
    agent.write_text('#!/usr/bin/env python3\nimport json,sys,time,pathlib,os\nassert os.environ.get("NOCTUA_S2_KEY")=="isolated-update-secret"\nsys.stdin.read()\npathlib.Path('+repr(str(root/'job-started'))+').touch()\ndeadline=time.monotonic()+180\nwhile not pathlib.Path('+repr(str(root/'job-release'))+').exists() and time.monotonic()<deadline:time.sleep(.05)\nprint(json.dumps({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Completed safely"}}}),flush=True)\nprint(json.dumps({"type":"result","session_id":"kept-job","result":"Completed safely","is_error":False}),flush=True)\npathlib.Path('+repr(str(root/'job-finished'))+').touch()\n')
    agent.chmod(0o700);env.update(NOCTUA_CLAUDE=str(agent),NOCTUA_ORIGINS='https://private.example',NOCTUA_S2_KEY='isolated-update-secret')
    def cli(*args,ok=True,executable=binary):
        result=subprocess.run([str(executable),*args],env=env,text=True,capture_output=True,timeout=90)
        assert (result.returncode==0)==ok,(args,result.stdout,result.stderr)
        return result
    old_hash=hashlib.sha256(binary.read_bytes()).hexdigest()
    old_stage=client/'servers'/('old-'+old_hash[:16])/('noctua.exe' if sys.platform=='win32' else 'noctua')
    old_stage.parent.mkdir(parents=True);shutil.copy2(binary,old_stage)
    port=None;auth={};editors=set();workers=[]
    def request(path,method='GET',body=None,headers=None,expected=200):
        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=15)
        h={**auth,**(headers or {})}
        if body is not None:h['Content-Type']='application/json'
        connection.request(method,path,json.dumps(body) if body is not None else None,h)
        response=connection.getresponse();payload=response.read();connection.close()
        assert response.status==expected,(path,response.status,payload)
        if expected>=400:return payload
        return json.loads(payload)
    def wait(predicate,timeout=60):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            try:
                value=predicate()
                if value:return value
            except (OSError,ValueError,AssertionError):pass
            time.sleep(.05)
        raise AssertionError('Condition timed out')
    def state():return json.loads((client/'server-update.json').read_text())
    def launch(target=candidate,ack=True,timeout=90,grace=1):
        old=state().get('id') if (client/'server-update.json').exists() else None
        proc=subprocess.Popen([str(binary),'update','--server',str(target),'--force','--grace-seconds',str(grace),'--timeout-seconds',str(timeout)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        workers.append(proc)
        if ack:
            notice=wait(lambda:(value if (value:=request('/api/server').get('maintenance')) and value['id']!=old else None))
            for editor in editors:
                try:request('/api/server/update/ack','POST',{'id':notice['id'],'client':editor,'saved':True})
                except AssertionError:pass # a previous process's sessions are no longer registered
        return proc
    try:
        initial=json.loads(cli('ensure',executable=old_stage).stdout);port=int(initial['url'].rsplit(':',1)[1]);auth={'Authorization':'Bearer '+(data/'server-token').read_text()}
        # A new desktop/service starts without the original shell's launch environment.
        for key in ['NOCTUA_CLAUDE','NOCTUA_ORIGINS','NOCTUA_S2_KEY']:env.pop(key)
        # Same OS user cannot run another data owner, even on a different port.
        other={**env,'NOCTUA_HOME':str(root/'other')}
        duplicate=subprocess.run([str(binary),'serve'],env=other,text=True,capture_output=True,timeout=10)
        assert duplicate.returncode and not (root/'other/server-format.json').exists()
        (data/'sentinel.txt').write_text('Research is preserved')
        (data/'notes/backups').mkdir(parents=True)
        (data/'notes/backups/report.txt').write_text('Nested user backup')
        (data/'notes/server.log').write_text('A user file, not a runtime log')
        record_path=data/'server.json';original_record=record_path.read_text()
        tampered=json.loads(original_record);tampered['executable']=str(root/'foreign-executable');record_path.write_text(json.dumps(tampered))
        refused=cli('update','--server',str(candidate),ok=False)
        assert 'record' in refused.stderr.lower() and request('/api/server')['instance_id']==initial['instance_id']
        record_path.write_text(original_record)
        request('/api/server',headers={'X-Noctua-Editor':'editor-one'});editors.add('editor-one')
        request('/api/server/update','POST',{'action':'begin','id':'remote'},expected=403)
        result={}
        # Chat responses are NDJSON, so consume without decoding as one JSON document.
        def chat():
            c=http.client.HTTPConnection('127.0.0.1',port,timeout=180);c.request('POST','/api/chat',json.dumps({'message':'Finish before upgrade','provider':'claude'}),{**auth,'Content-Type':'application/json'});r=c.getresponse();assert r.status==200;result['events']=[json.loads(line) for line in r.read().splitlines()];c.close()
        thread=threading.Thread(target=chat);thread.start();wait(lambda:(root/'job-started').exists())
        updating=launch();wait(lambda:state()['phase']=='draining')
        assert not (root/'job-finished').exists(),'fixture did not retain an active task'
        assert json.loads((data/'server.json').read_text())['instance_id']==initial['instance_id']
        request('/api/chat','POST',{'message':'Must not start'},expected=503)
        duplicate_update=cli('update','--server',str(candidate),'--force','--grace-seconds','0',ok=False)
        assert 'worker' in duplicate_update.stderr.lower()
        ensuring=subprocess.Popen([str(binary),'ensure'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE);workers.append(ensuring)
        (root/'job-release').touch()
        output,error=updating.communicate(timeout=90);assert updating.returncode==0,error
        upgraded=json.loads(output);port=int(upgraded['url'].rsplit(':',1)[1]);thread.join(timeout=10);assert not thread.is_alive()
        assert (root/'job-finished').exists() and any(e.get('type')=='done' for e in result['events'])
        chat_id=next(event['id'] for event in result['events'] if event['type']=='chat')
        assert 'Completed safely' in json.dumps(request('/api/chats/'+chat_id)), 'finished AI output was not persisted across the replacement'
        assert upgraded['version']!=initial['version'] and upgraded['server_id']==initial['server_id']
        assert upgraded['instance_id']!=initial['instance_id'] and upgraded['url']==initial['url']
        refused=cli('restart',ok=False)
        assert 'downgrade' in refused.stderr.lower() and request('/api/server')['instance_id']==upgraded['instance_id']
        output,error=ensuring.communicate(timeout=90);assert ensuring.returncode==0,error
        assert json.loads(output)['instance_id']==upgraded['instance_id']
        assert not old_stage.exists(),'previous staged executable was not cleaned after verification'
        assert request('/api/server',headers={'Origin':'https://private.example'})['server_id']==initial['server_id']
        assert not list(client.glob('server-launch-*.json')),'temporary credential handoff was not removed'
        assert 'isolated-update-secret' not in (client/'server-update.json').read_text()
        completed=state();backup=pathlib.Path(completed['backup']);assert (backup/'snapshot-complete.json').is_file()
        manifest=json.loads((backup/'snapshot-complete.json').read_text());assert manifest['origin']==initial['url'] and manifest['server_version']==initial['version']
        assert (backup/'sentinel.txt').read_text()=='Research is preserved' and (backup/'noctua-chats.sqlite').exists()
        assert (backup/'notes/backups/report.txt').read_text()=='Nested user backup'
        assert (backup/'notes/server.log').read_text()=='A user file, not a runtime log'
        assert (data/'sentinel.txt').read_text()=='Research is preserved'
        assert 'isolated-update-secret' not in (backup/'server-launch.json').read_text()
        # Repeating an upgrade is idempotent when an earlier retired file is already gone.
        repeated=launch();output,error=repeated.communicate(timeout=90);assert repeated.returncode==0,error
        upgraded=json.loads(output);port=int(upgraded['url'].rsplit(':',1)[1])
        assert state()['phase']=='complete' and not state()['cleanup_pending']
        # Failed editor saves leave the current server running and accepting work.
        request('/api/server',headers={'X-Noctua-Editor':'blocked-editor'});editors={'blocked-editor'}
        failed=launch(ack=False);notice=wait(lambda:request('/api/server').get('maintenance'))
        request('/api/server/update/ack','POST',{'id':notice['id'],'client':'blocked-editor','saved':False})
        _,error=failed.communicate(timeout=90);assert failed.returncode!=0 and 'editor' in error.lower()
        assert request('/api/server')['ready'] and request('/api/server')['maintenance'] is None
        assert request('/api/server')['instance_id']==upgraded['instance_id']
        # Invalid candidate metadata never stops the owner.
        bad=root/'bad-candidate';bad.write_text('#!/usr/bin/env python3\nimport json\nprint(json.dumps({"product":"noctua","api_version":999,"data_version":1,"version":"9.0.0"}))\n');bad.chmod(0o700)
        cli('update','--server',str(bad),ok=False)
        assert request('/api/server')['instance_id']==upgraded['instance_id']
        # An expired wait cancels maintenance, never the still-running AI child.
        (root/'job-started').unlink();(root/'job-finished').unlink();(root/'job-release').unlink()
        thread=threading.Thread(target=chat);thread.start();wait(lambda:(root/'job-started').exists())
        timed_out=launch(timeout=0);_,error=timed_out.communicate(timeout=90)
        assert timed_out.returncode!=0 and 'timed out' in error.lower()
        assert request('/api/server')['ready'] and not (root/'job-finished').exists()
        (root/'job-release').touch();thread.join(timeout=10);assert (root/'job-finished').exists()
        # A crashed controller cannot strand startup behind its reservation.
        interrupted=launch(ack=False,grace=30)
        notice=wait(lambda:request('/api/server').get('maintenance'))
        interrupted.terminate();interrupted.wait(timeout=10)
        time.sleep(6)
        assert json.loads(cli('update-status').stdout)['phase']=='interrupted'
        refused=cli('serve',ok=False)
        assert 'already running' in refused.stderr.lower() and not (client/'server-reservation.json').exists()
        request('/api/server/update','POST',{'id':notice['id'],'action':'cancel'},headers={'X-Noctua-Control':(data/'server-control').read_text()})
        assert request('/api/server')['ready']
        # Service replacement failures are real failures; old work/data are retained.
        if sys.platform in ['darwin','linux']:
            manager=root/'service-manager'
            manager.write_text('''#!/usr/bin/env python3
import json,pathlib,sys,os,subprocess
r=pathlib.Path(ROOT)
a=sys.argv[1:]
with (r/'service-calls').open('a') as f:f.write(' '.join(a)+'\\n')
if 'print-disabled' in a:print('app.noctua.server => false')
if 'is-enabled' in a:print('enabled')
if 'enable' in a and (r/'fail-refresh').exists():
    print('simulated service refresh failure',file=sys.stderr);sys.exit(1)
if any(action in a for action in ['kickstart','bootstrap','start']):
    registration=json.loads(next((r/'service').glob('*.registration.json')).read_text())
    environment={k:v for k,v in os.environ.items() if not k.startswith('NOCTUA_')}
    environment.update(NOCTUA_HOME=registration['data_dir'],NOCTUA_CLIENT_HOME=str(r/'client'),NOCTUA_SERVICE_HOME=str(r/'service'))
    with (r/'service-start.log').open('ab') as log:
        subprocess.Popen([registration['executable'],'serve'],env=environment,cwd=registration['data_dir'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
'''.replace('ROOT',repr(str(root))))
            manager.chmod(0o700);env['NOCTUA_SERVICE_MANAGER']=str(manager)
            cli('service','enable',executable=candidate)
            (root/'fail-refresh').touch()
            failure=launch();_,error=failure.communicate(timeout=90)
            assert failure.returncode!=0 and 'service' in error.lower()
            assert request('/api/server')['ready'] and state()['phase']=='failed'
            assert (data/'sentinel.txt').read_text()=='Research is preserved'
            (root/'fail-refresh').unlink()
            success=launch();output,error=success.communicate(timeout=90);assert success.returncode==0,error
            upgraded=json.loads(output);port=int(upgraded['url'].rsplit(':',1)[1]);editors=set()
            registration=json.loads(next(service.glob('*.registration.json')).read_text())
            assert pathlib.Path(registration['executable'])==pathlib.Path(upgraded['executable'])
            definition=next(p for p in service.iterdir() if p.suffix in ['.plist','.service','.xml'])
            assert 'NOCTUA_CLIENT_HOME' in definition.read_text()
            assert (root/'service-start.log').exists(),'replacement was not started by the registered service'
            assert request('/api/server',headers={'Origin':'https://private.example'})['ready']
            assert not list(client.glob('server-launch-*.json'))
            cli('service','disable',executable=candidate)
        # A verified candidate which cannot start retains the stopped snapshot and old executable.
        failing=root/'failing-candidate';failing.write_text('#!/usr/bin/env python3\nimport sys,json,pathlib,hashlib\nif sys.argv[1:]==["describe"]:\n print(json.dumps({"product":"noctua","api_version":1,"data_version":1,"version":"99.0.0","executable_hash":hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}))\nelse:sys.exit(42)\n');failing.chmod(0o700)
        failed=launch(failing);_,error=failed.communicate(timeout=90);assert failed.returncode!=0,error
        failure=state();assert failure['phase']=='failed' and pathlib.Path(failure['backup'],'snapshot-complete.json').exists()
        assert pathlib.Path(upgraded['executable']).exists(),'failed replacement removed the known previous binary'
        handoff=next(client.glob('server-launch-*.json'));assert handoff.stat().st_mode & 0o077==0
        assert 'isolated-update-secret' in handoff.read_text()
        # The prior real release may be restarted explicitly because the failing fixture never opened data.
        resumed=json.loads(cli('update','--server',str(candidate),'--grace-seconds','0').stdout);port=int(resumed['url'].rsplit(':',1)[1])
        assert resumed['server_id']==initial['server_id']
        assert state()['phase']=='complete','retry from a stopped failed replacement did not complete'
        assert not list(client.glob('server-launch-*.json'))
        cli('stop')
        # An older release cannot reopen data after the successful version change.
        old=cli('serve',ok=False);assert 'newer server' in old.stderr.lower()
        assert (data/'sentinel.txt').read_text()=='Research is preserved'
        print('PASS: real version replacement, task draining, editor acknowledgment, rejected work, concurrent ensure, one owner, backup, cleanup, crashed worker, service refresh success/failure, invalid candidates, startup failure and downgrade fencing')
    finally:
        (root/'job-release').touch()
        if 'thread' in locals():thread.join(timeout=10)
        for proc in workers:
            if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
        for attempt in range(20):
            try:
                stopped=subprocess.run([str(candidate),'stop'],env=env,capture_output=True,timeout=40)
                if stopped.returncode==0 or not (data/'server.json').exists():break
            except subprocess.TimeoutExpired:pass
            time.sleep(.1)
