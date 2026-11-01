#!/usr/bin/env python3
"""Claude Code 권한 확인 창("Do you want to make this edit…" 1 Yes / 2 Yes, always / 3 No)을 스튜디오 [작업] 에 알리는 훅 (PermissionRequest).

왜: 권한 확인 창은 사람이 pane 에서 골라야 하는데 [작업] 에는 아무것도 안 떠서 못 보고 지나간다(2026-11-01).
무엇을: 요청 알림을 열고 그 pane 으로 가는 길을 둔다. **허용 · 거부는 하지 않는다** — 훅은 아무 결정도 돌려주지 않아(출력 없음) 창이 그대로 뜬다.
  [작업] 에서 받은 답을 허용으로 바꿔 돌려주지도 않는다(키를 대신 눌러 잘못 허용되는 일이 없게). 사람이 pane 에서 고르면 요청은 저절로 거둔다.
이 훅이 불리는 때는 Claude Code 가 사람에게 물으려 할 때뿐이다(허용 규칙 · 자동 허용 도구는 이 훅까지 오지 않는다).
창이 몇 초 안에 닫히면(분류기가 곧 허용하는 등) 요청을 열지 않는다 — 뒤에서 도는 지킴이(scripts/lib/pane_request.py)가 기다렸다 본다. 훅 자체는 바로 끝난다.
같은 pane 의 권한 창은 요청 하나(--key perm:<pane>)를 고쳐 쓴다 — 연달아 떠도 팝업이 쌓이지 않는다.
대상 둘(인자로 가른다 — 같은 세션에 두 설정이 겹쳐 실려도 한 번만): 위임 에이전트(인자 없음 · ATHENA_AGENT 있음) · 아테나 pane(인자 `lead` · ATHENA_AGENT 없음).
어떤 실패도 창을 막지 않는다(항상 exit 0 · 출력 없음).
"""
import json
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'lib'))
import pane_request  # noqa: E402


def main() -> None:
    lead = sys.argv[1:2] == ['lead']
    if lead == bool(os.environ.get('ATHENA_AGENT')):
        return
    event = json.load(sys.stdin)
    pane = pane_request.caller_pane()
    if not pane:
        return  # pane 을 모르면 가리킬 곳이 없다 — 요청을 열지 않는다
    tool_input = event.get('tool_input') if isinstance(event.get('tool_input'), dict) else {}
    # 쓸 칸만 넘긴다 — 파일 쓰기의 content 같은 긴 글 · 비밀이 섞일 수 있는 글을 디스크에 두지 않는다
    shown = {key: tool_input[key] for key in pane_request.DETAIL_KEYS if key in tool_input}
    with tempfile.NamedTemporaryFile('w', suffix='.json', prefix='athena-perm-', delete=False, encoding='utf-8') as handle:
        json.dump({'pane': pane, 'event': {'tool_name': event.get('tool_name'), 'tool_input': shown}}, handle)
        payload = handle.name
    os.chmod(payload, 0o600)
    pane_request.spawn(['permission', payload])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        pane_request.log_failure(f'권한 훅 오류: {error}')
    sys.exit(0)
