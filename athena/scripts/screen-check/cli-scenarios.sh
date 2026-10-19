# 화면 계층 자체(scripts/screen · scripts/lib/screen.mjs) 시나리오 — check.sh 가 불러 SCENARIOS 에 더한다.
# 동작마다 herdr 를 어떤 인자로 부르는지 · 납작한 JSON · 실패 때 출력과 종료 코드를 golden 으로 고정한다.
S=scripts/screen
sc_cli_self() {
  step - "${IN[@]}" -- $S self
  step - "${IN[@]}" -- $S self --format sh
  step - "${IN[@]}" -- $S inside
  step - HERDR_PANE_ID=w1:p1 -- $S inside
  step - HERDR_PANE_ID=nocolon -- $S self
  step - "${IN[@]}" ATHENA_SCREEN=none -- $S self
  step - "${IN[@]}" ATHENA_SCREEN=none -- $S pane list
  step studio "${IN[@]}" ATHENA_SCREEN=studio -- $S self
  step studio "${IN[@]}" ATHENA_SCREEN=studio -- $S inside
  step studio "${IN[@]}" ATHENA_SCREEN=studio -- $S pane split --target self --direction down
  step studio "${IN[@]}" ATHENA_SCREEN=studio -- $S capabilities
  step - "${IN[@]}" ATHENA_SCREEN=bogus -- $S self
  step - "${IN[@]}" -- $S capabilities
  step - "${IN[@]}" -- $S capabilities --has layout-geometry,pane-move
  step - "${IN[@]}" -- $S capabilities --has herdr-sidebar,nope
  step - -- $S
  step - -- $S pane frobnicate
}
sc_cli_split() {
  step - "${IN[@]}" -- $S pane split --target self --direction down --ratio 0.25 --cwd /tmp/x --no-focus
  step - HERDR_ENV=1 -- $S pane split --target self --direction right --ratio 0.6 --cwd /tmp/x --env A=1 --env B=2 --no-focus --format id
  step - "${IN[@]}" -- $S pane split --target focused --direction down --ratio 0.5 --cwd /tmp/x --focus
  step - "${IN[@]}" -- $S pane split --target w2:p1 --direction right --ratio 0.5 --cwd /tmp/x --no-focus
  step - "${IN[@]}" -- $S pane split --target self
  step split-fail "${IN[@]}" -- $S pane split --target self --direction down
  step split-fail "${IN[@]}" -- $S pane split --target self --direction down --format id
}
sc_cli_list() {
  step - "${IN[@]}" -- $S pane list
  step monitor-reuse "${IN[@]}" -- $S pane list --label "🛰 에이전트 모니터" --format id
  step monitor-reuse "${IN[@]}" -- $S pane list --label "🛰 에이전트 모니터" --prefer-workspace self --format ids
  step monitor-reuse HERDR_ENV=1 -- $S pane list --label "🛰 에이전트 모니터" --prefer-workspace self --format id
  step guide-reuse "${IN[@]}" -- $S pane list --tab self --label "가이드 메뉴" --format id
  step guide-reuse HERDR_ENV=1 -- $S pane list --tab self --label "가이드 메뉴" --format id
  step learn-reuse "${IN[@]}" -- $S pane list --label "📚 배우기 검토" --cwd "$COPY" --format ids
  step - "${IN[@]}" -- $S pane list --agent-only --format ids
  step - "${IN[@]}" -- $S pane list --workspace w2 --format ids
  step layout-swap "${IN[@]}" -- $S pane list --label "가이드 메뉴" --workspace w2 --prefer-tab self --format id
  step - "${IN[@]}" -- $S pane list --label nothing --format id
}
sc_cli_ops() {
  step - "${IN[@]}" -- $S pane current
  step - "${IN[@]}" -- $S pane current --format id
  step - "${IN[@]}" -- $S pane get w1:p1
  step - "${IN[@]}" -- $S pane layout --pane w1:p1
  step - "${IN[@]}" -- $S pane is-shell w1:p4
  step shell "${IN[@]}" -- $S pane is-shell w1:p4
  step shell "${IN[@]}" -- $S pane is-shell ""
  step - "${IN[@]}" -- $S pane run w1:p9 bash -c "/x/agent-monitor.py --stay --recent "
  step - "${IN[@]}" -- $S pane run w1:p9 less -R --format x
  step - "${IN[@]}" -- $S pane send-text w1:p2 "첫 줄 --no-focus"
  step - "${IN[@]}" -- $S pane send-keys w1:p2 C-c
  step - "${IN[@]}" -- $S pane rename w1:p9 "📋 현황판"
  step - "${IN[@]}" -- $S pane swap w1:p3 w1:p5
  step - "${IN[@]}" -- $S pane move w1:p5 --new-tab --no-focus
  step - "${IN[@]}" -- $S pane move w1:p5 --tab w1:t9 --target "" --split right --no-focus
  step - "${IN[@]}" -- $S pane move w1:p5 --tab w1:t1 --target w1:p1 --split down --ratio 0.8 --no-focus --format id
  step - "${IN[@]}" -- $S pane close w1:p9
  step - "${IN[@]}" -- $S pane read w1:p2 --lines 20
  step - "${IN[@]}" -- $S pane wait-output w1:p2 --match done --timeout 1000
  step - "${IN[@]}" -- $S tab list --workspace w1
  step - "${IN[@]}" -- $S tab get w7:t3
  step - "${IN[@]}" -- $S tab rename w3:t1 shop-web
  step - "${IN[@]}" -- $S tab close w1:t9
  step - "${IN[@]}" -- $S workspace list
  step - "${IN[@]}" -- $S workspace get w2
  step - "${IN[@]}" -- $S workspace create --label shop-web --cwd /tmp/x --no-focus
}
sc_cli_node() {
  cat > "$WORK/node-check.mjs" <<'JS'
const { screen, screenSync } = await import(process.argv[2])
console.log(JSON.stringify((await screen(['pane', 'list', '--agent-only'])).panes.map((pane) => pane.id)))
console.log(JSON.stringify(await screen(['pane', 'send-text', 'w1:p2', 'hi'])))
console.log(screenSync(['pane', 'current']).pane.id)
process.env.ATHENA_SCREEN = 'studio'
console.log(JSON.stringify(await screen(['pane', 'list'])))
JS
  step studio "${IN[@]}" -- node "$WORK/node-check.mjs" "$COPY/scripts/lib/screen.mjs"
}
# 이름표·name·pane 제목은 따로 — --label 은 이름표만, --label-or-name 은 이름표 또는 name(board.sh)
sc_cli_titled() {
  step titled "${IN[@]}" -- $S pane list --label "📋 현황판" --format ids
  step titled "${IN[@]}" -- $S pane list --label-or-name "📋 현황판" --format ids
  step titled "${IN[@]}" -- $S pane list --label-or-name "🛰 에이전트 모니터" --format ids
  step titled "${IN[@]}" -- bash -c "$S pane list | python3 -c 'import sys,json;[print(json.dumps(p,ensure_ascii=False)) for p in json.load(sys.stdin)[\"panes\"] if p[\"id\"] in (\"w1:pT\",\"w1:pB\")]'"
}
# herdr 가 성공하면서 낸 경고는 CLI 표준오류로(원래 bash 에서처럼) · 파이썬 훅(모듈)은 원래처럼 받아 버린다 · 읽기 옵션은 그대로 넘긴다
sc_cli_passthrough() {
  step warn "${IN[@]}" -- $S pane list --format id
  step warn "${IN[@]}" -- python3 -c 'import sys; sys.path.insert(0, "scripts/lib"); import screen; print(len(screen.list_panes()))'
  step - "${IN[@]}" -- $S pane read w1:p2 --source visible --lines 5 --read-format ansi --ansi --raw
  step - "${IN[@]}" -- $S pane wait-output w1:p2 --regex 'done$' --raw --timeout 500
}
# 주소 열기 — herdr · none 은 기본 브라우저(가짜 open 이 ["#open", 주소] 로 적는다) · 주소가 없으면 usage
sc_cli_open_url() {
  step - "${IN[@]}" -- $S open-url "http://localhost:47999/plans/refactor/20261003-lead.html"
  step - "${IN[@]}" ATHENA_SCREEN=none -- $S open-url docs/playbook.html
  step - "${IN[@]}" -- $S open-url
}
SCENARIOS+=(cli_self cli_split cli_list cli_ops cli_node cli_titled cli_passthrough cli_open_url)
