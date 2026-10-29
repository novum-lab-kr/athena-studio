#!/usr/bin/env python3
"""에이전트의 AskUserQuestion 을 사람에게 묻는 요청으로 바꾸는 훅 (Claude Code PreToolUse · AskUserQuestion) — delegate.sh · agent-context.py 가 에이전트 세션에 건다.

왜: 위임 에이전트가 pane 안에서 고르기 창(AskUserQuestion)으로 물으면 요청이 열리지 않아 스튜디오 [작업] 에 질문이 안 올라온다(2026-10-29).
무엇을: 질문마다 `bin/athena request open --kind question` 을 열고(계획서 = ATHENA_PLAN · pane = 부른 pane) 도구는 막는다.
  돌려주는 안내(permissionDecisionReason)가 에이전트에게 간다 — 답은 `[요청 <id>] … 답:` 으로 이 pane 에 오고, 받으면 request ack.
요청 형식이 못 담는 것: 여러 개 고르기(multiSelect)는 단일 선택 + 메모로(본문에 안내), 선택지 미리보기(preview)는 본문 끝에 붙인다, 직접 입력(Other)은 팝업의 메모칸이 맡는다.
대상: ATHENA_AGENT 가 있는 세션(위임 에이전트)만. 아테나 pane 은 사람과 직접 대화하니 그대로 둔다. 요청을 열지 못하면 막지 않고 원래 고르기 창을 그대로 둔다(항상 exit 0).
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
RECOMMENDED = '(Recommended)'


def clean_label(label: str):
    """Claude Code 는 추천 선택지 라벨 끝에 '(Recommended)' 를 붙이게 한다 — 떼고 추천으로 표시한다."""
    text = str(label or '').strip()
    if text.endswith(RECOMMENDED):
        return text[:-len(RECOMMENDED)].strip(), True
    return text, False


def body_of(question: dict) -> str:
    lines = []
    header = str(question.get('header') or '').strip()
    if header:
        lines.append(f'[{header}]')
    if question.get('multiSelect'):
        lines.append('여러 개를 고를 수 있는 질문이다 — 하나를 고르고, 나머지는 메모에 적어 보낸다.')
    previews = [f"- {clean_label(option.get('label'))[0]}:\n{option['preview']}" for option in question.get('options') or []
                if isinstance(option, dict) and option.get('preview')]
    if previews:
        lines += ['', '선택지 미리보기'] + previews
    return '\n'.join(lines)


def open_request(question: dict):
    options, recommend = [], None
    for option in question.get('options') or []:
        if not isinstance(option, dict):
            continue
        label, is_recommended = clean_label(option.get('label'))
        if not label:
            continue
        desc = str(option.get('description') or '').strip().replace('\n', ' ')
        options.append(f'{label} :: {desc}' if desc else label)
        if is_recommended and recommend is None:
            recommend = label
    with tempfile.NamedTemporaryFile('w', suffix='.md', delete=False, encoding='utf-8') as handle:
        handle.write(body_of(question))
        body_file = handle.name
    try:
        command = [str(ATHENA_DIR / 'bin' / 'athena'), 'request', 'open', '--kind', 'question', '--title', str(question.get('question') or '').strip(),
                   '--body-file', body_file, '--json']
        plan = os.environ.get('ATHENA_PLAN')
        if plan:
            command += ['--plan', plan]
        for option in options:
            command += ['--option', option]
        if recommend:
            command += ['--recommend', recommend]
        done = subprocess.run(command, capture_output=True, text=True, timeout=30)
    finally:
        os.unlink(body_file)
    lines = [line for line in done.stdout.strip().splitlines() if line.strip()]
    result = json.loads(lines[-1]) if lines else {}
    if not result.get('ok'):
        raise RuntimeError(result.get('message') or done.stderr.strip() or '요청을 열지 못했다')
    return result['request']['id']


def main() -> None:
    if not os.environ.get('ATHENA_AGENT'):
        return
    event = json.load(sys.stdin)
    questions = [item for item in (event.get('tool_input') or {}).get('questions') or [] if isinstance(item, dict) and str(item.get('question') or '').strip()]
    if not questions:
        return
    ids = []
    try:
        for question in questions:
            ids.append(open_request(question))
    except Exception:
        # 일부만 열렸으면 거둔다 — 원래 고르기 창이 그대로 뜨니 같은 질문이 두 곳에 남지 않게
        for request_id in ids:
            subprocess.run([str(ATHENA_DIR / 'bin' / 'athena'), 'request', 'cancel', request_id, '--reason', '고르기 창으로 대신 물음'],
                           capture_output=True, text=True, timeout=30)
        return
    listed = ' · '.join(ids)
    reason = (f'질문을 스튜디오 [작업] 에 올렸다(요청 {listed}). 사람이 거기서 고르면 답이 `[요청 <id>] … 답:` 으로 이 pane 에 온다 — 받으면 바로 '
              '`bin/athena request ack <id>`. 그 답에 기대지 않는 일은 계속하고, 기대는 일만 멈춘다(계획서 Blocked 에 요청 id 를 적는다). 같은 질문을 다시 묻지 않는다.')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': reason}}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
