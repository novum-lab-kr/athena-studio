#!/usr/bin/env python3
"""아테나(리드)가 스스로 대화를 새로 시작하기 — 대화가 커졌을 때 사용자가 /new 를 치지 않아도(2026-11-11 사용자 결정).

  scripts/lead-fresh.py --plan <계획서>

**사용자가 새로 시작하자고 답한 뒤에만** 부른다(2026-11-11 사용자 결정 — 묻지 않고 지우면 당황스럽다). 압축 경고 훅
(scripts/hooks/compact-checkpoint.py warn)이 단계 끝에 AskUserQuestion(Codex request_user_input)으로 먼저 물으라고 알려 주고,
거절 · 답 없음이면 부르지 않는다. 물은 때 · 지운 때는 scripts/lib/lead_fresh_mark.py 에 적혀 30분 안에는 다시 묻지 않는다.
1. 지금 확인(앞에서 · 바로 끝난다): 부른 쪽이 화면 안의 아테나 pane(ATHENA_AGENT 없음 · Claude · Codex)인가 · 계획서가 있고
   Checkpoint "- Updated:" 가 FRESH_MINUTES 안인가(새로 시작하면 대화가 사라지니 Checkpoint 를 먼저 적게 한다). 안 되면 종료 1 · 이유
2. 뒤에서 처리기를 띄우고 "📦 대화가 커져 새로 시작합니다 — <계획서>" 한 줄을 찍는다(아테나가 사용자에게 그대로 알린다)
3. 처리기(떨어져 돈다 · pane 마다 하나): 아테나 pane 이 쉴 때까지 기다린다 — 일하는 중(agent_status working) · 선택 창(pane_request.pane_menu)
   · 입력칸에 초안이 있거나 입력칸을 못 읽으면 넣지 않고 기다린다(2초마다 · 최대 6시간 — lead-send 와 같은 값). 연달아 두 번 쉬어야 넣는다
   → Claude 는 /clear · Codex 는 /new 를 넣는다(pane 안 프로그램은 끄지 않는다) → 새 대화가 pane 기록(state/pane-sessions — pane-session.py)에
   적히면 옛 대화를 가리키던 계획서 "- Lead session:"(넘긴 계획서는 어느 대화를 가리키든) · 모아 둔 lead-send 글의 대화를 새 대화로 옮긴다(안 옮기면 에이전트 보고가
   "담당 대화가 바뀌었다" 로 막힌다) → 다시 쉴 때까지 기다려 재개 지시 "<계획서> 이어서 하자 …" 를 넣는다
   예약 뒤 새 입력이 들어왔으면(pane 기록의 session · at 이 바뀜 — pane-session.py 가 입력마다 at 을 다시 적는다) 그 차례의 문맥이
   Checkpoint 에 없을 수 있어 /clear 를 넣지 않고 끝낸다 · /clear 직전에 계획서 "- Updated:" 가 예약 때보다 앞서지 않았는지 다시 본다.
   /clear 뒤 재개를 기다리는 동안 · 넣기 직전에 대화가 감지한 새 대화와 다르거나 새 입력이 들어왔으면(사용자가 직접 /new · 새 일) 넣지 않는다.
   결과는 사건 기록(lead.fresh)에 남긴다
에이전트 pane(ATHENA_AGENT · 역할 agent — 리뷰어는 안 된다)도 같은 뼈대로 새로 시작한다(2026-11-11 사용자 결정 — 에이전트는 묻지 않고 자동 · 묻는 것은 아테나만).
   압축 경고 훅이 단계 끝에 Checkpoint 를 갱신하고 부르라고 알려 준다. 리드와 다른 점:
   사용자가 그 pane 을 보고 있으면(pane focused) 넣지 않고 기다린다 · 지운 뒤 계획서 Lead session 은 옮기지 않는다(아테나 대화다) ·
   대신 아테나(계획서 "- Lead pane:")에 "📦 <pane> 새로 시작 — <계획서>" 한 줄(lead-send.py --note — 끝 알림 받음 확인 · 그 차례의 직접 보고로 치지 않는다) ·
   재개 지시는 "<계획서> 이어서 — Checkpoint 부터 읽고 진행". 끝 알림 차례 상태(state/agent-turn · agent-notify) · pane 기록 · 보호 훅은
   pane · 환경 기준이라 대화가 바뀌어도 이어진다
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
import lead_rebind  # noqa: E402 — 대화가 바뀐 뒤 계획서 Lead session · lead-send 대기열 옮기기
import lead_fresh_mark  # noqa: E402 — 물은 때 · 지운 때(30분 안에는 다시 묻지 않는다)

PANE_ID = re.compile(r'^[\w-]{1,32}$')
FRESH_MINUTES = 15   # Checkpoint "- Updated:" 가 이만큼 안이어야 새로 시작한다
POLL_SECONDS = float(os.environ.get('ATHENA_LEAD_FRESH_POLL') or pane_request.POLL_SECONDS)
GIVE_UP_SECONDS = pane_request.GIVE_UP_SECONDS
SESSION_WAIT_SECONDS = 120   # /clear 뒤 새 대화가 pane 기록에 적히기를 기다리는 한도
CLEAR_COMMAND = {'claude': '/clear', 'codex': '/new'}
ROLES = ('lead', 'agent')
NOTE_TIMEOUT = 30   # 아테나에 📦 한 줄 보내기(lead-send.py) 시간 상한 — 못 받으면 lead-send 가 모아 뒀다 넣는다


def role_of() -> str:
    """부른 쪽 — 'lead'(아테나) · 'agent'(위임 에이전트) · 'reviewer'(새로 시작하지 않는다). delegate.sh 가 ATHENA_ROLE 을 넘긴다"""
    if not os.environ.get('ATHENA_AGENT'):
        return 'lead'
    role = os.environ.get('ATHENA_ROLE') or ''
    if role == 'reviewer' or (not role and os.environ.get('ATHENA_AGENT') in ('reviewer', 'security-reviewer')):
        return 'reviewer'
    return 'agent'


def pane_record(pane: str) -> dict:
    """pane 기록(state/pane-sessions/<pane>.json) — pane-session.py 가 대화 시작 · 입력마다 session · at 을 다시 적는다"""
    base = pane_request.pack_state()
    if base is None:
        return {}
    try:
        data = json.loads((base / 'pane-sessions' / f'{pane}.json').read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def pane_session(pane: str) -> str:
    return str(pane_record(pane).get('session') or '')


def pane_mark(pane: str) -> str:
    """대화 · 마지막 입력 표시 — 이것이 바뀌면 새 대화나 새 입력이 들어왔다"""
    data = pane_record(pane)
    return f"{data.get('session') or ''}@{data.get('at') or ''}"


def updated_stamp(text: str) -> str:
    """Checkpoint "- Updated:" 의 시각(YYYY-MM-DD HH:MM) — 없으면 ''. 같은 꼴이라 글자 비교가 시각 비교다"""
    found = re.search(r'^- Updated:[ \t]*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', text, re.M)
    return found.group(1) if found else ''


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


def ready(pane: str, agent: str, role: str = 'lead'):
    """넣어도 되나 — True · False(기다린다) · 'gone'(pane 이 없거나 다른 프로그램이 됐다). 에이전트 pane 은 사용자가 보고 있으면(focused) 기다린다"""
    backend = screen.get_backend()
    try:
        info = backend.get_pane(pane)
    except Exception:
        return 'gone'
    if not isinstance(info, dict) or info.get('agent') != agent:
        return 'gone'
    if info.get('agent_status') != 'idle':
        return False
    if role == 'agent' and info.get('focused'):
        return False
    if pane_request.pane_menu(pane) is not False:
        return False
    try:
        screen_text = backend.read(pane, ['--lines', '40', '--source', 'visible'])
    except Exception:
        return False
    return input_of(agent, screen_text) == ''


def wait_ready(pane: str, agent: str, deadline: float, guard, role: str = 'lead') -> str:
    """연달아 두 번 쉬면 '' — 도구 사이 잠깐 쉬는 때에 넣지 않게. 아니면 멈춘 이유:
    guard() 가 돌려준 이유(새 입력 · 다른 대화) · 'gone'(pane 이 없어짐) · 'gave-up'(한도를 넘김)"""
    calm = 0
    while time.monotonic() < deadline:
        reason = guard()
        if reason:
            return reason
        state = ready(pane, agent, role)
        if state == 'gone':
            return 'gone'
        calm = calm + 1 if state is True else 0
        if calm >= 2:
            return ''
        time.sleep(POLL_SECONDS)
    return 'gave-up'


def rebind_session(pane: str, old: str, new: str, plan: str = '') -> int:
    """옛 대화를 가리키던 계획서 Lead session · 모아 둔 lead-send 글을 새 대화로 — 옮긴 계획서 수(lib/lead_rebind.py).
    넘긴 계획서(plan)는 이 아테나 pane 것이면 Lead session 이 옛 대화가 아니어도 옮긴다 — 방금 Checkpoint 를 갱신하고 넘긴
    계획서라 이 아테나가 맡은 것이 확실하다. 사용자가 손으로 /clear · /new 한 때는 pane-session.py 가 같은 함수로 옮긴다"""
    return lead_rebind.rebind(pane, old, new, plan_path(plan))


def log_event(result: str, pane: str, plan: str) -> None:
    """사건 기록(scripts/lib/events.mjs) — 실패해도 무시한다"""
    try:
        subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'lib' / 'events.mjs'), 'lead.fresh', f'pane={pane}', f'plan={plan}', f'result={result}'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def resume_text(plan: str, role: str = 'lead') -> str:
    if role == 'agent':
        return f'{plan} 이어서 — Checkpoint 부터 읽고 진행(대화가 커져 새로 시작했다 · scripts/lead-fresh.py)'
    return (f'{plan} 이어서 하자 — 대화가 커져 새로 시작했다(scripts/lead-fresh.py). '
            '이 계획서 Checkpoint(Status · Progress · Next · Blocked)와 리드 기록부터 읽고, 맡긴 pane 의 상태를 확인한 뒤 이어 간다')


def plan_lead(plan: str) -> str:
    """계획서 Checkpoint "- Lead pane:" — 없거나 모양이 틀리면 ''"""
    path = plan_path(plan)
    if path is None:
        return ''
    try:
        found = re.search(r'^- Lead pane:[ \t]*(\S+)', path.read_text(encoding='utf-8'), re.M)
    except OSError:
        return ''
    return found.group(1) if found and PANE_ID.fullmatch(found.group(1)) else ''


def notify_lead(pane: str, plan: str) -> None:
    """에이전트 pane 을 지운 뒤 아테나에 한 줄 — lead-send.py --note(못 받으면 모아 뒀다 넣는다 · 받음 확인 · 직접 보고로 치지 않는다).
    실패해도 무시한다(새로 시작은 그대로 이어 간다)"""
    lead = plan_lead(plan)
    if not lead or lead == pane:
        return
    try:
        subprocess.run([sys.executable, str(ATHENA_DIR / 'scripts' / 'lead-send.py'), lead, f'📦 {pane} 새로 시작 — {plan}', '--plan', plan, '--note'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=NOTE_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        pass


def before_clear(pane: str, old: str, mark: str) -> str:
    """/clear 를 넣어도 되나 — '' 또는 멈출 이유. 예약 뒤 새 입력이 들어왔으면 그 차례 문맥이 Checkpoint 에 없을 수 있다"""
    if pane_session(pane) != old:
        return 'already-new'   # 그사이 사용자가 새로 시작했다
    if pane_mark(pane) != mark:
        return 'new-input'
    return ''


def checkpoint_kept(plan: str, stamp: str) -> bool:
    """/clear 직전 다시 보기 — 계획서가 있고 Checkpoint "- Updated:" 가 예약 때 시각보다 앞서지 않았나"""
    path = plan_path(plan)
    if path is None:
        return False
    try:
        now_stamp = updated_stamp(path.read_text(encoding='utf-8'))
    except OSError:
        return False
    return bool(now_stamp) and now_stamp >= stamp


def worker(pane: str, agent: str, plan: str, old: str, mark: str, stamp: str, role: str = 'lead') -> str:
    """처리기 본문 — 결과 한 낱말(사건 기록에 남긴다). mark = 예약 때 pane 기록(대화@마지막 입력) · stamp = 예약 때 Checkpoint 시각 · role = lead · agent"""
    deadline = time.monotonic() + GIVE_UP_SECONDS
    reason = wait_ready(pane, agent, deadline, lambda: before_clear(pane, old, mark), role)
    if reason:
        return reason
    # 넣기 직전에 한 번 더 — 기다리는 사이 마지막 읽기 뒤에 바뀌었을 수 있다
    reason = before_clear(pane, old, mark)
    if reason:
        return reason
    if not checkpoint_kept(plan, stamp):
        return 'checkpoint-stale'
    backend = screen.get_backend()
    try:
        backend.run(pane, [CLEAR_COMMAND[agent]])
    except Exception:
        return 'clear-failed'
    lead_fresh_mark.mark(pane, 'cleared')   # 30분 안에는 다시 묻지 않는다
    until = time.monotonic() + SESSION_WAIT_SECONDS
    new = ''
    fresh_mark = ''
    while time.monotonic() < until:
        # 새 대화와 입력 표시를 같은 기록에서 함께 잡는다 — 옮기는 사이 들어온 입력을 놓치지 않게
        record = pane_record(pane)
        new = str(record.get('session') or '')
        fresh_mark = f"{new}@{record.get('at') or ''}"
        if new and new != old:
            break
        try:
            backend.get_pane(pane)
        except Exception:
            return 'gone'
        time.sleep(POLL_SECONDS)
    if not new or new == old:
        return 'no-new-session'
    if role == 'agent':
        notify_lead(pane, plan)   # 에이전트 계획서의 Lead session 은 아테나 대화라 옮기지 않는다
    else:
        rebind_session(pane, old, new, plan)

    def before_resume() -> str:
        # 사용자가 직접 새 대화를 열었거나(/new) 새 대화에서 다른 일을 시켰으면 재개 지시를 넣지 않는다
        if pane_session(pane) != new:
            return 'user-new'
        return 'new-input' if pane_mark(pane) != fresh_mark else ''
    reason = wait_ready(pane, agent, deadline, before_resume, role)
    if reason:
        return f'resume-{reason}'
    reason = before_resume()
    if reason:
        return f'resume-{reason}'
    try:
        backend.run(pane, [resume_text(plan, role)])
    except Exception:
        return 'resume-failed'
    return 'done'


def run_worker(pane: str, agent: str, plan: str, old: str, mark: str, stamp: str, role: str = 'lead') -> None:
    base = pane_request.pack_state() or ATHENA_DIR
    folder = base / 'lead-fresh'
    folder.mkdir(parents=True, exist_ok=True)
    holder = open(folder / f'.{pane}.lock', 'w')
    try:
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return  # 이 pane 의 처리기가 이미 돈다
    try:
        result = worker(pane, agent, plan, old, mark, stamp, role)
    except Exception:
        result = 'error'
    log_event(result, pane, plan)


def start(plan: str) -> int:
    role = role_of()
    if role not in ROLES:
        print('아테나 · 위임 에이전트 pane 에서만 부른다 — 리뷰어는 쓰지 않는다', file=sys.stderr)
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
    text = path.read_text(encoding='utf-8')
    if not checkpoint_fresh(text, time.time()):
        print(f'계획서 Checkpoint 를 먼저 갱신한다(Progress · Next · Blocked · "- Updated:" 를 지금 시각으로 — {FRESH_MINUTES}분 안) — 새로 시작하면 이 대화가 사라진다: {plan}',
              file=sys.stderr)
        return 1
    old = pane_session(pane)
    if not old:
        print('이 pane 의 대화 기록(state/pane-sessions)을 찾지 못했다', file=sys.stderr)
        return 1
    subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), '--worker', pane, agent, plan, old, pane_mark(pane), updated_stamp(text), role],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    print(f'📦 대화가 커져 새로 시작합니다 — {plan}')
    if role == 'agent':
        print('  (이 턴이 끝나 입력칸이 비고 사용자가 이 pane 을 보고 있지 않으면 대화를 비우고 재개 지시를 넣는다 — 이 줄만 알리고 턴을 끝낸다)')
    else:
        print('  (이 턴이 끝나 입력칸이 비면 /clear 뒤 재개 지시를 넣는다 — 이 줄을 사용자에게 그대로 알리고 턴을 끝낸다)')
    return 0


def main(argv) -> int:
    if len(argv) in (7, 8) and argv[0] == '--worker':
        pane, agent, plan, old, mark, stamp = argv[1:7]
        role = argv[7] if len(argv) == 8 else 'lead'
        if PANE_ID.fullmatch(pane) and agent in CLEAR_COMMAND and role in ROLES:
            run_worker(pane, agent, plan, old, mark, stamp, role)
        return 0
    if len(argv) == 2 and argv[0] == '--plan' and argv[1].strip():
        return start(argv[1].strip())
    print('사용: scripts/lead-fresh.py --plan <계획서>', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
