#!/usr/bin/env bash
# 작업 브랜치를 만든다. 기본은 **워크트리**라 여러 작업을 동시에 돌릴 수 있다.
#
# 왜 워크트리인가: 체크아웃이 하나뿐이면 레포에 미커밋 변경이 있거나 남이 다른
# 브랜치를 물고 있을 때 작업을 시작조차 못 한다(실제로 겪음). 워크트리는 메인
# 체크아웃을 건드리지 않고 별도 디렉터리를 만들므로 그 제약이 사라지고,
# 한 레포에서 여러 작업을 동시에 진행할 수 있다.
#
# 사용:
#   scripts/new-branch.sh PROJ-3820 shop-web admin-web # 두 레포에 워크트리 생성
#   scripts/new-branch.sh PROJ-3820 web:admin          # 모노레포는 <별칭>:<앱> 으로 앱의 base 를 고른다
#   scripts/new-branch.sh fix/qa-로그인 admin-web       # 슬래시가 있으면 그 이름 그대로
#   scripts/new-branch.sh PROJ-3820 shop-web --in-place # 워크트리 없이 메인 체크아웃에서 분기
#   scripts/new-branch.sh PROJ-3820 shop-web --dry-run
#   scripts/new-branch.sh PROJ-3820 shop-web --reuse   # 이미 있는 브랜치를 이어 쓴다 (있으면 기본은 알려 주고 멈춘다)
#
# 대상은 레포 이름 일부 또는 설정 alias 로 매칭한다. 모노레포는 <별칭>:<앱>
# (<별칭>:packages 는 안내하고 멈춘다 — 앱 워크트리에 packages/** 가 같이 있다).
#
# 워크트리 위치: <athena>/.worktrees/<레포>/<브랜치 슬러그>  (gitignore 대상)
#   여러 팩 구조면 <데이터>/packs/<지금 팩>/worktrees/<레포>/<브랜치 슬러그> — 실제 경로(팩을 바꿔도 그 팩에 남는다)
# 정리: git -C repos/<레포> worktree remove <경로>
# 로컬 파일: 만든 워크트리에 메인 체크아웃의 git 무시 파일(.env·.aws 키 등, athena.config.json worktreeCopy)을
#   scripts/wt-copy-local.sh 로 복사한다. 이미 있는 워크트리는 scripts/wt-copy-local.sh --all
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 워크트리 자리 — ATHENA_WORKTREE_ROOT → (여러 팩) 지금 팩 데이터의 실제 경로 <데이터>/packs/<id>/worktrees → <athena>/.worktrees
# 여러 팩이면 실제 경로로 만든다: 본체의 .worktrees 링크로 만들면 팩을 바꾼 뒤 그 경로가 다른 팩을 가리킨다(D4 · scripts/lib/config.mjs paths)
WT_STATE="$(python3 - "$ROOT" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import paths, switching
print('switching' if switching(sys.argv[1]) else 'ok', paths(sys.argv[1])['worktrees'], sep='\t')
PYEOF
)"
[ "${WT_STATE%%$'\t'*}" = switching ] && { echo "팩을 바꾸는 중이라 브랜치·워크트리를 만들지 않는다 — 끝난 뒤 다시(bin/athena pack status)" >&2; exit 1; }
WT_ROOT="${WT_STATE#*$'\t'}"
# 설정을 못 읽어 자리를 모르면 멈춘다 — 빈 값이면 "/<레포>/…" 처럼 파일 시스템 맨 위에 만들 뻔한다(리뷰 제안 2026-10-18)
case "$WT_STATE" in ok$'\t'?*|switching$'\t'*) ;; *) echo "❌ 워크트리 자리를 정하지 못했다(설정·팩 확인 — scripts/lib/athena_config.py paths)" >&2; exit 1 ;; esac
[ -n "$WT_ROOT" ] || { echo "❌ 워크트리 자리가 비었다(설정·팩 확인)" >&2; exit 1; }
DRY_RUN=0; IN_PLACE=0; REUSE=0
TICKET=""; TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --reuse)    REUSE=1 ;;
    --in-place|--no-worktree) IN_PLACE=1 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) if [ -z "$TICKET" ]; then TICKET="$arg"; else TARGETS+=("$arg"); fi ;;
  esac
done

[ -n "$TICKET" ] && [ ${#TARGETS[@]} -gt 0 ] || { echo "사용: $0 <티켓|브랜치명> <대상...> [--in-place] [--dry-run]"; exit 2; }

case "$TICKET" in
  */*) BRANCH="$TICKET" ;;
  *)   BRANCH="feature/$TICKET" ;;
esac
SLUG="$(printf '%s' "$BRANCH" | tr '/' '-')"
BRANCH_GIVEN="$BRANCH"; SLUG_GIVEN="$SLUG"   # 레포마다 이름 규칙이 다를 수 있어 반복문에서 다시 정한다

resolve() {
  python3 - "$ROOT" "$1" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
cfg = load(sys.argv[1])
want = sys.argv[2]; app = None
if ':' in want: want, app = want.split(':', 1)
for repo in cfg['repos']:
    # 레포 이름 일부 또는 설정 alias 로 고른다
    if want.lower() not in repo['name'].lower() and want.lower() != repo.get('alias', '').lower(): continue
    name = repo['name']; alias = repo.get('alias') or name
    # 레포 관례 브랜치 이름(설정 branchName) — 없으면 '-'
    naming = json.dumps(repo['branchName'], ensure_ascii=False) if repo.get('branchName') else '-'
    if repo.get('kind') == 'monorepo':
        apps = repo.get('apps') or {}
        listing = ', '.join(sorted(apps))
        if not app:
            print(f'ERR|{name} 은 앱을 지정해야 한다: {alias}:<앱> 또는 {alias}:packages ({listing})'); sys.exit(0)
        if app.startswith('packages'):
            # 모노레포는 앱으로 딴 워크트리 안에 packages/** 가 그대로 있으니 packages 전용 대상을 따로 둘 이유가 없다.
            bases = sorted({entry.get('prBase', '') for entry in apps.values()})
            same = f"{len(apps)}개 앱 모두 base 가 {bases[0]} 라 어느 앱으로 따든 같다" if len(bases) == 1 else "앱마다 base 가 다르니 PR 을 낼 앱으로 딴다"
            print(f"ERR|packages/* 는 따로 딸 필요가 없다. {name} 은 모노레포라 앱으로 딴 워크트리 안에 packages/** 가 그대로 있고, {same}. 작업하는 앱으로 딴다 — {alias}:<앱> ({listing})")
            sys.exit(0)
        entry = apps.get(app)
        if not entry:
            print(f"ERR|{app} 은 {name} 의 앱이 아니다: {', '.join(apps)}"); sys.exit(0)
        print(f"{name}|{entry['prBase']}|{app}|{naming}"); sys.exit(0)
    # 5번째 칸 — main 직접 레포(팩 direct: true)면 1: 브랜치·워크트리를 만들지 않고 메인 체크아웃에서 바로 작업한다
    print(f"{name}|{repo['prBase']}|-|{naming}|{1 if repo.get('direct') else 0}"); sys.exit(0)
print(f"ERR|'{want}' 에 맞는 레포가 athena.config.json 에 없다")
PY
}

echo "브랜치: $BRANCH"
[ $IN_PLACE -eq 1 ] && echo "모드: 메인 체크아웃에서 분기 (--in-place)" || echo "모드: 워크트리 ($WT_ROOT/<레포>/$SLUG)"
[ $DRY_RUN -eq 1 ] && echo "(DRY-RUN: 실제로 만들지 않음)"
echo ""

created=0; skipped=0
for target in "${TARGETS[@]}"; do
  line="$(resolve "$target")"
  if [[ "$line" == ERR\|* ]]; then
    echo "❌ $target — ${line#ERR|}"; skipped=$((skipped+1)); continue
  fi
  IFS='|' read -r repo base app naming direct <<< "$line"
  dir="$ROOT/repos/$repo"
  label="$repo"; [ "$app" != "-" ] && label="$repo ($app)"

  [ -d "$dir" ] || { echo "❌ $label — repos/$repo 링크 없음. scripts/setup.sh 먼저"; skipped=$((skipped+1)); continue; }

  # main 직접 레포 — 브랜치·워크트리 없이 메인 체크아웃의 작업 브랜치에서 바로(docs/pack.md). 디스패치는 메인 체크아웃 경로로
  if [ "${direct:-0}" = 1 ]; then
    main_dir="$(cd "$dir" && pwd -P)"
    current="$(git -C "$main_dir" symbolic-ref --short -q HEAD || echo detached)"
    echo "✅ $label — main 직접: 브랜치·워크트리를 만들지 않는다(🌿 $current)"
    [ "$current" = "$base" ] || echo "   ⚠️ 메인 체크아웃이 $base 가 아니다(지금 $current) — 사용자에게 확인"
    behind="$(git -C "$main_dir" rev-list --count "HEAD..origin/$base" 2>/dev/null || echo 0)"
    [ "$behind" = 0 ] || echo "   ⚠️ origin/$base 보다 ${behind}커밋 뒤처졌다 — 먼저 받는다(git pull --ff-only)"
    echo "        디스패치: scripts/delegate.sh <에이전트> --cwd $main_dir --plan <계획서>"
    created=$((created+1)); continue
  fi

  # fetch 실패해도 로컬에 origin/<base> 가 있으면 진행하되 경고한다.
  # SSH 키가 없거나 오프라인일 때 작업 자체를 막을 이유는 없다. 다만 base 가
  # 낡았을 수 있다는 사실은 반드시 알린다.
  stale=""
  # 비대화형으로 — ssh 키 암호를 묻다 멈추지 않게. ssh 가 안 되면 https 로 재시도(sync·현황판과 같은 방식)
  fetch_quiet() { GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10" git -C "$dir" "$@" fetch origin "$base" --quiet 2>/dev/null; }
  if ! fetch_quiet && ! fetch_quiet -c url.https://github.com/.insteadOf=git@github.com:; then
    if git -C "$dir" rev-parse --verify --quiet "origin/$base" >/dev/null; then
      stale=" ⚠️ fetch 실패 — 로컬 origin/$base 로 분기했다. 최신이 아닐 수 있다"
    else
      echo "❌ $label — origin/$base 를 fetch 하지 못했고 로컬에도 없다 (네트워크·권한 확인)"
      skipped=$((skipped+1)); continue
    fi
  fi

  # 레포별 브랜치 이름 — 기본은 위에서 정한 이름. 설정 branchName 이 있으면(예: 앱은 feature/v<앱버전>/<티켓>)
  # 티켓만 줬을 때 base 의 versionFile 에서 versionRegex 첫 그룹을 읽어 pattern 을 채운다(슬래시가 있으면 준 이름 그대로)
  BRANCH="$BRANCH_GIVEN"; SLUG="$SLUG_GIVEN"
  if [ "${naming:--}" != "-" ] && [[ "$TICKET" != */* ]]; then
    version_file="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["versionFile"])' "$naming")"
    app_version="$(git -C "$dir" show "origin/$base:$version_file" 2>/dev/null | python3 -c '
import json, re, sys
spec = json.loads(sys.argv[1]); hit = re.search(spec["versionRegex"], sys.stdin.read(), re.M)
print(hit.group(1) if hit else "")' "$naming")"
    pattern="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["pattern"])' "$naming")"
    if [ -n "$app_version" ]; then
      BRANCH="$(sed -e "s|{version}|$app_version|" -e "s|{ticket}|$TICKET|" <<<"$pattern")"; SLUG="$(printf '%s' "$BRANCH" | tr '/' '-')"
      echo "   $label — 레포 관례로 브랜치 이름: $BRANCH (앱 버전은 origin/$base $version_file)"
    else
      echo "   ⚠️ $label — $version_file 에서 앱 버전을 못 읽어 $BRANCH 로 딴다. 관례는 $(sed -e 's|{version}|<앱버전>|' -e 's|{ticket}|<티켓>|' <<<"$pattern") — 전체 이름을 주면 그대로 쓴다"
    fi
  fi

  # 이미 있는 브랜치 — 로컬 또는 원격(origin). 기본은 어디에 어떤 상태로 있는지 알려 주고 멈춘다.
  # 이어 쓰려면 --reuse (사용자에게 "그대로 쓸까요?" 를 물은 뒤)
  local_ref=0; remote_ref=0
  git -C "$dir" show-ref --verify --quiet "refs/heads/$BRANCH" && local_ref=1
  if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10" git -C "$dir" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 \
    || GIT_TERMINAL_PROMPT=0 git -C "$dir" -c url.https://github.com/.insteadOf=git@github.com: ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    remote_ref=1
  fi
  if [ $local_ref = 1 ] || [ $remote_ref = 1 ]; then
    where="$(git -C "$dir" worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$BRANCH" '/^worktree /{w=$2} $0=="branch "b{print w}')"
    main_dir="$(cd "$dir" && pwd -P)"
    if [ $REUSE = 0 ]; then
      state="로컬 $([ $local_ref = 1 ] && echo 있음 || echo 없음) · 원격 $([ $remote_ref = 1 ] && echo 있음 || echo 없음)"
      [ $local_ref = 1 ] && state="$state · 마지막 커밋 $(git -C "$dir" log -1 --format='%h %ad %s' --date=short "$BRANCH" 2>/dev/null | cut -c1-60)"
      echo "⚠️  $label — 브랜치 $BRANCH 가 이미 있다 ($state)${where:+ · 체크아웃: $where}"
      echo "        그대로 이어 쓰려면 --reuse 를 붙여 다시 실행한다. 새로 따려면 다른 이름을 쓴다"
      skipped=$((skipped+1)); continue
    fi
    # --reuse
    if [ -n "$where" ] && [ "$(cd "$where" && pwd -P)" = "$main_dir" ]; then
      echo "⚠️  $label — $BRANCH 는 메인 체크아웃(repos/$repo)에 올라가 있어 워크트리로 이어 쓸 수 없다. 메인 체크아웃에서 할지 다른 이름으로 딸지 정한다"
      skipped=$((skipped+1)); continue
    fi
    if [ -n "$where" ]; then
      echo "♻️  $label — 이어서: 이미 있는 워크트리를 그대로 쓴다"
      echo "        워크트리: $where"
      created=$((created+1)); continue
    fi
    wt="$WT_ROOT/$repo/$SLUG"
    [ -e "$wt" ] && { echo "⏭  $label — 워크트리 경로가 이미 있다: $wt"; skipped=$((skipped+1)); continue; }
    [ $DRY_RUN = 1 ] && { echo "[DRY] $label — 이어서: $BRANCH ($([ $local_ref = 1 ] && echo 로컬 || echo 원격 추적))"; echo "        워크트리: $wt"; created=$((created+1)); continue; }
    mkdir -p "$(dirname "$wt")"
    if [ $local_ref = 1 ]; then
      ok="$(git -C "$dir" worktree add "$wt" "$BRANCH" >/dev/null 2>&1 && echo 1)"
    else
      GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10" git -C "$dir" fetch --quiet origin "$BRANCH" 2>/dev/null \
        || GIT_TERMINAL_PROMPT=0 git -C "$dir" -c url.https://github.com/.insteadOf=git@github.com: fetch --quiet origin "$BRANCH" 2>/dev/null
      ok="$(git -C "$dir" worktree add --track -b "$BRANCH" "$wt" "origin/$BRANCH" >/dev/null 2>&1 && echo 1)"
    fi
    if [ "$ok" = 1 ]; then
      echo "♻️  $label — 이어서: $BRANCH ($([ $local_ref = 1 ] && echo 로컬 브랜치 || echo 원격 추적)) 로 워크트리를 만들었다"
      echo "        워크트리: $wt"
      "$ROOT/scripts/wt-copy-local.sh" "$dir" "$wt"
      created=$((created+1))
    else
      echo "❌ $label — 이어 쓸 워크트리를 만들지 못했다 (git worktree add)"; skipped=$((skipped+1))
    fi
    continue
  fi

  head="$(git -C "$dir" rev-parse --short "origin/$base")"

  if [ $IN_PLACE -eq 1 ]; then
    dirty="$(git -C "$dir" status --porcelain 2>/dev/null)"
    if [ -n "$dirty" ]; then
      echo "⏭  $label — 미커밋 변경 $(printf '%s\n' "$dirty" | wc -l | tr -d ' ')건 (--in-place 라 건너뛴다. 워크트리로 하면 무관하다)"
      skipped=$((skipped+1)); continue
    fi
    cur="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
    if [ $DRY_RUN -eq 1 ]; then
      echo "[DRY] $label — origin/$base ($head) → $BRANCH (현재 $cur)${stale}"
    elif git -C "$dir" checkout -q -b "$BRANCH" "origin/$base" 2>/dev/null; then
      echo "✅ $label — origin/$base ($head) → $BRANCH  (이전 $cur)${stale}"
    else
      echo "❌ $label — 브랜치 생성 실패"; skipped=$((skipped+1)); continue
    fi
  else
    wt="$WT_ROOT/$repo/$SLUG"
    if [ -e "$wt" ]; then
      echo "⏭  $label — 워크트리 경로가 이미 있다: $wt"; skipped=$((skipped+1)); continue
    fi
    if [ $DRY_RUN -eq 1 ]; then
      echo "[DRY] $label — origin/$base ($head) → $BRANCH${stale}"
      echo "        워크트리: $wt"
    else
      mkdir -p "$(dirname "$wt")"
      if git -C "$dir" worktree add "$wt" -b "$BRANCH" "origin/$base" >/dev/null 2>&1; then
        echo "✅ $label — origin/$base ($head) → $BRANCH${stale}"
        echo "        워크트리: $wt"
        # git 무시 로컬 파일(.env·.aws 키 등)은 worktree add 가 가져오지 않는다 — 메인 체크아웃에서 복사(이름만 보고)
        "$ROOT/scripts/wt-copy-local.sh" "$dir" "$wt"
        echo "        디스패치: scripts/delegate.sh <에이전트> --cwd $wt --plan <계획서>"
      else
        echo "❌ $label — 워크트리 생성 실패 (git worktree add)"; skipped=$((skipped+1)); continue
      fi
    fi
  fi
  created=$((created+1))
done

# 에이전트 pane 안에서 브랜치를 새로 정했으면 pane 이름을 그 브랜치로 바꾼다.
# ATHENA_AGENT 는 delegate.sh 가 에이전트 pane 에만 넣는다(아테나 pane 에서 돌리면 이름을 건드리지 않는다)
# (부른 pane 은 화면 계층 self — 서버에 묻지 않고 환경에서. 화면 백엔드가 없으면 이름 바꾸기가 실패해 조용히 넘어간다)
if [ $created -gt 0 ] && [ $DRY_RUN -eq 0 ] && [ -n "${ATHENA_AGENT:-}" ]; then
  eval "$("$ROOT/scripts/screen" self --format sh 2>/dev/null)"
  if [ -n "${SCREEN_PANE_ID:-}" ]; then
    "$ROOT/scripts/screen" pane rename "$SCREEN_PANE_ID" "🤖 $ATHENA_AGENT · $BRANCH" >/dev/null 2>&1 && echo "🏷  pane 이름: 🤖 $ATHENA_AGENT · $BRANCH"
  fi
fi

echo ""
echo "생성: ${created}, 건너뜀: ${skipped}"
if [ $skipped -gt 0 ]; then
  echo "건너뛴 레포는 사용자에게 보고하고 처리 방법을 확인한다. 그 레포에는 디스패치하지 않는다."
fi
[ $created -gt 0 ] && [ $IN_PLACE -eq 0 ] && [ $DRY_RUN -eq 0 ] && \
  echo "작업이 끝나면 정리: git -C repos/<레포> worktree remove <경로>  (wt-sync 로 메인 체크아웃에 반영한 뒤)"
exit 0
