#!/usr/bin/env python3
"""Isolated lifecycle/auth regression. Never reads a user's data or service registration."""
import concurrent.futures, http.client, json, os, pathlib, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error
binary = pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'target/debug/noctua').resolve()
with tempfile.TemporaryDirectory(prefix='noctua-server-test-') as tmp:
    root=pathlib.Path(tmp); data=root/'data'; client=root/'client'; service=root/'service'
    clean_env={key:value for key,value in os.environ.items() if not key.startswith('NOCTUA_') and key!='ZOTERO_DATA_DIR'}
    env={**clean_env,'NOCTUA_HOME':str(data),'NOCTUA_CLIENT_HOME':str(client),'NOCTUA_SERVICE_HOME':str(service),'NOCTUA_PORT':'0','NOCTUA_ORIGINS':'https://private.example.ts.net'}
    def cli(*args,ok=True):
        p=subprocess.run([str(binary),*args],env=env,text=True,capture_output=True,timeout=40)
        if ok: assert p.returncode==0,(args,p.stderr)
        else: assert p.returncode!=0,(args,p.stdout)
        return p
    def request(path,method='GET',headers=None,body=None,expected=200):
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
        c.request(method,path,body,headers or {});r=c.getresponse();b=r.read();h=dict(r.getheaders());c.close()
        assert r.status==expected,(path,r.status,b)
        return b,h
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            values=list(pool.map(lambda _:json.loads(cli('ensure').stdout),range(6)))
        first=values[0];port=int(first['url'].rsplit(':',1)[1]);secret=(data/'server-token').read_text();auth={'Authorization':'Bearer '+secret}
        assert len({v['instance_id'] for v in values})==1
        assert not service.exists(), 'ensure installed a service'
        assert secret not in json.dumps(values)
        assert cli('status').returncode==0 # all ensure parents have already exited
        request('/api/server',expected=401)
        for path,content_type in [('/ui.css','text/css'),('/connection.css','text/css'),('/appearance.js','text/javascript'),('/fonts.js','text/javascript')]:
            content,headers=request(path)
            assert headers['content-type'].startswith(content_type),(path,headers)
            assert b'<!doctype html>' not in content.lower(), 'login assets returned the sign-in page'
            request(path,headers={'Host':'attacker.example'},expected=403)
            request(path,headers={'Origin':'https://attacker.example'},expected=403)
        request('/api/server',headers={**auth,'Host':'attacker.example'},expected=403)
        request('/api/server',headers={**auth,'Origin':'https://attacker.example'},expected=403)
        request('/api/server',headers={**auth,'Host':'private.example.ts.net','Origin':'https://private.example.ts.net'})
        request('/api/server',headers={'Authorization':'Bearer wrong'},expected=401)
        request('/api/server/stop','POST',auth,expected=403) # API token cannot manage local process
        body,headers=request('/auth/login','POST',{**auth,'Origin':first['url']})
        cookie=headers['set-cookie'].split(';')[0]
        request('/api/server',headers={'Cookie':cookie})
        # Browser cookies are host-scoped, so different ports need distinct names.
        original_home=env['NOCTUA_HOME'];original_port=port;env['NOCTUA_HOME']=str(root/'secondary')
        try:
            secondary=json.loads(cli('ensure').stdout);port=int(secondary['url'].rsplit(':',1)[1])
            secret2=(root/'secondary/server-token').read_text()
            _,second_headers=request('/auth/login','POST',{'Authorization':'Bearer '+secret2,'Origin':secondary['url']})
            cookie2=second_headers['set-cookie'].split(';')[0]
            assert cookie.split('=',1)[0]!=cookie2.split('=',1)[0]
            combined={'Cookie':cookie+'; '+cookie2}
            assert json.loads(request('/api/server',headers=combined)[0])['server_id']==secondary['server_id']
            port=original_port
            assert json.loads(request('/api/server',headers=combined)[0])['server_id']==first['server_id']
            cli('stop')
        finally:
            env['NOCTUA_HOME']=original_home;port=original_port

        request('/api/server',headers={'Cookie':cookie,'X-Noctua-Server':'a-different-data-owner'},expected=409)
        request('/api/notes','POST',{'Cookie':cookie,'Content-Type':'application/json'},'{}',expected=403)
        request('/api/notes','POST',{'Cookie':cookie,'Origin':first['url'],'Content-Type':'application/json'},'{}',expected=403)
        request('/api/notes','POST',{'Cookie':cookie,'Origin':first['url'],'X-Noctua-Client':'1','Content-Type':'application/json'},'{}',expected=409)
        browser={'Cookie':cookie,'Origin':first['url'],'X-Noctua-Client':'1','X-Noctua-Server':first['server_id'],'Content-Type':'application/json'}
        note=json.loads(request('/api/notes','POST',browser,json.dumps({'target':'L1','title':'Offline test'}))[0])
        path='/api/notes/L1/'+note['id']
        draft={**note,'title':'Device one'}
        saved=json.loads(request(path,'PUT',browser,json.dumps(draft))[0])
        request(path,'PUT',browser,json.dumps({**note,'title':'Device two'}),expected=409)
        assert json.loads(request(path,headers=auth)[0])['title']=='Device one'
        request('/api/desktop/pick-folder','POST',{**auth,'Content-Type':'application/json'},'{}',expected=404)
        # Same data cannot be opened even with an unrelated requested port.
        cli('serve',ok=False)
        original_record=json.loads((data/'server.json').read_text())
        (data/'server.json').write_text(json.dumps({**original_record,'api_version':999}))
        cli('status',ok=False);cli('ensure',ok=False)
        (data/'server.json').write_text(json.dumps({**original_record,'instance_id':'stale'}))
        cli('status',ok=False);cli('ensure',ok=False)
        (data/'server.json').write_text(json.dumps({k:first[k] for k in ['product','server_id','instance_id','api_version','version','data_dir','url','pid']}))
        cli('stop');cli('status',ok=False)
        assert (data/'notes').exists()
        # Dead process record and occupied configured port recover without trusting that port.
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1',0));occupied.listen();env['NOCTUA_PORT']=str(occupied.getsockname()[1])
            second=json.loads(cli('ensure').stdout)
            assert second['server_id']==first['server_id'] and second['instance_id']!=first['instance_id']
            assert second['url']!=f"http://127.0.0.1:{env['NOCTUA_PORT']}"
        port=int(second['url'].rsplit(':',1)[1]);assert json.loads(request(path,headers=auth)[0])['title']=='Device one'
        cli('restart');third=json.loads(cli('status').stdout);assert third['instance_id']!=second['instance_id']
        cli('stop')
        # Detaching changes cwd; relative overrides must retain their original meaning.
        previous_home=env['NOCTUA_HOME'];env['NOCTUA_HOME']=os.path.relpath(root/'relative-data')
        try:
            relative=json.loads(cli('ensure').stdout)
            assert pathlib.Path(relative['data_dir'])==(root/'relative-data').resolve()
            cli('status');cli('stop')
        finally:env['NOCTUA_HOME']=previous_home
        # Data-version fence refuses writes from an incompatible binary.
        marker=data/'server-format.json';original=marker.read_text();marker.write_text(json.dumps({'server_id':first['server_id'],'data_version':999}))
        cli('serve',ok=False);assert json.loads(marker.read_text())['data_version']==999;marker.write_text(original)
        # Mock the OS manager. Definitions/logs/staged executables all remain in tmp.
        if sys.platform in ('darwin','linux'):
            manager=root/'fake-service-manager'
            manager.write_text("""#!/usr/bin/env python3
import os,pathlib,subprocess,sys
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
with (root/'service-calls').open('a') as f:f.write(' '.join(args)+'\\n')
if (root/'fail-service').exists():print('simulated service failure',file=sys.stderr);sys.exit(1)
if 'is-enabled' in args:print('enabled' if (root/'enabled').exists() else 'disabled');sys.exit(0)
if args and args[0]=='print-disabled':print('"app.noctua.server" => '+('false' if (root/'enabled').exists() else 'true'));sys.exit(0)
if 'enable' in args:(root/'enabled').touch()
if 'disable' in args:(root/'enabled').unlink(missing_ok=True)
if (root/'delay-refresh').exists() and ('bootout' in args or 'daemon-reload' in args):
 import time
 (root/'refresh-blocked').touch()
 deadline=time.monotonic()+15
 while not (root/'release-refresh').exists() and time.monotonic()<deadline:time.sleep(.02)
if 'kickstart' in args or ('start' in args and '--user' in args):
 with (root/'service-server.log').open('ab') as log:subprocess.Popen([os.environ['NOCTUA_TEST_BINARY'],'serve'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
sys.exit(0)
""")
            manager.chmod(0o700);env['NOCTUA_SERVICE_MANAGER']=str(manager);env['NOCTUA_TEST_BINARY']=str(binary)
            cli('service','enable')
            cli('status',ok=False) # registering login must not start the current server
            assert json.loads(cli('service','status').stdout)['enabled']
            managed=json.loads(cli('ensure').stdout)
            assert managed['server_id']==first['server_id']
            (root/'delay-refresh').touch()
            restarting=subprocess.Popen([str(binary),'restart'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                deadline=time.monotonic()+15
                while not (root/'refresh-blocked').exists() and time.monotonic()<deadline:time.sleep(.02)
                assert (root/'refresh-blocked').exists(),'restart did not reach the serialized service refresh'
                ensuring=subprocess.Popen([str(binary),'ensure'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                time.sleep(.15);assert ensuring.poll() is None,'ensure bypassed the restart control lock'
                (root/'release-refresh').touch()
                output,error=restarting.communicate(timeout=30);assert restarting.returncode==0,error
                restarted=json.loads(output)
                output,error=ensuring.communicate(timeout=30);assert ensuring.returncode==0,error
                assert json.loads(output)['instance_id']==restarted['instance_id']
                assert restarted['instance_id']!=managed['instance_id']
            finally:
                (root/'release-refresh').touch()
                if restarting.poll() is None:restarting.terminate();restarting.wait(timeout=5)
                if 'ensuring' in locals() and ensuring.poll() is None:ensuring.terminate();ensuring.wait(timeout=5)
            calls=(root/'service-calls').read_text();assert 'kickstart' in calls or '--user start' in calls
            original_home=env['NOCTUA_HOME'];env['NOCTUA_HOME']=str(root/'other-data')
            cli('ensure',ok=False);cli('service','enable',ok=False)
            assert (root/'service-calls').read_text().count('kickstart')==calls.count('kickstart')
            assert (root/'service-calls').read_text().count('--user start')==calls.count('--user start')
            env['NOCTUA_HOME']=original_home;cli('status')
            cli('service','disable');cli('status') # disabling login must not stop the server
            cli('stop')
            (root/'fail-service').touch();cli('service','enable',ok=False)
            # Exercise real profile migration without ever selecting the user's profile.
            (root/'fail-service').unlink()
            previous_home=env.pop('NOCTUA_HOME');previous_service=env['NOCTUA_SERVICE_HOME']
            env['NOCTUA_PROFILE_HOME']=str(root/'profile');env['NOCTUA_SERVICE_HOME']=str(root/'profile-services')
            try:
                profile=json.loads(cli('ensure').stdout);cli('service','enable')
                definitions=[file for file in (root/'profile-services').iterdir() if file.suffix in ('.plist','.service')]
                assert definitions and 'NOCTUA_PROFILE_HOME' in definitions[0].read_text(), 'login service bypasses profile migration protection'
                port=int(profile['url'].rsplit(':',1)[1]);profile_auth={'Authorization':'Bearer '+(root/'profile/server-token').read_text(),'Content-Type':'application/json'}
                request('/api/settings/storage','POST',profile_auth,json.dumps({'dir':str(root/'relocated')}))
                relocated=json.loads(cli('restart').stdout)
                assert relocated['server_id']==profile['server_id']
                assert pathlib.Path(relocated['data_dir'])==(root/'relocated').resolve()
                metadata=next((root/'profile-services').glob('*.registration.json'))
                assert pathlib.Path(json.loads(metadata.read_text())['data_dir'])==(root/'relocated').resolve()
                cli('status');cli('stop')
            finally:
                env['NOCTUA_HOME']=previous_home;env['NOCTUA_SERVICE_HOME']=previous_service;env.pop('NOCTUA_PROFILE_HOME',None)

        print('PASS: concurrent ensure, detached lifetime, identity, stale records, owner lock, port collision, restart, data preservation, auth, Host/Origin/CSRF, browser session, note conflicts, native isolation, version fence, isolated service success/failure')
    finally:
        # Only the isolated data folder can be addressed by this cleanup.
        for cleanup_data in (data,root/'other-data',root/'relative-data',root/'profile',root/'relocated',root/'secondary'):
            cleanup_env={**env,'NOCTUA_HOME':str(cleanup_data)}
            subprocess.run([str(binary),'stop'],env=cleanup_env,capture_output=True,timeout=40)
