"""pane 의 사람 확인 창(고르기 · 권한 확인)을 [작업] 요청으로 올리는 훅들이 같이 쓰는 곳 — ask-to-request.py · permission-to-request.py

- pane 알아내기 · 계획서 찾기 · 실패 흔적 (두 훅이 같은 규칙)
- 창이 떠 있나 읽기(menu_open) — 현황판 pane-delivery.mjs 의 PROMPT_MENU 와 같은 글
- 뒤에서 도는 지킴이(CLI `permission` · `close`) — 훅은 pane 의 창을 막지 않고 바로 끝나야 해서 요청 열기 · 닫기는 떨어져 나온 프로세스가 맡는다
    permission <json 파일>   — 몇 초 기다려도 권한 창이 그대로면 요청을 열고, 창이 닫히면 요청을 거둔다
    close <pane> <요청 id>…  — 이미 열린 요청을 pane 의 창이 닫힐 때 거둔다

요청은 알림 + 그 pane 으로 가는 길이다. 권한 창의 허용 · 거부를 [작업] 답으로 돌려주지 않는다 — 허용을 대신 누르는 길을 만들지 않는다.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
import screen  # noqa: E402 — 화면 계층 — pane 을 다루는 곳은 scripts/lib/screen.py 하나

PANE_ID = re.compile(r'^[\w-]{1,32}$')
# 질문 · 고르기 · 권한 창 표시 — scripts/board/pane-delivery.mjs 의 PROMPT_MENU 와 같은 글
PROMPT_MENU = re.compile(r'Enter to (select|confirm)|Esc to cancel|↑/↓ to navigate|Do you want to|Type something\.')
GRACE_SECONDS = 4      # 권한 창이 이 시간 안에 닫히면(분류기 자동 허용 · 빠른 응답) 요청을 열지 않는다
POLL_SECONDS = 2
GIVE_UP_SECONDS = 6 * 3600
CLOSED_READS = 2       # 창이 안 보이는 읽기가 이만큼 이어져야 닫힌 것으로(다시 그리는 순간을 닫힘으로 보지 않는다)
SEEN_WAIT_SECONDS = 20  # 창이 아직 안 그려졌을 수 있어 기다려 주는 시간
DETAIL_MAX = 300


def pack_state():
    pack_data = ATHENA_DIR / '.pack-data'
    return pack_data.resolve() / 'state' if pack_data.is_symlink() else None


def caller_pane() -> str:
    try:
        pane = str(screen.self_info().get('pane_id') or '')
    except Exception:
        return ''
    return pane if PANE_ID.match(pane) else ''


def plan_of(pane: str) -> str:
    """계획서 — pane 기록(이어 보내기로 바뀐 계획서도 따라간다)을 먼저, 없으면 환경 ATHENA_PLAN (agent-done-notify.py 와 같은 순서)"""
    base = pack_state()
    if base and pane:
        try:
            plan = json.loads((base / 'pane-sessions' / f'{pane}.json').read_text(encoding='utf-8')).get('plan')
            if plan:
                return str(plan)
        except Exception:
            pass
    return os.environ.get('ATHENA_PLAN') or ''


def log_failure(reason: str) -> None:
    """훅이 요청을 못 열었다는 흔적 — 기존 사건 기록 진입점(scripts/lib/events.mjs)으로 한 줄 남긴다(pack · 시각 형식이 같다). 기록 실패는 무시"""
    try:
        subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'lib' / 'events.mjs'), 'request-hook-failed',
                        f"agent={os.environ.get('ATHENA_AGENT') or 'athena'}", f'reason={reason[:300]}'],
                       capture_output=True, text=True, timeout=10)
    except Exception:
        pass


def menu_open(text: str) -> bool:
    """화면 끝 12줄(빈 줄 빼고)에 질문 · 고르기 · 권한 창이 떠 있나"""
    lines = [line.rstrip() for line in str(text or '').split('\n') if line.strip()]
    return any(PROMPT_MENU.search(line) for line in lines[-12:])


def pane_menu(pane: str):
    """True = 창이 떠 있음 · False = 없음 · None = 모름(읽기 실패). pane 이 사라졌으면 'gone'"""
    try:
        backend = screen.get_backend()
        backend.get_pane(pane)
    except Exception:
        return 'gone'
    try:
        return menu_open(backend.read(pane, ['--lines', '20', '--source', 'visible']))
    except Exception:
        return None


def athena(args, timeout=30):
    """bin/athena 요청 명령 — --json 마지막 줄을 읽어 돌려준다(실패면 {})"""
    done = subprocess.run([str(ATHENA_DIR / 'bin' / 'athena'), *args, '--json'], capture_output=True, text=True, timeout=timeout)
    lines = [line for line in done.stdout.strip().splitlines() if line.strip()]
    try:
        return json.loads(lines[-1]) if lines else {}
    except ValueError:
        return {}


def spawn(args) -> None:
    """떨어져 나온 프로세스로 지킴이를 띄운다 — 훅이 기다리지 않게 입출력을 모두 끊는다"""
    subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), *map(str, args)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def mask(text: str) -> str:
    """비밀값 가리기 — 규칙 정본 scripts/lib/mask.mjs. 가리지 못하면 글을 아예 쓰지 않는다(빈 글)"""
    try:
        script = ('const { maskText } = await import(process.argv[1]); let text = ""; for await (const chunk of process.stdin) text += chunk; '
                  'process.stdout.write(maskText(text))')
        done = subprocess.run(['node', '--input-type=module', '-e', script, str(ATHENA_DIR / 'scripts' / 'lib' / 'mask.mjs')],
                              input=text, capture_output=True, text=True, timeout=15)
        return done.stdout if done.returncode == 0 else ''
    except Exception:
        return ''


# 권한 창이 묻는 일 — 도구 이름 → 쉬운 말
WHAT = {'Bash': '명령 실행', 'Write': '파일 쓰기', 'Edit': '파일 고치기', 'MultiEdit': '파일 고치기', 'NotebookEdit': '노트북 고치기',
        'Read': '파일 읽기', 'WebFetch': '웹 페이지 가져오기', 'WebSearch': '웹 검색'}
DETAIL_KEYS = ('command', 'file_path', 'notebook_path', 'url', 'query', 'path', 'pattern')


def permission_text(event: dict, pane: str):
    """권한 요청 → (제목, 본문). 내용은 한 줄 요약만 싣고(파일 쓰기의 content 같은 긴 글은 싣지 않는다) 비밀값은 가린다"""
    tool = str(event.get('tool_name') or '도구')
    what = WHAT.get(tool, f'{tool} 쓰기')
    tool_input = event.get('tool_input') if isinstance(event.get('tool_input'), dict) else {}
    detail = ''
    for key in DETAIL_KEYS:
        if tool_input.get(key):
            detail = str(tool_input[key]).strip().replace('\n', ' ')[:DETAIL_MAX]
            break
    detail = mask(detail) if detail else ''
    who = os.environ.get('ATHENA_AGENT') or '아테나'
    lines = [f'어디서: {pane} ({who})']
    plan = plan_of(pane)
    if plan:
        lines.append(f'작업: {plan}')
    lines.append(f'묻는 일: {what}' + (f' — {detail}' if detail else ''))
    lines += ['',
              '그 pane 이 허용 확인 창을 띄우고 기다려요. 허용하면 그대로 진행하고, 거부하면 멈춰요.',
              '이 요청은 알림이에요 — 여기서는 허용 · 거부를 할 수 없어요. [pane 으로 가기] 로 가서 그 창에서 고르세요. 고르면 이 요청은 저절로 닫혀요.']
    return f'{pane} 에서 허용 확인 대기 — {what}', '\n'.join(lines)


def request_state(request_id: str):
    return (athena(['request', 'show', request_id]).get('request') or {}).get('state')


def close_when_gone(pane: str, ids, seen: bool = False) -> None:
    """pane 의 창이 닫히면(또는 pane 이 없어지면) 아직 열린 요청을 거둔다. 사람이 [작업] 에서 먼저 답했거나 닫혔으면 그대로 둔다.
    seen — 창이 떠 있는 것을 이미 봤나. 훅이 도구 실행 전에 불리면 창이 아직 안 그려졌을 수 있어, 한 번 보기 전의 빈 화면은 닫힘으로 세지 않는다(SEEN_WAIT_SECONDS 까지)"""
    started = time.time()
    deadline = started + GIVE_UP_SECONDS
    closed = 0
    while time.time() < deadline:
        time.sleep(POLL_SECONDS)
        if all(request_state(request_id) != 'open' for request_id in ids):
            return  # 모두 [작업] 에서 답했거나 닫혔다 — 거둘 것이 없다
        state = pane_menu(pane)
        if state is None:
            continue
        if state is True:
            seen = True
        if not seen and state is False and time.time() - started < SEEN_WAIT_SECONDS:
            continue
        closed = closed + 1 if state is False or state == 'gone' else 0
        if closed >= CLOSED_READS or state == 'gone':
            break
    for request_id in ids:
        if request_state(request_id) == 'open':
            athena(['request', 'cancel', request_id, '--reason', 'pane 에서 이미 답했어요'])


def watch_permission(payload_path: str) -> None:
    """권한 요청 지킴이 — 잠깐 기다려 창이 그대로면 요청을 열고, 창이 닫히면 거둔다"""
    payload = json.loads(pathlib.Path(payload_path).read_text(encoding='utf-8'))
    pathlib.Path(payload_path).unlink(missing_ok=True)
    pane = payload['pane']
    time.sleep(GRACE_SECONDS)
    if pane_menu(pane) is not True:
        return  # 이미 닫혔거나 pane 이 없다 — 빠르게 지나간 창은 올리지 않는다
    title, body = permission_text(payload['event'], pane)
    command = ['request', 'open', '--kind', 'question', '--title', title, '--body', body, '--pane', pane, '--key', f'perm:{pane}']
    plan = plan_of(pane)
    if plan:
        command += ['--plan', plan]
    result = athena(command)
    if not result.get('ok'):
        log_failure(result.get('message') or '권한 확인 요청을 열지 못했다')
        return
    close_when_gone(pane, [result['request']['id']], seen=True)


def main(argv) -> None:
    mode = argv[0] if argv else ''
    if mode == 'permission' and len(argv) == 2:
        watch_permission(argv[1])
    elif mode == 'close' and len(argv) >= 3:
        close_when_gone(argv[1], argv[2:])


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        log_failure(f'지킴이 오류: {error}')
    sys.exit(0)
