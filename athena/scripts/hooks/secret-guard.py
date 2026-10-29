#!/usr/bin/env python3
"""시크릿 출력 차단 훅 (Claude Code PreToolUse · Bash) — 아테나·FE 에이전트·reviewer 모든 세션에 건다.

규칙: 토큰·키·비밀번호 값은 **어떤 경로로든 출력하지 않는다** (AGENTS.md 5절). 2026-10-01 에이전트가
`pnpm config get` 으로 사용자 전역 ~/.npmrc 토큰을 터미널에 찍은 사고 뒤에 넣었다.

막는 것
  - 패키지 매니저 설정 출력: npm|pnpm|yarn config get|list|ls (… 토큰이 섞여 나온다), npm|pnpm config 로 _authToken 조회
  - 시크릿 파일 읽기: git show·cat-file·diff·log·blame·grep · cat·head·tail·less·more·bat·grep·rg·awk·sed·strings·xxd·od·nl·cut·sort·jq·base64·open 이
    .npmrc · .env* · *.pem · *.key · id_rsa* · .netrc · .aws/credentials · gh/hosts.yml · firebase-key.json · access-key.js 를 읽는 것
    (값을 가리는 sed 치환 's/…=.*/…***/' 이 같은 파이프라인에 있으면 통과 · .env.example 같은 예시 파일만이면 통과)
  - 환경 변수 통째로 출력: printenv · env(인자 없이) · export -p · set(인자 없이) · declare -x
  - 토큰 변수 출력: echo/printf 에 $…TOKEN·KEY·SECRET·PASSWORD·PASS·AUTH… 가 들어간 것
  - 자격 증명 꺼내기: gh auth token · gh auth status -t/--show-token · git credential fill · security find-*-password -w
  - 프로세스 전체 인자·환경 변수: pgrep -fl/-a · ps aux/-ef/-e/-E/eww/-o command|args (편집기 helper 인자에 GITHUB_TOKEN=… 이 실린다 — 2026-10-02 사고)
확인이 필요하면 값 대신 **있는지·길이·해시 앞자리·HTTP 상태 코드**만 본다(예: curl -s -o /dev/null -w '%{http_code}').
실수 방지용이지 보안 경계가 아니다 — 스크립트 파일 안의 명령까지 보지는 않는다. 막으면 exit 2 (stderr 가 에이전트에게 간다).
"""
import json
import re
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
command = (payload.get('tool_input') or {}).get('command') or ''
if not command.strip():
    sys.exit(0)

# heredoc 본문과 작은따옴표 안은 실행되지 않는 글자다 — 규칙 문장·커밋 메시지에 'pnpm config get' 이 적혀 있어도 막지 않게 지운다.
# 단 따옴표 없는 heredoc(<<EOF)은 본문의 $(…)·`…` 가 실행되므로 그런 줄은 남긴다. 큰따옴표 안은 남긴다($TOKEN 이 펼쳐지고, "~/.npmrc" 처럼 경로를 감쌀 수 있다)
def strip_heredoc(source):
    out, end_tag, keep_subst = [], None, False
    for line in source.split('\n'):
        if end_tag is not None:
            if line.strip() == end_tag:
                end_tag = None
            elif keep_subst and ('$(' in line or '`' in line):
                out.append(line)
            continue
        match = re.search(r"<<-?\s*(['\"]?)(\w+)\1", line)
        if match:
            end_tag, keep_subst = match.group(2), not match.group(1)
        out.append(line)
    return '\n'.join(out)


base = strip_heredoc(command)
text = re.sub(r"'[^']*'", "''", base)
# 시크릿 파일 — 경로의 시작(앞에 글자·점이 없음)에서만 본다: process.env · import.meta.env · api.key.ts 는 파일이 아니다
SECRET_FILE = r"((?<![\w.-])\.npmrc(?![\w-])|(?<![\w.-])\.env(\.[\w-]+)*(?![\w-])|\.pem(?![\w.-])|\.key(?![\w.-])|id_rsa\w*|id_ed25519\w*|(?<![\w.-])\.netrc(?![\w-])|\.aws/credentials|gh/hosts\.yml|firebase-key\.json|access-key\.js)"
EXAMPLE_FILE = r"\.env\.(example|sample|template)$"
READERS = r"(\bgit\s+(show|cat-file|diff|log|blame|grep)\b|\b(cat|head|tail|less|more|bat|grep|egrep|rg|awk|sed|strings|xxd|od|hexdump|nl|cut|sort|uniq|jq|base64|open|tac|view|vim?|nano)\b)"
SECRET_VAR = r"\$\{?\w*(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL)\w*\}?"
# 값을 가리는 sed 치환 — 보통 작은따옴표 안에 있어 원래 글자에서 찾는다. 읽는 명령과 같은 파이프라인(; && || 줄바꿈으로 나뉘기 전)에 있어야 통과
MASK = r"s[/|#][^/|#]*(=|:)\)?\.\*[/|#][^/|#]*(\*{3}|MASK|숨김|<redacted>)"

# 명령 자리 — 줄 처음 · ; & | ( ` 줄바꿈 $( 뒤 · sh|bash -c " 안, 그 뒤 앞붙임(sudo/env/command/exec/time/nice/xargs/watch/timeout — 경로 · 값을 받는 옵션 -u root · 맨 숫자 인자 timeout 5 포함) · VAR=값 · 경로(/bin/ps)까지.
# ps · pgrep 은 인자 자리의 글자(send-keys ps Enter · docs/ps · grep x ps)에는 걸리지 않게 이 자리에서만 본다
CMD_POSITION = r"(?:^|[;&|(`\n]|\b(?:sh|bash|zsh)\s+-\w*c\s+[\"'])\s*(?:(?:\S*/)?(?:sudo|env|command|exec|time|nohup|nice|xargs|watch|timeout)\s+(?:-\S+(?:\s+[^-\s;&|]\S*)?\s+)*(?:\d\S*\s+)?|\w+=\S*\s+)*(?:\S*/)?"

rules = [
    (r"\b(npm|pnpm|yarn)\s+config\s+(get|list|ls)\b", "패키지 매니저 설정 출력(config get/list)은 토큰을 찍는다"),
    (r"\bnpm\s+whoami\b.*--verbose", "npm whoami --verbose 는 토큰을 찍을 수 있다"),
    (r"\b(printenv)\b", "환경 변수를 통째로 출력한다"),
    (r"(^|[;&|(]\s*)env\s*($|[;&|)])", "환경 변수를 통째로 출력한다"),
    (r"\bexport\s+-p\b|\bdeclare\s+-x\b|(^|[;&|(]\s*)set\s*($|[;&|)])", "환경 변수를 통째로 출력한다"),
    (rf"\b(echo|printf)\b[^;&|]*{SECRET_VAR}", "토큰·키 변수를 출력한다"),
    (r"\bgh\s+auth\s+token\b|\bgh\s+auth\s+status\b[^;&|]*(-t\b|--show-token)", "GitHub 토큰을 꺼낸다"),
    (r"\bgit\s+credential\s+fill\b", "git 자격 증명을 꺼낸다"),
    (r"\bsecurity\s+find-\w+-password\b[^;&|]*-w\b", "키체인 비밀번호를 꺼낸다"),
    # 프로세스 목록의 전체 인자·환경 변수 — 편집기 helper 등은 인자에 환경 변수(GITHUB_TOKEN=…)를 통째로 싣는다(2026-10-02 pgrep -fl 사고)
    (rf"{CMD_POSITION}pgrep\b(?:[^;&|]*\s-(?:\w*l\w*f|\w*f\w*l|\w*a)\w*\b|[^;&|]*\s-\w*l\w*\b[^;&|]*\s-\w*f|[^;&|]*\s-\w*f\w*\b[^;&|]*\s-\w*l)", "프로세스 전체 인자를 출력한다(환경 변수·토큰이 섞여 나온다) — pid 만 pgrep -f, 이름은 ps -o pid=,comm="),
    # macOS ps: -e/-E 환경 변수, -f/-j·BSD u 전체 인자, -o command|args 전체 인자
    (rf"{CMD_POSITION}ps\b(?:[^;&|]*(?:\s-[a-zA-Z]*[eEfj][a-zA-Z]*\b|\s-[a-zA-Z]*o\s*\S*\b(?:command|args|cmd)\b)|\s+[a-zA-Z]*[eu][a-zA-Z]*\b)","프로세스 전체 인자·환경 변수를 출력한다 — ps -axo pid=,ppid=,comm= 처럼 명령 이름만 본다"),
]
for pattern, reason in rules:
    if re.search(pattern, text):
        sys.stderr.write(f"⛔ 시크릿 출력 차단: {reason}.\n토큰·키 값은 어떤 경로로든 출력하지 않는다(AGENTS.md 5절). 필요하면 있는지·길이·HTTP 상태 코드만 확인한다 — 예: curl -s -o /dev/null -w '%{{http_code}}' …\n")
        sys.exit(2)

# 시크릿 파일을 읽는 명령 — 같은 조각에 읽는 도구와 시크릿 파일이 함께 있으면 막는다.
# 명령을 ; && || & 줄바꿈으로 나눈 파이프라인마다 본다 — 값을 가리는 sed 치환은 그 파이프라인 안에 있을 때만 통과(다른 명령의 치환으로 풀리지 않게).
# 나누는 기호는 따옴표 밖에서만 찾는다(따옴표 안 글자를 같은 길이로 가린 그림자 문자열로 위치를 잡는다)
def shadow(source):
    out, quote = [], None
    for char in source:
        if quote:
            out.append(char if char == quote else '_')
            if char == quote:
                quote = None
        else:
            if char in '\'"':
                quote = char
            out.append(char)
    return ''.join(out)


def pipelines(source):
    cuts = [0]
    for match in re.finditer(r"&&|\|\||;|\n|(?<![>&|])&(?![&>])", shadow(source)):
        cuts += [match.start(), match.end()]
    cuts.append(len(source))
    return [source[cuts[index]:cuts[index + 1]] for index in range(0, len(cuts), 2)]


def file_view(segment):
    # 공백이 든 따옴표 문장(지시문·커밋 메시지·검색어)은 파일 경로가 아니다 — 지운다. 공백 없는 따옴표('.env' · "$HOME/.npmrc")는 경로일 수 있어 따옴표만 벗긴다
    segment = re.sub(r"'[^']*\s[^']*'|\"[^\"]*\s[^\"]*\"", "''", segment)
    segment = re.sub(r"'([^']*)'|\"([^\"]*)\"", lambda match: match.group(1) if match.group(1) is not None else match.group(2), segment)
    # git 제외 pathspec(:!.npmrc · :(exclude).env) 는 읽는 게 아니라 빼는 것 — 지우고 본다
    return re.sub(r":(!|\(exclude\))\S+", ' ', segment)


for segment in pipelines(base):
    masked = re.search(MASK, segment)
    for piece in file_view(segment).split('|'):
        if not re.search(READERS, piece) or masked:
            continue
        # .env.example · .env.sample 같은 예시 파일만이면 통과 — 실제 파일이 하나라도 섞이면 막는다
        found = [match.group(0) for match in re.finditer(SECRET_FILE, piece)]
        if any(not re.search(EXAMPLE_FILE, name) for name in found):
            sys.stderr.write("⛔ 시크릿 출력 차단: 시크릿 파일(.npmrc·.env·키 파일 등) 내용을 읽어 출력한다.\n값을 봐야 하면 같은 파이프라인에서 sed 's/_authToken=.*/_authToken=***/' 처럼 가린 뒤 보거나, 있는지·참조 형태(${…})인지만 확인한다(AGENTS.md 5절).\n")
            sys.exit(2)
sys.exit(0)
