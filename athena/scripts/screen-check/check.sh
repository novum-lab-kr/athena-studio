#!/usr/bin/env bash
# 화면 계층 회귀 검사 — 각 스크립트가 herdr 를 "어떤 인자로 · 어떤 순서로" 부르는지 가짜 herdr 로 기록해 golden 과 비교한다.
# studio 백엔드도 같은 방식 — 가짜 athena-studio-cli(데몬 CLI)가 같은 로그에 ["@studio", …] 로 적는다(시나리오 studio_* · studio-scenarios.sh).
# herdr 호출을 scripts/screen 뒤로 옮겨도 화면에 하는 일이 그대로인지(같은 인자 · 같은 출력 · 같은 종료 코드) 보는 용도다.
#
# 사용: scripts/screen-check/check.sh                → golden 과 다르면 diff 를 보여 주고 1
#       scripts/screen-check/check.sh --record       → golden 을 새로 쓴다(바꾸기 전 커밋에서 한 번 · 일부러 바뀐 시나리오만)
#       scripts/screen-check/check.sh <시나리오…>      → 그 시나리오만 (--list 로 목록)
#
# 진짜 herdr·현황판·브라우저는 건드리지 않는다:
#   - 작업 트리를 임시 폴더에 복사해 그 안에서 돌린다(계획서·이슈는 fixture 로 새로 만든다)
#   - PATH 맨 앞에 fake-bin(가짜 herdr · athena-studio-cli · sleep · curl · open · nohup · gh · claude)을 두고, 환경은 env -i 로 비운 뒤 HERDR_*·ATHENA_STUDIO_* 를 직접 넣는다
#   - 진짜 Studio 데몬 접속 파일(~/.athena-studio/daemon.json)은 보지 않는다 — ATHENA_STUDIO_ENDPOINT 를 없는 파일로(있으면 pane 밖 시나리오가 studio 로 간다)
#   - herdr-sidebar-{patch,reopen}.sh 는 사본에서 기록만 하는 가짜로 바꾼다(플러그인 설치·실행 파일 복사를 하지 않게)
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
TEMPLATE="$WORK/template"; COPY="$WORK/athena"; BIN="$WORK/bin"; LOG="$WORK/herdr.log"; RESULTS="$WORK/results"
mkdir -p "$WORK/tmp" "$BIN" "$RESULTS"
cp "$HERE"/fake-bin/* "$BIN/"

# 사본에 필요한 명령(node · python3 · git)이 있는 폴더 — 가짜 bin 뒤에 둔다
SYS_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
for tool in node python3 git; do
  dir="$(dirname "$(command -v "$tool")")"
  case ":$SYS_PATH:" in *":$dir:"*) ;; *) SYS_PATH="$SYS_PATH:$dir" ;; esac
done
ENV0=(env -i HOME="$HOME" PATH="$BIN:$SYS_PATH" TMPDIR="$WORK/tmp/" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=dumb
      FAKE_HERDR_LOG="$LOG" FAKE_ATHENA="$COPY" ATHENA_STUDIO_ENDPOINT="$WORK/no-studio/daemon.json")
IN=(HERDR_ENV=1 HERDR_PANE_ID=w1:p1 HERDR_TAB_ID=w1:t1)   # herdr pane w1:p1(아테나) 안에서 부른 것처럼

# ── 작업 트리 사본(fixture 포함) ─────────────────────────────────────────
rsync -a --exclude .git --exclude .omc --exclude /repos --exclude /plans --exclude /issues --exclude /archive --exclude /.worktrees \
  --exclude node_modules --exclude '/.qa-*' --exclude '/.board-*' --exclude /.jev-log.jsonl --exclude /packs --exclude /pack \
  --exclude /patches/herdr-sidebar/bin --exclude __pycache__ --exclude /athena.config.json --exclude /.claude/settings.local.json \
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
  for stub in herdr-sidebar-patch.sh herdr-sidebar-reopen.sh; do
    printf '#!/usr/bin/env bash\nfake-log %s "$@"\n' "$stub" > "scripts/$stub"
  done
  printf '[ -n "${FAKE_PATCH_OUT:-}" ] && printf "%%s\\n" "$FAKE_PATCH_OUT"\nexit 0\n' >> scripts/herdr-sidebar-patch.sh
  chmod +x scripts/herdr-sidebar-*.sh
) || { echo "사본을 만들지 못했다" >&2; exit 1; }

fresh() { rm -rf "$COPY"; cp -R "$TEMPLATE" "$COPY"; }

# step <fixture,…> [변수=값…] -- <명령…>  — 사본 폴더에서 돌리고 명령·종료 코드·출력·herdr 호출을 결과에 덧붙인다
# STEP_STDIN 이 있으면 그 파일을 표준입력으로
step() {
  local fixtures="$1" fx="" name envs=() code
  shift
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  for name in ${fixtures//,/ } base; do fx="$fx:$HERE/fixtures/$name"; done
  : > "$LOG"
  (cd "$COPY" && "${ENV0[@]}" FAKE_HERDR_FIXTURE="${fx#:}" ${envs[@]+"${envs[@]}"} "$@" >"$WORK/out" 2>"$WORK/err" <"${STEP_STDIN:-/dev/null}")
  code=$?
  [ -n "${STEP_WAIT:-}" ] && for _ in $(seq 1 50); do grep -q "$STEP_WAIT" "$LOG" 2>/dev/null && break; /bin/sleep 0.1; done
  {
    echo "\$ ${envs[*]+${envs[*]} }$*"
    echo "--- exit $code"
    echo "--- stdout"; cat "$WORK/out"
    echo "--- stderr"; cat "$WORK/err"
    echo "--- herdr"; cat "$LOG"
  } >> "$RESULT"
}

# delegate.sh 가 만든 실행기는 가짜 pane 에서 돌지 않으니 스스로 지우지 못한다 — 실행기 안의 cleanup 줄대로 지운다
cleanup_runner() {
  local runner
  runner="$(python3 -c 'import json,sys
for line in open(sys.argv[1], encoding="utf-8"):
    argv = json.loads(line)
    if argv[:2] == ["pane", "run"] and "hermes-runner." in argv[-1]: print(argv[-1])' "$LOG" | tail -1)"
  [ -f "$runner" ] && bash -c "$(sed -n 's/^cleanup() { \(rm -f .*\); }$/\1/p' "$runner")"
}

# 함수 하나만 꺼내 부른다(메뉴 루프·워크트리 생성 없이) — extract <파일> <시작 줄 정규식> <끝 줄 정규식>
extract() { awk -v s="$2" -v e="$3" '$0 ~ s {p=1} p {print} p && $0 ~ e {exit}' "$COPY/$1"; }

# ── 시나리오 ────────────────────────────────────────────────────────────
PORT_ENV=(ATHENA_BOARD_PORT=47999 ATHENA_BOARD_NO_BROWSER=1)
sc_board_new()      { step - "${IN[@]}" "${PORT_ENV[@]}" -- scripts/board.sh; }
sc_board_reuse()    { step board-reuse "${IN[@]}" "${PORT_ENV[@]}" -- scripts/board.sh; }
sc_board_nopane()   { step - HERDR_ENV=1 HERDR_TAB_ID=w1:t1 "${PORT_ENV[@]}" -- scripts/board.sh; }
sc_board_outside()  { STEP_WAIT="#nohup" step - "${PORT_ENV[@]}" -- scripts/board.sh; }   # nohup 은 &로 뒤에서 돈다 — 기록이 다음 시나리오로 새지 않게 기다린다
sc_board_splitfail(){ step split-fail "${IN[@]}" "${PORT_ENV[@]}" -- scripts/board.sh; }
sc_monitor_new()    { step - "${IN[@]}" -- scripts/monitor-pane.sh 30; }
sc_monitor_reuse()  { step monitor-reuse "${IN[@]}" -- scripts/monitor-pane.sh; }
sc_monitor_otherws(){ step monitor-reuse HERDR_ENV=1 HERDR_PANE_ID=w9:p1 HERDR_TAB_ID=w9:t1 -- scripts/monitor-pane.sh; }
sc_monitor_outside(){ step - -- scripts/monitor-pane.sh; }
sc_learn_new()      { step - "${IN[@]}" -- scripts/learn-review-pane.sh; }
sc_learn_busy()     { step learn-reuse "${IN[@]}" -- scripts/learn-review-pane.sh; }
sc_learn_shell()    { step learn-reuse,shell "${IN[@]}" -- scripts/learn-review-pane.sh; }
sc_learn_outside()  { step - -- scripts/learn-review-pane.sh; }
sc_guide_new()      { step - "${IN[@]}" -- scripts/guide-pane.sh; }
sc_guide_file()     { step - "${IN[@]}" -- scripts/guide-pane.sh docs/setup.md; }
sc_guide_nopane()   { step - HERDR_ENV=1 HERDR_TAB_ID=w1:t1 -- scripts/guide-pane.sh; }
sc_guide_busy()     { step guide-reuse "${IN[@]}" -- scripts/guide-pane.sh; }
sc_guide_shell()    { step guide-reuse,shell "${IN[@]}" -- scripts/guide-pane.sh; }
sc_guide_menu() {
  extract scripts/guide-menu.sh '^ask_claude\\(\\)' '^}' > "$WORK/ask.sh"
  step - "${IN[@]}" ATHENA_DIR="$COPY" -- bash -c '. "$1"; ask_claude "/board 열어 줘"; echo "rc=$?"' _ "$WORK/ask.sh"
  step - ATHENA_DIR="$COPY" -- bash -c '. "$1"; ask_claude "/board 열어 줘"; echo "rc=$?"' _ "$WORK/ask.sh"
}
sc_new_branch() {
  extract scripts/new-branch.sh '^# 에이전트 pane 안에서 브랜치를 새로 정했으면' '^fi$' > "$WORK/rename.sh"
  step - "${IN[@]}" ROOT="$COPY" ATHENA_AGENT=fe -- bash -c 'created=1 DRY_RUN=0 BRANCH=feat/x; . "$1"; echo "rc=$?"' _ "$WORK/rename.sh"
  step - ROOT="$COPY" ATHENA_AGENT=fe -- bash -c 'created=1 DRY_RUN=0 BRANCH=feat/x; . "$1"; echo "rc=$?"' _ "$WORK/rename.sh"
}
sc_delegate_newws()    { step delegate-newws "${IN[@]}" -- scripts/delegate.sh fe "버튼 고쳐 줘 (긴급)" --plan plans/task/20261001-fe-test.md; cat "$COPY/plans/task/20261001-fe-test.md" >> "$RESULT"; cleanup_runner; }
sc_delegate_existing() { step delegate-existing "${IN[@]}" -- scripts/delegate.sh fe --plan plans/task/20261001-fe-test.md --down; cat "$COPY/plans/task/20261001-fe-test.md" >> "$RESULT"; cleanup_runner; }
sc_delegate_here()     { step - "${IN[@]}" -- scripts/delegate.sh reviewer --here --plan plans/task/20261001-fe-test.md; cat "$COPY/plans/task/20261001-fe-test.md" >> "$RESULT"; cleanup_runner; }
sc_delegate_outside()  { step - -- scripts/delegate.sh fe "조사" --plan plans/task/20261001-fe-test.md; }
sc_layout_ok()      { step layout-ok "${IN[@]}" -- scripts/athena-layout.sh; }
sc_layout_swap()    { step layout-swap "${IN[@]}" -- scripts/athena-layout.sh; }
sc_layout_arg()     { step layout-swap HERDR_ENV=1 HERDR_PANE_ID=w1:p3 -- scripts/athena-layout.sh w1:t1; }
sc_layout_other()   { step layout-other "${IN[@]}" -- scripts/athena-layout.sh; }
sc_layout_base()    { step - "${IN[@]}" -- scripts/athena-layout.sh; }
sc_up_normal()      { step - "${IN[@]}" ATHENA_BOARD_PORT=47999 -- scripts/athena-up.sh; }
sc_up_redeploy()    { step - "${IN[@]}" ATHENA_BOARD_PORT=47999 "FAKE_PATCH_OUT=  ✔ 패치판 교체" -- scripts/athena-up.sh; }
sc_up_firstrun()    { step - "${IN[@]}" ATHENA_BOARD_PORT=47999 ATHENA_FIRST_RUN=codex -- scripts/athena-up.sh; }
sc_up_outside()     { step - -- scripts/athena-up.sh; }
sc_workspace_up() {
  printf '#!/usr/bin/env bash\nfake-log athena-up "FIRST_RUN=${ATHENA_FIRST_RUN:-}"\n' > "$COPY/scripts/athena-up.sh"
  printf '{"cwd": "%s", "source": "startup"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" STEP_WAIT='#athena-up' step - "${IN[@]}" -- python3 scripts/hooks/workspace-up.py
  STEP_STDIN="$WORK/payload.json" step board-reuse HERDR_ENV=1 HERDR_PANE_ID=w2:p3 -- python3 scripts/hooks/workspace-up.py
  /bin/sleep 0.5; { echo "--- 늦게 온 기록"; cat "$LOG"; } >> "$RESULT"
  STEP_STDIN="$WORK/payload.json" step - HERDR_ENV=1 -- python3 scripts/hooks/workspace-up.py
}
sc_setup_check() {
  rm -f "$COPY/athena.config.json"
  printf '{"cwd": "%s", "source": "startup"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" step - "${IN[@]}" -- python3 scripts/hooks/setup-check.py
  STEP_STDIN="$WORK/payload.json" step - HERDR_ENV=1 -- python3 scripts/hooks/setup-check.py
}
sc_compact() {
  printf '{"cwd": "%s", "source": "compact"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" step - "${IN[@]}" -- python3 scripts/hooks/compact-checkpoint.py post
  STEP_STDIN="$WORK/payload.json" step - HERDR_ENV=1 -- python3 scripts/hooks/compact-checkpoint.py post
}
sc_plan_html() {
  step - "${IN[@]}" -- node scripts/plan-html.mjs plans/refactor/20261003-lead.md --add "$WORK/decisions.json"
  step - -- node scripts/plan-html.mjs plans/task/20261001-fe-test.md --add "$WORK/decisions.json"
}
# 현황판 서버 — 띄우고 API 로 지금 동작 중(pane 목록) · [직접 지시](send-text + Enter) · 이슈 [처리 시작 → 아테나](새 pane) 를 부른다.
# 3초마다 도는 pane list 는 횟수가 들쭉날쭉하니 빼고, 한 번이라도 불렸는지만 적는다
sc_board_server() { board_server base; }
board_server() { # board_server <fixture,…> [<직접 지시할 에이전트 pane> <없는 pane>]  — pane id 는 백엔드마다 모양이 다르다
  local port=47998 url token code fx="" name agent_pane="${2:-w1:p2}" missing_pane="${3:-w2:p1}"
  for name in ${1//,/ } base; do fx="$fx:$HERE/fixtures/$name"; done
  url="http://localhost:$port"
  : > "$LOG"
  # 포트를 이미 누가 쓰면(앞선 검사가 남긴 서버 등) 그 서버의 답을 기록하게 된다 — 기록하지 않고 실패로 알린다
  if /usr/bin/curl -s -o /dev/null --max-time 1 "$url/api/state"; then
    echo "--- 포트 $port 를 이미 쓰는 서버가 있다 — 끄고 다시 돌린다(lsof -tiTCP:$port -sTCP:LISTEN)" >> "$RESULT"; return
  fi
  (cd "$COPY" && "${ENV0[@]}" FAKE_HERDR_FIXTURE="${fx#:}" "${IN[@]}" ATHENA_BOARD_PORT=$port node scripts/board/server.mjs >"$WORK/server.out" 2>&1) &
  local server=$!
  # 첫 수집(pane 목록)이 끝날 때까지 — 그 전에는 /api/state 가 빈 상태로 답한다
  for _ in $(seq 1 100); do /usr/bin/curl -s --max-time 1 "$url/api/state" 2>/dev/null | grep -q '"panes"' && break; /bin/sleep 0.1; done
  token="$(/usr/bin/curl -s "$url/" | python3 -c "import sys,re;print(re.search(r\"const TOKEN = '([0-9a-f]+)'\", sys.stdin.read()).group(1))")"
  post() { /usr/bin/curl -s -X POST "$url$1" -H "Origin: $url" -H "x-board-token: $token" -H 'Content-Type: application/json' --data "$2"; echo; }
  {
    echo "--- state"
    /usr/bin/curl -s "$url/api/state" | python3 -c "import sys,json;s=json.load(sys.stdin);print(json.dumps({'available': s.get('herdr', s.get('screen')), 'panes': s['panes']}, ensure_ascii=False, indent=1))"
    echo "--- action"; post /api/action "{\"pane\": \"$agent_pane\", \"text\": \"첫 줄\\n  둘째 줄\"}"
    echo "--- action(없는 pane)"; post /api/action "{\"pane\": \"$missing_pane\", \"text\": \"x\"}"
    echo "--- hermes-new"; post /api/hermes-new '{"id": "issues/20261001-test.md", "text": "이슈 처리해 줘"}'
  } >> "$RESULT"
  { pkill -P "$server"; kill "$server"; wait "$server"; } 2>/dev/null
  {
    echo "--- herdr (pane list 뺌)"; grep -Ev '^\[("@studio", )?"pane", "list"\]$' "$LOG"
    echo "--- pane list 불림: $(grep -Ec '^\[("@studio", )?"pane", "list"\]$' "$LOG" | awk '{print ($1 > 0) ? "예" : "아니오"}')"
  } >> "$RESULT"
}

# 이름표(label) 없이 title·name 만 도구 이름인 pane(fixtures/titled) — 도구 pane 으로 치지 않는다(원래 스크립트는 label 만, board.sh 는 label·name 을 봤다)
sc_titled_board()   { step titled "${IN[@]}" "${PORT_ENV[@]}" -- scripts/board.sh; }
sc_titled_monitor() { step titled "${IN[@]}" -- scripts/monitor-pane.sh; }
sc_titled_learn()   { step titled "${IN[@]}" -- scripts/learn-review-pane.sh; }
sc_titled_guide()   { step titled "${IN[@]}" -- scripts/guide-pane.sh; }
sc_titled_layout()  { step titled HERDR_ENV=1 HERDR_PANE_ID=w1:pG HERDR_TAB_ID=w1:t1 -- scripts/athena-layout.sh; }
sc_titled_workspace_up() {
  printf '#!/usr/bin/env bash\nfake-log athena-up "FIRST_RUN=${ATHENA_FIRST_RUN:-}"\n' > "$COPY/scripts/athena-up.sh"
  printf '{"cwd": "%s", "source": "resume"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" STEP_WAIT='#athena-up' step titled HERDR_ENV=1 HERDR_PANE_ID=w1:pG HERDR_TAB_ID=w1:t1 -- python3 scripts/hooks/workspace-up.py
}
sc_titled_server()  { board_server titled; }

SCENARIOS=(board_new board_reuse board_nopane board_outside board_splitfail monitor_new monitor_reuse monitor_otherws monitor_outside
  learn_new learn_busy learn_shell learn_outside guide_new guide_file guide_nopane guide_busy guide_shell guide_menu new_branch
  delegate_newws delegate_existing delegate_here delegate_outside layout_ok layout_swap layout_arg layout_other layout_base
  up_normal up_redeploy up_firstrun up_outside workspace_up setup_check compact plan_html board_server
  titled_board titled_monitor titled_learn titled_guide titled_layout titled_workspace_up titled_server)
# 화면 계층 자체(scripts/screen) 검사 — 있으면 같이 돈다
[ -f "$HERE/cli-scenarios.sh" ] && . "$HERE/cli-scenarios.sh"
# studio 백엔드(가짜 데몬 CLI) — 같은 스크립트를 studio pane 안에서
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
