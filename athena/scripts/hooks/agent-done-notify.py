#!/usr/bin/env python3
"""위임 에이전트 끝 알림 훅 (UserPromptSubmit · Stop) — delegate.sh · agent-context.py 가 위임 에이전트 세션(ATHENA_AGENT)에만 건다.

에이전트가 한 차례(턴)를 끝내면(Stop) 그 pane 을 띄운 아테나 pane 에 한 줄을 입력한다:
  [<에이전트> → 아테나] 끝 · <pane> · 계획서 <경로> · Status <값> · PR <번호 · 상태>(있을 때만 · 상태는 gh 로 물은 실제 값, 못 물으면 계획서 값 + "(기록 기준)") · 머지 <레포 브랜치 결과>(PR 끔 레포의 바로 머지 — "- Auto merge:" 줄이 있을 때만)
아테나 pane 은 계획서 Checkpoint 의 "- Lead pane:" 줄(delegate.sh 가 적는다)에서 읽는다 — 새 기록을 만들지 않는다.
계획서는 pane 기록(state/pane-sessions/<pane>.json — 이어 보내기로 바뀐 계획서도 따라간다)을 먼저, 없으면 환경 ATHENA_PLAN.

무한 왕복 막기 — 상태는 <팩 데이터>/state/agent-notify/<pane>.json
  - 첫 입력 전 Stop · 지시 없이 띄운 시작 안내(ATHENA_NOTIFY_BOOTSTRAP)는 알리지 않는다
  - 같은 줄은 사용자 입력이 새로 오기 전에는 다시 보내지 않는다(새 입력이 오면 같은 내용도 다시 알린다 — 같은 계획서에 요청을 이어 받는 경우)
  - 아테나가 이 알림에 답한 입력("[아테나 …] … 끝 알림 …")으로 시작한 차례는 알리지 않는다
백그라운드 명령이 아직 돌면 그 차례는 알리지 않고 last 도 남기지 않는다 — 명령이 끝나 다시 Stop 이 오면 그때 알린다.
  대기 목록 = 대화 기록(transcript_path)의 시작 기록(backgroundTaskId · 출력 파일) − 끝 기록(task-notification · TaskStop). 끝 기록이 영영 안 남는 경우가 있어
  기록만 믿지 않고 출력 파일을 쥔 프로세스(lsof)가 있을 때만 "도는 중" 으로 본다. 확인하지 못하면 평소대로 알린다(알림이 영영 끊기지 않게).
아테나 pane 이 선택 창(waiting)을 띄웠으면 뒤에서 닫힐 때까지 기다린다. 새 사용자 입력이 오면 옛 턴의 대기 알림은 버린다.
넣기는 scripts/lead-send.py 와 같은 길(pane run · 대기열 · 담당 대화 확인) — Claude · Codex 아테나 창 모두.
아테나 pane 이 없거나 닫혔으면 조용히 넘어간다. 어떤 오류도 세션을 막지 않는다(항상 exit 0).

사용: agent-done-notify.py prompt|stop   (훅 입력은 표준 입력 JSON)
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import uuid

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
from reuse_link import pane_lock
import screen  # noqa: E402 — 화면 계층 — pane 을 다루는 곳은 scripts/lib/screen.py 하나

PANE_ID = re.compile(r'^[\w-]{1,32}$')
ACK_MARK = '끝 알림'


def is_ack(prompt: str) -> bool:
    """아테나가 끝 알림에 답한 입력인가 — '[아테나 …' 로 시작하고 '끝 알림' 이 들어 있다"""
    return prompt.lstrip().startswith('[아테나') and ACK_MARK in prompt


GH_TIMEOUT = 3   # 초 — 훅이 느려지거나 네트워크가 없을 때 막히지 않게


def gh_pr_state(url: str):
    """gh 로 PR 실제 상태(draft · open · merged · closed)를 묻는다 — gh 가 없거나 실패 · 시간 초과면 None.
    시간이 넘으면 gh 와 그 자식까지 프로세스 묶음째 끈다(자식이 출력 파이프를 쥐고 남으면 기다림이 끝나지 않는다)"""
    gh = shutil.which('gh', path=f"{os.environ.get('PATH', '')}:/opt/homebrew/bin:/usr/local/bin")
    if not gh:
        return None
    try:
        proc = subprocess.Popen([gh, 'pr', 'view', url, '--json', 'state,isDraft'], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    except OSError:
        return None
    try:
        out, _ = proc.communicate(timeout=GH_TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            pass
        proc.wait()
        return None
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(out)
    except ValueError:
        return None
    state = str(data.get('state') or '').lower() if isinstance(data, dict) else ''
    if state == 'open' and data.get('isDraft') is True:
        return 'draft'
    return state if state in ('open', 'merged', 'closed') else None


def pr_state(url: str, number: str, recorded: str) -> str:
    """'#<번호> <상태>' — 상태는 gh 로 물은 실제 값, 못 물으면 계획서 값에 '(기록 기준)'"""
    actual = gh_pr_state(url)
    return f'#{number} {actual}' if actual else f'#{number} {recorded} (기록 기준)'


def plan_fields(text: str) -> dict:
    """계획서에서 Lead pane · Status · 마지막 PR 한 줄(번호 · 상태)을 읽는다"""
    def line(label: str):
        found = re.search(rf'^- {label}:[ \t]*(.*)$', text, re.M)
        return found.group(1).strip() if found else ''
    prs = re.findall(r'^- PR:[ \t]*(\S*/pull/(\d+))\b[^\n]*?,\s*([^·)\n]+)', text, re.M)
    pr = pr_state(prs[-1][0], prs[-1][1], prs[-1][2].strip()) if prs else ''
    # 바로 머지(PR 끔) — "- Auto merge: <레포> <브랜치> @<sha7> · <결과> · <시각>" 줄마다 "레포 브랜치 결과". 완료 판단은 현황판이 같은 줄로 한다(ship.sh 종료 코드가 아니다)
    merges = [f'{hit.group(1)} {hit.group(2)} {hit.group(3).strip()}' for hit in re.finditer(r'^- Auto merge:[ \t]*(\S+)[ \t]+(\S+)[ \t]+@[0-9a-f]+[ \t]+·[ \t]+(.+?)[ \t]+·[ \t]+\d{4}-\d{2}-\d{2} \d{2}:\d{2}[ \t]*$', text, re.M)]
    return {'lead': line('Lead pane').split()[0] if line('Lead pane') else '', 'status': line('Status').split()[0] if line('Status') else '', 'pr': pr, 'merge': ' / '.join(merges)}


def notice_line(agent: str, pane: str, plan: str, fields: dict) -> str:
    parts = [f'[{agent} → 아테나] 끝', pane, f'계획서 {plan}', f'Status {fields["status"] or "?"}']
    if fields['pr']:
        parts.append(f'PR {fields["pr"]}')
    if fields.get('merge'):
        parts.append(f'머지 {fields["merge"]}')
    return ' · '.join(parts)


def load_json(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


OUTPUT_PATH = re.compile(r'Output is being written to: (\S+\.output)')
FINISHED_TASK = re.compile(r'<task-notification>\s*<task-id>([^<]+)</task-id>')


def tool_result_text(entry: dict) -> str:
    """user 줄의 tool_result 글을 이어 붙인다 — 출력 파일 경로가 여기 있다"""
    content = (entry.get('message') or {}).get('content')
    if not isinstance(content, list):
        return ''
    texts = []
    for block in content:
        if not isinstance(block, dict) or block.get('type') != 'tool_result':
            continue
        inner = block.get('content')
        if isinstance(inner, str):
            texts.append(inner)
        elif isinstance(inner, list):
            texts += [str(item.get('text') or '') for item in inner if isinstance(item, dict)]
    return '\n'.join(texts)


def pending_outputs(transcript: pathlib.Path) -> list:
    """시작했는데 끝 기록이 없는 백그라운드 명령의 출력 파일들. 대화 기록은 수백 MB 까지 커서 관련 줄만 JSON 으로 푼다"""
    started = {}
    finished = set()
    with transcript.open('rb') as handle:
        for raw in handle:
            if b'<task-notification>' in raw:
                finished.update(FINISHED_TASK.findall(raw.decode('utf-8', 'replace').replace('\\n', '\n')))
            if b'"backgroundTaskId"' not in raw and b'"task_id"' not in raw:
                continue
            try:
                entry = json.loads(raw)
            except ValueError:
                continue
            result = entry.get('toolUseResult') if isinstance(entry, dict) else None
            if not isinstance(result, dict):
                continue
            if result.get('task_id'):
                finished.add(str(result['task_id']))   # TaskStop 은 끝 기록을 따로 남기지 않는다
            if result.get('backgroundTaskId'):
                found = OUTPUT_PATH.search(tool_result_text(entry))
                if found:
                    started[str(result['backgroundTaskId'])] = found.group(1)
    return [output for task_id, output in started.items() if task_id not in finished]


def output_in_use(output: str) -> bool:
    """이 출력 파일에 쓰는 프로세스가 있나 — 파일이 없거나 lsof 를 못 돌리면 False"""
    lsof = shutil.which('lsof', path=f"{os.environ.get('PATH', '')}:/usr/sbin:/usr/bin")
    if not lsof or not os.path.exists(output):
        return False
    try:
        return bool(subprocess.run([lsof, '-t', output], capture_output=True, text=True, timeout=5).stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return False


def background_running(event: dict) -> bool:
    """이 세션의 백그라운드 명령이 아직 도는가 — 확인하지 못하면 False(평소대로 알린다)"""
    transcript = str(event.get('transcript_path') or '')
    if not transcript:
        return False
    try:
        return any(output_in_use(output) for output in pending_outputs(pathlib.Path(transcript)))
    except OSError:
        return False


def save_state(path: pathlib.Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'.{path.stem}.{os.getpid()}.tmp')
    temp.write_text(json.dumps(state, ensure_ascii=False) + '\n', encoding='utf-8')
    os.replace(temp, path)


def forward(lead: str, line: str, plan: str) -> None:
    """에이전트 → 아테나 보내기와 같은 길(scripts/lead-send.py) — pane run 전송 확인 · 아테나가 못 받으면 모아 뒀다 넣기 ·
    계획서 Lead session 으로 담당 대화 확인 · 못 넣으면 계획서 기록. 예전처럼 send-text + Enter 를 직접 보내면 Codex 아테나 창에서
    글이 입력칸에 남거나 쓰던 초안과 섞였다(검수 #16). 종료 코드는 보지 않는다 — lead-send 가 결과를 계획서 · 사건 기록에 남긴다"""
    args = [sys.executable, str(ATHENA_DIR / 'scripts' / 'lead-send.py'), lead, line]
    if plan:
        args += ['--plan', plan]
    subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)


def deliver_notice(state_path: pathlib.Path, pane: str, lead: str, notice_id: str, wait: bool = False) -> None:
    """턴·알림 ID와 같은 잠금으로 전송을 선점한다. 옛 작업은 새 알림 문구가 같아도 버린다."""
    deadline = time.monotonic() + 6 * 3600
    while time.monotonic() < deadline:
        with pane_lock(state_path.parent, pane):
            state = load_json(state_path)
            pending = state.get('pending')
            if not isinstance(pending, dict) or pending.get('id') != notice_id or pending.get('turn') != state.get('turn') or pending.get('claimed'):
                return
            try:
                backend = screen.get_backend()
                target = backend.get_pane(lead)
                if target.get('agent_status') == 'waiting':
                    if not wait:
                        subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), 'deliver', pane, lead, notice_id],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         start_new_session=True, close_fds=True)
                        return
                else:
                    pending['claimed'] = True
                    save_state(state_path, state)
                    forward(lead, pending['line'], str(pending.get('plan') or ''))
                    state['last'] = pending['line']
                    state.pop('pending', None)
                    save_state(state_path, state)
                    return
            except Exception:
                state.pop('pending', None)
                save_state(state_path, state)
                return
        time.sleep(2)
    with pane_lock(state_path.parent, pane):
        state = load_json(state_path)
        if (state.get('pending') or {}).get('id') == notice_id:
            state.pop('pending', None)
            save_state(state_path, state)


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    agent = os.environ.get('ATHENA_AGENT') or ''
    if mode == 'deliver' and len(sys.argv) == 5:
        pane, lead, notice_id = sys.argv[2:]
        if PANE_ID.fullmatch(pane) and PANE_ID.fullmatch(lead):
            deliver_notice(ATHENA_DIR / '.pack-data' / 'state' / 'agent-notify' / f'{pane}.json', pane, lead, notice_id, wait=True)
        return
    if mode not in ('prompt', 'stop') or not agent or agent == 'reviewer':
        return  # reviewer 는 계획서 줄로 결론을 남기고 pane 이 저절로 닫힌다(review-wait.sh)
    pane = str(screen.self_info().get('pane_id') or '')
    if not PANE_ID.match(pane):
        return
    pack_data = ATHENA_DIR / '.pack-data'
    if not pack_data.is_symlink():
        return
    base = pack_data.resolve() / 'state'
    state_path = base / 'agent-notify' / f'{pane}.json'
    event = json.load(sys.stdin)
    if mode == 'prompt':
        with pane_lock(state_path.parent, pane):
            state = load_json(state_path)
            bootstrap = not state.get('turn') and os.environ.get('ATHENA_NOTIFY_BOOTSTRAP') == '1'
            state['skip'] = bootstrap or is_ack(str(event.get('prompt') or ''))
            state['turn'] = uuid.uuid4().hex
            state.pop('pending', None)
            state['last'] = ''
            save_state(state_path, state)
        return
    initial = load_json(state_path)
    if not initial.get('turn') or initial.get('skip'):
        return  # 첫 사용자 입력(prompt) 전의 idle 은 끝난 작업이 아니다
    if background_running(event):
        return   # 아직 도는 명령이 있다 — 끝나서 다음 Stop 이 오면 그때 알린다(last 를 남기지 않는다)
    plan = str(load_json(base / 'pane-sessions' / f'{pane}.json').get('plan') or os.environ.get('ATHENA_PLAN') or '')
    if not plan:
        return
    try:
        fields = plan_fields((ATHENA_DIR / plan).read_text(encoding='utf-8'))
    except OSError:
        return
    lead = fields['lead']
    if not PANE_ID.match(lead) or lead == pane:
        return
    line = notice_line(agent, pane, plan, fields)
    with pane_lock(state_path.parent, pane):
        state = load_json(state_path)
        if not state.get('turn') or state.get('skip'):
            return
        turn = state['turn']
        pending = state.get('pending') or {}
        if state.get('last') == line or (pending.get('turn') == turn and pending.get('line') == line):
            return
        notice_id = uuid.uuid4().hex
        state['pending'] = {'id': notice_id, 'turn': turn, 'line': line, 'plan': plan}
        save_state(state_path, state)
    deliver_notice(state_path, pane, lead, notice_id)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
