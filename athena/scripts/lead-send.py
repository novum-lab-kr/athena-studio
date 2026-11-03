#!/usr/bin/env python3
"""에이전트 → 아테나 pane 한 줄 보내기 — 받을 수 없으면 모아 뒀다 넣는다(위임 지시문 delegate.sh LEAD_RULE 이 이 명령을 알려 준다).

  scripts/lead-send.py <아테나 pane> '<글>' [--plan <계획서>]

보내기는 `scripts/screen pane send-text <pane> <글> --enter` 와 같은 길(데몬 pane run — 전송 확인 · 재시도).
[작업] 에는 사람이 고를 것이 있을 때만 뜬다 — 이 명령은 요청을 열지 않는다(고를 것이 없다). 글은 버리지 않고 넣거나 기록한다(GitHub #134).
- 보냈다 → 끝
- 아테나 pane 이 살아 있는데 지금 못 받는다(질문 · 고르기 창 · 다른 전송 중) → 대기열에 두고, 뒤에서 처리기가
  창이 닫히면 들어온 차례대로 넣는다. 앞에 미룬 글이 있으면 새 글도 뒤에 줄 선다(차례를 지킨다)
- 받을 아테나 pane 이 닫혔다 → 지금 아테나 pane 을 고른다(lead_target):
  ① 계획서 "- Lead pane:" 줄(delegate.sh 가 다시 맡길 때 갱신)의 pane 이 살아 있으면 거기
  ② 아니면 떠 있는 아테나 pane(본체 루트의 claude · codex · 🤖 이름 아님 — 현황판 plan-bind.mjs boardPaneOf 와 같은 기준)이 하나뿐이면 거기
  ③ 여러 개면 그중 사용자가 보고 있는(focused) pane 이 하나일 때만 거기 — 아니면 아무 데나 넣지 않고 기록만
  ④ 하나도 없으면 대기열 → 아테나 pane 이 생기면 넣는다
- 기록만 — 전송을 확인하지 못했다(글이 입력칸에 남았을 수 있어 다시 넣지 않는다) · 아테나 pane 을 하나로 못 골랐다 · 6시간을 넘겼다 ·
  옛 구조(팩 데이터 없음)에서 못 보냈다 → 계획서 결과 절에 글 그대로 한 줄 + 사건 기록(state/events.jsonl `lead-send-unsent`)
기다리는 값은 기존 장치 그대로 — 2초마다 · 최대 6시간(pane_request.py POLL_SECONDS · GIVE_UP_SECONDS · agent-done-notify.py 와 같다).
결정 기록: plans/task/20261103-athena-studio-fe-에이전트가-아테나에-못-보낸-보고를-작업-질문으로-띄우지-않기.md(docs/requests.md "아테나에게 보내지 못했을 때")

대기열 <팩 데이터>/state/lead-send/<아테나 pane>-<시각ns>-<임의>.json — 처리기가 꺼져도 남고, 다음 보내기가 처리기를 다시 띄운다.
종료 코드: 0 = 보냈다 · 모아 뒀다 · 계획서에 기록했다(출력 첫 글자 ✅ · ⏳ · ⚠️) / 1 = 계획서에도 못 적었다(글을 계획서에 적고 알린다) / 2 = 사용법
"""
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import uuid

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ATHENA_DIR / 'scripts' / 'lib'))
import screen  # noqa: E402 — 화면 계층 — pane 을 다루는 곳은 scripts/lib/screen.py 하나
import pane_request  # noqa: E402 — 창 읽기(pane_menu) · 계획서 찾기(plan_of) · 기다리는 값
from reuse_link import pane_lock  # noqa: E402
from plan_update import update_plan  # noqa: E402 — 계획서 고치기(잠금 · 바꿔치기)

PANE_ID = re.compile(r'^[\w-]{1,32}$')
# 데몬이 글을 쓰기 전에 거절한 것(입력칸에 아무것도 안 들어갔다) — 다시 넣어도 겹치지 않는다.
# 글 정본: src/lib/pane-submit.mts submitText · src/daemon/daemon.mts submitToPane (앱 test/pane-submit.test.js 가 같은지 본다)
NOT_WRITTEN = ('입력을 기다리는 질문이 열려 있다', '이 pane 에 입력을 보내는 중이다')
POLL_SECONDS = pane_request.POLL_SECONDS
GIVE_UP_SECONDS = int(os.environ.get('ATHENA_LEAD_SEND_GIVE_UP') or pane_request.GIVE_UP_SECONDS)
# lead_target 이 pane 대신 돌려주는 값
NO_LEAD = 'none'     # 떠 있는 아테나 pane 이 없다(또는 목록을 못 읽었다) — 기다린다
MANY_LEADS = 'many'  # 여러 개인데 하나로 못 골랐다 — 기록만
MANY_REASON = '받을 아테나 pane 이 닫혔고 떠 있는 아테나 pane 이 여러 개라 고르지 못했어요'


def queue_dir():
    state = pane_request.pack_state()
    return state / 'lead-send' if state else None


def queued(folder: pathlib.Path, lead: str):
    """이 아테나 pane 앞으로 미룬 글 — 들어온 차례(이름이 시각 순)"""
    return sorted(folder.glob(f'{lead}-*.json')) if folder.is_dir() else []


def alive(pane: str) -> bool:
    try:
        screen.get_backend().get_pane(pane)
        return True
    except Exception:
        return False


def plan_file(plan: str):
    """계획서 실제 파일 — 본체 기준 논리 경로(plans/…md) · 절대 경로 모두. 없으면 None"""
    if not plan or not plan.endswith('.md'):
        return None
    path = pathlib.Path(plan) if os.path.isabs(plan) else ATHENA_DIR / plan
    return path if path.is_file() else None


def plan_lead(plan: str) -> str:
    """계획서 Checkpoint 의 "- Lead pane:" 첫 낱말(agent-done-notify.py plan_fields 와 같은 읽기)"""
    path = plan_file(plan)
    if path is None:
        return ''
    try:
        found = re.search(r'^- Lead pane:\s*(\S+)', path.read_text(encoding='utf-8'), re.M)
    except OSError:
        return ''
    return found.group(1) if found and PANE_ID.fullmatch(found.group(1)) else ''


def lead_panes(me: str):
    """떠 있는 아테나 pane — 본체 루트에서 도는 claude · codex 이고 위임 이름표(🤖)가 아닌 것(plan-bind.mjs boardPaneOf 와 같은 기준).
    목록을 못 읽으면 None"""
    try:
        panes = screen.get_backend().list_panes()
    except Exception:
        return None
    root = os.path.realpath(ATHENA_DIR)
    found = []
    for pane in panes:
        name = str(pane.get('label') or pane.get('name') or pane.get('pane_title') or '')
        cwd = str(pane.get('cwd') or '')
        if pane.get('agent') in ('claude', 'codex') and cwd and os.path.realpath(cwd) == root and not name.startswith('🤖') and pane.get('id') != me:
            found.append(pane)
    return found


def lead_target(lead: str, plan: str, me: str) -> str:
    """보낼 아테나 pane — 받을 pane 이 살아 있으면 그대로, 닫혔으면 ①~④(머리 주석). pane id · NO_LEAD · MANY_LEADS"""
    if alive(lead):
        return lead
    planned = plan_lead(plan)
    if planned and planned not in (lead, me) and alive(planned):
        return planned
    panes = lead_panes(me)
    if not panes:
        return NO_LEAD
    if len(panes) == 1:
        return str(panes[0]['id'])
    focused = [pane for pane in panes if pane.get('focused') is True]
    return str(focused[0]['id']) if len(focused) == 1 else MANY_LEADS


def try_send(lead: str, text: str) -> str:
    """'sent' · 'wait'(창이 떠 있다 · 글은 안 들어갔다) · 'gone'(pane 이 없다) · 그 밖은 실패 글(글이 들어갔는지 모른다)"""
    state = pane_request.pane_menu(lead)
    if state == 'gone':
        return 'gone'
    if state is True:
        return 'wait'
    try:
        screen.get_backend().run(lead, [text])
        return 'sent'
    except screen.ScreenError as error:
        if error.code == 'unavailable' and any(mark in error.message for mark in NOT_WRITTEN):
            return 'wait'
        return error.message or error.code


def unconfirmed(result: str) -> str:
    return f'보냈지만 전송을 확인하지 못했어요({result}) — 입력칸에 남았을 수 있어 다시 넣지 않았어요'


def record_unsent(entry: dict, reason: str) -> bool:
    """넣지 못한(또는 넣었는지 모르는) 글을 기록만 한다 — 요청은 열지 않는다(고를 것이 없다).
    계획서 결과 절 끝에 글 그대로 한 줄 + 사건 기록(scripts/lib/events.mjs) 한 줄. 계획서에 적었으면 True"""
    written = False
    path = plan_file(str(entry.get('plan') or ''))
    if path is not None:
        stamp = time.strftime('%Y-%m-%d %H:%M', time.localtime(float(entry.get('at') or time.time())))
        who = entry.get('from') or '에이전트'
        line = f'- ⚠️ {stamp} {who} 가 아테나(pane {entry["lead"]})에 못 보낸 글 — {reason}: {entry["text"]}'

        def append(text: str) -> str:
            # 결과 절 끝(다음 ## 앞)에 — 결과 절이 없으면 파일 끝에
            found = re.search(r'^## 결과[^\n]*\n', text, re.M)
            if not found:
                return text.rstrip('\n') + '\n\n' + line + '\n'
            after = re.search(r'^## ', text[found.end():], re.M)
            if not after:
                return text.rstrip('\n') + '\n' + line + '\n'
            cut = found.end() + after.start()
            return text[:cut].rstrip('\n') + '\n' + line + '\n\n' + text[cut:]
        try:
            update_plan(str(path), append)
            written = True
        except Exception:
            written = False
    fields = [f'lead={entry["lead"]}', f'from={entry.get("from") or ""}', f'plan={entry.get("plan") or ""}', f'reason={reason[:300]}',
              f'written={"true" if written else "false"}']
    if not written:
        fields.append(f'text={str(entry["text"])[:1000]}')   # 계획서에 못 적었으면 글을 사건 기록에라도 남긴다
    try:
        subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'lib' / 'events.mjs'), 'lead-send-unsent', *fields],
                       capture_output=True, text=True, timeout=10)
    except Exception:
        pass   # 사건 기록 실패는 무시(events.mjs 와 같은 규칙)
    return written


def write_entry(folder: pathlib.Path, entry: dict) -> pathlib.Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f'{entry["lead"]}-{time.time_ns()}-{uuid.uuid4().hex[:6]}.json'
    temp = folder / f'.{path.name}.tmp'
    temp.write_text(json.dumps(entry, ensure_ascii=False) + '\n', encoding='utf-8')
    os.replace(temp, path)
    return path


def spawn_deliverer(lead: str) -> None:
    """떨어져 나온 처리기 — 이미 돌고 있으면 그쪽이 잠금을 쥐고 있어 새것은 바로 끝난다"""
    subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), '--deliver', lead], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def send(lead: str, text: str, plan: str) -> int:
    me = pane_request.caller_pane()
    entry = {'lead': lead, 'text': text, 'plan': plan, 'pane': me, 'from': os.environ.get('ATHENA_AGENT') or me, 'at': time.time()}
    folder = queue_dir()
    target = lead_target(lead, plan, me)
    if target == MANY_LEADS:
        return recorded(entry, MANY_REASON)
    moved = f'아테나 pane {lead} 가 닫혀 지금 아테나 pane {target} 에 ' if target not in (lead, NO_LEAD) else f'아테나 pane {lead} 에 '
    if folder is None:
        # 옛 구조(팩 데이터 없음) — 모아 둘 자리가 없어 지금 보내 보고, 못 보내면 기록만
        result = 'gone' if target == NO_LEAD else try_send(target, text)
        if result == 'sent':
            print(f'✅ {moved}보냈다')
            return 0
        reasons = {'gone': '아테나 pane 이 없어요', 'wait': '아테나가 지금 받을 수 없어요(모아 둘 자리가 없는 옛 구조)'}
        return recorded(entry, reasons.get(result, unconfirmed(result)))
    # 아테나 pane 이 없으면 원래 pane 이름으로 줄 세워 두고, 처리기가 아테나 pane 이 생길 때까지 다시 고른다
    key = lead if target == NO_LEAD else target
    entry['lead'] = key
    with pane_lock(folder, key):
        if target == NO_LEAD or queued(folder, key):
            result = 'wait'
        else:
            result = try_send(target, text)
            if result == 'gone':
                result = 'wait'   # 고른 사이 닫혔다 — 처리기가 다시 고른다
        if result == 'wait':
            write_entry(folder, entry)
    if result == 'sent':
        print(f'✅ {moved}보냈다')
        return 0
    if result == 'wait':
        spawn_deliverer(key)
        if target == NO_LEAD:
            print(f'⏳ 아테나 pane {lead} 가 없고 떠 있는 아테나 pane 도 없어 모아 뒀다 — 아테나 pane 이 생기면 저절로 넣는다. 요청을 따로 열지 않는다')
        else:
            print(f'⏳ {moved}지금 못 넣어(질문 · 고르기 창 · 앞에 미룬 글) 모아 뒀다 — 받을 수 있게 되면 저절로 넣는다. 요청을 따로 열지 않는다')
        return 0
    return recorded(entry, unconfirmed(result))


def recorded(entry: dict, reason: str) -> int:
    if record_unsent(entry, reason):
        print(f'⚠️ 아테나 pane {entry["lead"]} 에 넣지 않고 계획서 결과 절에 기록했다 — {reason}. 요청을 따로 열지 않는다')
        return 0
    print(f'❌ 아테나 pane {entry["lead"]} 에 보내지 못했고 계획서에도 적지 못했다 — {reason}. 보낼 글을 계획서 Checkpoint 에 적고 보고에 알린다')
    return 1


def deliver(lead: str) -> None:
    """미룬 글을 차례대로 넣는다 — 하나라도 남아 있으면 계속. 처리기는 대기열 이름(아테나 pane)마다 하나(잠금)"""
    folder = queue_dir()
    if folder is None:
        return
    folder.mkdir(parents=True, exist_ok=True)
    holder = open(folder / f'.deliver-{lead}.lock', 'w')
    try:
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return  # 다른 처리기가 돈다
    while folder.is_dir():   # 폴더가 없어졌으면(팩 데이터 정리 · 시험 끝) 끝낸다
        with pane_lock(folder, lead):
            files = queued(folder, lead)
            if not files:
                # 끝낼 때는 잠금 안에서 처리기 잠금을 먼저 놓는다 — 그새 줄 선 글이 처리기 없이 남지 않게(보내는 쪽은 줄 선 뒤 처리기를 띄운다)
                fcntl.flock(holder, fcntl.LOCK_UN)
                holder.close()
                return
            path = files[0]
            try:
                entry = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                continue
            if time.time() - float(entry.get('at') or 0) > GIVE_UP_SECONDS:
                result = '6시간 동안 아테나가 받을 수 없었어요'
            else:
                # 기다리는 동안 pane 이 닫혔거나 처음부터 없었으면 다시 고른다(머리 주석 ①~④)
                target = lead_target(lead, str(entry.get('plan') or ''), str(entry.get('pane') or ''))
                if target == MANY_LEADS:
                    result = MANY_REASON
                elif target == NO_LEAD:
                    result = 'wait'
                else:
                    result = try_send(target, str(entry.get('text') or ''))
                    result = 'wait' if result == 'gone' else result
                    result = result if result in ('sent', 'wait') else unconfirmed(result)
            if result != 'wait':
                if result != 'sent':
                    record_unsent(entry, result)
                path.unlink(missing_ok=True)
                continue
        time.sleep(POLL_SECONDS)


def main(argv) -> int:
    if len(argv) == 2 and argv[0] == '--deliver':
        if PANE_ID.fullmatch(argv[1]):
            deliver(argv[1])
        return 0
    plan = ''
    if len(argv) == 4 and argv[2] == '--plan':
        plan = argv[3]
        argv = argv[:2]
    if len(argv) != 2 or not PANE_ID.fullmatch(argv[0]) or not argv[1].strip():
        print("사용: scripts/lead-send.py <아테나 pane> '<글>' [--plan <계획서>]", file=sys.stderr)
        return 2
    text = re.sub(r'\s*\n\s*', ' ', argv[1]).strip()
    return send(argv[0], text, plan or pane_request.plan_of(pane_request.caller_pane()))


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
