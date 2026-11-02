#!/usr/bin/env bash
# Actions 로 넘기기 시험 — 진짜 commit.sh · ship.sh · pr-auto.mjs · lib/handoff.mjs 와 workflow 틀의 머지 단계를 임시 레포 · 가짜 gh 응답으로 본다(GitHub 을 건드리지 않는다 · 몇 초)
# 보는 것(docs/pr-auto.md "Actions 로 넘기기"): 켠 레포만 넘긴다 · 머지 단계(머지 · 충돌 · 이미 들어감 · push 경쟁) · 결과 읽기 · 실패 전달 · 재시작해도 기록 · 전달이 두 번 안 된다 · 비밀값 가림
#
# 사용: test/handoff-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
ATH="$TMP/ath"; mkdir -p "$ATH/plans/task" "$ATH/repos"
cp -R "$SRC/scripts" "$ATH/"
printf '#!/bin/sh\nexit 0\n' > "$ATH/scripts/screen"; chmod +x "$ATH/scripts/screen"
export XDG_CACHE_HOME="$TMP/cache" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue"
mkdir -p "$TMP/queue/.watcher.lock"; echo $$ > "$TMP/queue/.watcher.lock/pid"   # 처리기가 돌고 있는 것처럼
unset ATHENA_VERIFY_DIR ATHENA_VERIFY_STRICT ATHENA_VERIFY_ALLOW_SKIP ATHENA_VERIFY_FULL ATHENA_PLAN ATHENA_AGENT

FAIL_COUNT=0
ok() { echo "  ✔ $1"; }
bad() { echo "  ✖ $1"; FAIL_COUNT=1; }

# 검증 스크립트 — 돌면 횟수 파일에 한 줄
COUNT="$TMP/runs"; : > "$COUNT"
cat > "$ATH/scripts/verify/web.sh" <<SCRIPT
#!/usr/bin/env bash
source "$ATH/scripts/verify/_lib.sh"
REPO_DIR="\$(resolve_repo_dir "$ATH/repos/web")"
echo run >> "$COUNT"
cd "\$REPO_DIR"
run_step "시험" true
print_summary web "\$REPO_DIR"
SCRIPT
chmod +x "$ATH/scripts/verify/web.sh"
config() { printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoPr": false, "autoMergeConfirm": false%s } ] }\n' "$1" > "$ATH/athena.config.json"; }
git init -q --bare "$TMP/origin.git"
git init -q "$TMP/main"
G() { git -C "$TMP/main" -c user.name=t -c user.email=t@t "$@"; }
G checkout -q -b main; echo base > "$TMP/main/f.txt"; G add .; G commit -qm base; G remote add origin "$TMP/origin.git"; G push -q origin main 2>/dev/null
G worktree add -q "$TMP/wt" -b feat/x
git -C "$TMP/wt" config user.name t; git -C "$TMP/wt" config user.email t@t
ln -s "$TMP/main" "$ATH/repos/web"
PLAN="$ATH/plans/task/p.md"
printf '# 시험\n\n## Checkpoint\n- Status: in_progress\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p1 (web-fe)\n\n### Validation\n- 아직 실행 안 함\n\n## Commits\n' "$TMP/wt" > "$PLAN"
commit() { "$ATH/scripts/commit.sh" --plan plans/task/p.md --dir "$TMP/wt" -m "$1" -- "${@:2}" 2>&1; }
ship() { "$ATH/scripts/ship.sh" --plan plans/task/p.md --dir "$TMP/wt" --direct-merge 2>&1; }
remote_has() { git -C "$TMP/origin.git" rev-parse -q --verify "refs/heads/$1" >/dev/null; }

echo "넘기기 — commit.sh · ship.sh"
config ', "actionsHandoff": true'
echo one > "$TMP/wt/f.txt"
out="$(commit '첫 변경' f.txt)"; rc=$?
[ $rc = 0 ] && [ "$(wc -l < "$COUNT" | tr -d ' ')" = 1 ] && ok "workflow 가 아직 없으면 commit.sh 가 맥에서 전체 검증을 돌린다" || bad "workflow 없는 커밋(rc=$rc · 검증 $(wc -l < "$COUNT")번): $out"
out="$(ship)"; rc=$?
[ $rc != 0 ] && ! remote_has handoff/feat/x && printf '%s' "$out" | grep -q 'athena-handoff.yml 가 없다' && ok "workflow 가 커밋에 없으면 넘기지 않는다" || bad "workflow 없는 넘기기(rc=$rc): $out"

mkdir -p "$TMP/wt/.github/workflows"; cp "$SRC/docs/templates/actions/athena-handoff.yml" "$TMP/wt/.github/workflows/athena-handoff.yml"
: > "$COUNT"
out="$(commit 'workflow 넣기' .github/workflows/athena-handoff.yml)"; rc=$?
[ $rc = 0 ] && [ "$(wc -l < "$COUNT" | tr -d ' ')" = 1 ] && ok "workflow 를 넣는 커밋도 맥에서 검증(HEAD 에 아직 없다)" || bad "workflow 커밋(rc=$rc): $out"
echo two > "$TMP/wt/f.txt"; : > "$COUNT"
out="$(commit '둘째 변경' f.txt)"; rc=$?
[ $rc = 0 ] && [ ! -s "$COUNT" ] && ok "켠 레포 · workflow 있음 → commit.sh 가 전체 검증을 돌리지 않는다" || bad "검증 건너뛰기(rc=$rc · 검증 $(wc -l < "$COUNT")번): $out"
grep -q '전체 검증은 넘긴 뒤 Actions 에서' "$PLAN" && ! grep -q '둘째.*검증 생략' "$PLAN" && ok "계획서 Commits 에 Actions 검증으로 적는다" || bad "Commits 기록: $(grep -n '둘째' "$PLAN")"
SHA="$(git -C "$TMP/wt" rev-parse HEAD)"; START_MAIN="$(git -C "$TMP/origin.git" rev-parse refs/heads/main)"
out="$(ship)"; rc=$?
[ $rc = 0 ] && [ "$(git -C "$TMP/origin.git" rev-parse refs/heads/handoff/feat/x)" = "$SHA" ] && [ "$(git -C "$TMP/origin.git" rev-parse refs/heads/main)" = "$START_MAIN" ] && ok "ship.sh --direct-merge → handoff/<브랜치> push 만 · main 그대로" || bad "넘기기(rc=$rc): $out"
grep -q '^- Auto merge: web feat/x @.* · Actions 대기 — 넘김 · ' "$PLAN" && ok "계획서에 Actions 대기" || bad "대기 줄 없음: $(grep -n 'Auto merge' "$PLAN")"
ls "$ATH"/.board-handoffs/web-*.json >/dev/null 2>&1 && ok "작업 파일이 남는다(현황판이 읽는다)" || bad "작업 파일 없음"
grep -q '"type":"handoff"' "$ATH/.events.jsonl" && ok "사건 handoff" || bad "사건 handoff 없음"
out="$(ship)"; rc=$?
[ $rc = 0 ] && [ "$(ls "$ATH"/.board-handoffs/web-*.json | wc -l | tr -d ' ')" = 1 ] && ok "같은 HEAD 를 다시 넘겨도 일은 하나" || bad "다시 넘기기(rc=$rc): $out"
rm -f "$ATH"/.board-handoffs/*.json; git -C "$TMP/origin.git" update-ref -d refs/heads/handoff/feat/x
config ''
sed -i.bak '/^- Auto merge:/d' "$PLAN"
out="$(ship)"; rc=$?
! remote_has handoff/feat/x && grep -q '^- Auto merge: web feat/x .*머지됨' "$PLAN" && ok "안 켠 레포는 지금 그대로 맥에서 바로 머지" || bad "안 켠 레포(rc=$rc): $out"
: > "$COUNT"; echo three > "$TMP/wt/f.txt"
out="$(commit '안 켠 레포 변경' f.txt)"; rc=$?
[ $rc = 0 ] && [ -s "$COUNT" ] && ok "안 켠 레포는 workflow 가 있어도 commit.sh 가 검증을 돌린다" || bad "안 켠 레포 커밋(rc=$rc): $out"

echo; echo "workflow 틀 — 머지 단계(진짜 git)"
python3 - "$SRC/docs/templates/actions/athena-handoff.yml" "$TMP/merge-step.sh" <<'PY'
import sys, re, textwrap
text = open(sys.argv[1]).read()
block = text.split('# >>> merge\n', 1)[1].split('# <<< merge', 1)[0]
assert '${{' not in block, '머지 단계 run 안에 표현식을 쓰지 않는다'
body = block.split('run: |\n', 1)[1]
open(sys.argv[2], 'w').write('set -e\n' + textwrap.dedent(body).replace('sleep "$((attempt * 5))"', 'sleep 0'))
PY
SETUP=0
merge_case() {   # 원격 준비 후 틀 단계 실행 — 결과 코드를 돌려준다. $1 작업 브랜치 sha
  rm -rf "$TMP/runner"; git clone -q "$TMP/m-origin.git" "$TMP/runner"
  git -C "$TMP/runner" config user.name r; git -C "$TMP/runner" config user.email r@r
  [ -z "${PRE_HOOK:-}" ] || cp "$PRE_HOOK" "$TMP/m-origin.git/hooks/pre-receive"
  (cd "$TMP/runner" && git fetch -q origin "refs/heads/handoff/w:refs/remotes/origin/handoff/w" && git checkout -q --detach "$1" \
    && GITHUB_SHA="$1" GITHUB_REF_NAME=handoff/w BASE_BRANCH=main bash "$TMP/merge-step.sh") > "$TMP/merge.out" 2>&1
  local code=$?; rm -f "$TMP/m-origin.git/hooks/pre-receive"; return $code
}
git init -q --bare "$TMP/m-origin.git"; git -C "$TMP/m-origin.git" symbolic-ref HEAD refs/heads/main
git init -q "$TMP/m"; M() { git -C "$TMP/m" -c user.name=t -c user.email=t@t "$@"; }
M checkout -q -b main; echo base > "$TMP/m/a.txt"; echo keep > "$TMP/m/b.txt"; M add .; M commit -qm base; M remote add origin "$TMP/m-origin.git"; M push -q origin main 2>/dev/null
start_work() { M checkout -q -B w main; echo "$1" > "$TMP/m/$2"; M add .; M commit -qm "$3"; M push -qf origin w:refs/heads/handoff/w 2>/dev/null; M rev-parse HEAD; }
W="$(start_work work a.txt '작업 제목')"
M checkout -q main; echo other > "$TMP/m/c.txt"; M add .; M commit -qm '다른 일'; M push -q origin main 2>/dev/null
BEFORE="$(M rev-parse HEAD)"
merge_case "$W"; rc=$?
TIP="$(git -C "$TMP/m-origin.git" rev-parse refs/heads/main)"
[ $rc = 0 ] && [ "$(git -C "$TMP/m-origin.git" rev-parse "$TIP^")" = "$BEFORE" ] && [ "$(git -C "$TMP/m-origin.git" show "$TIP:a.txt")" = work ] && [ "$(git -C "$TMP/m-origin.git" show "$TIP:c.txt")" = other ] && [ "$(git -C "$TMP/m-origin.git" log -1 --format=%s "$TIP")" = '작업 제목' ] \
  && ok "base 위 커밋 하나로 합친다(앞선 머지 유지 · 제목은 작업 커밋)" || { bad "머지(rc=$rc)"; sed 's/^/      /' "$TMP/merge.out"; }
! git -C "$TMP/m-origin.git" rev-parse -q --verify refs/heads/handoff/w >/dev/null && ok "머지 뒤 넘김 브랜치를 지운다" || bad "넘김 브랜치가 남았다"
M fetch -q origin main; M checkout -q main; M merge -q --ff-only FETCH_HEAD
M push -qf origin "$W:refs/heads/handoff/w" 2>/dev/null
TIP="$(git -C "$TMP/m-origin.git" rev-parse refs/heads/main)"
merge_case "$W"; rc=$?
[ $rc = 0 ] && [ "$(git -C "$TMP/m-origin.git" rev-parse refs/heads/main)" = "$TIP" ] && grep -q '이미 main 에 들어 있다' "$TMP/merge.out" && ok "같은 내용을 다시 넘기면 빈 커밋을 만들지 않는다" || { bad "이미 들어감(rc=$rc)"; sed 's/^/      /' "$TMP/merge.out"; }
W="$(start_work mine b.txt '충돌 작업')"
M checkout -q main; echo theirs > "$TMP/m/b.txt"; M add .; M commit -qm '먼저 들어간 일'; M push -q origin main 2>/dev/null
TIP="$(M rev-parse HEAD)"
merge_case "$W"; rc=$?
[ $rc = 1 ] && [ "$(git -C "$TMP/m-origin.git" rev-parse refs/heads/main)" = "$TIP" ] && grep -q '충돌' "$TMP/merge.out" && git -C "$TMP/m-origin.git" rev-parse -q --verify refs/heads/handoff/w >/dev/null && ok "충돌은 실패 · main 그대로 · 강제 없음" || { bad "충돌(rc=$rc)"; sed 's/^/      /' "$TMP/merge.out"; }
W="$(start_work race d.txt '경쟁 작업')"
# 첫 push 를 한 번 거부해 다른 머지가 먼저 들어간 것처럼 — 다음 시도는 새 base 위로 합쳐야 한다
printf '#!/bin/sh\nif [ ! -e "%s" ]; then touch "%s"; echo rejected >&2; exit 1; fi\nexit 0\n' "$TMP/once" "$TMP/once" > "$TMP/reject-once"; chmod +x "$TMP/reject-once"
PRE_HOOK="$TMP/reject-once" merge_case "$W"; rc=$?
[ $rc = 0 ] && grep -q 'push 거부' "$TMP/merge.out" && [ "$(git -C "$TMP/m-origin.git" show refs/heads/main:d.txt)" = race ] && ok "push 가 거부되면 다시 합쳐 넣는다(줄 세우기 없이 차례)" || { bad "push 경쟁(rc=$rc)"; sed 's/^/      /' "$TMP/merge.out"; }
python3 - "$SRC/docs/templates/actions/athena-handoff.yml" <<'PY' && ok "틀 모양 — 넘김 브랜치 push 로만 · 브랜치별 차례 · 기본 읽기 권한" || bad "틀 모양"
import sys
text = open(sys.argv[1]).read()
assert "branches: ['handoff/**']" in text and 'pull_request' not in text.split('jobs:')[0].replace('pull_request 로 시작하지', '')
assert 'group: athena-handoff-${{ github.ref }}' in text and 'permissions:\n  contents: read' in text and '--force' not in text and 'secrets.' not in text
PY

echo; echo "결과 읽기 — 현황판 감시"
cat > "$TMP/watch.mjs" <<JS
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const lib = await import('$ATH/scripts/lib/handoff.mjs')
const { directMergeStatus } = await import('$ATH/scripts/lib/pr-auto.mjs')
const root = '$ATH'
const planFile = 'plans/task/w.md'
const planPath = join(root, planFile)
let failures = 0
const check = (name, passed, detail = '') => { console.log(passed ? '  ✔ ' + name : '  ✖ ' + name + ' — ' + detail); if (!passed) failures += 1 }
const sha = 'a'.repeat(40)
const atNow = Date.parse('2026-11-02T00:00:00Z')
const seed = (commits = true) => {
  writeFileSync(planPath, '# w\n\n## Checkpoint\n- Status: in_progress\n- Agent: web-fe\n- Work ref: /wt · 🌿 feat/w · pane p7 (web-fe)\n\n### Validation\n- 아직 실행 안 함\n\n## Commits\n' + (commits ? '- 2026-11-02 00:00 · web · 🌿 feat/w · \`' + sha.slice(0, 7) + '\` · x\n' : ''))
  mkdirSync(lib.handoffDir(root), { recursive: true })
  writeFileSync(lib.handoffFile(root, 'web', 'feat/w'), JSON.stringify({ plan: planFile, repo: 'web', branch: 'feat/w', sha, base: 'main', worktree: root, at: new Date(atNow).toISOString() }))
}
const pending = () => readdirSync(lib.handoffDir(root)).filter((name) => name.includes('web-')).length
const planText = () => readFileSync(planPath, 'utf8')
const world = (overrides = {}) => {
  const state = { runs: [], jobs: [], log: '', sent: [], opened: [], events: [], calls: [], sendResult: () => null, openResult: true, now: atNow + 60000, ...overrides }
  const run = async (command, args) => {
    state.calls.push(args.join(' '))
    if (args[0] === 'api' && args[1].includes('/runs?')) return JSON.stringify(state.runs)
    if (args[0] === 'api' && args[1].endsWith('/jobs')) return JSON.stringify(state.jobs)
    if (args[0] === 'run') return state.log
    return null
  }
  const watch = lib.createHandoffWatch({
    root, org: 'acme', run, stamp: () => '2026-11-02 09:00', now: () => state.now, log: () => {},
    sendToPane: async (pane, text) => { state.sent.push({ pane, text }); return state.sendResult(pane) },
    openPane: async (agent, plan, worktree, text) => { state.opened.push({ agent, plan, worktree, text }); return state.openResult },
    logEvent: (type, fields) => state.events.push({ type, ...fields }),
    canRun: () => state.canRun !== false,
  })
  return { state, watch }
}
const baseRun = { id: 11, html_url: 'https://github.com/acme/web/actions/runs/11', head_branch: 'handoff/feat/w', created_at: new Date(atNow + 1000).toISOString(), conclusion: null }

seed()
{
  const { state, watch } = world()
  await watch.tick()
  check('실행이 아직 없으면 그대로 기다린다', pending() === 1 && !state.sent.length)
  state.runs = [{ ...baseRun, id: 9, head_branch: 'other', status: 'in_progress' }, { ...baseRun, id: 8, created_at: new Date(atNow - 3600000).toISOString(), status: 'completed', conclusion: 'failure' }]
  await watch.tick()
  check('다른 브랜치 · 넘기기 전의 실행은 보지 않는다', !planText().includes('run 9') && !planText().includes('run 8') && !state.sent.length, planText())
  state.runs = [{ ...baseRun, status: 'queued' }]
  await watch.tick()
  check('대기 → 카드 상태 waiting', lib.handoffStateOf(planText()) === 'waiting', planText())
  state.runs = [{ ...baseRun, status: 'in_progress' }]
  await watch.tick()
  check('도는 중 → 카드 상태 running', lib.handoffStateOf(planText()) === 'running', planText())
  check('아직 완료 아님', directMergeStatus(planText()).state === 'wait', JSON.stringify(directMergeStatus(planText())))
  state.runs = [{ ...baseRun, status: 'completed', conclusion: 'success' }]
  state.jobs = [{ name: 'verify', conclusion: 'success' }, { name: 'merge', conclusion: 'success', completed_at: new Date(atNow + 120000).toISOString() }, { name: 'deploy', conclusion: 'success' }]
  await watch.tick()
  check('머지 성공 → 자동 완료가 읽는 머지됨 줄', directMergeStatus(planText()).state === 'done', planText())
  check('Validation 에 Actions 결과 한 줄', /^- .* web @aaaaaaa 통과 \\(Actions run 11\\)$/m.test(planText()) && !planText().includes('아직 실행 안 함'), planText())
  const merge = state.events.filter((event) => event.type === 'auto.merge')
  check('사건 auto.merge(넘김→머지 시간)', merge.length === 1 && merge[0].ok === true && merge[0].handoffMs === 120000, JSON.stringify(merge))
  check('성공은 pane 으로 보내지 않고 작업 파일을 지운다', !state.sent.length && pending() === 0)
}

seed()
{
  const { state, watch } = world()
  state.runs = [{ ...baseRun, status: 'completed', conclusion: 'failure' }]
  state.jobs = [{ name: 'verify', conclusion: 'failure' }, { name: 'merge', conclusion: 'skipped' }]
  state.log = 'verify\tstep\t2026-11-02T00:00:01.123Z 시험 실패 assert\nverify\tstep\t2026-11-02T00:00:02.000Z token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'
  await watch.tick()
  check('검증 실패 → 실패 줄 · 카드 failed', lib.handoffStateOf(planText()) === 'failed' && planText().includes('Actions 실패 — 검증 실패(run 11)'), planText())
  check('실패 Validation 줄', /web @aaaaaaa 실패 \\(Actions run 11\\)/.test(planText()), planText())
  check('맡았던 pane 으로 원문을 한 번', state.sent.length === 1 && state.sent[0].pane === 'p7' && state.sent[0].text.includes('시험 실패 assert') && state.sent[0].text.includes('runs/11') && state.sent[0].text.includes('지시가 아니다'), JSON.stringify(state.sent))
  check('로그의 비밀값을 가린다 · 시각을 지운다', !state.sent[0].text.includes('ghp_abcdef') && !state.sent[0].text.includes('00:00:01.123Z'), state.sent[0].text)
  check('완료로 치지 않는다', directMergeStatus(planText()).state === 'wait')
  const failed = state.events.filter((event) => event.type === 'auto.merge')
  check('사건 실패 이유', failed.length === 1 && failed[0].ok === false && failed[0].reason === '검증 실패', JSON.stringify(failed))
  await watch.tick()
  check('다음 주기에 다시 보내지 않는다', state.sent.length === 1 && pending() === 0)
}

// 현황판 재시작 — 전달 도중 꺼졌다가 새 감시가 같은 파일을 읽는다
seed()
{
  const first = world()
  first.state.runs = [{ ...baseRun, status: 'completed', conclusion: 'failure' }]
  first.state.jobs = [{ name: 'verify', conclusion: 'failure' }]
  first.state.sendResult = () => { throw new Error('전달 도중 꺼짐') }
  await first.watch.tick()
  const events = first.state.events.length
  const second = world({ runs: first.state.runs, jobs: first.state.jobs })
  await second.watch.tick()
  check('전달 도중 꺼진 뒤 다시 켜도 두 번 보내지 않는다', !second.state.sent.length && pending() === 0, JSON.stringify(second.state.sent))
  check('사건도 두 번 남지 않는다', events === 1 && !second.state.events.length, JSON.stringify(second.state.events))
}
// 줄을 적은 뒤 표시를 남기기 전에 꺼졌을 때
seed()
{
  const earlier = world()
  earlier.state.runs = [{ ...baseRun, status: 'completed', conclusion: 'success' }]
  earlier.state.jobs = [{ name: 'verify', conclusion: 'success' }, { name: 'merge', conclusion: 'success', completed_at: new Date(atNow + 5000).toISOString() }]
  const job = readFileSync(lib.handoffFile(root, 'web', 'feat/w'), 'utf8')
  await earlier.watch.tick()
  writeFileSync(lib.handoffFile(root, 'web', 'feat/w'), job)   // 파일이 표시 전 그대로 남은 상태
  const lines = planText().match(/Actions run 11/g).length
  const again = world({ runs: earlier.state.runs, jobs: earlier.state.jobs })
  await again.watch.tick()
  check('기록 뒤 꺼져도 줄 · 사건이 두 번 남지 않는다', !again.state.events.length && planText().match(/Actions run 11/g).length === lines && pending() === 0, planText())
}

seed()
{
  const { state, watch } = world()
  state.runs = [{ ...baseRun, status: 'completed', conclusion: 'failure' }]
  state.jobs = [{ name: 'verify', conclusion: 'success' }, { name: 'merge', conclusion: 'failure' }]
  state.sendResult = (pane) => (pane === 'p7' ? 'pane 없음' : null)
  await watch.tick()
  check('머지 실패(충돌 등)를 구분한다', planText().includes('머지 실패(run 11)') && /통과 \\(Actions run 11\\)/.test(planText()), planText())
  check('pane 이 없으면 같은 워크트리로 새로 띄운다', state.opened.length === 1 && state.opened[0].agent === 'web-fe' && state.opened[0].worktree === root && pending() === 0, JSON.stringify(state.opened))
}
seed()
{
  const { state, watch } = world({ openResult: false })
  state.runs = [{ ...baseRun, status: 'completed', conclusion: 'failure' }]
  state.jobs = [{ name: 'verify', conclusion: 'failure' }]
  state.sendResult = () => '못 보냄'
  await watch.tick()
  check('아무 데도 못 보내면 파일을 남겨 다음에 다시', pending() === 1 && state.sent.at(-1).pane === 'hermes')
  state.sendResult = () => null
  await watch.tick()
  check('다음 주기에 아테나로 전달 · 사건은 한 번', pending() === 0 && state.events.length === 1, JSON.stringify(state.events))
}
seed()
{
  const { state, watch } = world()
  state.runs = [{ ...baseRun, status: 'completed', conclusion: 'failure' }]
  state.jobs = [{ name: 'verify', conclusion: 'success' }, { name: 'merge', conclusion: 'success', completed_at: new Date(atNow + 5000).toISOString() }, { name: 'deploy', conclusion: 'failure' }]
  await watch.tick()
  check('배포 시작 실패 → 머지됨 유지 · 알림만', directMergeStatus(planText()).state === 'done' && state.sent.length === 1 && state.sent[0].text.includes('배포 시작이 실패'), JSON.stringify(state.sent))
}
seed()
{
  const { state, watch } = world({ now: atNow + 31 * 60000 })
  await watch.tick(); await watch.tick()
  check('30분 지나도 실행이 없으면 아테나에 한 번', state.sent.length === 1 && state.sent[0].pane === 'hermes' && pending() === 1, JSON.stringify(state.sent))
}
seed()
{
  const { state, watch } = world()
  state.canRun = false
  await watch.tick()
  check('옛 현황판(canRun 거짓)은 gh 를 부르지 않는다', !state.calls.length)
}
{
  const { summarize } = await import('$ATH/scripts/lib/metrics.mjs')
  const seen = '2026-11-02T01:00:00.000Z'
  const summary = summarize([
    { at: '2026-11-02T00:00:00.000Z', type: 'plan.status', plan: planFile, from: null, to: 'in_progress' },
    { at: seen, type: 'auto.merge', plan: planFile, repo: 'web', ok: true, direct: true, handoff: true, mergedAt: '2026-11-02T00:10:00.000Z', handoffMs: 300000 },
  ], { now: Date.parse('2026-11-02T02:00:00Z') }).current
  check('지표 — 넘김→머지 · 머지 시각은 현황판이 본 때가 아니라 Actions 가 끝낸 때', summary.handoffToMerge.count === 1 && summary.handoffToMerge.p50Ms === 300000 && summary.lead.p50Ms === 600000, JSON.stringify([summary.handoffToMerge, summary.lead]))
}
process.exit(failures ? 1 : 0)
JS
node "$TMP/watch.mjs" 2>&1 || FAIL_COUNT=1

echo; [ "$FAIL_COUNT" = 0 ] && echo "✅ 통과" || { echo "❌ 실패"; exit 1; }
