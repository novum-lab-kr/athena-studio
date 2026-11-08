"""에이전트 차례 상태 · 아테나 알림 받음 기록 — 끝 알림 훅 · 질문 · 권한 훅 · lead-send · 아테나 pane 기록 훅 · 현황판이 같이 쓴다.

차례 상태 — <팩 데이터>/state/agent-turn/<pane>.json (위임 에이전트 pane 마다 하나 · Claude · Codex 모두)
  state: working(입력을 받아 일하는 중) · done(차례를 끝냄) · asking(고르기 질문을 [작업] 요청으로 올림) · waiting-permission(권한 창)
  그 밖의 칸: pane · agent · plan · turn(입력마다 새 값) · background(도는 백그라운드 명령 수) · question(마지막 답 끝이 질문)
    · stop(⏸ 멈춤 이유) · requests(asking 때 연 요청 id) · at(ISO 시각) · ts(초)
  "끝났다" 는 이 파일의 state 하나로 정한다 — 쓰는 곳: agent-done-notify.py(prompt → working · stop → done/asking) ·
  ask-to-request.py(asking) · permission-to-request.py(waiting-permission). 읽는 곳: 현황판 server.mjs reconcileTurns

아테나 알림 받음 기록 — <팩 데이터>/state/lead-notices/<id>.json
  { id, kind(turn · unconfirmed · menu), lead, text, plan, pane, from, turn, sent_at, received_at?, resent_at?, request? }
  쓰는 곳: lead-send.py(끝 알림을 넣었을 때 --track · 전송을 확인하지 못했을 때) · 현황판(선택 창 알림 · 다시 넣기 · 요청)
  받음 표시: 아테나 pane 의 UserPromptSubmit 훅(pane-session.py)이 받은 입력에 그 글이 들어 있으면 received_at 을 적는다
  다시 넣기(2분) · [작업] 요청(10분)은 현황판이 한다(계획서 결정 D1)
어떤 실패도 부르는 쪽을 막지 않게 — 쓰기 실패는 예외로 올리고 부르는 쪽이 삼킨다.
"""
import datetime
import json
import os
import pathlib
import re
import time
import uuid

from reuse_link import pane_lock

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
STATES = ('working', 'done', 'asking', 'waiting-permission')
NOTICE_ID = re.compile(r'^[0-9a-f]{32}$')


def pack_state():
    """<팩 데이터>/state — 옛 구조(팩 데이터 없음)면 None"""
    pack_data = ATHENA_DIR / '.pack-data'
    return pack_data.resolve() / 'state' if pack_data.is_symlink() else None


def _load(path: pathlib.Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save(path: pathlib.Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'.{path.stem}.{os.getpid()}.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')
    os.replace(temp, path)


def read_turn(pane: str) -> dict:
    base = pack_state()
    return _load(base / 'agent-turn' / f'{pane}.json') if base else {}


def write_turn(pane: str, **fields) -> dict:
    """차례 상태를 고쳐 쓴다(주지 않은 칸은 그대로). 옛 구조면 아무것도 안 한다"""
    base = pack_state()
    if base is None:
        return {}
    if fields.get('state') not in STATES:
        raise ValueError(f'알 수 없는 차례 상태: {fields.get("state")}')
    folder = base / 'agent-turn'
    folder.mkdir(parents=True, exist_ok=True)
    with pane_lock(folder, pane):
        data = _load(folder / f'{pane}.json')
        data.update(fields)
        data['pane'] = pane
        data['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        data['ts'] = time.time()
        _save(folder / f'{pane}.json', data)
    return data


QUESTION_END = re.compile(r'[?？]\s*$')


def ends_with_question(reply: str) -> bool:
    """마지막 답의 끝(빈 줄 · 꾸밈 글자 빼고 마지막 줄)이 물음표로 끝나나 — '커밋할까요?' 처럼 글로 묻고 끝낸 차례"""
    lines = [re.sub(r'[*_`>\s]+$', '', line) for line in str(reply or '').split('\n')]
    lines = [line for line in lines if line.strip()]
    return bool(lines) and bool(QUESTION_END.search(lines[-1]))


def record_notice(kind: str, lead: str, text: str, plan: str = '', pane: str = '', sender: str = '', turn: str = '') -> str:
    """아테나에 넣은(또는 넣었는지 모르는) 글을 받음 확인 대상으로 남긴다 — id. 옛 구조면 ''"""
    base = pack_state()
    if base is None:
        return ''
    notice_id = uuid.uuid4().hex
    _save(base / 'lead-notices' / f'{notice_id}.json',
          {'id': notice_id, 'kind': kind, 'lead': lead, 'text': text, 'plan': plan, 'pane': pane, 'from': sender, 'turn': turn, 'sent_at': time.time()})
    return notice_id


def _squash(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def mark_received(lead: str, prompt: str) -> list:
    """아테나 pane(lead)이 받은 입력에 든 알림을 받음으로 표시한다 — 표시한 id 목록. 줄바꿈 · 공백 차이는 무시한다(대기 입력이 여러 개 이어 붙어 와도)"""
    base = pack_state()
    if base is None:
        return []
    folder = base / 'lead-notices'
    if not folder.is_dir():
        return []
    received = _squash(prompt)
    if not received:
        return []
    marked = []
    for path in folder.glob('*.json'):
        if not NOTICE_ID.match(path.stem):
            continue
        notice = _load(path)
        if notice.get('lead') != lead or notice.get('received_at'):
            continue
        text = _squash(notice.get('text'))
        if not text or text not in received:
            continue
        with pane_lock(folder, path.stem):
            notice = _load(path)
            if notice and not notice.get('received_at'):
                notice['received_at'] = time.time()
                _save(path, notice)
                marked.append(path.stem)
    return marked
