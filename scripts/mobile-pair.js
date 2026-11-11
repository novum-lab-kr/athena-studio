#!/usr/bin/env node
// @ts-check
// 모바일 시험 2 의 개발용 [허용] — 격리 시험 앱(src/main/mobile-dev.mts)이 기다리는 연결 요청을 보고 허용 · 거절한다.
//   node scripts/mobile-pair.js --home <격리 집>                    기다리는 요청 보기(요청 id · 기기 id · 확인 숫자)
//   node scripts/mobile-pair.js --home <격리 집> accept [requestId]  허용(요청이 하나면 id 생략)
//   node scripts/mobile-pair.js --home <격리 집> reject [requestId]  거절
// 앱이 <집>/mobile/pair-answer.json 을 0.5초마다 읽어 relay 에 답한다. 폰 화면의 확인 숫자와 같은지 먼저 본다
const fs = require('fs')
const path = require('path')

/** @param {string} message */
function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const homeAt = args.indexOf('--home')
const home = homeAt >= 0 ? args[homeAt + 1] : ''
if (!home) fail('사용: node scripts/mobile-pair.js --home <격리 집> [accept|reject] [requestId]')
const rest = args.filter((_, index) => index !== homeAt && index !== homeAt + 1)
const [action = 'list', wanted = ''] = rest
// 상태 폴더 — mobile-dev.mts mobileStateDir 와 같은 자리
const dir = path.join(path.resolve(/** @type {string} */ (home)), 'mobile')

/** @returns {{ requestId: string, from: string, code: string, at: string }[]} */
function readPending() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'pair-pending.json'), 'utf8'))
    return Array.isArray(parsed.pending) ? parsed.pending : []
  } catch {
    return []
  }
}

const pending = readPending()
if (action === 'list') {
  if (!pending.length) console.log('기다리는 연결 요청이 없어요')
  for (const request of pending) console.log(`${request.requestId}  기기 ${request.from}  확인 숫자 ${request.code}  ${request.at}`)
  process.exit(0)
}
if (action !== 'accept' && action !== 'reject') fail(`모르는 동작: ${action} — accept · reject`)
if (!wanted && pending.length !== 1) fail(pending.length ? '요청이 여럿이에요 — requestId 를 적어 주세요' : '기다리는 연결 요청이 없어요')
const target = wanted ? pending.find((request) => request.requestId === wanted) : pending[0]
if (!target) fail(`기다리는 요청이 아니에요: ${wanted}`)
const chosen = /** @type {{ requestId: string, code: string }} */ (target)
// 비밀은 없지만 상태 폴더와 같은 권한으로
fs.writeFileSync(path.join(dir, 'pair-answer.json'), `${JSON.stringify({ requestId: chosen.requestId, answer: action })}\n`, { mode: 0o600 })
console.log(`${action === 'accept' ? '허용' : '거절'}을 넘겼어요 — ${chosen.requestId} (확인 숫자 ${chosen.code}) · 앱 로그에서 결과를 보세요`)
