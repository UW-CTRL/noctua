#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
provider = Path(sys.argv[0]).name
home = Path(sys.argv[0]).parent
with (home / 'invocations.jsonl').open('a') as f: f.write(json.dumps({'provider':provider,'args':args})+'\n')
if provider == 'claude' and '{"disableAllHooks":true}' in args:
    for line in sys.stdin:
        message = json.loads(line)
        assert message['type'] == 'control_request', 'discovery must not send a user prompt'
        assert message['request']['subtype'] == 'initialize'
        response = {'request_id':message['request_id'], 'subtype':'success', 'response':{'models':[
            {'value':'default','displayName':'Organization default','supportedEffortLevels':['medium']},
            {'value':'new-opus','displayName':'New Opus','supportsFastMode':True,'supportedEffortLevels':['low','high']},
            {'value':'new-haiku','displayName':'New Haiku'},
        ]}}
        if (home / 'model-list-fail').exists(): response = {'request_id':message['request_id'],'subtype':'error','error':'Claude catalog unavailable'}
        if (home / 'model-list-eof').exists(): sys.exit(0)
        print(json.dumps({'type':'control_response','response':response}), flush=True)
    sys.exit(0)
if args[:1] == ['app-server']:
    initialized = False
    for line in sys.stdin:
        message = json.loads(line)
        method = message.get('method')
        if method == 'initialize':
            print(json.dumps({'id':message['id'], 'result':{}}), flush=True)
        elif method == 'initialized':
            initialized = True
        elif method == 'model/list':
            assert initialized, 'missing discovery handshake'
            if (home / 'model-list-fail').exists():
                print(json.dumps({'id':message['id'], 'error':{'message':'model catalog unavailable'}}), flush=True)
                continue
            if (home / 'model-list-eof').exists(): sys.exit(0)
            print(json.dumps({'method':'account/updated', 'params':{}}), flush=True)
            model = lambda name, hidden=False: {'id':name, 'model':name, 'hidden':hidden, 'supportedReasoningEfforts':[{'reasoningEffort':'low'}, {'reasoningEffort':'high'}], 'isDefault':name=='catalog-model'}
            if message['params'].get('cursor'):
                result = {'data':[model('catalog-model'),model('second-model')], 'nextCursor':None}
            else:
                result = {'data':[model('catalog-model'),model('hidden-model',True)], 'nextCursor':'page-two'}
            print(json.dumps({'id':message['id'], 'result':result}), flush=True)
    sys.exit(0)
if args[:2] == ['login','status'] or args[:2] == ['auth','status']:
    sys.exit(0 if (home / (provider+'-signed-in')).exists() else 1)
if args == ['login'] or args == ['auth','login']:
    print('Sign in at https://example.com/login?test=true&provider='+provider, flush=True)
    (home / (provider+'-signed-in')).touch()
    sys.exit(0)
if (home / 'analysis-start-failure').exists():
    print('The selected model is unavailable for this account.', file=sys.stderr)
    sys.exit(1)
prompt = sys.stdin.read()
if 'verify-selected-passages' in prompt:
    assert '<selected_passages>' in prompt and 'A grounded passage.' in prompt and 'note-1' in prompt
    (home / (provider+'-selected.txt')).write_text(prompt)
if '--image' in args:
    assert Path(args[args.index('--image')+1]).read_bytes().startswith(b'\x89PNG'), 'missing image attachment'
if '--input-format' in args:
    msg = json.loads(prompt)
    assert msg['message']['content'][0]['type'] == 'image'
transcribe = '--image' in args or '--input-format' in args
text = r'\[x^2\]' if transcribe else ('Partial' if 'slow' in prompt else provider+' reply')
if any('Build a concise navigable outline' in arg for arg in args):
    paper = json.loads(prompt)
    text = json.dumps({'entries':[{'title':'Introduction','page':1,'level':1,'quote':paper['pages'][0]['text'][:60]}]})
if any("You are Noctua's Auto-highlight agent" in arg for arg in args):
    paper = json.loads(prompt)
    text = json.dumps({'highlights':[{'category':'novelty','page':1,'quote':paper['pages'][0]['text'][:60],'comment':'Principal contribution.'}]})
    if (home / 'auto-highlight-invalid').exists():
        text = json.dumps({'highlights':[{'category':'novelty','page':1,'quote':'An invented source passage.'}]})
if 'Name each research thread' in prompt:
    text = 'Here are the threads:\n```json\n' + json.dumps({'common':'Both use attention.','threads':[{'id':'t1','name':provider+' thread','problem':'Long-range dependencies.','summary':'Recurrence gave way to attention.','key':['a','b'],'steps':[{'from':'a','to':'b','relation':'extends','note':'adds attention'}]}]}) + '\n```'
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
