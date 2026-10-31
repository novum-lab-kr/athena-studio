#!/usr/bin/env bash
# QA 실행기 · 현황판 QA 탭 시험 — 임시 코어 사본 · 임시 레포 · 가짜 서버로 흐름 문서 + TC 가 통과/실패로 QA 탭에 뜨는지 본다.
# BE 는 언제나 · FE 는 scripts/qa/node_modules 에 Playwright 가 있을 때만(없으면 건너뜀을 표시한다).
# 사용: test/qa-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1 (KEEP=1 이면 임시 폴더를 남긴다)
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-qa-test.XXXXXX")"
CORE="$TMP/core"
SERVER_PID=''
BLOCKER_PID=''
FAILED=0
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$BLOCKER_PID" ] && kill "$BLOCKER_PID" 2>/dev/null
  [ "${KEEP:-0}" = 1 ] || rm -rf "$TMP"
}
trap cleanup EXIT
pass() { echo "  ✔ $1"; }
fail() { echo "  ✖ $1"; [ $# -gt 1 ] && echo "$2" | sed 's/^/      /'; FAILED=1; }
# run.json 을 읽어 JS 식을 평가한다 — 맨 위 변수: run(가장 최근 실행), flow(이름)
# 이름순 = 시작 순서(실행기와 같은 기준 · 끝의 / 를 붙여 정렬하면 x-qa-002 가 x-qa 앞으로 간다)
latest_run() { local name; name="$(ls "$CORE/.qa-runs" 2>/dev/null | LC_ALL=C sort | tail -1)"; [ -n "$name" ] && echo "$CORE/.qa-runs/$name/"; }
check_run() { # 이름 식
  node -e '
    const run = JSON.parse(require("fs").readFileSync(process.argv[1] + "run.json", "utf8"))
    const flow = (name) => run.flows.find((entry) => entry.flow === name)
    const item = (name, id) => flow(name)?.cases.find((entry) => entry.id === id)
    process.exit(eval(process.argv[2]) ? 0 : 1)' "$(latest_run)" "$2" && pass "$1" || fail "$1" "$(cat "$(latest_run)run.json" 2>/dev/null | head -60)"
}

mkdir -p "$CORE"
(cd "$SRC" && tar --exclude=node_modules --exclude=.git -cf - .) | (cd "$CORE" && tar -xf -)
[ -d "$SRC/scripts/qa/node_modules/playwright" ] && ln -s "$SRC/scripts/qa/node_modules" "$CORE/scripts/qa/node_modules"
cat > "$CORE/athena.config.json" <<'EOF'
{ "repos": [
  { "name": "demo", "branch": "main", "prBase": "main", "kind": "single", "remote": "git@github.com:acme/demo.git", "agents": ["demo-fe"] },
  { "name": "lib", "branch": "main", "prBase": "main", "kind": "packages", "remote": "", "agents": ["demo-fe"] }
] }
EOF

# ── 임시 레포: 가짜 서버 + 층별 흐름 문서 · TC ─────────────────────
BE_PORT=$((46000 + RANDOM % 900))
FE_PORT=$((BE_PORT + 1000))
git init -q --bare -b main "$TMP/demo.git"
git init -q -b main "$TMP/seed"
SEED="$TMP/seed"
mkdir -p "$SEED/docs/flows/fe" "$SEED/docs/flows/be" "$SEED/docs/flows/app" "$SEED/src"
cat > "$SEED/src/server.js" <<'EOF'
const { createServer } = require('node:http')
createServer((request, response) => {
  if (request.url === '/health') return response.end('ok')
  if (request.url === '/v1/me') { response.writeHead(401, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'no', token: 'abc' })) }
  if (request.url === '/broken') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return response.end('<script>throw new Error("터짐")</script><h1>깨진 화면</h1>') }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<h1>환영합니다</h1><button id="go" onclick="document.body.append(\'눌렀어요\')">다음</button>')
}).listen(Number(process.argv[2]), '127.0.0.1')
EOF
cat > "$SEED/docs/flows/be/01-auth.md" <<'EOF'
# 인증
## 단계
| 단계 | 엔드포인트 | 근거 | 부르는 API | 오류 처리 | 기대 |
|---|---|---|---|---|---|
| 내 정보 | `GET /v1/me` | `src/server.js:4` | - | 401 | UNAUTHORIZED |
## 갈림길
- **토큰 없음** — 401
- **일부러 틀림** — 실패 표시 시험
- **간편인증** — 사람이 본다
EOF
cat > "$SEED/docs/flows/be/01-auth.tc.json" <<'EOF'
{ "cases": [
  { "id": "AUTH-1", "branch": "토큰 없음", "title": "401", "request": { "path": "/v1/me" }, "expect": { "status": 401, "body": { "code": "UNAUTHORIZED" }, "shape": { "message": "string" } } },
  { "id": "AUTH-2", "branch": "일부러 틀림", "title": "상태 코드가 달라 실패", "request": { "path": "/v1/me" }, "expect": { "status": 200 } },
  { "id": "AUTH-3", "branch": "간편인증", "manual": "자동으로 못 돈다" }
] }
EOF
cat > "$SEED/docs/flows/be/02-bad.md" <<'EOF'
# 짝이 안 맞는 TC
EOF
cat > "$SEED/docs/flows/be/02-bad.tc.json" <<'EOF'
{ "cases": [ { "id": "BAD-1", "branch": "문서에 없는 분기", "request": { "path": "/health" }, "expect": { "status": 200 } } ] }
EOF
cat > "$SEED/docs/flows/fe/01-home.md" <<'EOF'
# 첫 화면
## 갈림길
- **첫 화면 정상**
- **콘솔 오류**
- **문구 없음**
EOF
cat > "$SEED/docs/flows/fe/01-home.tc.json" <<'EOF'
{ "cases": [
  { "id": "HOME-1", "branch": "첫 화면 정상", "steps": [ { "goto": "/" }, { "expectText": "환영합니다" }, { "click": "#go" }, { "expectText": "눌렀어요" } ] },
  { "id": "HOME-2", "branch": "콘솔 오류", "steps": [ { "goto": "/broken" }, { "expectText": "깨진 화면" } ] }
] }
EOF
cat > "$SEED/docs/flows/app/01-signup.md" <<'EOF'
# 가입
## 체크리스트
- [ ] 가입하면 홈이 보인다
EOF
cat > "$SEED/docs/flows/qa.json" <<EOF
{ "fe": { "start": "node src/server.js $FE_PORT", "url": "http://localhost:$FE_PORT", "ready": "/health" },
  "be": { "install": "touch installed-by-qa", "start": "node src/server.js $BE_PORT", "url": "http://localhost:$BE_PORT", "ready": "/health" } }
EOF
git -C "$SEED" add -A
git -C "$SEED" -c user.name=t -c user.email=t@t commit -qm 시작
git -C "$SEED" remote add origin "$TMP/demo.git"
git -C "$SEED" push -q origin main
mkdir -p "$CORE/repos"
git clone -q "$TMP/demo.git" "$CORE/repos/demo"

# ── 순수 로직 ──────────────────────────────────────────────────────
echo "순수 로직:"
(cd "$CORE" && node --input-type=module -e "
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimRunId, checkLayerSettings, checkTc, affectedFlows, docUrl, flowsOfFiles, listServices } from './scripts/qa/flows.mjs'
import { shapeErrors, bodyErrors } from './scripts/qa/cases.mjs'
import assert from 'node:assert/strict'
assert.match(checkLayerSettings({ start: 'x', url: 'https://dev.acme.com' }, 'be'), /로컬 서버만/)
assert.equal(checkLayerSettings({ start: 'x', url: 'http://127.0.0.1:3000' }, 'be'), '')
assert.match(checkLayerSettings(undefined, 'fe'), /설정이 없어요/)
assert.ok(checkTc({ cases: [{ id: 'A', branch: '없는 글', request: { path: '/x' }, expect: { status: 200 } }] }, 'be', '다른 글')[0].includes('흐름 문서에 없어요'))
assert.ok(checkTc({ cases: [{ id: 'A', branch: '글', steps: [{ goto: 'https://x' }] }] }, 'fe', '글')[0].includes('/ 로 시작'))
assert.deepEqual(checkTc({ cases: [{ id: 'A', branch: '글', manual: '이유' }] }, 'be', '글'), [])
assert.deepEqual(flowsOfFiles(['fe/a.md', 'fe/a.tc.json', 'app/b.md', 'app/b.tc.json', 'fe/README.md', 'qa.json']).map((item) => [item.flow, item.tc]), [['a', 'fe/a.tc.json'], ['b', null]])
const docs = [{ layer: 'fe', flow: 'a', text: '근거 \`src/x.ts:12\` · \`src/y.ts\`' }]
assert.deepEqual(affectedFlows(['src/x.ts', 'docs/flows/fe/a.md'], docs), [{ layer: 'fe', flow: 'a', files: ['src/x.ts'] }])
assert.deepEqual(affectedFlows(['src/z.ts'], docs), [])
assert.deepEqual(shapeErrors({ items: [{ id: 'number' }], name: 'string' }, { items: [{ id: 1 }], name: 'a' }), [])
assert.equal(shapeErrors({ name: 'string' }, { name: 1 }).length, 1)
assert.equal(bodyErrors({ code: 'A' }, { code: 'A', more: 1 }).length, 0)
assert.equal(bodyErrors({ code: 'A' }, { code: 'B' }).length, 1)
const services = listServices({ repos: [{ name: 'mono', kind: 'monorepo', branch: 'dev', apps: { web: { branch: 'main' }, api: { dir: 'svc/api' } } }, { name: 'pkg', kind: 'packages' }] })
assert.deepEqual(services.map((item) => [item.name, item.dir, item.branch]), [['web', 'apps/web', 'main'], ['api', 'svc/api', 'dev']])
assert.equal(docUrl({ remote: 'git@github.com:acme/demo.git', branch: 'main', dir: '' }, 'fe/a b.md'), 'https://github.com/acme/demo/blob/main/docs/flows/fe/a%20b.md')
const runsDir = mkdtempSync(join(tmpdir(), 'qa-runs-'))
const claimed = [claimRunId(runsDir, '20261030-000000'), claimRunId(runsDir, '20261030-000000'), claimRunId(runsDir, '20261030-000000')]
assert.equal(new Set(claimed).size, 3)
assert.deepEqual([...claimed].sort(), claimed)
rmSync(runsDir, { recursive: true })
assert.equal(docUrl({ remote: 'https://gitlab.com/acme/demo', branch: 'main', dir: '' }, 'fe/a.md'), null)
" && pass "형식 검사 · 로컬만 · 닿는 흐름 · 응답 비교 · 서비스 목록 · 문서 주소 · 같은 초 실행 폴더") || fail "순수 로직"

# ── 실행기 BE ──────────────────────────────────────────────────────
echo "실행기 BE:"
OUT="$(cd "$CORE" && node scripts/qa/run.mjs --service demo --layer be 2>&1)"; CODE=$?
[ "$CODE" = 1 ] && pass "실패가 있으면 끝 코드 1" || fail "실패가 있으면 끝 코드 1 (지금 $CODE)" "$OUT"
check_run "통과 케이스" 'item("01-auth", "AUTH-1")?.status === "pass"'
check_run "실패 케이스 — 원문이 남는다" 'item("01-auth", "AUTH-2")?.status === "fail" && item("01-auth", "AUTH-2").error.includes("상태 코드 200 여야 하는데 401")'
check_run "실패 원문의 비밀값 모양은 가린다" '!item("01-auth", "AUTH-2").error.includes("abc")'
check_run "manual 은 돌리지 않고 사람 확인" 'item("01-auth", "AUTH-3")?.status === "manual"'
check_run "흐름 상태 fail" 'flow("01-auth").status === "fail"'
check_run "문서에 없는 분기는 흐름 오류" 'flow("02-bad").status === "error" && flow("02-bad").error.includes("흐름 문서에 없어요")'
check_run "끝났다고 기록" 'Boolean(run.finishedAt)'
[ -e "$CORE/.worktrees/demo/qa-base/installed-by-qa" ] && pass "기준 트리에 install" || fail "기준 트리에 install"
curl -s -o /dev/null --max-time 1 "http://localhost:$BE_PORT/health" && fail "끝나면 서버를 끈다" || pass "끝나면 서버를 끈다"

# 같은 주소에 서버가 떠 있으면 돌리지 않는다 · --reuse-server 는 쓴다
node "$SEED/src/server.js" "$BE_PORT" & BLOCKER_PID=$!
for _ in $(seq 1 20); do curl -s -o /dev/null --max-time 1 "http://localhost:$BE_PORT/health" && break; sleep 0.2; done
(cd "$CORE" && node scripts/qa/run.mjs --service demo --layer be --flow 01-auth >/dev/null 2>&1)
check_run "이미 떠 있는 서버는 거부" 'flow("01-auth").status === "error" && flow("01-auth").error.includes("이미 서버가 떠 있어요")'
(cd "$CORE" && node scripts/qa/run.mjs --service demo --layer be --flow 01-auth --reuse-server >/dev/null 2>&1)
check_run "--reuse-server 면 그 서버로" 'item("01-auth", "AUTH-1")?.status === "pass"'
kill "$BLOCKER_PID" 2>/dev/null; wait "$BLOCKER_PID" 2>/dev/null; BLOCKER_PID=''

# 사용법 오류
(cd "$CORE" && node scripts/qa/run.mjs >/dev/null 2>&1); [ $? = 2 ] && pass "인자 없으면 끝 코드 2" || fail "인자 없으면 끝 코드 2"
(cd "$CORE" && node scripts/qa/run.mjs --service 없음 >/dev/null 2>&1); [ $? = 2 ] && pass "모르는 서비스 끝 코드 2" || fail "모르는 서비스 끝 코드 2"

# ── 실행기 FE ──────────────────────────────────────────────────────
echo "실행기 FE:"
if [ -e "$CORE/scripts/qa/node_modules/playwright" ]; then
  OUT="$(cd "$CORE" && node scripts/qa/run.mjs --service demo --layer fe 2>&1)"
  check_run "실제 브라우저로 누르고 문구 확인" 'item("01-home", "HOME-1")?.status === "pass"'
  check_run "페이지 오류가 있으면 실패" 'item("01-home", "HOME-2")?.status === "fail" && item("01-home", "HOME-2").error.includes("터짐")'
else
  echo "  ⏭ 건너뜀 — Playwright 없음(scripts/setup.sh)"
  (cd "$CORE" && node scripts/qa/run.mjs --service demo --layer fe >/dev/null 2>&1)
  check_run "Playwright 가 없으면 설치 안내" 'flow("01-home").status === "error" && flow("01-home").error.includes("setup.sh")'
fi

# ── 현황판 ─────────────────────────────────────────────────────────
echo "현황판 QA 탭:"
mkdir -p "$TMP/bin"
for name in claude gh; do printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/$name"; chmod +x "$TMP/bin/$name"; done
PORT=$((47000 + RANDOM % 900))
export ATHENA_HEAVY_LOCK="$TMP/heavy.lock"
(cd "$CORE" && PATH="$TMP/bin:$PATH" ATHENA_BOARD_PORT=$PORT exec node scripts/board/server.mjs > "$TMP/server.log" 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -s "http://127.0.0.1:$PORT/api/qa/flows" -o "$TMP/flows.json" 2>/dev/null && grep -q '"services"' "$TMP/flows.json" && break; sleep 0.5; done
check_flows() {
  curl -s "http://127.0.0.1:$PORT/api/qa/flows" -o "$TMP/flows.json"
  node -e '
    const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const demo = data.services.find((entry) => entry.name === "demo")
    const layer = (name) => demo?.layers.find((entry) => entry.layer === name)
    const flow = (name, id) => layer(name)?.flows.find((entry) => entry.flow === id)
    process.exit(eval(process.argv[2]) ? 0 : 1)' "$TMP/flows.json" "$2" && pass "$1" || fail "$1" "$(head -c 1500 "$TMP/flows.json")"
}
check_flows "서비스 → 층 → 흐름(발행 패키지는 뺀다)" 'data.services.length === 1 && layer("be").flows.length === 2 && layer("fe").flows.length === 1 && layer("app").flows.length === 1'
check_flows "결과가 뜬다(마지막 실행 · 케이스)" 'flow("be", "01-auth").result.ranAt && flow("be", "01-auth").result.cases.length === 3'
check_flows "실패 원문이 뜬다" 'flow("be", "02-bad").result.error.includes("흐름 문서에 없어요")'
check_flows "문서 링크는 GitHub blob" 'flow("be", "01-auth").docUrl === "https://github.com/acme/demo/blob/main/docs/flows/be/01-auth.md"'
check_flows "앱은 TC 없음" 'flow("app", "01-signup").hasTc === false && flow("app", "01-signup").result === null'

PAGE="$(curl -s "http://127.0.0.1:$PORT/")"
TOKEN="$(printf '%s' "$PAGE" | sed -n "s/.*const TOKEN = '\([0-9a-f]*\)'.*/\1/p" | head -1)"
grep -q 'id="qa-services"' <<< "$PAGE" && pass "화면에 QA 칸" || fail "화면에 QA 칸"
post() { curl -s -o "$TMP/post.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/qa-run" -H "Origin: http://127.0.0.1:$PORT" -H "Content-Type: application/json" -H "X-Board-Token: ${2:-$TOKEN}" -d "$1"; }
[ "$(post '{"service":"demo"}' wrong)" = 403 ] && pass "토큰 없으면 거부" || fail "토큰 없으면 거부" "$(cat "$TMP/post.json")"
[ "$(post '{"service":"없음"}')" = 400 ] && pass "모르는 서비스 400" || fail "모르는 서비스 400" "$(cat "$TMP/post.json")"
[ "$(post '{"service":"demo","layer":"app"}')" = 400 ] && pass "앱 층은 실행 안 됨" || fail "앱 층은 실행 안 됨" "$(cat "$TMP/post.json")"
BEFORE="$(latest_run)"
[ "$(post '{"service":"demo","layer":"be","flow":"01-auth"}')" = 202 ] && pass "[실행] 202" || fail "[실행] 202" "$(cat "$TMP/post.json")"
[ "$(post '{"service":"demo"}')" = 400 ] && pass "도는 중이면 거부" || fail "도는 중이면 거부" "$(cat "$TMP/post.json")"
for _ in $(seq 1 60); do
  [ "$(latest_run)" != "$BEFORE" ] && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1] + "run.json", "utf8")).finishedAt ? 0 : 1)' "$(latest_run)" 2>/dev/null && break
  sleep 0.5
done
check_run "[실행] 이 실행기를 돌렸다" 'flow("01-auth")?.status === "fail" && run.flows.length === 1'
check_flows "끝나면 결과가 바뀌고 도는 표시가 꺼진다" '!data.running && flow("be", "01-auth").result.status === "fail"'

# 화면 — 탭을 누르면 실제로 그려지고 [실행] 버튼이 토큰 · Origin 검사를 통과하는지
if [ -e "$CORE/scripts/qa/node_modules/playwright" ]; then
  cat > "$CORE/scripts/qa/browser-check.mjs" <<'EOF'
import { chromium } from './node_modules/playwright/index.mjs'
const [port, shot] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.goto(`http://127.0.0.1:${port}/`)
await page.click('#tab-qa')
await page.waitForSelector('.qa-flow', { timeout: 10000 })
const text = await page.innerText('#qa-services')
for (const word of ['demo', '01-auth', '02-bad', '01-home', '01-signup', '흐름 문서에 없어요']) {
  if (!text.includes(word)) throw new Error(`화면에 없음: ${word}\n${text}`)
}
await page.screenshot({ path: shot })
const [response] = await Promise.all([
  page.waitForResponse('**/api/qa-run'),
  page.click('button[data-qa-service="demo"][data-qa-layer="be"][data-qa-flow="01-auth"]'),
])
if (response.status() !== 202) throw new Error(`[실행] 응답 ${response.status()}`)
if (errors.length) throw new Error(`페이지 오류: ${errors.join('\n')}`)
await browser.close()
EOF
  OUT="$(cd "$CORE/scripts/qa" && node browser-check.mjs "$PORT" "$TMP/qa-tab.png" 2>&1)" && pass "탭이 그려지고 [실행] 버튼이 동작" || fail "탭이 그려지고 [실행] 버튼이 동작" "$OUT"
  rm -f "$CORE/scripts/qa/browser-check.mjs"
  for _ in $(seq 1 60); do
    node -e 'process.exit(JSON.parse(require("fs").readFileSync(0, "utf8")).running ? 1 : 0)' < <(curl -s "http://127.0.0.1:$PORT/api/qa/flows") && break
    sleep 0.5
  done
else
  echo "  ⏭ 건너뜀 — 화면 확인(Playwright 없음)"
fi

# ── 실행기가 죽지 않고 · 죽어도 기록이 남는다 ───────────────────────
echo "실행기 죽음:"
CRASH_PORT=$((FE_PORT + 500))
CRASH_TREE="$TMP/crash-tree"
mkdir -p "$CRASH_TREE/docs/flows/be"
cat > "$CRASH_TREE/server.js" <<'EOF'
require('node:http').createServer((request, response) => response.end('ok')).listen(Number(process.argv[2]), '127.0.0.1')
EOF
# 응답 뒤 연결을 닫는 서버(python http.server 와 같다) — 본문을 안 읽은 fetch 가 undici assert(!this.paused) 로 프로세스를 죽였다.
# 다른 프로세스 서버로는 가끔만 터져서, 실행기 안에 띄워 항상 터지는 조건으로 본다(--reuse-server 로 여기에 붙는다)
cat > "$TMP/close-server-preload.mjs" <<'EOF'
import { createServer } from 'node:net'
const size = 80 * 1024
const server = createServer((socket) => {
  socket.on('error', () => {})
  socket.once('data', () => {
    socket.write(`HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${size}\r\n\r\n`)
    socket.end(Buffer.alloc(size, 97))
  })
})
await new Promise((ready) => server.listen(Number(process.env.CRASH_PORT), '127.0.0.1', ready))
EOF
printf '# 닫는 서버\n## 갈림길\n- **열림**\n' > "$CRASH_TREE/docs/flows/be/01-close.md"
printf '{ "cases": [ { "id": "CLOSE-1", "branch": "열림", "request": { "path": "/ok" }, "expect": { "status": 200 } } ] }\n' > "$CRASH_TREE/docs/flows/be/01-close.tc.json"
printf '# 터지는 흐름\n## 갈림길\n- **터짐**\n' > "$CRASH_TREE/docs/flows/be/02-boom.md"
printf '{ "cases": [ { "id": "BOOM-1", "branch": "터짐", "request": { "path": "/boom" }, "expect": { "status": 200 } } ] }\n' > "$CRASH_TREE/docs/flows/be/02-boom.tc.json"
printf '{ "be": { "start": "node server.js %s", "url": "http://127.0.0.1:%s", "ready": "/" } }\n' "$CRASH_PORT" "$CRASH_PORT" > "$CRASH_TREE/docs/flows/qa.json"
# TC 도중 잡히지 않는 예외를 일으킨다 — 실행기 코드에 시험용 구멍을 내지 않으려고 fetch 만 바꿔 끼운다
cat > "$TMP/crash-preload.mjs" <<'EOF'
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) => {
  if (!String(url).includes('/boom')) return realFetch(url, init)
  setTimeout(() => { throw new Error('일부러 터짐') }, 0)
  return new Promise(() => {})
}
EOF
git -C "$CRASH_TREE" init -q -b main
git -C "$CRASH_TREE" add -A
git -C "$CRASH_TREE" -c user.name=t -c user.email=t@t commit -qm 시작
OUT="$(cd "$CORE" && CRASH_PORT="$CRASH_PORT" node --import "$TMP/close-server-preload.mjs" scripts/qa/run.mjs --service demo --cwd "$CRASH_TREE" --layer be --flow 01-close --reuse-server 2>&1)"; CODE=$?
[ "$CODE" = 0 ] && pass "연결을 닫는 서버를 기다려도 안 죽는다" || fail "연결을 닫는 서버를 기다려도 안 죽는다" "$OUT"
OUT="$(cd "$CORE" && node --import "$TMP/crash-preload.mjs" scripts/qa/run.mjs --service demo --cwd "$CRASH_TREE" --layer be --flow 02-boom 2>&1)"; CODE=$?
[ "$CODE" = 1 ] && pass "도중에 터지면 끝 코드 1" || fail "도중에 터지면 끝 코드 1" "code $CODE: $OUT"
check_run "터진 케이스는 실패로 남는다" 'item("02-boom", "BOOM-1")?.status === "fail" && item("02-boom", "BOOM-1").error.includes("일부러 터짐")'
check_run "흐름은 오류 · 실행은 끝남으로 남는다" 'flow("02-boom").status === "error" && Boolean(run.finishedAt)'
curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$CRASH_PORT/" && fail "터져도 띄운 서버를 끈다" || pass "터져도 띄운 서버를 끈다"

# ── 싱크 확정 뒤 자동 실행 ─────────────────────────────────────────
echo "싱크:"
(cd "$CORE" && PATH="$TMP/bin:$PATH" node scripts/sync-fingerprint.mjs --repo demo >/dev/null 2>&1)
OUT="$(cd "$CORE" && node scripts/sync-fingerprint.mjs --accept 2>&1)"
grep -q 'QA 시작' <<< "$OUT" && fail "첫 확정은 돌리지 않는다" "$OUT" || pass "첫 확정은 돌리지 않는다"
FROM="$(git -C "$SEED" rev-parse HEAD)"
echo '// 바꿈' >> "$SEED/src/server.js"
git -C "$SEED" add -A; git -C "$SEED" -c user.name=t -c user.email=t@t commit -qm 바꿈; git -C "$SEED" push -q origin main
(cd "$CORE" && PATH="$TMP/bin:$PATH" node scripts/sync-fingerprint.mjs --repo demo >/dev/null 2>&1)
AFFECTED="$(cd "$CORE" && node scripts/qa/affected.mjs --service demo --from "$FROM" 2>&1)"
grep -q 'demo be/01-auth: src/server.js' <<< "$AFFECTED" && pass "바뀐 파일이 닿는 흐름을 찾는다" || fail "바뀐 파일이 닿는 흐름을 찾는다" "$AFFECTED"
BEFORE="$(latest_run)"
OUT="$(cd "$CORE" && node scripts/sync-fingerprint.mjs --accept 2>&1)"
grep -q 'QA 시작: demo' <<< "$OUT" && pass "코드가 바뀌면 확정 뒤 QA 시작" || fail "코드가 바뀌면 확정 뒤 QA 시작" "$OUT"
for _ in $(seq 1 120); do
  [ "$(latest_run)" != "$BEFORE" ] && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1] + "run.json", "utf8")).finishedAt ? 0 : 1)' "$(latest_run)" 2>/dev/null && break
  sleep 0.5
done
export NEW_REF="$(git -C "$SEED" rev-parse HEAD | cut -c1-12)"
check_run "자동 실행 결과가 남는다(새 커밋 기준)" 'flow("01-auth")?.ref === process.env.NEW_REF'

echo
[ "$FAILED" = 0 ] && echo 'qa-test: 모두 통과' || echo 'qa-test: 실패 있음'
exit "$FAILED"
