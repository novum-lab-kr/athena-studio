#!/usr/bin/env bash
# 화면 계층 회귀 검사 — 각 스크립트가 화면(Athena Studio 데몬 CLI)을 "어떤 인자로 · 어떤 순서로" 부르는지 가짜 athena-studio-cli 로 기록해 golden 과 비교한다.
# 가짜 데몬 CLI 는 받은 인자를 로그에 ["@studio", …] 로 적고, 가짜 명령(nohup · open …)은 ["#<이름>", …] 로 같은 로그에 적는다.
# 시나리오: 화면 밖(none — 여기) · 화면 계층 자체(cli-scenarios.sh) · Studio pane 안·밖(studio_* · studio-scenarios.sh)
#
# 사용: scripts/screen-check/check.sh                → golden 과 다르면 diff 를 보여 주고 1
#       scripts/screen-check/check.sh --record       → golden 을 새로 쓴다(일부러 바뀐 시나리오만 — 바꾼 뒤 git diff 로 golden 변화를 확인한다)
#       scripts/screen-check/check.sh <시나리오…>      → 그 시나리오만 (--list 로 목록)
#
# 진짜 Studio 데몬·현황판·브라우저는 건드리지 않는다:
#   - 작업 트리를 임시 폴더에 복사해 그 안에서 돌린다(계획서·이슈는 fixture 로 새로 만든다)
#   - PATH 맨 앞에 fake-bin(가짜 athena-studio-cli · sleep · curl · open · nohup · gh · claude)을 두고, 환경은 env -i 로 비운 뒤 ATHENA_STUDIO_* 를 직접 넣는다
#   - 진짜 Studio 데몬 접속 파일(~/.athena-studio/daemon.json)은 보지 않는다 — ATHENA_STUDIO_ENDPOINT 를 없는 파일로(있으면 pane 밖 시나리오가 studio 로 간다)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ATHENA_DIR="$(cd "$HERE/../.." && pwd -P)"

MODE=check; ONLY=()
for arg in "$@"; do
  case "$arg" in
    --record) MODE=record ;;
    --list) MODE=list ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ONLY+=("$arg") ;;
  esac
done

WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/screen-check.XXXXXX")" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
TEMPLATE="$WORK/template"; COPY="$WORK/athena"; BIN="$WORK/bin"; LOG="$WORK/screen.log"; RESULTS="$WORK/results"
mkdir -p "$WORK/tmp" "$BIN" "$RESULTS"
cp "$HERE"/fake-bin/* "$BIN/"

# 사본에 필요한 명령(node · python3 · git)이 있는 폴더 — 가짜 bin 뒤에 둔다
SYS_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
for tool in node python3 git; do
  dir="$(dirname "$(command -v "$tool")")"
  case ":$SYS_PATH:" in *":$dir:"*) ;; *) SYS_PATH="$SYS_PATH:$dir" ;; esac
done
ENV0=(env -i HOME="$HOME" PATH="$BIN:$SYS_PATH" TMPDIR="$WORK/tmp/" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=dumb
      FAKE_SCREEN_LOG="$LOG" FAKE_ATHENA="$COPY" ATHENA_STUDIO_ENDPOINT="$WORK/no-studio/daemon.json")
# studio pane p1(아테나) 안에서 부른 것처럼 — 데몬이 pane 셸에 넣어 주는 환경 변수 그대로
IN=(ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_TAB_ID=t1 ATHENA_STUDIO_WORKSPACE_ID=w1
    ATHENA_STUDIO_SOCKET=/tmp/athena-studio.sock ATHENA_STUDIO_CLI="$BIN/athena-studio-cli")

# ── 작업 트리 사본(fixture 포함) ─────────────────────────────────────────
rsync -a --exclude .git --exclude .omc --exclude /repos --exclude /plans --exclude /issues --exclude /archive --exclude /.worktrees \
  --exclude node_modules --exclude '/.qa-*' --exclude '/.board-*' --exclude /.jev-log.jsonl --exclude /packs --exclude /pack \
  --exclude __pycache__ --exclude /athena.config.json --exclude /.claude/settings.local.json \
  --exclude /.pack-data --exclude '/.pack-data.*' --exclude /.sync --exclude '/.migrate-*' --exclude /test \
  --exclude /scripts/screen-check "$ATHENA_DIR/" "$TEMPLATE/"
(
  cd "$TEMPLATE" || exit 1
  printf '{\n  "reposRoot": "..",\n  "repos": [{ "name": "shop-web", "agents": ["fe"] }]\n}\n' > athena.config.json
  printf -- '---\nname: fe\ndescription: 검사용 에이전트\n---\n검사용\n' > .claude/agents/fe.md
  mkdir -p repos/shop-web plans/task plans/refactor issues
  git -C repos/shop-web init -q -b main && git -C repos/shop-web -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  printf '# 검사 작업\n\n## Checkpoint\n- Updated: 2026-10-01\n- Status: in_progress\n- Owner: t\n- Agent: fe\n- Issue: \n- Work ref: (디스패치할 때 채운다 — 워크트리 · 브랜치 · pane)\n\n## 지시\n검사\n' > plans/task/20261001-fe-test.md
  printf '# 압축 검사\n\n## Checkpoint\n- Updated: 2026-10-01\n- Status: in_progress\n- Work ref: /tmp · 🌿 main · pane w1:p1 (fe)\n' > plans/task/20261002-fe-compact.md
  printf '# 정식 검사\n\n## Checkpoint\n- Status: planned\n' > plans/refactor/20261003-lead.md
  printf '[{ "id": "r1", "title": "R1 검사", "desc": "영향", "type": "single", "required": true, "options": [{ "label": "A 그대로", "desc": "설명", "recommended": true }] }]\n' > "$WORK/decisions.json"
  printf -- '---\ntitle: 검사 이슈\nstatus: open\nrepo: athena\n---\n본문\n' > issues/20261001-test.md
) || { echo "사본을 만들지 못했다" >&2; exit 1; }

fresh() { rm -rf "$COPY"; cp -R "$TEMPLATE" "$COPY"; }

# step <fixture,…|-> [변수=값…] -- <명령…>  — 사본 폴더에서 돌리고 명령·종료 코드·출력·화면 호출 기록을 결과에 덧붙인다(- 는 fixture 없음)
# STEP_STDIN 이 있으면 그 파일을 표준입력으로
step() {
  local fixtures="$1" fx="" name envs=() code
  shift
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  for name in ${fixtures//,/ }; do [ "$name" = - ] || fx="$fx:$HERE/fixtures/$name"; done
  : > "$LOG"
  (cd "$COPY" && "${ENV0[@]}" FAKE_SCREEN_FIXTURE="${fx#:}" ${envs[@]+"${envs[@]}"} "$@" >"$WORK/out" 2>"$WORK/err" <"${STEP_STDIN:-/dev/null}")
  code=$?
  [ -n "${STEP_WAIT:-}" ] && for _ in $(seq 1 50); do grep -q "$STEP_WAIT" "$LOG" 2>/dev/null && break; /bin/sleep 0.1; done
  {
    echo "\$ ${envs[*]+${envs[*]} }$*"
    echo "--- exit $code"
    echo "--- stdout"; cat "$WORK/out"
    echo "--- stderr"; cat "$WORK/err"
    echo "--- screen"; cat "$LOG"
  } >> "$RESULT"
}

# delegate.sh 가 만든 실행기는 가짜 pane 에서 돌지 않으니 스스로 지우지 못한다 — 실행기 안의 cleanup 줄대로 지운다(기록은 ["@studio", "pane", "run", …])
cleanup_runner() {
  local runner
  runner="$(python3 -c 'import json,sys
for line in open(sys.argv[1], encoding="utf-8"):
    argv = json.loads(line)
    if argv[:3] == ["@studio", "pane", "run"] and "hermes-runner." in argv[-1]: print(argv[-1])' "$LOG" | tail -1)"
  [ -f "$runner" ] && bash -c "$(sed -n 's/^cleanup() { \(rm -f .*\); }$/\1/p' "$runner")"
}

# 함수 하나만 꺼내 부른다(메뉴 루프·워크트리 생성 없이) — extract <파일> <시작 줄 정규식> <끝 줄 정규식>
extract() { awk -v s="$2" -v e="$3" '$0 ~ s {p=1} p {print} p && $0 ~ e {exit}' "$COPY/$1"; }

# ── 시나리오 ────────────────────────────────────────────────────────────
# 화면 밖(none — Studio pane 밖 · 데몬 없음): 스크립트가 원래 하던 대체 동작(nohup · 직접 실행 안내 · 건너뜀)을 한다
PORT_ENV=(ATHENA_BOARD_PORT=47999 ATHENA_BOARD_NO_BROWSER=1)
sc_board_outside()  { STEP_WAIT="#nohup" step - "${PORT_ENV[@]}" -- scripts/board.sh; }   # nohup 은 &로 뒤에서 돈다 — 기록이 다음 시나리오로 새지 않게 기다린다
sc_monitor_outside(){ step - -- scripts/monitor-pane.sh; }
sc_guide_menu() {
  # ask_claude 는 shell_line(scripts/lib/shell-line.sh)을 쓴다 — 함수만 잘라 내니 도우미도 같이 싣는다 · Studio pane 안 · 밖
  { cat "$COPY/scripts/lib/shell-line.sh"; extract scripts/guide-menu.sh '^ask_claude\\(\\)' '^}'; } > "$WORK/ask.sh"
  step studio "${IN[@]}" ATHENA_DIR="$COPY" -- bash -c '. "$1"; ask_claude "/board 열어 줘"; echo "rc=$?"' _ "$WORK/ask.sh"
  step - ATHENA_DIR="$COPY" -- bash -c '. "$1"; ask_claude "/board 열어 줘"; echo "rc=$?"' _ "$WORK/ask.sh"
}
sc_new_branch() {
  extract scripts/new-branch.sh '^# 에이전트 pane 안에서 브랜치를 새로 정했으면' '^fi$' > "$WORK/rename.sh"
  step studio "${IN[@]}" ROOT="$COPY" ATHENA_AGENT=fe -- bash -c 'created=1 DRY_RUN=0 BRANCH=feat/x; . "$1"; echo "rc=$?"' _ "$WORK/rename.sh"
  step - ROOT="$COPY" ATHENA_AGENT=fe -- bash -c 'created=1 DRY_RUN=0 BRANCH=feat/x; . "$1"; echo "rc=$?"' _ "$WORK/rename.sh"
}
sc_delegate_outside()  { step - -- scripts/delegate.sh fe "조사" --plan plans/task/20261001-fe-test.md; }
sc_up_outside()     { step - -- scripts/athena-up.sh; }
sc_setup_check() {
  rm -f "$COPY/athena.config.json"
  printf '{"cwd": "%s", "source": "startup"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" step - -- python3 scripts/hooks/setup-check.py
}
sc_compact() {
  printf '{"cwd": "%s", "source": "compact"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" step - -- python3 scripts/hooks/compact-checkpoint.py post
}
sc_plan_html() { step - -- node scripts/plan-html.mjs plans/task/20261001-fe-test.md --add "$WORK/decisions.json"; }
# 현황판 서버 — 띄우고 API 로 지금 동작 중(pane 목록) · [직접 지시](send-text + Enter) · 이슈 [처리 시작 → 아테나](새 pane) 를 부른다.
# 3초마다 도는 pane list 는 횟수가 들쭉날쭉하니 빼고, 한 번이라도 불렸는지만 적는다 · Studio pane 환경(IN)으로 띄운다
board_server() { # board_server <fixture,…> <직접 지시할 에이전트 pane> <없는 pane>
  local port=47998 url token code fx="" name agent_pane="$2" missing_pane="$3"
  for name in ${1//,/ }; do fx="$fx:$HERE/fixtures/$name"; done
  url="http://localhost:$port"
  : > "$LOG"
  # 포트를 이미 누가 쓰면(앞선 검사가 남긴 서버 등) 그 서버의 답을 기록하게 된다 — 기록하지 않고 실패로 알린다
  if /usr/bin/curl -s -o /dev/null --max-time 1 "$url/api/state"; then
    echo "--- 포트 $port 를 이미 쓰는 서버가 있다 — 끄고 다시 돌린다(lsof -tiTCP:$port -sTCP:LISTEN)" >> "$RESULT"; return
  fi
  (cd "$COPY" && "${ENV0[@]}" FAKE_SCREEN_FIXTURE="${fx#:}" "${IN[@]}" ATHENA_BOARD_PORT=$port node scripts/board/server.mjs >"$WORK/server.out" 2>&1) &
  local server=$!
  # 첫 수집(pane 목록)이 끝날 때까지 — 그 전에는 /api/state 가 빈 상태로 답한다
  for _ in $(seq 1 100); do /usr/bin/curl -s --max-time 1 "$url/api/state" 2>/dev/null | grep -q '"panes"' && break; /bin/sleep 0.1; done
  token="$(/usr/bin/curl -s "$url/" | python3 -c "import sys,re;print(re.search(r\"const TOKEN = '([0-9a-f]+)'\", sys.stdin.read()).group(1))")"
  post() { /usr/bin/curl -s -X POST "$url$1" -H "Origin: $url" -H "x-board-token: $token" -H 'Content-Type: application/json' --data "$2"; echo; }
  {
    echo "--- state"
    /usr/bin/curl -s "$url/api/state" | python3 -c "import sys,json;s=json.load(sys.stdin);print(json.dumps({'available': s.get('screen'), 'panes': s['panes']}, ensure_ascii=False, indent=1))"
    echo "--- action"; post /api/action "{\"pane\": \"$agent_pane\", \"text\": \"첫 줄\\n  둘째 줄\"}"
    echo "--- action(없는 pane)"; post /api/action "{\"pane\": \"$missing_pane\", \"text\": \"x\"}"
    echo "--- hermes-new"; post /api/hermes-new '{"id": "issues/20261001-test.md", "text": "이슈 처리해 줘"}'
  } >> "$RESULT"
  { pkill -P "$server"; kill "$server"; wait "$server"; } 2>/dev/null
  {
    echo "--- screen (pane list 뺌)"; grep -Ev '^\["@studio", "pane", "list"\]$' "$LOG"
    echo "--- pane list 불림: $(grep -Ec '^\["@studio", "pane", "list"\]$' "$LOG" | awk '{print ($1 > 0) ? "예" : "아니오"}')"
  } >> "$RESULT"
}

SCENARIOS=(board_outside monitor_outside guide_menu new_branch delegate_outside up_outside setup_check compact plan_html)
# 화면 계층 자체(scripts/screen) 검사 — 있으면 같이 돈다
[ -f "$HERE/cli-scenarios.sh" ] && . "$HERE/cli-scenarios.sh"
# studio 백엔드(가짜 데몬 CLI) — 아테나 스크립트를 Studio pane 안·밖에서
[ -f "$HERE/studio-scenarios.sh" ] && . "$HERE/studio-scenarios.sh"

if [ "$MODE" = list ]; then printf '%s\n' "${SCENARIOS[@]}"; exit 0; fi
[ "${#ONLY[@]}" -gt 0 ] && SCENARIOS=("${ONLY[@]}")

# 경로·임시 파일 이름·bash 줄 번호처럼 돌릴 때마다(또는 줄을 옮기면) 바뀌는 것만 고정 문자열로 바꾼다
normalize() {
  python3 - "$1" "$COPY" "$WORK" <<'PY'
import re, sys
path, copy, work = sys.argv[1:4]
text = open(path, encoding='utf-8').read()
for real, alias in ((copy, '<ATHENA>'), (work, '<WORK>')):
    text = text.replace(real, alias)
    if real.startswith('/private/'):
        text = text.replace(real[len('/private'):], alias)
# delegate.sh 의 mktemp -t 는 macOS 에서 TMPDIR 를 보지 않고 사용자 임시 폴더에 만든다 — 폴더째 고정 문자열로
text = re.sub(r'[^\s"\']*/(hermes-(?:runner|prompt|settings|agents|context|plan-prompt))\.[A-Za-z0-9]+', r'<TMP>/\1.X', text)
text = re.sub(r'(hermes-issue-(?:runner|prompt))-[0-9a-f]{8}', r'\1-X', text)
text = re.sub(r'(\.sh): line [0-9]+:', r'\1: line N:', text)
text = re.sub(r'<WORK>/tmp//+', '<WORK>/tmp/', text)
# reviewer 를 띄운 시각(delegate.sh 의 '- Review: … · 띄움 <시각>') — 돌릴 때마다 다르다
text = re.sub(r'띄움 \d{4}-\d{2}-\d{2} \d{2}:\d{2}', '띄움 <TIME>', text)
open(path, 'w', encoding='utf-8').write(text)
PY
}

failed=0
for name in "${SCENARIOS[@]}"; do
  declare -F "sc_$name" >/dev/null || { echo "그런 시나리오가 없다: $name" >&2; failed=$((failed + 1)); continue; }
  RESULT="$RESULTS/$name.txt"; : > "$RESULT"
  fresh
  "sc_$name"
  normalize "$RESULT"
  golden="$HERE/golden/$name.txt"
  if [ "$MODE" = record ]; then
    cp "$RESULT" "$golden"; echo "기록: $name"
  elif [ ! -f "$golden" ]; then
    echo "✖ $name — golden 이 없다 (--record)"; failed=$((failed + 1))
  elif diff -u "$golden" "$RESULT" > "$WORK/diff"; then
    echo "✔ $name"
  else
    echo "✖ $name"; sed 's/^/    /' "$WORK/diff"; failed=$((failed + 1))
  fi
done
[ "$MODE" = record ] && exit 0
echo "${#SCENARIOS[@]}개 중 실패 $failed"
[ "$failed" = 0 ]
