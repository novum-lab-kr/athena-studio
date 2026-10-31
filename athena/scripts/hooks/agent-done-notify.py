#!/usr/bin/env python3
"""위임 에이전트 끝 알림 훅 (UserPromptSubmit · Stop) — delegate.sh · agent-context.py 가 위임 에이전트 세션(ATHENA_AGENT)에만 건다.

에이전트가 한 차례(턴)를 끝내면(Stop) 그 pane 을 띄운 아테나 pane 에 한 줄을 입력한다:
  [<에이전트> → 아테나] 끝 · <pane> · 계획서 <경로> · Status <값> · PR <번호 · 상태>(있을 때만)
아테나 pane 은 계획서 Checkpoint 의 "- Lead pane:" 줄(delegate.sh 가 적는다)에서 읽는다 — 새 기록을 만들지 않는다.
계획서는 pane 기록(state/pane-sessions/<pane>.json — 이어 보내기로 바뀐 계획서도 따라간다)을 먼저, 없으면 환경 ATHENA_PLAN.

무한 왕복 막기 — 상태는 <팩 데이터>/state/agent-notify/<pane>.json
  - 같은 줄은 사용자 입력이 새로 오기 전에는 다시 보내지 않는다(새 입력이 오면 같은 내용도 다시 알린다 — 같은 계획서에 요청을 이어 받는 경우)
  - 아테나가 이 알림에 답한 입력("[아테나 …] … 끝 알림 …")으로 시작한 차례는 알리지 않는다
백그라운드 명령이 아직 돌면 그 차례는 알리지 않고 last 도 남기지 않는다 — 명령이 끝나 다시 Stop 이 오면 그때 알린다.
  대기 목록 = 대화 기록(transcript_path)의 시작 기록(backgroundTaskId · 출력 파일) − 끝 기록(task-notification · TaskStop). 끝 기록이 영영 안 남는 경우가 있어
  기록만 믿지 않고 출력 파일을 쥔 프로세스(lsof)가 있을 때만 "도는 중" 으로 본다. 확인하지 못하면 평소대로 알린다(알림이 영영 끊기지 않게).
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

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
import screen  # noqa: E402 — 화면 계층 — pane 을 다루는 곳은 scripts/lib/screen.py 하나

PANE_ID = re.compile(r'^[\w-]{1,32}$')
ACK_MARK = '끝 알림'


def is_ack(prompt: str) -> bool:
    """아테나가 끝 알림에 답한 입력인가 — '[아테나 …' 로 시작하고 '끝 알림' 이 들어 있다"""
    return prompt.lstrip().startswith('[아테나') and ACK_MARK in prompt


def plan_fields(text: str) -> dict:
    """계획서에서 Lead pane · Status · 마지막 PR 한 줄(번호 · 상태)을 읽는다"""
    def line(label: str):
        found = re.search(rf'^- {label}:[ \t]*(.*)$', text, re.M)
        return found.group(1).strip() if found else ''
    prs = re.findall(r'^- PR:[ \t]*\S*/pull/(\d+)\b[^\n]*?,\s*([^·)\n]+)', text, re.M)
    pr = f'#{prs[-1][0]} {prs[-1][1].strip()}' if prs else ''
    return {'lead': line('Lead pane').split()[0] if line('Lead pane') else '', 'status': line('Status').split()[0] if line('Status') else '', 'pr': pr}


def notice_line(agent: str, pane: str, plan: str, fields: dict) -> str:
    parts = [f'[{agent} → 아테나] 끝', pane, f'계획서 {plan}', f'Status {fields["status"] or "?"}']
    if fields['pr']:
        parts.append(f'PR {fields["pr"]}')
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


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    agent = os.environ.get('ATHENA_AGENT') or ''
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
    state = load_json(state_path)
    event = json.load(sys.stdin)

    def save() -> None:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        temp = state_path.with_name(f'.{pane}.{os.getpid()}.tmp')
        temp.write_text(json.dumps(state, ensure_ascii=False) + '\n', encoding='utf-8')
        os.replace(temp, state_path)

    if mode == 'prompt':
        state['skip'] = is_ack(str(event.get('prompt') or ''))
        state['last'] = ''   # 새 입력 — 이 차례가 끝나면 같은 내용이어도 다시 알린다
        save()
        return

    if state.get('skip'):
        return   # 회신 턴 — 지우지 않는다(새 입력 없이 Stop 이 다시 와도 알리지 않게). 다음 prompt 가 갱신한다
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
    if state.get('last') == line:
        return
    try:
        screen.get_backend().get_pane(lead)   # 닫힌 pane 이면 예외 — 조용히 넘어간다
        screen.get_backend().send_text(lead, line)
        screen.get_backend().send_keys(lead, ['Enter'])
    except Exception:
        return
    state['last'] = line
    save()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
