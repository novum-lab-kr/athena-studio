#!/usr/bin/env python3
"""계획서 칸 자동 기록 — 스크립트가 아는 사실을 에이전트가 다시 쓰지 않게 한다(검증 → Validation 한 줄 · 커밋 → Status).

python3 plan_autofill.py resolve <본체> <환경 ATHENA_PLAN>        → 지금 이 pane 의 계획서(논리 경로) 출력
python3 plan_autofill.py validation <본체> <계획서> <한 줄>        → Validation 절에 덧붙인다(같은 레포 · sha · 결과가 바로 위면 안 적는다)
python3 plan_autofill.py status <본체> <계획서>                    → in_progress · planned 면 ready_for_review 로 바꾸고 옛 값 출력(안 바꾸면 출력 없음)
"""
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from plan_update import update_plan  # noqa: E402

VALIDATION_HEAD = re.compile(r'^(#{2,3}) Validation[ \t]*$', re.M)
CHECKPOINT_HEAD = re.compile(r'^## Checkpoint[ \t]*$', re.M)
STATUS_LINE = re.compile(r'^- Status:[ \t]*(\S+)[ \t]*$', re.M)
PLACEHOLDER = re.compile(r'^- (?:\(검증 스크립트 출력 표[^\n]*|실행한 검증 / 결과 / 대상 SHA 또는 diff 상태|미실행 검증과 이유)[ \t]*\n', re.M)   # 템플릿의 자리 표시 줄
DEDUP_KEY = re.compile(r'^- \d{4}-\d\d-\d\d \d\d:\d\d (\S+ @\S+ (?:통과|실패 \d+)) ')   # 시각만 다른 같은 결과


def section_end(text, start, level):
    """start 뒤에서 level 이하 제목이 처음 나오는 자리(없으면 문서 끝)"""
    following = re.compile(r'^#{1,%d} ' % level, re.M).search(text, start)
    return following.start() if following else len(text)


def with_validation_line(text, line):
    """Validation 절 끝에 한 줄을 더한 글(같은 결과가 바로 위면 그대로). 절이 없으면 Checkpoint 끝(없으면 문서 끝)에 만든다 — red-check.mjs 와 같은 자리"""
    head = VALIDATION_HEAD.search(text)
    if not head:
        checkpoint = CHECKPOINT_HEAD.search(text)
        at = section_end(text, checkpoint.end(), 2) if checkpoint else len(text)
        before = text[:at].rstrip('\n')
        after = text[at:]
        return f"{before}\n\n### Validation\n{line}\n" + (f"\n{after}" if after else '')
    end = section_end(text, head.end(), len(head.group(1)))
    body = PLACEHOLDER.sub('', text[head.end():end]).rstrip()
    rows = body.splitlines()
    last = rows[-1] if rows else ''
    new_key, last_key = DEDUP_KEY.match(line), DEDUP_KEY.match(last)
    if new_key and last_key and new_key.group(1) == last_key.group(1):
        return text
    gap = '\n' if last.startswith('|') else ''   # 표 바로 밑에 붙으면 표의 칸으로 읽힌다
    return f"{text[:head.end()]}{body}\n{gap}{line}\n\n{text[end:]}".rstrip('\n') + '\n'


def with_ready_status(text):
    """(바꾼 글, 옛 Status). Checkpoint 의 Status 가 in_progress · planned 일 때만 바꾼다"""
    checkpoint = CHECKPOINT_HEAD.search(text)
    start = checkpoint.end() if checkpoint else 0
    end = section_end(text, start, 2) if checkpoint else len(text)
    found = STATUS_LINE.search(text, start, end)
    if not found or found.group(1) not in ('in_progress', 'planned'):
        return text, None
    return f"{text[:found.start()]}- Status: ready_for_review{text[found.end():]}", found.group(1)


def current_plan(athena, env_plan, pane):
    """이어 보낸 pane(delegate.sh --reuse-pane)의 환경 값은 처음 계획서다 — pane 기록의 envPlan 과 같으면 기록의 plan 이 지금 계획서다(reuse_link.py)"""
    pack_data = pathlib.Path(athena) / '.pack-data'
    if not pane or not pack_data.is_symlink():
        return env_plan
    try:
        record = json.loads((pack_data.resolve() / 'state' / 'pane-sessions' / f'{pane}.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return env_plan
    if record.get('envPlan') == env_plan and record.get('plan'):
        return record['plan']
    return env_plan


def main(argv):
    command, athena, plan = argv[:3]
    if command == 'resolve':
        try:
            import screen
            pane = str(screen.self_info().get('pane_id') or '')
        except Exception:   # 화면 밖 · 옛 코어 — 환경 값 그대로
            pane = ''
        print(current_plan(athena, plan, pane))
        return 0
    path = pathlib.Path(athena) / plan
    if not path.is_file():
        return 0   # 다른 본체의 계획서 · 보관함으로 옮겨진 계획서는 적지 않는다
    if command == 'validation':
        update_plan(path, lambda text: with_validation_line(text, argv[3]))
        return 0
    if command == 'status':
        previous = []
        def change(text):
            updated, old = with_ready_status(text)
            if old:
                previous.append(old)
            return updated
        update_plan(path, change)
        if previous:
            print(previous[0])
        return 0
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
