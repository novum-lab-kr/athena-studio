#!/usr/bin/env python3
"""아테나 답 끝 📝 줄 → 리드 기록 (Claude Code · Codex Stop 훅 — 본체 .claude/settings.json · .codex/hooks.json).

아테나가 lead-log 만 부르느라 한 턴을 따로 썼다 — 하루 약 130턴, 그중 61% 는 기록 바로 뒤 도구 없이 답하고 끝나는 자리라
"다른 호출과 같은 턴에 묶기" 가 성립하지 않았다(2026-11-27 대화 기록 실측 · 계획서 plans/task/20261127-…-lead-log-단독-턴-…).
그래서 아테나는 답에 한 줄을 쓰고, 차례가 끝날 때 이 훅이 받아 적는다(2026-11-27 사용자 결정 — 답에 줄이 보이는 안):
  📝 <정정|실패|사실|결정>: <한 줄>
줄마다 scripts/lead-log.mjs 를 그대로 불러 적는다 — 줄 형식 · 쓴 창 표시(pane · 대화) · 비밀값 가림 · 자리가 lead-log 명령과 같다.
  코드 블록(```) 안의 줄은 예시라 적지 않는다 · 한 답에 여러 줄이면 모두
  마지막 답은 훅 입력 last_assistant_message, 없으면 대화 기록(transcript_path) 끝의 마지막 assistant 글(agent-done-notify.py 와 같은 법)
  같은 답을 두 번 적지 않는다 — 세션마다 마지막으로 적은 답의 해시(임시 폴더 MARK_DIR)
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
        if not isinstance(entry, dict) or entry.get('type') != 'assistant':
            continue
        text = assistant_text((entry.get('message') or {}).get('content'))
        if text.strip():
            return text
    return ''


def already_written(session: str, digest: str) -> bool:
    """이 세션에서 같은 답을 이미 적었으면 참 — 아니면 지금 답을 적어 둔다(세션 id 를 모르면 늘 거짓)"""
    if not SESSION_ID.match(session):
        return False
    mark = MARK_DIR / session
    try:
        if mark.read_text(encoding='utf-8') == digest:
            return True
    except OSError:
        pass
    try:
        MARK_DIR.mkdir(parents=True, exist_ok=True)
        mark.write_text(digest, encoding='utf-8')
    except OSError:
        pass
    return False


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
    if already_written(str(event.get('session_id') or ''), hashlib.sha256(reply.encode('utf-8')).hexdigest()):
        return
    for kind, text in logs:
        # 글은 인자 하나로 넘긴다(셸을 거치지 않는다) — 비밀값 가림 · 창 표시는 lead-log.mjs 가 한다
        subprocess.run(['node', str(LEAD_LOG), kind, text], cwd=str(ATHENA_DIR), stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
