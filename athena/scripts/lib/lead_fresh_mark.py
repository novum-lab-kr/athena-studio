"""아테나 새로 시작하기(scripts/lead-fresh.py)를 언제 마지막으로 물었나 · 지웠나 — pane 마다.

압축 경고 훅(scripts/hooks/compact-checkpoint.py warn)이 사용자에게 물으라고 할 때 'asked', lead-fresh 처리기가 /clear(/new) 를
넣을 때 'cleared' 를 적는다. 경고 훅은 둘 중 하나라도 QUIET_SECONDS 안이면 다시 물으라고 하지 않는다 — 새 대화는 세션이 바뀌어
세션마다 한 번인 경고 표시로는 못 막는다(2026-11-11 p1m 이 21분 만에 두 번 지웠다 · 사용자 결정: 묻고 지우기 · 30분 안에는 다시 묻지 않기).
자리: 팩 데이터 state/lead-fresh/<pane>.<asked|cleared>(옛 구조면 본체 lead-fresh/ — lead-fresh.py 처리기 잠금과 같은 폴더). 글 = 적은 때(epoch 초)
"""
import pathlib
import re
import time

import pane_request  # 팩 데이터 자리(pack_state)

QUIET_SECONDS = 30 * 60
KINDS = ('asked', 'cleared')
PANE_ID = re.compile(r'^[\w-]{1,32}$')


def folder() -> pathlib.Path:
    return (pane_request.pack_state() or pane_request.ATHENA_DIR) / 'lead-fresh'


def mark(pane: str, kind: str) -> None:
    """지금 시각을 적는다 — 실패해도 무시한다(표시가 없으면 다음에 한 번 더 물을 뿐이다)"""
    if kind not in KINDS or not PANE_ID.fullmatch(pane or ''):
        return
    try:
        target = folder()
        target.mkdir(parents=True, exist_ok=True)
        (target / f'{pane}.{kind}').write_text(f'{time.time():.0f}\n', encoding='utf-8')
    except OSError:
        pass


def recent(pane: str, now: float = 0.0) -> bool:
    """QUIET_SECONDS 안에 묻거나 지웠나"""
    if not PANE_ID.fullmatch(pane or ''):
        return False
    now = now or time.time()
    for kind in KINDS:
        try:
            stamp = float((folder() / f'{pane}.{kind}').read_text(encoding='utf-8').strip())
        except (OSError, ValueError):
            continue
        if now - stamp < QUIET_SECONDS:
            return True
    return False
