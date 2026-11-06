#!/usr/bin/env python3
"""Codex 시작·재개·압축 뒤 필수 규칙과 계획서 재확인 안내. 사용자 설정은 바꾸지 않는다."""
import json
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/lib'))
import rule_docs


IMPORT = re.compile(r'^@(\S+)\s*$')


def expand_imports(path, seen):
    """Claude 의 @import 와 같은 결과 — 한 줄 전체가 `@<상대 경로>` 인 줄을 그 파일 본문으로 바꾼다(그 안의 참조도).
    본체 AGENTS.md 는 Codex CLI 가 이미 읽으니 seen 에 넣어 두고 건너뛴다. 못 읽은 참조는 경로를 남겨 직접 읽게 한다."""
    out = []
    for line in path.read_text(encoding='utf-8').splitlines():
        match = IMPORT.match(line)
        if not match:
            out.append(line)
            continue
        # 안내에는 본체 기준 경로(링크를 풀지 않음 — pack 은 팩 데이터로 가는 링크) · 겹침 판정은 실제 파일로
        target = pathlib.Path(os.path.normpath(path.parent / match.group(1)))
        if target.resolve() in seen:
            continue
        seen.add(target.resolve())
        try:
            out.append(expand_imports(target, seen))
        except OSError:
            out.append(f'(불러오지 못한 참조 — 직접 읽는다: {target})')
    return '\n'.join(out)


def lead_context():
    """본체 리드 세션 문맥 — Claude 가 CLAUDE.md 로 받는 것(team-lead.md · 그 안의 pack/ROUTING.md 본문)을 그대로."""
    claude = ROOT / 'CLAUDE.md'
    try:
        return expand_imports(claude, {claude.resolve(), (ROOT / 'AGENTS.md').resolve()})
    except OSError:
        return f'본체 팀 리드 필수 진입: {ROOT / "docs/team-lead.md"}와 {ROOT / "pack/ROUTING.md"}를 먼저 읽는다. 위임 세션에는 적용하지 않는다.'


def context(payload):
    source = payload.get('source', 'startup')
    parts = []
    agent = os.environ.get('ATHENA_AGENT', '')
    if not agent:
        # 본체의 AGENTS.md는 CLI가 읽는다. Claude만 자동으로 읽는 공통 규칙 · CLAUDE.md 의 리드 규칙은 본문째 전달한다.
        for path in sorted((ROOT / '.claude/rules').glob('*.md')):
            parts.append(path.read_text(encoding='utf-8'))
        parts.append(lead_context())
    if source in ('compact', 'resume'):
        current = os.environ.get('ATHENA_CODEX_CONTEXT') if agent else None
        if current:
            try:
                path = pathlib.Path(current)
                stat = path.lstat()
                if not path.is_symlink() and stat.st_uid == os.getuid() and stat.st_size <= 400000:
                    snapshot = json.loads(path.read_text(encoding='utf-8'))
                    if isinstance(snapshot, str) and len(snapshot) <= 90000:
                        parts.append('이번 위임의 현재 규칙 원문이다. 이전 실행의 같은 범위 규칙과 다르면 이 원문을 따른다.\n\n' + snapshot)
                    else:
                        parts.append(f'현재 위임 규칙 원문을 먼저 읽는다: {path}')
            except (OSError, ValueError):
                parts.append('현재 위임 규칙 스냅샷을 읽지 못했다. 본체·레포 규칙과 계획서 Checkpoint를 직접 다시 읽는다.')
        cwd = payload.get('cwd') or os.getcwd()
        listed = rule_docs.prepare(str(ROOT), agent, cwd, 'codex')['listed'] if agent else []
        # --tool=codex — 대화 원문 자리를 Codex 기록(rollout jsonl · 훅 입력 transcript_path 가 없으면 세션 id 로)으로 알린다(scripts/transcript-search.mjs 가 읽는다)
        result = subprocess.run(
            [sys.executable, str(ROOT / 'scripts/hooks/compact-checkpoint.py'), 'post', '--tool=codex', *listed],
            input=json.dumps({**payload, 'source': 'compact'}), text=True, capture_output=True, timeout=15)
        if result.stdout.strip():
            parts.append(json.loads(result.stdout)['hookSpecificOutput']['additionalContext'])
        parts.append(f'재개·압축 후 필수 규칙 재확인: {ROOT / "AGENTS.md"} 2.6·4·5·6절과 작업 레포 규칙을 다시 읽고 계획서 Next를 현재 diff와 대조한다. 위임 세션은 AGENTS의 팀 리드 전용 절을 적용하지 않는다.')
    return '\n\n'.join(parts)


if __name__ == '__main__':
    try:
        message = context(json.load(sys.stdin))
        if message:
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': message}}, ensure_ascii=False))
    except Exception as error:
        print(f'Codex 필수 규칙 재확인 안내를 만들지 못했다: {type(error).__name__}', file=sys.stderr)
