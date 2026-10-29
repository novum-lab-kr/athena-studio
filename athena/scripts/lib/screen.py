"""화면 계층 — 아테나가 pane·탭·workspace 를 다루는 곳은 여기 하나다(scripts/screen CLI · node 쪽 scripts/lib/screen.mjs 가 이걸 부른다).

화면 백엔드는 studio(Athena Studio 자체 터미널 데몬) 하나다 — 그 밖이면 none(터미널 하나뿐). 아테나 스크립트는 아래 계약(동작 · 납작한 JSON)만 안다.
데몬 CLI(athena-studio-cli)·ATHENA_STUDIO_* 를 아는 건 StudioBackend 뿐이다.

백엔드 고르기 — 위에서부터:
  1. ATHENA_SCREEN=studio|none                      → 그 값(회귀 검사 · 한 번만 바꿀 때 · auto 면 다음으로)
  2. ATHENA_STUDIO=1(Studio pane 안)                → studio
  3. 이 아테나 폴더의 athena.config.json "screen"(studio·none — pane 밖에서만 쓰인다. auto · 모르는 값이면 다음으로)
  4. Studio 데몬 접속 파일(~/.athena-studio/daemon.json — pid·소켓이 살아 있을 때) → studio   (pane 밖 현황판 · 일반 터미널)
  5. 그 밖                                           → none
  pane 밖이어도 백엔드는 골라진다(plan-html 이 화면 밖에서 부르는 pane current · 현황판의 pane list).
  "pane 안인가" 는 inside() 가 따로 답한다(studio: ATHENA_STUDIO=1 + 데몬 CLI).

납작한 JSON(백엔드 모양을 감춘다 — id 는 불투명한 문자열, 부르는 쪽이 id 를 쪼개 읽지 않는다):
  Pane      {id, tab_id, workspace_id, label, name, pane_title, cwd, foreground_cwd, focused, agent, agent_status, title, cols, rows}
            label 은 백엔드가 준 이름표 그대로(없으면 null) — name·pane_title 로 채우지 않는다(도구 pane 찾기가 이름표만 본다).
            title 은 터미널 제목, pane_title 은 백엔드의 pane 제목 필드.
            cols · rows 는 pane 크기(글자 칸 수 — 2026-10-28 더함 · 추가만). 옛 데몬은 이 칸이 없다 — 부르는 쪽은 없거나 null 이면 크기를 모르는 것으로 다룬다(delegate.sh 배치)
  Tab       {id, workspace_id, label}
  Workspace {id, label, active_tab_id, focused}
  Self      {inside, backend, pane_id, tab_id, workspace_id}
            inside = 환경상 화면 pane 안에서 켜졌다(서버에 묻지 않음 — ATHENA_STUDIO=1).
            inside 동작(scripts/screen inside)은 그 위에 데몬 CLI 까지 있어 지금 조작할 수 있는지다
실패: 종료 코드 1 이상. 화면 계층이 낸 오류는 표준오류에 {"error": "<code>", "message": "…"}.
      데몬 CLI 가 이미 {"error","message"} 로 말하므로 그 code(usage · not_found · timeout · unavailable · internal)를 그대로 옮긴다.
      약속 밖 출력(node 가 죽음 등)은 그 출력·종료 코드를 그대로 흘려보낸다

주소 열기(open-url) — 화면이 브라우저를 품고 있으면 그 안에서 연다(studio: 그 본체 창의 옆 브라우저 · 데몬 op open-url → 앱).
  못 하면(none · 옛 데몬 · 붙은 앱 창 없음 · http(s) 가 아님) 기본 브라우저(맥 open · 그 밖 xdg-open)로 떨어진다 — 부르는 쪽은 늘 이것 하나만 부른다.
  결과 {ok, target: "panel"|"external", via: "studio"|"open"|"xdg-open"}

bash 에서:  "$ATHENA_DIR/scripts/screen" pane list --label "📋 현황판" --format id
파이썬에서: sys.path.insert(0, ATHENA_DIR + '/scripts/lib'); import screen
            me = screen.self_info(); panes = screen.list_panes(timeout=3)
"""
import json
import os
import shlex
import shutil
import subprocess
import sys

FORWARD_STDERR = False   # CLI(main)만 켠다 — 성공해도 데몬 CLI 의 경고를 표준오류로. 파이썬 훅은 받아 버린다

FEATURES_STUDIO = ['agent-status', 'process-info', 'workspaces']


class ScreenError(Exception):
    """code: usage · not_inside · unsupported · unavailable · backend.
    backend 오류는 백엔드가 낸 출력(stdout · stderr · 종료 코드)을 그대로 들고 있다 — CLI 가 그대로 흘려보낸다."""

    def __init__(self, code, message, stdout='', stderr='', returncode=1):
        super().__init__(message)
        self.code, self.message = code, message
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode or 1


def _realpath(path):
    return os.path.realpath(path) if path else ''


class Backend:
    """동작 계약. 백엔드가 못 하는 동작은 refusal() 오류로 실패한다(조용히 넘어가지 않는다).
    title 은 사용자 안내 글에 쓰는 이름("<title> 밖입니다") — scripts/screen name 이 돌려준다."""
    name = 'none'
    title = '화면 터미널'

    def refusal(self):
        return ScreenError('unsupported', f'{self.name} 화면 백엔드는 이 동작을 지원하지 않는다')

    def _no(self, *_args, **_kwargs):
        raise self.refusal()

    def features(self):
        return []

    def inside(self):
        return False

    def self_info(self):
        return {'inside': False, 'backend': self.name, 'pane_id': '', 'tab_id': '', 'workspace_id': ''}

    def open_url(self, url):
        """화면 안에서 주소를 열 수 있으면 {ok, target, via} · 못 하면 None(부르는 쪽이 기본 브라우저로)"""
        return None

    pane_current = list_panes = get_pane = is_shell = read = wait_output = _no
    list_tabs = get_tab = rename_tab = close_tab = list_workspaces = get_workspace = create_workspace = _no
    split = run = send_text = send_keys = rename = close = _no


class NoneBackend(Backend):
    """화면 계층 밖 — 터미널 하나뿐. 부르는 쪽이 원래 하던 대체 동작(nohup · 새 창 · 직접 실행 안내)을 한다."""
    name = 'none'
    title = 'Athena Studio 화면'

    def refusal(self):
        return ScreenError('not_inside', '화면 계층 밖이다(ATHENA_SCREEN=none · Athena Studio 밖)')


def _studio_endpoint():
    """Athena Studio 데몬 접속 파일(~/.athena-studio/daemon.json — 데몬이 쓴다: socket · cli · node · pid).
    pane 밖(앱이 띄우지 않은 현황판 · 일반 터미널)에서 studio 를 알아보는 데 쓴다. 데몬이 죽고 파일만 남았으면 없는 것으로 친다
    (pid 가 없거나 소켓이 없으면) — 낡은 파일 하나로 없는 데몬을 부르지 않게. ATHENA_STUDIO_ENDPOINT 로 자리를 바꿀 수 있다(회귀 검사용)"""
    path = os.environ.get('ATHENA_STUDIO_ENDPOINT') or os.path.join(os.path.expanduser('~'), '.athena-studio', 'daemon.json')
    try:
        with open(path, encoding='utf-8') as source:
            info = json.load(source)
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict):
        return None
    socket = info.get('socket')
    if socket and not os.path.exists(socket):
        return None
    pid = info.get('pid')
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        except PermissionError:
            pass   # 있지만 다른 사용자 — 살아 있다
    return info


class StudioBackend(Backend):
    """Athena Studio 자체 터미널 — 데몬 CLI(athena-studio-cli)를 부른다. 출력이 이미 납작한 JSON 이라 읽기만 한다.
    데몬 프로토콜 번호는 보지 않는다 — CLI 가 그 데몬과 같은 앱에서 오므로(접속 파일의 cli) 맞춰 보는 건 앱(S3) 몫이다. 프로토콜 3 까지 확인.
    pane list 에는 탭 밖 고정 칸(앱 하단 에이전트 모니터 — dock)이 섞인다: tab_id·workspace_id 가 null · 이름표 '🛰 에이전트 모니터'.
    탭·workspace 로 거르면 빠지고, 이름표로 찾으면 잡힌다(나눌 수는 없다 — 데몬이 usage). 지금 앱은 모니터를 앱 화면으로 그려 monitor-pane 은 studio 에서 띄우지 않는다
    CLI 실패: 종료 1 + 표준오류 {"error","message"} → 그 code 의 ScreenError · 데몬에 못 붙으면 종료 3 → unavailable.
    pane 안이면 데몬이 넣어 준 ATHENA_STUDIO=1 · ATHENA_STUDIO_PANE_ID · _TAB_ID · _WORKSPACE_ID · _SOCKET · _CLI · _NODE 를,
    pane 밖이면 접속 파일의 socket · cli · node 를 쓴다"""
    name = 'studio'
    title = 'Athena Studio'

    def features(self):
        return list(FEATURES_STUDIO)

    def _cli(self):
        # → (CLI 경로, 넘길 환경) · 못 찾으면 (None, None)
        env = dict(os.environ)
        cli = env.get('ATHENA_STUDIO_CLI', '')
        if not (cli and os.access(cli, os.X_OK)):
            cli = ''
        endpoint = None if cli and env.get('ATHENA_STUDIO_SOCKET') else _studio_endpoint()
        if endpoint:
            if not cli and endpoint.get('cli') and os.access(endpoint['cli'], os.X_OK):
                cli = endpoint['cli']
            # CLI 래퍼는 ATHENA_STUDIO_NODE(없으면 PATH 의 node)로 돈다 · CLI 는 ATHENA_STUDIO_SOCKET 이 없으면 접속 파일을 다시 읽는다
            if endpoint.get('socket') and not env.get('ATHENA_STUDIO_SOCKET'):
                env['ATHENA_STUDIO_SOCKET'] = endpoint['socket']
            if endpoint.get('node') and not env.get('ATHENA_STUDIO_NODE'):
                env['ATHENA_STUDIO_NODE'] = endpoint['node']
        cli = cli or shutil.which('athena-studio-cli') or ''
        return (cli, env) if cli else (None, None)

    def inside(self):
        return os.environ.get('ATHENA_STUDIO') == '1' and self._cli()[0] is not None

    def self_info(self):
        inside = os.environ.get('ATHENA_STUDIO') == '1'
        pick = lambda key: os.environ.get(key, '') if inside else ''  # noqa: E731
        return {'inside': inside, 'backend': 'studio', 'pane_id': pick('ATHENA_STUDIO_PANE_ID'), 'tab_id': pick('ATHENA_STUDIO_TAB_ID'),
                'workspace_id': pick('ATHENA_STUDIO_WORKSPACE_ID')}

    def _run(self, args, timeout=None):
        cli, env = self._cli()
        if not cli:
            raise ScreenError('unavailable', 'Athena Studio 데몬 CLI(athena-studio-cli)를 찾지 못했다 — 앱을 켜면 데몬이 뜬다')
        try:
            done = subprocess.run([cli, *args], capture_output=True, text=True, timeout=timeout, env=env)
        except (FileNotFoundError, PermissionError):
            raise ScreenError('unavailable', f'Athena Studio 데몬 CLI 를 실행하지 못했다: {cli}')
        if FORWARD_STDERR and done.returncode == 0 and done.stderr:
            sys.stderr.write(done.stderr)
        return done

    def _fail(self, args, done):
        what = ' '.join(args[:2])
        try:
            error = json.loads(done.stderr.strip().splitlines()[-1])
            code, message = error['error'], error['message']
        except (ValueError, KeyError, TypeError, IndexError):
            # CLI 가 약속한 모양으로 말하지 못했다(node 가 죽음 등) — 출력을 그대로 들고 backend 오류로
            return ScreenError('unavailable' if done.returncode == 3 else 'backend', f'studio {what} 실패', done.stdout, done.stderr, done.returncode)
        if done.returncode == 3:
            code = 'unavailable'
        return ScreenError(code, f'studio {what}: {message}')

    def _call(self, args, timeout=None, parse=True):
        done = self._run(args, timeout)
        if done.returncode != 0:
            raise self._fail(args, done)
        if not parse:
            return done.stdout
        try:
            return json.loads(done.stdout)
        except ValueError:
            raise ScreenError('backend', f'studio {" ".join(args[:2])} 응답을 읽지 못했다', done.stdout, done.stderr)

    def open_url(self, url):
        # 옆 브라우저는 http(s) 만 연다 — 파일 경로 등은 기본 브라우저로. 데몬이 op 를 모르거나(옛 데몬) · 붙은 앱 창이 없거나 · 못 붙으면 None
        if not url.startswith(('http://', 'https://')):
            return None
        try:
            result = self._call(['open-url', url], timeout=10)
        except (ScreenError, subprocess.TimeoutExpired):
            return None
        if not isinstance(result, dict) or result.get('target') not in ('panel', 'external'):
            return None
        return {'ok': True, 'target': result['target'], 'via': 'studio'}

    # 조회
    def pane_current(self):
        return self._call(['pane', 'current'])['pane']

    def list_panes(self, timeout=None):
        return self._call(['pane', 'list'], timeout=timeout)['panes']

    def get_pane(self, pane):
        return self._call(['pane', 'get', pane])['pane']

    def is_shell(self, pane):
        # 빈 셸이면 0 — 종료 코드로만 답한다. 확인 못 하면 False(돌고 있는 것을 건드리지 않는 쪽으로)
        if not pane:
            return False
        try:
            return self._run(['pane', 'is-shell', pane]).returncode == 0
        except ScreenError:
            return False

    def read(self, pane, options):
        # 읽기 옵션은 그대로 — 데몬이 못 하는 것(--format · --ansi · --raw · recent-unwrapped)은 CLI 가 usage 로 거절한다
        return self._call(['pane', 'read', pane, *options], parse=False)

    def wait_output(self, pane, options):
        return self._call(['pane', 'wait-output', pane, *options], parse=False)

    def list_tabs(self, workspace=None):
        # 데몬이 거르지만 계약은 화면 계층이 지킨다
        tabs = self._call(['tab', 'list', *(['--workspace', workspace] if workspace is not None else [])])['tabs']
        return [tab for tab in tabs if workspace is None or tab.get('workspace_id') == workspace]

    def get_tab(self, tab):
        return self._call(['tab', 'get', tab])['tab']

    def rename_tab(self, tab, label):
        self._call(['tab', 'rename', tab, label], parse=False)

    def close_tab(self, tab):
        self._call(['tab', 'close', tab], parse=False)

    def list_workspaces(self):
        return self._call(['workspace', 'list'])['workspaces']

    def get_workspace(self, workspace):
        return self._call(['workspace', 'get', workspace])['workspace']

    def create_workspace(self, label, cwd, focus=None):
        # 데몬은 빈 셸 탭 하나와 함께 만든다(root_pane) — 계약은 workspace 만 돌려준다
        args = ['workspace', 'create', '--label', label, '--cwd', cwd]
        if focus is not None:
            args.append('--focus' if focus else '--no-focus')
        return self._call(args)['workspace']

    # 바꾸기
    def split(self, target, direction, ratio=None, cwd=None, env=(), focus=None):
        # self 는 CLI 가 ATHENA_STUDIO_PANE_ID 로 푼다(없으면 포커스된 pane) — 환경을 그대로 넘긴다
        args = ['pane', 'split', '--target', target, '--direction', direction]
        if ratio is not None:
            args += ['--ratio', ratio]
        if cwd is not None:
            args += ['--cwd', cwd]
        for pair in env:
            args += ['--env', pair]
        if focus is not None:
            args.append('--focus' if focus else '--no-focus')
        return self._call(args)['pane']

    def run(self, pane, words):
        # 단어를 따옴표 없이 공백으로 이어 한 줄 + Enter(데몬이 \r) — 따옴표가 필요하면 부르는 쪽이 한 줄로 만들어 넘긴다
        self._call(['pane', 'run', pane, *words], parse=False)

    def send_text(self, pane, text):
        self._call(['pane', 'send-text', pane, text], parse=False)

    def send_keys(self, pane, keys):
        self._call(['pane', 'send-keys', pane, *keys], parse=False)

    def rename(self, pane, label):
        self._call(['pane', 'rename', pane, label], parse=False)

    def close(self, pane):
        self._call(['pane', 'close', pane], parse=False)


BACKENDS = {'studio': StudioBackend, 'none': NoneBackend}


def _configured_screen():
    """이 아테나 폴더의 athena.config.json(이 컴퓨터 설정) "screen" — studio·none·auto 문자열만. 없거나 읽지 못하거나 다른 값(옛 설정에 남은 다른 백엔드 이름 등)이면 ''(자동)."""
    config = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'athena.config.json')
    try:
        with open(config, encoding='utf-8') as config_file:
            value = json.load(config_file).get('screen')
    except (OSError, ValueError, AttributeError):
        return ''
    return value if value in ('studio', 'none', 'auto') else ''


def backend_name():
    # 1) 환경 변수(회귀 검사·한 번만 바꿀 때) → 2) Studio pane 안 표시(데몬이 넣어 준 ATHENA_STUDIO=1) → 3) 이 아테나 폴더 설정 "screen"
    # → 4) pane 밖이면 떠 있는 Studio 데몬(접속 파일) → none.
    # pane 안 표시가 설정보다 먼저다 — 설정 "screen":"none" 이어도 Studio pane 안 아테나·delegate 는 그 화면에 pane 을 만든다
    name = os.environ.get('ATHENA_SCREEN', '')
    if name and name != 'auto':
        return name
    if os.environ.get('ATHENA_STUDIO') == '1':
        return 'studio'
    configured = _configured_screen()
    if configured and configured != 'auto':
        return configured
    if _studio_endpoint():
        return 'studio'
    return 'none'


def open_external(url):
    """기본 브라우저로 — 맥 open · 그 밖 xdg-open(원래 스크립트가 하던 그대로). 둘 다 없으면 unavailable"""
    for opener in ('open', 'xdg-open'):
        path = shutil.which(opener)
        if not path:
            continue
        done = subprocess.run([path, url], capture_output=True, text=True, timeout=15)
        if done.returncode != 0:
            raise ScreenError('backend', f'{opener} 실패', done.stdout, done.stderr, done.returncode)
        return {'ok': True, 'target': 'external', 'via': opener}
    raise ScreenError('unavailable', '브라우저를 열 명령이 없다(open · xdg-open)')


def open_url(url):
    """화면 안에서 열 수 있으면 거기서(studio 옆 브라우저), 아니면 기본 브라우저로"""
    return get_backend().open_url(url) or open_external(url)


def get_backend():
    name = backend_name()
    if name not in BACKENDS:
        raise ScreenError('usage', f'모르는 화면 백엔드: ATHENA_SCREEN={name} (studio · none)')
    return BACKENDS[name]()


# 파이썬 훅용 짧은 이름
def self_info():
    return get_backend().self_info()


def inside():
    return get_backend().inside()


def list_panes(timeout=None):
    return get_backend().list_panes(timeout=timeout)


# ── CLI (scripts/screen) ────────────────────────────────────────────────
USAGE = """사용: scripts/screen <동작> …   (결과는 납작한 JSON · 실패면 종료 코드 1 이상)
  self [--format json|sh]                      부른 pane(환경에서 — 서버에 묻지 않음) · sh 는 eval 용 SCREEN_* 변수
  inside                                       화면 pane 안이면 0
  name                                         안내 글에 쓸 화면 이름 한 줄(Athena Studio …)
  capabilities [--has <기능>[,<기능>…]]          백엔드 기능 목록 · --has 는 다 있으면 0
  pane current                                 서버가 정한 지금 pane(self 와 다르다 — 환경이 없으면 포커스된 pane)
  pane list [--tab T] [--workspace W] [--label L] [--cwd D] [--agent-only] [--prefer-tab T] [--prefer-workspace W]
                                               (T·W 에 self 를 쓰면 부른 pane 의 탭·workspace) · --cwd 는 cwd 나 foreground_cwd 의 실제 경로가 D 인 것
  pane get <pane> · pane is-shell <pane>(빈 셸이면 0)
  pane read <pane> [--lines N] [--source S]    출력 그대로(글자 · 데몬이 못 하는 옵션 --read-format · --ansi · --raw 는 usage)
  pane wait-output <pane> (--match T | --regex R) [--timeout MS] [--lines N] [--source S] [--raw]
  pane split --target <id|self|focused> --direction right|down [--ratio R] [--cwd D] [--env K=V]… [--focus|--no-focus]
  pane run <pane> <단어>…                      단어를 공백으로 이어 붙인 한 줄을 그 pane 셸에 친다(따옴표 없음)
  pane send-text <pane> <글> [--enter](글 뒤 Enter 까지) · pane send-keys <pane> <키>… (Enter · C-c) · pane rename <pane> <이름> · pane close <pane>
  tab list [--workspace W] · tab get <tab> · tab rename <tab> <이름> · tab close <tab>
  workspace list · workspace get <w> · workspace create --label L --cwd D [--focus|--no-focus]
  open-url <주소>                              studio 면 그 본체 창의 옆 브라우저(localhost) · 못 하면(none · 옛 데몬) 기본 브라우저(open)
  공통: --format json(기본) | id(첫 대상의 id 한 줄) | ids(한 줄에 하나)
  백엔드: ATHENA_SCREEN=studio|none → pane 안 표시(ATHENA_STUDIO=1 → studio)
         → athena.config.json screen → Studio 데몬 접속 파일 → none"""

VALUE_FLAGS = {'--format', '--has', '--tab', '--workspace', '--label', '--read-format', '--cwd', '--prefer-tab', '--prefer-workspace',
               '--target', '--direction', '--ratio', '--env', '--lines', '--source', '--match', '--regex', '--timeout'}
BOOL_FLAGS = {'--agent-only', '--focus', '--no-focus', '--ansi', '--raw'}


def _parse(args):
    """--플래그 값 · 자리 인자. --env 는 여러 번. pane run · send-text 는 부르는 쪽에서 나눠 받는다(단어에 - 가 있어도 그대로)"""
    flags, positional, index = {}, [], 0
    while index < len(args):
        arg = args[index]
        if arg in VALUE_FLAGS:
            if index + 1 >= len(args):
                raise ScreenError('usage', f'{arg} 에 값이 없다')
            if arg == '--env':
                flags.setdefault('--env', []).append(args[index + 1])
            else:
                flags[arg] = args[index + 1]
            index += 2
        elif arg in BOOL_FLAGS:
            flags[arg] = True
            index += 1
        elif arg.startswith('--'):
            raise ScreenError('usage', f'모르는 옵션: {arg}')
        else:
            positional.append(arg)
            index += 1
    return flags, positional


def _focus(flags):
    if flags.get('--focus'):
        return True
    if flags.get('--no-focus'):
        return False
    return None


def _need(positional, count, what):
    if len(positional) < count:
        raise ScreenError('usage', f'{what} 가 없다')
    return positional


def _filter_panes(screen, panes, flags):
    me = screen.self_info()
    resolve = lambda value, key: me[key] if value == 'self' else value  # noqa: E731
    if '--tab' in flags:
        panes = [p for p in panes if p['tab_id'] == resolve(flags['--tab'], 'tab_id')]
    if '--workspace' in flags:
        panes = [p for p in panes if p['workspace_id'] == resolve(flags['--workspace'], 'workspace_id')]
    if '--label' in flags:
        panes = [p for p in panes if p['label'] == flags['--label']]
    if '--cwd' in flags:
        root = _realpath(flags['--cwd'])
        panes = [p for p in panes if (p['cwd'] and _realpath(p['cwd']) == root) or (p['foreground_cwd'] and _realpath(p['foreground_cwd']) == root)]
    if flags.get('--agent-only'):
        panes = [p for p in panes if p['agent']]
    # 우선순위는 정렬로(안정 정렬 — 같은 순위 안에서는 백엔드가 준 순서 그대로)
    if flags.get('--prefer-workspace') and resolve(flags['--prefer-workspace'], 'workspace_id'):
        want = resolve(flags['--prefer-workspace'], 'workspace_id')
        panes = sorted(panes, key=lambda p: p['workspace_id'] != want)
    if flags.get('--prefer-tab') and resolve(flags['--prefer-tab'], 'tab_id'):
        want = resolve(flags['--prefer-tab'], 'tab_id')
        panes = sorted(panes, key=lambda p: p['tab_id'] != want)
    return panes


def _dispatch(screen, words, flags, positional, raw_rest):
    """→ (출력 객체 | None, 종료 코드)"""
    op = ' '.join(words)
    if op == 'self':
        return screen.self_info(), 0
    if op == 'inside':
        return None, 0 if screen.inside() else 1
    if op == 'name':
        return {'text': screen.title + '\n'}, 0
    if op == 'open-url':
        url = _need(positional, 1, '주소')[0]
        return screen.open_url(url) or open_external(url), 0
    if op == 'capabilities':
        features = screen.features()
        if '--has' in flags:
            return None, 0 if all(f in features for f in flags['--has'].split(',') if f) else 1
        return {'backend': screen.name, 'features': features}, 0
    if op == 'pane current':
        return {'pane': screen.pane_current()}, 0
    if op == 'pane list':
        return {'panes': _filter_panes(screen, screen.list_panes(), flags)}, 0
    if op == 'pane get':
        return {'pane': screen.get_pane(_need(positional, 1, 'pane')[0])}, 0
    if op == 'pane is-shell':
        try:
            return None, 0 if screen.is_shell(positional[0] if positional else '') else 1
        except ScreenError:
            return None, 1   # 확인 못 하면 1 — 돌고 있는 것을 건드리지 않는 쪽으로
    if op in ('pane read', 'pane wait-output'):
        pane = _need(positional, 1, 'pane')[0]
        # 읽기 옵션을 그대로 넘긴다 — --format 은 출력 형식(json·id)과 겹쳐 --read-format 으로 받는다(데몬이 못 하면 usage)
        options = [item for key in ('--source', '--lines', '--match', '--regex', '--timeout') if key in flags for item in (key, flags[key])]
        if '--read-format' in flags:
            options += ['--format', flags['--read-format']]
        options += [key for key in ('--ansi', '--raw') if flags.get(key)]
        text = (screen.read if op == 'pane read' else screen.wait_output)(pane, options)
        return {'text': text}, 0
    if op == 'pane split':
        if '--target' not in flags or '--direction' not in flags:
            raise ScreenError('usage', 'pane split --target <id|self|focused> --direction right|down')
        return {'pane': screen.split(flags['--target'], flags['--direction'], flags.get('--ratio'), flags.get('--cwd'), flags.get('--env', []), _focus(flags))}, 0
    if op == 'pane run':
        _need(raw_rest, 2, 'pane 과 명령')
        screen.run(raw_rest[0], raw_rest[1:])
        return None, 0
    if op == 'pane send-text':
        _need(raw_rest, 2, 'pane 과 글')
        # 끝의 --enter 는 글 넣기 뒤 Enter 까지 한 명령으로(글 넣기가 실패하면 예외로 빠져 Enter 를 보내지 않는다).
        # 글 자리가 '--enter' 인 경우(인자 둘)는 글이다 — 셋일 때 마지막만 플래그
        if len(raw_rest) > 3 or (len(raw_rest) == 3 and raw_rest[2] != '--enter'):
            raise ScreenError('usage', 'pane send-text <pane> <글> [--enter]')
        screen.send_text(raw_rest[0], raw_rest[1])
        if len(raw_rest) == 3:
            screen.send_keys(raw_rest[0], ['Enter'])
        return None, 0
    if op == 'pane send-keys':
        _need(raw_rest, 2, 'pane 과 키')
        screen.send_keys(raw_rest[0], raw_rest[1:])
        return None, 0
    if op == 'pane rename':
        _need(raw_rest, 2, 'pane 과 이름')
        screen.rename(raw_rest[0], raw_rest[1])
        return None, 0
    if op == 'pane close':
        screen.close(_need(positional, 1, 'pane')[0])
        return None, 0
    if op == 'tab list':
        return {'tabs': screen.list_tabs(flags.get('--workspace'))}, 0
    if op == 'tab get':
        return {'tab': screen.get_tab(_need(positional, 1, 'tab')[0])}, 0
    if op == 'tab rename':
        _need(raw_rest, 2, 'tab 과 이름')
        screen.rename_tab(raw_rest[0], raw_rest[1])
        return None, 0
    if op == 'tab close':
        screen.close_tab(_need(positional, 1, 'tab')[0])
        return None, 0
    if op == 'workspace list':
        return {'workspaces': screen.list_workspaces()}, 0
    if op == 'workspace get':
        return {'workspace': screen.get_workspace(_need(positional, 1, 'workspace')[0])}, 0
    if op == 'workspace create':
        if '--label' not in flags or '--cwd' not in flags:
            raise ScreenError('usage', 'workspace create --label L --cwd D')
        return {'workspace': screen.create_workspace(flags['--label'], flags['--cwd'], _focus(flags))}, 0
    raise ScreenError('usage', f'모르는 동작: {op or "(없음)"} — scripts/screen --help')


def _print(result, fmt):
    if result is None:
        return
    if fmt == 'sh':
        sys.stdout.write(''.join(f'SCREEN_{key.upper()}={shlex.quote(str(int(value)) if isinstance(value, bool) else str(value or ""))}\n' for key, value in result.items()))
    elif fmt in ('id', 'ids'):
        if 'text' in result:
            sys.stdout.write(result['text'])
            return
        items = next((value for value in result.values() if isinstance(value, list)), None)
        if items is None:
            items = [next(iter(result.values()))] if result else []
        ids = [item.get('id') or '' for item in items if isinstance(item, dict)]
        sys.stdout.write((ids[0] if ids else '') + '\n' if fmt == 'id' else ''.join(f'{value}\n' for value in ids))
    elif 'text' in result:
        sys.stdout.write(result['text'])   # read · wait-output 은 사람·에이전트가 읽는 글자 그대로
    else:
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')


def main(argv):
    global FORWARD_STDERR
    FORWARD_STDERR = True
    if not argv or argv[0] in ('-h', '--help', 'help'):
        print(USAGE)
        return 0 if argv else 2
    # 동작 이름(한두 단어) — pane run · send-text · rename 뒤는 손대지 않고 그대로 넘긴다(단어가 - 로 시작해도)
    count = 1 if argv[0] in ('self', 'inside', 'name', 'capabilities', 'open-url') else 2
    words, rest = argv[:count], argv[count:]
    raw_ops = ('pane run', 'pane send-text', 'pane send-keys', 'pane rename', 'tab rename')
    fmt = 'json'
    try:
        if ' '.join(words) in raw_ops:
            flags, positional, raw_rest = {}, [], rest
        else:
            flags, positional = _parse(rest)
            raw_rest = positional
            fmt = flags.get('--format', 'json')
            if fmt not in ('json', 'id', 'ids', 'sh'):
                raise ScreenError('usage', f'--format 은 json · id · ids · sh: {fmt}')
        screen = get_backend()
        result, code = _dispatch(screen, words, flags, positional, raw_rest)
    except ScreenError as error:
        if error.code == 'backend':
            # 백엔드가 낸 글자를 그대로(json 일 때만 표준출력. id 는 비워 둔다 — 부르는 쪽이 오류 글을 id 로 읽지 않게)
            (sys.stdout if fmt == 'json' else sys.stderr).write(error.stdout)
            sys.stderr.write(error.stderr)
            return error.returncode
        sys.stderr.write(json.dumps({'error': error.code, 'message': error.message}, ensure_ascii=False) + '\n')
        return 2 if error.code == 'usage' else 1
    except subprocess.TimeoutExpired:
        sys.stderr.write(json.dumps({'error': 'timeout', 'message': '화면 백엔드가 제때 답하지 않았다'}, ensure_ascii=False) + '\n')
        return 1
    _print(result, fmt)
    return code
