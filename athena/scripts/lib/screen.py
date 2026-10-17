"""화면 계층 — 아테나가 pane·탭·workspace 를 다루는 곳은 여기 하나다(scripts/screen CLI · node 쪽 scripts/lib/screen.mjs 가 이걸 부른다).

화면 백엔드는 herdr 와 studio(Athena Studio 자체 터미널 데몬) 둘이다 — 둘 다 같은 계약(아래 동작 · 납작한 JSON)이라 아테나 스크립트는 그대로 쓴다.
아테나 코드는 herdr·studio 를 직접 부르지 않는다 — herdr 명령·HERDR_* 환경 변수·herdr JSON 모양을 아는 건 HerdrBackend,
데몬 CLI(athena-studio-cli)·ATHENA_STUDIO_* 를 아는 건 StudioBackend 뿐이다
(예외: herdr 플러그인 자체를 다루는 scripts/herdr-sidebar-*.sh — scripts/screen-lint.sh 허용 목록).

백엔드 고르기 — ATHENA_SCREEN=herdr|studio|none → 없으면 이 아테나 폴더의 athena.config.json "screen"(같은 값 —
  아테나를 화면마다 한 벌씩 둘 때 고정한다: herdr 용 ~/athena 는 herdr, Studio 전용 아테나는 studio) → 없거나 auto 면 위에서부터
  (둘 다 켜 있어도 스크립트가 그대로 돈다 — 공존):
  1. HERDR_ENV=1 이거나 HERDR_PANE_ID 가 있다(herdr pane 안) → herdr
     (Studio 데몬은 pane 셸에서 HERDR_* 를 지운다 — 둘 다 있으면 Studio pane 안에서 켠 herdr 이고 안쪽인 herdr 가 맞다)
  2. ATHENA_STUDIO=1(Studio pane 안)                → studio
  3. Studio 데몬 접속 파일(~/.athena-studio/daemon.json — pid·소켓이 살아 있을 때) → studio   (pane 밖 현황판 · 일반 터미널)
  4. herdr 명령이 있다                                → herdr
  5. 그 밖                                           → none
  pane 밖이어도 백엔드는 골라진다 — 원래 스크립트가 그 자리에서 herdr 를 바로 불렀다(plan-html 의 pane current · 현황판의 pane list).
  "pane 안인가" 는 inside() 가 따로 답한다(herdr: HERDR_ENV=1 + herdr 명령 · studio: ATHENA_STUDIO=1 + 데몬 CLI).

납작한 JSON(백엔드 모양을 감춘다 — id 는 불투명한 문자열, 부르는 쪽이 id 를 쪼개 읽지 않는다):
  Pane      {id, tab_id, workspace_id, label, name, pane_title, cwd, foreground_cwd, focused, agent, agent_status, title}
            label 은 백엔드가 준 이름표 그대로(없으면 null) — name·pane_title 로 채우지 않는다(도구 pane 찾기가 이름표만 본다).
            title 은 터미널 제목, pane_title 은 백엔드의 pane 제목 필드(herdr title)
  Tab       {id, workspace_id, label}
  Workspace {id, label, active_tab_id, focused}
  Layout    {area:{x,y,width,height}, panes:[{id, rect:{x,y,width,height}}]}
  Self      {inside, backend, pane_id, tab_id, workspace_id}
            inside = 환경상 화면 pane 안에서 켜졌다(서버에 묻지 않음 — herdr 면 HERDR_ENV=1 · studio 면 ATHENA_STUDIO=1).
            inside 동작(scripts/screen inside)은 그 위에 백엔드 명령까지 있어 지금 조작할 수 있는지다(herdr 면 + herdr 명령)
실패: 종료 코드 1 이상. 화면 계층이 낸 오류는 표준오류에 {"error": "<code>", "message": "…"}.
      herdr 가 실패하면 그 출력·종료 코드를 그대로 흘려보낸다 — 원래 스크립트가 오류 안내에 넣던 글자가 그대로 남게.
      studio 는 데몬 CLI 가 이미 {"error","message"} 로 말하므로 그 code(usage · not_found · timeout · unavailable · internal)를 그대로 옮긴다

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

FORWARD_STDERR = False   # CLI(main)만 켠다 — 성공해도 herdr 의 경고를 표준오류로(원래 bash 에서처럼). 파이썬 훅은 원래도 받아 버렸다

FEATURES_HERDR = ['agent-status', 'process-info', 'layout-geometry', 'pane-move', 'workspaces', 'herdr-sidebar']
# studio — 고정 배치(layout-geometry · pane-move)·herdr 사이드바는 없다 → athena-layout · 사이드바는 저절로 건너뛴다
FEATURES_STUDIO = ['agent-status', 'process-info', 'workspaces']


class ScreenError(Exception):
    """code: usage · not_inside · unsupported · unavailable · backend.
    backend 오류는 백엔드가 낸 출력(stdout · stderr · 종료 코드)을 그대로 들고 있다 — CLI 가 그대로 흘려보낸다(원래 스크립트가 받던 그 글자)."""

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

    pane_current = list_panes = get_pane = layout = is_shell = read = wait_output = _no
    list_tabs = get_tab = rename_tab = close_tab = list_workspaces = get_workspace = create_workspace = _no
    split = run = send_text = send_keys = rename = swap = move = close = _no


class NoneBackend(Backend):
    """화면 계층 밖 — 터미널 하나뿐. 부르는 쪽이 원래 하던 대체 동작(nohup · 새 창 · 직접 실행 안내)을 한다."""
    name = 'none'
    title = '화면 터미널(herdr · Athena Studio)'

    def refusal(self):
        return ScreenError('not_inside', '화면 계층 밖이다(ATHENA_SCREEN=none · herdr 없음)')


def _studio_endpoint():
    """Athena Studio 데몬 접속 파일(~/.athena-studio/daemon.json — 데몬이 쓴다: socket · cli · node · pid).
    pane 밖(앱이 띄우지 않은 현황판 · 일반 터미널)에서 studio 를 알아보는 데 쓴다. 데몬이 죽고 파일만 남았으면 없는 것으로 친다
    (pid 가 없거나 소켓이 없으면) — 낡은 파일 하나로 herdr 를 못 쓰게 되지 않게. ATHENA_STUDIO_ENDPOINT 로 자리를 바꿀 수 있다(회귀 검사용)"""
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
    탭·workspace 로 거르면 빠지고, 이름표로 찾으면 잡혀 monitor-pane 이 새로 띄우지 않고 그 칸을 다시 쓴다(나눌 수는 없다 — 데몬이 usage)
    CLI 실패: 종료 1 + 표준오류 {"error","message"} → 그 code 의 ScreenError · 데몬에 못 붙으면 종료 3 → unavailable.
    pane 안이면 데몬이 넣어 준 ATHENA_STUDIO=1 · ATHENA_STUDIO_PANE_ID · _TAB_ID · _WORKSPACE_ID · _SOCKET · _CLI · _NODE 를,
    pane 밖이면 접속 파일의 socket · cli · node 를 쓴다. 고정 배치(layout · move · swap)·herdr 사이드바는 없다 — features 에서 끈다"""
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
        # 데몬이 거르지만 계약은 화면 계층이 지킨다(herdr 백엔드와 같게)
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
        # 데몬은 빈 셸 탭 하나와 함께 만든다(root_pane) — 계약은 workspace 만 돌려준다(herdr 와 같게)
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
        # herdr 계약 그대로 — 단어를 공백으로 이어 한 줄 + Enter(데몬이 \r)
        self._call(['pane', 'run', pane, *words], parse=False)

    def send_text(self, pane, text):
        self._call(['pane', 'send-text', pane, text], parse=False)

    def send_keys(self, pane, keys):
        self._call(['pane', 'send-keys', pane, *keys], parse=False)

    def rename(self, pane, label):
        self._call(['pane', 'rename', pane, label], parse=False)

    def close(self, pane):
        self._call(['pane', 'close', pane], parse=False)


def _pane(raw):
    # label·name·pane_title 은 따로 둔다 — 합치면 이름표 없는 pane 이 제목만으로 도구 pane 처럼 잡힌다(보여 줄 이름은 부르는 쪽이 고른다)
    return {
        'id': raw.get('pane_id'), 'tab_id': raw.get('tab_id'), 'workspace_id': raw.get('workspace_id'),
        'label': raw.get('label') or None, 'name': raw.get('name') or None, 'pane_title': raw.get('title') or None,
        'cwd': raw.get('cwd'), 'foreground_cwd': raw.get('foreground_cwd'), 'focused': bool(raw.get('focused')),
        'agent': raw.get('agent') or None, 'agent_status': raw.get('agent_status') or None,
        'title': raw.get('terminal_title_stripped') or None,
    }


def _workspace(raw):
    return {'id': raw.get('workspace_id'), 'label': raw.get('label'), 'active_tab_id': raw.get('active_tab_id'), 'focused': bool(raw.get('focused'))}


class HerdrBackend(Backend):
    name = 'herdr'
    title = 'herdr'

    def features(self):
        return list(FEATURES_HERDR)

    def inside(self):
        return os.environ.get('HERDR_ENV') == '1' and shutil.which('herdr') is not None

    def self_info(self):
        pane = os.environ.get('HERDR_PANE_ID', '')
        # herdr id 는 "<workspace>:<pane>" — 쪼개 읽는 건 백엔드 몫이다(monitor-pane 이 하던 그대로: ':' 가 없으면 비움)
        return {'inside': os.environ.get('HERDR_ENV') == '1', 'backend': 'herdr', 'pane_id': pane, 'tab_id': os.environ.get('HERDR_TAB_ID', ''),
                'workspace_id': pane.split(':')[0] if ':' in pane else ''}

    def _call(self, args, timeout=None, parse=True):
        try:
            done = subprocess.run(['herdr', *args], capture_output=True, text=True, timeout=timeout)
        except FileNotFoundError:
            raise ScreenError('unavailable', 'herdr 명령을 찾지 못했다')
        if FORWARD_STDERR and done.returncode == 0 and done.stderr:
            sys.stderr.write(done.stderr)
        if done.returncode != 0:
            raise ScreenError('backend', f'herdr {" ".join(args[:2])} 실패', done.stdout, done.stderr, done.returncode)
        if not parse:
            return done.stdout
        try:
            return json.loads(done.stdout)['result']
        except (ValueError, KeyError, TypeError):
            raise ScreenError('backend', f'herdr {" ".join(args[:2])} 응답을 읽지 못했다', done.stdout, done.stderr)

    # 조회
    def pane_current(self):
        return _pane(self._call(['pane', 'current'])['pane'])

    def list_panes(self, timeout=None):
        return [_pane(raw) for raw in self._call(['pane', 'list'], timeout=timeout)['panes']]

    def get_pane(self, pane):
        return _pane(self._call(['pane', 'get', pane])['pane'])

    def layout(self, pane):
        lay = self._call(['pane', 'layout', '--pane', pane])['layout']
        return {'area': lay['area'], 'panes': [{'id': rect['pane_id'], 'rect': rect['rect']} for rect in lay['panes']]}

    def is_shell(self, pane):
        # 빈 셸(프롬프트에서 대기 — 안에서 도는 프로그램 없음)이면 True. 확인 못 하면 False — 돌고 있는 것을 건드리지 않는 쪽으로
        if not pane:
            return False
        try:
            info = self._call(['pane', 'process-info', '--pane', pane])['process_info']
        except (ScreenError, KeyError, TypeError):
            return False
        return info.get('foreground_process_group_id') == info.get('shell_pid')

    def read(self, pane, options):
        return self._call(['pane', 'read', *options, pane], parse=False)

    def wait_output(self, pane, options):
        return self._call(['pane', 'wait-output', *options, pane], parse=False)

    def list_tabs(self, workspace=None):
        tabs = [{'id': raw.get('tab_id'), 'workspace_id': raw.get('workspace_id'), 'label': raw.get('label')} for raw in self._call(['tab', 'list'])['tabs']]
        return [tab for tab in tabs if workspace is None or tab['workspace_id'] == workspace]

    def get_tab(self, tab):
        # herdr 탭 id 는 "<workspace>:<tab>" — 서버에 묻지 않고 id 에서 읽는다(athena-layout 이 하던 ${TAB%%:*} 그대로 · herdr 를 더 부르지 않게)
        return {'id': tab, 'workspace_id': tab.split(':', 1)[0], 'label': None}

    def rename_tab(self, tab, label):
        self._call(['tab', 'rename', tab, label], parse=False)

    def close_tab(self, tab):
        self._call(['tab', 'close', tab], parse=False)

    def list_workspaces(self):
        return [_workspace(raw) for raw in self._call(['workspace', 'list'])['workspaces']]

    def get_workspace(self, workspace):
        return _workspace(self._call(['workspace', 'get', workspace])['workspace'])

    def create_workspace(self, label, cwd, focus=None):
        args = ['workspace', 'create', '--label', label, '--cwd', cwd]
        if focus is not None:
            args.append('--focus' if focus else '--no-focus')
        return _workspace(self._call(args)['workspace'])

    # 바꾸기
    def split(self, target, direction, ratio=None, cwd=None, env=(), focus=None):
        # target: self = 부른 pane(모르면 포커스된 pane) · focused = 포커스된 pane · 그 밖 = pane id.
        # herdr 인자는 원래 스크립트가 쓰던 그대로 — self 는 --pane <id>, id 는 자리 인자(둘 다 herdr 에서 같은 뜻)
        if target == 'self':
            pane = os.environ.get('HERDR_PANE_ID', '')
            where = ['--pane', pane] if pane else ['--current']
        elif target == 'focused':
            where = ['--current']
        else:
            where = [target]
        args = ['pane', 'split', *where, '--direction', direction]
        if ratio is not None:
            args += ['--ratio', ratio]
        if cwd is not None:
            args += ['--cwd', cwd]
        for pair in env:
            args += ['--env', pair]
        if focus is not None:
            args.append('--focus' if focus else '--no-focus')
        return _pane(self._call(args)['pane'])

    def run(self, pane, words):
        # herdr 는 단어를 따옴표 없이 공백으로 이어 붙여 그 pane 의 셸에 한 줄로 친다 — 계약 그대로 둔다(따옴표가 필요하면 부르는 쪽이 한 줄로 만들어 넘긴다)
        self._call(['pane', 'run', pane, *words], parse=False)

    def send_text(self, pane, text):
        self._call(['pane', 'send-text', pane, text], parse=False)

    def send_keys(self, pane, keys):
        self._call(['pane', 'send-keys', pane, *keys], parse=False)

    def rename(self, pane, label):
        self._call(['pane', 'rename', pane, label], parse=False)

    def swap(self, source, target):
        self._call(['pane', 'swap', '--source-pane', source, '--target-pane', target], parse=False)

    def move(self, pane, new_tab=False, tab=None, target=None, split=None, ratio=None, focus=None):
        # 옮기면 pane id 가 바뀐다(herdr) — 돌려준 id 를 쓴다. herdr 는 같은 탭 안 이동을 못 한다(reason same_tab)
        args = ['pane', 'move', pane]
        if new_tab:
            args.append('--new-tab')
        else:
            args += ['--tab', tab, '--target-pane', target, '--split', split]
            if ratio is not None:
                args += ['--ratio', ratio]
        if focus is not None:
            args.append('--focus' if focus else '--no-focus')
        return _pane(self._call(args)['move_result']['pane'])

    def close(self, pane):
        self._call(['pane', 'close', pane], parse=False)


BACKENDS = {'herdr': HerdrBackend, 'studio': StudioBackend, 'none': NoneBackend}


def _configured_screen():
    """이 아테나 폴더의 athena.config.json(이 컴퓨터 설정) "screen" — herdr·studio·none·auto 문자열만. 없거나 읽지 못하거나 다른 값이면 ''(자동)."""
    config = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'athena.config.json')
    try:
        with open(config, encoding='utf-8') as config_file:
            value = json.load(config_file).get('screen')
    except (OSError, ValueError, AttributeError):
        return ''
    return value if value in ('herdr', 'studio', 'none', 'auto') else ''


def backend_name():
    # 환경 변수가 먼저(회귀 검사·한 번만 바꿀 때) → 이 아테나 폴더 설정(폴더마다 화면 고정) → 자동
    name = os.environ.get('ATHENA_SCREEN', '') or _configured_screen() or 'auto'
    if name != 'auto':
        return name
    # 1) 화면 pane 안(그 백엔드가 넣어 준 환경 변수) · 2) pane 밖이면 떠 있는 Studio 데몬(접속 파일) · 3) herdr 명령
    # 둘 다 있으면 herdr(R1) — Studio 데몬은 pane 셸에서 HERDR_* 를 지우므로, 둘 다 있다는 건 Studio pane 안에서 켠 herdr(안쪽)다
    if os.environ.get('HERDR_ENV') == '1' or os.environ.get('HERDR_PANE_ID'):
        return 'herdr'
    if os.environ.get('ATHENA_STUDIO') == '1':
        return 'studio'
    if _studio_endpoint():
        return 'studio'
    if shutil.which('herdr'):
        return 'herdr'
    return 'none'


def get_backend():
    name = backend_name()
    if name not in BACKENDS:
        raise ScreenError('usage', f'모르는 화면 백엔드: ATHENA_SCREEN={name} (herdr · studio · none)')
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
  name                                         안내 글에 쓸 화면 이름 한 줄(herdr · Athena Studio · 화면 터미널…)
  capabilities [--has <기능>[,<기능>…]]          백엔드 기능 목록 · --has 는 다 있으면 0
  pane current                                 서버가 정한 지금 pane(self 와 다르다 — 환경이 없으면 포커스된 pane)
  pane list [--tab T] [--workspace W] [--label L] [--label-or-name L] [--cwd D] [--agent-only] [--prefer-tab T] [--prefer-workspace W]
                                               (T·W 에 self 를 쓰면 부른 pane 의 탭·workspace) · --cwd 는 cwd 나 foreground_cwd 의 실제 경로가 D 인 것
  pane get <pane> · pane layout --pane <pane> · pane is-shell <pane>(빈 셸이면 0)
  pane read <pane> [--lines N] [--source S] [--read-format text|ansi] [--ansi] [--raw]   출력 그대로(글자 · --read-format 은 herdr --format)
  pane wait-output <pane> (--match T | --regex R) [--timeout MS] [--lines N] [--source S] [--raw]
  pane split --target <id|self|focused> --direction right|down [--ratio R] [--cwd D] [--env K=V]… [--focus|--no-focus]
  pane run <pane> <단어>…                      단어를 공백으로 이어 붙인 한 줄을 그 pane 셸에 친다(따옴표 없음 — herdr 계약 그대로)
  pane send-text <pane> <글> · pane send-keys <pane> <키>… (Enter · C-c) · pane rename <pane> <이름> · pane close <pane>
  pane swap <pane> <pane> · pane move <pane> (--new-tab | --tab T --target P --split right|down [--ratio R]) [--focus|--no-focus]
  tab list [--workspace W] · tab get <tab> · tab rename <tab> <이름> · tab close <tab>
  workspace list · workspace get <w> · workspace create --label L --cwd D [--focus|--no-focus]
  공통: --format json(기본) | id(첫 대상의 id 한 줄) | ids(한 줄에 하나)
  백엔드: ATHENA_SCREEN=herdr|studio|none → athena.config.json screen → auto"""

VALUE_FLAGS = {'--format', '--has', '--tab', '--workspace', '--label', '--label-or-name', '--read-format', '--cwd', '--prefer-tab', '--prefer-workspace', '--pane',
               '--target', '--direction', '--ratio', '--env', '--split', '--lines', '--source', '--match', '--regex', '--timeout'}
BOOL_FLAGS = {'--agent-only', '--focus', '--no-focus', '--new-tab', '--ansi', '--raw'}


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
    if '--label-or-name' in flags:   # board.sh 가 원래 보던 대로 — 이름표 또는 name
        panes = [p for p in panes if flags['--label-or-name'] in (p['label'], p['name'])]
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
    if op == 'pane layout':
        if '--pane' not in flags:
            raise ScreenError('usage', 'pane layout --pane <pane>')
        return screen.layout(flags['--pane']), 0
    if op == 'pane is-shell':
        try:
            return None, 0 if screen.is_shell(positional[0] if positional else '') else 1
        except ScreenError:
            return None, 1   # 확인 못 하면 1 — 돌고 있는 것을 건드리지 않는 쪽으로
    if op in ('pane read', 'pane wait-output'):
        pane = _need(positional, 1, 'pane')[0]
        # herdr 의 읽기 옵션을 그대로 넘긴다 — --format 은 출력 형식(json·id)과 겹쳐 --read-format 으로 받는다
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
        screen.send_text(raw_rest[0], raw_rest[1])
        return None, 0
    if op == 'pane send-keys':
        _need(raw_rest, 2, 'pane 과 키')
        screen.send_keys(raw_rest[0], raw_rest[1:])
        return None, 0
    if op == 'pane rename':
        _need(raw_rest, 2, 'pane 과 이름')
        screen.rename(raw_rest[0], raw_rest[1])
        return None, 0
    if op == 'pane swap':
        _need(positional, 2, '두 pane')
        screen.swap(positional[0], positional[1])
        return None, 0
    if op == 'pane move':
        pane = _need(positional, 1, 'pane')[0]
        if flags.get('--new-tab'):
            return {'pane': screen.move(pane, new_tab=True, focus=_focus(flags))}, 0
        if not all(key in flags for key in ('--tab', '--target', '--split')):
            raise ScreenError('usage', 'pane move <pane> (--new-tab | --tab T --target P --split right|down [--ratio R])')
        return {'pane': screen.move(pane, tab=flags['--tab'], target=flags['--target'], split=flags['--split'], ratio=flags.get('--ratio'), focus=_focus(flags))}, 0
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
    count = 1 if argv[0] in ('self', 'inside', 'name', 'capabilities') else 2
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
            # 백엔드가 낸 글자를 그대로 — 원래 스크립트가 받던 출력(json 일 때만 표준출력. id 는 비워 둔다 — 부르는 쪽이 오류 글을 id 로 읽지 않게)
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
