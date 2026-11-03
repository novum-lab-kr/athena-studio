#!/usr/bin/env python3
"""에이전트 → 아테나 pane 한 줄 보내기 — 받을 수 없으면 모아 뒀다 넣는다(위임 지시문 delegate.sh LEAD_RULE 이 이 명령을 알려 준다).

  scripts/lead-send.py <아테나 pane> '<글>' [--plan <계획서>]

보내기는 `scripts/screen pane send-text <pane> <글> --enter` 와 같은 길(데몬 pane run — 전송 확인 · 재시도).
- 보냈다 → 끝
- 아테나 pane 이 살아 있는데 지금 못 받는다(질문 · 고르기 창 · 다른 전송 중) → 요청을 열지 않고 대기열에 두고, 뒤에서 처리기가
  창이 닫히면 들어온 차례대로 넣는다. 사용자 화면에는 아무것도 안 뜬다. 앞에 미룬 글이 있으면 새 글도 뒤에 줄 선다(차례를 지킨다)
- 아테나 pane 이 없다 · 기다리다 닫혔다 · 6시간을 넘겼다 · 전송을 확인하지 못했다(글이 입력칸에 남았을 수 있어 다시 넣지 않는다)
  → 버리지 않고 요청(question)으로 남긴다(GitHub #134 — docs/requests.md "아테나에게 보내지 못했을 때")
기다리는 값은 기존 장치 그대로 — 2초마다 · 최대 6시간(pane_request.py POLL_SECONDS · GIVE_UP_SECONDS · agent-done-notify.py 와 같다).

대기열 <팩 데이터>/state/lead-send/<아테나 pane>-<시각ns>-<임의>.json — 처리기가 꺼져도 남고, 다음 보내기가 처리기를 다시 띄운다.
종료 코드: 0 = 보냈다 · 모아 뒀다 · 요청으로 남겼다(출력 첫 글자 ✅ · ⏳ · ⚠️) / 1 = 요청도 못 열었다(글을 계획서에 적고 알린다) / 2 = 사용법
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
import pane_request  # noqa: E402 — 창 읽기(pane_menu) · 요청 명령(athena) · 계획서 찾기(plan_of) · 기다리는 값
from reuse_link import pane_lock  # noqa: E402

PANE_ID = re.compile(r'^[\w-]{1,32}$')
# 데몬이 글을 쓰기 전에 거절한 것(입력칸에 아무것도 안 들어갔다) — 다시 넣어도 겹치지 않는다.
# 글 정본: src/lib/pane-submit.mts submitText · src/daemon/daemon.mts submitToPane (앱 test/pane-submit.test.js 가 같은지 본다)
NOT_WRITTEN = ('입력을 기다리는 질문이 열려 있다', '이 pane 에 입력을 보내는 중이다')
POLL_SECONDS = pane_request.POLL_SECONDS
GIVE_UP_SECONDS = int(os.environ.get('ATHENA_LEAD_SEND_GIVE_UP') or pane_request.GIVE_UP_SECONDS)


def queue_dir():
    state = pane_request.pack_state()
    return state / 'lead-send' if state else None


def queued(folder: pathlib.Path, lead: str):
    """이 아테나 pane 앞으로 미룬 글 — 들어온 차례(이름이 시각 순)"""
    return sorted(folder.glob(f'{lead}-*.json')) if folder.is_dir() else []


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


def leave_request(entry: dict, reason: str):
    """보내지 못한 글을 요청으로 남긴다 — 요청 id(못 열면 '')"""
    body = '\n'.join([f'{entry.get("from") or "에이전트"} 가 아테나 pane {entry["lead"]} 에 보내려던 글이에요. {reason}', '', entry['text']])
    command = ['request', 'open', '--kind', 'question', '--title', f'아테나에 못 보낸 글 — {entry["text"][:60]}', '--body', body]
    if entry.get('pane'):
        command += ['--pane', entry['pane']]
    if entry.get('plan'):
        command += ['--plan', entry['plan']]
    try:
        result = pane_request.athena(command)
    except Exception:
        result = {}
    if result.get('ok'):
        return str(result['request']['id'])
    pane_request.log_failure(result.get('message') or '아테나에 못 보낸 글을 요청으로 남기지 못했다')
    return ''


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
    if folder is None:
        # 옛 구조(팩 데이터 없음) — 모아 둘 자리가 없어 지금처럼 보내고, 못 보내면 요청
        result = try_send(lead, text)
        if result == 'sent':
            print(f'✅ 아테나 pane {lead} 에 보냈다')
            return 0
        return fallback(entry, '아테나 pane 이 없어요.' if result == 'gone' else f'보내지 못했어요({result}).')
    with pane_lock(folder, lead):
        result = 'wait' if queued(folder, lead) else try_send(lead, text)
        if result == 'wait':
            write_entry(folder, entry)
    if result == 'sent':
        print(f'✅ 아테나 pane {lead} 에 보냈다')
        return 0
    if result == 'wait':
        spawn_deliverer(lead)
        print(f'⏳ 아테나 pane {lead} 가 지금 못 받아(질문 · 고르기 창 · 앞에 미룬 글) 모아 뒀다 — 받을 수 있게 되면 저절로 넣는다. 요청을 따로 열지 않는다')
        return 0
    return fallback(entry, '아테나 pane 이 없어요.' if result == 'gone' else f'보냈지만 전송을 확인하지 못했어요({result}) — 아테나 입력칸에 글이 남았을 수 있어요.')


def fallback(entry: dict, reason: str) -> int:
    request_id = leave_request(entry, reason)
    if request_id:
        print(f'⚠️ 아테나 pane {entry["lead"]} 에 보내지 못해 요청으로 남겼다 — {request_id} · {reason}')
        return 0
    print(f'❌ 아테나 pane {entry["lead"]} 에 보내지 못했고 요청도 열지 못했다 — {reason} 보낼 글을 계획서 Checkpoint 에 적고 보고에 알린다')
    return 1


def deliver(lead: str) -> None:
    """미룬 글을 차례대로 넣는다 — 하나라도 남아 있으면 계속. 처리기는 아테나 pane 마다 하나(잠금)"""
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
                result = 'old'
            else:
                result = try_send(lead, str(entry.get('text') or ''))
            if result != 'wait':
                if result != 'sent':
                    reasons = {'old': '6시간 동안 아테나가 받을 수 없었어요.', 'gone': '기다리는 동안 아테나 pane 이 닫혔어요.'}
                    leave_request(entry, reasons.get(result, f'보냈지만 전송을 확인하지 못했어요({result}) — 아테나 입력칸에 글이 남았을 수 있어요.'))
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
