#!/usr/bin/env python3
"""Real compiler/API regression. Requires cargo build and both compiler setup scripts."""
import gzip
import json
import os
from pathlib import Path
import socket
import platform
import re
import shutil
import traceback
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def recorded_source(sync_dir, artifact, path):
    """Use the compiler's Input spelling, including Windows drive/relative paths.

    Reconstructing an absolute path from Python can differ from Tectonic's
    recorded path on Windows. SyncTeX may then exit successfully without a hit.
    Split at most twice: an Input name may itself contain a drive-letter colon.
    """
    sync = sync_dir / (artifact + '.synctex.gz')
    content = (gzip.decompress(sync.read_bytes()) if sync.exists()
               else (sync_dir / (artifact + '.synctex')).read_bytes())
    names = [line.split(':', 2)[2] for line in content.decode('utf-8').splitlines()
             if line.startswith('Input:')]
    matches = [name for name in names
               if name.replace('\\', '/').removeprefix('./') == path
               or name.replace('\\', '/').endswith('/' + path)]
    assert len(matches) == 1, f"Expected one SyncTeX Input for {path!r}: {names!r}"
    return matches[0]


def synctex_diagnostics(program, sync_dir, artifact, source, relative, line):
    """Probe a failed query without weakening its assertion or changing app data.

    Exit zero with only the banner does not distinguish a path lookup failure
    from an unreadable map. Compare compressed/plain copies in a genuinely short
    directory and try inverse lookup independently of source-name matching.
    """
    compressed = sync_dir / (artifact + '.synctex.gz')
    raw = (gzip.decompress(compressed.read_bytes()) if compressed.exists()
           else (sync_dir / (artifact + '.synctex')).read_bytes())
    report = [f'Platform: {platform.platform()}', f'Map bytes: {len(raw)}',
              f'Original directory: {sync_dir}',
              'Map preamble:\n' + raw.decode('utf-8', errors='replace').split('Content:', 1)[0]]
    for zipped in (True, False):
        with tempfile.TemporaryDirectory(prefix='ns-') as temp:
            folder = Path(temp)
            sidecar = folder / ('probe.synctex.gz' if zipped else 'probe.synctex')
            sidecar.write_bytes(gzip.compress(raw) if zipped else raw)
            candidates = list(dict.fromkeys([source, source.replace('\\', '/'), relative]))
            commands = [[str(program), 'view', '-i', f'{line}:0:{name}', '-o', 'probe.pdf']
                        for name in candidates]
            commands.append([str(program), 'edit', '-o', '1:100:100:probe.pdf'])
            for command in commands:
                report.append(f'cwd={folder!s}; sidecar length={len(str(sidecar))}; argv={command!r}')
                try:
                    result = subprocess.run(command, cwd=folder, capture_output=True, text=True,
                                            errors='replace', timeout=10)
                    report.append(f'exit={result.returncode}\n{result.stdout}\n{result.stderr}')
                except Exception as error:
                    report.append(repr(error))
    return '\n'.join(report)


def run(engine):
    with tempfile.TemporaryDirectory(prefix='noctua-paper-test-') as temp:
        # Keep the real compiler/source paths short enough for Windows TeX, but
        # force the fingerprint + artifact sidecar path beyond MAX_PATH. Both
        # forward lookup here and the app's inverse lookup must use a basename.
        data = Path(temp)/('project-' + 'x' * 32)
        data.mkdir()
        (data/'settings.json').write_text('{"s2_key_skipped":true}')
        (data/'notes').mkdir()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = {k:v for k,v in os.environ.items() if not k.startswith('NOCTUA_')}
        env.update(NOCTUA_HOME=str(data), NOCTUA_CLIENT_HOME=str(Path(temp)/'client'), NOCTUA_PROFILE_HOME=str(Path(temp)/'profile'), NOCTUA_SERVICE_HOME=str(Path(temp)/'services'), NOCTUA_PORT=str(port), PATH='')
        binary = ROOT/'target'/'debug'/('noctua.exe' if os.name == 'nt' else 'noctua')
        # Exercise compiler lookup from the independent server's durable resource
        # tree, including the managed path layout on Windows.
        staged=Path(temp)/'client'/'servers'/'paper-integration-release'
        staged.mkdir(parents=True)
        executable=staged/binary.name
        shutil.copy2(binary,executable)
        distribution='tectonic' if engine=='tectonic' else 'texlive'
        shutil.copytree(ROOT/'target'/distribution,staged/'paper-resources'/distribution,symlinks=True)
        # Use the production stager, then retain foreground ownership for fixture
        # cleanup. The compiler copy must work independently of its source tree.
        prepared=subprocess.run([str(executable),'ensure'],cwd=temp,env=env,capture_output=True,text=True,timeout=180)
        assert prepared.returncode==0,prepared.stderr
        record=json.loads(prepared.stdout)
        stopped=subprocess.run([str(executable),'stop'],cwd=temp,env=env,capture_output=True,text=True,timeout=60)
        assert stopped.returncode==0,stopped.stderr
        executable=Path(record['executable'])
        shutil.rmtree(staged)
        process = subprocess.Popen([str(executable),'serve'], cwd=temp, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        base = f'http://127.0.0.1:{port}'
        def api(path, body=None, raw=False):
            request = urllib.request.Request(base+path, data=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None, headers={'Content-Type':'application/json','Authorization':'Bearer '+((data/'server-token').read_text() if (data/'server-token').exists() else '')})
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read() if raw else json.load(response)
        try:
            for _ in range(100):
                try:
                    api('/api/settings')
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(.1)
            target = api('/api/library/folder', {'parent':'L1','name':'Paper test'})['id']
            url = '/api/workspaces/'+target
            manifest = api(url)
            def change(**body):
                nonlocal manifest
                manifest = api(url, dict(body, revision=manifest['revision']))
                return manifest
            def create(name, text, parent=''):
                change(op='create', name=name, text=text, parent=parent)
                return next(e['id'] for e in manifest['entries'] if e['name']==name and e.get('parent','')==parent and not e.get('deleted'))
            def wait():
                deadline = time.monotonic()+310
                while time.monotonic()<deadline:
                    state = api(url+'/paper')
                    if state['state'] not in ('queued','building','cancelling'):
                        return state
                    time.sleep(.1)
                raise AssertionError('Build status timed out')
            def build(force=False):
                api(url+'/paper', {'revision':manifest['revision'], 'force':force})
                return wait()
            create('demo.cls', '\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{demo}\n\\LoadClass[twocolumn]{article}\n')
            # Keep aliases in this fixture after removing the temporary compiler
            # workaround: the upstream engine must preserve their spaces itself.
            bibliography = '@string{venue={{Foundations and Trends in Machine Learning}}}\n@article{key, author={Ada Lovelace}, title={A test reference}, journal=venue, year={2026}}'
            create('references.bib', bibliography)
            change(op='folder', name='sections', parent='')
            folder = next(e['id'] for e in manifest['entries'] if e['name']=='sections')
            included = create('intro.tex',r'Included text and a citation \cite{key}.', folder)
            image=(ROOT/'app/icons/32x32.png').read_bytes()
            manifest=api(url+'/upload?name=figure.png&revision='+str(manifest['revision']),image)
            source = r'''\documentclass{demo}
\usepackage{amsmath,graphicx}
\begin{document}
\section{Introduction}
\input{sections/intro}
\begin{equation}E=mc^2\end{equation}
\includegraphics[width=1cm]{Media/figure.png}
\bibliographystyle{plain}
\bibliography{references}
\end{document}
'''
            main = create('main.v2.tex', source)
            change(op='config', paper={'compiler':engine,'auto_compile':False})
            change(op='config', paper={'main_file':main})
            assert manifest['paper']['compiler']==engine and manifest['paper']['auto_compile'] is False
            other=api('/api/library/folder',{'parent':'L1','name':'Independent project'})['id']
            assert not api('/api/workspaces/'+other).get('paper',{}).get('compiler')
            assert all(c['available'] for c in api('/api/paper-compilers')['compilers'])
            result = build()
            assert result['state']=='success', result
            first = result['last_success']['fingerprint']
            assert result['last_success']['synctex'],result
            paper_root=next((data/'notes').glob('*/.workspace/paper'))
            tex_platform={'Darwin':'universal-darwin','Windows':'windows','Linux':'aarch64-linux' if platform.machine().lower() in ('arm64','aarch64') else 'x86_64-linux'}[platform.system()]
            synctex=ROOT/'target/texlive/bin'/tex_platform/('synctex.exe' if os.name=='nt' else 'synctex')
            def source_point(build,path,line):
                last=build['last_success']
                sync_dir = paper_root/'sync'/last['fingerprint']
                source = recorded_source(sync_dir, last['artifact'], path)
                command = [str(synctex),'view','-i',f"{line}:0:{source}",
                           '-o','map.pdf']
                sidecar = sync_dir / (last['artifact']+'.synctex.gz')
                assert len(str(sidecar)) > 260, 'Fixture must exercise a long sidecar path'
                # Match the app's query staging. Changing cwd alone still lets
                # Windows SyncTeX hit MAX_PATH when it resolves the full name.
                # Preserve map bytes and their source records exactly.
                with tempfile.TemporaryDirectory(prefix='ns-') as temp:
                    query_dir = Path(temp)
                    suffix = 'synctex.gz' if sidecar.exists() else 'synctex'
                    shutil.copyfile(sync_dir/(last['artifact']+'.'+suffix), query_dir/('map.'+suffix))
                    forward=subprocess.run(command,cwd=query_dir,capture_output=True,text=True,timeout=10)
                values=dict(re.findall(r'^(Page|x|y):([^\n]+)',forward.stdout,re.M))
                if forward.returncode != 0 or not {'Page','x','y'} <= values.keys():
                    report = synctex_diagnostics(synctex, sync_dir, last['artifact'], source, path, line)
                    (paper_root/'synctex-diagnostics.txt').write_text(report, encoding='utf-8')
                    print(report, flush=True)
                assert forward.returncode == 0 and {'Page','x','y'} <= values.keys(), (
                    f"SyncTeX command: {command!r}\nWorking directory: {query_dir} (temporary copy of {sync_dir})\nExit: {forward.returncode}\n"
                    + forward.stdout + forward.stderr)
                return {'fingerprint':last['fingerprint'],'page':int(values['Page']),'x':float(values['x']),'y':float(values['y'])}
            point=source_point(result,'sections/intro.tex',1)
            found=api(url+'/paper/source',point)
            assert found['file_id']==included and found['line']==1,found
            main_point=source_point(result,'.noctua-paper.tex',6)
            assert api(url+'/paper/source',main_point)['file_id']==main
            print('PASS: SyncTeX resolves main and included source files')

            assert api(url+'/paper/pdf/'+result['last_success']['artifact'], raw=True).startswith(b'%PDF-')
            bbl = next((data/'notes').glob('*/.workspace/paper/out/*.bbl')).read_text()
            assert 'Lovelace' in bbl
            assert 'Foundations and Trends in Machine Learning' in bbl, bbl
            # Stored files remain byte-for-byte unchanged; only build copies expand.
            bib_entry = next(e for e in manifest['entries'] if e['name']=='references.bib')
            blobs = list((data/'notes').rglob(bib_entry['blob']))
            assert blobs and all(p.read_text()==bibliography for p in blobs)
            if engine=='pdflatex':
                work_bib=next((data/'notes').glob('*/.workspace/paper/work/references.bib'))
                assert work_bib.read_text()==bibliography, 'Tectonic workaround must not affect pdfLaTeX'
            print('PASS: @string venue spacing preserved; original bibliography unchanged')
            print('PASS: custom class, nested input, dotted filename, BibTeX, PDF retrieval;', result['last_success']['elapsed_ms'], 'ms')
            assert build()['last_success']==result['last_success'], 'Unchanged build should reuse artifact'
            warm = build(True)
            assert warm['state']=='success',warm
            print('PASS: forced warm rebuild;',warm['last_success']['elapsed_ms'],'ms')
            change(op='edit',id=included,text=r'Updated included source. \cite{key}.')
            try:
                api(url+'/paper/source',point)
                raise AssertionError('Outdated source mapping accepted')
            except urllib.error.HTTPError as error:
                assert 'Source changed' in error.read().decode()
            updated = build()
            assert updated['state']=='success' and updated['last_success']['fingerprint']!=first
            last = updated['last_success']['fingerprint']
            updated_point=source_point(updated,'sections/intro.tex',1)
            change(op='edit',id=main,text=source.replace('\\section{Introduction}',r'\notARealCommand'))
            failed = build()
            assert failed['state']=='error' and failed['last_success']['fingerprint']==last
            assert failed['stale'] and failed.get('log')
            assert api(url+'/paper/pdf/'+failed['last_success']['artifact'],raw=True).startswith(b'%PDF-')
            assert api(url+'/paper/source',updated_point)['file_id']==included
            print('PASS: last-good SyncTeX survives failed compilation')
            print('PASS: invalid edits retain last successful PDF and expose logs')
            change(op='edit',id=main,text=source.replace('\\section{Introduction}',r'\loop\iftrue\repeat'))
            api(url+'/paper',{'revision':manifest['revision']})
            time.sleep(.3)
            # Queue a newer valid source, then stop: both the active and pending builds stop.
            change(op='edit',id=main,text=source)
            api(url+'/paper',{'revision':manifest['revision']})
            api(url+'/paper/cancel',{})
            stopped=wait()
            assert stopped['state']=='cancelled',stopped
            assert stopped['last_success']['fingerprint']==last
            print('PASS: Stop cancels active and queued builds')
            assert build()['state']=='success'
            # Keep one finite build occupied while two newer snapshots arrive.
            slow=source.replace('\\section{Introduction}',r'\newcount\counter \loop\advance\counter by1 \ifnum\counter<10000000 \repeat')
            change(op='edit',id=main,text=slow)
            api(url+'/paper',{'revision':manifest['revision']})
            change(op='edit',id=main,text=source+'% intermediate snapshot\n')
            api(url+'/paper',{'revision':manifest['revision']})
            change(op='edit',id=main,text=source+'% newest snapshot\n')
            api(url+'/paper',{'revision':manifest['revision']})
            latest=wait()
            assert latest['state']=='success' and latest['last_success']['fingerprint']==latest['current_fingerprint'],latest
            print('PASS: queued edits coalesce to the newest snapshot')
            change(op='rename',id=included,name='renamed.tex')
            assert build()['state']=='error','Renamed input must not survive in working directory'
            change(op='edit',id=main,text=source.replace('sections/intro','sections/renamed'))
            assert build()['state']=='success'
            try:
                api(url+'/paper',{'revision':0})
                raise AssertionError('Stale revision accepted')
            except urllib.error.HTTPError as error:
                assert 'Project changed' in error.read().decode()
            change(op='move',id=main,parent=folder)
            nested=build()
            assert nested['state']=='success',nested
            print('PASS: main document in a subfolder resolves project-root paths')
            work=next((data/'notes').glob('*/.workspace/paper/work'))
            arch='aarch64' if platform.machine().lower() in ('arm64','aarch64') else 'x86_64'
            platform_name={'Darwin':'apple-darwin','Linux':'unknown-linux-musl','Windows':'pc-windows-msvc'}[platform.system()]
            executable=ROOT/'target/tectonic'/f'{arch}-{platform_name}'/('tectonic.exe' if os.name=='nt' else 'tectonic')
            offline=subprocess.run([str(executable),'-X','compile','--untrusted','--only-cached','--outdir',str(work.parent/'out'),'./.noctua-paper.tex'],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
            assert offline.returncode==0,offline.stdout.decode(errors='replace')
            print('PASS: cached resources compile with network access disabled by --only-cached')
            if engine=='pdflatex':
                template=create('template.tex',r'\documentclass[pmlr]{jmlr}\usepackage{times}\begin{document}\section{Heading}Regular \textbf{bold} \textit{italic}.\end{document}')
                change(op='config',paper={'main_file':template})
                fonts=build()
                assert fonts['state']=='success',fonts
                assert 'utmb8a.pfb' in fonts['log'] and 'utmri8a.pfb' in fonts['log'], fonts['log']
                assert 'Font shape' not in fonts['log'],fonts['log']
                change(op='config',paper={'main_file':main})
                assert build()['state']=='success'
                print('PASS: bundled JMLR template and Times bold/italic without system PATH')
            # Changing engines must invalidate the artifact and retain project settings.
            change(op='config',paper={'compiler':'pdflatex' if engine=='tectonic' else 'tectonic'})
            switched=build()
            assert switched['state']=='success',switched
            assert switched['last_success']['compiler']!=engine
            assert switched['last_success']['fingerprint']!=nested['last_success']['fingerprint']
            assert manifest['paper']['main_file']==main and manifest['paper']['auto_compile'] is False
            print('PASS: independent project settings, compiler switching and cache invalidation')
            change(op='delete',id=main)
            assert api(url+'/paper').get('configuration_error')
            print('PASS: renamed inputs, stale revisions, and deleted main documents handled')
            pdfs=list((data/'notes').glob('*/.workspace/paper/*.pdf'))
            assert len(pdfs)<=2, pdfs
            print('PASS: artifact retention bounded to two PDFs')
        except Exception:
            # Preserve only this synthetic test project's build data, never the
            # user's library. CI uploads it before the temporary fixture vanishes.
            diagnostics = ROOT/'target/paper-diagnostics'/engine
            diagnostics.mkdir(parents=True, exist_ok=True)
            (diagnostics/'failure.txt').write_text(traceback.format_exc(), encoding='utf-8')
            for paper_dir in (data/'notes').glob('*/.workspace/paper'):
                shutil.copytree(paper_dir, diagnostics/paper_dir.parents[1].name, dirs_exist_ok=True)
            raise
        finally:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill();process.wait()

if __name__=='__main__':
    failures = []
    for engine in ('tectonic','pdflatex'):
        print("Testing",engine,flush=True)
        try:
            run(engine)
        except Exception:
            traceback.print_exc()
            failures.append(engine)
    if failures:
        raise SystemExit('Paper integration failed: ' + ', '.join(failures))
