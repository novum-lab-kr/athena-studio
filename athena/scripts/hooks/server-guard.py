#!/usr/bin/env python3
"""서버 명령 확인 훅 (Claude Code · Codex PreToolUse · Bash) — 등록한 서버(pack.json servers[])로 가는 길을 하나로 묶는다.

규칙(계획서 Decisions "D2 바뀜" · docs/setup.md "서버 하나 더하기"): **허용 목록만 자유**.
등록한 서버에는 `scripts/ssh-run.sh <서버> …` 로만 들어간다 — 그 스크립트가 허용 목록(scripts/lib/server_allow.py)의
읽기 명령만 바로 돌리고, 나머지 명령과 모든 파일 고치기(--put)는 [작업] 확인 요청을 연다(diff · 원격 백업 위치).
이 훅이 막는 것:
  - 등록한 ssh 별칭으로 바로 가는 ssh · scp · rsync · sftp(확인을 건너뛴다 · ssh -G 는 주소를 찍는다)
  - 명령 안에서 ssh-run.sh 의 시험용 값(ATHENA_SSH_BIN · ATHENA_SCP_BIN · ATHENA_REQUEST_BIN · ATHENA_GUARD_*)을 정하기(승인을 흉내 낸다)
  - `request answer` · `request cancel`(bin/athena · scripts/athena.mjs) 중 **ssh-run.sh 의 확인 요청(key server-cmd:* · server-put:*)** 에 닿는 것 — 에이전트가 자기 확인 요청에
    스스로 "실행" 을 답하는 길(2026-11-08 PR 리뷰 2). 어느 세션이든 막고, 다른 요청(질문 · 결정)의 대화 답 흐름은 그대로 둔다(계획서 R1).
    요청 id 를 글자로 못 읽거나(변수 등) 요청을 읽다 실패하면 막는다 · 없는 요청이면 통과
ssh-run.sh 로 가는 것은 명령 첫 낱말(VAR=값 앞붙임 뒤)이 ssh-run.sh 로 끝나는 경로일 때만 — 글자가 섞여 있기만 한 것(ssh -o x=ssh-run.sh …)은 아니다.
모든 검사는 맨 위에서 한 번 만든 **정규화한 사본**(views)만 본다 — 셸이 지우는 따옴표 · 백슬래시로 낱말을 가르는 우회
(s""sh · ATHENA_SSH\\_BIN= · request $'answer' · {ssh,별칭})를 판정마다 따로 막지 않는다(2026-11-08 PR 세 번째 리뷰).
치환(${IFS} · $IFS · $(…) · `…`)은 빈 글자 · 공백 두 사본으로 · $'…' 는 \\xHH · \\NNN · \\uHHHH 를 푼 글자로 · 시험용 값은 += 도(네 번째 리뷰).
서버가 하나도 없으면 바로 통과. 실수 방지용이지 보안 경계가 아니다 — 변수로 돌려 부르기 · 스크립트 파일 안의 명령까지 보지는 않는다.
시험용: ATHENA_GUARD_SERVERS="<이름>=<별칭>,…"(팩 대신) · ATHENA_GUARD_REQUEST_BIN(요청 읽기 bin — 기본 bin/athena) — 훅을 부르는 쪽 환경에서만
"""
import json
import os
import pathlib
import re
import sys

ATHENA_DIR = pathlib.Path(__file__).resolve().parents[2]
BRACE_LIMIT = 64   # 중괄호 펼치기 — 이보다 많아지면 펼친 사본은 그만 만든다({ , } 를 공백으로 바꾼 사본은 늘 본다)


# 치환 — ${…} · $이름 · $특수 · $(…) · `…`(안에 같은 꼴이 또 없는 것). 'keep' 사본은 빈 것만 지우고 나머지는 그대로 둔다($(ssh …) 안을 보려고)
SUBST = re.compile(r'\$\{[^{}]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?!$-]|\$\([^()]*\)|`[^`]*`')
EMPTY_SUBST = re.compile(r'\$\{\w*\}|\$\(\s*\)|``')
ANSI_C = re.compile(r"\$'((?:[^'\\]|\\.)*)'", re.S)
ANSI_ESCAPE = re.compile(r'\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)', re.S)
ANSI_NAMED = {'n': '\n', 't': '\t', 'r': '\r', 'a': '\a', 'b': '\b', 'f': '\f', 'v': '\v', 'e': '\x1b', 'E': '\x1b'}


def ansi_char(escape):
    """$'…' 안 이스케이프 하나를 bash 처럼 푼다 — \\xHH · \\NNN · \\uHHHH · \\UHHHHHHHH · \\n 등 · 모르는 것은 글자 그대로"""
    head, body = escape[0], escape[1:]
    if head in 'xuU' and body:
        return chr(min(int(body, 16), 0x10FFFF))
    if head.isdigit():
        return chr(int(escape, 8) & 0xFF)
    if head == 'c' and body:
        return chr(ord(body) & 0x1F)
    return ANSI_NAMED.get(escape, escape)


def normalize(text, joint, subst):
    """셸이 지우는 것을 지운 사본 — 백슬래시-줄바꿈(joint 로 바꿈 · '' 이면 이어 붙이기) · $'…' 는 이스케이프를 푼 글자로 · $" 의 $ ·
    치환(subst — 'keep' 이면 빈 것만 지우고 · '' · ' ' 이면 모든 치환을 그 글자로: ${IFS} 는 공백이 되어 낱말을 가른다) · ' · " · 백슬래시"""
    text = text.replace('\\\n', joint)
    text = ANSI_C.sub(lambda found: ANSI_ESCAPE.sub(lambda part: ansi_char(part.group(1)), found.group(1)), text)
    text = re.sub(r'\$(?=[\'"])', '', text)   # 닫히지 않은 $' · $" 의 $
    text = EMPTY_SUBST.sub('', text) if subst == 'keep' else SUBST.sub(subst, text)
    return re.sub(r'[\'"\\]', '', text)


def expand_braces(text):
    """{a,b} 를 셸처럼 그 낱말 안에서 펼친다(안쪽부터) — 너무 많아지면 None"""
    for _ in range(BRACE_LIMIT):
        found = re.search(r'\{([^{}]*,[^{}]*)\}', text)
        if not found:
            return text
        start = found.start()
        while start > 0 and not text[start - 1].isspace():
            start -= 1
        end = found.end()
        while end < len(text) and not text[end].isspace():
            end += 1
        prefix, suffix = text[start:found.start()], text[found.end():end]
        words = ' '.join(prefix + part + suffix for part in found.group(1).split(','))
        text = text[:start] + words + text[end:]
        if len(text) > 20000:
            return None
    return None


def views_of(text):
    """검사가 보는 사본들 — (백슬래시-줄바꿈 이어 붙이기 · 공백) × (치환 그대로 · 빈 글자 · 공백) × (중괄호 펼치기 · { , } 를 공백으로)"""
    seen = []
    for joint in ('', ' '):
        for subst in ('keep', '', ' '):
            plain = normalize(text, joint, subst)
            for view in (expand_braces(plain), re.sub(r'[{},]', ' ', plain)):
                if view is not None and view not in seen:
                    seen.append(view)
    return seen


try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
command = (payload.get('tool_input') or {}).get('command') or ''
if not command.strip():
    sys.exit(0)

OVERRIDE = re.compile(r'\b(ATHENA_SSH_BIN|ATHENA_SCP_BIN|ATHENA_REQUEST_BIN|ATHENA_GUARD_\w+)\s*\+?=')
RAW = re.compile(r'\b(ssh|scp|rsync|sftp)\b')
ANSWER = re.compile(r'\brequest\s+(answer|cancel)\b')
# 답 · 취소할 요청 id — request answer|cancel 바로 뒤 낱말
ANSWER_ID = re.compile(r'\brequest\s+(answer|cancel)(?:\s+(\S+))?')
# 막는 요청 key — ssh-run.sh 의 명령 확인(server-cmd:*) · 파일 올리기 확인(server-put:* — 계획서 R1 확정 2026-11-08)
SERVER_KEYS = ('server-cmd:', 'server-put:')
# 한 명령의 첫 낱말 — 앞의 VAR=값 은 건너뛴다(사본에는 따옴표가 없다)
FIRST_WORD = re.compile(r'^\s*(?:\w+=\S*\s+)*(\S+)')

VIEWS = views_of(command)

# 빠른 길 — 어느 사본에도 ssh 계열 · 시험용 값 · request answer 가 없으면 팩도 읽지 않는다
if not any(RAW.search(view) or OVERRIDE.search(view) or ANSWER.search(view) for view in VIEWS):
    sys.exit(0)


def registered():
    """[(이름, 별칭)] — 팩 servers[]"""
    override = os.environ.get('ATHENA_GUARD_SERVERS')
    if override is not None:
        return [tuple(item.split('=', 1)) for item in override.split(',') if '=' in item]
    try:
        sys.path.insert(0, str(ATHENA_DIR / 'scripts/lib'))
        from athena_config import load
        servers = load(str(ATHENA_DIR)).get('servers') or []
    except Exception:
        return []
    return [(server['name'], server['host']) for server in servers if isinstance(server, dict) and server.get('name') and server.get('host')]


servers = registered()
if not servers:
    sys.exit(0)


def via_ssh_run(segment):
    """이 명령이 ssh-run.sh 를 부르나 — 첫 낱말이 ssh-run.sh 로 끝나는 경로"""
    first = FIRST_WORD.match(segment)
    return bool(first) and re.search(r'(^|/)ssh-run\.sh$', first.group(1)) is not None


host_alt = '|'.join(re.escape(host) for _, host in sorted(servers, key=lambda pair: len(pair[1]), reverse=True))
# ssh [옵션…] <별칭> · scp/rsync … <별칭>:경로 · user@<별칭> — 별칭 앞뒤가 이름 글자가 아니면
HOST = re.compile(r'(?<![\w.-])(?:[\w.-]+@)?(' + host_alt + r')(?![\w.-])')


REQUEST_KEYS = {}


def request_key(request_id):
    """요청의 key(dedupeKey) — 없는 요청이면 '' · 읽다 실패하면 None. 요청 bin 의 request show 로 읽는다(ssh-run.sh 승인 확인과 같은 길)"""
    if request_id in REQUEST_KEYS:
        return REQUEST_KEYS[request_id]
    request_bin = os.environ.get('ATHENA_GUARD_REQUEST_BIN') or str(ATHENA_DIR / 'bin/athena')
    found = None
    try:
        import subprocess
        done = subprocess.run([request_bin, 'request', 'show', request_id, '--json'], capture_output=True, text=True, timeout=20)
        lines = done.stdout.strip().split('\n')
        reply = json.loads(lines[-1]) if lines and lines[-1] else {}
        request = reply.get('request') if isinstance(reply, dict) else None
        if isinstance(request, dict):
            found = str(request.get('dedupeKey') or '')
        elif isinstance(reply, dict) and reply.get('ok') is False and reply.get('error') == 'not-found':
            found = ''   # 없는 요청 — 서버 확인 요청일 수 없다(그 명령은 어차피 실패한다)
    except Exception:
        found = None
    REQUEST_KEYS[request_id] = found
    return found


def answer_blocked(view):
    """이 사본의 request answer · cancel 이 서버 명령 확인 요청에 닿으면 (동작, 이유) — 아니면 None"""
    for match in ANSWER_ID.finditer(view):
        action, first = match.group(1), match.group(2) or ''
        if not re.match(r'^[\w-]+$', first):
            return action, f'요청 id 를 글자로 읽지 못했다({first or "없음"})'
        # 첫 낱말 + 같은 명령 조각 안의 요청 id 꼴 낱말 모두 — 중괄호를 펼친 사본은 낱말이 늘어난다(can{c,}el r-1 → cancel cael r-1)
        rest = re.split(r'[\n;|&]', view[match.end():])[0]
        ids = [first] + [word for word in rest.split() if re.match(r'^r-[\w-]+$', word) and word != first]
        for request_id in ids:
            key = request_key(request_id)
            if key is None:
                return action, f'요청 {request_id} 를 읽지 못했다'
            if key.startswith(SERVER_KEYS):
                return action, f'요청 {request_id} 는 서버 확인 요청이다'
    return None


def blocked(view):
    """이 사본에서 막을 이유(안내 글) — 없으면 None"""
    found = OVERRIDE.search(view)
    if found:
        return (f'⛔ 명령 안에서 {found.group(1)} 를 정하지 않는다 — ssh-run.sh 의 시험용 값이라 서버 확인을 건너뛴다.\n'
                '   등록한 서버에는 scripts/ssh-run.sh <서버> -- <명령> 으로만 들어간다.')
    found = answer_blocked(view)
    if found:
        return (f'⛔ 서버 명령 확인 요청에는 request {found[0]} 를 부르지 않는다 — {found[1]}. 스스로 "실행" 을 답하는 길이다.\n'
                '   답은 사람이 [작업] 탭에서 한다. 요청 id 는 글자로 바로 쓴다(다른 질문 · 결정 요청의 대화 답은 그대로 된다).')
    for match in HOST.finditer(view):
        # 조각은 ; | & 줄바꿈 · ( · 백틱에서 나눈다 — $( ) · `…` · <( ) 안의 ssh 는 이 맥에서 돈다(2026-11-08 PR 재리뷰)
        tail = re.split(r'[\n;|&(`]', view[:match.start()])[-1]
        if RAW.search(tail) and not via_ssh_run(tail):
            name = next(name for name, host in servers if host == match.group(1))
            return (f'⛔ 등록한 서버({name})에 ssh · scp · rsync 로 바로 들어가지 않는다 — 허용 목록 · 확인 · 백업을 건너뛴다.\n'
                    f'   scripts/ssh-run.sh {name} -- <명령>(읽기 명령은 바로 · 나머지는 확인 요청) · '
                    f'--get <원격> <로컬> · --put <로컬> <원격>(diff 확인 → 백업 → 덮어쓰기) 로 한다.')
    return None


for view in VIEWS:
    why = blocked(view)
    if why:
        print(why, file=sys.stderr)
        sys.exit(2)
sys.exit(0)
