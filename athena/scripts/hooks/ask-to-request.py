#!/usr/bin/env python3
"""에이전트의 고르기 질문을 사람에게 묻는 요청으로 바꾸는 훅 (PreToolUse · Claude AskUserQuestion / Codex request_user_input).

왜: 위임 에이전트가 pane 안에서 고르기 창(AskUserQuestion)으로 물으면 요청이 열리지 않아 스튜디오 [작업] 에 질문이 안 올라온다(2026-10-29).
무엇을: 질문마다 `bin/athena request open --kind question` 을 열고(계획서 = ATHENA_PLAN · pane = 부른 pane) 도구는 막는다.
  돌려주는 안내(permissionDecisionReason)가 에이전트에게 간다 — 답은 `[요청 <id>] … 답:` 으로 이 pane 에 오고, 받으면 request ack.
요청 형식이 못 담는 것: 여러 개 고르기(multiSelect)는 단일 선택 + 메모로(본문에 안내), 선택지 미리보기(preview)는 본문 끝에 붙인다, 직접 입력(Other)은 팝업의 메모칸이 맡는다.
대상 둘(인자로 가른다 — 같은 세션에 두 설정이 겹쳐 실려도 요청이 두 번 열리지 않게):
  - 위임 에이전트(인자 없음 · ATHENA_AGENT 있음) — 항상 요청으로 바꾼다
  - 아테나 pane(인자 `lead` · ATHENA_AGENT 없음 · 본체 .claude/settings.json) — 사용자가 그 pane 을 안 보고 있으면(화면 계층 pane get 의 focused 가 거짓) 위임 에이전트처럼 요청으로 바꾸고 도구는 막는다.
    보고 있거나 · 포커스를 모르면 pane 의 고르기 창은 그대로 두고 [작업] 에도 같이 올린다(막으면 보던 사람이 바로 못 고른다). 그때는 pane 에서 고르면 요청을 저절로 거두고(뒤에서 도는 지킴이 pane_request.py close),
    [작업] 에서 먼저 고르면 앱이 pane 의 창에서 같은 선택지를 고른다(질문 하나 · 메모 없음일 때만 — 앱 src/lib/answer-delivery.mts · 아니면 '선택 창이 떠 있음' 알림). pane 을 모르면 가리킬 곳이 없어 올리지 않는다. 계획서가 없으면(pane 기록 plan 없음) 계획서 없는 요청으로 열린다.
요청을 열지 못하면 막지 않고 원래 고르기 창을 그대로 둔다(항상 exit 0).
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
import pane_request  # noqa: E402 — pane 알아내기 · 계획서 · 지킬 때의 규칙은 두 훅(고르기 · 권한)이 같이 쓴다
from pane_request import caller_pane, log_failure, plan_of, screen  # noqa: E402,F401 — screen: 화면 계층 — pane 을 다루는 곳은 scripts/lib/screen.py 하나
from studio_lang import pick  # noqa: E402 — 요청 본문은 사람이 [작업] 에서 본다 — 앱 언어로(에이전트에게 돌려주는 안내는 그대로)

RECOMMENDED = '(Recommended)'


def pane_unwatched(pane: str) -> bool:
    """사용자가 그 pane 을 안 보고 있다고 확인된 때만 참 — 화면 계층 focused(창의 보는 pane). 모르면(조회 실패 · 값 없음) 거짓 = 고르기 창을 그대로 둔다"""
    if not pane:
        return False
    try:
        return screen.get_backend().get_pane(pane).get('focused') is False
    except Exception:
        return False


def clean_label(label: str):
    """Claude Code 는 추천 선택지 라벨 끝에 '(Recommended)' 를 붙이게 한다 — 떼고 추천으로 표시한다."""
    text = str(label or '').strip()
    if text.endswith(RECOMMENDED):
        return text[:-len(RECOMMENDED)].strip(), True
    return text, False


WATCHED_NOTE = {
    'ko': ('지금 그 pane 에도 같은 선택 프롬프트가 떠 있어요. pane 에서 고르면 이 요청은 저절로 닫혀요. '
           '여기서 고르면 pane 의 프롬프트에서 같은 선택지를 골라요. 메모를 붙였거나 질문이 여러 개인 프롬프트면 넣지 못하니 pane 에서 골라 주세요.'),
    'en': ('The same choice prompt is open in that pane too. Choose there and this request closes by itself. '
           'If you choose here, the same option is picked in the pane\'s prompt. With a note, or if the prompt has several questions, it cannot be typed in — choose in the pane.'),
    'ja': ('その pane にも同じ選択プロンプトが出ています。pane で選ぶとこのリクエストは自動で閉じます。'
           'ここで選ぶと、pane のプロンプトで同じ選択肢を選びます。メモを付けた場合や質問が複数あるプロンプトでは入力できないので、pane で選んでください。'),
    'zh': ('该 pane 中也打开了相同的选择提示。在 pane 中选择后，此请求会自动关闭。'
           '如果在这里选择，会在 pane 的提示中选中相同的选项。如果附加了备注或提示中有多个问题，则无法输入，请在 pane 中选择。'),
}
MULTI_SELECT = {
    'ko': '여러 개를 고를 수 있는 질문이에요 — 하나를 고르고, 나머지는 메모에 적어 보내 주세요.',
    'en': 'This question allows several choices — pick one and add the rest in the note.',
    'ja': '複数選べる質問です — 一つを選び、残りはメモに書いて送ってください。',
    'zh': '此问题可多选 — 选一个，其余写在备注里发送。',
}
PREVIEWS = {'ko': '선택지 미리보기', 'en': 'Option previews', 'ja': '選択肢のプレビュー', 'zh': '选项预览'}
ASKED_IN_PANE = {'ko': '선택 프롬프트로 대신 물음', 'en': 'Asked in the choice prompt instead', 'ja': '選択プロンプトで代わりに質問', 'zh': '改为在选择提示中询问'}


def body_of(question: dict, watched: bool = False) -> str:
    lines = [pick(WATCHED_NOTE), ''] if watched else []
    header = str(question.get('header') or '').strip()
    if header:
        lines.append(f'[{header}]')
    if question.get('multiSelect'):
        lines.append(pick(MULTI_SELECT))
    previews = [f"- {clean_label(option.get('label'))[0]}:\n{option['preview']}" for option in question.get('options') or []
                if isinstance(option, dict) and option.get('preview')]
    if previews:
        lines += ['', pick(PREVIEWS)] + previews
    return '\n'.join(lines)


def open_request(question: dict, pane: str, watched: bool = False):
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
        handle.write(body_of(question, watched))
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
    lead = sys.argv[1:2] == ['lead']
    if lead == bool(os.environ.get('ATHENA_AGENT')):
        return  # 아테나 설정(lead)은 에이전트 세션에서, 에이전트 설정은 아테나 세션에서 건너뛴다(같은 세션에 둘 다 실려도 한 번만)
    event = json.load(sys.stdin)
    questions = [item for item in (event.get('tool_input') or {}).get('questions') or [] if isinstance(item, dict) and str(item.get('question') or '').strip()]
    if not questions:
        return
    ids = []
    pane = caller_pane()
    # 아테나 pane — 안 보고 있으면 요청으로 바꾸고 막는다. 보고 있거나 포커스를 모르면 pane 창은 두고 [작업] 에도 올린다(막지 않는다)
    watched = lead and not pane_unwatched(pane)
    if watched and not pane:
        return  # pane 을 모르면 창이 닫힌 것을 알아볼 수 없어 요청이 남는다 — 올리지 않는다
    try:
        for question in questions:
            ids.append(open_request(question, pane, watched))
    except Exception as error:
        log_failure(str(error))
        # 일부만 열렸으면 거둔다 — 원래 고르기 창이 그대로 뜨니 같은 질문이 두 곳에 남지 않게
        for request_id in ids:
            try:
                subprocess.run([str(ATHENA_DIR / 'bin' / 'athena'), 'request', 'cancel', request_id, '--reason', pick(ASKED_IN_PANE)],
                               capture_output=True, text=True, timeout=30)
            except Exception as cancel_error:
                log_failure(f'요청 {request_id} 거두기 실패: {cancel_error}')
        if watched:
            return  # pane 창은 어차피 그대로 — 올리지 못한 것은 흔적(request-hook-failed)으로만 남긴다
        # 막지 않고 원래 고르기 창을 둔다 — 스튜디오 [작업] 에는 안 올라갔다는 것을 에이전트에게 알린다(이유는 events.jsonl 에도 남았다)
        notice = '질문을 스튜디오 [작업] 에 올리지 못했다(요청 열기 실패) — 이 고르기 창에는 사람이 pane 에서 답한다. 답이 늦으면 아테나에 알린다.'
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': notice}}, ensure_ascii=False))
        return
    if watched:
        pane_request.spawn(['close', pane, *ids])  # 창은 그대로 — pane 에서 고르면 요청을 거둔다
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
