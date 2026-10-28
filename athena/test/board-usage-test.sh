#!/usr/bin/env bash
# 현황판 서버 사용량 시험 — 임시 코어 사본에서 진짜 scripts/board/server.mjs 를 띄워 /api/state header.usage 를 본다.
# 2026-10-28 재현: readUsage 가 창을 { label, percent, resetsAt } 로 다시 골라 minutes 를 버려
# 스튜디오 메뉴 막대(src/lib/tray-model.mts windowName)가 영어 화면에서도 한국어 label(5시간 · 주간)을 썼다.
# 가짜 claude · gh(PATH 앞) · 임시 폴더 · 화면을 부르지 않는다 · 몇 초
#
# 사용: test/board-usage-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-board-usage-test.XXXXXX")"
CORE="$TMP/core"
SERVER_PID=''
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ "${KEEP:-0}" = 1 ] || rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$CORE" "$TMP/bin"
cp -R "$SRC/." "$CORE/"
# statusline.sh 가 떨구는 모양 — 5시간 · 7일 창
now=$(date +%s)
printf '{"at":%s,"rate_limits":{"five_hour":{"used_percentage":12.4,"resets_at":%s},"seven_day":{"used_percentage":40,"resets_at":%s}}}\n' \
  "$now" "$((now + 3600))" "$((now + 86400))" > "$CORE/.board-usage.json"
# 사용량은 PATH 에 claude 가 있을 때만 읽는다 — 실행만 되는 가짜 · gh 는 부르면 실패만
for name in claude gh; do printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/$name"; chmod +x "$TMP/bin/$name"; done

PORT=$((47000 + RANDOM % 900))
(cd "$CORE" && PATH="$TMP/bin:$PATH" ATHENA_BOARD_PORT=$PORT exec node scripts/board/server.mjs > "$TMP/server.log" 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/api/state" -o "$TMP/state.json" 2>/dev/null && grep -q '"header"' "$TMP/state.json" && break
  sleep 0.5
done
if ! grep -q '"header"' "$TMP/state.json" 2>/dev/null; then
  echo "  ✖ 현황판 서버가 /api/state 를 내주지 않음"
  tail -20 "$TMP/server.log"
  exit 1
fi

node - "$TMP/state.json" <<'EOF'
const state = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }
const claude = (state.header?.usage ?? []).find((cli) => cli.id === 'claude')
const windows = claude?.windows ?? []
check('Claude 사용량이 header.usage 에 있음', windows.length === 2, JSON.stringify(state.header?.usage))
check('창마다 minutes(300 · 10080) — 메뉴 막대가 언어에 맞는 이름을 짓는 값', JSON.stringify(windows.map((win) => win.minutes)) === '[300,10080]', JSON.stringify(windows))
check('label · percent · resetsAt 은 그대로(현황판 화면 · 옛 앱 하위 호환)', windows[0]?.label === '5시간' && windows[0]?.percent === 12 && typeof windows[0]?.resetsAt === 'number', JSON.stringify(windows[0]))
console.log()
console.log(fail ? 'board-usage-test: 실패 있음' : 'board-usage-test: 모두 통과')
process.exit(fail)
EOF
