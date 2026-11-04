#!/usr/bin/env python3
"""본체 .codex/hooks.json 훅을 Codex 가 믿는지 점검한다 — setup.sh 의 도구 점검이 부른다.

사용: codex-hook-trust.py <폴더>
- Codex 공식 app-server 의 hooks/list 로 그 폴더의 project 출처 훅 trustStatus 를 센다.
  믿음 키 존재 · 해시 일치는 Codex 가 판단한다(trusted · untrusted=기록 없음 · modified=내용이 바뀜).
  config.toml 을 직접 읽지 않고, 해시 · 키 · 명령 원문은 출력하지 않는다 — 개수만.
- 출력 한 줄: `<전체> <믿음 없음> <바뀜>` · 종료 코드 0 모두 믿음 / 1 믿음 표시가 필요한 훅 있음 / 2 점검 못 함
"""
import json
import pathlib
import signal
import subprocess
import sys

TIMEOUT = 20


def listed(folder: str):
    process = subprocess.Popen(['codex', 'app-server', '--stdio'], cwd=folder, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def expired(_signum, _frame):
        raise TimeoutError

    previous = signal.signal(signal.SIGALRM, expired)
    signal.alarm(TIMEOUT)
    try:
        for message in ({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'athena-hook-trust', 'version': '1'}}},
                        {'method': 'initialized'},
                        {'id': 2, 'method': 'hooks/list', 'params': {'cwds': [folder]}}):
            process.stdin.write((json.dumps(message) + '\n').encode())
        process.stdin.flush()
        for line in process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get('id') == 2:
                return message.get('result')
        return None
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main() -> int:
    if len(sys.argv) != 2:
        print('사용: codex-hook-trust.py <폴더>', file=sys.stderr)
        return 2
    folder = str(pathlib.Path(sys.argv[1]).resolve())
    try:
        result = listed(folder)
    except (OSError, TimeoutError):
        return 2
    if not isinstance(result, dict) or not isinstance(result.get('data'), list):
        return 2
    statuses = [hook.get('trustStatus') for entry in result['data'] if isinstance(entry, dict)
                for hook in entry.get('hooks') or [] if isinstance(hook, dict) and hook.get('source') == 'project']
    untrusted = statuses.count('untrusted')
    modified = statuses.count('modified')
    print(f'{len(statuses)} {untrusted} {modified}')
    return 1 if untrusted or modified else 0


if __name__ == '__main__':
    sys.exit(main())
