#!/usr/bin/env python3
"""아테나(리드)가 스스로 대화를 새로 시작하기 — 대화가 커졌을 때 사용자가 /new 를 치지 않아도(2026-11-11 사용자 결정).

  scripts/lead-fresh.py --plan <계획서>

아테나가 단계가 끝난 지점(보고를 마친 턴 끝)에서 부른다 — 압축 경고 훅(scripts/hooks/compact-checkpoint.py warn)이 언제 부를지 알려 준다.
1. 지금 확인(앞에서 · 바로 끝난다): 부른 쪽이 화면 안의 아테나 pane(ATHENA_AGENT 없음 · Claude · Codex)인가 · 계획서가 있고
   Checkpoint "- Updated:" 가 FRESH_MINUTES 안인가(새로 시작하면 대화가 사라지니 Checkpoint 를 먼저 적게 한다). 안 되면 종료 1 · 이유
2. 뒤에서 처리기를 띄우고 "📦 대화가 커져 새로 시작합니다 — <계획서>" 한 줄을 찍는다(아테나가 사용자에게 그대로 알린다)
3. 처리기(떨어져 돈다 · pane 마다 하나): 아테나 pane 이 쉴 때까지 기다린다 — 일하는 중(agent_status working) · 선택 창(pane_request.pane_menu)
   · 입력칸에 초안이 있거나 입력칸을 못 읽으면 넣지 않고 기다린다(2초마다 · 최대 6시간 — lead-send 와 같은 값). 연달아 두 번 쉬어야 넣는다
   → Claude 는 /clear · Codex 는 /new 를 넣는다(pane 안 프로그램은 끄지 않는다) → 새 대화가 pane 기록(state/pane-sessions — pane-session.py)에
   적히면 옛 대화를 가리키던 계획서 "- Lead session:" · 모아 둔 lead-send 글의 대화를 새 대화로 옮긴다(안 옮기면 에이전트 보고가
   "담당 대화가 바뀌었다" 로 막힌다) → 다시 쉴 때까지 기다려 재개 지시 "<계획서> 이어서 하자 …" 를 넣는다
   그사이 대화가 이미 바뀌었으면(사용자가 직접 /new) 넣지 않고 끝낸다. 결과는 사건 기록(lead.fresh)에 남긴다
화면은 scripts/lib/screen.py 로만. 입력칸 읽기는 앱 src/lib/pane-submit.mts inputOf 와 같은 규칙(Claude ❯ ~ 가로선 · Codex › ~ 빈 줄).
종료 코드: 0 = 처리기를 띄웠다 · 1 = 확인 실패(이유를 찍는다) · 2 = 사용법
"""
import datetime
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
import screen  # noqa: E402 — 화면 계층 — pane 을 다루는 곳은 scripts/lib/screen.py 하나
import pane_request  # noqa: E402 — 선택 창(pane_menu) · 기다리는 값 · 팩 데이터 자리
from reuse_link import pane_lock  # noqa: E402 — lead-send 대기열 · 기록과 같은 잠금
from plan_update import update_plan  # noqa: E402 — 계획서 고치기(잠금 · 바꿔치기)

PANE_ID = re.compile(r'^[\w-]{1,32}$')
FRESH_MINUTES = 15   # Checkpoint "- Updated:" 가 이만큼 안이어야 새로 시작한다
POLL_SECONDS = float(os.environ.get('ATHENA_LEAD_FRESH_POLL') or pane_request.POLL_SECONDS)
GIVE_UP_SECONDS = pane_request.GIVE_UP_SECONDS
SESSION_WAIT_SECONDS = 120   # /clear 뒤 새 대화가 pane 기록에 적히기를 기다리는 한도
CLEAR_COMMAND = {'claude': '/clear', 'codex': '/new'}
CLOSED_STATUS = ('done', 'cancelled')


def pane_session(pane: str) -> str:
    base = pane_request.pack_state()
    if base is None:
        return ''
    try:
        return str(json.loads((base / 'pane-sessions' / f'{pane}.json').read_text(encoding='utf-8')).get('session') or '')
    except (OSError, ValueError):
        return ''


def plan_path(plan: str):
    if not plan or not plan.endswith('.md'):
        return None
    path = pathlib.Path(plan) if os.path.isabs(plan) else ATHENA_DIR / plan
    return path if path.is_file() else None


def checkpoint_fresh(text: str, now: float) -> bool:
    """Checkpoint "- Updated: YYYY-MM-DD HH:MM …" 가 FRESH_MINUTES 안인가(지역 시각 — 계획서는 지역 시각으로 적는다)"""
    found = re.search(r'^- Updated:[ \t]*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', text, re.M)
    if not found:
        return False
    stamp = datetime.datetime.strptime(found.group(1), '%Y-%m-%d %H:%M').timestamp()
    return now - stamp <= FRESH_MINUTES * 60 and stamp - now <= 60


def input_of(agent: str, text: str):
    """입력칸 글 — 못 찾으면 None. 앱 src/lib/pane-submit.mts inputOf 와 같은 규칙"""
    lines = [line.rstrip() for line in str(text or '').split('\n')]
    mark = {'codex': '›', 'claude': '❯'}.get(agent)
    if not mark:
        return None
    starts = [index for index, line in enumerate(lines) if line.lstrip().startswith(mark)]
    if not starts:
        return None
    index = starts[-1]
    rest = lines[index + 1:]
    ends = [offset for offset, line in enumerate(rest) if (re.match(r'^─{3}', line) if agent == 'claude' else not line.strip())]
    if not ends:
        return None
    body = '\n'.join([lines[index].lstrip()[1:], *rest[:ends[0]]]).strip()
    # Claude 가 일하는 중 받은 글을 큐로 옮기고 빈 입력칸에 그리는 안내 — 초안이 아니다(pane-submit.mts 와 같다)
    if agent == 'claude' and body == 'Press up to edit queued messages' and any(line.strip() == 'ctrl+x ctrl+s to send now' for line in lines):
        return ''
    return body


def ready(pane: str, agent: str):
    """넣어도 되나 — True · False(기다린다) · 'gone'(pane 이 없거나 다른 프로그램이 됐다)"""
    backend = screen.get_backend()
    try:
        info = backend.get_pane(pane)
    except Exception:
        return 'gone'
    if not isinstance(info, dict) or info.get('agent') != agent:
        return 'gone'
    if info.get('agent_status') != 'idle':
        return False
    if pane_request.pane_menu(pane) is not False:
        return False
    try:
        screen_text = backend.read(pane, ['--lines', '40', '--source', 'visible'])
    except Exception:
        return False
    return input_of(agent, screen_text) == ''


def wait_ready(pane: str, agent: str, deadline: float) -> bool:
    """연달아 두 번 쉬면 True — 도구 사이 잠깐 쉬는 때에 넣지 않게. pane 이 없어지거나 한도를 넘기면 False"""
    calm = 0
    while time.monotonic() < deadline:
        state = ready(pane, agent)
        if state == 'gone':
            return False
        calm = calm + 1 if state is True else 0
        if calm >= 2:
            return True
        time.sleep(POLL_SECONDS)
    return False


def rebind_session(pane: str, old: str, new: str) -> int:
    """옛 대화를 가리키던 계획서 Lead session · 모아 둔 lead-send 글을 새 대화로 — 옮긴 계획서 수"""
    moved = 0
    for path in sorted((ATHENA_DIR / 'plans').rglob('*.md')):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        lead = re.search(r'^- Lead pane:[ \t]*(\S+)', text, re.M)
        status = re.search(r'^- Status:[ \t]*(\S+)', text, re.M)
        if not lead or lead.group(1) != pane or not re.search(rf'^- Lead session:[ \t]*{re.escape(old)}[ \t]*$', text, re.M):
            continue
        if status and status.group(1) in CLOSED_STATUS:
            continue

        def swap(current: str):
            changed = re.sub(rf'^- Lead session:[ \t]*{re.escape(old)}[ \t]*$', f'- Lead session: {new}', current, flags=re.M)
            return changed if changed != current else None
        try:
            update_plan(str(path), swap)
            moved += 1
        except Exception:
            pass
    base = pane_request.pack_state()
    queue = base / 'lead-send' if base else None
    if queue and queue.is_dir():
        with pane_lock(queue, pane):
            for entry_path in sorted(queue.glob(f'{pane}-*.json')):
                try:
                    entry = json.loads(entry_path.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    continue
                if entry.get('session') == old:
                    entry['session'] = new
                    temp = entry_path.with_name(f'.{entry_path.name}.tmp')
                    temp.write_text(json.dumps(entry, ensure_ascii=False) + '\n', encoding='utf-8')
                    os.replace(temp, entry_path)
    return moved


def log_event(result: str, pane: str, plan: str) -> None:
    """사건 기록(scripts/lib/events.mjs) — 실패해도 무시한다"""
    try:
        subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'lib' / 'events.mjs'), 'lead.fresh', f'pane={pane}', f'plan={plan}', f'result={result}'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def resume_text(plan: str) -> str:
    return (f'{plan} 이어서 하자 — 대화가 커져 새로 시작했다(scripts/lead-fresh.py). '
            '이 계획서 Checkpoint(Status · Progress · Next · Blocked)와 리드 기록부터 읽고, 맡긴 pane 의 상태를 확인한 뒤 이어 간다')


def worker(pane: str, agent: str, plan: str, old: str) -> str:
    """처리기 본문 — 결과 한 낱말(사건 기록에 남긴다)"""
    deadline = time.monotonic() + GIVE_UP_SECONDS
    if not wait_ready(pane, agent, deadline):
        return 'gave-up'
    if pane_session(pane) != old:
        return 'already-new'   # 그사이 사용자가 새로 시작했다
    backend = screen.get_backend()
    try:
        backend.run(pane, [CLEAR_COMMAND[agent]])
    except Exception:
        return 'clear-failed'
    until = time.monotonic() + SESSION_WAIT_SECONDS
    new = ''
    while time.monotonic() < until:
        new = pane_session(pane)
        if new and new != old:
            break
        try:
            backend.get_pane(pane)
        except Exception:
            return 'gone'
        time.sleep(POLL_SECONDS)
    if not new or new == old:
        return 'no-new-session'
    rebind_session(pane, old, new)
    if not wait_ready(pane, agent, deadline):
        return 'resume-gave-up'
    try:
        backend.run(pane, [resume_text(plan)])
    except Exception:
        return 'resume-failed'
    return 'done'


def run_worker(pane: str, agent: str, plan: str, old: str) -> None:
    base = pane_request.pack_state() or ATHENA_DIR
    folder = base / 'lead-fresh'
    folder.mkdir(parents=True, exist_ok=True)
    holder = open(folder / f'.{pane}.lock', 'w')
    try:
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return  # 이 pane 의 처리기가 이미 돈다
    try:
        result = worker(pane, agent, plan, old)
    except Exception:
        result = 'error'
    log_event(result, pane, plan)


def start(plan: str) -> int:
    if os.environ.get('ATHENA_AGENT'):
        print('아테나(리드) pane 에서만 부른다 — 위임 에이전트는 쓰지 않는다', file=sys.stderr)
        return 1
    info = screen.self_info()
    pane = str(info.get('pane_id') or '')
    if not info.get('inside') or not PANE_ID.fullmatch(pane):
        print('화면 pane 안에서만 부른다 — 이 세션의 pane 을 찾지 못했다', file=sys.stderr)
        return 1
    try:
        agent = str(screen.get_backend().get_pane(pane).get('agent') or '')
    except Exception:
        agent = ''
    if agent not in CLEAR_COMMAND:
        print('이 pane 의 Claude · Codex 를 확인하지 못했다', file=sys.stderr)
        return 1
    path = plan_path(plan)
    if path is None:
        print(f'계획서를 찾지 못했다: {plan}', file=sys.stderr)
        return 1
    if not checkpoint_fresh(path.read_text(encoding='utf-8'), time.time()):
        print(f'계획서 Checkpoint 를 먼저 갱신한다(Progress · Next · Blocked · "- Updated:" 를 지금 시각으로 — {FRESH_MINUTES}분 안) — 새로 시작하면 이 대화가 사라진다: {plan}',
              file=sys.stderr)
        return 1
    old = pane_session(pane)
    if not old:
        print('이 pane 의 대화 기록(state/pane-sessions)을 찾지 못했다', file=sys.stderr)
        return 1
    subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), '--worker', pane, agent, plan, old],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    print(f'📦 대화가 커져 새로 시작합니다 — {plan}')
    print('  (이 턴이 끝나 입력칸이 비면 /clear 뒤 재개 지시를 넣는다 — 이 줄을 사용자에게 그대로 알리고 턴을 끝낸다)')
    return 0


def main(argv) -> int:
    if len(argv) == 5 and argv[0] == '--worker':
        pane, agent, plan, old = argv[1:]
        if PANE_ID.fullmatch(pane) and agent in CLEAR_COMMAND:
            run_worker(pane, agent, plan, old)
        return 0
    if len(argv) == 2 and argv[0] == '--plan' and argv[1].strip():
        return start(argv[1].strip())
    print('사용: scripts/lead-fresh.py --plan <계획서>', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
