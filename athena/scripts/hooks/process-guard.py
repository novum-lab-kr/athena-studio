#!/usr/bin/env python3
"""프로세스 종료 보호 훅 (Claude Code PreToolUse · Bash) — 아테나·FE 에이전트·reviewer 모든 세션에 건다.

규칙: 멈춘 명령은 TaskStop 이나 **확인한 pid 의 `kill <pid>`** 로만 끈다. 이름으로 찾아 죽이지 않는다.
2026-10-29 GitHub #133 — 에이전트 pane 이 `pkill -f "cat" -U $(id -u) -x` 를 실행했다. macOS(BSD) pkill 은 패턴 뒤 옵션을
패턴으로 읽고 -f 는 전체 명령줄을 봐서 /Applications 경로의 "cat" 까지 맞춰, 같은 사용자의 앱(Athena Studio Helper 포함) 수십 개가 꺼졌다.

막는 것
  - pkill · killall · killall5                   → 이름·패턴으로 찾아 죽인다
  - kill -1 · kill -9 -1 · kill 0 · kill -- -<pgid> · kill -TERM -<pgid>   → 전체 프로세스/프로세스 그룹에 보낸다(0·음수 대상)
  - kill $(pgrep …) · kill `pidof …` · … | xargs kill   → 이름으로 찾은 pid 를 확인 없이 죽인다
  - sh|bash|zsh -c "pkill …" · $( … ) 안의 위 명령
통과: kill 12345 · kill -TERM 12345 · kill -0 12345 · ps -axo pid=,comm= · 문자열/주석/인자 속 글자(echo "pkill" · grep pkill) · pgrep 단독(읽기)
실수 방지용이지 보안 경계가 아니다 — 스크립트 파일 안의 명령, timeout/find -exec 로 감싼 kill 은 보지 않는다.
명령 나누기 · 앞붙임(VAR=값 · env · sudo …) 건너뛰기 · sh -c · $( ) 풀기는 commit-guard.py 와 같은 방식. 막으면 exit 2 — stderr 가 에이전트에게 간다.
"""
import json
import os
import re
import shlex
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
command = (payload.get('tool_input') or {}).get('command') or ''
if not command.strip():
    sys.exit(0)

WRAPPERS = {'env', 'command', 'sudo', 'nohup', 'time', 'exec', 'nice', 'builtin'}
SHELLS = {'sh', 'bash', 'zsh', 'dash'}
NAME_KILLERS = {'pkill', 'killall', 'killall5'}
HOW_TO = '백그라운드 명령은 TaskStop, 아니면 `ps -axo pid=,comm=` 로 pid 를 확인해 `kill <pid>` 로 끈다'


def mask_quotes(text, keep_substitution):
    """따옴표 안을 같은 길이의 공백으로 가린다 — 커밋 메시지 "fix: (git merge 대응)" 같은 글자를 명령으로 보지 않게.
    keep_substitution 이면 큰따옴표 안의 $( … ) · ` … ` 는 남긴다(큰따옴표 안에서도 실행된다)"""
    out, index, quote = [], 0, ''
    while index < len(text):
        char = text[index]
        if quote == "'":
            out.append(' ' if char != "'" else char); quote = '' if char == "'" else quote
        elif quote == '"':
            if char == '\\' and index + 1 < len(text):
                out.append('  '); index += 2; continue
            if char == '"':
                out.append(char); quote = ''
            elif keep_substitution and (text.startswith('$(', index) or char == '`'):
                # 치환 구간은 끝까지 그대로 옮긴다 — $( ) 는 괄호 짝을 센다(중첩)
                if char == '$':
                    depth, end = 0, index + 1
                    while end < len(text):
                        depth += {'(': 1, ')': -1}.get(text[end], 0)
                        if depth == 0:
                            break
                        end += 1
                else:
                    end = text.find('`', index + 1)
                end = len(text) - 1 if end < 0 or end >= len(text) else end
                out.append(text[index:end + 1]); index = end + 1; continue
            else:
                out.append(' ')
        else:
            if char in ('"', "'"):
                quote = char
            out.append(char)
        index += 1
    return ''.join(out)


def balanced_groups(view, opener):
    """view 에서 opener('$(' 또는 '(') 로 시작하는 구간의 안쪽 (시작, 끝) 을 괄호 짝을 세어 찾는다 — 중첩도 바깥 한 겹"""
    spans, index = [], 0
    while True:
        index = view.find(opener, index)
        if index < 0:
            return spans
        if opener == '(' and index > 0 and view[index - 1] == '$':
            index += 1; continue   # $( 는 치환 쪽에서 본다
        depth, cursor = 0, index + len(opener) - 1
        while cursor < len(view):
            if view[cursor] == '(':
                depth += 1
            elif view[cursor] == ')':
                depth -= 1
                if depth == 0:
                    break
            cursor += 1
        spans.append((index + len(opener), cursor))
        index = cursor + 1


def inner_commands(text):
    """$( … ) · ` … ` · ( … ) 안의 명령을 꺼낸다. 괄호 짝을 세어 바깥 한 겹을 꺼내고, 그 안은 check() 가 재귀로 다시 본다.
    치환은 작은따옴표만 가리고(큰따옴표 안에서도 실행), 서브셸 ( … ) 은 따옴표를 모두 가린 뒤 찾는다"""
    substitution_view = mask_quotes(text, keep_substitution=True)
    found = [text[begin:end] for begin, end in balanced_groups(substitution_view, '$(')]
    found += [text[match.start(1):match.end(1)] for match in re.finditer(r'`([^`]*)`', substitution_view)]
    plain_view = mask_quotes(text, keep_substitution=False)
    found += [text[begin:end] for begin, end in balanced_groups(plain_view, '(')]
    return found


def split_pieces(text):
    """; && || | & 줄바꿈으로 나눈다 — 따옴표 안의 구분자는 가린 채로 자리를 찾아 원문을 자른다"""
    view = mask_quotes(text, keep_substitution=False)
    pieces, start = [], 0
    for match in re.finditer(r'&&|\|\||[;|&\n]', view):
        pieces.append(text[start:match.start()]); start = match.end()
    pieces.append(text[start:])
    return [piece.strip() for piece in pieces if piece.strip()]


def tokens_of(piece):
    try:
        return shlex.split(piece, posix=True)
    except ValueError:
        return piece.split()


def strip_prefix(tokens):
    """VAR=값 · 감싸는 명령(env·sudo…)과 그 옵션을 건너뛴다"""
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', token):
            index += 1
        elif os.path.basename(token) in WRAPPERS:
            index += 1
            # 감싸는 명령의 옵션(-u user, -i 등)은 값까지 건너뛴다 — 다음 비옵션 토큰이 실제 명령
            while index < len(tokens) and tokens[index].startswith('-'):
                index += 2 if tokens[index] in ('-u', '-g', '-C', '-n') else 1
        else:
            break
    return tokens[index:]


def kill_reason(args, piece):
    """kill 뒤 토큰들. 0·음수 대상(전체·프로세스 그룹)이나 이름으로 찾은 pid 면 이유를 돌려준다"""
    if re.search(r'\b(pgrep|pidof)\b', piece):
        return f'kill 에 pgrep/pidof 로 이름을 찾은 pid 를 넘기면 엉뚱한 프로세스까지 죽는다. {HOW_TO}'
    index = 0
    if args and args[0] == '-1' and len(args) == 1:
        return f'kill -1 은 모든 프로세스에 신호를 보낸다. {HOW_TO}'
    if index < len(args) and args[index] in ('-s', '-n'):
        index += 2
    elif index < len(args) and re.match(r'^-([0-9]+|[A-Za-z][A-Za-z0-9]*)$', args[index]):
        index += 1
    for target in args[index:]:
        if target == '--':
            continue
        if target == '0' or re.match(r'^-[0-9]+$', target):
            return f'kill 대상 {target} 은 전체 프로세스/프로세스 그룹이다. {HOW_TO}'
    return ''


def check(text, depth=0):
    if depth > 5:
        return ''
    for inner in inner_commands(text):
        reason = check(inner, depth + 1)
        if reason:
            return reason
    pieces = split_pieces(text)
    for position, piece in enumerate(pieces):
        tokens = strip_prefix(tokens_of(piece))
        if not tokens:
            continue
        name = os.path.basename(tokens[0])
        flag = next((pos for pos, token in enumerate(tokens[1:], 1) if re.match(r'^-[A-Za-z]*c[A-Za-z]*$', token)), None) if name in SHELLS else None
        if flag is not None:
            if flag + 1 < len(tokens):
                reason = check(tokens[flag + 1], depth + 1)
                if reason:
                    return reason
            continue
        if name in NAME_KILLERS:
            return f'{name} 은 이름·패턴으로 찾아 죽인다(macOS pkill 은 패턴 뒤 옵션을 패턴으로 읽고 -f 는 /Applications 경로까지 맞춘다 — GH #133). {HOW_TO}'
        if name == 'kill':
            reason = kill_reason(tokens[1:], piece)
            if reason:
                return reason
        if name == 'xargs':
            rest = [token for token in tokens[1:] if not token.startswith('-')]
            fed_by_echo = position > 0 and os.path.basename((strip_prefix(tokens_of(pieces[position - 1])) or [''])[0]) in ('echo', 'printf')
            if rest and os.path.basename(rest[0]) == 'kill' and position > 0 and not fed_by_echo:
                return f'파이프로 받은 pid 를 xargs kill 로 확인 없이 죽이면 안 된다. {HOW_TO}'
    return ''


reason = check(command)
if reason:
    print(f'⛔ 아테나 보호 훅: {reason}', file=sys.stderr)
    sys.exit(2)
sys.exit(0)
