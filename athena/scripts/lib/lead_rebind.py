"""아테나 pane 의 대화가 바뀌었을 때 계획서 Lead session · 모아 둔 lead-send 글을 새 대화로 옮긴다.

부르는 곳: scripts/lead-fresh.py(스스로 새로 시작 — /clear · /new 를 넣은 뒤) · scripts/hooks/pane-session.py(사용자가 손으로 /clear ·
Codex /new — SessionStart source=clear). Lead session 은 delegate.sh 만 적어서, 대화가 바뀐 뒤 아무도 옮기지 않으면 에이전트 보고가
"담당 대화가 바뀌었다" 로 막힌다(2026-11-11 p1m — lead-send.py 는 계획서 Lead session 과 pane 의 지금 대화를 맞춰 본다).
"""
import json
import os
import pathlib
import re

import pane_request  # 팩 데이터 자리(pack_state)
from plan_update import update_plan  # 계획서 고치기(잠금 · 바꿔치기)
from reuse_link import pane_lock  # lead-send 대기열과 같은 잠금

ATHENA_DIR = pathlib.Path(__file__).resolve().parent.parent.parent
CLOSED_STATUS = ('done', 'cancelled')


def rebind(pane: str, old: str, new: str, named=None) -> int:
    """이 pane 이 Lead pane 인 진행 중 계획서 중 Lead session 이 옛 대화(old)인 것을 새 대화(new)로 — 옮긴 계획서 수.
    named(넘긴 계획서)는 이 아테나 pane 것이면 Lead session 이 옛 대화가 아니어도 옮긴다 — 방금 Checkpoint 를 갱신하고 넘긴
    계획서라 이 아테나가 맡은 것이 확실하다. 다른 계획서는 어느 대화 것인지 알 수 없어 옛 대화와 같을 때만 옮긴다.
    lead-send 대기열(<팩 데이터>/state/lead-send/<pane>-*.json)도 옛 대화로 모아 둔 글은 새 대화로 바꾼다"""
    if not new or old == new:
        return 0
    named = named.resolve() if named else None
    moved = 0
    for path in sorted((ATHENA_DIR / 'plans').rglob('*.md')):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        lead = re.search(r'^- Lead pane:[ \t]*(\S+)', text, re.M)
        status = re.search(r'^- Status:[ \t]*(\S+)', text, re.M)
        if not lead or lead.group(1) != pane:
            continue
        if status and status.group(1) in CLOSED_STATUS:
            continue
        # 넘긴 계획서는 어느 대화를 가리키든 · 다른 계획서는 옛 대화를 가리킬 때만
        if named is not None and path.resolve() == named:
            target = r'\S+'
        elif old:
            target = re.escape(old)
        else:
            continue
        if not re.search(rf'^- Lead session:[ \t]*{target}[ \t]*$', text, re.M):
            continue

        def swap(current: str, target=target):
            changed = re.sub(rf'^- Lead session:[ \t]*{target}[ \t]*$', f'- Lead session: {new}', current, count=1, flags=re.M)
            return changed if changed != current else None
        try:
            update_plan(str(path), swap)
            moved += 1
        except Exception:
            pass
    base = pane_request.pack_state()
    queue = base / 'lead-send' if base else None
    if old and queue and queue.is_dir():
        with pane_lock(queue, pane):
            for entry_path in sorted(queue.glob(f'{pane}-*.json')):
                try:
                    entry = json.loads(entry_path.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    continue
                if entry.get('session') == old:
                    entry['session'] = new
                    temp = entry_path.with_name(f'.{entry_path.name}.tmp')
                    temp.write_text(json.dumps(entry, ensure_ascii=False) + '\n', encoding='utf-8')
                    os.replace(temp, entry_path)
    return moved
