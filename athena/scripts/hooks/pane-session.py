#!/usr/bin/env python3
"""pane ↔ 대화 기록 훅 (SessionStart · UserPromptSubmit) — Claude Code 는 .claude/settings.json · 위임 에이전트는 delegate.sh · agent-context.py 가 건다.

화면 pane 안에서(화면 계층 screen.self_info() 의 pane_id) 세션이 시작 · 재개 · 압축 · 지우기로 바뀔 때와 메시지를 보낼 때마다(훅이 생기기 전에 켠 세션도 잡게)
<팩 데이터>/state/pane-sessions/<pane>.json 에 { pane, session, cwd, agent, plan, at } 를 적는다.
팩 백업(pack backup --with-work)이 이 기록으로 "어느 pane 에서 어느 대화를 하고 있었나" 를 담고, 되살릴 때 claude --resume 으로 잇는다(docs/pack.md).
pane 마다 파일 하나라 동시에 여러 세션이 시작돼도 서로 덮지 않는다. 본체는 이 파일 위치로 찾는다. 어떤 오류도 세션을 막지 않는다(항상 exit 0).
메시지를 보낼 때(입력에 prompt 가 있을 때)는 사람이 직접 쓴 글이면 이 pane 의 열린 질문을 대화 답으로 닫고 추가 문맥으로 알린다(lib/chat_answer.py).
아테나 pane(ATHENA_AGENT 없음)이면 그 입력에 든 에이전트 알림을 받음으로 표시한다(lib/agent_turn.py mark_received — Claude · Codex 아테나 모두 이 훅이 돈다).
아테나 pane 에서 대화를 지워 새로 시작하면(SessionStart source=clear — Claude /clear · Codex /new) 옛 대화를 가리키던 진행 중 계획서
"- Lead session:" · 모아 둔 lead-send 글을 새 대화로 옮긴다(lib/lead_rebind.py — 사용자가 손으로 지우면 아무도 안 옮겨 에이전트 보고가
"담당 대화가 바뀌었다" 로 막혔다 · 2026-11-11 p1m). lead-fresh.py 가 지운 때도 같은 일을 해서 두 번 돌아도 결과가 같다.
"""
import datetime
import json
import os
import pathlib
import re
import sys

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
import screen  # noqa: E402 — 화면 계층 — pane 을 묻는 곳은 scripts/lib/screen.py 하나
from reuse_link import pane_lock  # noqa: E402 — 이어 보내기와 같은 기록 잠금
import chat_answer  # noqa: E402 — 대화로 답한 질문 닫기
import agent_turn  # noqa: E402 — 아테나가 받은 알림 표시(state/lead-notices)
import lead_rebind  # noqa: E402 — 대화를 지운 뒤 계획서 Lead session · lead-send 대기열 옮기기
SESSION_ID = re.compile(r'^[0-9a-fA-F-]{8,64}$')
PANE_ID = re.compile(r'^[\w-]{1,32}$')


def headless_claude() -> bool:
    """pane 안에서 다른 프로그램(플러그인 · 스크립트)이 띄운 headless claude(-p · SDK) 인가 — claude 가 진입점을 CLAUDE_CODE_ENTRYPOINT 로
    자식(훅)에 넘긴다(대화형 cli · headless sdk-cli — 2026-11-04 실측). pane 환경을 물려받아 같은 pane 으로 보이지만 그 pane 의 대화가 아니다.
    기록하면 담당 대화가 바뀐 것으로 보여 lead-send 가 막힌다(2026-11-04 px5)"""
    return os.environ.get('CLAUDE_CODE_ENTRYPOINT', '').startswith('sdk')


def main() -> None:
    if '--tool=codex' not in sys.argv and headless_claude():
        return
    pane = str(screen.self_info().get('pane_id') or '')
    if not PANE_ID.match(pane):
        return
    try:
        event = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(event, dict):
        return
    try:
        notice = chat_answer.close_by_chat(pane, event['prompt']) if isinstance(event.get('prompt'), str) else ''
    except Exception:
        notice = ''
    if isinstance(event.get('prompt'), str) and not os.environ.get('ATHENA_AGENT'):
        try:
            # 아테나 pane 이 받은 입력 — 그 안에 든 에이전트 알림을 받음으로 표시한다(현황판이 안 받은 알림만 다시 넣는다 · lib/agent_turn.py)
            agent_turn.mark_received(pane, event['prompt'])
        except Exception:
            pass
    try:
        previous = record(pane, event)
        session = str(event.get('session_id') or '')
        if event.get('source') == 'clear' and not os.environ.get('ATHENA_AGENT') and previous and previous != session:
            try:
                lead_rebind.rebind(pane, previous, session)
            except Exception:
                pass
    finally:
        if notice:
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': notice}}, ensure_ascii=False))


def record(pane: str, event: dict) -> str:
    """pane 기록을 새로 적고 그 전에 적혀 있던 대화(session)를 돌려준다(없으면 '')"""
    session = str(event.get('session_id') or '')
    if not SESSION_ID.match(session):
        return ''
    pack_data = ATHENA_DIR / '.pack-data'
    if not pack_data.is_symlink():
        return ''  # 옛 구조 본체 — 팩 데이터가 없다
    record = {
        'pane': pane,
        'session': session,
        'cwd': os.path.realpath(str(event.get('cwd') or os.getcwd())),
        # 위임 에이전트는 delegate.sh 가 ATHENA_AGENT · ATHENA_PLAN 을 넘긴다 — 없으면 본체에서 켠 아테나
        'agent': os.environ.get('ATHENA_AGENT') or 'athena',
        'engine': 'codex' if '--tool=codex' in sys.argv else (os.environ.get('ATHENA_ENGINE') or 'claude'),
        'role': os.environ.get('ATHENA_ROLE') or ('agent' if os.environ.get('ATHENA_AGENT') else 'lead'),
        'plan': os.environ.get('ATHENA_PLAN') or None,
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    folder = pack_data.resolve() / 'state' / 'pane-sessions'
    folder.mkdir(parents=True, exist_ok=True)
    # 이어 보내기(delegate.sh --reuse-pane)로 다른 계획서를 받은 pane — 기록의 plan 은 새 계획서고 envPlan 은 처음 띄울 때의 환경 값이다.
    # 환경 값이 envPlan 과 같으면(같은 실행 pane — /clear 로 session 이 바뀌어도) 옛 계획서로 되돌리지 않고 plan · envPlan 을 이어 받는다
    # (되돌리면 끝난 계획서가 다시 진행 중으로 묶인다). 읽기 · 쓰기는 delegate.sh 의 기록 갱신과 같은 잠금으로 직렬화한다
    old_session = ''
    with pane_lock(folder, pane):
        try:
            previous = json.loads((folder / f'{pane}.json').read_text(encoding='utf-8'))
            old_session = str(previous.get('session') or '')
            if previous.get('envPlan') and previous.get('envPlan') == record['plan'] and previous.get('plan'):
                record['plan'] = previous['plan']
                record['envPlan'] = previous['envPlan']
        except Exception:
            pass
        temp = folder / f'.{pane}.{os.getpid()}.tmp'
        temp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(temp, folder / f'{pane}.json')
    return old_session


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
