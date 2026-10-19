#!/usr/bin/env bash
# 바뀐 파일에 화면 계층 파일이 있는지 — 화면 회귀 시험(screen-check, 약 2분)을 돌릴지 정한다(계획서 D1).
# 팩 검증 스크립트가 부른다:
#   if bash "$ATHENA_DIR/scripts/verify/changed-screen.sh" "$REPO_DIR" $FULL; then run_step "screen-check …" …
#   else skip_step_rule "screen-check …" "화면 파일 변경 없음"; fi
#
# 사용: scripts/verify/changed-screen.sh [<트리>] [--full] [--base <ref>]
#   exit 0 → 화면 파일이 바뀌었다(돌린다) · 바뀐 화면 파일을 출력
#   exit 1 → 화면 파일 변경 없음(건너뛴다)
#   --full 이면 늘 0. 기준 ref 를 못 찾으면 늘 0(모르면 돌린다)
#
# <트리> 는 레포 맨 위가 아니어도 된다(하위 폴더면 그 폴더 안만 본다)
# 바뀐 파일 = 기준 ref 와의 merge-base 대비 커밋된 변경 + 미커밋 변경(스테이징·작업 트리) + 미추적 파일(무시 제외)
#   기준 ref — --base, 없으면 브랜치 upstream, 없으면 origin/HEAD, 없으면 origin/main
# 화면 파일 = screen-lint 가 보는 곳(scripts · bin · .claude · .codex) 안에서
#   ① 화면 계층 자체 — scripts/screen · scripts/lib/screen.* · scripts/screen-lint.sh · scripts/screen-check/**
#   ② screen-check 시나리오가 돌리는 스크립트(시나리오 파일에 적힌 scripts/… 경로)
#   ③ 화면 계층을 부르는 스크립트(scripts/screen · lib/screen · screenSync 를 쓰는 코드 — 문서 *.md 제외)
#   ④ ①~③ 이 불러 쓰는 scripts/lib 파일(sh·mjs·py, lib 안의 lib 까지 따라간다)
# 목록을 손으로 적지 않는 것은 새 화면 스크립트가 생겨도 빠지지 않게 하려는 것이다.
set -uo pipefail
TREE="."; FULL=0; BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --base) BASE="${2:-}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TREE="$1"; shift ;;
  esac
done
[ $FULL = 1 ] && { echo "--full — 화면 회귀를 늘 돌린다"; exit 0; }
# 받은 폴더 기준으로 본다 — 스튜디오처럼 코어가 레포 하위 폴더(athena/)에 있어도 그 폴더 안 경로(scripts/…)로 비교한다
cd "$TREE" 2>/dev/null && [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || { echo "git 트리가 아니다: $TREE — 돌린다"; exit 0; }
git() { command git -c core.quotePath=false "$@"; }

# ── 기준 ref ────────────────────────────────────────────────────────────
if [ -z "$BASE" ]; then
  for candidate in '@{upstream}' origin/HEAD origin/main; do
    git rev-parse -q --verify "$candidate^{commit}" >/dev/null 2>&1 && { BASE="$candidate"; break; }
  done
fi
MERGE_BASE="$(git merge-base HEAD "$BASE" 2>/dev/null)" || MERGE_BASE=""
[ -n "$MERGE_BASE" ] || { echo "기준 ref(${BASE:-없음})를 찾지 못했다 — 돌린다"; exit 0; }

# --relative · ls-files 는 지금 폴더 안 파일만, 지금 폴더 기준 경로로 낸다
CHANGED="$( { git diff --relative --name-only "$MERGE_BASE" HEAD; git diff --relative --name-only --cached; git diff --relative --name-only; git ls-files --others --exclude-standard; } | sort -u)"

# ── 화면 파일 목록 ──────────────────────────────────────────────────────
SCOPE="$(git ls-files -co --exclude-standard -- scripts bin .claude .codex | sort -u)"
in_scope() { printf '%s\n' "$SCOPE" | grep -vE '\.md$' | grep -E "$1"; }
SCREEN="$(
  in_scope '^scripts/(screen|screen-lint\.sh|lib/screen\.[a-z]+|screen-check/.*)$'
  # ② 시나리오가 돌리는 스크립트
  cat scripts/screen-check/*.sh 2>/dev/null | grep -oE 'scripts/[A-Za-z0-9_./-]+|bin/athena' | sed 's#/*$##' | sort -u \
    | while IFS= read -r path; do [ -f "$path" ] && printf '%s\n' "$path"; done
  # ③ 화면 계층을 부르는 코드
  printf '%s\n' "$SCOPE" | grep -vE '\.md$' | while IFS= read -r path; do [ -f "$path" ] && [ ! -L "$path" ] && printf '%s\n' "$path"; done \
    | grep -vxF scripts/verify/changed-screen.sh | tr '\n' '\0' | xargs -0 grep -lE 'scripts/screen([^-_[:alnum:]]|$)|lib/screen|screenSync|import screen|from screen import' 2>/dev/null
)"
SCREEN="$(printf '%s\n' "$SCREEN" | grep -v '^$' | sort -u)"
# ④ 불러 쓰는 파일 — 새로 찾은 게 없을 때까지 따라간다
#   셸·문자열의 lib/<이름>.(sh|mjs|py) · 파이썬 from/import <모듈>(scripts/lib/<모듈>.py) · node 상대 import('./x.mjs' · '../qa/y.mjs')
#   다른 스크립트 이름이 글로 적힌 것(지시문 속 commit.sh 등)은 따라가지 않는다 — 그러면 거의 모든 파일이 화면 파일이 된다
SCREEN="$(printf '%s\n' "$SCREEN" | python3 -I -c '
import os, re, sys
lib_ref = re.compile(r"lib/([A-Za-z0-9_.-]+\.(?:sh|mjs|py))")
py_import = re.compile(r"^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)", re.M)
js_import = re.compile(r"""(?:from\s+|import\s*\(\s*)[\x27"](\.{1,2}/[^\x27"]+\.mjs)[\x27"]""")
def refs(path):
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return []
    found = ["scripts/lib/" + name for name in lib_ref.findall(text)]
    found += ["scripts/lib/" + name + ".py" for name in py_import.findall(text)]
    found += [os.path.normpath(os.path.join(os.path.dirname(path), name)) for name in js_import.findall(text)]
    return [ref for ref in found if os.path.isfile(ref)]
known = set(line for line in sys.stdin.read().split("\n") if line)
queue = list(known)
while queue:
    for ref in refs(queue.pop()):
        if ref not in known:
            known.add(ref)
            queue.append(ref)
print("\n".join(sorted(known)))
')"

HITS="$(printf '%s\n' "$CHANGED" | grep -xF -f <(printf '%s\n' "$SCREEN") || true)"
if [ -n "$HITS" ]; then
  echo "화면 파일 변경 (기준 $BASE):"
  printf '%s\n' "$HITS" | sed 's/^/  /'
  exit 0
fi
echo "화면 파일 변경 없음 (기준 $BASE · 바뀐 파일 $(printf '%s\n' "$CHANGED" | grep -c .)개)"
exit 1
