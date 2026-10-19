# 화면 계층 자체(scripts/screen) 시나리오 — check.sh 가 불러 SCENARIOS 에 더한다. Studio 데몬 CLI 쪽은 studio-scenarios.sh(studio_self · studio_ops …)
# 화면 밖(none)에서의 동작 · 사용법 오류 · 없는 동작을 golden 으로 고정한다.
S=scripts/screen
sc_cli_none() {
  step - -- $S self
  step - -- $S self --format sh
  step - -- $S inside
  step - -- $S name
  step - -- $S capabilities
  step - -- $S capabilities --has workspaces
  step - -- $S pane list
  step - -- $S pane split --target self --direction down
  # ATHENA_SCREEN 은 studio · none 만 — 그 밖은 usage
  step - ATHENA_SCREEN=none -- $S self
  step - ATHENA_SCREEN=bogus -- $S self
}
# 사용법 — 인자 없음 · 모르는 동작(고정 배치 pane layout · swap · move 도 없다) · 모르는 옵션 · 빠진 값
sc_cli_usage() {
  step - -- $S
  step - -- $S pane frobnicate
  step - ATHENA_SCREEN=studio -- $S pane layout --pane p1
  step - ATHENA_SCREEN=studio -- $S pane swap p1 p2
  step - ATHENA_SCREEN=studio -- $S pane move p2 --new-tab
  step - ATHENA_SCREEN=studio -- $S pane list --nope
  step - ATHENA_SCREEN=studio -- $S pane list --label
  step - ATHENA_SCREEN=studio -- $S pane list --format yaml
}
# 주소 열기 — none 은 기본 브라우저(가짜 open 이 ["#open", 주소] 로 적는다) · 주소가 없으면 usage
sc_cli_open_url() {
  step - -- $S open-url "http://localhost:47999/plans/refactor/20261003-lead.html"
  step - ATHENA_SCREEN=none -- $S open-url docs/playbook.html
  step - -- $S open-url
}
SCENARIOS+=(cli_none cli_usage cli_open_url)
