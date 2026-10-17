#!/usr/bin/env bash
# herdr-sidebar 패치판을 설치한다 (아테나를 켤 때 athena-up.sh 가 부른다 · setup.sh 도 · 다시 돌려도 안전).
#   - 원본은 버전을 고정한다(PIN). 다른 커밋이 깔려 있으면 PIN 으로 다시 설치한다
#   - patches/herdr-sidebar/*.patch 를 원본 소스에 적용한다(이미 적용됐으면 건너뜀)
#   - 실행 파일은 미리 빌드해 둔 patches/herdr-sidebar/bin/herdr-sidebar-<아키텍처> 를 넣는다 → 팀원 PC 에 Rust 가 필요 없다
#     (그 실행 파일이 지금 패치로 빌드된 것인지 bin/BUILT_FROM 으로 확인한다. 맞는 게 없고 cargo 가 있으면 소스로 빌드)
#   - 패치를 고치면 scripts/herdr-sidebar-build-bin.sh 로 실행 파일을 다시 만들어 함께 커밋한다
# herdr 가 없거나 응답하지 않으면 건너뛴다(0). 설치·패치·빌드가 실패하면 1 로 끝난다(setup.sh 가 "준비 완료" 에서 뺀다).
# herdr 가 플러그인을 다시 설치·업데이트하면 다시 돌리면 된다(아테나를 켜면 자동).
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="alexarthurs/herdr-sidebar"
SUBDIR="plugins/herdr-sidebar"
PIN="4faeea73503bcfb7e5ba72ef0c683649f64f74e5"   # 2026-09-01 · v0.11.0
PATCH_DIR="$ATHENA_DIR/patches/herdr-sidebar"
BIN_DIR="$PATCH_DIR/bin"

say() { printf '  %s\n' "$*"; }

command -v herdr >/dev/null 2>&1 || { say "· herdr-sidebar 패치: herdr 없음 — 건너뜀"; exit 0; }

# 설치 정보: plugin_root(실행 파일 위치) · managed_path(git 체크아웃) · resolved_commit
info() {
  herdr plugin list --json 2>/dev/null | python3 -c '
import sys, json
for p in json.load(sys.stdin)["result"]["plugins"]:
    if p.get("plugin_id") == "herdr-sidebar":
        s = p.get("source") or {}
        print(p.get("plugin_root", ""), s.get("managed_path", ""), s.get("resolved_commit", ""), sep="\t")
'
}

# herdr 서버가 응답하지 않으면(설치만 돼 있고 안 켜짐 등) 아무것도 하지 않는다 — 잘못 다시 설치하지 않게
herdr plugin list --json 2>/dev/null | python3 -c 'import sys,json;json.load(sys.stdin)["result"]["plugins"]' >/dev/null 2>&1 \
  || { say "· herdr-sidebar 패치: herdr 가 응답하지 않음 — 건너뜀"; exit 0; }
IFS=$'\t' read -r ROOT MANAGED COMMIT <<<"$(info)"
if [ -z "${ROOT:-}" ] || [ "${COMMIT:-}" != "$PIN" ]; then
  say "· herdr-sidebar 를 고정 버전(${PIN:0:7})으로 설치합니다"
  herdr plugin install "$REPO/$SUBDIR" --ref "$PIN" -y >/dev/null 2>&1 || { say "✖ herdr-sidebar 설치 실패 — herdr plugin install $REPO/$SUBDIR --ref $PIN"; exit 1; }
  IFS=$'\t' read -r ROOT MANAGED COMMIT <<<"$(info)"
fi
[ -n "${MANAGED:-}" ] && [ -d "$MANAGED/.git" ] || { say "✖ herdr-sidebar 체크아웃을 찾지 못했습니다 — 패치 건너뜀"; exit 1; }

# 1) 소스에 패치 — 실행 파일과 소스가 같은 내용이 되게(소스로 다시 빌드할 때도 그대로)
for patch in "$PATCH_DIR"/*.patch; do
  [ -f "$patch" ] || continue
  name="$(basename "$patch")"
  if git -C "$MANAGED" apply --reverse --check "$patch" >/dev/null 2>&1; then
    :
  elif git -C "$MANAGED" apply --check "$patch" >/dev/null 2>&1; then
    git -C "$MANAGED" apply "$patch" && say "✔ $name 적용"
  else
    say "✖ $name 적용 실패 — 원본이 고정 버전과 다릅니다(git -C $MANAGED status)"; exit 1
  fi
done

# 2) 실행 파일 — 미리 빌드한 것(지금 패치로 만든 것일 때만) → 없으면 cargo 로 빌드 → 그것도 없으면 원본 그대로
BIN="$ROOT/target/release/herdr-sidebar"
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) triple="aarch64-apple-darwin" ;;
  Darwin/x86_64) triple="x86_64-apple-darwin" ;;
  *) triple="" ;;
esac
patch_sum="$(cat "$PATCH_DIR"/*.patch 2>/dev/null | shasum -a 256 | awk '{print $1}')"
prebuilt="$BIN_DIR/herdr-sidebar-$triple"
built_from="$(awk -v t="$triple" '$1==t{print $2, $3}' "$BIN_DIR/BUILT_FROM" 2>/dev/null)"   # <아키텍처> <PIN> <패치 sha256>

if [ -n "$triple" ] && [ -f "$prebuilt" ] && [ "$built_from" = "$PIN $patch_sum" ]; then
  if cmp -s "$prebuilt" "$BIN"; then
    say "✔ herdr-sidebar 패치판 최신"
  else
    mkdir -p "$(dirname "$BIN")"
    cp "$prebuilt" "$BIN.hermes-tmp" && chmod +x "$BIN.hermes-tmp" && mv "$BIN.hermes-tmp" "$BIN" \
      && say "✔ herdr-sidebar 패치판 교체 (미리 빌드한 $triple) — 열린 사이드바는 herdr plugin action invoke redeploy --plugin herdr-sidebar 로 새로 띄운다" \
      || { say "✖ 실행 파일을 넣지 못했습니다 — $BIN"; exit 1; }
  fi
elif command -v cargo >/dev/null 2>&1 || { [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" && command -v cargo >/dev/null 2>&1; }; then
  newest_src="$(find "$ROOT/src" -name '*.rs' -newer "$BIN" 2>/dev/null | head -1)"
  if [ ! -x "$BIN" ] || [ -n "$newest_src" ]; then
    say "· 이 PC 용 미리 빌드한 실행 파일이 없어 소스로 빌드합니다 (cargo build --release)…"
    if (cd "$ROOT" && "$ATHENA_DIR/scripts/heavy.sh" cargo build --release >/dev/null 2>&1); then
      say "✔ herdr-sidebar 패치판 교체 (소스 빌드) — 열린 사이드바는 herdr plugin action invoke redeploy --plugin herdr-sidebar 로 새로 띄운다"
    else
      say "✖ 빌드 실패 — cd $ROOT && cargo build --release"
      exit 1
    fi
  else
    say "✔ herdr-sidebar 패치판 최신 (소스 빌드)"
  fi
else
  say "· herdr-sidebar 패치판: 이 PC($triple) 용 실행 파일이 없습니다 — 원본 사이드바 그대로 둡니다"
fi
