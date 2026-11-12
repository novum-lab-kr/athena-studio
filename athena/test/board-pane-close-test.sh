#!/usr/bin/env bash
# 끝난 에이전트 pane 자동 닫기 — 진짜 현황판 서버(scripts/board/server.mjs closeFinishedPanes · scripts/board/pane-close.mjs) 한 주기.
# 판정 함수는 board-auto-test.sh 가 보고 여기서는 서버가 화면에 넣는 것(pane close · 아테나 알림)을 본다. 임시 코어 사본 · 가짜 gh · 가짜 화면 CLI · 몇 초
#   닫음: PR 머지 + 쉼 · 뒤 셸만 돌고 앞은 쉼 / 안 닫음: 사용자가 봄 · 미커밋 · 앞이 일함 · PR 열림 · 남은 단계 칸 · 열린 요청 · 입력칸 초안 · 화면 못 읽음 · 닫기 직전에 초안이 생김 · 아테나 pane
#
# 사용: test/board-pane-close-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/athena-board-pane-close-test.XXXXXX")" && pwd -P)"
SERVER_PID=''
cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  local learn_pid
  learn_pid="$(cat "$TMP/learn-queue/.watcher.lock/pid" 2>/dev/null)"
  if [ -n "$learn_pid" ] && kill "$learn_pid" 2>/dev/null; then
    for _ in $(seq 1 20); do kill -0 "$learn_pid" 2>/dev/null || break; sleep 0.1; done
  fi
  # 끈 서버가 막 띄운 화면 CLI(p16 읽기 횟수 파일을 쓴다)가 늦게 끝날 수 있어 한 번 더
  [ "${KEEP:-0}" = 1 ] || rm -rf "$TMP" 2>/dev/null || { sleep 1; rm -rf "$TMP"; }
}
trap cleanup EXIT
athena_test_reap "$TMP"
mkdir -p "$TMP/bin" "$TMP/home"

# 가짜 gh — PR 9 는 열림, 그 밖에는 머지됨
cat > "$TMP/bin/gh" <<'SH'
#!/bin/sh
case "$*" in
  'pr view 9 '*) echo '{"state":"OPEN","baseRefName":"main","mergedAt":"","headRefOid":"abc1234"}' ;;
  'pr view '*) echo '{"state":"MERGED","baseRefName":"main","mergedAt":"2026-11-01T00:00:00Z","headRefOid":"abc1234"}' ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$TMP/bin/gh"
for name in claude codex; do printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/$name"; chmod +x "$TMP/bin/$name"; done
cp "$SRC/scripts/screen-check/fake-bin/athena-studio-cli" "$TMP/bin/fake-studio-cli"
# pane 마다 다른 화면 — p14 는 입력칸에 쓰다 만 글 · p15 는 화면 읽기 실패 · 그 밖은 fixture(빈 입력칸)
cat > "$TMP/bin/athena-studio-cli" <<SH
#!/bin/sh
case "\$*" in
  'pane read p14 '*) printf '일 끝\\n────────\\n❯ 아직 안 보낸 글\\n────────\\n' ; exit 0 ;;
  'pane read p15 '*) exit 1 ;;
  # p16 — 처음 읽을 땐 빈 입력칸, 닫기 직전 다시 읽으면 초안(읽은 뒤 사용자가 쓰기 시작) — 읽을 때마다 번갈아
  'pane read p16 '*)
    n=\$(( \$(cat "$TMP/p16.count" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "$TMP/p16.count"
    if [ \$((n % 2)) = 1 ]; then printf '일 끝\\n────────\\n❯ \\n────────\\n'; else printf '일 끝\\n────────\\n❯ 막 쓰기 시작한 글\\n────────\\n'; fi
    exit 0 ;;
esac
exec "$TMP/bin/fake-studio-cli" "\$@"
SH
chmod +x "$TMP/bin/athena-studio-cli"

CORE="$TMP/core"
mkdir -p "$CORE"
rsync -a --exclude .git --exclude node_modules --exclude /repos --exclude /plans --exclude /issues --exclude /archive --exclude /.worktrees \
  --exclude '/.board-*' --exclude '/.requests' --exclude /athena.config.json --exclude /pack --exclude /packs --exclude /.pack-data --exclude '/.pack-data.*' --exclude /test \
  "$SRC/" "$CORE/"
mkdir -p "$CORE/issues" "$CORE/plans/task" "$CORE/testpack"
printf '{ "pack": "./testpack" }\n' > "$CORE/athena.config.json"
printf '{ "id": "acme", "name": "acme", "github": { "org": "acme" }, "repos": [ { "name": "demo", "branch": "main", "prBase": "main", "kind": "single", "agents": ["demo-fe"] } ] }\n' > "$CORE/testpack/pack.json"

# pane 이 쓰는 폴더 — 깨끗한 git 레포 하나 · 미커밋 레포 하나
for name in clean dirty; do
  git init -q "$TMP/$name" && git -C "$TMP/$name" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
done
echo 고침 > "$TMP/dirty/new.txt"

# 계획서 — 이름 · pane · PR 번호 · Progress
plan() {
  printf '# %s\n\n## Checkpoint\n- Status: in_progress\n- Agent: demo-fe\n- Lead pane: p1\n- Work ref: /tmp · pane %s (fe)\n- PR: https://github.com/acme/demo/pull/%s\n\n### Progress\n%b\n' \
    "$1" "$2" "$3" "$4" > "$CORE/plans/task/$1.md"
}
plan 20261112-merged p6 7 '- [x] 구현'
plan 20261112-bg p7 7 '- [x] 구현\n- [ ] 후속 배포'
plan 20261112-focused p8 7 '- [x] 구현'
plan 20261112-dirty p9 7 '- [x] 구현'
plan 20261112-working p10 7 '- [x] 구현'
plan 20261112-open p11 9 '- [x] 구현'
plan 20261112-step p12 7 '- [x] 1단계\n- [ ] 2단계 전환'
plan 20261112-asked p13 7 '- [x] 구현'
plan 20261112-draft p14 7 '- [x] 구현'
plan 20261112-unread p15 7 '- [x] 구현'
plan 20261112-race p16 7 '- [x] 구현'
(cd "$CORE" && node --input-type=module -e "
import { openRequest } from './scripts/lib/requests.mjs'
openRequest(process.cwd(), { kind: 'question', title: '물음', links: { plan: 'plans/task/20261112-asked.md' }, pane: 'p13' })
") || { echo "  ✖ 요청을 만들지 못했다"; exit 1; }

mkdir -p "$TMP/fixture"
cp "$SRC/scripts/screen-check/fixtures/studio/"* "$TMP/fixture/"
printf '일 끝\n────────\n❯ \n────────\n  ? for shortcuts\n' > "$TMP/fixture/pane_read.txt"   # 빈 Claude 입력칸
node - "$TMP/fixture/pane_list.json" "$TMP" <<'FIXTURE'
const fs = require('node:fs')
const [file, tmp] = process.argv.slice(2)
const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
const base = { ...fixture.panes[1], cwd: `${tmp}/clean`, foreground_cwd: `${tmp}/clean`, agent_status: 'idle', foreground_status: 'idle', focused: false }
const add = (id, extra) => fixture.panes.push({ ...base, id, label: `🤖 fe · feat/${id}`, ...extra })
add('p6', {})
add('p7', { agent_status: 'working', background_shells: 1 })   // 뒤 셸만 돈다 — 앞은 쉼
add('p8', { focused: true })
add('p9', { cwd: `${tmp}/dirty`, foreground_cwd: `${tmp}/dirty` })
add('p10', { agent_status: 'working', foreground_status: 'working' })
add('p11', {})
add('p12', {})
add('p13', {})
add('p14', {})
add('p15', {})
add('p16', {})
fs.writeFileSync(file, JSON.stringify(fixture))
FIXTURE
SCREEN_LOG="$TMP/screen.log"
: > "$SCREEN_LOG"
PORT=$((47900 + RANDOM % 90))
(cd "$CORE" && PATH="$TMP/bin:$PATH" HOME="$TMP/home" ATHENA_LEARN_QUEUE="$TMP/learn-queue" PYTHONDONTWRITEBYTECODE=1 \
  ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_TAB_ID=t1 ATHENA_STUDIO_WORKSPACE_ID=w1 ATHENA_STUDIO_SOCKET=/tmp/athena-studio.sock \
  ATHENA_STUDIO_CLI="$TMP/bin/athena-studio-cli" ATHENA_STUDIO_ENDPOINT="$TMP/no-studio/daemon.json" \
  FAKE_SCREEN_FIXTURE="$TMP/fixture" FAKE_SCREEN_LOG="$SCREEN_LOG" FAKE_ATHENA="$CORE" ATHENA_BOARD_PANE_CLOSE_MS=0 \
  ATHENA_BOARD_PORT=$PORT exec node scripts/board/server.mjs > "$TMP/server.log" 2>&1) &
SERVER_PID=$!
athena_test_guard "$SERVER_PID"
# 두 주기 — 가짜 화면은 닫아도 pane 이 목록에 남으니 두 번째 주기에도 같은 판정을 한 번 더 본다
for _ in $(seq 1 100); do
  [ "$(grep -c '끝난 pane 닫음' "$TMP/server.log" 2>/dev/null)" -ge 4 ] && break
  sleep 0.2
done

node - "$TMP" <<'EOF'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const [tmp] = process.argv.slice(2)
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }
const read = (path) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
const log = read(join(tmp, 'server.log'))
const calls = read(join(tmp, 'screen.log')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((args) => args[0] === '@studio')
const closed = new Set(calls.filter((args) => args[1] === 'pane' && args[2] === 'close').map((args) => args[3]))
check('PR 머지 + 쉼 → 닫음(scripts/screen pane close)', closed.has('p6'), log)
check('뒤 셸만 돌고 앞은 쉼(foreground_status idle) → 닫음 · 일반 빈 칸은 막지 않는다', closed.has('p7'), log)
for (const [pane, why] of [['p8', '사용자가 봄'], ['p9', '미커밋 변경'], ['p10', '앞이 일함'], ['p11', 'PR 열림'], ['p12', '남은 단계 칸'], ['p13', '열린 요청'], ['p14', '입력칸에 보내지 않은 글'], ['p15', '화면을 못 읽음'], ['p16', '닫기 직전 다시 보니 입력칸에 글'], ['p1', '아테나 pane'], ['p2', '일하는 pane']]) {
  check(`${why} → 안 닫음(${pane})`, !closed.has(pane), [...closed].join(' '))
}
const notes = calls.filter((args) => args[1] === 'pane' && args[2] === 'run' && String(args[4]).includes('🚪'))
check('아테나(Lead pane p1)에 닫은 pane 한 줄', notes.some((args) => args[3] === 'p1' && args[4] === '[현황판 → 아테나] 🚪 p6 닫음 — 맡은 일이 끝남(plans/task/20261112-merged.md)'), JSON.stringify(notes))
check('닫기 직전에 다시 본다(p16 — 취소 기록)', /닫기 취소/.test(log) && log.includes('p16'), log)
check('pane 안 프로그램을 끄는 키는 넣지 않는다(C-c 없음)', !calls.some((args) => args[2] === 'send-keys'), JSON.stringify(calls.filter((args) => args[2] === 'send-keys')))
console.log()
process.exit(fail)
EOF
