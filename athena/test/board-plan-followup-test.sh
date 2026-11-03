#!/usr/bin/env bash
# 현황판 서버 한 주기 — 자동 완료(단계 칸 · 일반 칸 · 칸 없음 · Lead pane 알림)와 묶인 pane 이 닫힌 계획서의 이어 갈 이슈.
# 판정 함수는 board-auto-test.sh 가 보고 여기서는 진짜 서버가 파일 · pane 에 남기는 결과를 본다. 임시 코어 사본 · 가짜 gh · 가짜 화면 CLI · 몇 초
#
# 사용: test/board-plan-followup-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/athena-board-followup-test.XXXXXX")" && pwd -P)"
SERVER_PID=''
cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  # 서버가 따로 띄운 배우기 검토 프로세스(detached) — 잠금 안의 pid. 끝날 때까지 잠깐 기다린다(임시 폴더를 지우는 중에 대기열을 쓰지 않게)
  local learn_pid
  learn_pid="$(cat "$TMP/learn-queue/.watcher.lock/pid" 2>/dev/null)"
  if [ -n "$learn_pid" ] && kill "$learn_pid" 2>/dev/null; then
    for _ in $(seq 1 20); do kill -0 "$learn_pid" 2>/dev/null || break; sleep 0.1; done
  fi
  [ "${KEEP:-0}" = 1 ] || rm -rf "$TMP"
}
trap cleanup EXIT
athena_test_reap "$TMP"   # 전에 SIGKILL 로 끊긴 이 시험의 고아 서버
mkdir -p "$TMP/bin" "$TMP/home"

# 가짜 gh — PR 조회는 모두 머지됨, 그 밖에는 빈 목록
cat > "$TMP/bin/gh" <<'SH'
#!/bin/sh
case "$*" in
  'pr view '*) echo '{"state":"MERGED","baseRefName":"main","mergedAt":"2026-11-01T00:00:00Z","headRefOid":"abc1234"}' ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$TMP/bin/gh"
# 가짜 claude · codex(로그인 안 됨) — PR 이 머지됐다고 보면 서버가 배우기 검토(learn-review.mjs)를 띄운다. 진짜 CLI 로 검토하지 않게
# (2026-11-03 실측: 이 시험이 /tmp 에 남긴 검토 로그 73개 중 69개가 진짜 claude 를 불렀다 — 한 번에 $0.005~0.16)
for name in claude codex; do printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/$name"; chmod +x "$TMP/bin/$name"; done
cp "$SRC/scripts/screen-check/fake-bin/athena-studio-cli" "$TMP/bin/"

CORE="$TMP/core"
mkdir -p "$CORE"
rsync -a --exclude .git --exclude node_modules --exclude /repos --exclude /plans --exclude /issues --exclude /archive --exclude /.worktrees \
  --exclude '/.board-*' --exclude '/.requests' --exclude /athena.config.json --exclude /pack --exclude /packs --exclude /.pack-data --exclude '/.pack-data.*' --exclude /test \
  "$SRC/" "$CORE/"
mkdir -p "$CORE/issues" "$CORE/plans/task" "$CORE/testpack"
printf '{ "pack": "./testpack" }\n' > "$CORE/athena.config.json"
printf '{ "id": "acme", "name": "acme", "github": { "org": "acme" }, "repos": [ { "name": "demo", "branch": "main", "prBase": "main", "kind": "single", "agents": ["demo-fe"] } ] }\n' > "$CORE/testpack/pack.json"

# 계획서 하나 — 이름 · 제목 · Issue 줄 · PR 줄 · Progress 칸
plan() {
  printf '# %s\n\n## Checkpoint\n- Status: in_progress\n- Agent: demo-fe\n- Issue: %s\n- Lead pane: p1\n%s\n\n### Progress\n%b\n' \
    "$2" "$3" "$4" "$5" > "$CORE/plans/task/$1.md"
}
PR='- PR: https://github.com/acme/demo/pull/7'
plan 20261101-stage '단계 칸' 없음 "$PR" '- [x] 1단계\n- [ ] 2단계 전환'
plan 20261101-plain '일반 칸' 없음 "$PR" '- [x] 구현\n- [ ] 문서\n- [ ] 정리'
plan 20261101-empty '칸 없음' 없음 "$PR" '- 구현 끝'
# 살아 있는 작업 pane p2 — working/idle/waiting 모두 닫힐 때까지 자동 완료를 막는다
for state in working idle waiting; do
  pane=p2
  [ "$state" != idle ] || pane=p4
  [ "$state" != waiting ] || pane=p5
  for kind in pr direct; do
    record="$PR"
    if [ "$kind" = direct ]; then
      record=$'- Auto merge: demo feat/x @abc1234 · 머지됨 — squash → main @def5678(PR 없음) · 2026-11-01 10:05\n\n## Commits\n- 2026-11-01 10:00 · demo · 🌿 feat/x · `abc1234def` — fix: 시험 · 검증 통과'
    fi
    record="- Work ref: /tmp · pane $pane (fe)"$'\n'"$record"
    plan "20261101-live-$kind-$state" "살아 있는 pane $kind $state" 없음 "$record" '- [ ] 후속 배포'
  done
done
plan 20261101-old '오래 닫힘' 없음 '' '- [ ] 구현'
plan 20261101-recent '방금 닫힘' 없음 '' '- [ ] 구현'
plan 20261101-linked '연결 이슈 있음' issues/20261101-demo-linked.md '' '- [ ] 구현'
plan 20261101-asked '요청 있음' 없음 '' '- [ ] 구현'
printf -- '---\ntitle: 연결\nrepo: demo\nstatus: open\nplan: plans/task/20261101-linked.md\n---\n' > "$CORE/issues/20261101-demo-linked.md"
# PR 끔(바로 머지) 레포의 코드 이슈 — PR 없이 "- Auto merge:" 줄로 끝난 계획서면 완료 가능 · 머지 확인 대기면 아님
DIRECT_COMMIT=$'\n\n## Commits\n- 2026-11-01 10:00 · demo · 🌿 feat/d · `abc1234def` — fix: 시험 · 검증 통과'
plan 20261101-direct-done '바로 머지 끝' issues/20261101-demo-direct-done.md "- Auto merge: demo feat/d @abc1234 · 머지됨 — squash → main @def5678(PR 없음) · 2026-11-01 10:05$DIRECT_COMMIT" '- [x] 구현'
plan 20261101-direct-wait '바로 머지 대기' issues/20261101-demo-direct-wait.md "- Auto merge: demo feat/d @abc1234 · 머지 확인 대기 · 2026-11-01 10:05$DIRECT_COMMIT" '- [x] 구현'
for name in direct-done direct-wait; do
  printf -- '---\ntitle: %s\nrepo: demo\nkind: code\nstatus: open\nplan: plans/task/20261101-%s.md\n---\n' "$name" "$name" > "$CORE/issues/20261101-demo-$name.md"
done

# 닫힌 시각 기록 — 2시간 전 셋 · 10분 전 하나
NOW_MS=$(($(date +%s) * 1000))
OLD=$((NOW_MS - 7200000)); RECENT=$((NOW_MS - 600000))
printf '{"plans/task/20261101-old.md":{"closedAt":%s},"plans/task/20261101-recent.md":{"closedAt":%s},"plans/task/20261101-linked.md":{"closedAt":%s},"plans/task/20261101-asked.md":{"closedAt":%s}}' \
  "$OLD" "$RECENT" "$OLD" "$OLD" > "$CORE/.board-plan-panes.json"
(cd "$CORE" && node --input-type=module -e "
import { openRequest } from './scripts/lib/requests.mjs'
openRequest(process.cwd(), { kind: 'question', title: '물음', links: { plan: 'plans/task/20261101-asked.md' } })
") || { echo "  ✖ 요청을 만들지 못했다"; exit 1; }

mkdir -p "$TMP/fixture"
cp "$SRC/scripts/screen-check/fixtures/studio/"* "$TMP/fixture/"
node - "$TMP/fixture/pane_list.json" <<'FIXTURE'
const fs = require('node:fs')
const file = process.argv[2]
const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const [id, state] of [['p4', 'idle'], ['p5', 'waiting']]) {
  fixture.panes.push({ ...fixture.panes[1], id, agent_status: state, label: `🤖 fe · feat/${id}` })
}
fs.writeFileSync(file, JSON.stringify(fixture))
FIXTURE
SCREEN_LOG="$TMP/screen.log"
: > "$SCREEN_LOG"
PORT=$((47900 + RANDOM % 90))
# 서버는 임시 HOME 으로 — 진짜 ~/.claude/projects · ~/.codex/sessions 대화 기록을 읽지 않게.
# 가짜 화면 CLI(python3)가 그 HOME 에 캐시를 쓰다 cleanup 의 rm 과 겹치지 않게 PYTHONDONTWRITEBYTECODE
(cd "$CORE" && PATH="$TMP/bin:$PATH" HOME="$TMP/home" ATHENA_LEARN_QUEUE="$TMP/learn-queue" PYTHONDONTWRITEBYTECODE=1 \
  ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_TAB_ID=t1 ATHENA_STUDIO_WORKSPACE_ID=w1 ATHENA_STUDIO_SOCKET=/tmp/athena-studio.sock \
  ATHENA_STUDIO_CLI="$TMP/bin/athena-studio-cli" ATHENA_STUDIO_ENDPOINT="$TMP/no-studio/daemon.json" \
  FAKE_SCREEN_FIXTURE="$TMP/fixture" FAKE_SCREEN_LOG="$SCREEN_LOG" FAKE_ATHENA="$CORE" \
  ATHENA_BOARD_PORT=$PORT exec node scripts/board/server.mjs > "$TMP/server.log" 2>&1) &
SERVER_PID=$!
athena_test_guard "$SERVER_PID"
for _ in $(seq 1 100); do
  grep -q '자동 완료 — 남은 빈 칸' "$SCREEN_LOG" && ls "$CORE/issues" | grep -q 'demo-old' && break
  sleep 0.2
done
# 이슈 목록은 수집 앞쪽에서 읽으니 새 이슈 카드는 다음 주기에 나온다
for _ in $(seq 1 50); do
  curl -s "http://127.0.0.1:$PORT/api/state" -o "$TMP/state.json" 2>/dev/null && grep -q 'demo-old' "$TMP/state.json" && break
  sleep 0.2
done

node - "$TMP" "$CORE" "$PORT" <<'EOF'
const { readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [tmp, core, port] = process.argv.slice(2)
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }
const read = (path) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
const plan = (name) => read(join(core, 'plans/task', `${name}.md`))
const status = (name) => (plan(name).match(/^- Status: (\w+)/m) ?? [])[1]
const log = read(join(tmp, 'server.log'))

console.log('── 자동 완료')
check('단계 칸 있음 → 그대로', status('20261101-stage') === 'in_progress', log)
check('일반 칸만 있음 → done', status('20261101-plain') === 'done', log)
check('칸 없음 → done', status('20261101-empty') === 'done', log)
for (const kind of ['pr', 'direct']) for (const state of ['working', 'idle', 'waiting']) {
  check(`살아 있는 pane ${kind} ${state} → 완료 보류`, status(`20261101-live-${kind}-${state}`) === 'in_progress', log)
}
const sent = read(join(tmp, 'screen.log')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  // 글 넣기는 공통 전송 경로(scripts/screen pane send-text --enter → 데몬 CLI pane run)
  .filter((args) => args[1] === 'pane' && args[2] === 'run')
const notes = sent.filter((args) => args[4]?.startsWith('[현황판 → 아테나]'))
check('일반 칸을 남긴 계획서만 Lead pane 에 한 줄 — 계획서 · 남은 칸 수', notes.length === 1 && notes[0][3] === 'p1' && notes[0][4] === '[현황판 → 아테나] plans/task/20261101-plain.md 자동 완료 — 남은 빈 칸 2개', JSON.stringify(sent))

console.log('── 이어 갈 이슈')
const files = readdirSync(join(core, 'issues')).sort()
const created = files.filter((name) => !['20261101-demo-linked.md', '20261101-demo-direct-done.md', '20261101-demo-direct-wait.md'].includes(name))
check('닫힌 지 1시간 지난 계획서만 이슈 하나 — 방금 닫힘 · 연결 이슈 있음 · 요청 있음은 안 만듦', created.length === 1 && /^\d{8}-demo-old\.md$/.test(created[0]), `${files.join(' ')}\n${log}`)
const issue = read(join(core, 'issues', created[0] ?? 'x'))
check('이슈 — 제목은 계획서 제목 · 레포는 계획서 기준 · open · 계획서를 가리킴', /^title: 오래 닫힘$/m.test(issue) && /^repo: demo$/m.test(issue) && /^status: open$/m.test(issue) && /^plan: plans\/task\/20261101-old\.md$/m.test(issue), issue)
check('계획서 Issue 줄로 연결 · Status 는 그대로', plan('20261101-old').includes(`- Issue: issues/${created[0]}`) && status('20261101-old') === 'in_progress', plan('20261101-old'))
const watch = JSON.parse(read(join(core, '.board-plan-panes.json')) || '{}')
check('만든 계획서는 기록에서 빠져 또 만들지 않음 · 1시간 전 것은 시각 그대로 남음', !watch['plans/task/20261101-old.md'] && Boolean(watch['plans/task/20261101-recent.md']?.closedAt), JSON.stringify(watch))
const cards = JSON.parse(read(join(tmp, 'state.json')) || '{}').cards ?? []
const card = cards.find((item) => item.kind === 'issue' && item.id === `issues/${created[0]}`)
check('이슈 카드에 계획서가 붙음 — [작업 시작] 이 이 계획서를 이어 간다', card?.linkedPlan?.id === 'plans/task/20261101-old.md', JSON.stringify(cards.map((item) => [item.kind, item.id, item.linkedPlan?.id])))
console.log('── 바로 머지 레포의 코드 이슈 완료 배지')
const doneCheckOf = (state, name) => (state.cards ?? []).find((item) => item.kind === 'issue' && item.id === `issues/20261101-demo-${name}.md`)?.doneCheck
const directReady = async () => {
  const ok = await waitUntil((state) => doneCheckOf(state, 'direct-done')?.ready === true)
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()
  check('PR 없이 바로 머지로 끝난 계획서 → 완료 가능', ok, JSON.stringify(doneCheckOf(state, 'direct-done')))
  const wait = doneCheckOf(state, 'direct-wait')
  check('바로 머지가 머지 확인 대기 → 완료 가능 아님', wait && wait.ready === false, JSON.stringify(wait))
}
// 같은 서버에서 pane 목록 실패 → pane 닫힘 확인까지 이어서 본다.
const waitUntil = async (predicate) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`)
    if (predicate(await response.json())) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}
const verifyClosure = async () => {
  writeFileSync(join(tmp, 'fixture/pane_list.exit'), '1')
  check('pane 목록 실패 주기 확인', await waitUntil((state) => !state.screen))
  for (const kind of ['pr', 'direct']) for (const state of ['working', 'idle', 'waiting']) {
    check(`pane 목록 실패 ${kind} ${state} → 완료 보류`, status(`20261101-live-${kind}-${state}`) === 'in_progress')
  }
  const fixtureFile = join(tmp, 'fixture/pane_list.json')
  const fixture = JSON.parse(read(fixtureFile))
  fixture.panes = fixture.panes.filter((pane) => pane.id === 'p1')
  writeFileSync(fixtureFile, JSON.stringify(fixture))
  writeFileSync(join(tmp, 'fixture/pane_list.exit'), '0')
  check('pane 닫힘 뒤 다시 수집', await waitUntil((state) => state.screen && !state.cards.some((card) => card.id.includes('20261101-live-') && card.status !== 'done')))
  for (const kind of ['pr', 'direct']) for (const state of ['working', 'idle', 'waiting']) {
    const name = `20261101-live-${kind}-${state}`
    const text = plan(name) || read(join(core, 'archive', name, 'plan.md'))
    check(`pane 모두 닫힘 ${kind} ${state} → done`, /^- Status: done/m.test(text), text)
  }
}
directReady().then(verifyClosure).then(() => process.exit(fail)).catch((error) => { console.error(error); process.exit(1) })
EOF
code=$?
[ "$code" = 0 ] && echo "✅ 통과"
exit "$code"
