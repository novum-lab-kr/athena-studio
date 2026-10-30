#!/usr/bin/env python3
"""FE 에이전트 세션 보호 훅 (Claude Code PreToolUse · Bash) — delegate.sh 가 FE 세션에만 건다.

막는 것 (실수 방지용이지 보안 경계가 아니다 — 스크립트 파일 안의 명령까지 보지는 않는다)
  - git commit 직접        → scripts/commit.sh 로 안내 (지정 파일만·엄격 검증·계획서 기록)
  - git add -A / --all / . / -u / 디렉터리  → 남의 변경이 섞인다. 파일을 하나씩 지정하거나 commit.sh 로
  - git push · gh pr (쓰기) → scripts/ship.sh 로 안내 (사용자가 "PR 올려줘" 했을 때 · 레포 하나짜리 작업만 · 그 한 마디로 커밋 → 정리 → draft PR)
  - git revert · merge · cherry-pick · am  → commit.sh 를 거치지 않고 커밋을 만든다(base 합치기는 commit.sh --merge-base — prBase 만)
  - git stash(list·show 제외) · reset --hard → 미커밋 변경(남의 작업일 수 있다)을 치우거나 지운다
  - git checkout·restore 로 전부(. · :/ · 디렉터리)를 되돌리기 · checkout -f · clean -f → 같은 이유(파일 하나 되돌리기·restore --staged 는 통과)
  - git rebase(--abort·--continue 등 진행 중 정리는 통과) · commit-tree · update-ref → commit.sh 를 거치지 않고 커밋·브랜치를 바꾼다
통과: 실제로 실행되는 명령(조각의 첫 실행 토큰)이 **이 아테나(athena) 레포의** scripts/commit.sh · scripts/ship.sh 인 조각(경로를 풀어 비교 — 같은 이름의 다른 파일은 막는다),
      gh pr 읽기(view·list·status·checks·diff), gh api 읽기(GET).
      PR 자동 리뷰의 고친 커밋 push 도 ship.sh --auto-push 로 이 통과 길을 쓴다 — 조건(켠 레포 · 열린 PR · 자동 리뷰의 수정 요청)은 ship.sh 가 본다(docs/pr-auto.md).
      자동 머지는 FE 세션이 아니라 scripts/pr-auto.mjs(현황판이 띄우는 처리기)가 하므로 이 훅이 걸리지 않는다.
그 밖에 막는 것: ship.sh --repo-agent(아테나 전용 — 여러 레포 순서 조율), gh api 쓰기(-X POST 등 · -f/-F 필드 · --input, 붙여 쓴 꼴 포함).
경로는 페이로드 cwd 기준으로 푼다 — 워크트리에서는 절대 경로로 부른다(에이전트 지시문이 그렇게 한다).
한계(보안 경계가 아니다): FE 세션은 아테나 레포에 쓰기 권한이 있어 scripts 자체나 계획서 기록(Review result 등)을 고칠 수 있고,
git -c alias.… · send-pack · eval · xargs 로 감싼 push 는 보지 않는다.

명령은 ; && || | & 줄바꿈으로 나누고, $( … ) · ` … ` · ( … ) 안과 sh|bash|zsh -c "…" 인자도 따로 본다.
VAR=값 · env · command · sudo · nohup · time · exec · nice 앞붙임은 건너뛰고, git·gh 는 경로를 떼고 이름으로 본다.
막으면 exit 2 — stderr 가 에이전트에게 그대로 전달된다.
"""
import json
import os
import pathlib
import re
import shlex
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
command = (payload.get('tool_input') or {}).get('command') or ''
cwd = payload.get('cwd') or os.getcwd()
if not command.strip():
    sys.exit(0)

WRAPPERS = {'env', 'command', 'sudo', 'nohup', 'time', 'exec', 'nice', 'builtin'}
SHELLS = {'sh', 'bash', 'zsh', 'dash'}
GIT_OPTS_WITH_VALUE = {'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'}
GH_OPTS_WITH_VALUE = {'-R', '--repo', '--hostname'}
# 통과시키는 스크립트 — 이 파일 기준 athena 루트의 scripts/ 아래 실제 파일만
ATHENA_SCRIPTS = pathlib.Path(__file__).resolve().parents[1]
ALLOWED_SCRIPTS = {name: os.path.realpath(ATHENA_SCRIPTS / name) for name in ('commit.sh', 'ship.sh')}


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
                    end = closing_paren(text, index + 1)
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
        if opener == '$(':
            cursor = closing_paren(view, index + 1)   # 치환 안의 따옴표 속 ) 는 세지 않는다
        else:
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


def check_git(args):
    """args = git 뒤의 토큰들. 막을 이유를 돌려준다"""
    index = 0
    while index < len(args) and args[index].startswith('-'):
        option = args[index].split('=', 1)[0]
        index += 2 if option in GIT_OPTS_WITH_VALUE and '=' not in args[index] else 1
    if index >= len(args):
        return ''
    sub, rest = args[index], args[index + 1:]
    if sub == 'commit':
        return '커밋은 scripts/commit.sh 로만 한다 — 사용자가 "커밋해줘" · "PR 올려줘" 라고 했을 때: scripts/commit.sh --plan <계획서> --dir <워크트리> -m "<메시지>" -- <파일>…'
    if sub == 'merge':
        # base 합치기(PR 충돌 풀기)는 commit.sh --merge-base 한 길만 — 이 레포 prBase 만 · 커밋은 commit.sh 가 merge 커밋으로(docs/pr-auto.md)
        return 'git merge 는 막는다. base(prBase)를 합쳐 충돌을 풀려면 scripts/commit.sh --plan <계획서> --dir <워크트리> --merge-base → 충돌을 푼 뒤 scripts/commit.sh … -m "<메시지>" -- <푼 파일>… 로 merge 커밋. 다른 브랜치를 합쳐야 하면 이유를 사용자에게 말한다'
    if sub in ('revert', 'cherry-pick', 'am', 'commit-tree', 'update-ref'):
        return f'git {sub} 는 commit.sh 를 거치지 않고 커밋·브랜치를 만든다(검증·계획서 기록 없음). 필요하면 이유를 사용자에게 말하고 사용자가 직접 실행하게 한다'
    if sub == 'rebase' and not any(arg in ('--abort', '--quit', '--show-current-patch') for arg in rest):
        return 'git rebase 는 commit.sh 를 거치지 않고 커밋을 다시 만든다. 필요하면 이유를 사용자에게 말하고 사용자가 직접 실행하게 한다(진행 중인 rebase 정리 --abort 는 된다)'
    if sub == 'clean' and not any(arg in ('-n', '--dry-run') or re.match(r'^-[A-Za-z]*n', arg) for arg in rest):
        return 'git clean 은 추적 안 된 파일(남의 작업일 수 있다)을 지운다. 지울 게 있으면 git clean -n 으로 목록만 보여 주고 사용자에게 확인받는다'
    if sub in ('checkout', 'restore'):
        # 작업 트리 전부·폴더째 되돌리기 — 남의 미커밋 변경까지 지운다. 파일 하나·restore --staged(스테이징만 내림)는 된다
        staged_only = sub == 'restore' and any(arg in ('--staged', '-S') for arg in rest) and not any(arg in ('--worktree', '-W') for arg in rest)
        paths = [arg for arg in rest if not arg.startswith('-')]
        if sub == 'checkout' and '--' not in rest and not any(path in ('.', './', ':/') for path in paths):
            paths = []   # checkout <브랜치> — 경로가 아니다
        broad = any(path in ('.', './', ':/', ':') or path.startswith(':/') or os.path.isdir(os.path.join(cwd, path)) for path in paths)
        forced = sub == 'checkout' and any(arg in ('-f', '--force') for arg in rest)
        if (broad and not staged_only) or forced:
            return f'git {sub} 로 작업 트리 전부·폴더째(또는 -f 로) 되돌리면 남의 미커밋 변경까지 지운다. 되돌릴 파일을 하나씩 지정하고, 많으면 사용자에게 확인받는다'
    if sub == 'stash' and (not rest or rest[0] not in ('list', 'show')):
        return 'git stash 는 미커밋 변경(사용자·남의 작업일 수 있다)을 치운다. 보기만(list·show) 허용 — 필요하면 사용자에게 묻는다'
    if sub == 'reset' and '--hard' in rest:
        return 'git reset --hard 는 미커밋 변경을 지운다. 되돌릴 게 있으면 파일을 지정해 사용자에게 확인한 뒤 사용자가 직접 한다'
    if sub == 'push':
        return 'push 는 scripts/ship.sh 로만 한다 — 사용자가 "PR 올려줘" 라고 했을 때: scripts/ship.sh --plan <계획서> --dir <워크트리> 미리보기 → 제목 · 본문 정리 → --yes'
    if sub == 'add':
        for arg in rest:
            short_bundle = re.match(r'^-[A-Za-z]+$', arg) and any(flag in arg[1:] for flag in 'Au')
            everything = arg in ('--all', '--update', '.', './', ':/', ':') or arg.startswith(':/') or short_bundle
            directory = not arg.startswith('-') and os.path.isdir(os.path.join(cwd, arg))
            if everything or directory:
                return 'git add -A · . · -u · 디렉터리는 남의 변경까지 올린다. 커밋하려면 scripts/commit.sh 에 파일을 하나씩 지정한다'
    return ''


def check_gh(args):
    index = 0
    while index < len(args) and args[index].startswith('-'):
        option = args[index].split('=', 1)[0]
        index += 2 if option in GH_OPTS_WITH_VALUE and '=' not in args[index] else 1
    if index < len(args) and args[index] == 'api':
        rest = args[index + 1:]
        # 붙여 쓴 꼴(-XPUT · -X=POST · --method=PATCH · -fquery=… · -Fhead=…)까지 본다
        method = ''
        for pos, token in enumerate(rest):
            if token in ('-X', '--method'):
                method = rest[pos + 1].upper() if pos + 1 < len(rest) else '?'
            elif token.startswith('--method='):
                method = token.split('=', 1)[1].upper()
            elif token.startswith('-X'):
                method = token[2:].lstrip('=').upper()
        writes = any(token.startswith(('-f', '-F', '--field', '--raw-field', '--input')) for token in rest)
        if (method and method != 'GET') or writes:
            return 'gh api 쓰기는 막는다 — PR 은 scripts/ship.sh 로. 읽기(GET)만 허용'
        return ''
    if index < len(args) and args[index] == 'pr':
        action = args[index + 1] if index + 1 < len(args) else ''
        if action in ('view', 'list', 'status', 'checks', 'diff'):
            return ''
        return 'PR 은 scripts/ship.sh 로만 만든다 — 사용자가 "PR 올려줘" 라고 했을 때: scripts/ship.sh --plan <계획서> --dir <워크트리> 미리보기 → 제목 · 본문 정리 → --yes'
    return ''


# heredoc 머리줄 — <<EOF · <<-EOF · <<'EOF' · <<"EOF" · <<\EOF (따옴표·역슬래시가 있으면 본문에서 치환이 일어나지 않는다)
# 구분자는 단어 하나 전체다(<<EOF-X 의 구분자는 EOF-X) — 따옴표 · 역슬래시를 뗀 것이 종료자 줄이다
HEREDOC_HEAD = re.compile(r'<<(?!<)(?P<dash>-)?[ \t]*(?P<word>(?:\\.|\'[^\']*\'|"[^"]*"|[^\s;&|()<>\'"\\])+)[^\n]*\n')


def closing_paren(body, start):
    """body[start] == '(' 의 짝 ')' 자리 — 안쪽 따옴표 · 역슬래시 속의 괄호는 세지 않고, 큰따옴표 안의 $( … ) · 백틱은
    새 문맥이라 그 짝까지 통째로 건너뛴다(없으면 len(body))"""
    depth, quote, index = 0, '', start
    while index < len(body):
        char = body[index]
        if quote == "'":
            quote = '' if char == "'" else quote
        elif char == '\\':
            index += 1
        elif body.startswith('$(', index):
            index = closing_paren(body, index + 1)
        elif char == '`':
            index += 1
            while index < len(body) and body[index] != '`':
                index += 2 if body[index] == '\\' else 1
        elif quote == '"':
            quote = '' if char == '"' else quote
        elif char in ('"', "'"):
            quote = char
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return len(body)


def arithmetic_spans(view):
    """(( … )) · $(( … )) 구간 (시작, 끝) — 안의 << 는 heredoc 이 아니라 시프트 연산이다"""
    spans = []
    for opened in re.finditer(r'\(\(', view):
        depth, cursor = 0, opened.start()
        while cursor < len(view):
            depth += {'(': 1, ')': -1}.get(view[cursor], 0)
            if depth == 0:
                break
            cursor += 1
        spans.append((opened.start(), cursor))
    return spans


def unquote_word(word):
    """셸의 인용 제거 — 작은따옴표 안은 그대로(역슬래시 포함), 큰따옴표 안의 역슬래시는 $ ` " \\ 앞에서만 사라지고, 따옴표 밖은 다음 글자를 보호"""
    out, quote, index = [], '', 0
    while index < len(word):
        char = word[index]
        following = word[index + 1:index + 2]
        if quote == "'":
            if char == "'":
                quote = ''
            else:
                out.append(char)
        elif char == '\\':
            if quote == '"' and following not in ('$', '`', '"', '\\', '\n'):
                out.append(char)
            else:
                out.append(following); index += 1
        elif char == '"':
            quote = '' if quote else '"'
        elif char == "'" and not quote:
            quote = "'"
        else:
            out.append(char)
        index += 1
    return ''.join(out)


def heredoc_substitutions(body):
    """따옴표 없는 heredoc 본문에서 실제로 실행되는 $( … ) · ` … ` 안쪽만 꺼낸다 — \\$( · \\` 는 글자일 뿐이다"""
    found, index = [], 0
    while index < len(body):
        char = body[index]
        if char == '\\':
            index += 2
        elif body.startswith('$(', index):
            end = closing_paren(body, index + 1)
            found.append(body[index + 2:end]); index = end + 1
        elif char == '`':
            end = index + 1
            while end < len(body) and body[end] != '`':
                end += 2 if body[end] == '\\' else 1
            found.append(body[index + 1:end]); index = end + 1
        else:
            index += 1
    return found


def strip_heredocs(text):
    """heredoc 본문은 명령이 아니라 글이다 — 커밋 메시지 줄이 `commit.sh …` · `git commit …` 로 시작해도 명령으로 보지 않게 지운다.
    따옴표 · 주석 · 산술식 안의 << 는 heredoc 이 아니다(그 뒤 줄은 실제 명령이다). 종료자는 셸처럼 줄 전체가 정확히 같아야 한다
    (<<- 이면 앞의 탭만 뗀다 — 공백 · 닫는 괄호는 안 된다). 종료자가 없으면 끝까지가 본문이다.
    따옴표 없는 구분자(<<EOF)의 본문은 실제로 실행되는 $( … ) · ` … ` 만 남긴다"""
    view = mask_quotes(text, keep_substitution=True)
    spans = arithmetic_spans(view)
    out, position = [], 0
    for head in HEREDOC_HEAD.finditer(text):
        start = head.start()
        if start < position:
            continue
        line_start = text.rfind('\n', 0, start) + 1
        if (view[start:start + 2] != '<<' or re.search(r'(^|\s)#', view[line_start:start])
                or any(begin <= start <= end for begin, end in spans)):
            continue
        tag = unquote_word(head.group('word'))
        if not tag:
            continue
        body_end, cursor = len(text), head.end()
        while cursor < len(text):
            line_end = text.find('\n', cursor)
            line_end = len(text) if line_end < 0 else line_end
            line = text[cursor:line_end]
            if (line.lstrip('\t') if head.group('dash') else line) == tag:
                body_end = cursor
                break
            cursor = line_end + 1
        out.append(text[position:head.end()])
        if tag == head.group('word'):   # 따옴표 · 역슬래시가 없는 구분자만 본문에서 치환이 일어난다
            out += [f'$({piece})\n' for piece in heredoc_substitutions(text[head.end():body_end])]
        position = body_end
    out.append(text[position:])
    return ''.join(out)


def raw_words(piece):
    """따옴표 · 역슬래시를 그대로 둔 채 공백으로 나눈 단어들 — tokens_of 와 단어 수가 같으면 같은 자리다"""
    words, current, quote, started, index = [], '', '', False, 0
    while index < len(piece):
        char = piece[index]
        if quote == "'":
            current += char
            quote = '' if char == "'" else quote
        elif char == '\\' and index + 1 < len(piece):
            current += piece[index:index + 2]; index += 2; started = True; continue
        elif quote == '"':
            current += char
            quote = '' if char == '"' else quote
        elif char in ('"', "'"):
            quote = char; current += char; started = True
        elif char.isspace():
            if started:
                words.append(current); current, started = '', False
        else:
            current += char; started = True
        index += 1
    if started:
        words.append(current)
    return words


def assigned(name):
    """명령 글 안에서 이 변수에 값을 넣는 부분이 있나 — 있으면 훅 프로세스의 값은 셸의 값이 아니다(eval 이 있으면 모른다)"""
    escaped = re.escape(name)
    patterns = [
        rf'(?<![\w$]){escaped}\+?=',
        rf'\$\{{{escaped}:?=',
        rf'\b(?:export|declare|typeset|readonly|local|unset|read|getopts|mapfile|readarray|for|select|printf\s+-v)\b[^;&|\n]*\b{escaped}\b',
    ]
    return bool(re.search(r'\beval\b', command)) or any(re.search(pattern, command) for pattern in patterns)


def expand_word(raw):
    """셸이 실제로 풀어 주는 부분만 푼다 — 작은따옴표 · 역슬래시로 보호된 $VAR · ~ 는 글자 그대로,
    큰따옴표 안의 ~ 도 그대로. 풀 수 없으면(미정의 변수 · 명령 치환 · 글롭 · 이 명령 안에서 값을 넣는 변수) None"""
    out, index, quote = [], 0, ''
    while index < len(raw):
        char = raw[index]
        following = raw[index + 1:index + 2]
        if quote == "'":
            if char == "'":
                quote = ''
            else:
                out.append(char)
        elif char == '\\':
            if quote == '"' and following not in ('$', '`', '"', '\\', '\n'):
                out.append(char)
            else:
                out.append(following); index += 1
        elif char == '"':
            quote = '' if quote else '"'
        elif char == "'" and not quote:
            quote = "'"
        elif char == '`' or (char == '$' and following in ('(', '')):
            return None
        elif char == '$':
            matched = re.match(r'\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))', raw[index:])
            if not matched:
                return None
            name = matched.group(1) or matched.group(2)
            if name in ('PWD', 'OLDPWD') or name not in os.environ or assigned(name):
                return None
            out.append(os.environ[name]); index += matched.end(); continue
        elif char == '~' and not quote and index == 0:
            if following not in ('', '/') or assigned('HOME'):
                return None
            out.append(os.path.expanduser('~'))
        elif not quote and char in '*?[{':
            return None
        else:
            out.append(char)
        index += 1
    return None if quote else ''.join(out)


def resolve_script_path(raw, token):
    """실행하는 스크립트 경로를 실경로로 — raw(원문 단어)가 있으면 셸이 푸는 만큼만 풀고, 못 풀면 None(= 같은 파일이라 확신할 수 없다)"""
    expanded = token if raw is None else expand_word(raw)
    return None if expanded is None else os.path.realpath(os.path.join(cwd, expanded))


def check(text, depth=0):
    if depth > 5:
        return ''
    text = strip_heredocs(text)
    for inner in inner_commands(text):
        reason = check(inner, depth + 1)
        if reason:
            return reason
    for piece in split_pieces(text):
        all_tokens = tokens_of(piece)
        tokens = strip_prefix(all_tokens)
        if not tokens:
            continue
        name = os.path.basename(tokens[0])
        if name in ALLOWED_SCRIPTS:
            # 이 아테나 레포의 그 파일일 때만 통과 — ./ship.sh · /tmp/ship.sh 같은 같은 이름의 다른 파일은 막는다
            words = raw_words(piece)
            raw = words[len(all_tokens) - len(tokens)] if len(words) == len(all_tokens) else None
            if resolve_script_path(raw, tokens[0]) != ALLOWED_SCRIPTS[name]:
                return f'{name} 은 아테나(athena) 레포의 scripts/{name} 만 실행한다: {ALLOWED_SCRIPTS[name]}'
            if name == 'ship.sh' and any(token == '--repo-agent' or token.startswith('--repo-agent=') for token in tokens[1:]):
                return 'ship.sh --repo-agent 는 아테나 전용이다(여러 레포 작업의 순서 조율). 사용자에게 아테나에게 PR 을 요청해 달라고 알린다'
            continue
        # -c 는 -lc · -ec 처럼 다른 옵션과 묶여 올 수 있다
        flag = next((position for position, token in enumerate(tokens[1:], 1) if re.match(r'^-[A-Za-z]*c[A-Za-z]*$', token)), None) if name in SHELLS else None
        if flag is not None:
            position = flag
            if position + 1 < len(tokens):
                reason = check(tokens[position + 1], depth + 1)
                if reason:
                    return reason
            continue
        if name == 'git':
            reason = check_git(tokens[1:])
        elif name == 'gh':
            reason = check_gh(tokens[1:])
        else:
            reason = ''
        if reason:
            return reason
    return ''


reason = check(command)
if reason:
    print(f'⛔ 아테나 보호 훅: {reason}', file=sys.stderr)
    sys.exit(2)
sys.exit(0)
