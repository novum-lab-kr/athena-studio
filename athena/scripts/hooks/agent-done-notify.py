#!/usr/bin/env python3
"""위임 에이전트 끝 알림 훅 (UserPromptSubmit · Stop) — delegate.sh · agent-context.py 가 위임 에이전트 세션(ATHENA_AGENT · reviewer 포함)에만 건다.

차례 상태 파일(state/agent-turn/<pane>.json — scripts/lib/agent_turn.py)을 먼저 적는다: 입력(prompt) → working · 끝(stop) → done
  (같은 차례에 고르기 질문을 요청으로 올렸으면 asking 그대로) · 도는 백그라운드 명령 수 · 마지막 답 끝이 질문인지. "끝났다" 는 이 파일로 정한다.
  알림은 그 상태로 만든다 — 넣은 알림은 받음 확인 대상으로 남아(lead-send.py --track) 아테나가 안 받으면 현황판이 다시 넣고 요청을 연다.

에이전트가 한 차례(턴)를 끝내면(Stop) 그 pane 을 띄운 아테나 pane 에 한 줄을 입력한다:
  [<에이전트> → 아테나] 끝 · <pane> · 계획서 <경로> · Status <값> · PR <번호 · 상태>(있을 때만 · 상태는 gh 로 물은 실제 값, 못 물으면 계획서 값 + "(기록 기준)") · 머지 <레포 브랜치 결과>(PR 끔 레포의 바로 머지 — "- Auto merge:" 줄이 있을 때만)
계획서 지시의 "멈춤:" 에서 멈춘 차례(마지막 답에 "⏸ 멈춤: <기다리는 것>" 으로 시작하는 줄 — delegate.sh 머리말이 그렇게 쓰게 한다)는 "끝" 대신
  [<에이전트> → 아테나] ⏸ 멈춤 · <pane> · 계획서 <경로> · Status <값> · <기다리는 것> 으로 알리고 사건 plan.stop 을 남긴다(현황판 [지표] 탭이 센다).
멈춤 표시 없이 질문으로 끝낸 차례(마지막 줄이 물음표 — "커밋할까요?" · 또는 고르기 질문을 요청으로 올린 차례)는 "끝" 대신 "질문으로 멈춤"(결정 D3).
  마지막 답은 훅 입력 last_assistant_message 가 있으면 그것, 없으면 대화 기록(transcript_path) 끝의 마지막 assistant 글
아테나 pane 은 계획서 Checkpoint 의 "- Lead pane:" 줄(delegate.sh 가 적는다)에서 읽는다 — 새 기록을 만들지 않는다.
계획서는 pane 기록(state/pane-sessions/<pane>.json — 이어 보내기로 바뀐 계획서도 따라간다)을 먼저, 없으면 환경 ATHENA_PLAN.

무한 왕복 막기 — 상태는 <팩 데이터>/state/agent-notify/<pane>.json
  - 첫 입력 전 Stop · 지시 없이 띄운 시작 안내(ATHENA_NOTIFY_BOOTSTRAP)는 알리지 않는다
  - 같은 줄은 사용자 입력이 새로 오기 전에는 다시 보내지 않는다(새 입력이 오면 같은 내용도 다시 알린다 — 같은 계획서에 요청을 이어 받는 경우)
  - 아테나가 이 알림에 답한 입력("[아테나 …] … 끝 알림 …")으로 시작한 차례는 알리지 않는다
백그라운드 명령이 아직 돌아도 그 차례는 알리고 줄 끝에 "(백그라운드 명령 N개 도는 중)" 을 붙인다 — 미루면 다음 Stop 이 안 와 알림이 영영 안 갔다.
  명령이 끝나 다음 Stop 이 오면 줄이 달라져 한 번 더 간다(같은 줄 중복 막기는 그대로).
  대기 목록 = 대화 기록(transcript_path)의 시작 기록(backgroundTaskId · 출력 파일) − 끝 기록(task-notification · TaskStop). 끝 기록이 영영 안 남는 경우가 있어
  기록만 믿지 않고 출력 파일을 쥔 프로세스(lsof)가 있는 것만 "도는 중" 으로 센다. 확인하지 못하면 0개로 본다(개수 없이 알린다).
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
import agent_turn  # noqa: E402 — 차례 상태 파일 · 받음 확인
import pane_request  # noqa: E402 — 선택 창 판정(prompt-menu.json · 데몬 waiting 합집합)

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


def notice_head(stop: str, question: bool) -> str:
    if stop:
        return '⏸ 멈춤'
    return '질문으로 멈춤' if question else '끝'


def notice_line(agent: str, pane: str, plan: str, fields: dict, stop: str = '', background: int = 0, question: bool = False) -> str:
    head = notice_head(stop, question)
    parts = [f'[{agent} → 아테나] {head}', pane, f'계획서 {plan}', f'Status {fields["status"] or "?"}']
    if stop:
        parts.append(stop)
    if fields['pr']:
        parts.append(f'PR {fields["pr"]}')
    if fields.get('merge'):
        parts.append(f'머지 {fields["merge"]}')
    if background:
        parts.append(f'(백그라운드 명령 {background}개 도는 중)')
    return ' · '.join(parts)


STOP_MARK = re.compile(r'^[\s#>*_`-]*⏸\s*멈춤\s*[:：]?\s*(.*)$', re.M)
TAIL_BYTES = 2 * 1024 * 1024   # 대화 기록은 수백 MB 까지 커서 끝부분만 읽는다


def assistant_text(content) -> str:
    """assistant 줄의 글 조각을 이어 붙인다(도구 호출 · 생각은 뺀다)"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return '\n'.join(str(block.get('text') or '') for block in content if isinstance(block, dict) and block.get('type') == 'text')


def last_reply(event: dict) -> str:
    """이 차례의 마지막 답 — 훅 입력 last_assistant_message, 없으면 대화 기록 끝에서 글이 있는 마지막 assistant 줄. 못 읽으면 ''"""
    given = event.get('last_assistant_message')
    if isinstance(given, str) and given.strip():
        return given
    transcript = str(event.get('transcript_path') or '')
    if not transcript:
        return ''
    try:
        with open(transcript, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - TAIL_BYTES))
            rows = handle.read().split(b'\n')
    except OSError:
        return ''
    for raw in reversed(rows):
        if b'"assistant"' not in raw:
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get('type') != 'assistant':
            continue
        text = assistant_text((entry.get('message') or {}).get('content'))
        if text.strip():
            return text
    return ''


def stop_reason(reply: str) -> str:
    """멈춤 표시 줄의 '기다리는 것' — 표시가 없으면 ''. 알림 한 줄에 들어가게 줄인다"""
    found = STOP_MARK.search(reply)
    if not found:
        return ''
    reason = re.sub(r'[*_`]+', '', found.group(1)).strip() or '(기다리는 것 안 적음)'
    return reason if len(reason) <= 120 else reason[:119] + '…'


def log_event(kind: str, **fields: str) -> None:
    """사건 기록(scripts/lib/events.mjs) — 실패해도 무시한다"""
    try:
        subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'lib' / 'events.mjs'), kind, *[f'{key}={value}' for key, value in fields.items()]],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


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


def background_running(event: dict) -> int:
    """이 세션에서 아직 도는 백그라운드 명령 개수 — 확인하지 못하면 0(개수 없이 알린다)"""
    transcript = str(event.get('transcript_path') or '')
    if not transcript:
        return 0
    try:
        return sum(1 for output in pending_outputs(pathlib.Path(transcript)) if output_in_use(output))
    except OSError:
        return 0


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
    args.append('--track')   # 넣은 알림을 받음 확인 대상으로(state/lead-notices — 안 받으면 현황판이 다시 넣는다)
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
                menu = pane_request.pane_menu(lead)
                if menu == 'gone':
                    raise RuntimeError('아테나 pane 이 없다')
                if menu is True:
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
    if mode not in ('prompt', 'stop') or not agent:
        return  # reviewer 도 알린다(결정 D2) — 결론은 계획서 줄 · pane 은 review-wait.sh 가 닫는다
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
            turn = state['turn']
        plan = str(load_json(base / 'pane-sessions' / f'{pane}.json').get('plan') or os.environ.get('ATHENA_PLAN') or '')
        try:
            agent_turn.write_turn(pane, state='working', agent=agent, plan=plan, turn=turn, background=0, question=False, stop='', requests=[])
        except Exception:
            pass
        return
    initial = load_json(state_path)
    if not initial.get('turn'):
        return  # 첫 사용자 입력(prompt) 전의 idle 은 끝난 작업이 아니다
    plan = str(load_json(base / 'pane-sessions' / f'{pane}.json').get('plan') or os.environ.get('ATHENA_PLAN') or '')
    reply = last_reply(event)
    stop = stop_reason(reply)
    background = background_running(event)
    previous = agent_turn.read_turn(pane)
    # 같은 차례에 고르기 질문을 [작업] 요청으로 올렸으면 그 질문을 기다리며 멈춘 것 — asking 그대로
    asking = previous.get('state') == 'asking' and previous.get('turn') == initial['turn']
    question = asking or (not stop and agent_turn.ends_with_question(reply))
    try:
        agent_turn.write_turn(pane, state='asking' if asking else 'done', agent=agent, plan=plan, turn=initial['turn'],
                              background=background, question=question, stop=stop)
    except Exception:
        pass
    if initial.get('skip') or not plan:
        return  # 시작 안내 · 아테나의 끝 알림 답으로 시작한 차례는 알리지 않는다
    try:
        fields = plan_fields((ATHENA_DIR / plan).read_text(encoding='utf-8'))
    except OSError:
        return
    lead = fields['lead']
    if not PANE_ID.match(lead) or lead == pane:
        return
    line = notice_line(agent, pane, plan, fields, stop, background, question)
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
    if stop:
        log_event('plan.stop', plan=plan, agent=agent, pane=pane)
    deliver_notice(state_path, pane, lead, notice_id)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
