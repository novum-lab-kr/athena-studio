#!/usr/bin/env python3
"""아테나 답 끝 📝 줄 → 리드 기록 (Claude Code · Codex Stop 훅 — 본체 .claude/settings.json · .codex/hooks.json).

아테나가 lead-log 만 부르느라 한 턴을 따로 썼다 — 하루 약 130턴, 그중 61% 는 기록 바로 뒤 도구 없이 답하고 끝나는 자리라
"다른 호출과 같은 턴에 묶기" 가 성립하지 않았다(2026-11-27 대화 기록 실측 · 계획서 plans/task/20261127-…-lead-log-단독-턴-…).
그래서 아테나는 답에 한 줄을 쓰고, 차례가 끝날 때 이 훅이 받아 적는다(2026-11-27 사용자 결정 — 답에 줄이 보이는 안):
  📝 <정정|실패|사실|결정>: <한 줄>
줄마다 scripts/lead-log.mjs 를 그대로 불러 적는다 — 줄 형식 · 쓴 창 표시(pane · 대화) · 비밀값 가림 · 자리가 lead-log 명령과 같다.
  코드 블록(```) 안의 줄은 예시라 적지 않는다 · 한 답에 여러 줄이면 모두
  마지막 답은 훅 입력 last_assistant_message, 없으면 대화 기록(transcript_path) 끝의 마지막 assistant 글(agent-done-notify.py 와 같은 법)
    — Claude 는 type assistant 줄 · Codex rollout 은 response_item · message · role assistant 의 output_text(2026-11-27 codex 기록 확인)
  같은 답을 두 번 적지 않는다 — 세션마다 마지막 답의 해시와 적기에 성공한 줄 번호(임시 폴더 MARK_DIR · JSON).
    lead-log.mjs 가 실패 · 시간 초과한 줄은 표시하지 않아 같은 Stop 입력을 다시 넣으면 그 줄부터 다시 적는다
아테나 세션에서만 돈다 — 위임 에이전트(ATHENA_AGENT)는 본체 안에서 띄워도 이 훅을 건너뛴다(작업자 규칙은 그대로).
어떤 오류도 세션을 막지 않는다(항상 exit 0 · 출력 없음).

사용: lead-log-stop.py   (hook 입력 JSON 은 stdin)
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
LEAD_LOG = ATHENA_DIR / 'scripts' / 'lead-log.mjs'
# scripts/lead-log.mjs KINDS · scripts/token-usage.mjs REPLY_LOG 와 같은 꼴
REPLY_LOG = re.compile(r'^\s*📝\s*(정정|실패|사실|결정)\s*[:：]\s*(\S.*?)\s*$')
FENCE = re.compile(r'^\s*(```|~~~)')
MARK_DIR = pathlib.Path(tempfile.gettempdir()) / 'athena-lead-log-stop'
TAIL_BYTES = 2 * 1024 * 1024   # 대화 기록은 수백 MB 까지 커서 끝부분만 읽는다
SESSION_ID = re.compile(r'^[0-9A-Za-z-]{8,64}$')


def reply_logs(reply: str) -> list:
    """답에서 적을 (종류, 글) — 코드 블록 밖의 📝 줄만"""
    found = []
    fenced = False
    for line in reply.splitlines():
        if FENCE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        match = REPLY_LOG.match(line)
        if match:
            found.append((match.group(1), match.group(2)))
    return found


def assistant_text(content) -> str:
    """assistant 줄의 글 조각을 이어 붙인다(도구 호출 · 생각은 뺀다)"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return '\n'.join(str(block.get('text') or '') for block in content if isinstance(block, dict) and block.get('type') == 'text')


def entry_text(entry) -> str:
    """대화 기록 한 줄이 assistant 답이면 그 글 — Claude(type assistant · message.content) · Codex(response_item · message · role assistant · output_text). 아니면 ''"""
    if not isinstance(entry, dict):
        return ''
    if entry.get('type') == 'assistant':
        return assistant_text((entry.get('message') or {}).get('content'))
    payload = entry.get('payload')
    if entry.get('type') != 'response_item' or not isinstance(payload, dict) or payload.get('type') != 'message' or payload.get('role') != 'assistant':
        return ''
    content = payload.get('content')
    blocks = content if isinstance(content, list) else []
    return '\n'.join(str(block.get('text') or '') for block in blocks if isinstance(block, dict) and block.get('type') == 'output_text')


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
        text = entry_text(entry)
        if text.strip():
            return text
    return ''


def written_lines(session: str, digest: str) -> set:
    """이 세션의 같은 답에서 이미 적은 줄 번호 — 다른 답 · 표시 없음 · 세션 id 를 모르면 빈 집합"""
    if not SESSION_ID.match(session):
        return set()
    try:
        mark = json.loads((MARK_DIR / session).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return set()
    if not isinstance(mark, dict) or mark.get('digest') != digest or not isinstance(mark.get('done'), list):
        return set()
    return {number for number in mark['done'] if isinstance(number, int)}


def mark_written(session: str, digest: str, done: set) -> None:
    """적기에 성공한 줄 번호를 남긴다(세션 id 를 모르면 남기지 않는다)"""
    if not SESSION_ID.match(session):
        return
    try:
        MARK_DIR.mkdir(parents=True, exist_ok=True)
        (MARK_DIR / session).write_text(json.dumps({'digest': digest, 'done': sorted(done)}), encoding='utf-8')
    except OSError:
        pass


def write_line(kind: str, text: str) -> bool:
    """lead-log.mjs 로 한 줄 — 글은 인자 하나로 넘긴다(셸을 거치지 않는다 · 가림 · 창 표시는 lead-log.mjs 가 한다). 종료 0 일 때만 참"""
    try:
        done = subprocess.run(['node', str(LEAD_LOG), kind, text], cwd=str(ATHENA_DIR), stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0


def main() -> None:
    if os.environ.get('ATHENA_AGENT'):
        return
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(event, dict) or event.get('agent_id'):
        return   # 하위 에이전트(Task)의 끝은 아테나 답이 아니다
    reply = last_reply(event)
    logs = reply_logs(reply)
    if not logs:
        return
    session = str(event.get('session_id') or '')
    digest = hashlib.sha256(reply.encode('utf-8')).hexdigest()
    done = written_lines(session, digest)
    for number, (kind, text) in enumerate(logs):
        if number in done:
            continue
        if write_line(kind, text):   # 실패한 줄은 표시하지 않는다 — 다시 넣으면 그 줄부터
            done.add(number)
            mark_written(session, digest, done)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
