#!/usr/bin/env bash
# athena workspace 고정 배치 — 도구 pane 을 정해진 자리로 옮긴다 (다시 돌려도 안전).
#   오른쪽 끝 세로 칸: Explorer(위 · 사이드바 플러그인이 띄움) · 가이드 메뉴(아래)
#   하단 한 줄:        🛰 에이전트 모니터 | 📋 현황판 | 📚 배우기 검토 (아테나 pane 아래)
#   나머지(아테나·에이전트 pane)는 왼쪽 위 본 영역
# pane 을 띄우는 스크립트(guide-pane · monitor-pane · board · learn-review-pane)와 athena-up 이 끝에 부른다. 손으로: scripts/athena-layout.sh
# 이미 그 모양이면 아무것도 안 한다. 아니면 도구 pane 을 모두 임시 탭으로 뺐다가 정해진 순서로 다시 붙인다
# (herdr 는 같은 탭 안 이동을 못 한다 — reason same_tab. 옮기면 pane id 가 바뀌므로 라벨로 다시 찾는다).
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCREEN="$ATHENA_DIR/scripts/screen"   # 화면 계층 — pane 은 이걸로만 다룬다(옮기기·자리 정보가 없는 백엔드면 아무것도 안 한다)
"$SCREEN" inside && "$SCREEN" capabilities --has layout-geometry,pane-move || exit 0
eval "$("$SCREEN" self --format sh)"   # SCREEN_PANE_ID · SCREEN_TAB_ID

TAB="${1:-${SCREEN_TAB_ID:-}}"
[ -n "$TAB" ] || exit 0
WS="$("$SCREEN" tab get "$TAB" | python3 -c "import sys,json;print(json.load(sys.stdin)['tab']['workspace_id'])")"
# athena workspace 에서만 — 이름(hermes · fe-hermes 등 사람마다 다르다)이 아니라, athena 폴더에서 열린 pane 중 에이전트 pane(🤖 …)이 아닌 게 있는지로 판단(에이전트 workspace 의 pane 도 cwd 가 hermes 일 수 있다)
"$SCREEN" pane list 2>/dev/null | python3 -c "import sys,json,os;h=os.path.realpath('$ATHENA_DIR');sys.exit(0 if any(p['workspace_id']=='$WS' and os.path.realpath(p.get('cwd') or '')==h and not (p.get('label') or '').startswith('🤖') for p in json.load(sys.stdin)['panes']) else 1)" || exit 0

EXPLORER="Explorer"; GUIDE="가이드 메뉴"; MON="🛰 에이전트 모니터"; BOARD="📋 현황판"; LEARN="📚 배우기 검토"
ROW=("$MON" "$BOARD" "$LEARN")

# 이 탭의 pane 사각형: 라벨\tid\tx\ty\tw\th (라벨 없는 pane 은 "-") + AREA 줄
snapshot() {
  python3 - "$TAB" "$SCREEN" <<'PY'
import sys, json, subprocess
tab, screen = sys.argv[1], sys.argv[2]
panes = {p['id']: p for p in json.loads(subprocess.run([screen,'pane','list'],capture_output=True,text=True).stdout)['panes'] if p['tab_id'] == tab}
if not panes:
    sys.exit(0)
lay = json.loads(subprocess.run([screen,'pane','layout','--pane',next(iter(panes))],capture_output=True,text=True).stdout)
a = lay['area']; print('AREA', '-', a['x'], a['y'], a['width'], a['height'], sep='\t')
for r in lay['panes']:
    q = r['rect']; print(panes.get(r['id'], {}).get('label') or '-', r['id'], q['x'], q['y'], q['width'], q['height'], sep='\t')
PY
}
get() { awk -F'\t' -v l="$1" '$1==l{print $2; exit}' <<<"$SNAP"; }
rect() { awk -F'\t' -v l="$1" '$1==l{print $3, $4, $5, $6; exit}' <<<"$SNAP"; }
# 같은 workspace 어디든(이 탭 우선) 라벨로 pane id
find_ws() {
  "$SCREEN" pane list 2>/dev/null | python3 -c "
import sys, json
ps = [p for p in json.load(sys.stdin)['panes'] if p['workspace_id'] == '$WS' and p.get('label') == sys.argv[1]]
ps.sort(key=lambda p: p['tab_id'] != '$TAB')
print(ps[0]['id'] if ps else '')" "$1"
}
in_tab() { "$SCREEN" pane list 2>/dev/null | python3 -c "import sys,json;sys.exit(0 if any(p['id']=='$1' and p['tab_id']=='$TAB' for p in json.load(sys.stdin)['panes']) else 1)"; }

SNAP="$(snapshot)"; [ -n "$SNAP" ] || exit 0

# 본 pane(하단 줄을 붙일 자리) — 부른 pane 이 아테나·에이전트 pane 이면 그것, 아니면 도구·미리보기가 아닌 가장 큰 pane
MAIN="$(SNAP="$SNAP" python3 - "${SCREEN_PANE_ID:-}" "$EXPLORER" "$GUIDE" "${ROW[@]}" <<'PY'
import os, sys
cur, tools = sys.argv[1], set(sys.argv[2:])
rows = [l.split('\t') for l in os.environ['SNAP'].splitlines() if not l.startswith('AREA')]
ok = [r for r in rows if r[0] not in tools and not r[0].endswith('· preview')]
mine = [r for r in ok if r[1] == cur]
best = mine or sorted(ok, key=lambda r: -int(r[4]) * int(r[5]))
print(best[0][1] if best else '')
PY
)"
[ -n "$MAIN" ] || exit 0

# 지금 모양이 맞는지 — 맞으면 손대지 않는다
is_ok() {
  local present=() label id x y w h ex ey ew eh AH prev_end="" y0=""
  AH="$(awk -F'\t' '$1=="AREA"{print $6}' <<<"$SNAP")"
  # 다른 탭에 떨어진 도구 pane 이 있으면 틀린 것
  for label in "$GUIDE" "${ROW[@]}"; do
    id="$(find_ws "$label")"; [ -n "$id" ] || continue
    [ -n "$(get "$label")" ] || return 1
  done
  if [ -n "$(get "$EXPLORER")" ] && [ -n "$(get "$GUIDE")" ]; then
    read -r ex ey ew eh <<<"$(rect "$EXPLORER")"; read -r x y w h <<<"$(rect "$GUIDE")"
    [ "$x" = "$ex" ] && [ "$w" = "$ew" ] && [ "$y" = "$((ey + eh))" ] || return 1
  fi
  for label in "${ROW[@]}"; do [ -n "$(get "$label")" ] && present+=("$label"); done
  [ "${#present[@]}" -ge 1 ] || return 0
  for label in "${present[@]}"; do
    read -r x y w h <<<"$(rect "$label")"
    [ -z "$y0" ] && y0="$y"
    [ "$y" = "$y0" ] && [ "$((y + h))" = "$AH" ] || return 1
    [ -n "$prev_end" ] && [ "$x" != "$prev_end" ] && return 1
    prev_end="$((x + w))"
  done
  # 하단 줄은 Explorer 칸을 침범하지 않는다
  if [ -n "$(get "$EXPLORER")" ]; then read -r ex _ _ _ <<<"$(rect "$EXPLORER")"; [ "$prev_end" -le "$ex" ] || return 1; fi
  return 0
}
is_ok && exit 0

# ⓪ 자리는 있는데 순서만 틀렸으면 자리끼리 바꾼다(swap — 너비·위치는 그대로라 위쪽 pane 이 여럿이어도 하단 줄 폭이 유지된다)
swap_to() { # swap_to <라벨> <그 자리에 있는 pane id>
  local src; src="$(get "$1")"
  [ -n "$src" ] && [ -n "$2" ] && [ "$src" != "$2" ] && "$SCREEN" pane swap "$src" "$2" >/dev/null 2>&1
  SNAP="$(snapshot)"
}
TOOLS_RE="^($GUIDE|$MON|$BOARD|$LEARN)$"
# 가이드 메뉴: Explorer 바로 아래 칸에 다른 도구 pane 이 있으면 그것과 바꾼다
if [ -n "$(get "$EXPLORER")" ] && [ -n "$(get "$GUIDE")" ]; then
  read -r ex ey ew eh <<<"$(rect "$EXPLORER")"
  below="$(awk -F'\t' -v x="$ex" -v y="$((ey + eh))" -v re="$TOOLS_RE" '$3==x && $4==y && $1 ~ re {print $2; exit}' <<<"$SNAP")"
  swap_to "$GUIDE" "$below"
fi
# 하단 줄: 맨 아래에 붙은(Explorer 칸 왼쪽) 칸이 모두 도구 pane 이고 개수가 맞으면 왼쪽부터 모니터 | 현황판 | 배우기 검토
present=(); for label in "${ROW[@]}"; do [ -n "$(get "$label")" ] && present+=("$label"); done
AH="$(awk -F'\t' '$1=="AREA"{print $6}' <<<"$SNAP")"
EX="$(read -r x _ _ _ <<<"$(rect "$EXPLORER")"; echo "${x:-99999}")"
slots=(); all_tools=1
while IFS=$'\t' read -r label id; do
  slots+=("$id"); [[ "$label" =~ $TOOLS_RE ]] || all_tools=0
done < <(awk -F'\t' -v ah="$AH" -v ex="$EX" '$1!="AREA" && $4+$6==ah && $3+$5<=ex {print $3"\t"$1"\t"$2}' <<<"$SNAP" | sort -n | cut -f2-)
if [ "$all_tools" = 1 ] && [ "${#slots[@]}" = "${#present[@]}" ] && [ "${#slots[@]}" -ge 1 ]; then
  for ((j = 0; j < ${#present[@]}; j++)); do
    slot_id="$(awk -F'\t' -v ah="$AH" -v ex="$EX" '$1!="AREA" && $4+$6==ah && $3+$5<=ex {print $3"\t"$2}' <<<"$SNAP" | sort -n | sed -n "$((j + 1))p" | cut -f2)"
    swap_to "${present[$j]}" "$slot_id"
  done
fi
is_ok && exit 0

# ① 도구 pane(가이드·모니터·현황판·배우기 검토)을 모두 임시 탭 하나로 뺀다
PARK=""
for label in "$GUIDE" "${ROW[@]}"; do
  id="$(find_ws "$label")"; [ -n "$id" ] || continue
  if [ -z "$PARK" ]; then
    PARK="$("$SCREEN" pane move "$id" --new-tab --no-focus 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['pane']['tab_id'])" 2>/dev/null)"
    [ -n "$PARK" ] || { echo "⚠️  athena-layout: 임시 탭을 못 만들었습니다" >&2; exit 0; }
  else
    anchor="$("$SCREEN" pane list 2>/dev/null | python3 -c "import sys,json;print(next((p['id'] for p in json.load(sys.stdin)['panes'] if p['tab_id']=='$PARK' and p.get('label')!='$EXPLORER'),''))")"
    "$SCREEN" pane move "$id" --tab "$PARK" --target "$anchor" --split right --no-focus >/dev/null 2>&1
  fi
done
sleep 0.5

# ② 사이드바 Explorer 가 이 탭에 자리 잡기를 잠깐 기다린다(세션 시작 직후엔 늦게 뜬다)
for _ in 1 2 3 4 5 6 7 8 9 10; do SNAP="$(snapshot)"; [ -n "$(get "$EXPLORER")" ] && break; sleep 0.5; done

# ③ 정해진 순서로 다시 붙인다 — put <라벨> <붙일 pane> <right|down> <붙일 pane 이 남길 몫>
put() {
  local id try
  for try in 1 2 3 4 5 6; do
    id="$(find_ws "$1")"; [ -n "$id" ] || return 0
    in_tab "$id" && return 0
    "$SCREEN" pane move "$id" --tab "$TAB" --target "$2" --split "$3" --ratio "$4" --no-focus >/dev/null 2>&1
    sleep 0.4
  done
  echo "⚠️  athena-layout: $1 을 제자리로 못 옮겼습니다" >&2
}
# 하단 줄: 본 pane 아래에 첫 칸, 그 오른쪽으로 나머지를 같은 너비로
row=(); for label in "${ROW[@]}"; do [ -n "$(find_ws "$label")" ] && row+=("$label"); done
prev="$MAIN"; n="${#row[@]}"
for ((j = 0; j < n; j++)); do
  if [ "$j" = 0 ]; then put "${row[$j]}" "$MAIN" down 0.8
  else put "${row[$j]}" "$prev" right "$(python3 -c "print(round(1/($n-$j+1),3))")"; fi
  prev="$(find_ws "${row[$j]}")"
done
# 오른쪽 끝: Explorer 아래 가이드 메뉴(Explorer 가 없으면 본 pane 오른쪽)
if [ -n "$(find_ws "$GUIDE")" ]; then
  SNAP="$(snapshot)"; E="$(get "$EXPLORER")"
  if [ -n "$E" ]; then put "$GUIDE" "$E" down 0.6; else put "$GUIDE" "$MAIN" right 0.8; fi
fi

# ④ 임시 탭 정리 — 도구 pane 이 다 돌아왔고 남은 게 사이드바 Explorer 뿐이면 닫는다
if [ -n "$PARK" ]; then
  if "$SCREEN" pane list 2>/dev/null | python3 -c "import sys,json;ps=[p for p in json.load(sys.stdin)['panes'] if p['tab_id']=='$PARK'];sys.exit(0 if all(p.get('label')=='$EXPLORER' for p in ps) else 1)"; then
    "$SCREEN" tab close "$PARK" >/dev/null 2>&1 || true
  else
    echo "⚠️  athena-layout: 임시 탭 $PARK 에 도구 pane 이 남아 있습니다" >&2
  fi
fi
exit 0
