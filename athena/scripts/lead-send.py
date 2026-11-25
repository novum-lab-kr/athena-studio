#!/usr/bin/env python3
"""에이전트 → 아테나 pane 한 줄 보내기 — 받을 수 없으면 모아 뒀다 넣는다(위임 지시문 delegate.sh LEAD_RULE 이 이 명령을 알려 준다).

  scripts/lead-send.py <아테나 pane> '<글>' [--plan <계획서>] [--track | --note]

보내기는 `scripts/screen pane send-text <pane> <글> --enter` 와 같은 길(데몬 pane run — 전송 확인 · 재시도).
[작업] 에는 사람이 고를 것이 있을 때만 뜬다 — 이 명령은 요청을 열지 않는다(고를 것이 없다). 글은 버리지 않고 넣거나 기록한다(GitHub #134).
- 보냈다 → 끝
- 아테나 pane 이 살아 있는데 지금 못 받는다(질문 · 고르기 창 · 다른 전송 중) → 대기열에 두고, 뒤에서 처리기가
  창이 닫히면 들어온 차례대로 넣는다. 앞에 미룬 글이 있으면 새 글도 뒤에 줄 선다(차례를 지킨다)
- 담당은 계획서 "- Lead pane:"가 우선이다. 없으면 명시한 인자를 쓴다. 담당이 살아 있으면 유일/focused pane 으로 대체하지 않는다.
- 담당(계획서 Lead pane)이 닫혔다 → 떠 있는 아테나에게 넘기고 계획서 Lead pane · Lead session 을 그 아테나로 바꾼다(2026-11-26 사용자 결정).
  여럿이면 사용자가 보고 있는(focused) 아테나 → 가장 최근에 쓴 아테나. 넘기는 글 앞에 `[이어받음 · 원래 담당 <pane> 닫힘] 계획서 <경로>` 를 붙인다.
  떠 있는 아테나가 없으면 같은 담당 앞으로 모아 두고 기다린다(떠 있는 아테나가 생기면 그때 넘긴다). 살아 있는데 잠깐 못 받는 담당은 넘기지 않는다.
- 계획서 Lead session 또는 대기열에 저장한 대화가 달라졌다 → 새 대화로 넣지 않고 기록한다.
- 기록만 — 전송을 확인하지 못했다(글이 입력칸에 남았을 수 있어 다시 넣지 않는다) · 담당 대화가 달라졌다 · 6시간을 넘겼다 ·
  옛 구조(팩 데이터 없음)에서 못 보냈다 → 계획서 결과 절에 글 그대로 한 줄 + 사건 기록(state/events.jsonl `lead-send-unsent`)
기다리는 값은 기존 장치 그대로 — 2초마다 · 최대 6시간(pane_request.py POLL_SECONDS · GIVE_UP_SECONDS · agent-done-notify.py 와 같다).
받음 확인(scripts/lib/agent_turn.py · state/lead-notices) — 전송을 확인하지 못한 글은 늘, --track(끝 알림 훅이 붙인다)이면 넣은 글도 남긴다.
  에이전트 pane 이 직접 넣은 보고(ATHENA_AGENT 있음 · --track 없음)도 넣은 글을 남기고, 그 차례에 보고했다고 적는다
  (state/agent-notify/<pane>.json reported) — 끝 알림 훅이 같은 차례의 "끝" 줄을 따로 넣지 않는다(한 차례에 아테나를 두 번 깨우지 않기)
  아테나 pane 의 입력 훅(pane-session.py)이 그 글을 받으면 표시하고, 안 받았으면 현황판이 2분 뒤 한 번 다시 넣고 10분이면 [작업] 요청을 연다.
--note(scripts/lead-fresh.py 가 에이전트 pane 을 새로 시작한 뒤 붙인다) = 알림만 — 에이전트 pane 에서 보내도 받음 확인 대상으로 남기지 않고
  그 차례의 직접 보고로 적지 않는다(끝 알림을 대신하지 않는다 · 안 받았다고 다시 넣거나 요청을 열지 않는다). 넣기 · 모아 두기 · 기록은 같다
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
    """계획서 실제 파일 — 본체 기준 논리 경로(plans/…md) · 절대 경로 모두. 이 본체 계획서 폴더 밖이거나 없으면 None
    (에이전트가 넘긴 값이라 읽기 · 고쳐 쓰기 모두 폴더 안으로 묶는다 — agent_turn.plan_path)"""
    return agent_turn.plan_path(plan)


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
    if not alive(target):
        return NO_LEAD   # 닫힌 담당은 대화 대조보다 먼저 — 떠 있는 아테나에게 넘기거나(take_over) 모아 둔다
    expected = plan_session(plan) if planned else ''
    if not expected and target == lead:
        expected = session
    if expected and pane_session(target) != expected:
        return WRONG_SESSION
    return target


def floating_leads(skip: set) -> list:
    """떠 있는 이 본체의 아테나 pane — 사용자가 보고 있는(focused) 것 먼저, 그다음 가장 최근에 쓴 순(pane-sessions 기록의 at — 입력마다 새로 적힌다).
    아테나 판정은 caller_lead 와 같다(claude · codex · cwd 가 본체 · 위임 이름표 🤖 아님). 목록을 못 읽으면 []"""
    try:
        panes = screen.get_backend().list_panes(timeout=5)
    except Exception:
        return []
    base = pane_request.pack_state()
    found = []
    for pane in panes:
        pane_id = str(pane.get('id') or '')
        name = str(pane.get('label') or pane.get('name') or pane.get('pane_title') or '')
        if (not PANE_ID.fullmatch(pane_id) or pane_id in skip or pane.get('agent') not in ('claude', 'codex') or name.startswith('🤖')
                or not pane.get('cwd') or os.path.realpath(str(pane.get('cwd'))) != str(ATHENA_DIR)):
            continue
        used = ''
        if base is not None:
            try:
                used = str(json.loads((base / 'pane-sessions' / f'{pane_id}.json').read_text(encoding='utf-8')).get('at') or '')
            except (OSError, ValueError):
                used = ''
        found.append((bool(pane.get('focused')), used, pane_id))
    return [pane_id for _focused, _used, pane_id in sorted(found, reverse=True)]


def takeover_head(closed: str, plan: str) -> str:
    return f'[이어받음 · 원래 담당 {closed} 닫힘] 계획서 {plan} '


def take_over(plan: str, me: str) -> tuple[str, str]:
    """담당 아테나(계획서 Lead pane)가 닫혔을 때 떠 있는 아테나에게 넘긴다(2026-11-26 사용자 결정 — 계획서 D3 · F4) — (새 담당, 닫힌 담당).
    계획서의 Lead pane · Lead session 을 새 담당으로 바꾼다(그 뒤 담당은 이어받은 아테나 하나 — 원래 담당이 돌아와도 둘이 되지 않는다).
    떠 있는 아테나가 없거나 계획서에 Lead pane 줄이 없으면 ('', '') — 지금처럼 모아 둔다. 살아 있는데 잠깐 못 받는 담당은 여기 오지 않는다"""
    path = plan_file(plan)
    closed = plan_lead(plan)
    if path is None or not closed or alive(closed):
        return '', ''
    picked = (floating_leads({closed, me}) or [''])[0]
    if not picked:
        return '', ''
    session = pane_session(picked)
    moved = []

    def rebind(text: str) -> str:
        now = re.search(r'^- Lead pane:[ \t]*(\S+)', text, re.M)
        if not now or now.group(1) != closed:
            return text   # 그새 다른 쪽이 담당을 바꿨다 — 그 값을 따른다
        moved.append(picked)
        text = re.sub(r'^- Lead pane:[^\n]*$', f'- Lead pane: {picked}', text, count=1, flags=re.M)
        text = re.sub(r'^- Lead session:[^\n]*\n', '', text, flags=re.M)
        if session:
            text = re.sub(r'^(- Lead pane:[^\n]*\n)', lambda found: f'{found.group(1)}- Lead session: {session}\n', text, count=1, flags=re.M)
        return text
    try:
        update_plan(str(path), rebind)
    except Exception:
        return '', ''
    if not moved:
        return '', ''
    try:
        subprocess.run(['node', str(ATHENA_DIR / 'scripts' / 'lib' / 'events.mjs'), 'lead-takeover', f'plan={plan}', f'from={closed}', f'to={picked}'],
                       capture_output=True, text=True, timeout=10)
    except Exception:
        pass   # 사건 기록 실패는 무시
    return picked, closed


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


def note_report(me: str, plan: str) -> None:
    """에이전트의 직접 보고를 그 차례에 적는다 — 끝 알림 훅이 같은 차례의 끝 줄을 따로 넣지 않게(한 차례에 두 번 깨우지 않기).
    실패해도 보내기는 그대로(끝 줄이 한 번 더 갈 뿐)"""
    path = plan_file(plan)
    try:
        agent_turn.mark_reported(me, path.read_text(encoding='utf-8') if path else '')
    except Exception:
        pass


def send(lead: str, text: str, plan: str, tracked: bool = False, note: bool = False) -> int:
    me = pane_request.caller_pane()
    entry = {'lead': lead, 'text': text, 'plan': plan, 'pane': me, 'from': os.environ.get('ATHENA_AGENT') or me, 'at': time.time()}
    # 에이전트가 직접 넣는 보고(끝 알림 훅은 --track 을 붙인다) — 그 차례의 끝 줄을 대신하니 끝 줄처럼 받음 확인 대상으로 남긴다
    direct = not tracked and not note and bool(os.environ.get('ATHENA_AGENT')) and bool(me)
    if tracked or direct:
        entry['track'] = True
    folder = queue_dir()
    target = lead_target(lead, plan, me)
    if target == NO_LEAD:
        # 담당이 닫혔다 — 떠 있는 아테나가 있으면 넘기고 담당을 바꾼다(없으면 아래에서 지금처럼 모아 둔다)
        picked, closed = take_over(plan, me)
        if picked:
            text = takeover_head(closed, plan) + text
            entry['text'] = text
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
            if direct:
                note_report(me, plan)
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
    if direct and result in ('sent', 'wait'):
        note_report(me, plan)   # 모아 둔 보고도 — 처리기가 넣는다
    if result == 'sent':
        sent(entry, target)
        print(f'✅ {moved}보냈다')
        return 0
    if result == 'wait':
        spawn_deliverer(key)
        if target == NO_LEAD:
            print(f'⏳ 담당 아테나 pane {key} 가 닫혔고 떠 있는 아테나도 없어 모아 뒀다 — 아테나가 뜨면 그쪽으로 넘긴다. 요청을 따로 열지 않는다')
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
                if target == NO_LEAD:
                    # 기다리는 동안 담당이 닫혔다(또는 처음부터 없었다) — 떠 있는 아테나가 생기면 넘긴다
                    picked, closed = take_over(str(entry.get('plan') or ''), str(entry.get('pane') or ''))
                    if picked:
                        entry['text'] = takeover_head(closed, str(entry.get('plan') or '')) + str(entry.get('text') or '')
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
    note = '--note' in argv[2:]
    if tracked and note:
        print('--track 과 --note 는 같이 쓰지 않는다', file=sys.stderr)
        return 2
    argv = argv[:2] + [arg for arg in argv[2:] if arg not in ('--track', '--note')]
    plan = ''
    if len(argv) == 4 and argv[2] == '--plan':
        plan = argv[3]
        argv = argv[:2]
    if len(argv) != 2 or not PANE_ID.fullmatch(argv[0]) or not argv[1].strip():
        print("사용: scripts/lead-send.py <아테나 pane> '<글>' [--plan <계획서>] [--track | --note]", file=sys.stderr)
        return 2
    text = re.sub(r'\s*\n\s*', ' ', argv[1]).strip()
    return send(argv[0], text, plan or pane_request.plan_of(pane_request.caller_pane()), tracked, note)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
