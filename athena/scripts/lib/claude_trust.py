"""위임 에이전트(Claude)를 띄우기 전에 워크트리 폴더 믿음을 ~/.claude.json 에 미리 적어 둔다 — delegate.sh 가 부른다.

맥에서 처음 쓰는 레포의 새 워크트리에 Claude 를 띄우면 "이 폴더를 믿을까요?" 창이 한 번 떠서 사람이 눌러야 했다.
Claude Code 는 projects.<폴더 실제 경로>.hasTrustDialogAccepted 가 true 면 그 창을 건너뛴다
(2026-11-19 Claude Code 2.1.328 실측 — 새 레포 워크트리: 칸 없음 → 창이 뜸 · 워크트리 경로에 true → 창 없음.
 창에서 직접 고르면 Claude 는 메인 체크아웃 경로에 적지만 워크트리 경로 칸으로도 건너뛴다).

지키는 것
- 아테나가 만든 워크트리(지금 팩의 worktrees 자리 안 · .git 이 파일인 연결 워크트리 맨 위)만 — 다른 폴더는 믿음 표시하지 않는다
- ~/.claude.json 은 다른 Claude 세션이 같이 쓰는 파일 — Claude 가 설정을 쓸 때 잡는 잠금(~/.claude.json.lock 폴더 ·
  proper-lockfile 방식 mkdir — 2.1.328 실행 파일에서 확인)을 같이 잡고 읽기부터 rename 까지 한다. 잠금 안에서 그 칸만 고쳐
  같은 폴더의 임시 파일 → rename 으로 바꾸고, 잠금 없이 쓰는 경우(Claude 의 잠금 실패 대비 길)를 위해 쓰기 직전에 파일이 바뀌었으면 다시 읽는다
- 잠금을 못 잡으면(다른 세션이 오래 쥠 · 오래된 잠금) 쓰지 않는다 — 남의 잠금을 지우지 않는다
- 파일이 없거나 JSON 이 깨졌거나 모양이 다르면 쓰지 않는다(지금처럼 창이 뜬다)
- 파일 내용은 어디에도 찍지 않는다 — 결과 낱말 하나만

CLI: python3 claude_trust.py <athena 루트> <작업 폴더>  → marked · already · skip:<이유> 한 줄 · 종료 코드는 늘 0(띄우기를 막지 않는다)
"""
import json
import os
import sys
import tempfile
import time

import athena_config

KEY = 'hasTrustDialogAccepted'
RETRIES = 3
LOCK_WAIT = 3.0  # 초 — Claude 는 설정을 쓰는 동안만 잠금을 쥔다(오래된 잠금 기준 10초)


def config_link():
    """Claude 가 여는 전역 설정 파일 자리 — 잠금 폴더는 이 이름 뒤에 .lock(Claude 와 같은 자리)"""
    return os.path.join(os.path.expanduser('~'), '.claude.json')


def config_path():
    """Claude 전역 설정 파일 — 링크면 가리키는 실제 파일(rename 이 링크를 파일로 바꾸지 않게)"""
    return os.path.realpath(config_link())


def acquire(lock, wait=LOCK_WAIT):
    """Claude 와 같은 잠금 폴더를 mkdir 로 잡는다 — 잡으면 True · 기다려도 못 잡으면 False(남의 잠금은 지우지 않는다)"""
    deadline = time.monotonic() + wait
    while True:
        try:
            os.mkdir(lock)
            return True
        except FileExistsError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)


def worktree_of(athena_dir, workdir):
    """믿음을 적을 경로 — 지금 팩 worktrees 자리 안의 연결 워크트리 맨 위면 그 실제 경로, 아니면 None"""
    root = athena_config.paths(athena_dir).get('worktrees')
    if not root or not os.path.isdir(root):
        return None
    real_root = os.path.realpath(root)
    real = os.path.realpath(workdir)
    if not real.startswith(real_root + os.sep):
        return None
    # 연결 워크트리 맨 위만 — .git 이 파일(gitdir: …)이다. 레포 폴더(<자리>/<레포>)나 그 안의 하위 폴더는 아니다
    if not os.path.isfile(os.path.join(real, '.git')):
        return None
    return real


def _stamp(path):
    info = os.stat(path)
    return (info.st_ino, info.st_size, info.st_mtime_ns)


def mark(target, path=None, lock=None):
    """target 칸에 믿음을 적는다 — 결과 낱말(marked · already · skip:<이유>)"""
    path = path or config_path()
    lock = lock or config_link() + '.lock'
    if not os.path.exists(path):
        return 'skip:no-config'
    try:
        held = acquire(lock)
    except OSError:
        return 'skip:unwritable'
    if not held:
        return 'skip:busy'
    try:
        return _write_locked(target, path)
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


def _write_locked(target, path):
    """잠금을 쥔 채로 읽고 → 그 칸만 고쳐 → rename"""
    for _ in range(RETRIES):
        try:
            before = _stamp(path)
            with open(path, encoding='utf-8') as handle:
                data = json.load(handle)
        except FileNotFoundError:
            return 'skip:no-config'
        except (OSError, ValueError):
            return 'skip:unreadable'
        if not isinstance(data, dict):
            return 'skip:shape'
        projects = data.setdefault('projects', {})
        if not isinstance(projects, dict):
            return 'skip:shape'
        entry = projects.setdefault(target, {})
        if not isinstance(entry, dict):
            return 'skip:shape'
        if entry.get(KEY) is True:
            return 'already'
        entry[KEY] = True
        folder = os.path.dirname(path)
        try:
            handle_fd, temp = tempfile.mkstemp(dir=folder, prefix='.claude.json.athena-')
        except OSError:
            return 'skip:unwritable'
        try:
            with os.fdopen(handle_fd, 'w', encoding='utf-8') as handle:
                json.dump(data, handle, indent=2, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp, os.stat(path).st_mode & 0o777)
            # 잠금 없이 쓴 세션(Claude 의 잠금 실패 대비 길)이 있었으면 그 내용을 덮지 않게 처음부터 다시
            if _stamp(path) != before:
                os.unlink(temp)
                continue
            os.replace(temp, path)
            return 'marked'
        except OSError:
            try:
                os.unlink(temp)
            except OSError:
                pass
            return 'skip:unwritable'
    return 'skip:busy'


def pretrust(athena_dir, workdir, path=None):
    target = worktree_of(athena_dir, workdir)
    if not target:
        return 'skip:outside'
    return mark(target, path)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('사용: claude_trust.py <athena 루트> <작업 폴더>', file=sys.stderr)
        sys.exit(2)
    try:
        print(pretrust(sys.argv[1], sys.argv[2]))
    except Exception as error:  # 띄우기를 막지 않는다 — 실패하면 지금처럼 창이 뜬다
        print(f'skip:error {type(error).__name__}')
