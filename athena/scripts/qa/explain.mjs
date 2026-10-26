/**
 * QA 실패 문구를 사람이 읽는 원인으로 — 콘솔 오류 원문(스택·%o·수천 번 반복)을 "무엇 때문에 실패인지" 한 줄 + 횟수 + 확인할 곳으로 묶는다.
 * run.json 은 원문 그대로 두고, 보여 줄 때만 쓴다(일감 /api/qa/run 이 screens[].reasons 로 붙인다).
 *
 *   explainProblems(problems, guesses?) → [{ title, why, hint, kind, count, viewports, at, sample, unknownKey? }]  (많이 나온 순)
 *   guessCause(group) → { cause, confidence, model } | null   정규식이 모르는 오류(unknownKey 가 있는 묶음)의 원인을 Jev 로 추정
 *     guesses = { [unknownKey]: guessCause 결과 } 를 explainProblems 에 주면 why·hint 에 "추정(Jev N%)" 으로 붙인다(일감이 캐시에 모아 준다)
 */
import { askJev } from '../lib/jev.mjs'

const firstLine = (text) => String(text ?? '').replace(/%[osdifcO]/g, '').split('\n').map((line) => line.trim()).find(Boolean) ?? ''
const hostOf = (text) => text.match(/https?:\/\/([^/'"\s]+)/)?.[1] ?? ''

// 원문 하나 → { key, title, why, hint } — key 가 같으면 한 줄로 묶는다
function classify(problem) {
  const text = String(problem.text ?? '')
  const kind = problem.kind ?? ''
  if (kind === 'tracking') {
    const name = text.split('—').pop().trim()
    return { key: `tracking:${name}`, title: `화면 보기 이벤트가 안 나감 — ${name}`, why: '이 화면을 열면 Mixpanel 로 나가야 하는 화면 보기 이벤트가 잡히지 않았다', hint: '화면의 PageViewEventLogger·sendViewEvent 이름과 호출 시점(로그인·가드 뒤에만 나가는지)을 본다' }
  }
  if (kind === 'expect') return { key: `expect:${text}`, title: `기대한 이동과 다름 — ${text}`, why: '세션 상태(비로그인·로그인·본인인증)에 맞는 곳으로 보내지 않았다', hint: '가드(AuthGuard 등)와 routes 설정의 expect 를 비교한다' }
  if (/blocked by CORS policy/i.test(text)) {
    const host = hostOf(text.split('from origin')[0])
    return { key: `cors:${host}`, title: `API 호출이 CORS 로 막힘 — ${host}`, why: `이 주소(${hostOf(text.split('from origin')[1] ?? '') || '테스트 주소'})에서 ${host} 를 부르는 것이 서버 설정으로 막혀 있다`, hint: '코드 문제가 아니라 환경 문제일 수 있다 — 서버 대상(dev 주소)으로 다시 돌려 비교한다' }
  }
  if (kind === 'network') {
    const target = text.replace(/^net::\S+\s*/, '')
    return { key: `network:${hostOf(target) || target.split('?')[0]}`, title: `요청이 응답을 못 받음 — ${target.split('?')[0].slice(0, 80)}`, why: `${text.split(' ')[0]} — 네트워크·CORS·서버 다운으로 요청이 끊겼다`, hint: '같은 화면의 CORS·서버 오류 줄과 함께 본다' }
  }
  if (/Access forbidden\. Clearing access token and reloading/i.test(text)) return { key: 'forbidden-reload', title: '권한 없음(403)으로 로그인 토큰을 지우고 페이지를 다시 불러옴', why: 'API 가 403 을 돌려줘 앱이 토큰을 지우고 새로고침했다 — 많이 반복되면 무한 새로고침', hint: '세션(로그인 상태)이 이 화면에 맞는지, 그 API 의 권한을 본다' }
  const noData = text.match(/No data returned for operation `([^`]+)`, got error\(s\):\s*([\s\S]*)/)
  if (noData) {
    const message = firstLine(noData[2].replace(/See the error `source`[\s\S]*/, ''))
    return { key: `gql:${noData[1]}:${message}`, title: `API 오류 — ${noData[1]}: ${message}`, why: 'GraphQL 서버가 데이터 대신 오류를 돌려줬다', hint: '백엔드 응답 문제일 가능성 — 계정 데이터(이력 유무)와 API 를 본다' }
  }
  const missingField = text.match(/Payload did not contain a value for field `([^`:]+)/)
  if (missingField) return { key: `field:${missingField[1]}`, title: `API 응답에 ${missingField[1]} 값이 없음`, why: '응답이 비었거나 요청이 실패해 화면이 기대한 필드를 못 받았다', hint: '같은 화면의 요청 실패·API 오류 줄이 원인인 경우가 많다' }
  if (/fetchGraphQL error: TypeError: Failed to fetch/i.test(text)) return { key: 'gql-failed-fetch', title: 'GraphQL 요청이 응답을 못 받음(Failed to fetch)', why: '요청이 서버까지 가지 못했다 — CORS·네트워크·서버 다운', hint: '같은 화면의 CORS·요청 실패 줄과 함께 본다' }
  const readUndefined = text.match(/Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/)
  if (readUndefined) return { key: `undefined:${readUndefined[2]}:${problem.at ?? ''}`, title: `화면 코드 오류 — 없는 값(${readUndefined[1]})의 ${readUndefined[2]} 를 읽으려 함`, why: '응답이나 상태가 비어 있는데 코드가 바로 읽었다 — 보통 앞선 API 실패의 결과', hint: problem.at ? `코드 위치 ${problem.at}` : '스택의 첫 앱 코드 위치를 본다' }
  if (kind === 'http') {
    const status = Number(text.split(' ')[0])
    const path = text.split(' ').slice(1).join(' ').split('?')[0]
    const label = status === 404 ? '주소가 없음(404)' : status === 401 || status === 403 ? `권한 없음(${status})` : status >= 500 ? `서버 오류(${status})` : `HTTP ${status}`
    return { key: `http:${status}:${path}`, title: `${label} — ${path.slice(0, 90)}`, why: '화면이 부른 요청이 실패 응답을 받았다', hint: status >= 500 ? '백엔드 쪽 오류일 수 있다' : '요청 주소·세션 상태를 본다' }
  }
  if (kind === 'pageerror') return { key: `pageerror:${firstLine(text)}`, title: `화면 코드 예외 — ${firstLine(text).slice(0, 100)}`, why: '잡히지 않은 오류로 화면 코드가 멈췄다', hint: problem.at ? `코드 위치 ${problem.at}` : '' }
  if (kind === 'timeout') return { key: `timeout:${firstLine(text)}`, title: '화면이 시간 안에 다 뜨지 않음', why: firstLine(text).slice(0, 140), hint: '느린 API·무한 로딩·무한 새로고침인지 본다' }
  // 나머지(css·image·layout·text·font·console 등) — 원문 첫 줄을 그대로, 서식 기호만 정리
  const line = firstLine(text).slice(0, 140)
  return { key: `${kind}:${line}`, title: kind === 'console' ? `콘솔 오류 — ${line}` : line, why: '', hint: problem.at ? `코드 위치 ${problem.at}` : '', unknown: true }
}

// ── 정규식이 모르는 오류 — Jev 원인 추정(scripts/lib/jev.mjs). 표시만 바꾸고 run.json 원문·실패 판정은 그대로 ─────
export const CAUSES = {
  api: { label: 'API 요청·응답 문제', hint: '같은 화면의 요청 실패·API 오류 줄과 함께 본다', criterion: 'API 요청이 실패했거나 응답(데이터·오류 필드)이 기대와 달라 생긴 오류' },
  code: { label: '화면 코드 오류', hint: '스택의 첫 앱 코드 위치를 본다', criterion: '앱의 화면·컴포넌트 코드가 잘못 동작해 생긴 오류(렌더링·상태·타입·잘못된 값 처리)' },
  env: { label: '실행 환경·설정 문제', hint: '코드보다 환경 변수·도메인·dev 서버 설정을 먼저 본다', criterion: '실행 환경이나 설정(환경 변수·도메인·CORS·인증서·dev 서버) 때문에 생긴 오류' },
  asset: { label: '리소스 로드 문제', hint: '파일 경로·CDN·빌드 산출물을 본다', criterion: '이미지·폰트·CSS·스크립트 파일 같은 리소스를 불러오지 못해 생긴 오류' },
  tracking: { label: '외부 도구(분석·광고·채팅) 문제', hint: '화면 기능과 무관할 수 있다 — 외부 도구 설정을 본다', criterion: '분석·광고·채팅 같은 외부 스크립트나 SDK 에서 난 오류' },
  noise: { label: '화면과 무관한 경고일 수 있음', hint: '실제 문제인지 원문을 한 번 본다', criterion: '개발 모드·브라우저·라이브러리가 내는 경고로, 화면 동작과는 무관한 것' },
}
// 이보다 확신이 낮으면 붙이지 않는다(모르는 채로 둔다)
const GUESS_MIN = 0.6
// 질문을 바꾸면 올린다 — 기록(.jev-log.jsonl)에서 질문별로 나눠 보려고
const GUESS_VERSION = 'qa-cause-v1'

export async function guessCause(group) {
  const answer = await askJev({
    purpose: 'qa-explain',
    state: `웹 화면 QA 중 브라우저에서 잡힌 문제(종류: ${group.kind || '알 수 없음'}${group.at ? ` · 위치: ${group.at}` : ''})\n${group.sample}`,
    questions: { cause: { type: 'choice', instructions: '이 문제가 생긴 가장 그럴듯한 원인', criteria: Object.fromEntries(Object.entries(CAUSES).map(([name, cause]) => [name, cause.criterion])) } },
    meta: { qv: GUESS_VERSION },
  })
  const cause = answer?.answers?.cause
  return cause && CAUSES[cause.choice] ? { cause: cause.choice, confidence: Number(cause.confidence ?? 0), model: answer.model } : null
}

const withGuess = (group, guess) => {
  if (!guess || !CAUSES[guess.cause] || guess.confidence < GUESS_MIN) return group
  const cause = CAUSES[guess.cause]
  return { ...group, why: `추정(Jev ${Math.round(guess.confidence * 100)}%) — ${cause.label}`, hint: group.hint ? `${group.hint} · ${cause.hint}` : cause.hint, guessed: guess.cause }
}

export function explainProblems(problems = [], guesses = {}) {
  const groups = new Map()
  for (const problem of problems) {
    const item = classify(problem)
    const group = groups.get(item.key) ?? { ...item, rankKey: item.key.split(':')[0], kind: problem.kind ?? '', count: 0, viewports: [], at: problem.at ?? '', sample: String(problem.text ?? '').slice(0, 400) }
    group.count += 1
    if (problem.viewport && !group.viewports.includes(problem.viewport)) group.viewports.push(problem.viewport)
    groups.set(item.key, group)
  }
  return [...groups.values()].map(({ key, unknown, ...plain }) => {
    const group = unknown ? withGuess({ ...plain, unknownKey: key }, guesses[key]) : plain
    return {
      ...group,
      // 같은 오류가 수십 번 넘게 반복되면 무한 루프(새로고침·재요청)를 의심한다
      why: group.count > 50 ? `${group.why ? `${group.why} · ` : ''}같은 오류가 ${group.count}번 반복 — 무한 루프 의심` : group.why
    }
  }).sort((left, right) => rankOf(left) - rankOf(right) || right.count - left.count)
}

// 원인 쪽을 먼저 — 기대 이동·권한·CORS·API 오류가 그 결과로 생긴 "응답 못 받음·값 없음" 보다 위로 온다
const RANK = { expect: 0, 'forbidden-reload': 1, cors: 1, gql: 2, http: 2, pageerror: 3, timeout: 3, tracking: 4, network: 5, 'gql-failed-fetch': 5, field: 6, undefined: 6 }
const rankOf = (group) => RANK[group.rankKey] ?? 7
