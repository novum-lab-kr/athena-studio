#!/usr/bin/env python3
"""화면 세팅 훅 (SessionStart) — 아테나 세션이 켜지면 scripts/athena-up.sh 를 뒤에서 돌린다.
Claude Code 는 .claude/settings.json, Codex 는 .codex/hooks.json(--tool codex) 이 건다.

현황판을 (없으면) 뒤에서 띄우고, 첫 실행이면 첫 실행 지시를 입력한다.
아테나 세션만 — FE 에이전트(claude --agent)·reviewer, athena 루트가 아닌 cwd, 화면 pane(Athena Studio) 밖,
도구 pane 안에서 뜬 claude(배우기 검토의 claude -p 등)는 건너뛴다. 세션 시작을 막거나 늦추지 않는다(항상 exit 0).
팩이 없고 새로 켠 세션이면 ATHENA_FIRST_RUN=<도구> 를 넘겨, 화면 세팅이 끝난 뒤 이 pane 에 첫 실행 지시를 입력하게 한다.
"""
import json
import os
import subprocess
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

ATHENA_DIR = os.path.realpath(os.path.join(os.path.dirname(__file__), '..', '..'))
TOOL = sys.argv[sys.argv.index('--tool') + 1] if '--tool' in sys.argv[:-1] else 'claude'
TOOL_LABELS = {'📋 현황판', '🛰 에이전트 모니터', '📚 배우기 검토', '가이드 메뉴', 'Explorer'}


def main() -> None:
    if payload.get('agent_type') or os.environ.get('ATHENA_AGENT'):
        return
    if os.path.realpath(payload.get('cwd') or os.getcwd()) != ATHENA_DIR:
        return
    sys.path.insert(0, os.path.join(ATHENA_DIR, 'scripts', 'lib'))
    import screen  # 화면 계층 — pane 을 묻는 곳은 scripts/lib/screen.py 하나
    me = screen.self_info()
    if not me['inside'] or not me['pane_id']:
        return
    # 도구 pane 안에서 뜬 claude 는 건너뛴다
    try:
        mine = next((p for p in screen.list_panes(timeout=3) if p['id'] == me['pane_id']), {})
        if mine.get('label') in TOOL_LABELS:
            return
    except Exception:
        return
    env = dict(os.environ)
    from athena_config import needs_first_run
    # 첫 실행 자동 시작은 새로 켠 세션에서만 — 재개·/clear 에 다시 입력하지 않는다
    if payload.get('source') in (None, 'startup') and needs_first_run(ATHENA_DIR):
        env['ATHENA_FIRST_RUN'] = TOOL
    subprocess.Popen(
        [os.path.join(ATHENA_DIR, 'scripts', 'athena-up.sh')], env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


try:
    main()
except Exception:
    pass
sys.exit(0)
