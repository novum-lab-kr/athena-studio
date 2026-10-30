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
import re
import subprocess
import sys
import tempfile

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
import screen  # noqa: E402 — 화면 계층 — pane 을 다루는 곳은 scripts/lib/screen.py 하나

RECOMMENDED = '(Recommended)'
PANE_ID = re.compile(r'^[\w-]{1,32}$')


def pack_state():
    pack_data = ATHENA_DIR / '.pack-data'
    return pack_data.resolve() / 'state' if pack_data.is_symlink() else None


def caller_pane() -> str:
    try:
        pane = str(screen.self_info().get('pane_id') or '')
    except Exception:
        return ''
    return pane if PANE_ID.match(pane) else ''


def plan_of(pane: str) -> str:
    """계획서 — pane 기록(이어 보내기로 바뀐 계획서도 따라간다)을 먼저, 없으면 환경 ATHENA_PLAN (agent-done-notify.py 와 같은 순서)"""
    base = pack_state()
    if base and pane:
        try:
            plan = json.loads((base / 'pane-sessions' / f'{pane}.json').read_text(encoding='utf-8')).get('plan')
            if plan:
                return str(plan)
        except Exception:
            pass
    return os.environ.get('ATHENA_PLAN') or ''


def log_failure(reason: str) -> None:
    """훅이 요청을 못 열었다는 흔적 — 기존 사건 기록 진입점(scripts/lib/events.mjs)으로 한 줄 남긴다(pack · 시각 형식이 같다). 기록 실패는 무시"""
    try:
        subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'lib' / 'events.mjs'), 'request-hook-failed',
                        f"agent={os.environ.get('ATHENA_AGENT') or ''}", f'reason={reason[:300]}'],
                       capture_output=True, text=True, timeout=10)
    except Exception:
        pass


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


def open_request(question: dict, pane: str):
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
        plan = plan_of(pane)
        if plan:
            command += ['--plan', plan]
        if pane:
            command += ['--pane', pane]
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
    pane = caller_pane()
    try:
        for question in questions:
            ids.append(open_request(question, pane))
    except Exception as error:
        log_failure(str(error))
        # 일부만 열렸으면 거둔다 — 원래 고르기 창이 그대로 뜨니 같은 질문이 두 곳에 남지 않게
        for request_id in ids:
            try:
                subprocess.run([str(ATHENA_DIR / 'bin' / 'athena'), 'request', 'cancel', request_id, '--reason', '고르기 창으로 대신 물음'],
                               capture_output=True, text=True, timeout=30)
            except Exception as cancel_error:
                log_failure(f'요청 {request_id} 거두기 실패: {cancel_error}')
        # 막지 않고 원래 고르기 창을 둔다 — 스튜디오 [작업] 에는 안 올라갔다는 것을 에이전트에게 알린다(이유는 events.jsonl 에도 남았다)
        notice = '질문을 스튜디오 [작업] 에 올리지 못했다(요청 열기 실패) — 이 고르기 창에는 사람이 pane 에서 답한다. 답이 늦으면 아테나에 알린다.'
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': notice}}, ensure_ascii=False))
        return
    listed = ' · '.join(ids)
    reason = (f'질문을 스튜디오 [작업] 에 올렸다(요청 {listed}). 사람이 거기서 고르면 답이 `[요청 <id>] … 답:` 으로 이 pane 에 온다 — 받으면 바로 '
              '`bin/athena request ack <id>`. 그 답에 기대지 않는 일은 계속하고, 기대는 일만 멈춘다(계획서 Blocked 에 요청 id 를 적는다). 답이 오기 전에는 같은 질문을 다시 묻지 않는다 — '
              '다만 `bin/athena request show <id>` 가 expired · cancelled 로 닫혔다고 하면 답은 오지 않으니 같은 질문을 새 요청으로 다시 연다.')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': reason}}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        log_failure(f'훅 오류: {error}')
    sys.exit(0)
