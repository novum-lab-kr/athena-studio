"""계획서 고치기 — commit.sh·ship.sh·delegate.sh·review-result.sh·압축 훅과 일감·learn-review 가 같은 계획서를 동시에 고칠 수 있다.
읽기 → 바꾸기 → 쓰기를 계획서마다 잠금 하나(<계획서>.lock 폴더 — node 쪽 plan-update.mjs 와 같은 잠금) 안에서 하고,
쓰기는 임시 파일 → 바꿔치기로 한다. 정식 계획서의 결정 콘솔 html 안 md 사본(<script id="plan-md">)도 같은 잠금 안에서 맞춘다.
에이전트가 편집기로 직접 고치는 것까지 막지는 못한다(잠금을 모른다) — 스크립트끼리 서로의 기록을 덮어쓰지 않게 하는 것이다.

bash 에서:  ATHENA_DIR="$ATHENA_DIR" python3 - <계획서> … <<'PYEOF'
            import os, sys; sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
            update_plan(sys.argv[1], lambda text: text.replace(…))
"""
import contextlib
import os
import pathlib
import re
import shutil
import tempfile
import time

LOCK_WAIT_SECONDS = 15
STALE_SECONDS = 120


def _alive(pid):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _owner(lock):
    try:
        return int(pathlib.Path(lock, 'pid').read_text().strip() or 0)
    except (OSError, ValueError):
        return 0


@contextlib.contextmanager
def plan_lock(path):
    lock = f'{path}.lock'
    deadline = time.time() + LOCK_WAIT_SECONDS
    while True:
        # pid 를 넣은 임시 폴더를 잠금 이름으로 옮긴다 — rename 은 원자적이라 둘이 동시에 잡지 못하고 pid 없는 잠금이 보이는 틈도 없다
        staging = tempfile.mkdtemp(prefix='.plan-lock-', dir=os.path.dirname(os.path.abspath(lock)))
        pathlib.Path(staging, 'pid').write_text(str(os.getpid()))
        try:
            os.rename(staging, lock)
            break
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
        # 주인이 죽었거나 너무 오래된 잠금 — 고유한 이름으로 옮겨 치우고 다시
        try:
            age = time.time() - os.stat(lock).st_mtime
        except OSError:
            continue
        if not _alive(_owner(lock)) or age > STALE_SECONDS:
            stale = f'{lock}.stale-{os.getpid()}'
            try:
                os.rename(lock, stale)
                shutil.rmtree(stale, ignore_errors=True)
            except OSError:
                pass
            continue
        if time.time() > deadline:
            raise TimeoutError(f'계획서 잠금을 {LOCK_WAIT_SECONDS}초 기다려도 풀리지 않았다: {lock}')
        time.sleep(0.1)
    try:
        yield
    finally:
        release_lock(lock)


def release_lock(lock):
    """내 잠금일 때만, 다른 이름으로 먼저 옮긴 뒤 지운다(안의 pid 를 먼저 지우면 빈 폴더가 된 틈에 다른 쪽의 rename 이 그 자리를 차지한다)"""
    if _owner(lock) != os.getpid():
        return
    released = f'{lock}.released-{os.getpid()}-{time.time_ns()}'
    try:
        os.rename(lock, released)
        shutil.rmtree(released, ignore_errors=True)
    except OSError:
        pass


def write_atomic(path, text):
    path = pathlib.Path(path)
    temp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    temp.write_text(text, encoding='utf-8')
    os.replace(temp, path)


PLAN_MD_BLOCK = re.compile(r'(<script id="plan-md" type="text/markdown">)(.*?)(</script>)', re.S)


def sync_html(path, text):
    """정식 계획서는 같은 이름 .html(결정 콘솔)이 md 본문을 <script id="plan-md"> 에 그대로 담는다 — 있으면 같이 맞춘다"""
    html = pathlib.Path(path).with_suffix('.html')
    if not html.exists():
        return
    page = html.read_text(encoding='utf-8')
    if not PLAN_MD_BLOCK.search(page):
        return
    body = re.sub(r'</(script)', r'<\\/\1', text, flags=re.I)   # 본문 안의 닫는 태그(대소문자 변형 포함)가 블록을 끊지 않게
    write_atomic(html, PLAN_MD_BLOCK.sub(lambda match: match.group(1) + '\n' + body + match.group(3), page, count=1))


def update_plan(path, change):
    """잠금 안에서 지금 내용을 읽어 change(text) 로 바꾼다. 바꿀 게 없으면(None·같음) False. 바꾼 뒤 html 사본도 맞춘다"""
    path = pathlib.Path(path)
    with plan_lock(path):
        text = path.read_text(encoding='utf-8')
        updated = change(text)
        if updated is None or updated == text:
            return False
        write_atomic(path, updated)
        sync_html(path, updated)
        return True
