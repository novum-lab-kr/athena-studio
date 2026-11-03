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
gateway.overrides={};gateway.extra_roots=['/extra'];gateway.workspace_roots={'thread1':['/base']}
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
