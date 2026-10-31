#!/usr/bin/env python3
"""대화 압축 전후 Checkpoint 훅 (Claude Code PreCompact · SessionStart[compact]).

대화가 압축되면 진행 상황이 요약에만 남는다. 진행 상황의 정본은 계획서 Checkpoint 다(AGENTS.md 2.6).
  pre  — 압축 직전(PreCompact): 이 pane 에 묶인 계획서 Checkpoint 에 기계적으로 알 수 있는 상태
         (시각 · 브랜치 · HEAD · 미커밋 파일)를 `- Auto snapshot:` 한 줄로 갱신한다. Claude 가 쓰지 않아도 남는다
  post — 압축 직후(SessionStart, source=compact): "요약만 믿지 말고 계획서 Checkpoint 부터 다시 읽어라" 를
         계획서 경로·스냅샷과 함께 대화 맨 앞에 넣는다

계획서 찾기 — 이 pane(화면 계층 self — scripts/lib/screen.py)이 적힌 계획서: Checkpoint `- Work ref: … pane <id>` · `- Review: … pane <id>`
(delegate.sh 가 적는다) 또는 정식 계획서 html 의 `"leadPane": "<id>"`(옛 계획서는 `hermesPane`). 여럿이면 가장 최근에 고친 것. 끝난(done) 계획서는 뺀다.
못 찾으면 pre 는 아무것도 쓰지 않고, post 는 진행 중 계획서 후보만 알린다(아테나 세션·FE pane 에서만).
압축·세션 시작을 막거나 늦추지 않는다(항상 exit 0).

사용: compact-checkpoint.py pre | post [다시 읽을 레포 규칙 문서 경로…]   (hook 입력 JSON 은 stdin)
"""
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
from plan_update import update_plan  # noqa: E402 — 경로를 넣은 뒤에 읽는다
import screen  # noqa: E402
PLANS_DIR = ATHENA_DIR / 'plans'
SNAPSHOT_PREFIX = '- Auto snapshot:'
MAX_LISTED_FILES = 8


def read_payload() -> dict:
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def plan_status(text: str) -> str:
    match = re.search(r'^- Status:\s*(.*)$', text, re.M)
    return match.group(1).strip() if match else ''


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
        if plan_status(text).startswith('done'):
            continue
        found.append((path, text))
    found.sort(key=lambda item: item[0].stat().st_mtime, reverse=True)
    return found


def find_plan(pane_id: str):
    if not pane_id:
        return None
    pane_pattern = re.compile(r'^- (?:Work ref|Review):.*\bpane ' + re.escape(pane_id) + r'(?![\w:])', re.M)
    # leadPane — 이름 변경(2026-10) 전 계획서는 hermesPane
    html_needles = (f'"leadPane": "{pane_id}"', f'"hermesPane": "{pane_id}"')
    for path, text in active_plans():
        if pane_pattern.search(text):
            return path, text
        html_path = path.with_suffix('.html')
        try:
            if html_path.is_file() and any(needle in html_path.read_text(encoding='utf-8') for needle in html_needles):
                return path, text
        except OSError:
            continue
    return None


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


def on_pre(payload: dict) -> None:
    found = find_plan(screen.self_info()['pane_id'])
    if not found:
        return
    path, text = found
    write_snapshot(path, snapshot_line(work_dir_for(text, payload), payload.get('trigger') or '?'))


def on_post(payload: dict, reread: list) -> None:
    if payload.get('source') not in (None, 'compact'):
        return
    found = find_plan(screen.self_info()['pane_id'])
    if found:
        path, text = found
        snapshot = re.search(r'^' + re.escape(SNAPSHOT_PREFIX) + r'\s*(.*)$', text, re.M)
        message = (
            f'🔄 방금 대화가 압축됐다. 압축 요약만 믿지 말고 이 pane 의 계획서 {path} 의 Checkpoint'
            '(Status · Progress · Next · Blocked · Validation)와 "## 지시" 절을 먼저 다시 읽는다. '
            'Work ref 의 트리에서 git status 로 현재 상태를 확인하고, Checkpoint 와 다르면 그 차이부터 평가한 뒤 Next 부터 이어 간다'
            '(AGENTS.md 2.6 — 바뀐 ref 에서 과거 검증 결과를 현재 통과로 재사용하지 않는다).'
        )
        if snapshot:
            message += f' 압축 직전 자동 기록: {snapshot.group(1)}'
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
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': message}}, ensure_ascii=False))


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    payload = read_payload()
    if mode == 'pre':
        on_pre(payload)
    elif mode == 'post':
        on_post(payload, sys.argv[2:])


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
