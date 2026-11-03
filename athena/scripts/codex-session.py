#!/usr/bin/env python3
"""새 Codex TUI와 개별 app-server 사이의 공식 RPC 중계. 기존 세션에는 붙지 않는다.

외부 포트 없이 사용자 전용 Unix 소켓을 쓴다. TUI는 WebSocket, 앱은 같은 소켓의
HTTP 목록/응답 경로를 사용한다. 원래 stdin/stdout은 TUI가 그대로 소유한다.
"""
from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import pathlib
import re
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts/lib'))
from codex_approvals import Approvals
import codex_dispatch
import screen

MAX_MESSAGE = 64 * 1024 * 1024


def frame(data: bytes, opcode: int = 1) -> bytes:
    size = len(data)
    header = bytes([0x80 | opcode])
    if size < 126:
        return header + bytes([size]) + data
    if size < 65536:
        return header + bytes([126]) + struct.pack('!H', size) + data
    return header + bytes([127]) + struct.pack('!Q', size) + data


def exact(stream, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise EOFError()
    return data


def receive(stream):
    """클라이언트의 마스크된 텍스트/연속 프레임을 읽고 제어 프레임은 따로 돌려준다."""
    first, second = exact(stream, 2)
    if first & 0x70 or not second & 0x80:
        raise ValueError('WebSocket frame')
    size = second & 0x7f
    if size == 126:
        size = struct.unpack('!H', exact(stream, 2))[0]
    elif size == 127:
        size = struct.unpack('!Q', exact(stream, 8))[0]
    if size > MAX_MESSAGE:
        raise ValueError('WebSocket size')
    opcode = first & 0x0f
    if opcode >= 8 and (not first & 0x80 or size > 125):
        raise ValueError('WebSocket control')
    mask = exact(stream, 4)
    data = exact(stream, size)
    return bool(first & 0x80), opcode, bytes(value ^ mask[index % 4] for index, value in enumerate(data))


class UnixServer(http.server.ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True

    def server_bind(self):
        socketserver_bind = super(http.server.HTTPServer, self).server_bind
        socketserver_bind()
        self.server_name = 'localhost'
        self.server_port = 0


class Gateway:
    def __init__(self, command: list[str], pane: str, body: str, overrides: dict | None = None, extra_roots: list[str] | None = None):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.overrides = overrides or {}
        self.extra_roots = [os.path.abspath(root) for root in extra_roots or []]
        self.workspace_roots: dict[str, list[str]] = {}
        self.pending_roots: dict[str, tuple[str, list[str]]] = {}
        self.roots_lock = threading.RLock()
        self.writer_lock = threading.Lock()
        self.ws_lock = threading.RLock()
        self.ws = None
        self.connected = False
        self.broker = Approvals(pane, body, self.send)

    def send(self, message: dict) -> None:
        with self.writer_lock:
            self.process.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
            self.process.stdin.flush()

    def relay(self) -> None:
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                self.observe(message)
                self.broker.server(message)
                with self.ws_lock:
                    if self.ws:
                        self.ws.sendall(frame(line.rstrip(b'\n')))
        finally:
            self.broker.close()
            with self.ws_lock:
                if self.ws:
                    try:
                        self.ws.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

    def observe(self, message: dict) -> None:
        with self.roots_lock:
            result = message.get('result') or {}
            if isinstance(result, dict) and isinstance(result.get('thread'), dict):
                thread = result['thread'].get('id')
                roots = result.get('runtimeWorkspaceRoots')
                if isinstance(thread, str) and isinstance(roots, list) and all(isinstance(root, str) and os.path.isabs(root) for root in roots):
                    self.workspace_roots[thread] = roots
            if 'id' in message and 'method' not in message:
                pending = self.pending_roots.pop(Approvals.identity(message['id']), None)
                if pending and 'result' in message and 'error' not in message:
                    thread, roots = pending
                    self.workspace_roots[thread] = roots

    def forward(self, message: dict) -> None:
        method = message.get('method')
        if method in ('thread/start', 'thread/resume', 'thread/fork'):
            params = dict(message.get('params') or {})
            for key, value in self.overrides.items():
                if key == 'developerInstructions' and isinstance(value, str):
                    native = params.get(key)
                    if isinstance(native, str) and native:
                        params[key] = native if value in native else native + '\n\n' + value
                    else:
                        params[key] = value
                elif key == 'config':
                    params[key] = {**(params.get(key) or {}), **value}
                elif params.get(key) is None:
                    params[key] = value
            message = {**message, 'params': params}
        elif method == 'turn/start' and self.extra_roots:
            params = dict(message.get('params') or {})
            roots = params.get('runtimeWorkspaceRoots')
            if roots is None:
                with self.roots_lock:
                    roots = self.workspace_roots.get(params.get('threadId'))
            if not isinstance(roots, list) or not all(isinstance(root, str) and os.path.isabs(root) for root in roots):
                with self.ws_lock:
                    if self.ws:
                        self.ws.sendall(frame(json.dumps({'id': message.get('id'), 'error': {'code': -32602, 'message': 'Codex 쓰기 루트를 확인하지 못했다'}}).encode()))
                return
            params['runtimeWorkspaceRoots'] = list(dict.fromkeys([*roots, *self.extra_roots]))
            message = {**message, 'params': params}
            with self.roots_lock:
                self.pending_roots[Approvals.identity(message.get('id'))] = (params['threadId'], params['runtimeWorkspaceRoots'])
        self.broker.client(message)

    def handler(self):
        gateway = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                pass

            def reply(self, value: dict, status: int = 200):
                data = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(data)
                self.close_connection = True

            def do_GET(self):
                if self.path == '/requests' and not self.headers.get('Upgrade'):
                    self.reply({'generation': gateway.broker.generation, 'requests': gateway.broker.listing()})
                    return
                if self.path not in ('/', '/rpc') or self.headers.get('Upgrade', '').lower() != 'websocket' or self.headers.get('Sec-WebSocket-Version') != '13':
                    self.reply({'error': 'unsupported'}, 400)
                    return
                key = self.headers.get('Sec-WebSocket-Key', '')
                try:
                    valid_key = len(base64.b64decode(key, validate=True)) == 16
                except ValueError:
                    valid_key = False
                with gateway.ws_lock:
                    if not valid_key or gateway.connected:
                        self.reply({'error': 'connection-used'}, 409)
                        return
                    gateway.connected = True
                    accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                    self.send_response(101)
                    self.send_header('Upgrade', 'websocket')
                    self.send_header('Connection', 'Upgrade')
                    self.send_header('Sec-WebSocket-Accept', accept)
                    self.end_headers()
                    gateway.ws = self.connection
                threading.Thread(target=gateway.relay, daemon=True).start()
                chunks = bytearray()
                fragmented = False
                try:
                    while True:
                        final, opcode, data = receive(self.rfile)
                        if opcode == 8:
                            break
                        if opcode == 9:
                            with gateway.ws_lock:
                                self.connection.sendall(frame(data, 10))
                            continue
                        if opcode == 10:
                            continue
                        if opcode == 1 and not fragmented:
                            chunks = bytearray(data)
                        elif opcode == 0 and fragmented:
                            chunks.extend(data)
                        else:
                            raise ValueError('WebSocket opcode')
                        if len(chunks) > MAX_MESSAGE:
                            raise ValueError('WebSocket size')
                        fragmented = not final
                        if final:
                            message = json.loads(chunks.decode('utf-8'))
                            if not isinstance(message, dict):
                                raise ValueError('RPC object')
                            gateway.forward(message)
                except (EOFError, OSError, ValueError):
                    pass
                finally:
                    gateway.broker.close()
                    self.close_connection = True

            def do_POST(self):
                if self.path != '/respond' or self.headers.get('Origin'):
                    self.reply({'ok': False}, 403)
                    return
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 4096:
                        raise ValueError('size')
                    payload = json.loads(exact(self.rfile, size))
                    ok = isinstance(payload, dict) and gateway.broker.answer(payload)
                    self.reply({'ok': ok}, 200 if ok else 409)
                except (ValueError, OSError):
                    self.reply({'ok': False}, 409)

        return Handler


def server_args(args: list[str]) -> list[str]:
    """TUI와 서버가 같은 설정을 읽는다. 프로필 훅은 공식 sessionFlags로 전달한다."""
    result = []
    index = 0
    while index < len(args):
        argument = args[index]
        if argument in ('-c', '--config'):
            result += ['-c', args[index + 1]]
            index += 2
        elif argument in ('-p', '--profile'):
            # 이 실행기는 hooks만 담는 위임 생성 프로필만 지원한다. 사용자 권한 프로필을
            # 조용히 버리지 않고 원래 로컬 CLI에서 사용하도록 오류로 돌려준다.
            role = os.environ.get('ATHENA_ROLE') or 'agent'
            expected = 'athena-dispatch-' + hashlib.sha256((str(ROOT.resolve()) + ':' + role).encode()).hexdigest()[:20]
            profile = args[index + 1]
            if profile != expected:
                raise ValueError('지원하지 않는 사용자 Codex 프로필')
            home = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
            content = (home / (profile + '.config.toml')).read_text(encoding='utf-8')
            if not content.startswith('# Athena generated delegation hooks\n[hooks]\n'):
                raise ValueError('위임 생성 프로필이 아닌 설정')
            sections = re.findall(r'^\[([^\n]+)\]', content, re.M)
            if any(section != 'hooks' and not section.startswith(('hooks.state', 'tui')) for section in sections):
                raise ValueError('지원하지 않는 위임 프로필 설정')
            index += 2
        elif argument in ('-m', '--model'):
            result += ['-c', 'model=' + json.dumps(args[index + 1])]
            index += 2
        elif argument == '--add-dir':
            # app-server CLI 인자에는 없다. 명시적 쓰기 루트 설정에 보존한다.
            index += 2
        elif argument.startswith('-') and argument not in ('--no-alt-screen', '--no-daemon'):
            raise ValueError('지원하지 않는 Codex 연결 인자: ' + argument)
        else:
            index += 1
    return result


def main() -> int:
    args = sys.argv[1:]
    hook_args = []
    if '--athena-hooks-file' in args:
        index = args.index('--athena-hooks-file')
        hooks = json.loads(pathlib.Path(args[index + 1]).read_text(encoding='utf-8'))
        hook_args = ['-c', 'hooks=' + codex_dispatch.toml(hooks)]
        del args[index:index + 2]
    pane = str(screen.self_info().get('pane_id') or '')
    if not pane or not (ROOT / '.pack-data').is_symlink():
        # Studio 밖 실행은 기존 CLI로 유지한다.
        return subprocess.call(['codex', *args])
    # 원격 TUI 자체가 공유 데몬을 쓰지 않는다. --remote와 배타적인 플래그는 여기서 소비한다.
    args = [argument for argument in args if argument != '--no-daemon']
    if any(argument in ('-p', '--profile') for argument in args) and not hook_args:
        raise ValueError('위임 훅 정의가 없는 프로필')
    forwarded = server_args(args) + hook_args
    # remote 재개는 저장된 지시를 고를 수 있으므로 이번 위임의 명시적 지시/모델/문서 한도도
    # 공식 thread 시작·재개 params에 전달한다. 승인 정책·기본 권한은 새로 만들지 않는다.
    overrides = {'cwd': os.getcwd()}
    for index, argument in enumerate(args[:-1]):
        if argument in ('-c', '--config'):
            key, separator, value = args[index + 1].partition('=')
            if separator and key.strip() in ('developer_instructions', 'project_doc_max_bytes'):
                parsed = json.loads(value)
                if key.strip() == 'developer_instructions':
                    overrides['developerInstructions'] = parsed
                else:
                    overrides.setdefault('config', {})['project_doc_max_bytes'] = parsed
        elif argument in ('-m', '--model'):
            overrides['model'] = args[index + 1]
    extra_roots = [args[index + 1] for index, argument in enumerate(args[:-1]) if argument == '--add-dir']
    # --add-dir는 remote TUI가 거절한다. 공식 turn params로 전달하고 TUI 인자에서는 소비한다.
    tui_args = []
    index = 0
    while index < len(args):
        if args[index] == '--add-dir':
            index += 2
        else:
            tui_args.append(args[index])
            index += 1

    registry = (ROOT / '.pack-data').resolve() / 'state/codex-connections'
    registry.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='athena-codex-', dir='/tmp') as directory:
        endpoint = str(pathlib.Path(directory) / 'rpc.sock')
        gateway = Gateway(['codex', 'app-server', '--stdio', *forwarded], pane, str(ROOT.resolve()), overrides, extra_roots)
        server = UnixServer(endpoint, gateway.handler())
        os.chmod(endpoint, 0o600)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        record = registry / (gateway.broker.generation + '.json')
        record.write_text(json.dumps({'socket': endpoint, 'pane': pane, 'body': str(ROOT.resolve()), 'generation': gateway.broker.generation}))
        record.chmod(0o600)
        tui = None
        def stop(_signum, _frame):
            if tui and tui.poll() is None:
                tui.terminate()
        previous = signal.signal(signal.SIGTERM, stop)
        try:
            tui = subprocess.Popen(['codex', '--remote', 'unix://' + endpoint, *tui_args])
            return tui.wait()
        finally:
            signal.signal(signal.SIGTERM, previous)
            gateway.broker.close()
            if tui and tui.poll() is None:
                tui.terminate()
                tui.wait(timeout=5)
            gateway.process.terminate()
            try:
                gateway.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                gateway.process.kill()
                gateway.process.wait()
            server.shutdown()
            server.server_close()
            record.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f'Codex 공식 승인 연결을 시작하지 못했다: {type(error).__name__}. 원래 pane에서 codex로 실행할 수 있다.', file=sys.stderr)
        raise SystemExit(1)
