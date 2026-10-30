#!/usr/bin/env python3
"""위임 에이전트 끝 알림 훅 (UserPromptSubmit · Stop) — delegate.sh · agent-context.py 가 위임 에이전트 세션(ATHENA_AGENT)에만 건다.

에이전트가 한 차례(턴)를 끝내면(Stop) 그 pane 을 띄운 아테나 pane 에 한 줄을 입력한다:
  [<에이전트> → 아테나] 끝 · <pane> · 계획서 <경로> · Status <값> · PR <번호 · 상태>(있을 때만)
아테나 pane 은 계획서 Checkpoint 의 "- Lead pane:" 줄(delegate.sh 가 적는다)에서 읽는다 — 새 기록을 만들지 않는다.
계획서는 pane 기록(state/pane-sessions/<pane>.json — 이어 보내기로 바뀐 계획서도 따라간다)을 먼저, 없으면 환경 ATHENA_PLAN.

무한 왕복 막기 — 상태는 <팩 데이터>/state/agent-notify/<pane>.json
  - 같은 줄은 사용자 입력이 새로 오기 전에는 다시 보내지 않는다(새 입력이 오면 같은 내용도 다시 알린다 — 같은 계획서에 요청을 이어 받는 경우)
  - 아테나가 이 알림에 답한 입력("[아테나 …] … 끝 알림 …")으로 시작한 차례는 알리지 않는다
아테나 pane 이 없거나 닫혔으면 조용히 넘어간다. 어떤 오류도 세션을 막지 않는다(항상 exit 0).

사용: agent-done-notify.py prompt|stop   (훅 입력은 표준 입력 JSON)
"""
import json
import os
import pathlib
import re
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
