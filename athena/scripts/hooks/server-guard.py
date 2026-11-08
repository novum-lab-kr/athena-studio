#!/usr/bin/env python3
"""서버 명령 확인 훅 (Claude Code · Codex PreToolUse · Bash) — 등록한 서버(pack.json servers[])로 가는 길을 하나로 묶는다.

규칙(계획서 Decisions "D2 바뀜" · docs/setup.md "서버 하나 더하기"): **허용 목록만 자유**.
등록한 서버에는 `scripts/ssh-run.sh <서버> …` 로만 들어간다 — 그 스크립트가 허용 목록(scripts/lib/server_allow.py)의
읽기 명령만 바로 돌리고, 나머지 명령과 모든 파일 고치기(--put)는 [작업] 확인 요청을 연다(diff · 원격 백업 위치).
이 훅이 막는 것:
  - 등록한 ssh 별칭으로 바로 가는 ssh · scp · rsync · sftp(확인을 건너뛴다 · ssh -G 는 주소를 찍는다)
  - 명령 안에서 ssh-run.sh 의 시험용 값(ATHENA_SSH_BIN · ATHENA_SCP_BIN · ATHENA_REQUEST_BIN · ATHENA_GUARD_*)을 정하기(승인을 흉내 낸다)
서버가 하나도 없으면 바로 통과. 실수 방지용이지 보안 경계가 아니다 — 스크립트 파일 안의 명령까지 보지는 않는다.
시험용: ATHENA_GUARD_SERVERS="<이름>=<별칭>,…"(팩 대신 — 훅을 부르는 쪽 환경에서만)
"""
import json
import os
import pathlib
import re
import sys

ATHENA_DIR = pathlib.Path(__file__).resolve().parents[2]

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
command = (payload.get('tool_input') or {}).get('command') or ''
if not command.strip():
    sys.exit(0)

OVERRIDE = re.compile(r'\b(ATHENA_SSH_BIN|ATHENA_SCP_BIN|ATHENA_REQUEST_BIN|ATHENA_GUARD_\w+)\s*=')
RAW = re.compile(r'\b(ssh|scp|rsync|sftp)\b')

# 빠른 길 — ssh 계열도 시험용 값도 없으면 팩도 읽지 않는다
if not RAW.search(command) and not OVERRIDE.search(command):
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

found = OVERRIDE.search(command)
if found:
    print(
        f'⛔ 명령 안에서 {found.group(1)} 를 정하지 않는다 — ssh-run.sh 의 시험용 값이라 서버 확인을 건너뛴다.\n'
        '   등록한 서버에는 scripts/ssh-run.sh <서버> -- <명령> 으로만 들어간다.',
        file=sys.stderr,
    )
    sys.exit(2)

host_alt = '|'.join(re.escape(host) for _, host in sorted(servers, key=lambda pair: len(pair[1]), reverse=True))
# ssh [옵션…] <별칭> · scp/rsync … <별칭>:경로 · user@<별칭> — ssh 계열 낱말 뒤 같은 명령 안에 별칭이 보이면
pattern = re.compile(r'(?<![\w.-])(?:[\w.-]+@)?(' + host_alt + r')(?=$|[\s:\'"])')
for match in pattern.finditer(command):
    before = command[:match.start()]
    tail = re.split(r'[\n;|&]', before)[-1]
    if RAW.search(tail) and 'ssh-run.sh' not in tail:
        name = next(name for name, host in servers if host == match.group(1))
        print(
            f'⛔ 등록한 서버({name})에 ssh · scp · rsync 로 바로 들어가지 않는다 — 허용 목록 · 확인 · 백업을 건너뛴다.\n'
            f'   scripts/ssh-run.sh {name} -- <명령>(읽기 명령은 바로 · 나머지는 확인 요청) · '
            f'--get <원격> <로컬> · --put <로컬> <원격>(diff 확인 → 백업 → 덮어쓰기) 로 한다.',
            file=sys.stderr,
        )
        sys.exit(2)
sys.exit(0)
