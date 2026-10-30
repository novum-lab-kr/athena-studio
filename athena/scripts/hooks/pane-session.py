#!/usr/bin/env python3
"""pane ↔ 대화 기록 훅 (SessionStart · UserPromptSubmit) — Claude Code 는 .claude/settings.json · 위임 에이전트는 delegate.sh · agent-context.py 가 건다.

화면 pane 안에서(화면 계층 screen.self_info() 의 pane_id) 세션이 시작 · 재개 · 압축 · 지우기로 바뀔 때와 메시지를 보낼 때마다(훅이 생기기 전에 켠 세션도 잡게)
<팩 데이터>/state/pane-sessions/<pane>.json 에 { pane, session, cwd, agent, plan, at } 를 적는다.
팩 백업(pack backup --with-work)이 이 기록으로 "어느 pane 에서 어느 대화를 하고 있었나" 를 담고, 되살릴 때 claude --resume 으로 잇는다(docs/pack.md).
pane 마다 파일 하나라 동시에 여러 세션이 시작돼도 서로 덮지 않는다. 본체는 이 파일 위치로 찾는다. 어떤 오류도 세션을 막지 않는다(항상 exit 0).
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
SESSION_ID = re.compile(r'^[0-9a-fA-F-]{8,64}$')
PANE_ID = re.compile(r'^[\w-]{1,32}$')


def main() -> None:
    pane = str(screen.self_info().get('pane_id') or '')
    if not PANE_ID.match(pane):
        return
    try:
        event = json.load(sys.stdin)
    except Exception:
        return
    session = str(event.get('session_id') or '')
    if not SESSION_ID.match(session):
        return
    pack_data = ATHENA_DIR / '.pack-data'
    if not pack_data.is_symlink():
        return  # 옛 구조 본체 — 팩 데이터가 없다
    record = {
        'pane': pane,
        'session': session,
        'cwd': os.path.realpath(str(event.get('cwd') or os.getcwd())),
        # 위임 에이전트는 delegate.sh 가 ATHENA_AGENT · ATHENA_PLAN 을 넘긴다 — 없으면 본체에서 켠 아테나
        'agent': os.environ.get('ATHENA_AGENT') or 'athena',
        'plan': os.environ.get('ATHENA_PLAN') or None,
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    folder = pack_data.resolve() / 'state' / 'pane-sessions'
    folder.mkdir(parents=True, exist_ok=True)
    # 이어 보내기(delegate.sh --reuse-pane)로 다른 계획서를 받은 pane — 기록의 plan 은 새 계획서고 envPlan 은 처음 띄울 때의 환경 값이다.
    # 같은 세션이고 환경 값이 그대로면 옛 계획서로 되돌리지 않는다(되돌리면 끝난 계획서가 다시 진행 중으로 묶인다)
    try:
        previous = json.loads((folder / f'{pane}.json').read_text(encoding='utf-8'))
        if previous.get('session') == session and previous.get('envPlan') and previous.get('envPlan') == record['plan'] and previous.get('plan'):
            record['plan'] = previous['plan']
        if previous.get('session') == session and previous.get('envPlan'):
            record['envPlan'] = previous['envPlan']
    except Exception:
        pass
    temp = folder / f'.{pane}.{os.getpid()}.tmp'
    temp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, folder / f'{pane}.json')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
