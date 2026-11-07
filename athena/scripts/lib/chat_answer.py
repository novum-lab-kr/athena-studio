"""대화로 답한 질문 닫기 — pane-session.py(UserPromptSubmit · Claude · Codex 같은 자리)가 부른다(docs/requests.md "사용자가 대화로 답하면").

묻던 pane 에 사람이 직접 글을 보내면 그 pane 의 열린(open) 질문(question)을 답으로 보고 by chat 으로 닫는다(묻던 pane 에서 부르니 바로 delivered).
에이전트가 `request answer --by chat` 을 잊어도 [작업] 에 남지 않게. 닫은 것은 훅 추가 문맥으로 모델에게 알린다 — 답이 아니었으면 다시 묻는다.

사람 글로 치지 않는 것: `[…]` 로 시작하는 줄(앱 답 `[요청 <id>] … 답:` · pane 사이 `[<누구> → <누구>]` · 현황판 `[작업계획서 …]` 등 도구가 넣는 글) ·
`<` 로 시작하는 시스템 글 · `/` 명령 · 빈 글. answered(앱에서 이미 답함) · decision(결정 콘솔) · 허락 창 알림(키 perm:) · 다른 pane · 다른 데몬의 질문은 건드리지 않는다.
요청 폴더는 읽기만 하고(대부분 질문이 없다 — 훅을 느리게 하지 않게) 닫기는 bin/athena request answer 로만(쓰기는 lib/requests.mjs 한 곳).
"""
import json
import os
import re

import pane_request

ANSWER_MAX = 200   # 답으로 적는 글 — 앞부분만
ANSWER_TIMEOUT = 5  # 질문 하나 닫기 — Codex 훅 제한(10초) 안에서 끝나게
MACHINE = re.compile(r'^(?:\[[^\]\n]+\]|<|/)')


def is_person(prompt: str) -> bool:
    """사람이 직접 쓴 글인가 — 도구가 넣는 머리표 · 시스템 글 · 명령이면 아니다"""
    text = prompt.strip()
    return bool(text) and not MACHINE.match(text)


def open_questions(pane: str) -> list:
    """이 pane(같은 데몬)의 열린 질문 — 팩 데이터 state/requests 를 읽기만 한다(옛 구조 본체면 없음)"""
    state = pane_request.pack_state()
    folder = state / 'requests' if state else None
    if not folder or not folder.is_dir():
        return []
    socket = os.environ.get('ATHENA_STUDIO_SOCKET') or ''
    found = []
    for path in sorted(folder.glob('r-*.json')):
        try:
            request = json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(request, dict) or request.get('pane') != pane or request.get('kind') != 'question' or request.get('state') != 'open':
            continue
        if str(request.get('dedupeKey') or '').startswith('perm:'):
            continue
        if request.get('screen') and socket and request.get('screen') != socket:
            continue
        found.append(request)
    return found


def close_by_chat(pane: str, prompt: str) -> str:
    """닫은 질문을 모델에게 알릴 글 — 닫은 것이 없으면 ''"""
    if not pane or not is_person(prompt):
        return ''
    questions = open_questions(pane)
    if not questions:
        return ''
    answer = pane_request.mask(' '.join(prompt.split())[:ANSWER_MAX]) or '(대화로 답함 — 글은 가리지 못해 적지 않았다)'
    closed = []
    for request in questions:
        try:
            result = pane_request.athena(['request', 'answer', request['id'], '--by', 'chat', '--text', answer, '--rev', str(request.get('rev', ''))],
                                         timeout=ANSWER_TIMEOUT)
        except Exception:
            continue  # 시간 초과 등 — 못 닫은 질문은 열린 채로 둔다
        if result.get('ok'):
            closed.append(f"{request['id']}({request.get('title') or ''})")
    if not closed:
        return ''
    return (f'[요청] 열린 질문 {" · ".join(closed)} 를 이 입력을 대화 답으로 보고 닫았다(by chat). '
            '답이 아니었으면 다시 물어라 — bin/athena request open --kind question …')
