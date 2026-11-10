#!/usr/bin/env bash
# 현황판 서버 한 주기 — 계획서 하나에 이슈 여럿 묶기(계획서 `- Issue:` 줄에 이슈 경로 여럿).
#   합치기(scripts/board/server.mjs — 이슈 카드에 계획서 붙이기): 묶인 열린 이슈는 모두 붙고 · "작업 중 발견"(열린 이슈가 plan: 만 가리킴)은 지금처럼 안 붙는다 · 옛 형식(Issue 하나)은 그대로
#   보관(scripts/board/archive.mjs — 자동 보관): 끝난 계획서를 보관하면 묶인 이슈들의 plan: 이 모두 보관 자리로 고쳐진다(완료 판정이 계획서를 계속 찾게)
#   이슈 하나 보관([아카이브]): Issue: 목록에 없는 이슈와 같이 계획서를 옮겨도 Issue: 의 묶인 이슈는 그대로
# 임시 코어 사본 · 가짜 gh · 가짜 화면 CLI · 몇 초
#
# 사용: test/board-multi-issue-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/athena-board-multi-issue-test.XXXXXX")" && pwd -P)"
SERVER_PID=''
cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  [ "${KEEP:-0}" = 1 ] || rm -rf "$TMP"
}
trap cleanup EXIT
athena_test_reap "$TMP"   # 전에 SIGKILL 로 끊긴 이 시험의 고아 서버
mkdir -p "$TMP/bin" "$TMP/home"

# 가짜 gh — 빈 목록(이 시험의 계획서는 PR 이 없다) · 가짜 claude · codex 는 로그인 안 됨(진짜 CLI 를 부르지 않게)
printf '#!/bin/sh\necho "[]"\n' > "$TMP/bin/gh"
chmod +x "$TMP/bin/gh"
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

# 계획서 — 이름(제목도) · Status · Issue 줄 · 그 밖의 Checkpoint 줄
plan() {
  printf '# %s\n\n## Checkpoint\n- Status: %s\n- Agent: demo-fe\n- Issue: %s\n%s\n\n### Progress\n- [ ] 구현\n' "$1" "$2" "$3" "$4" > "$CORE/plans/task/$1.md"
}
# 이슈 — 이름 · status · plan
issue() {
  printf -- '---\ntitle: %s\nrepo: demo\nkind: code\nstatus: %s\nplan: %s\n---\n' "$1" "$2" "$3" > "$CORE/issues/$1.md"
}
WORKING='- Work ref: /tmp · pane p2 (fe)'   # 가짜 화면의 p2 = 일하는 중

# ① 묶음 — Issue 줄에 둘(구분은 ' · '). 셋째 이슈는 같은 계획서를 plan: 으로 가리키지만 Issue 줄에 없다 → 작업 중 발견
plan 20261110-multi in_progress 'issues/20261110-demo-a.md · issues/20261110-demo-b.md' "$WORKING"
issue 20261110-demo-a open plans/task/20261110-multi.md
issue 20261110-demo-b open plans/task/20261110-multi.md
issue 20261110-demo-found open plans/task/20261110-multi.md
# ② 옛 형식 — Issue 하나
plan 20261110-single in_progress 'issues/20261110-demo-single.md' "$WORKING"
issue 20261110-demo-single open plans/task/20261110-single.md
# ③ 작업 중 발견 — Issue 없는 진행 중 계획서를 열린 이슈가 plan: 으로 가리킴 → 계획서 카드는 그대로 남는다
plan 20261110-other in_progress '없음' "$WORKING"
issue 20261110-demo-other-found open plans/task/20261110-other.md
# ④ 보관 — 끝난 계획서(PR 없음 · 묶인 pane 없음)에 이슈 셋. 끝난 것 둘 · 진행 중 하나
plan 20261110-archive done 'issues/20261110-demo-e1.md, issues/20261110-demo-e2.md issues/20261110-demo-e3.md' ''
issue 20261110-demo-e1 done plans/task/20261110-archive.md
issue 20261110-demo-e2 in_progress plans/task/20261110-archive.md
issue 20261110-demo-e3 done plans/task/20261110-archive.md

mkdir -p "$TMP/fixture"
cp "$SRC/scripts/screen-check/fixtures/studio/"* "$TMP/fixture/"
PORT=$((47700 + RANDOM % 90))
# 서버는 임시 HOME 으로 — 진짜 대화 기록을 읽지 않게. 가짜 화면 CLI(python3)가 캐시를 쓰지 않게 PYTHONDONTWRITEBYTECODE
(cd "$CORE" && PATH="$TMP/bin:$PATH" HOME="$TMP/home" ATHENA_LEARN_QUEUE="$TMP/learn-queue" PYTHONDONTWRITEBYTECODE=1 \
  ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_TAB_ID=t1 ATHENA_STUDIO_WORKSPACE_ID=w1 ATHENA_STUDIO_SOCKET=/tmp/athena-studio.sock \
  ATHENA_STUDIO_CLI="$TMP/bin/athena-studio-cli" ATHENA_STUDIO_ENDPOINT="$TMP/no-studio/daemon.json" \
  FAKE_SCREEN_FIXTURE="$TMP/fixture" FAKE_SCREEN_LOG="$TMP/screen.log" FAKE_ATHENA="$CORE" \
  ATHENA_BOARD_PORT=$PORT exec node scripts/board/server.mjs > "$TMP/server.log" 2>&1) &
SERVER_PID=$!
athena_test_guard "$SERVER_PID"

node - "$TMP" "$CORE" "$PORT" <<'EOF'
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const [tmp, core, port] = process.argv.slice(2)
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }
const read = (path) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
const state = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() } catch { return null } }
const waitUntil = async (predicate) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await state()
    if (current && predicate(current)) return current
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return await state()
}
const ARCHIVED = join(core, 'archive/20261110-archive')

const main = async () => {
  // 자동 보관(④)과 그 뒤 따로 보관되는 끝난 이슈(e3)까지 — 두 주기
  const current = await waitUntil((found) => found.screen && existsSync(join(core, 'archive/20261110-demo-e3/issue.md')) && found.cards.some((card) => card.id === 'issues/20261110-demo-a.md'))
  const cards = current?.cards ?? []
  const card = (name) => cards.find((item) => item.id === `issues/${name}.md`)
  const brief = JSON.stringify(cards.map((item) => [item.id, item.column, item.linkedPlan?.id ?? '-']))

  console.log('── 합치기')
  for (const name of ['20261110-demo-a', '20261110-demo-b']) {
    check(`Issue 줄에 묶인 열린 이슈 ${name} → 계획서가 붙고 일하는 pane 이면 진행 중 칸`, card(name)?.linkedPlan?.id === 'plans/task/20261110-multi.md' && card(name)?.column === 'doing', brief)
  }
  check('묶음 계획서 카드는 따로 안 보임', !cards.some((item) => item.id === 'plans/task/20261110-multi.md'), brief)
  check('Issue 줄에 없는 열린 이슈(작업 중 발견) → 안 붙음', card('20261110-demo-found') && !card('20261110-demo-found').linkedPlan, brief)
  check('옛 형식(Issue 하나) → 붙음', card('20261110-demo-single')?.linkedPlan?.id === 'plans/task/20261110-single.md' && card('20261110-demo-single')?.column === 'doing', brief)
  check('Issue 없는 계획서를 가리키는 열린 이슈 → 안 붙고 계획서 카드는 그대로', card('20261110-demo-other-found') && !card('20261110-demo-other-found').linkedPlan && cards.some((item) => item.id === 'plans/task/20261110-other.md'), brief)

  console.log('── 보관')
  const log = read(join(tmp, 'server.log'))
  check('끝난 계획서 보관 · 끝난 첫 이슈를 같이 묶음', existsSync(join(ARCHIVED, 'plan.md')) && /^title: 20261110-demo-e1$/m.test(read(join(ARCHIVED, 'issue.md'))), log)
  const archivedPlan = read(join(ARCHIVED, 'plan.md'))
  check('보관한 계획서 Issue 줄 — 묶은 이슈는 보관 자리 · 나머지는 그대로', /^- Issue: archive\/20261110-archive\/issue\.md, issues\/20261110-demo-e2\.md issues\/20261110-demo-e3\.md$/m.test(archivedPlan), archivedPlan)
  const e2 = read(join(core, 'issues/20261110-demo-e2.md'))
  check('진행 중인 묶인 이슈는 남고 plan: 이 보관 자리로', /^plan: archive\/20261110-archive\/plan\.md$/m.test(e2), e2)
  // 완료 판정은 수집 앞쪽(보관 전)에 하니 보관 뒤 주기의 것을 본다
  const planCheckOf = (found) => found?.cards?.find((item) => item.id === 'issues/20261110-demo-e2.md')?.doneCheck?.checks?.find((item) => item.label.startsWith('plan:'))
  const later = await waitUntil((found) => planCheckOf(found)?.ok === true)
  check('남은 이슈의 완료 판정이 보관된 계획서를 읽음(Status done)', planCheckOf(later)?.ok === true, JSON.stringify(planCheckOf(later)))
  const e3 = read(join(core, 'archive/20261110-demo-e3/issue.md'))
  check('끝난 다른 묶인 이슈는 따로 보관 · plan: 이 보관 자리로', /^plan: archive\/20261110-archive\/plan\.md$/m.test(e3), e3 || log)
}
main().then(() => process.exit(fail)).catch((error) => { console.error(error); process.exit(1) })
EOF
code=$?

# ⑤ 이슈 하나 보관(현황판 [아카이브] 와 같은 archiveBundle) — 끝난 계획서를 가리키는 이슈가 계획서와 같이 보관될 때.
#    서버를 먼저 끈다(자동 보관이 같은 파일을 건드리지 않게)
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=''
archive_issue() { (cd "$CORE" && node scripts/board/archive.mjs "issues/$1.md" --no-commit > /dev/null 2>&1); }
line_of() { grep -m1 '^- Issue:' "$CORE/archive/$1/plan.md" 2>/dev/null; }
step() { if [ "$2" = ok ]; then echo "  ✔ $1"; else echo "  ✖ $1"; echo "      $3"; code=1; fi; }
echo '── 이슈 하나 보관'
#   목록 밖 발견 이슈 c 를 보관 → 계획서는 같이 옮겨지되 Issue: 의 a · b 는 그대로 · a · b 의 plan: 은 보관 자리로
plan 20261110-found-arch done 'issues/20261110-demo-fa.md · issues/20261110-demo-fb.md' ''
issue 20261110-demo-fa in_progress plans/task/20261110-found-arch.md
issue 20261110-demo-fb in_progress plans/task/20261110-found-arch.md
issue 20261110-demo-fc done plans/task/20261110-found-arch.md
archive_issue 20261110-demo-fc
got="$(line_of 20261110-demo-fc)"
[ "$got" = '- Issue: issues/20261110-demo-fa.md · issues/20261110-demo-fb.md' ] && step 'Issue: 목록에 없는 이슈를 보관 → 계획서 Issue: 의 묶인 이슈는 그대로' ok || step 'Issue: 목록에 없는 이슈를 보관 → 계획서 Issue: 의 묶인 이슈는 그대로' no "$got"
grep -q '^plan: archive/20261110-demo-fc/plan\.md$' "$CORE/issues/20261110-demo-fa.md" && grep -q '^plan: archive/20261110-demo-fc/plan\.md$' "$CORE/issues/20261110-demo-fb.md" \
  && step '묶인 이슈 a · b 의 plan: 은 보관 자리로' ok || step '묶인 이슈 a · b 의 plan: 은 보관 자리로' no "$(grep -h '^plan:' "$CORE/issues/20261110-demo-fa.md" "$CORE/issues/20261110-demo-fb.md")"
#   옛 형식 — Issue 없는 계획서를 가리키는 이슈를 보관 → 지금처럼 Issue: 가 그 이슈의 보관 자리로
plan 20261110-legacy-arch done '없음' ''
issue 20261110-demo-legacy done plans/task/20261110-legacy-arch.md
archive_issue 20261110-demo-legacy
got="$(line_of 20261110-demo-legacy)"
[ "$got" = '- Issue: archive/20261110-demo-legacy/issue.md' ] && step 'Issue 없는 계획서 → Issue: 가 같이 보관한 이슈 자리로(옛 동작)' ok || step 'Issue 없는 계획서 → Issue: 가 같이 보관한 이슈 자리로(옛 동작)' no "$got"

[ "$code" = 0 ] && echo "✅ 통과"
exit "$code"
