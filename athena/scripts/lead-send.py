#!/usr/bin/env python3
"""에이전트 → 아테나 pane 한 줄 보내기 — 받을 수 없으면 모아 뒀다 넣는다(위임 지시문 delegate.sh LEAD_RULE 이 이 명령을 알려 준다).

  scripts/lead-send.py <아테나 pane> '<글>' [--plan <계획서>] [--track]

보내기는 `scripts/screen pane send-text <pane> <글> --enter` 와 같은 길(데몬 pane run — 전송 확인 · 재시도).
[작업] 에는 사람이 고를 것이 있을 때만 뜬다 — 이 명령은 요청을 열지 않는다(고를 것이 없다). 글은 버리지 않고 넣거나 기록한다(GitHub #134).
- 보냈다 → 끝
- 아테나 pane 이 살아 있는데 지금 못 받는다(질문 · 고르기 창 · 다른 전송 중) → 대기열에 두고, 뒤에서 처리기가
  창이 닫히면 들어온 차례대로 넣는다. 앞에 미룬 글이 있으면 새 글도 뒤에 줄 선다(차례를 지킨다)
- 담당은 계획서 "- Lead pane:"가 우선이다. 없으면 명시한 인자를 쓴다. 유일/focused pane 으로 대체하지 않는다.
- 담당이 닫혔다 → 원래 담당 또는 계획서에 명시적으로 재배정한 담당을 기다린다.
- 계획서 Lead session 또는 대기열에 저장한 대화가 달라졌다 → 새 대화로 넣지 않고 기록한다.
- 기록만 — 전송을 확인하지 못했다(글이 입력칸에 남았을 수 있어 다시 넣지 않는다) · 담당 대화가 달라졌다 · 6시간을 넘겼다 ·
  옛 구조(팩 데이터 없음)에서 못 보냈다 → 계획서 결과 절에 글 그대로 한 줄 + 사건 기록(state/events.jsonl `lead-send-unsent`)
기다리는 값은 기존 장치 그대로 — 2초마다 · 최대 6시간(pane_request.py POLL_SECONDS · GIVE_UP_SECONDS · agent-done-notify.py 와 같다).
받음 확인(scripts/lib/agent_turn.py · state/lead-notices) — 전송을 확인하지 못한 글은 늘, --track(끝 알림 훅이 붙인다)이면 넣은 글도 남긴다.
  아테나 pane 의 입력 훅(pane-session.py)이 그 글을 받으면 표시하고, 안 받았으면 현황판이 2분 뒤 한 번 다시 넣고 10분이면 [작업] 요청을 연다.
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
import agent_turn  # noqa: E402 — 받음 확인 기록(state/lead-notices)
from reuse_link import pane_lock  # noqa: E402
from plan_update import update_plan  # noqa: E402 — 계획서 고치기(잠금 · 바꿔치기)

PANE_ID = re.compile(r'^[\w-]{1,32}$')
# 데몬이 글을 쓰기 전에 거절한 것(입력칸에 아무것도 안 들어갔다) — 다시 넣어도 겹치지 않는다.
# 글 정본: src/lib/pane-submit.mts submitText · src/daemon/daemon.mts submitToPane (앱 test/pane-submit.test.js 가 같은지 본다)
NOT_WRITTEN = ('입력을 기다리는 질문이 열려 있다', '이 pane 에 입력을 보내는 중이다')
POLL_SECONDS = pane_request.POLL_SECONDS
GIVE_UP_SECONDS = int(os.environ.get('ATHENA_LEAD_SEND_GIVE_UP') or pane_request.GIVE_UP_SECONDS)
# 담당 pane 을 임의로 고르지 않는다. 대화 소유권을 확인하지 못하면 기록만 한다.
NO_LEAD = 'none'
WRONG_SESSION = 'wrong-session'
SESSION_REASON = '담당 대화가 바뀌었거나 확인되지 않아요'


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
        found = re.search(r'^- Lead pane:[ \t]*(\S+)', path.read_text(encoding='utf-8'), re.M)
    except OSError:
        return ''
    return found.group(1) if found and PANE_ID.fullmatch(found.group(1)) else ''


def pane_session(pane: str) -> str:
    base = pane_request.pack_state()
    if base is None:
        return ''
    try:
        return str(json.loads((base / 'pane-sessions' / f'{pane}.json').read_text(encoding='utf-8')).get('session') or '')
    except (OSError, ValueError):
        return ''


def plan_session(plan: str) -> str:
    path = plan_file(plan)
    if path is None:
        return ''
    found = re.search(r'^- Lead session:[ \t]*(\S+)', path.read_text(encoding='utf-8'), re.M)
    return found.group(1) if found else ''


def caller_lead() -> tuple[str, str]:
    """위임의 발신자 검증 — 환경 ID 를 존재·본체·역할·가능한 대화 기록과 대조한다."""
    backend = screen.get_backend()
    info = backend.self_info()
    pane = str(info.get('pane_id') or '')
    if not info.get('inside'):
        return '', ''
    # 화면 안이지만 pane ID 가 아예 없다 = pane 이 아닌 앱 · 현황판이 불렀다(사이드바 [부르기] — 2026-11-08) → 화면 밖과 같다.
    # 있는데 모양이 틀리거나 아래 대조에 걸리면 그대로 막는다
    if not pane:
        return '', ''
    if not PANE_ID.fullmatch(pane):
        raise ValueError('부른 pane ID 를 확인하지 못했다')
    found = backend.get_pane(pane)
    name = str(found.get('label') or found.get('name') or found.get('pane_title') or '')
    if (found.get('id') != pane or found.get('agent') not in ('claude', 'codex')
            or not found.get('cwd') or os.path.realpath(str(found.get('cwd') or '')) != str(ATHENA_DIR)
            or name.startswith('🤖')):
        raise ValueError('부른 pane 이 이 본체의 아테나가 아니다')
    session = pane_session(pane)
    thread = os.environ.get('CODEX_THREAD_ID') or ''
    if thread and thread != session:
        raise ValueError('부른 Codex 대화와 pane 기록이 일치하지 않는다')
    return pane, session


def lead_target(lead: str, plan: str, me: str, session: str = '') -> str:
    """계획서의 명시한 담당만 따라간다. 포커스·후보 수는 소유권 근거가 아니다."""
    planned = plan_lead(plan)
    target = planned or lead
    if target == me:
        return WRONG_SESSION
    expected = plan_session(plan) if planned else ''
    if not expected and target == lead:
        expected = session
    if expected and pane_session(target) != expected:
        return WRONG_SESSION
    return target if alive(target) else NO_LEAD


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


UNCONFIRMED_HEAD = '보냈지만 전송을 확인하지 못했어요'


def unconfirmed(result: str) -> str:
    return f'보냈지만 전송을 확인하지 못했어요({result}) — 입력칸에 남았을 수 있어 다시 넣지 않았어요'


def track(entry: dict, kind: str, lead: str = '', pending: bool = False) -> str:
    """받음 확인 대상으로 남긴다 — 기록 id. 실패해도 보내기는 그대로(기록만 빠진다)"""
    try:
        return agent_turn.record_notice(kind, lead or str(entry.get('lead') or ''), str(entry.get('text') or ''), plan=str(entry.get('plan') or ''),
                                        pane=str(entry.get('pane') or ''), sender=str(entry.get('from') or ''), pending=pending)
    except Exception:
        return ''


def before_send(entry: dict, lead: str) -> None:
    """넣기 **전에** 기록을 만든다 — 넣자마자 아테나 입력 훅(pane-session.py)이 돌아도 받음 표시할 기록이 있게.
    추적하는 끝 알림은 turn, 아니면 넣었는지 모를 때를 대비한 unconfirmed(넣으면 지운다). 결과는 after_send 가 같은 기록에 고친다"""
    entry['_notice'] = track(entry, 'turn' if entry.get('track') else 'unconfirmed', lead, pending=True)


def after_send(entry: dict, result: str) -> None:
    """넣은 결과로 before_send 기록을 고친다 — sent: 추적이면 남기고 아니면 지움 · 못 넣음(wait · gone): 지움(다시 넣을 때 새로 만든다) · 그 밖(확인 못 함): unconfirmed"""
    notice = str(entry.pop('_notice', '') or '')
    if not notice:
        return
    try:
        if result == 'sent' and entry.get('track'):
            agent_turn.update_notice(notice, pending=False)
            entry['_tracked'] = True   # sent 가 또 남기지 않게
        elif result in ('sent', 'wait', 'gone'):
            agent_turn.drop_notice(notice)
        else:
            agent_turn.update_notice(notice, kind='unconfirmed', pending=False)
            entry['_tracked'] = True   # record_unsent 가 또 남기지 않게
    except Exception:
        pass


def sent(entry: dict, lead: str) -> None:
    # 보통은 before_send 기록이 이미 있다 — 그 기록을 못 만들었을 때만 지금 남긴다
    if entry.get('track') and not entry.pop('_tracked', False):
        track(entry, 'turn', lead)


def record_unsent(entry: dict, reason: str) -> bool:
    """넣지 못한(또는 넣었는지 모르는) 글을 기록만 한다 — 요청은 열지 않는다(고를 것이 없다).
    계획서 결과 절 끝에 글 그대로 한 줄 + 사건 기록(scripts/lib/events.mjs) 한 줄. 계획서에 적었으면 True"""
    if reason.startswith(UNCONFIRMED_HEAD) and not entry.pop('_tracked', False):
        track(entry, 'unconfirmed')   # 넣었는지 모른다 — 아테나가 받았는지로 가린다(안 받았으면 현황판이 다시 넣는다)
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


def send(lead: str, text: str, plan: str, tracked: bool = False) -> int:
    me = pane_request.caller_pane()
    entry = {'lead': lead, 'text': text, 'plan': plan, 'pane': me, 'from': os.environ.get('ATHENA_AGENT') or me, 'at': time.time()}
    if tracked:
        entry['track'] = True
    folder = queue_dir()
    target = lead_target(lead, plan, me)
    if target == WRONG_SESSION:
        return recorded(entry, SESSION_REASON)
    moved = f'계획서 담당 아테나 pane {target} 에 ' if target not in (lead, NO_LEAD) else f'아테나 pane {lead} 에 '
    if folder is None:
        # 옛 구조(팩 데이터 없음) — 모아 둘 자리가 없어 지금 보내 보고, 못 보내면 기록만
        if target != NO_LEAD:
            before_send(entry, target)
        result = 'gone' if target == NO_LEAD else try_send(target, text)
        after_send(entry, result)
        if result == 'sent':
            sent(entry, target)
            print(f'✅ {moved}보냈다')
            return 0
        reasons = {'gone': '아테나 pane 이 없어요', 'wait': '아테나가 지금 받을 수 없어요(모아 둘 자리가 없는 옛 구조)'}
        return recorded(entry, reasons.get(result, unconfirmed(result)))
    # 담당이 없으면 같은 담당 앞으로 보관한다. 계획서의 명시적 재배정만 따라간다
    key = (plan_lead(plan) or lead) if target == NO_LEAD else target
    entry['lead'] = key
    entry['session'] = plan_session(plan) or pane_session(key)
    with pane_lock(folder, key):
        if target == NO_LEAD or queued(folder, key):
            result = 'wait'
        else:
            before_send(entry, target)
            result = try_send(target, text)
            after_send(entry, result)
            if result == 'gone':
                result = 'wait'   # 고른 사이 닫혔다 — 처리기가 다시 고른다
        if result == 'wait':
            write_entry(folder, entry)
    if result == 'sent':
        sent(entry, target)
        print(f'✅ {moved}보냈다')
        return 0
    if result == 'wait':
        spawn_deliverer(key)
        if target == NO_LEAD:
            print(f'⏳ 담당 아테나 pane {key} 가 없어 모아 뒀다 — 같은 담당의 복귀 또는 계획서의 명시한 재배정을 기다린다. 요청을 따로 열지 않는다')
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
                # 대기 중에도 명시한 담당과 대화 소유권을 다시 확인한다
                target = lead_target(lead, str(entry.get('plan') or ''), str(entry.get('pane') or ''), str(entry.get('session') or ''))
                if target == WRONG_SESSION:
                    result = SESSION_REASON
                elif target == NO_LEAD:
                    result = 'wait'
                else:
                    before_send(entry, target)
                    result = try_send(target, str(entry.get('text') or ''))
                    after_send(entry, result)
                    result = 'wait' if result == 'gone' else result
                    result = result if result in ('sent', 'wait') else unconfirmed(result)
            if result != 'wait':
                if result == 'sent':
                    sent(entry, target)
                else:
                    record_unsent(entry, result)
                path.unlink(missing_ok=True)
                continue
        time.sleep(POLL_SECONDS)


def main(argv) -> int:
    if argv == ['--caller']:
        try:
            pane, session = caller_lead()
            print(f'{pane} {session}'.rstrip())
            return 0
        except Exception as error:
            print(f'아테나 발신자를 확인하지 못해 위임하지 않는다: {error}', file=sys.stderr)
            return 1
    if len(argv) == 2 and argv[0] == '--deliver':
        if PANE_ID.fullmatch(argv[1]):
            deliver(argv[1])
        return 0
    tracked = '--track' in argv[2:]
    argv = argv[:2] + [arg for arg in argv[2:] if arg != '--track']
    plan = ''
    if len(argv) == 4 and argv[2] == '--plan':
        plan = argv[3]
        argv = argv[:2]
    if len(argv) != 2 or not PANE_ID.fullmatch(argv[0]) or not argv[1].strip():
        print("사용: scripts/lead-send.py <아테나 pane> '<글>' [--plan <계획서>] [--track]", file=sys.stderr)
        return 2
    text = re.sub(r'\s*\n\s*', ' ', argv[1]).strip()
    return send(argv[0], text, plan or pane_request.plan_of(pane_request.caller_pane()), tracked)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
