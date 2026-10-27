#!/usr/bin/env python3
"""Isolated managed-compiler ownership and drain regression; no real service or TeX."""
import http.client, json, os, pathlib, platform, shutil, subprocess, sys, tempfile, time
repo=pathlib.Path(__file__).resolve().parent.parent
assert os.name!='nt','The fake executable compiler fixture runs on Unix; real compiler CI covers Windows'
binary=repo/'target/debug/noctua';candidate=repo/'target/debug/noctua-update-fixture'
with tempfile.TemporaryDirectory(prefix='noctua-paper-owner-') as tmp:
    root=pathlib.Path(tmp);data=root/'data';client=root/'client'
    env={k:v for k,v in os.environ.items() if not k.startswith('NOCTUA_')}
    env.update(NOCTUA_HOME=str(data),NOCTUA_CLIENT_HOME=str(client),NOCTUA_PROFILE_HOME=str(root/'profile'),NOCTUA_SERVICE_HOME=str(root/'services'),NOCTUA_PORT='0')
    arch='aarch64' if platform.machine().lower() in ['arm64','aarch64'] else 'x86_64'
    triple=arch+('-apple-darwin' if sys.platform=='darwin' else '-unknown-linux-musl')
    def bundle(name,source):
        directory=root/name;executable=directory/'binaries/noctua-server';executable.parent.mkdir(parents=True);shutil.copy2(source,executable)
        compiler=directory/'tectonic'/triple/'tectonic';compiler.parent.mkdir(parents=True)
        compiler.with_name('support.txt').write_text('Kept outside the app bundle')
        compiler.write_text('''#!/usr/bin/env python3
import pathlib,sys,time
root=pathlib.Path(ROOT)
(root/'compiler-started').touch()
deadline=time.monotonic()+180
while not (root/'release-compiler').exists():
    assert time.monotonic()<deadline
    time.sleep(.05)
assert pathlib.Path(__file__).with_name('support.txt').read_text()=='Kept outside the app bundle'
out=pathlib.Path(sys.argv[sys.argv.index('--outdir')+1]);out.mkdir(exist_ok=True)
(out/'.noctua-paper.pdf').write_bytes(b'%PDF-1.7\\nFinished before server replacement\\n')
(root/'compiler-finished').touch()
'''.replace('ROOT',repr(str(root))))
        compiler.chmod(0o700);return executable
    old=bundle('old-bundle',binary);new=bundle('new-bundle',candidate);worker=None
    def cli(*args):return subprocess.run([str(binary),*args],env=env,capture_output=True,text=True,timeout=120)
    def wait(test):
        deadline=time.monotonic()+120
        while time.monotonic()<deadline:
            if test():return
            time.sleep(.05)
        raise AssertionError('Paper lifecycle condition timed out')
    try:
        result=subprocess.run([str(old),'ensure'],env=env,capture_output=True,text=True,timeout=120);assert result.returncode==0,result.stderr
        initial=json.loads(result.stdout);port=int(initial['url'].rsplit(':',1)[1]);secret=(data/'server-token').read_text()
        def api(path,body=None):
            connection=http.client.HTTPConnection('127.0.0.1',port,timeout=30)
            connection.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,{'Authorization':'Bearer '+secret,'Content-Type':'application/json'})
            response=connection.getresponse();content=response.read();connection.close();assert response.status==200,(path,response.status,content);return json.loads(content)
        target=api('/api/library/folder',{'parent':'L1','name':'Compile before upgrade'})['id'];url='/api/workspaces/'+target
        manifest=api(url);manifest=api(url,{'revision':manifest['revision'],'op':'create','name':'main.tex','text':'Paper source'})
        main=next(entry['id'] for entry in manifest['entries'] if entry['name']=='main.tex')
        manifest=api(url,{'revision':manifest['revision'],'op':'config','paper':{'main_file':main,'auto_compile':False,'compiler':'tectonic'}})
        api(url+'/paper',{'revision':manifest['revision']});wait(lambda:(root/'compiler-started').exists())
        stopped=cli('stop');assert stopped.returncode!=0,'safe stop interrupted a detached paper build'
        assert api('/api/server')['ready'] and not (root/'compiler-finished').exists()
        worker=subprocess.Popen([str(binary),'update','--server',str(new),'--grace-seconds','1','--timeout-seconds','120'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        def draining():
            file=client/'server-update.json';return file.exists() and json.loads(file.read_text())['phase']=='draining'
        wait(draining);assert not (root/'compiler-finished').exists()
        shutil.rmtree(root/'old-bundle');assert pathlib.Path(initial['executable']).parent.joinpath('paper-resources').is_dir()
        (root/'release-compiler').touch();output,error=worker.communicate(timeout=120);assert worker.returncode==0,error
        ready=json.loads(output);assert ready['server_id']==initial['server_id'] and ready['instance_id']!=initial['instance_id']
        assert (root/'compiler-finished').exists() and api(url+'/paper')['last_success']
        assert all(item['available'] for item in api('/api/paper-compilers')['compilers'] if item['id']=='tectonic')
        assert not pathlib.Path(initial['executable']).exists()
        assert not pathlib.Path(initial['executable']).parent.joinpath('paper-resources').exists(),'retired compiler resources were not cleaned'
        print('PASS: detached paper builds block safe stop, drain before update, survive app-bundle removal, retain output and retire old compiler resources')
    finally:
        (root/'release-compiler').touch()
        if worker and worker.poll() is None:worker.terminate();worker.wait(timeout=10)
        cli('stop')
