#!/usr/bin/env python3
"""대화 압축 전후 Checkpoint 훅 (Claude Code PreCompact · SessionStart[compact] · Codex 는 같은 이벤트 이름 — `--tool=codex`).

대화가 압축되면 진행 상황이 요약에만 남는다. 진행 상황의 정본은 계획서 Checkpoint 다(AGENTS.md 2.6).
  pre  — 압축 직전(PreCompact): 이 pane 에 묶인 계획서 Checkpoint 에 기계적으로 알 수 있는 상태
         (시각 · 브랜치 · HEAD · 미커밋 파일)를 `- Auto snapshot:` 한 줄로 갱신한다. Claude 가 쓰지 않아도 남는다
  post — 압축 직후(SessionStart, source=compact): "요약만 믿지 말고 계획서 Checkpoint 부터 다시 읽어라" 를
         계획서 경로·스냅샷과 함께 대화 맨 앞에 넣는다

  warn — 도구를 쓴 뒤 · 메시지를 받을 때(PostToolUse · UserPromptSubmit): 지금 문맥이 실제 압축 기준의 70% 를 넘으면
         (Claude 는 압축 창 − 33,000 · Codex 는 codex_compact_limit — 2026-11-07 사용자: 압축점의 70%)
         "곧 압축 — 알게 된 것을 계획서 · 이슈에 적어 두라" 를 모델에게만 한 번 넣는다(압축 뒤 다시 한 번).
         사용자 화면에는 띄우지 않는다(2026-11-06 사용자: 헷갈리니 알리지 말고 적기만) · 글은 "답하기 전에 먼저 적어라" 로
         할 일을 앞에 둔다(Codex 는 사용자 글 뒤에 붙어 "적기만" 을 미뤘다)
         아테나 세션에는 리드 기록(scripts/lead-log.mjs)에도 적으라고 가리킨다
         세션 첫 도구 뒤에는 기록에 첫 응답이 아직 없을 수 있어 잠깐(FIRST_WRITE_WAIT) 다시 읽는다

압축 뒤 안내에는 대화 원문 자리(훅 입력 transcript_path)와 찾는 명령(scripts/transcript-search.mjs)을 붙이고,
아테나 세션이면 리드 기록 최근 줄을 맨 앞에 싣는다.
요약이 빠뜨린 것을 원문으로 끝에 더 싣는다(2026-11-07 사용자: 압축 뒤 앞서 받은 말 · 다른 일을 잊는다):
  최근 사용자 말 — 기록 끝에서 거꾸로 사람이 친 글만 USER_WORDS_COUNT 개(시각 · 한 개 · 전체 글자 상한 · pane 알림 · 도구 결과 · 태그 글 빼고)
  아테나 세션이면 열린 [작업] 요청(bin/athena request list)과 살아 있는 에이전트 pane(scripts/lib/screen.py) — 조회마다 LOOKUP_TIMEOUT
  이 묶음은 scripts/lib/mask.mjs 로 비밀값을 가린 뒤 싣고, 가리지 못하면 싣지 않는다 · 안내 전체는 POST_MESSAGE_LIMIT 글자까지

Codex(`--tool=codex` — .codex/hooks.json · scripts/lib/codex_dispatch.py 가 건다)는 대화 기록이 rollout jsonl
(`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<시각>-<세션 id>.jsonl`)이라 셈이 다르다(2026-11-06 실제 기록 · codex-cli 0.166 확인):
  문맥 크기 — 마지막 `event_msg` token_count 의 info.last_token_usage.total_tokens
  압축 기준 — min(config.toml `model_auto_compact_token_limit` → 모델 값, context_window × 9/10) — codex-rs 소스 줄은 codex_compact_limit
             (Codex 도 last_token_usage.total_tokens 에 그 뒤 도구 결과 추정치를 더해 센다 — context_manager/history.rs:953-974 · 훅은 앞부분만 본다)
  기록 자리 — 훅 입력 transcript_path, 없으면 세션 id 로 sessions/ 에서 찾는다

계획서 찾기 — 이 pane(화면 계층 self — scripts/lib/screen.py)이 적힌 계획서:
  ① 일하는 pane — Checkpoint `- Work ref: … pane <id>` · `- Review: … pane <id>`(delegate.sh 가 적는다). 여럿이면 가장 최근에 고친 것 하나
  ② ① 이 없으면 아테나 pane — 정식 계획서 html 의 `"leadPane": "<id>"`(옛 계획서는 `hermesPane`) · Checkpoint `- Lead pane: <id>`
     (delegate.sh 가 아테나 pane 에서 띄울 때 적는다). 아테나는 여러 일을 맡기니 모두 · 최근에 고친 순
끝난(done) 계획서와 계획서가 아닌 것(`plans/artifacts/` · `## Checkpoint` 가 없는 md)은 뺀다.
그 계획서에 묶인 이슈(Checkpoint `- Issue: issues/…` · 이슈 머리 `plan:` 이 그 계획서)도 끝나지 않았으면 다시 읽을 목록에 넣는다.
못 찾으면 pre 는 아무것도 쓰지 않고, post 는 진행 중 계획서 후보만 알린다(아테나 세션·FE pane 에서만).
압축·세션 시작을 막거나 늦추지 않는다(항상 exit 0).

사용: compact-checkpoint.py pre | post [다시 읽을 레포 규칙 문서 경로…] | warn  [--tool=codex]   (hook 입력 JSON 은 stdin)
"""
import datetime
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import time

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
from plan_update import update_plan  # noqa: E402 — 경로를 넣은 뒤에 읽는다
import athena_config  # noqa: E402
import screen  # noqa: E402
PLANS_DIR = ATHENA_DIR / 'plans'
ISSUES_DIR = ATHENA_DIR / 'issues'
# 계획서가 아닌 산출물(검증 표 · 리뷰 메모 등)을 두는 곳 — 진행 중 계획서로 치지 않는다
NOT_PLAN_DIRS = ('artifacts',)
# 실제 압축 기준의 이만큼(%)을 넘으면 알린다 — 정수 셈(경계에서 소수 오차 없게)
WARN_PERCENT = 70
# Claude Code 2.1.319 의 자동 압축 기준 = 압축 창 − 출력 여유 min(maxOutputTokens, 20,000) − 요약 여유 13,000
#   (설치본 Ure · L4 — 시험 실측 200k 에서 167,392 · 100k 에서 68,219). 출력 한도가 20,000 보다 작은 모델은 기준이 더 늦으니 알림은 더 이르다
CLAUDE_OUTPUT_RESERVE = 20000
CLAUDE_SUMMARY_RESERVE = 13000
# 같은 세션에서 이미 알렸다는 표시 — 세션 id 이름의 빈 파일(압축 직후 지운다)
WARN_MARK_DIR = pathlib.Path(tempfile.gettempdir()) / 'athena-compact-warn'
# 세션 첫 응답은 PostToolUse 훅이 시작된 뒤에야 기록에 쓰인다(2026-11-07 대화형 claude 실측 — 훅 시작 60ms 뒤 · 둘째 응답부터는 이미 있다).
#   그때 사용량을 못 읽으면 이만큼(초) 다시 읽어 본다 — 없으면 조용히 끝(첫 도구 뒤 알림이 다음 메시지까지 밀렸다)
FIRST_WRITE_WAIT = 1.0
FIRST_WRITE_STEP = 0.05
# 대화 기록 끝에서 마지막 응답을 찾을 때 거꾸로 읽는 최대 크기
TRANSCRIPT_TAIL_LIMIT = 16 * 1024 * 1024
SNAPSHOT_PREFIX = '- Auto snapshot:'
# 압축 뒤 아테나 세션에 보여 줄 리드 기록 최근 줄 수(scripts/lead-log.mjs)
LEAD_LOG_TAIL = 15
# 압축 뒤 안내에 원문으로 다시 싣는 최근 사용자 말 — 개수 · 한 개 글자 상한 · 묶음 전체 글자 상한(넘으면 오래된 것부터 뺀다)
USER_WORDS_COUNT = 20
USER_WORD_LIMIT = 300
USER_WORDS_TOTAL = 4000
# 아테나 세션의 열린 요청 · 에이전트 pane 목록 — 줄 수 · 한 줄 글자 상한
LIVE_LIST_COUNT = 15
LIVE_LINE_LIMIT = 160
# 압축 뒤 안내 전체 글자 상한 — 넘으면 끝을 자른다
POST_MESSAGE_LIMIT = 9000
# 조회 하나마다 시간 상한(초) — 압축 뒤 세션 시작을 늦추지 않는다
LOOKUP_TIMEOUT = 2
# 사람이 친 글이 아닌 pane 알림의 머리 — `[athena-studio-fe → 아테나]` · `[자동 리뷰 → fe]` · `[아테나 pw3 → … pw0]`(pane 으로 넣어 typed 로 기록된다)
PANE_NOTICE = re.compile(r'\[[^\[\]\n]{1,80} → [^\[\]\n]{1,80}\]')
# 글 안의 이미지 자리 표시(`[Image #1]` 등) — 원문 묶음에서는 뺀다
IMAGE_MARK = re.compile(r'\[Image[^\]\n]*\]')
# Codex 가 사용자 차례에 끼워 넣는 지시문(태그로 시작하지 않는 것)
CODEX_INJECTED = ('# AGENTS.md instructions',)
MAX_LISTED_FILES = 8
CODEX_SESSION_ID = re.compile(r'^[0-9A-Za-z-]{8,64}$')


def read_payload() -> dict:
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def plan_status(text: str) -> str:
    match = re.search(r'^- Status:\s*(.*)$', text, re.M)
    return match.group(1).strip() if match else ''


def is_plan_file(path: pathlib.Path, text: str) -> bool:
    """계획서인가 — plans/artifacts/ 아래가 아니고 Checkpoint 절이 있다(진행 상황의 정본 · AGENTS.md 2.6)"""
    relative = path.relative_to(PLANS_DIR).parts
    if relative and relative[0] in NOT_PLAN_DIRS:
        return False
    return re.search(r'^## Checkpoint\s*$', text, re.M) is not None


def active_plans() -> list:
    """끝나지 않은 계획서 (경로, 본문) — 최근에 고친 순"""
    if not PLANS_DIR.is_dir():
        return []
    found = []
    for path in PLANS_DIR.rglob('*.md'):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        if not is_plan_file(path, text) or plan_status(text).startswith('done'):
            continue
        found.append((path, text))
    found.sort(key=lambda item: item[0].stat().st_mtime, reverse=True)
    return found


def find_plans(pane_id: str):
    """이 pane 의 계획서 ([(경로, 본문)], 아테나 pane 인가) — 일하는 pane 이면 하나, 아테나 pane 이면 묶인 것 모두(최근에 고친 순)"""
    if not pane_id:
        return [], False
    pane_pattern = re.compile(r'^- (?:Work ref|Review):.*\bpane ' + re.escape(pane_id) + r'(?![\w:])', re.M)
    lead_pattern = re.compile(r'^- Lead pane:[ \t]*' + re.escape(pane_id) + r'(?![\w:])', re.M)
    # leadPane — 이름 변경(2026-10) 전 계획서는 hermesPane
    html_needles = (f'"leadPane": "{pane_id}"', f'"hermesPane": "{pane_id}"')
    led = []
    for path, text in active_plans():
        if pane_pattern.search(text):
            return [(path, text)], False
        if lead_pattern.search(text):
            led.append((path, text))
            continue
        html_path = path.with_suffix('.html')
        try:
            if html_path.is_file() and any(needle in html_path.read_text(encoding='utf-8') for needle in html_needles):
                led.append((path, text))
        except OSError:
            continue
    return led, bool(led)


def issue_field(text: str, name: str) -> str:
    match = re.search(r'^' + re.escape(name) + r':[ \t]*(.*)$', text, re.M)
    return match.group(1).strip() if match else ''


def linked_issues(plans: list) -> list:
    """계획서에 묶인 끝나지 않은 이슈 경로 — 계획서 `- Issue: issues/…` 또는 이슈 머리 `plan:` 이 그 계획서(docs/issues.md)"""
    if not plans or not ISSUES_DIR.is_dir():
        return []
    plan_paths = {str(path.relative_to(ATHENA_DIR)) for path, _ in plans}
    named = set()
    for _, text in plans:
        match = re.search(r'^- Issue:[ \t]*(issues/\S+\.md)', text, re.M)
        if match:
            named.add(match.group(1))
    found = []
    for path in sorted(ISSUES_DIR.glob('*.md')):
        relative = str(path.relative_to(ATHENA_DIR))
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        if issue_field(text, 'status') in ('done', 'wontfix'):
            continue
        if relative in named or issue_field(text, 'plan') in plan_paths:
            found.append(relative)
    return found


def git(work_dir: str, *args: str) -> str:
    try:
        # 앞쪽 공백은 남긴다 — status --porcelain 첫 줄의 상태 칸(" M")이 잘리면 파일명 첫 글자가 먹힌다
        return subprocess.run(['git', '-C', work_dir, *args], capture_output=True, text=True, timeout=5).stdout.rstrip()
    except Exception:
        return ''


def work_dir_for(plan_text: str, payload: dict) -> str:
    """스냅샷을 찍을 트리 — 워크트리 검증 경로 > Work ref 맨 앞의 실제 폴더 > 세션 cwd"""
    verify_dir = os.environ.get('ATHENA_VERIFY_DIR', '')
    if verify_dir and os.path.isdir(verify_dir):
        return verify_dir
    match = re.search(r'^- Work ref:\s*(\S+)', plan_text, re.M)
    if match and os.path.isdir(match.group(1)):
        return match.group(1)
    return payload.get('cwd') or os.getcwd()


def snapshot_line(work_dir: str, trigger: str) -> str:
    now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    branch = git(work_dir, 'rev-parse', '--abbrev-ref', 'HEAD') or '?'
    head = git(work_dir, 'log', '-1', '--format=%h %s') or '?'
    changed = [line[3:] for line in git(work_dir, 'status', '--porcelain').splitlines() if len(line) > 3]
    listed = ', '.join(changed[:MAX_LISTED_FILES]) + (f' 외 {len(changed) - MAX_LISTED_FILES}개' if len(changed) > MAX_LISTED_FILES else '')
    dirty = f'미커밋 {len(changed)}개({listed})' if changed else '미커밋 없음'
    return f'{SNAPSHOT_PREFIX} {now} 대화 압축 직전({trigger}) · {work_dir} · 🌿 {branch} · HEAD {head} · {dirty}'


def write_snapshot(path: pathlib.Path, line: str) -> None:
    def record(text: str):
        if re.search(r'^' + re.escape(SNAPSHOT_PREFIX) + r'.*$', text, re.M):
            return re.sub(r'^' + re.escape(SNAPSHOT_PREFIX) + r'.*$', lambda _: line, text, count=1, flags=re.M)
        if re.search(r'^- Work ref:.*$', text, re.M):
            return re.sub(r'^(- Work ref:.*)$', lambda match: match.group(1) + '\n' + line, text, count=1, flags=re.M)
        return None
    # 다른 스크립트(commit.sh 등)가 같은 계획서를 고치는 중일 수 있다 — 잠금 안에서 지금 내용을 다시 읽어 이 줄만 바꾼다(scripts/lib/plan_update.py)
    update_plan(path, record)


def is_hermes_session(payload: dict) -> bool:
    if os.environ.get('ATHENA_AGENT'):
        return True
    return pathlib.Path(payload.get('cwd') or os.getcwd()).resolve() == ATHENA_DIR


def is_lead() -> bool:
    """아테나(리드) 세션 — 위임 에이전트는 delegate.sh 가 ATHENA_AGENT 를 넘긴다(pane-session.py 의 role 과 같은 규칙)"""
    return not os.environ.get('ATHENA_AGENT')


def lead_log_file() -> pathlib.Path:
    """리드 기록 자리 — scripts/lead-log.mjs leadLogFile 과 같다(여러 팩이면 팩 데이터 state/, 옛 구조면 본체)"""
    where = athena_config.paths(str(ATHENA_DIR))
    if where['mode'] == 'packs':
        return pathlib.Path(where['state']) / 'lead-log.md'
    return ATHENA_DIR / '.lead-log.md'


def lead_log_note() -> str:
    """압축 뒤 아테나가 먼저 읽을 리드 기록 최근 줄(없으면 적는 법 한 줄)"""
    file = lead_log_file()
    try:
        lines = [line for line in file.read_text(encoding='utf-8').splitlines() if line.startswith('- ')]
    except OSError:
        lines = []
    add = f'node {shlex.quote(str(ATHENA_DIR / "scripts/lead-log.mjs"))} <정정|실패|사실|결정> "<한 줄>"'
    if not lines:
        return f'📝 리드 기록({file})은 아직 비었다 — 사용자 정정 · 실패 원인 · 확인한 사실 · 결정이 생기면 그때 {add} 로 한 줄씩 적는다.'
    recent = '\n'.join(lines[-LEAD_LOG_TAIL:])
    return (f'📝 리드 기록({file}) 최근 {min(len(lines), LEAD_LOG_TAIL)}줄 — 요약에서 빠졌을 수 있는 정정 · 결정이니 계획서보다 먼저 읽는다'
            f'(새로 생기면 {add}):\n{recent}')


def codex_home() -> pathlib.Path:
    return pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')


def codex_rollout(payload: dict) -> str:
    """Codex 대화 기록(rollout jsonl) 자리 — 훅 입력 transcript_path 가 먼저, 없으면 세션 id 가 이름 끝에 든 파일(가장 최근)"""
    given = str(payload.get('transcript_path') or '')
    if given and os.path.isfile(given):
        return given
    session = str(payload.get('session_id') or '')
    if not CODEX_SESSION_ID.match(session):
        return ''
    found = sorted((codex_home() / 'sessions').glob(f'*/*/*/rollout-*-{session}.jsonl'), key=lambda path: path.stat().st_mtime, reverse=True)
    return str(found[0]) if found else ''


def transcript_of(payload: dict, codex: bool) -> str:
    if codex:
        return codex_rollout(payload)
    return str(payload.get('transcript_path') or '')


def transcript_note(payload: dict, codex: bool = False) -> str:
    """대화 원문 자리 — 압축해도 기록 파일(훅 입력 transcript_path · Codex 는 rollout)에는 원문이 남는다(scripts/transcript-search.mjs)"""
    path = transcript_of(payload, codex)
    if not path:
        return ''
    search = f'node {shlex.quote(str(ATHENA_DIR / "scripts/transcript-search.mjs"))} {shlex.quote(path)} <낱말…>'
    return f'대화 원문: {path} — 요약에 없는 사실은 짐작하지 말고 {search} 로 원문에서 찾는다.'


def human_text(text: str) -> str:
    """사람이 친 글만 남긴다 — 태그로 시작하는 글(`<system-reminder>` · `<command-name>` …) · Codex 지시문은 '',
    pane 알림(`[… → …]`)은 그 앞까지(사용자 글 뒤에 알림이 붙어 들어온 기록이 있다 — 2026-11-07 c5d6cf73), 이미지 자리 표시는 지운다"""
    text = text.strip()
    if not text or text.startswith('<') or text.startswith(CODEX_INJECTED):
        return ''
    notice = PANE_NOTICE.search(text)
    if notice:
        text = text[:notice.start()]
    return IMAGE_MARK.sub('', text).strip()


def claude_user_words(entry: dict):
    """Claude 기록 한 줄이 사람이 친 말이면 (시각, 글) — 아니면 None.
    사람 말: type user · isMeta · isCompactSummary · isSidechain 아님 · origin 이 있으면 kind human(2026-11-07 Claude Code 기록 — task-notification 은 다른 kind) ·
    도구 결과(tool_result)가 아닌 글 조각"""
    if entry.get('type') != 'user' or entry.get('isMeta') or entry.get('isCompactSummary') or entry.get('isSidechain'):
        return None
    origin = entry.get('origin')
    if isinstance(origin, dict) and origin.get('kind') != 'human':
        return None
    message = entry.get('message')
    content = message.get('content') if isinstance(message, dict) else None
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(block, dict) and block.get('type') == 'tool_result' for block in content):
            return None
        text = ' '.join(block['text'] for block in content
                        if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str))
    else:
        return None
    text = human_text(text)
    return (str(entry.get('timestamp') or ''), text) if text else None


def codex_user_words(entry: dict):
    """Codex 기록 한 줄이 사람이 친 말이면 (시각, 글) — response_item · message · role user 의 input_text(2026-11-03 codex-tui 0.166 기록).
    압축 줄(compacted)의 replacement_history 는 앞 원문의 사본이라 보지 않는다(원문 줄이 기록에 그대로 있다)"""
    payload = entry.get('payload')
    if entry.get('type') != 'response_item' or not isinstance(payload, dict) or payload.get('type') != 'message' or payload.get('role') != 'user':
        return None
    content = payload.get('content')
    blocks = content if isinstance(content, list) else []
    texts = [human_text(block['text']) for block in blocks if isinstance(block, dict) and isinstance(block.get('text'), str)]
    text = ' '.join(piece for piece in texts if piece)
    return (str(entry.get('timestamp') or ''), text) if text else None


def recent_user_words(transcript_path: str, parse, count: int) -> list:
    """기록(jsonl) 끝에서 거꾸로 읽어 사람이 친 말 (시각, 글) 최근 count 개 — 오래된 것부터. 같은 글이 거듭되면(이어 붙인 세션 사본) 최근 것 하나"""
    found = []
    seen = set()
    try:
        with open(transcript_path, 'rb') as stream:
            stream.seek(0, os.SEEK_END)
            end = stream.tell()
            buffer = b''
            position = end
            while position > 0 and end - position < TRANSCRIPT_TAIL_LIMIT and len(found) < count:
                step = min(256 * 1024, position)
                position -= step
                stream.seek(position)
                buffer = stream.read(step) + buffer
                lines = buffer.split(b'\n')
                # 맨 앞 조각은 줄 중간일 수 있다 — 처음까지 읽은 때만 쓴다
                complete = lines if position == 0 else lines[1:]
                for raw in reversed(complete):
                    if b'"user"' not in raw:
                        continue
                    try:
                        entry = json.loads(raw)
                    except ValueError:
                        continue
                    words = parse(entry) if isinstance(entry, dict) else None
                    if not words or words[1] in seen:
                        continue
                    seen.add(words[1])
                    found.append(words)
                    if len(found) >= count:
                        break
                buffer = lines[0] if position > 0 else b''
    except OSError:
        return []
    return list(reversed(found))


def local_stamp(value: str) -> str:
    """기록 시각(UTC ISO)을 이 맥 시각 `YYYY-MM-DD HH:MM` 으로 — scripts/transcript-search.mjs localTime 과 같다"""
    try:
        moment = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return '?'
    if moment.tzinfo is None:
        return '?'
    return moment.astimezone().strftime('%Y-%m-%d %H:%M')


def clip(text: str, limit: int) -> str:
    flat = re.sub(r'\s+', ' ', text).strip()
    return flat if len(flat) <= limit else flat[:limit - 1] + '…'


def user_words_note(payload: dict, codex: bool) -> str:
    """최근 사용자 말 원문 묶음 — 압축 요약이 빠뜨린 정정 · 지시를 다시 본다. 못 읽거나 없으면 ''"""
    path = transcript_of(payload, codex)
    if not path:
        return ''
    words = recent_user_words(path, codex_user_words if codex else claude_user_words, USER_WORDS_COUNT)
    lines = []
    used = 0
    # 최근 것부터 담고 전체 상한을 넘으면 거기서 멈춘다(오래된 것이 빠진다)
    for stamp, text in reversed(words):
        line = f'- {local_stamp(stamp)} {clip(text, USER_WORD_LIMIT)}'
        if used + len(line) > USER_WORDS_TOTAL:
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ''
    return (f'💬 최근 사용자 말 원문 {len(lines)}개(오래된 것부터 · pane 알림 · 도구 결과 빼고) — 요약이 빠뜨린 정정 · 지시가 있으면 이것이 먼저다:\n'
            + '\n'.join(reversed(lines)))


def open_requests_note() -> str:
    """아테나 세션의 열린 [작업] 요청(bin/athena request list — open · answered). 못 읽으면 ''"""
    try:
        done = subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'athena.mjs'), 'request', 'list', '--json'], cwd=str(ATHENA_DIR),
                              capture_output=True, text=True, timeout=LOOKUP_TIMEOUT)
        requests = json.loads(done.stdout).get('requests') if done.returncode == 0 else None
    except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
        return ''
    if not isinstance(requests, list):
        return ''
    if not requests:
        return '📮 열린 [작업] 요청: 없음'
    lines = []
    for request in requests[-LIVE_LIST_COUNT:]:
        if not isinstance(request, dict):
            continue
        where = f' · pane {request["pane"]}' if request.get('pane') else ''
        lines.append(clip(f'- {request.get("id")} · {request.get("kind")} · {request.get("state")}{where} — {request.get("title") or ""}', LIVE_LINE_LIMIT))
    more = f'(최근 {len(lines)}개 · 전체 {len(requests)}개)' if len(requests) > len(lines) else f'{len(lines)}개'
    return f'📮 열린 [작업] 요청 {more} — 답을 기다리거나 받은 것:\n' + '\n'.join(lines)


def agent_panes_note(self_pane: str) -> str:
    """살아 있는 에이전트 pane(화면 계층 — scripts/lib/screen.py list_panes · 에이전트가 도는 것만 · 이 pane 은 뺀다). 못 읽으면 ''"""
    try:
        panes = screen.list_panes(timeout=LOOKUP_TIMEOUT)
    except Exception:
        return ''
    if not isinstance(panes, list):
        return ''
    alive = [pane for pane in panes if isinstance(pane, dict) and pane.get('agent') and pane.get('id') != self_pane]
    if not alive:
        return '🧩 살아 있는 에이전트 pane: 없음'
    lines = [clip(f'- {pane.get("id")} · {pane.get("agent_status") or "?"} · {pane.get("label") or pane.get("title") or ""}', LIVE_LINE_LIMIT)
             for pane in alive[:LIVE_LIST_COUNT]]
    more = f'(앞 {len(lines)}개 · 전체 {len(alive)}개)' if len(alive) > len(lines) else f'{len(lines)}개'
    return f'🧩 살아 있는 에이전트 pane {more} — pane id · 상태 · 이름표:\n' + '\n'.join(lines)


def mask(text: str) -> str:
    """비밀값 가리기 — 규칙 정본 scripts/lib/mask.mjs maskText(scripts/lib/pane_request.py mask 와 같은 방식). 가리지 못하면 ''(싣지 않는다)"""
    script = ('const { maskText } = await import(process.argv[1]); let text = ""; for await (const chunk of process.stdin) text += chunk; '
              'process.stdout.write(maskText(text))')
    try:
        done = subprocess.run(['node', '--input-type=module', '-e', script, str(ATHENA_DIR / 'scripts' / 'lib' / 'mask.mjs')],
                              input=text, capture_output=True, text=True, timeout=LOOKUP_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return done.stdout if done.returncode == 0 else ''


def on_pre(payload: dict) -> None:
    plans, _ = find_plans(screen.self_info()['pane_id'])
    for path, text in plans:
        write_snapshot(path, snapshot_line(work_dir_for(text, payload), payload.get('trigger') or '?'))


def resume_message(plans: list, led: bool) -> str:
    """압축 뒤 다시 읽을 안내 — 일하는 pane 은 계획서 하나, 아테나 pane 은 묶인 계획서 목록"""
    if not led:
        path, text = plans[0]
        snapshot = re.search(r'^' + re.escape(SNAPSHOT_PREFIX) + r'\s*(.*)$', text, re.M)
        message = (
            f'🔄 방금 대화가 압축됐다. 압축 요약만 믿지 말고 이 pane 의 계획서 {path} 의 Checkpoint'
            '(Status · Progress · Next · Blocked · Validation)와 "## 지시" 절을 먼저 다시 읽는다. '
            'Work ref 의 트리에서 git status 로 현재 상태를 확인하고, Checkpoint 와 다르면 그 차이부터 평가한 뒤 Next 부터 이어 간다'
            '(AGENTS.md 2.6 — 바뀐 ref 에서 과거 검증 결과를 현재 통과로 재사용하지 않는다).'
        )
        if snapshot:
            message += f' 압축 직전 자동 기록: {snapshot.group(1)}'
    else:
        listed = ', '.join(f'{path.relative_to(ATHENA_DIR)}(Status {plan_status(text) or "?"})' for path, text in plans)
        message = (
            '🔄 방금 대화가 압축됐다. 압축 요약만 믿지 말고 이 아테나 pane 이 다루던 계획서의 Checkpoint'
            '(Status · Progress · Next · Blocked)와 "## 지시" 절을 다시 읽고, 맡긴 pane 의 현재 상태를 확인한 뒤 이어 간다'
            f'(AGENTS.md 2.6). 최근에 고친 순: {listed}'
        )
    issues = linked_issues(plans)
    if issues:
        message += f' — 묶인 이슈도 다시 읽는다: {", ".join(issues)}'
    return message


def recall_notes(payload: dict, codex: bool, self_pane: str) -> str:
    """압축 요약이 빠뜨린 것을 원문으로 — 최근 사용자 말, 아테나 세션이면 열린 요청 · 에이전트 pane. 비밀값은 가린 뒤(못 가리면 싣지 않는다)"""
    notes = [user_words_note(payload, codex)]
    if is_lead():
        notes += [open_requests_note(), agent_panes_note(self_pane)]
    text = '\n\n'.join(note for note in notes if note)
    return mask(text).strip() if text else ''


def on_post(payload: dict, reread: list, codex: bool = False) -> None:
    if payload.get('source') not in (None, 'compact'):
        return
    clear_warn_mark(payload)
    self_pane = screen.self_info()['pane_id']
    plans, led = find_plans(self_pane)
    if plans:
        message = resume_message(plans, led)
    elif is_hermes_session(payload):
        candidates = [str(path.relative_to(ATHENA_DIR)) for path, _ in active_plans()[:5]]
        message = (
            '🔄 방금 대화가 압축됐다. 이 pane 에 묶인 계획서를 찾지 못했다. 진행 중이던 작업이 있으면 그 계획서 Checkpoint 부터 '
            '다시 읽고 이어 간다(AGENTS.md 2.6). 어느 계획서인지 모르면 사용자에게 묻는다. '
            f'최근 진행 중 계획서: {", ".join(candidates) if candidates else "없음"}'
        )
    else:
        message = ''
    # 상한을 넘어 전문을 싣지 못한 레포 규칙 문서 — 읽은 내용이 압축으로 사라졌다(agent-context.py 가 경로를 넘긴다)
    if reread:
        message = f'{message} 레포 규칙 문서 다시 읽기: {", ".join(reread)}'.strip()
    if not message:
        return
    original = transcript_note(payload, codex)
    if original:
        message = f'{message} {original}'
    if is_lead():
        message = f'{lead_log_note()}\n\n{message}'
    recall = recall_notes(payload, codex, self_pane)
    if recall:
        message = f'{message}\n\n{recall}'
    if len(message) > POST_MESSAGE_LIMIT:
        message = message[:POST_MESSAGE_LIMIT - 1] + '…'
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': message}}, ensure_ascii=False))


def parse_window(value) -> int:
    """압축 창 값(200000 · "200k" · "1M" · 줄여 쓴 "200" = 200k)을 토큰 수로. auto · 읽지 못하는 값은 0(알리지 않는다)"""
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else 0
    match = re.fullmatch(r'\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM]?)\s*', str(value or ''))
    if not match:
        return 0
    number = float(match.group(1))
    unit = match.group(2).lower()
    if unit == 'k':
        return int(number * 1000)
    if unit == 'm':
        return int(number * 1000 * 1000)
    # Claude Code /autocompact 안내의 줄여 쓰기("200 as shorthand") — 1000 아래 맨 숫자는 천 단위
    return int(number * 1000) if number < 1000 else int(number)


def claude_compact_point(window: int) -> int:
    """압축 창에서 Claude Code 가 실제로 압축하는 토큰 수. 창을 모르거나 너무 작으면 0(알리지 않는다)"""
    point = window - CLAUDE_OUTPUT_RESERVE - CLAUDE_SUMMARY_RESERVE
    return point if window > 0 and point > 0 else 0


def compact_window() -> int:
    """이 세션의 압축 창 — 환경 변수 CLAUDE_CODE_AUTO_COMPACT_WINDOW 가 먼저, 없으면 본체 .claude/settings.json autoCompactWindow
    (아테나 세션은 프로젝트 설정 · 위임 pane 은 delegate.sh 가 같은 값을 --settings 로 넣는다 — agent_hooks.auto_compact_window)"""
    env_value = os.environ.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '').strip()
    if env_value:
        return parse_window(env_value)
    try:
        settings = json.loads((ATHENA_DIR / '.claude' / 'settings.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return 0
    return parse_window(settings.get('autoCompactWindow'))


def usage_tokens(entry: dict) -> int:
    """대화 기록 한 줄이 본 대화(sidechain 아님)의 응답이면 그때 문맥 크기 — Claude Code 상태줄 total_input_tokens 와 같은 셈
    (input + cache_creation + cache_read). 아니면 -1"""
    if entry.get('type') != 'assistant' or entry.get('isSidechain') or entry.get('isApiErrorMessage'):
        return -1
    message = entry.get('message')
    usage = message.get('usage') if isinstance(message, dict) else None
    if not isinstance(usage, dict):
        return -1
    total = sum(usage.get(key) or 0 for key in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
    # 합성 응답(모델 <synthetic> 등)은 usage 가 0 — 문맥 크기로 치지 않는다
    return total if total > 0 else -1


def context_tokens(transcript_path: str) -> int:
    """대화 기록(jsonl) 끝에서 거꾸로 읽어 마지막 응답의 문맥 크기. 못 읽으면 -1"""
    return last_from_tail(transcript_path, b'"usage"', usage_tokens)


def codex_usage_tokens(entry: dict) -> int:
    """Codex 기록 한 줄이 token_count 면 그때 문맥 크기(last_token_usage.total_tokens — 압축 직전 줄이 압축 기준을 넘는 값). 아니면 -1"""
    payload = entry.get('payload')
    if entry.get('type') != 'event_msg' or not isinstance(payload, dict) or payload.get('type') != 'token_count':
        return -1
    info = payload.get('info')
    last = info.get('last_token_usage') if isinstance(info, dict) else None
    total = last.get('total_tokens') if isinstance(last, dict) else None
    return total if isinstance(total, int) and not isinstance(total, bool) and total > 0 else -1


def codex_model(entry: dict) -> str:
    """Codex 기록 한 줄이 turn_context 면 그 차례의 모델 이름. 아니면 ''(last_from_tail 이 건너뛴다)"""
    payload = entry.get('payload')
    if entry.get('type') != 'turn_context' or not isinstance(payload, dict):
        return ''
    return str(payload.get('model') or '')


def codex_config() -> dict:
    """$CODEX_HOME/config.toml 에서 압축 기준에 닿는 값만 — 맨 위(표 머리 전) `키 = 값` 은 정수면 int · 그 밖은 따옴표를 뗀 글자,
    `[features]` 의 token_budget 이 꺼짐(false)이 아니면 'features.token_budget' = True(python 3.9 라 tomllib 이 없다 · 값은 출력하지 않는다)"""
    try:
        text = (codex_home() / 'config.toml').read_text(encoding='utf-8')
    except OSError:
        return {}
    found = {}
    table = ''
    for line in text.splitlines():
        header = re.match(r'^\s*\[\s*([^\]]+?)\s*\]', line)
        if header:
            table = header.group(1)
            if table == 'features.token_budget':
                found['features.token_budget'] = True
            continue
        match = re.match(r'^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$', line)
        if not match:
            continue
        key, value = match.group(1), match.group(2)
        if table == 'features':
            if key == 'token_budget' and value != 'false':
                found['features.token_budget'] = True
            continue
        if table:
            continue
        number = value.replace('_', '')
        found[key] = int(number) if number.isdigit() else value.strip('"\'')
    return found


def codex_model_entry(model: str) -> dict:
    """models_cache.json 의 그 모델 항목(못 찾으면 {})"""
    if not model:
        return {}
    try:
        cache = json.loads((codex_home() / 'models_cache.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    models = cache.get('models') if isinstance(cache, dict) else None
    for entry in models if isinstance(models, list) else []:
        if isinstance(entry, dict) and entry.get('slug') == model:
            return entry
    return {}


def positive_int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def codex_compact_limit(model: str) -> int:
    """Codex 압축 기준(토큰) — codex-cli 0.166.0 소스(rust-v0.166.0) 그대로. 셈이 소스로 정해지지 않는 설정이면 0(알리지 않는다)
      창 = 설정 model_context_window(모델 max_context_window 로 자름) → 모델 context_window → max_context_window
           (models-manager/src/model_info.rs:20-28 · protocol/src/openai_models.rs:523-525)
      기준 = min(설정 model_auto_compact_token_limit → 모델 auto_compact_token_limit, 창 × 9 / 10)
           (model_info.rs:29-31 · openai_models.rs:534-546)
      턴 끝 압축 — 설정 model_post_turn_compact_threshold_percent(기본 0)가 있으면 창 × effective_context_window_percent(기본 95) / 100 × 그 % 에서도
           (core/src/session/context_window.rs:84-86 · 111-117)
      알리지 않는 것 — model_auto_compact_token_limit_scope 가 total(기본) 이 아니면(앞부분을 뺀 토큰으로 세는데 그 앞부분 크기는 기록에 없다 · context_window.rs:61-81),
           features.token_budget 이 켜져 있으면(기준에 여유 토큰이 더해질 수 있다 · context_window.rs:97-103 · session/token_budget.rs:81-120)"""
    config = codex_config()
    if config.get('features.token_budget'):
        return 0
    if str(config.get('model_auto_compact_token_limit_scope', 'total')) != 'total':
        return 0
    entry = codex_model_entry(model)
    if not entry:
        return 0
    max_window = positive_int(entry.get('max_context_window'))
    window = positive_int(config.get('model_context_window'))
    if window and max_window:
        window = min(window, max_window)
    window = window or positive_int(entry.get('context_window')) or max_window
    configured = positive_int(config.get('model_auto_compact_token_limit')) or positive_int(entry.get('auto_compact_token_limit'))
    if not window:
        return configured
    limit = window * 9 // 10
    if configured:
        limit = min(configured, limit)
    percent = positive_int(config.get('model_post_turn_compact_threshold_percent'))
    if percent:
        effective = positive_int(entry.get('effective_context_window_percent')) or 95
        limit = min(limit, window * effective // 100 * percent // 100)
    return limit


def last_from_tail(transcript_path: str, needle: bytes, parse, empty=-1):
    """기록(jsonl) 끝에서 거꾸로 읽어 needle 이 든 줄 중 parse 가 empty 아닌 값을 낸 마지막 것. 못 찾으면 empty"""
    try:
        with open(transcript_path, 'rb') as stream:
            stream.seek(0, os.SEEK_END)
            end = stream.tell()
            chunk = 256 * 1024
            buffer = b''
            position = end
            while position > 0 and end - position < TRANSCRIPT_TAIL_LIMIT:
                step = min(chunk, position)
                position -= step
                stream.seek(position)
                buffer = stream.read(step) + buffer
                lines = buffer.split(b'\n')
                # 맨 앞 조각은 줄 중간일 수 있다 — 처음까지 읽은 때만 쓴다
                complete = lines if position == 0 else lines[1:]
                for raw in reversed(complete):
                    if needle not in raw:
                        continue
                    try:
                        entry = json.loads(raw)
                        value = parse(entry) if isinstance(entry, dict) else empty
                    except ValueError:
                        continue
                    if value != empty:
                        return value
                buffer = lines[0] if position > 0 else b''
    except OSError:
        return empty
    return empty


def warn_mark(payload: dict):
    session = re.sub(r'[^\w.-]', '_', str(payload.get('session_id') or ''))
    return WARN_MARK_DIR / session if session else None


def clear_warn_mark(payload: dict) -> None:
    mark = warn_mark(payload)
    if mark:
        try:
            mark.unlink()
        except OSError:
            pass


def claude_context_now(payload: dict) -> int:
    """Claude 의 지금 문맥 토큰 — 못 읽으면 -1. 도구 뒤(tool_use_id 가 있다)인데 기록에 응답이 아직 없으면(세션 첫 응답) 잠깐 기다려 다시 읽는다"""
    transcript_path = str(payload.get('transcript_path') or '')
    tokens = context_tokens(transcript_path)
    if tokens >= 0 or not payload.get('tool_use_id') or not os.path.isfile(transcript_path):
        return tokens
    deadline = time.monotonic() + FIRST_WRITE_WAIT
    while tokens < 0 and time.monotonic() < deadline:
        time.sleep(FIRST_WRITE_STEP)
        tokens = context_tokens(transcript_path)
    return tokens


def codex_context_now(payload: dict):
    """Codex 의 (지금 문맥 토큰, 압축 기준) — 못 읽으면 (-1, 0)"""
    rollout = codex_rollout(payload)
    if not rollout:
        return -1, 0
    model = str(payload.get('model') or '') or last_from_tail(rollout, b'"turn_context"', codex_model, '')
    return last_from_tail(rollout, b'"token_count"', codex_usage_tokens), codex_compact_limit(model)


def on_warn(payload: dict, codex: bool = False) -> None:
    # 하위 에이전트(Task)의 훅은 본 대화 문맥이 아니다
    if payload.get('agent_id'):
        return
    mark = warn_mark(payload)
    if not mark:
        return
    if codex:
        tokens, window = codex_context_now(payload)
    else:
        window = claude_compact_point(compact_window())
        tokens = claude_context_now(payload) if window > 0 else -1
    # window 는 여기서부터 실제 압축 기준(토큰)
    if window <= 0 or tokens < 0:
        return
    if tokens * 100 < window * WARN_PERCENT:
        # 압축(직후 훅이 못 돌았어도)으로 문맥이 줄었으면 다음에 다시 알린다
        clear_warn_mark(payload)
        return
    if mark.exists():
        return
    try:
        WARN_MARK_DIR.mkdir(parents=True, exist_ok=True)
        mark.touch()
    except OSError:
        return
    percent = int(tokens * 100 / window)
    event = payload.get('hook_event_name') or 'PostToolUse'
    # 아테나는 정정 · 실패 원인 · 확인한 사실 · 결정을 리드 기록에도(scripts/lead-log.mjs)
    where = '계획서 Checkpoint(Progress · Next · Blocked)나 이슈'
    if is_lead():
        where = (f'리드 기록(node {shlex.quote(str(ATHENA_DIR / "scripts/lead-log.mjs"))} <정정|실패|사실|결정> "<한 줄>" — {lead_log_file()})'
                 f'과 {where}')
    # 할 일을 맨 앞에 시키는 말로 — 사용자 글 뒤에 붙는 Codex 는 "적기만" 을 뒤로 미뤄 끝내 적지 않았다(2026-11-06 시험)
    context = (
        f'⚠️ 곧 대화가 압축된다 — 문맥 {tokens:,} 토큰 · 압축 기준 {window:,} 의 {percent}%. '
        f'이번 턴에서 답하기 전에 먼저, 이번 대화에서 알게 된 사실 · 정한 것 · 다음 할 일을 {where}에 적는다. '
        '압축되면 요약만 남아 적지 않은 것은 사라진다. 적은 뒤 하던 일을 이어 가고, 이 알림 자체는 사용자에게 말하지 않는다.'
    )
    # 모델에게만 — 사용자 화면 줄(systemMessage)은 내지 않는다
    print(json.dumps({'hookSpecificOutput': {'hookEventName': event, 'additionalContext': context}}, ensure_ascii=False))


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    codex = '--tool=codex' in sys.argv[2:]
    rest = [arg for arg in sys.argv[2:] if arg != '--tool=codex']
    payload = read_payload()
    if mode == 'pre':
        on_pre(payload)
    elif mode == 'post':
        on_post(payload, rest, codex)
    elif mode == 'warn':
        on_warn(payload, codex)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
