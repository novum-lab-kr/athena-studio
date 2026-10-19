#!/usr/bin/env bash
# /call 이 에이전트를 띄우기 전에 아테나가 브랜치를 묻는 데 쓰는 정보.
#   워크트리를 먼저 만들고 그 폴더에서 에이전트를 띄워야 pane 의 작업 폴더가 그 워크트리가 된다
#   (Explorer 는 pane 프로그램의 폴더를 본다 — athena 루트에서 띄운 뒤 안에서 워크트리를 만들면 계속 hermes 를 보여 준다)
# 사용: scripts/call-branch-info.sh <에이전트>
# 출력(탭 구분):
#   target\t<new-branch.sh 대상 — 설정 alias(없으면 레포 이름) · 모노레포는 <별칭>:<앱> · <별칭>:packages>
#   repo\t<레포 이름>
#   main\t<메인 체크아웃 git status 첫 줄>\t<미커밋 개수>
#   direct\t<작업 브랜치>\t<메인 체크아웃 경로>   main 직접 레포(팩 direct: true)일 때만 — 브랜치를 묻지 않는다
#   candidate\t<브랜치>\t<로컬|원격|로컬·원격>\t<최근 활동>\t<체크아웃 위치 또는 ->   (0~3줄, scripts/branch-candidates.sh)
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT="${1:-}"
[ -n "$AGENT" ] || { echo "사용: $0 <에이전트>" >&2; exit 2; }

read -r TARGET REPO <<<"$(python3 - "$ATHENA_DIR" "$AGENT" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
cfg = load(sys.argv[1]); agent = sys.argv[2]
for repo in cfg['repos']:
    # new-branch.sh 대상 — 설정 alias(없으면 레포 이름). 모노레포는 <별칭>:<앱> · <별칭>:packages
    alias = repo.get('alias') or repo['name']
    if agent in (repo.get('agents') or []):
        print(alias, repo['name']); break
    if repo.get('packagesAgent') == agent:
        print(f'{alias}:packages', repo['name']); break
    hit = [name for name, app in (repo.get('apps') or {}).items() if app.get('agent') == agent]
    if hit:
        print(f'{alias}:{hit[0]}', repo['name']); break
PYEOF
)"
[ -n "${REPO:-}" ] || { echo "담당 레포를 찾지 못했다: $AGENT (athena.config.json)" >&2; exit 2; }
printf 'target\t%s\nrepo\t%s\n' "$TARGET" "$REPO"
DIR="$ATHENA_DIR/repos/$REPO"
# main 직접 레포(팩 direct: true) — 브랜치를 묻지 않고 메인 체크아웃에서 띄운다: direct\t<작업 브랜치>\t<메인 체크아웃 경로>
DIRECT="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import load, is_direct, direct_branch; c=load(sys.argv[1]); print(direct_branch(c, sys.argv[2]) if is_direct(c, sys.argv[2]) else "")' "$ATHENA_DIR" "$REPO")"
[ -n "$DIRECT" ] && [ -d "$DIR" ] && printf 'direct\t%s\t%s\n' "$DIRECT" "$(cd "$DIR" && pwd -P)"
if [ -d "$DIR" ]; then
  printf 'main\t%s\t%s\n' "$(git -C "$DIR" status --short --branch 2>/dev/null | head -1)" "$(git -C "$DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  "$ATHENA_DIR/scripts/branch-candidates.sh" "$REPO" 3 2>/dev/null | sed 's/^/candidate\t/'
fi
exit 0
