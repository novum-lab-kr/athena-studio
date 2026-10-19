# studio 백엔드(Athena Studio 데몬 CLI) 시나리오 — check.sh 가 불러 SCENARIOS 에 더한다. golden 은 golden/studio_*.txt
# 가짜 athena-studio-cli(fake-bin)가 받은 인자를 ["@studio", …] 로 같은 로그에 적는다 — 화면 계층이 CLI 를 어떤 인자로 부르는지 ·
# 납작한 JSON · 오류 옮기기(종료 1 + {"error","message"} → 그 code · 종료 3 → unavailable)를 고정한다.
# herdr 시나리오와 같은 스크립트를 studio pane 안에서(IN_STUDIO) 돌려, 백엔드만 바꿔도 아테나 스크립트가 그대로 도는지 본다.
S=scripts/screen
# studio pane p1(아테나) 안에서 부른 것처럼 — 데몬이 pane 셸에 넣어 주는 환경 변수 그대로
IN_STUDIO=(ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_TAB_ID=t1 ATHENA_STUDIO_WORKSPACE_ID=w1
           ATHENA_STUDIO_SOCKET=/tmp/athena-studio.sock ATHENA_STUDIO_CLI="$BIN/athena-studio-cli")

# 접속 파일(S4 — 데몬이 ~/.athena-studio/daemon.json 에 쓴다) — 살아 있는 것(pid 1 · 소켓 있음) · 소켓이 사라진 것 · pid 가 죽은 것
mkdir -p "$WORK/studio"
: > "$WORK/studio/daemon.sock"
printf '{"socket": "%s", "cli": "%s", "node": "/fake/electron", "pid": 1, "protocol": 3}\n' "$WORK/studio/daemon.sock" "$BIN/athena-studio-cli" > "$WORK/studio/live.json"
printf '{"socket": "%s", "cli": "%s", "node": "/fake/electron", "pid": 1, "protocol": 3}\n' "$WORK/studio/gone.sock" "$BIN/athena-studio-cli" > "$WORK/studio/nosocket.json"
/usr/bin/true & DEAD_PID=$!; wait "$DEAD_PID"
printf '{"socket": "%s", "cli": "%s", "node": "/fake/electron", "pid": %s, "protocol": 3}\n' "$WORK/studio/daemon.sock" "$BIN/athena-studio-cli" "$DEAD_PID" > "$WORK/studio/deadpid.json"
LIVE=(ATHENA_STUDIO_ENDPOINT="$WORK/studio/live.json")

# 백엔드 고르기 · self · inside · capabilities · name
sc_studio_self() {
  step studio "${IN_STUDIO[@]}" -- $S self
  step studio "${IN_STUDIO[@]}" -- $S self --format sh
  step studio "${IN_STUDIO[@]}" -- $S inside
  step studio "${IN_STUDIO[@]}" -- $S capabilities
  step studio "${IN_STUDIO[@]}" -- $S capabilities --has layout-geometry,pane-move
  step studio "${IN_STUDIO[@]}" -- $S capabilities --has herdr-sidebar
  step studio "${IN_STUDIO[@]}" -- $S capabilities --has workspaces,agent-status,process-info
  step studio "${IN_STUDIO[@]}" -- $S name
  # 둘 다 있으면 herdr(R1) — Studio 데몬은 pane 셸에서 HERDR_* 를 지우므로 둘 다 있는 건 Studio pane 안에서 켠 herdr(안쪽)뿐이다
  # 명시(ATHENA_SCREEN)는 언제나 먼저
  step studio "${IN[@]}" "${IN_STUDIO[@]}" -- $S self
  step studio "${IN_STUDIO[@]}" ATHENA_SCREEN=herdr -- $S self
  # herdr pane 안이면 데몬이 떠 있어도 herdr
  step studio "${IN[@]}" "${LIVE[@]}" -- $S self
  # pane 밖 — 접속 파일이 살아 있으면 studio(inside 아님) · 소켓이 없거나 pid 가 죽었으면 없는 것으로(herdr 명령으로)
  step studio "${LIVE[@]}" -- $S capabilities
  step studio "${LIVE[@]}" -- $S inside
  step studio ATHENA_STUDIO_ENDPOINT="$WORK/studio/nosocket.json" -- $S capabilities
  step studio ATHENA_STUDIO_ENDPOINT="$WORK/studio/deadpid.json" -- $S capabilities
  step studio ATHENA_STUDIO_ENDPOINT="$WORK/studio/deadpid.json" -- $S name
  # 접속 파일로 고른 CLI 에 소켓·node 를 넘긴다(CLI 래퍼가 그 node 로 돈다)
  step studio "${LIVE[@]}" FAKE_STUDIO_SHOW_ENV=1 -- $S pane list --format ids
  # 밖에서 ATHENA_SCREEN=studio 로 고르면 inside 아님 · pane 정보 비움
  step studio ATHENA_SCREEN=studio "${LIVE[@]}" -- $S self
}

# 동작마다 CLI 인자 · 납작한 JSON · 필터(화면 계층이 한다)
sc_studio_ops() {
  step studio "${IN_STUDIO[@]}" -- $S pane list
  step studio "${IN_STUDIO[@]}" -- $S pane list --agent-only --format ids
  step studio "${IN_STUDIO[@]}" -- $S pane list --tab self --format ids
  step studio "${IN_STUDIO[@]}" -- $S pane list --label "🤖 fe · feat/x" --format id
  step studio "${IN_STUDIO[@]}" -- $S pane list --workspace w2 --prefer-tab self --format ids
  step studio "${IN_STUDIO[@]}" -- $S pane list --cwd "$COPY" --format ids
  step studio "${IN_STUDIO[@]}" -- $S pane current --format id
  step studio "${IN_STUDIO[@]}" -- $S pane get p1
  step studio "${IN_STUDIO[@]}" -- $S pane is-shell p3
  step studio-shell,studio "${IN_STUDIO[@]}" -- $S pane is-shell p3
  step studio-shell,studio "${IN_STUDIO[@]}" -- $S pane is-shell ""
  step studio "${IN_STUDIO[@]}" -- $S pane split --target self --direction down --ratio 0.25 --cwd /tmp/x --env A=1 --env B=2 --no-focus
  step studio "${IN_STUDIO[@]}" -- $S pane split --target focused --direction right --focus --format id
  step studio "${IN_STUDIO[@]}" -- $S pane split --target p3 --direction right --ratio 0.5
  step studio "${IN_STUDIO[@]}" -- $S pane run p9 env "ATHENA_BOARD_PORT=4700" node /x/server.mjs
  step studio "${IN_STUDIO[@]}" -- $S pane run p9 less -R --format x
  step studio "${IN_STUDIO[@]}" -- $S pane send-text p2 "첫 줄 --no-focus"
  step studio "${IN_STUDIO[@]}" -- $S pane send-keys p2 C-c Enter
  step studio "${IN_STUDIO[@]}" -- $S pane rename p9 "📋 현황판"
  step studio "${IN_STUDIO[@]}" -- $S pane close p9
  step studio "${IN_STUDIO[@]}" -- $S pane read p2 --lines 20 --source visible
  step studio "${IN_STUDIO[@]}" -- $S pane wait-output p2 --match done --timeout 1000
  step studio "${IN_STUDIO[@]}" -- $S pane wait-output p2 --regex 'done$' --lines 5
  step studio "${IN_STUDIO[@]}" -- $S tab list
  step studio "${IN_STUDIO[@]}" -- $S tab list --workspace w1
  step studio "${IN_STUDIO[@]}" -- $S tab get t1
  step studio "${IN_STUDIO[@]}" -- $S tab rename t3 shop-web
  step studio "${IN_STUDIO[@]}" -- $S tab close t3
  step studio "${IN_STUDIO[@]}" -- $S workspace list
  step studio "${IN_STUDIO[@]}" -- $S workspace get w1
  step studio "${IN_STUDIO[@]}" -- $S workspace create --label shop-web --cwd /tmp/x --no-focus
  # 고정 배치·옮기기는 없다 — 데몬에 묻지 않고 unsupported
  step studio "${IN_STUDIO[@]}" -- $S pane layout --pane p1
  step studio "${IN_STUDIO[@]}" -- $S pane swap p1 p2
  step studio "${IN_STUDIO[@]}" -- $S pane move p2 --new-tab
}

# 실패 옮기기 — CLI 의 {"error","message"} code 그대로 · 종료 3 은 unavailable · 약속 밖 출력은 그대로 흘려보낸다
sc_studio_errors() {
  step studio-notfound,studio "${IN_STUDIO[@]}" -- $S pane get p99
  step studio-timeout,studio "${IN_STUDIO[@]}" -- $S pane wait-output p2 --match never --timeout 1000
  step studio-usage,studio "${IN_STUDIO[@]}" -- $S pane read p2 --ansi
  step studio-down,studio "${IN_STUDIO[@]}" -- $S pane list
  step studio-down,studio "${IN_STUDIO[@]}" -- $S pane split --target self --direction down --format id
  step studio-down,studio "${IN_STUDIO[@]}" -- $S pane is-shell p3
  step studio-broken,studio "${IN_STUDIO[@]}" -- $S pane list
  step studio-down,studio "${IN_STUDIO[@]}" -- python3 -c 'import sys; sys.path.insert(0, "scripts/lib"); import screen
try: screen.list_panes()
except screen.ScreenError as error: print(error.code, error.message)'
  # CLI 를 못 찾으면(경로가 실행 파일이 아니고 PATH 에도 없다) unavailable
  step studio "${IN_STUDIO[@]}" ATHENA_STUDIO_CLI=/nope PATH="/usr/bin:/bin" -- /usr/bin/python3 scripts/screen pane list
  step studio "${IN_STUDIO[@]}" ATHENA_STUDIO_CLI=/nope PATH="/usr/bin:/bin" -- /usr/bin/python3 scripts/screen inside
}

# node(scripts/lib/screen.mjs) — 현황판·학습 검토가 쓰는 입구
sc_studio_node() {
  cat > "$WORK/studio-node.mjs" <<'JS'
const { screen, screenSync, screenName } = await import(process.argv[2])
const listed = await screen(['pane', 'list', '--agent-only'])   // 실패면 null
console.log(JSON.stringify(listed && listed.panes.map((pane) => pane.id)))
console.log(JSON.stringify(await screen(['pane', 'send-text', 'p2', 'hi'])))
try {
  console.log(screenSync(['pane', 'current'], { stdio: ['ignore', 'pipe', 'ignore'] }).pane.id)
} catch (error) {
  console.log('screenSync 예외', error.status)
}
console.log(screenName())
JS
  step studio "${IN_STUDIO[@]}" -- node "$WORK/studio-node.mjs" "$COPY/scripts/lib/screen.mjs"
  step studio-down,studio "${IN_STUDIO[@]}" -- node "$WORK/studio-node.mjs" "$COPY/scripts/lib/screen.mjs"
}

# 아테나 스크립트를 studio pane 안에서 — herdr 시나리오와 같은 명령(백엔드만 다르다)
# 스튜디오 화면이면 현황판도 nohup(뒤에서) — 기록이 다음 시나리오로 새지 않게 기다린다(board_outside 와 같다)
sc_studio_board()    { STEP_WAIT="#nohup" step studio "${IN_STUDIO[@]}" "${PORT_ENV[@]}" -- scripts/board.sh; }
sc_studio_board_outside() { STEP_WAIT="#nohup" step studio "${LIVE[@]}" "${PORT_ENV[@]}" -- scripts/board.sh; }
sc_studio_monitor()  { step studio "${IN_STUDIO[@]}" -- scripts/monitor-pane.sh 30; step studio "${LIVE[@]}" -- scripts/monitor-pane.sh; }
sc_studio_learn()    { step studio "${IN_STUDIO[@]}" -- scripts/learn-review-pane.sh; }
sc_studio_guide()    { step studio "${IN_STUDIO[@]}" -- scripts/guide-pane.sh; }
sc_studio_layout()   { step studio "${IN_STUDIO[@]}" -- scripts/athena-layout.sh; }
sc_studio_up()       { STEP_WAIT="#nohup" step studio "${IN_STUDIO[@]}" ATHENA_BOARD_PORT=47999 -- scripts/athena-up.sh; }
sc_studio_up_firstrun() { STEP_WAIT="#nohup" step studio "${IN_STUDIO[@]}" ATHENA_BOARD_PORT=47999 ATHENA_FIRST_RUN=claude -- scripts/athena-up.sh; }
sc_studio_delegate_newws()    { step studio-newws,studio "${IN_STUDIO[@]}" -- scripts/delegate.sh fe "버튼 고쳐 줘 (긴급)" --plan plans/task/20261001-fe-test.md; cat "$COPY/plans/task/20261001-fe-test.md" >> "$RESULT"; studio_cleanup_runner; }
sc_studio_delegate_existing() { step studio-existing,studio "${IN_STUDIO[@]}" -- scripts/delegate.sh fe --plan plans/task/20261001-fe-test.md --down; cat "$COPY/plans/task/20261001-fe-test.md" >> "$RESULT"; studio_cleanup_runner; }
sc_studio_delegate_here()     { step studio "${IN_STUDIO[@]}" -- scripts/delegate.sh reviewer --here --plan plans/task/20261001-fe-test.md; cat "$COPY/plans/task/20261001-fe-test.md" >> "$RESULT"; studio_cleanup_runner; }
sc_studio_delegate_outside()  { step studio "${LIVE[@]}" -- scripts/delegate.sh fe "조사" --plan plans/task/20261001-fe-test.md; }
sc_studio_workspace_up() {
  printf '#!/usr/bin/env bash\nfake-log athena-up "FIRST_RUN=${ATHENA_FIRST_RUN:-}"\n' > "$COPY/scripts/athena-up.sh"
  printf '{"cwd": "%s", "source": "startup"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" STEP_WAIT='#athena-up' step studio "${IN_STUDIO[@]}" -- python3 scripts/hooks/workspace-up.py
  STEP_STDIN="$WORK/payload.json" step studio "${LIVE[@]}" -- python3 scripts/hooks/workspace-up.py
}
sc_studio_setup_check() {
  rm -f "$COPY/athena.config.json"
  printf '{"cwd": "%s", "source": "startup"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" step studio "${IN_STUDIO[@]}" -- python3 scripts/hooks/setup-check.py
  STEP_STDIN="$WORK/payload.json" step studio "${LIVE[@]}" -- python3 scripts/hooks/setup-check.py
}
sc_studio_compact() {
  # 계획서 Work ref 는 herdr id(w1:p1) — studio pane p1 과 섞이지 않아야 한다. studio id 로 적힌 계획서는 찾는다
  printf '# 스튜디오 압축 검사\n\n## Checkpoint\n- Updated: 2026-10-01\n- Status: in_progress\n- Work ref: /tmp · 🌿 main · pane p2 (fe)\n' > "$COPY/plans/task/20261004-fe-studio.md"
  printf '{"cwd": "%s", "source": "compact"}' "$COPY" > "$WORK/payload.json"
  STEP_STDIN="$WORK/payload.json" step studio "${IN_STUDIO[@]}" -- python3 scripts/hooks/compact-checkpoint.py post
  STEP_STDIN="$WORK/payload.json" step studio "${IN_STUDIO[@]}" ATHENA_STUDIO_PANE_ID=p2 -- python3 scripts/hooks/compact-checkpoint.py post
}
sc_studio_plan_html() { step studio "${IN_STUDIO[@]}" -- node scripts/plan-html.mjs plans/refactor/20261003-lead.md --add "$WORK/decisions.json"; }
sc_studio_server() {
  # board_server 는 herdr pane 환경(IN)으로 띄운다 — 여기서는 studio pane 환경으로 바꿔 같은 API 를 부른다
  local saved=("${IN[@]}")
  IN=("${IN_STUDIO[@]}")
  board_server studio p2 p8
  IN=("${saved[@]}")
}

# delegate.sh 실행기 지우기 — studio 기록은 ["@studio", "pane", "run", …]
studio_cleanup_runner() {
  local runner
  runner="$(python3 -c 'import json,sys
for line in open(sys.argv[1], encoding="utf-8"):
    argv = json.loads(line)
    if argv[:3] == ["@studio", "pane", "run"] and "hermes-runner." in argv[-1]: print(argv[-1])' "$LOG" | tail -1)"
  [ -f "$runner" ] && bash -c "$(sed -n 's/^cleanup() { \(rm -f .*\); }$/\1/p' "$runner")"
}

SCENARIOS+=(studio_self studio_ops studio_errors studio_node studio_board studio_board_outside studio_monitor studio_learn studio_guide
  studio_layout studio_up studio_up_firstrun studio_delegate_newws studio_delegate_existing studio_delegate_here studio_delegate_outside
  studio_workspace_up studio_setup_check studio_compact studio_plan_html studio_server)

# 탭 밖 고정 칸(dock — 앱 하단 에이전트 모니터, 프로토콜 3): pane list 에 tab_id·workspace_id 가 null 인 '🛰 에이전트 모니터' 가 섞인다
# 탭·workspace 로 거르면 빠지고(pane 밖 self 의 '' 와도 맞지 않는다) · 이름표로 찾으면 잡혀 모니터를 새로 띄우지 않고 그 칸을 다시 쓴다
sc_studio_dock() {
  step studio-dock,studio "${IN_STUDIO[@]}" -- $S pane list --tab self --format ids
  step studio-dock,studio "${IN_STUDIO[@]}" -- $S pane list --workspace self --format ids
  step studio-dock,studio "${IN_STUDIO[@]}" -- $S pane list --prefer-tab self --format ids
  step studio-dock,studio "${IN_STUDIO[@]}" -- $S pane list --agent-only --format ids
  step studio-dock,studio "${IN_STUDIO[@]}" -- $S pane list --label "🛰 에이전트 모니터" --prefer-workspace self --format id
  step studio-dock,studio "${LIVE[@]}" -- $S pane list --tab self --format ids
  step studio-dock,studio "${LIVE[@]}" -- $S pane list --workspace self --format ids
  # 고정 칸은 나눌 수 없다 — 데몬의 usage 를 그대로(fixture studio-docksplit)
  step studio-docksplit,studio-dock,studio "${IN_STUDIO[@]}" -- $S pane split --target p20 --direction right
  # 모니터: 고정 칸을 다시 쓴다(split 없음) · athena-up 도 모니터를 새로 띄우지 않는다
  step studio-dock,studio "${IN_STUDIO[@]}" -- scripts/monitor-pane.sh
  STEP_WAIT="#nohup" step studio-dock,studio "${IN_STUDIO[@]}" ATHENA_BOARD_PORT=47999 -- scripts/athena-up.sh
}
sc_studio_dock_server() {
  local saved=("${IN[@]}")
  IN=("${IN_STUDIO[@]}")
  board_server studio-dock,studio p2 p20
  IN=("${saved[@]}")
}
SCENARIOS+=(studio_dock studio_dock_server)

# 백엔드 고르기 — pane 안 표시가 athena.config.json "screen" 보다 먼저(본체 하나를 herdr·스튜디오가 같이 쓸 때 · 여러 팩 계획서)
# 설정 herdr + Studio pane 안 → studio · 설정 studio + herdr pane 안 → herdr · pane 밖이면 설정이 데몬 접속 파일보다 먼저
sc_studio_config_screen() {
  local saved
  saved="$(cat "$COPY/athena.config.json")"
  python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["screen"]=sys.argv[2]; json.dump(d, open(p,"w"))' "$COPY/athena.config.json" herdr
  step studio "${IN_STUDIO[@]}" -- $S self
  step studio "${LIVE[@]}" -- $S capabilities
  python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["screen"]=sys.argv[2]; json.dump(d, open(p,"w"))' "$COPY/athena.config.json" studio
  step studio "${IN[@]}" -- $S self
  step studio "${LIVE[@]}" ATHENA_STUDIO_ENDPOINT="$WORK/studio/deadpid.json" -- $S capabilities
  printf '%s\n' "$saved" > "$COPY/athena.config.json"
}
SCENARIOS+=(studio_config_screen)

# 주소 열기 — Studio pane 안 · pane 밖(접속 파일)이면 데몬 op open-url(그 본체 창의 옆 브라우저) ·
# http(s) 가 아니거나 · 옛 데몬(op 모름 usage) · 붙은 앱 창 없음(not_found) · 데몬 없음이면 기본 브라우저(open)로 떨어진다
sc_studio_open_url() {
  local url="http://localhost:47999/plans/refactor/20261003-lead.html"
  step studio "${IN_STUDIO[@]}" -- $S open-url "$url"
  step studio "${LIVE[@]}" -- $S open-url "$url"
  step studio "${IN_STUDIO[@]}" -- $S open-url docs/playbook.html
  step studio-oldurl,studio "${IN_STUDIO[@]}" -- $S open-url "$url"
  step studio-noapp,studio "${LIVE[@]}" -- $S open-url "$url"
  step studio-down "${IN_STUDIO[@]}" -- $S open-url "$url"
  step studio "${IN_STUDIO[@]}" ATHENA_BOARD_PORT=47999 FAKE_BOARD_UP=1 -- bash -c 'touch plans/refactor/20261003-lead.html && scripts/board.sh open plans/refactor/20261003-lead.md'
  step studio "${IN_STUDIO[@]}" ATHENA_BOARD_PORT=47999 FAKE_BOARD_UP=1 -- scripts/board.sh
}
SCENARIOS+=(studio_open_url)
