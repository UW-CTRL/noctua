#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
provider = Path(sys.argv[0]).name
home = Path(sys.argv[0]).parent
with (home / 'invocations.jsonl').open('a') as f: f.write(json.dumps({'provider':provider,'args':args})+'\n')
if args[:2] == ['login','status'] or args[:2] == ['auth','status']:
    sys.exit(0 if (home / (provider+'-signed-in')).exists() else 1)
if args == ['login'] or args == ['auth','login']:
    print('Sign in at https://example.com/login?test=true&provider='+provider, flush=True)
    (home / (provider+'-signed-in')).touch()
    sys.exit(0)
prompt = sys.stdin.read()
if '--image' in args:
    assert Path(args[args.index('--image')+1]).read_bytes().startswith(b'\x89PNG'), 'missing image attachment'
if '--input-format' in args:
    msg = json.loads(prompt)
    assert msg['message']['content'][0]['type'] == 'image'
transcribe = '--image' in args or '--input-format' in args
text = r'\[x^2\]' if transcribe else ('Partial' if 'slow' in prompt else provider+' reply')
session = provider+'-session'
if provider == 'codex':
    print(json.dumps({'type':'thread.started','thread_id':session}), flush=True)
    print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':text}}), flush=True)
else:
    print(json.dumps({'type':'system','subtype':'init','session_id':session}), flush=True)
    print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':text}}}), flush=True)
if 'slow' in prompt: time.sleep(30)
if 'fail' in prompt:
    print('fake provider failure', file=sys.stderr)
    sys.exit(1)
if provider == 'codex': print(json.dumps({'type':'turn.completed'}), flush=True)
else: print(json.dumps({'type':'result','session_id':session,'result':text,'is_error':False}), flush=True)
