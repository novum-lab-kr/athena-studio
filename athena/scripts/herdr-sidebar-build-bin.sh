#!/usr/bin/env bash
# (패치를 고친 사람이 한 번) herdr-sidebar 패치판 실행 파일을 빌드해 patches/herdr-sidebar/bin/ 에 넣는다.
# 팀원은 Rust 없이 이 파일을 받아 쓴다(scripts/herdr-sidebar-patch.sh). 끝나면 bin/ 과 patch 를 함께 커밋한다.
#   - 이 PC 아키텍처 하나만 만든다. 다른 아키텍처(Intel Mac 등)는 그 PC 에서 이 스크립트를 돌리거나,
#     rustup target 이 있으면 HERDR_SIDEBAR_TARGETS="aarch64-apple-darwin x86_64-apple-darwin" 로 같이 만든다
#   - 빌드는 실제 설치본(패치가 적용된 체크아웃)에서 한다 — 먼저 scripts/herdr-sidebar-patch.sh 로 패치를 적용해 둔다
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_DIR="$ATHENA_DIR/patches/herdr-sidebar"
BIN_DIR="$PATCH_DIR/bin"
PIN="$(sed -n 's/^PIN="\([0-9a-f]*\)".*/\1/p' "$ATHENA_DIR/scripts/herdr-sidebar-patch.sh")"

ROOT="$(herdr plugin list --json 2>/dev/null | python3 -c "import sys,json;print(next((p.get('plugin_root','') for p in json.load(sys.stdin)['result']['plugins'] if p.get('plugin_id')=='herdr-sidebar'),''))")"
[ -n "$ROOT" ] || { echo "✖ herdr-sidebar 가 설치돼 있지 않습니다 — scripts/herdr-sidebar-patch.sh 먼저"; exit 1; }
MANAGED="$(git -C "$ROOT" rev-parse --show-toplevel)"
[ "$(git -C "$MANAGED" rev-parse HEAD)" = "$PIN" ] || { echo "✖ 설치본이 고정 버전(${PIN:0:7})이 아닙니다"; exit 1; }
for patch in "$PATCH_DIR"/*.patch; do
  git -C "$MANAGED" apply --reverse --check "$patch" >/dev/null 2>&1 || { echo "✖ $(basename "$patch") 가 설치본에 적용돼 있지 않습니다 — scripts/herdr-sidebar-patch.sh 먼저"; exit 1; }
done
[ -z "$(git -C "$MANAGED" diff | diff - <(cat "$PATCH_DIR"/*.patch))" ] || { echo "✖ 설치본에 patch 밖의 변경이 있습니다 — git -C $MANAGED diff 로 확인 후 patch 를 다시 만드세요"; exit 1; }

case "$(uname -m)" in arm64) host="aarch64-apple-darwin" ;; x86_64) host="x86_64-apple-darwin" ;; *) echo "✖ macOS 만 지원"; exit 1 ;; esac
targets="${HERDR_SIDEBAR_TARGETS:-$host}"
patch_sum="$(cat "$PATCH_DIR"/*.patch | shasum -a 256 | awk '{print $1}')"
mkdir -p "$BIN_DIR"
touch "$BIN_DIR/BUILT_FROM"
for target in $targets; do
  echo "· $target 빌드…"
  if [ "$target" = "$host" ]; then
    (cd "$ROOT" && "$ATHENA_DIR/scripts/heavy.sh" cargo build --release) || exit 1
    out="$ROOT/target/release/herdr-sidebar"
  else
    (cd "$ROOT" && "$ATHENA_DIR/scripts/heavy.sh" cargo build --release --target "$target") || exit 1
    out="$ROOT/target/$target/release/herdr-sidebar"
  fi
  cp "$out" "$BIN_DIR/herdr-sidebar-$target"
  # 한 줄에 아키텍처 · 고정 버전 · 패치 sha256 · 실행 파일 sha256
  grep -v "^$target " "$BIN_DIR/BUILT_FROM" > "$BIN_DIR/BUILT_FROM.tmp"
  printf '%s %s %s %s\n' "$target" "$PIN" "$patch_sum" "$(shasum -a 256 "$BIN_DIR/herdr-sidebar-$target" | awk '{print $1}')" >> "$BIN_DIR/BUILT_FROM.tmp"
  sort "$BIN_DIR/BUILT_FROM.tmp" > "$BIN_DIR/BUILT_FROM"; rm -f "$BIN_DIR/BUILT_FROM.tmp"
  echo "✔ $BIN_DIR/herdr-sidebar-$target"
done
echo "→ patches/herdr-sidebar/ 를 커밋하세요 (patch · bin/ · BUILT_FROM)"
