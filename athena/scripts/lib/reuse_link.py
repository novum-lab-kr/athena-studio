"""이어 보내기(delegate.sh --reuse-pane) 때 pane 기록(state/pane-sessions/<pane>.json)을 새 계획서로 잇는다.
pane-session.py 훅과 같은 잠금(<기록 폴더>/.<pane>.lock)으로 직렬화한다 — 지시를 보내면 훅이 곧바로 돌아 같은 파일을 읽고 쓰므로.

사용: python3 reuse_link.py link <아테나 폴더> <pane> <새 계획서>   → 되돌릴 정보를 JSON 한 줄로 출력 (기록 폴더 · pane 기록이 없어 못 이으면 비정상 종료)
      python3 reuse_link.py rollback <아테나 폴더> <pane> '<link 가 출력한 JSON>'
"""
import contextlib
import fcntl
import json
import os
import pathlib
import sys


def folder_of(athena):
    pack_data = pathlib.Path(athena) / '.pack-data'
    return pack_data.resolve() / 'state' / 'pane-sessions' if pack_data.is_symlink() else None


@contextlib.contextmanager
def pane_lock(folder, pane):
    folder.mkdir(parents=True, exist_ok=True)
    with open(folder / f'.{pane}.lock', 'w') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def write(folder, pane, record):
    temp = folder / f'.{pane}.{os.getpid()}.tmp'
    temp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, folder / f'{pane}.json')


def link(athena, pane, plan):
    folder = folder_of(athena)
    if not folder:
        raise ValueError('pane 기록 폴더(.pack-data)가 없다')   # 연결 없이 보내면 훅이 옛 계획서로 기록을 만든다 — 호출한 쪽이 보내기 전에 멈춘다
    with pane_lock(folder, pane):
        path = folder / f'{pane}.json'
        if not path.is_file():
            raise ValueError(f'pane {pane} 의 기록이 없다')
        record = json.loads(path.read_text(encoding='utf-8'))
        undo = {'plan': record.get('plan'), 'envPlan': record.get('envPlan')}
        record.setdefault('envPlan', record.get('plan'))   # pane 을 처음 띄울 때 환경 값(ATHENA_PLAN) — A→B→C 로 이어도 변하지 않는다
        record['plan'] = plan
        write(folder, pane, record)
        return undo


def rollback(athena, pane, undo):
    folder = folder_of(athena)
    if not folder or not undo:
        return
    with pane_lock(folder, pane):
        path = folder / f'{pane}.json'
        if not path.is_file():
            return
        record = json.loads(path.read_text(encoding='utf-8'))
        record['plan'] = undo.get('plan')
        if undo.get('envPlan') is None:
            record.pop('envPlan', None)
        else:
            record['envPlan'] = undo['envPlan']
        write(folder, pane, record)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'link':
            print(json.dumps(link(sys.argv[2], sys.argv[3], sys.argv[4]), ensure_ascii=False))
        elif sys.argv[1] == 'rollback':
            rollback(sys.argv[2], sys.argv[3], json.loads(sys.argv[4]))
    except Exception as error:
        print(f'pane 기록을 잇지 못했다: {error}', file=sys.stderr)
        sys.exit(1)
