#!/usr/bin/env bash
# 공식 envelope와 Unix/WebSocket→stdio 중계 회귀 — 사용자 세션·인증 없이 가짜 서버에서 실행한다.
. "$(dirname "$0")/_lib.sh"
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - "$PWD" <<'PY'
import importlib.util, io, json, os, pathlib, socket, struct, subprocess, sys, tempfile, threading, time
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / 'scripts/lib'))
from codex_approvals import Approvals, choices_for
spec = importlib.util.spec_from_file_location('codex_session', root / 'scripts/codex-session.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

# WebSocket의 짧은/16비트/64비트 길이·한글 UTF-8·마스크·제어 프레임을 확인한다.
for size in (0, 125, 126, 65535, 70000):
    payload=(('한'.encode()*((size+2)//3))[:size])
    encoded=module.frame(payload)
    assert encoded[0]==0x81
    marker=encoded[1]
    header=2
    if marker==126:
        assert struct.unpack('!H',encoded[2:4])[0]==size;header=4
    elif marker==127:
        assert struct.unpack('!Q',encoded[2:10])[0]==size;header=10
    else:assert marker==size
    mask=b'1234'
    client_frame=bytes([encoded[0],encoded[1]|0x80])+encoded[2:header]+mask+bytes(value^mask[index%4] for index,value in enumerate(payload))
    assert module.receive(io.BytesIO(client_frame))==(True,1,payload)
try:
    module.receive(io.BytesIO(b'\x81\x00'))
    raise AssertionError('마스크 없는 클라이언트 프레임 수락')
except ValueError:pass

def broker():
    sent = []
    def send(message):
        sent.append(message)
        if 'result' in message:
            instance.server({'method':'serverRequest/resolved','params':{'threadId':'thread1','requestId':message['id']}})
    instance = Approvals('p1', '/body', send)
    instance.server({'method':'turn/started','params':{'threadId':'thread1','turn':{'id':'turn1'}}})
    return instance, sent

def request(request_id=7, thread='thread1', turn='turn1'):
    return {'id':request_id,'method':'item/commandExecution/requestApproval','params':{'threadId':thread,'turnId':turn,'itemId':'item1','command':'echo fixture','startedAtMs':1}}

def answer(instance, **changes):
    entry = instance.listing()[0]
    return {**{key:entry[key] for key in ('token','generation','pane','body')},'choice':0,**changes}

instance, sent = broker(); instance.server(request())
assert len(instance.listing()) == 1 and sent == []
payload = answer(instance)
for field in ('token','generation','pane','body'):
    assert not instance.answer({**payload,field:'wrong'}) and sent == []
for choice in (-1, True, 4, '0'):
    assert not instance.answer({**payload,'choice':choice}) and sent == []
assert instance.answer(payload) and sent == [{'id':7,'result':{'decision':'accept'}}]
assert not instance.answer(payload)
instance.client({'id':7,'result':{'decision':'decline'}})
assert len(sent) == 1
# 같은 화면이어도 원래 RPC는 다르다. 옛 클릭을 다음 요청에 쓰지 않는다.
instance.server(request(8)); assert not instance.answer(payload)
assert instance.answer(answer(instance, choice=1)) and sent[-1] == {'id':8,'result':{'decision':'acceptForSession'}}
for event in [
    {'method':'turn/completed','params':{'threadId':'thread1','turn':{'id':'turn1'}}},
    {'method':'serverRequest/resolved','params':{'threadId':'thread1','requestId':7}},
    {'method':'turn/started','params':{'threadId':'thread1','turn':{'id':'turn2'}}},
    {'method':'thread/closed','params':{'threadId':'thread1'}},
]:
    instance,sent = broker();instance.server(request());payload=answer(instance)
    instance.server(event);assert not instance.answer(payload) and sent == []
instance,sent=broker();instance.server(request());payload=answer(instance);instance.close();assert not instance.answer(payload)
for thread,turn in [('other','turn1'),('thread1','other')]:
    instance,sent=broker();instance.server(request(thread=thread,turn=turn));assert instance.listing() == []
instance,sent=broker();instance.server(request());payload=answer(instance)
threads=[threading.Thread(target=instance.answer,args=(payload,)) for _ in range(8)]
for thread in threads:thread.start()
for thread in threads:thread.join()
assert len(sent)==1
amendment=['echo','fixture']
choices=choices_for('item/commandExecution/requestApproval', {'proposedExecpolicyAmendment':amendment})
assert choices[2]['result']=={'decision':{'acceptWithExecpolicyAmendment':{'execpolicy_amendment':amendment}}}
assert choices_for('item/commandExecution/requestApproval', {'availableDecisions':['decline']}) == [{'key':'decline','detail':None,'result':{'decision':'decline'}}]
assert len(choices_for('item/fileChange/requestApproval',{}))==4
assert choices_for('item/permissions/requestApproval',{'permissions':{'network':{'enabled':True}}})[1]['result']=={'permissions':{'network':{'enabled':True}},'scope':'session'}
assert choices_for('mcpServer/elicitation/request',{'mode':'url'})==[]
choices=choices_for('mcpServer/elicitation/request',{'mode':'form','requestedSchema':{'properties':{'approval':{'type':'string','enum':['once','always'],'enumNames':['Allow once','Always allow']}}}})
assert choices[1]['label']=='Always allow' and choices[1]['result']=={'action':'accept','content':{'approval':'always'}}
# Browser와 같은 공식 단일 질문은 원래 question ID/label/설명/answers 모양을 보존한다.
choices=choices_for('item/tool/requestUserInput',{'questions':[{'id':'browser-approval','question':'Browser access','options':[{'label':'Allow','description':'Once'},{'label':'Always allow','description':'Remember future requests'}]}]})
assert choices[1]['result']=={'answers':{'browser-approval':{'answers':['Always allow']}}}
assert choices[1]['description']=='Remember future requests'
assert choices_for('item/tool/requestUserInput',{'questions':[{'id':'secret','isSecret':True,'options':[{'label':'value'}]}]})==[]
# 기존 쓰기 루트 보존과 명시 교체의 다음 턴 유지(실패 응답은 반영하지 않는다).
sent=[]
gateway=module.Gateway.__new__(module.Gateway)
gateway.overrides={};gateway.extra_roots=['/extra'];gateway.review_roots=[];gateway.workspace_roots={'thread1':['/base']}
gateway.pending_roots={};gateway.roots_lock=threading.RLock();gateway.ws_lock=threading.RLock();gateway.ws=None
gateway.broker=Approvals('p1','/body',sent.append)
gateway.forward({'id':101,'method':'turn/start','params':{'threadId':'thread1'}})
assert sent[-1]['params']['runtimeWorkspaceRoots']==['/base','/extra']
gateway.observe({'id':101,'result':{'turn':{'id':'turn1'}}})
gateway.forward({'id':102,'method':'turn/start','params':{'threadId':'thread1','runtimeWorkspaceRoots':['/new']}})
assert sent[-1]['params']['runtimeWorkspaceRoots']==['/new','/extra']
gateway.observe({'id':102,'result':{'turn':{'id':'turn2'}}})
gateway.forward({'id':103,'method':'turn/start','params':{'threadId':'thread1'}})
assert sent[-1]['params']['runtimeWorkspaceRoots']==['/new','/extra']
gateway.forward({'id':104,'method':'turn/start','params':{'threadId':'thread1','runtimeWorkspaceRoots':['/failed']}})
gateway.observe({'id':104,'error':{'code':-1}})
gateway.forward({'id':105,'method':'turn/start','params':{'threadId':'thread1'}})
assert sent[-1]['params']['runtimeWorkspaceRoots']==['/new','/extra']
count=len(sent);gateway.forward({'id':106,'method':'turn/start','params':{'threadId':'unknown'}});assert len(sent)==count
gateway.overrides={'cwd':'/initial','model':'original','developerInstructions':'current'}
gateway.forward({'id':107,'method':'thread/resume','params':{'threadId':'thread1','cwd':'/selected','model':'selected','developerInstructions':'native-terminal-context'}})
assert sent[-1]['params']['cwd']=='/selected' and sent[-1]['params']['model']=='selected' and sent[-1]['params']['developerInstructions']=='native-terminal-context\n\ncurrent'
gateway.forward({'id':108,'method':'thread/resume','params':{'threadId':'thread1','cwd':None}})
assert sent[-1]['params']['cwd']=='/initial'
# reviewer 격리 — 작업자는 TUI 권한 값을 그대로 넘기고(전), reviewer 는 쓰기 영역을 리뷰 기록 자리로 고정한다(후)
wide={'type':'dangerFullAccess'}
gateway.overrides={'cwd':'/tree'};gateway.extra_roots=[];gateway.review_roots=[]
gateway.forward({'id':109,'method':'thread/start','params':{'sandbox':'danger-full-access'}})
assert sent[-1]['params']['sandbox']=='danger-full-access' and 'runtimeWorkspaceRoots' not in sent[-1]['params']
gateway.forward({'id':110,'method':'turn/start','params':{'threadId':'thread1','sandboxPolicy':wide}})
assert sent[-1]['params']['sandboxPolicy']==wide
gateway.review_roots=['/plans','/state']
for number,method in enumerate(('thread/start','thread/resume','thread/fork')):
    gateway.forward({'id':111+number,'method':method,'params':{'threadId':'thread1','sandbox':'danger-full-access','permissions':':danger','runtimeWorkspaceRoots':['/tree'],'config':{'model_reasoning_effort':'high','sandbox_workspace_write':{'writable_roots':['/tree'],'exclude_slash_tmp':True}}}})
    params=sent[-1]['params']
    assert params['sandbox']=='workspace-write' and params['runtimeWorkspaceRoots']==['/plans','/state'] and 'permissions' not in params, (method, params)
    assert params['config']=={'model_reasoning_effort':'high','sandbox_workspace_write':{'writable_roots':[],'network_access':True,'exclude_slash_tmp':True}}, params['config']
gateway.forward({'id':114,'method':'turn/start','params':{'threadId':'thread1','cwd':'/tree','runtimeWorkspaceRoots':['/tree'],'sandboxPolicy':wide,'permissions':':danger'}})
params=sent[-1]['params']
assert params['runtimeWorkspaceRoots']==['/plans','/state'] and 'sandboxPolicy' not in params and 'permissions' not in params and params['cwd']=='/tree'
gateway.forward({'id':115,'method':'thread/settings/update','params':{'threadId':'thread1','sandboxPolicy':wide,'permissions':':danger','model':'other'}})
params=sent[-1]['params']
assert 'sandboxPolicy' not in params and 'permissions' not in params and params['model']=='other'
gateway.review_roots=[]
gateway.forward({'id':109,'method':'thread/start','params':{'developerInstructions':'current\n\nnative-terminal-context'}})
assert sent[-1]['params']['developerInstructions']=='current\n\nnative-terminal-context'

# 실제 HTTP/Unix/WebSocket→자식 프로세스 stdio로 확인한다. 클릭 전 응답은 0.
with tempfile.TemporaryDirectory(prefix='codex-gateway-test-') as tmp:
    tmp=pathlib.Path(tmp);events=tmp/'responses.jsonl'
    fake=tmp/'fake.py'
    fake.write_text('''import json,sys\nfor line in sys.stdin:\n message=json.loads(line)\n if message.get('method')=='initialize':\n  print(json.dumps({'id':1,'result':{}}),flush=True)\n  print(json.dumps({'method':'turn/started','params':{'threadId':'thread1','turn':{'id':'turn1'}}}),flush=True)\n  print(json.dumps('''+repr(request())+'''),flush=True)\n else:\n  with open(sys.argv[1],'a') as output:output.write(line)\n  print(json.dumps({'method':'serverRequest/resolved','params':{'threadId':'thread1','requestId':message['id']}}),flush=True)\n''')
    gateway=module.Gateway([sys.executable,str(fake),str(events)],'p1','/body')
    endpoint=str(tmp/'rpc.sock');server=module.UnixServer(endpoint,gateway.handler())
    threading.Thread(target=server.serve_forever,daemon=True).start()
    client=socket.socket(socket.AF_UNIX);client.connect(endpoint)
    client.sendall(b'GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n')
    stream=client.makefile('rb')
    assert b'101' in stream.readline()
    while stream.readline()!=b'\r\n':pass
    def write(message):
        data=json.dumps(message).encode();mask=b'1234'
        size=len(data);header=bytes([0x81,0x80|size]) if size<126 else bytes([0x81,0xfe])+struct.pack('!H',size)
        client.sendall(header+mask+bytes(value^mask[index%4] for index,value in enumerate(data)))
    write({'id':1,'method':'initialize','params':{}})
    for _ in range(3):
        first,second=module.exact(stream,2);size=second&127
        if size==126:size=struct.unpack('!H',module.exact(stream,2))[0]
        json.loads(module.exact(stream,size))
    def http(method,path,payload=None):
        import http.client
        connection=http.client.HTTPConnection('localhost');connection.sock=socket.socket(socket.AF_UNIX);connection.sock.connect(endpoint)
        connection.request(method,path,body=json.dumps(payload) if payload is not None else None,headers={'Content-Type':'application/json'})
        result=json.loads(connection.getresponse().read());connection.close();return result
    listing=http('GET','/requests')['requests'];assert len(listing)==1 and not events.exists()
    payload={**{key:listing[0][key] for key in ('token','generation','pane','body')},'choice':0}
    assert http('POST','/respond',payload)=={'ok':True}
    assert http('POST','/respond',payload)=={'ok':False}
    deadline=time.monotonic()+2
    while not events.exists() and time.monotonic()<deadline:time.sleep(.01)
    assert [json.loads(line) for line in events.read_text().splitlines()]==[{'id':7,'result':{'decision':'accept'}}]
    client.shutdown(socket.SHUT_RDWR);client.close();gateway.process.terminate();gateway.process.wait();server.shutdown();server.server_close()
print('✅ Codex 공식 승인 식별·중복·종료·연결·HTTP/WebSocket/stdio 통합 회귀 통과')
PY

# wrapper 실제 실행 — 가짜 codex(app-server · 원격 TUI 흉내)로 정리 · 청소 · pane 기록 · 옛 구조 본체 경로를 본다.
python3 - "$PWD" <<'PY'
import json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time, uuid
root = pathlib.Path(sys.argv[1])
fake = r'''#!/usr/bin/env python3
import json, os, pathlib, socket, struct, sys, time, uuid
log = pathlib.Path(os.environ['FAKE_CODEX_LOG'])
with open(log / 'pids', 'a') as handle: handle.write(f'{os.getpid()}\n')
args = sys.argv[1:]
if args[:2] == ['app-server', '--stdio']:
    thread = str(uuid.uuid4())
    for line in sys.stdin:
        message = json.loads(line)
        if message.get('method') == 'initialize':
            print(json.dumps({'id': message['id'], 'result': {}}), flush=True)
        elif message.get('method') == 'thread/start':
            cwd = message['params'].get('cwd')
            print(json.dumps({'id': message['id'], 'result': {'cwd': cwd, 'thread': {'id': thread, 'cwd': cwd}}}), flush=True)
    sys.exit(0)
assert args[0] == '--remote'
client = socket.socket(socket.AF_UNIX); client.connect(args[1][len('unix://'):])
client.sendall(b'GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n')
stream = client.makefile('rb')
while stream.readline() != b'\r\n': pass
def write(message):
    data = json.dumps(message).encode(); mask = b'1234'
    client.sendall(bytes([0x81, 0x80 | len(data)]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(data)))
write({'id': 1, 'method': 'initialize', 'params': {}})
write({'id': 2, 'method': 'thread/start', 'params': {}})
for _ in range(2):
    _first, second = stream.read(2); size = second & 127
    if size == 126: size = struct.unpack('!H', stream.read(2))[0]
    stream.read(size)
(log / 'ready').write_text('1')
while True: time.sleep(1)
'''
def wait(check, label, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value: return value
        time.sleep(.05)
    raise AssertionError('시간 초과: ' + label)
with tempfile.TemporaryDirectory(prefix='codex-session-test-') as temp:
    temp = pathlib.Path(temp)
    spawned = []  # 이 시험이 띄운 pid 만 — 단언이 실패해도 끝에서 정리한다(가짜 TUI 가 남지 않게)
    bindir = temp / 'bin'; bindir.mkdir()
    (bindir / 'codex').write_text(fake); (bindir / 'codex').chmod(0o755)
    def body(name, packs):
        place = temp / name
        shutil.copytree(root / 'scripts', place / 'scripts', ignore=shutil.ignore_patterns('node_modules', 'board'))
        if packs:
            (temp / (name + '-data')).mkdir(); (place / '.pack-data').symlink_to(temp / (name + '-data'))
            return place, temp / (name + '-data') / 'state'
        return place, None
    def start(place, log):
        log.mkdir(exist_ok=True)
        for item in ('ready', 'pids'): (log / item).unlink(missing_ok=True)
        env = {key: value for key, value in os.environ.items() if not key.startswith(('ATHENA_', 'CODEX_'))}
        env.update(PATH=f'{bindir}:{env.get("PATH", "")}', FAKE_CODEX_LOG=str(log), ATHENA_SCREEN='studio', ATHENA_STUDIO='1',
                   ATHENA_STUDIO_PANE_ID='p1', ATHENA_AGENT='fixture-agent', ATHENA_ROLE='agent')
        process = subprocess.Popen([sys.executable, str(place / 'scripts/codex-session.py'), '--no-daemon'], cwd=place, env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        wait(lambda: (log / 'ready').exists() or process.poll() is not None, '가짜 TUI 연결')
        spawned.append(process.pid)
        spawned.extend(int(line) for line in (log / 'pids').read_text().split())
        assert process.poll() is None, process.stderr.read().decode()
        return process
    def records(registry): return sorted(registry.glob('*.json')) if registry.exists() else []

    try:
        place, state = body('body', True)
        registry = state / 'codex-connections'; log = temp / 'log'
        # 1) pane 이 닫힐 때(SIGHUP) 등록 · 소켓 자리를 지운다 · thread id 가 pane 기록에 엔진 codex 로 남는다
        process = start(place, log)
        [record] = wait(lambda: records(registry), '연결 등록')
        value = json.loads(record.read_text()); socket_dir = pathlib.Path(value['socket']).parent
        assert value['pid'] == process.pid and value['pane'] == 'p1' and (record.stat().st_mode & 0o077) == 0
        session = wait(lambda: (state / 'pane-sessions/p1.json').exists() and json.loads((state / 'pane-sessions/p1.json').read_text()), 'pane 기록')
        assert session['engine'] == 'codex' and session['agent'] == 'fixture-agent' and session['role'] == 'agent' and uuid.UUID(session['session'])
        process.send_signal(signal.SIGHUP); process.wait(timeout=10)
        assert records(registry) == [] and not socket_dir.exists(), 'SIGHUP 뒤 등록·소켓이 남음'
        print('  ✔ SIGHUP 정리 · pane 기록(engine codex)')
        # 2) kill -9 로 정리 없이 죽으면 다음 실행이 낡은 등록 · 소켓을 치운다(살아 있는 pid 의 등록은 두고)
        process = start(place, log)
        [record] = wait(lambda: records(registry), '연결 등록')
        stale_dir = pathlib.Path(json.loads(record.read_text())['socket']).parent
        children = [int(line) for line in (log / 'pids').read_text().split()]
        process.kill(); process.wait()
        for pid in children:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        assert record.exists() and stale_dir.exists()
        old = registry / (str(uuid.uuid4()) + '.json')   # pid 가 없는 옛 기록 — 소켓이 없으면 낡은 것
        old.write_text(json.dumps({'socket': '/tmp/athena-codex-gone/rpc.sock', 'pane': 'p9'})); old.chmod(0o600)
        keep = registry / (str(uuid.uuid4()) + '.json')  # 살아 있는 실행의 기록은 지우지 않는다
        keep.write_text(json.dumps({'socket': '/tmp/athena-codex-gone/rpc.sock', 'pane': 'p8', 'pid': os.getpid()})); keep.chmod(0o600)
        process = start(place, log)
        assert not record.exists() and not stale_dir.exists() and not old.exists() and keep.exists(), 'kill -9 뒤 낡은 기록을 치우지 않음'
        keep.unlink()
        process.send_signal(signal.SIGTERM); process.wait(timeout=10)
        assert records(registry) == []
        print('  ✔ kill -9 뒤 다음 실행이 낡은 등록·소켓 청소')
        # 3) 옛 구조 본체(.pack-data 없음)도 pane 안이면 원격 중계를 탄다 — 등록은 본체 .codex-connections
        legacy, _ = body('legacy', False)
        process = start(legacy, temp / 'legacy-log')
        wait(lambda: records(legacy / '.codex-connections'), '옛 구조 본체 등록')
        process.send_signal(signal.SIGINT); process.wait(timeout=10)
        assert records(legacy / '.codex-connections') == []
        print('  ✔ 옛 구조 본체도 원격 중계 · SIGINT 정리')
    finally:
        for pid in spawned:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
print('✅ Codex wrapper 종료 정리 · 낡은 등록 청소 · pane 기록 · 실행 경로 통합 회귀 통과')
PY

# 본체 훅 믿음 점검(codex-hook-trust.py) — hooks/list 의 project 훅 trustStatus 개수만 · 해시는 내보내지 않는다
python3 - "$PWD" <<'PY'
import os, pathlib, subprocess, sys, tempfile
root = pathlib.Path(sys.argv[1])
fake = r'''#!/usr/bin/env python3
import json, os, sys
statuses = os.environ['FAKE_STATUSES'].split(',') if os.environ['FAKE_STATUSES'] else []
for line in sys.stdin:
    message = json.loads(line)
    if message.get('id') == 1: print(json.dumps({'id': 1, 'result': {}}), flush=True)
    if message.get('method') == 'hooks/list':
        if os.environ.get('FAKE_ERROR'): print(json.dumps({'id': 2, 'error': {'message': 'x'}}), flush=True); continue
        hooks = [{'source': 'project', 'trustStatus': status, 'currentHash': 'sha256:SECRETHASH', 'key': 'k'} for status in statuses]
        hooks.append({'source': 'user', 'trustStatus': 'untrusted', 'currentHash': 'sha256:SECRETHASH', 'key': 'u'})
        print(json.dumps({'id': 2, 'result': {'data': [{'cwd': message['params']['cwds'][0], 'hooks': hooks}]}}), flush=True)
'''
with tempfile.TemporaryDirectory(prefix='codex-hook-trust-test-') as temp:
    bindir = pathlib.Path(temp)
    (bindir / 'codex').write_text(fake); (bindir / 'codex').chmod(0o755)
    def check(statuses, error=''):
        env = dict(os.environ, PATH=f'{bindir}:{os.environ.get("PATH", "")}', FAKE_STATUSES=statuses, FAKE_ERROR=error)
        result = subprocess.run([sys.executable, str(root / 'scripts/codex-hook-trust.py'), temp], env=env, capture_output=True, text=True, timeout=30)
        assert 'SECRETHASH' not in result.stdout + result.stderr, '해시가 출력됨'
        return result.returncode, result.stdout.strip()
    assert check('trusted,trusted,managed') == (0, '3 0 0')
    assert check('trusted,untrusted,modified,untrusted') == (1, '4 2 1')   # user 출처(untrusted)는 세지 않는다
    assert check('', error='1')[0] == 2
    print('  ✔ 본체 훅 믿음 점검: 모두 믿음 0 · 믿음 표시 필요 1 · 확인 못 함 2 · 해시 비출력')
print('✅ Codex 본체 훅 믿음 점검 회귀 통과')
PY

# 서버 중계 훅 믿음 키(sessionFlags `<이벤트>:<묶음>:<순번>`)는 본체 · 역할 구분이 없다 —
# 리뷰어가 가진 자리마다 에이전트와 같은 matcher · 명령이어야 서로의 믿음을 modified 로 덮지 않는다
python3 - "$PWD" <<'PY'
import json, pathlib, sys, tempfile
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / 'scripts/lib'))
import codex_dispatch
def slots(hooks):
    return {(event, group_index, hook_index): (group.get('matcher'), json.dumps(hook, sort_keys=True))
            for event, groups in hooks.items() for group_index, group in enumerate(groups)
            for hook_index, hook in enumerate(group['hooks'])}
with tempfile.TemporaryDirectory(prefix='codex-hook-slots-') as temp:
    context = pathlib.Path(temp) / 'context.md'; context.write_text('x')
    definitions = pathlib.Path(temp) / 'agents.json'
    definitions.write_text(json.dumps({name: {'prompt': 'p'} for name in ('web-fe', 'api-be', 'reviewer')}))
    sets = {agent: slots(codex_dispatch.settings(root, agent, role, context, definitions)[1])
            for agent, role in (('web-fe', 'agent'), ('api-be', 'agent'), ('reviewer', 'reviewer'))}
assert sets['web-fe'] == sets['api-be'], '에이전트마다 훅 자리가 다르다'
moved = [key for key, value in sets['reviewer'].items() if sets['web-fe'].get(key) != value]
assert not moved, f'리뷰어와 에이전트의 같은 자리에 다른 훅: {moved}'
assert len(sets['web-fe']) > len(sets['reviewer'])   # 역할 전용 훅은 공통 훅 뒤에 덧붙는다
print('  ✔ 위임 훅 자리: 에이전트끼리 같음 · 리뷰어 자리는 모두 에이전트와 같은 훅(역할 전용은 뒤)')
print('✅ Codex 위임 훅 믿음 자리 회귀 통과')
PY
