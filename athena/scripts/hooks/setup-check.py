#!/usr/bin/env python3
"""첫 실행 점검 훅 (SessionStart) — Claude Code 는 .claude/settings.json, Codex 는 .codex/hooks.json(--tool codex) 이 아테나 세션에 건다.

회사 팩이 없으면 첫 실행(docs/setup.md)을 안내한다. herdr 안에서 새로 켠 세션이면 화면 세팅 뒤 workspace-up 훅(athena-up.sh)이
그 pane 에 첫 실행 지시(Claude `/setup` · Codex 문장)를 대신 입력하므로 사용자는 아무것도 치지 않아도 된다.

repos/<레포> 링크가 athena.config.json 목록대로 다 있으면 아무것도 하지 않는다.
빠진 게 있으면
  - 기본 레포 루트(reposRoot, 보통 hermes 상위 폴더)에서 찾은 것은 묻지 않고 scripts/setup.sh 로 바로 연결한다
  - 거기에도 없는 레포가 남으면 터미널 안내(systemMessage) + 아테나 지시(additionalContext) — 첫 응답에서 폴더 위치를 묻는다
FE 에이전트 세션(claude --agent), 바깥 도구가 띄운 세션(ATHENA_AGENT 가 있음 — 예: 서버의 nhm 창), athena 루트가 아닌 cwd(레포·워크트리)에서는 조용히 넘어간다.
자동 연결은 링크만 한다(setup.sh --links-only) — 사이드바 패치·QA 의존성·Chromium 같은 공용 도구 설치는 사용자가 /setup·setup.sh 로 직접.
어떤 오류가 나도 세션 시작을 막지 않는다(항상 exit 0).
"""
import json
import os
import subprocess
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

ATHENA_DIR = os.path.realpath(os.path.join(os.path.dirname(__file__), '..', '..'))
TOOL = sys.argv[sys.argv.index('--tool') + 1] if '--tool' in sys.argv[:-1] else 'claude'


def main() -> None:
    sys.path.insert(0, os.path.join(ATHENA_DIR, 'scripts', 'lib'))
    from athena_config import load, needs_first_run
    # 아테나 세션만 — 에이전트 세션·다른 cwd 는 건너뛴다
    if payload.get('agent_type'):  # claude --agent 로 뜬 세션(실측 2026-09-30)
        return
    # 바깥 도구가 띄운 세션(ATHENA_AGENT — 서버의 nhm 창 등)은 아테나를 켜는 자리가 아니다. /setup 안내·자동 연결을 하지 않는다
    if os.environ.get('ATHENA_AGENT'):
        return
    cwd = os.path.realpath(payload.get('cwd') or os.getcwd())
    if cwd != ATHENA_DIR:
        return
    if payload.get('source') not in (None, 'startup', 'clear'):
        return

    # 새 회사 첫 실행 — 설정·팩이 없거나 레포가 0개면 첫 실행(레포 찾기부터). herdr 에서 새로 켰으면 지시가 자동으로 입력된다
    if needs_first_run(ATHENA_DIR):
        import screen  # 화면 pane 안에서 새로 켠 세션이면 workspace-up 훅이 첫 실행 지시를 대신 입력한다
        me = screen.self_info()
        auto = me['inside'] and me['pane_id'] and payload.get('source') in (None, 'startup')
        how = '/setup 스킬을 부른다' if TOOL == 'claude' else 'docs/setup.md 절차를 0단계부터 그대로 한다'
        print(json.dumps({
            'systemMessage': ('🌱 아직 회사 팩이 없습니다 — 화면 세팅이 끝나면 아테나가 첫 실행(레포 찾기 → 팩 → 뼈대 → 검증 → 지문)을 바로 시작합니다.' if auto
                              else '🌱 아직 회사 팩이 없습니다 — 아무 말이나 입력하면 아테나가 첫 실행(레포 찾기 → 팩 → 뼈대 → 검증 → 지문)을 시작합니다.'),
            'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': (
                '[setup-check] 회사 팩이 없다(athena.config.json 의 pack 이 없거나 pack.json 에 레포가 0개). '
                f'사용자의 첫 메시지가 무엇이든 먼저 한 줄로 알리고 {how}(환경 설정이라 계획서 없이 진행). '
                '이미 만든 팩을 받을 회사면 packs/<회사> 에 clone 하고 athena.config.json 에 pack 을 적은 뒤 bin/athena pack link 하면 된다 — 첫 실행 0단계가 먼저 그걸 묻는다.'
            )},
        }, ensure_ascii=False))
        return
    config = load(ATHENA_DIR)
    names = [repo['name'] for repo in config.get('repos', [])]

    def is_repo(path: str) -> bool:
        return os.path.exists(os.path.join(path, '.git'))

    missing = [name for name in names if not is_repo(os.path.join(ATHENA_DIR, 'repos', name))]
    if not missing:
        return

    repos_root = config.get('reposRoot') or '..'
    if not os.path.isabs(repos_root):
        repos_root = os.path.join(ATHENA_DIR, repos_root)
    repos_root = os.path.realpath(repos_root)
    # 폴더로 묶여 있는 레포는 repoPaths(이 컴퓨터 설정)에 위치가 있다
    repo_paths = config.get('repoPaths') or {}
    found = [name for name in missing if is_repo(os.path.join(repos_root, repo_paths.get(name, name)))]

    # 기본 위치에서 찾은 레포는 묻지 않고 바로 연결한다 — 사용자가 setup.sh 를 몰라도 되게
    messages = []
    if found:
        subprocess.run(['bash', os.path.join(ATHENA_DIR, 'scripts', 'setup.sh'), '--links-only'], cwd=ATHENA_DIR,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=40, check=False)
        linked = [name for name in found if is_repo(os.path.join(ATHENA_DIR, 'repos', name))]
        if linked:
            messages.append(f'🔗 레포 {len(linked)}개를 자동으로 연결했습니다 ({", ".join(linked)} → {repos_root})')
    still_missing = [name for name in names if not is_repo(os.path.join(ATHENA_DIR, 'repos', name))]
    if not still_missing:
        print(json.dumps({'systemMessage': messages[0]}, ensure_ascii=False))
        return

    # 기본 위치에 없는 레포만 남았다 — 어디 있는지는 사용자만 안다
    messages.append(f'⚙️  {len(still_missing)}개 레포를 {repos_root} 에서 찾지 못했습니다 ({", ".join(still_missing)}). 아무 말이나 입력하면 아테나가 위치를 물어 연결합니다.')
    system_message = '\n'.join(messages)
    context = (
        f'[setup-check] repos/ 링크 점검: {repos_root} 에서 찾은 레포는 훅이 이미 scripts/setup.sh 로 자동 연결했다. '
        f'남은 {len(still_missing)}개는 그 위치에 없다 — {", ".join(still_missing)}. '
        '사용자의 첫 메시지가 무엇이든 그 작업보다 먼저 이것을 처리한다(환경 설정이라 계획서 없이 진행한다). 한 줄로 알리고 곧바로 AskUserQuestion 으로 묻는다 — '
        "질문 '이 레포들이 있는 폴더가 어디인가요?', header '레포 위치', 선택지: "
        "'폴더 경로 입력'(description 'Other 에 레포들이 나란히 있는 폴더 경로를 적어 주세요'), "
        "'아직 clone 안 함'(description 'clone 할 레포와 위치를 안내합니다'), '나중에'(description '지금은 건너뜀. 연결 안 된 레포의 에이전트는 동작하지 않음'). "
        '경로를 받으면 scripts/setup.sh --root <경로> 를 실행하고 ✔/✖ 줄을 요약한다. clone 은 사용자에게 묻고 한다. 끝나면 원래 요청으로 돌아간다. '
        "'나중에'면 더 묻지 않고 원래 요청을 진행하되, 연결 안 된 레포가 필요한 작업이면 그때 알린다."
    )
    print(json.dumps({
        'systemMessage': system_message,
        'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': context},
    }, ensure_ascii=False))


try:
    main()
except Exception:
    pass
sys.exit(0)
