#!/usr/bin/env node
/**
 * 정식 계획서의 결정 콘솔 html 을 만들거나 md 와 맞춘다.
 *
 *   node scripts/plan-html.mjs <plans/…md> --data <PLAN.json>   # 처음 만들 때 (docs/plan-template.html 복사)
 *   node scripts/plan-html.mjs <plans/…md> [--data <PLAN.json>] # 이미 있으면 틀을 지금 템플릿으로 · plan-md 를 md 로 다시 맞추고, --data 가 있으면 PLAN 도 바꾼다
 *   node scripts/plan-html.mjs <plans/…md> --add <결정.json>    # 리뷰 뒤 결정을 덧붙인다 — 기존 결정(확정분은 잠긴 채)은 두고 새 결정만 연다.
 *                                                               html 이 없으면(경량 계획서) 템플릿으로 새로 만든다. 결정.json 은 decisions[] 배열(또는 { decisions: [] })
 *   node scripts/plan-html.mjs <plans/…md> --decide r1='<label>' [r2='<label>' …]  # 확정을 기록한다 — 그 id 에만 decided 를 채우고 나머지는 그대로
 *                                                               (--data 로 PLAN 전체를 바꾸면 기존 결정이 지워진다 — 확정에는 이걸 쓴다)
 *   옵션 --pane <id> : [이대로 진행] 이 보낼 pane(계획서를 만든 아테나, 리뷰 뒤 결정이면 그 작업 에이전트). 없으면 PLAN.leadPane(옛 계획서는 hermesPane) → 없으면 화면 계층의 지금 pane(`scripts/screen pane current`)
 *
 * PLAN.json 은 title·type·scope·summary·decisions[] (형식은 docs/plan-template.html 헤더 주석). mdFile 은 자동으로 채운다.
 * 치환은 헤더 주석이 끝난 뒤에서만 한다 — 주석 안의 블록 이름까지 바꾸면 PLAN 이 주석에 갇혀 빈 화면이 된다.
 * 만든 뒤 `scripts/board.sh open <md>` 로 현황판 주소로 연다.
 * 안 정한 결정이 있으면 사람에게 묻는 요청(scripts/lib/requests.mjs · 계획서마다 하나)을 열고, 다 정해지면 받은 것으로 닫는다 — 앱 배지 · 알림이 이것을 센다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquirePlanLock, releaseLock, writeAtomic } from './lib/plan-update.mjs'
import { syncPlanRequest } from './lib/requests.mjs'
import { screenSync } from './lib/screen.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] ?? '' : ''
}
const mdArg = argv.find((arg) => arg.endsWith('.md'))
if (!mdArg) {
  console.error('사용: node scripts/plan-html.mjs <plans/…md> [--data <PLAN.json>] [--pane <id>]')
  process.exit(1)
}
const mdPath = resolve(mdArg)
const mdFile = relative(ROOT, mdPath)
if (!mdFile.startsWith('plans/') || !existsSync(mdPath)) {
  console.error(`⚠️  plans/ 안의 md 가 아니거나 없다: ${mdArg}`)
  process.exit(1)
}
const htmlPath = mdPath.replace(/\.md$/, '.html')
const dataPath = option('data')
const addPath = option('add')
// --decide 뒤의 id=label 들 (다음 -- 옵션 전까지)
const decideIndex = argv.indexOf('--decide')
const decides = []
if (decideIndex >= 0) {
  for (const arg of argv.slice(decideIndex + 1)) {
    if (arg.startsWith('--')) break
    decides.push(arg)
  }
}
if (decideIndex >= 0 && (!decides.length || decides.some((pair) => !/^[^=]+=.+/.test(pair)))) {
  console.error("⚠️  --decide 는 id='label' 형식이다 (예: --decide r1='A 유지' r2='B 되돌림')")
  process.exit(1)
}
if (decides.length && !existsSync(htmlPath)) {
  console.error('⚠️  html 이 없다 — --decide 는 결정 콘솔이 있는 계획서에만 쓴다')
  process.exit(1)
}
if (!existsSync(htmlPath) && !dataPath && !addPath) {
  console.error('⚠️  html 이 없다 — 처음 만들 때는 --data <PLAN.json> (리뷰 뒤 결정이면 --add <결정.json>) 이 필요하다')
  process.exit(1)
}

// html 읽기 → 고치기 → 쓰기를 계획서 잠금(md 와 같은 <계획서>.lock) 안에서 한다 — 동시에 돈 --decide·updatePlan 의 변경을 덮지 않게.
// 중간에 process.exit 로 끝나도 잠금을 푼다
const planLock = acquirePlanLock(mdPath)
process.on('exit', () => releaseLock(planLock))

// 틀(스타일 · 스크립트)은 늘 지금 템플릿 것으로 — 기존 html 에서는 PLAN 블록만 읽는다(본문은 md 에서 다시 넣는다).
// 그래서 템플릿을 고치면 기존 계획서도 다음에 맞출 때 새 모양이 된다
const source = readFileSync(join(ROOT, 'docs/plan-template.html'), 'utf8')
const commentEnd = source.indexOf('-->') + 3
const head = source.slice(0, commentEnd)
let body = source.slice(commentEnd)
const existing = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : null
const existingBody = existing === null ? body : existing.slice(existing.indexOf('-->') + 3)

const planBlock = /(<script id="plan-data">\n)const PLAN = ([\s\S]*?)\n(<\/script>)/

// 기존 html 의 PLAN 블록 읽기 — 코드로 실행하지 않고(new Function 금지) 데이터로만 읽는다.
// 이 스크립트가 쓴 블록은 JSON 이다. 템플릿을 손으로 복사한 블록(따옴표 없는 키 · '…' 문자열 · 주석 · 끝 쉼표)은 JSON 으로 바꿔 읽고,
// 그 밖의 것(변수·함수 호출·템플릿 문자열 등)이 섞여 있으면 읽지 않고 멈춘다
function parsePlanLiteral(source) {
  try {
    return JSON.parse(source)
  } catch { /* 템플릿 모양 — 아래에서 바꿔 본다 */ }
  let out = ''
  let index = 0
  const fail = (why) => { throw new Error(`PLAN 블록을 데이터로 읽지 못했다(${why}, ${index}번째 글자) — html 의 PLAN 을 JSON 으로 고치거나 --data 로 다시 만든다`) }
  while (index < source.length) {
    const char = source[index]
    const rest = source.slice(index)
    if (rest.startsWith('//')) { index = source.indexOf('\n', index); if (index < 0) index = source.length; continue }
    if (rest.startsWith('/*')) { const end = source.indexOf('*/', index + 2); if (end < 0) fail('닫히지 않은 주석'); index = end + 2; continue }
    if (char === "'" || char === '"') {
      let value = ''
      index += 1
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') {
          const next = source[index + 1]
          const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/' }
          if (next in simple) { value += simple[next]; index += 2; continue }
          if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) { value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16)); index += 6; continue }
          fail('알 수 없는 이스케이프')
        }
        if (source[index] === '\n') fail('줄이 바뀐 문자열')
        value += source[index]
        index += 1
      }
      if (index >= source.length) fail('닫히지 않은 문자열')
      index += 1
      out += JSON.stringify(value)
      continue
    }
    const word = rest.match(/^[A-Za-z_$][\w$]*/)?.[0]
    if (word) {
      // 키(뒤에 :) 면 따옴표를 붙이고, 값이면 true·false·null 만
      if (/^\s*:/.test(source.slice(index + word.length))) out += JSON.stringify(word)
      else if (['true', 'false', 'null'].includes(word)) out += word
      else fail(`데이터가 아닌 이름 ${word}`)
      index += word.length
      continue
    }
    const number = rest.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)?.[0]
    if (number) { out += number; index += number.length; continue }
    if (char === ',') {
      // 끝 쉼표 — 다음 글자(빈칸·주석 건너뛰고)가 } 나 ] 면 뺀다
      let ahead = index + 1
      for (;;) {
        while (ahead < source.length && /\s/.test(source[ahead])) ahead += 1
        if (source.startsWith('//', ahead)) { ahead = source.indexOf('\n', ahead); if (ahead < 0) ahead = source.length; continue }
        if (source.startsWith('/*', ahead)) { const end = source.indexOf('*/', ahead + 2); ahead = end < 0 ? source.length : end + 2; continue }
        break
      }
      if (!'}]'.includes(source[ahead] ?? '')) out += char
      index += 1
      continue
    }
    if ('{}[]:'.includes(char) || /\s/.test(char)) { out += char; index += 1; continue }
    fail(`허용하지 않는 글자 ${char}`)
  }
  try {
    return JSON.parse(out)
  } catch (error) {
    index = 0
    return fail(error.message)
  }
}
const current = existingBody.match(planBlock)
if (!current) {
  console.error('⚠️  html 에서 PLAN 블록을 찾지 못했다')
  process.exit(1)
}
let plan
if (dataPath) {
  plan = JSON.parse(readFileSync(dataPath, 'utf8'))
} else if (existing !== null) {
  try {
    plan = parsePlanLiteral(current[2])
  } catch (error) {
    console.error(`⚠️  ${error.message}`)
    process.exit(1)
  }
} else {
  // 경량 계획서에 처음 결정 콘솔을 붙일 때 — 제목은 md 의 첫 제목
  const title = readFileSync(mdPath, 'utf8').match(/^#\s+(.+)$/m)?.[1] ?? mdFile
  plan = { title, type: 'task', scope: '-', summary: '리뷰 뒤 다시 결정할 사항', decisions: [] }
}
if (addPath) {
  const added = JSON.parse(readFileSync(addPath, 'utf8'))
  const list = Array.isArray(added) ? added : added.decisions ?? []
  // 콘솔은 id·title·options[].label 로 동작한다 — 빠지면 바로 거부
  const broken = list.find((decision) => !decision?.id || !decision.title || !Array.isArray(decision.options) || !decision.options.length || decision.options.some((item) => !item?.label))
  if (broken) {
    console.error(`⚠️  결정 형식이 틀렸다 — id·title·options[{label}] 가 필요하다: ${JSON.stringify(broken).slice(0, 120)}`)
    process.exit(1)
  }
  // 리뷰를 두 번 돌면 reviewer 는 다시 R1 부터 매긴다 — 겹치는 r 번호는 다음 빈 번호로 바꾼다
  const taken = new Set((plan.decisions ?? []).map((decision) => decision.id))
  const nextReviewId = () => {
    let number = 1
    while (taken.has(`r${number}`)) number += 1
    return `r${number}`
  }
  for (const decision of list) {
    if (taken.has(decision.id)) {
      if (!/^r\d+$/i.test(decision.id)) {
        console.error(`⚠️  결정 id 가 겹친다: ${decision.id} — 다른 id 로 다시`)
        process.exit(1)
      }
      const renamed = nextReviewId()
      console.log(`   ${decision.id} → ${renamed} (이미 있는 번호라 바꿨다 — 제목의 번호도 확인)`)
      decision.title = decision.title.replace(new RegExp(`^${decision.id}\\b`, 'i'), renamed.toUpperCase())
      decision.id = renamed
    }
    taken.add(decision.id)
  }
  plan.decisions = [...(plan.decisions ?? []), ...list]
}
for (const pair of decides) {
  const [id, ...rest] = pair.split('=')
  const label = rest.join('=')
  const decision = (plan.decisions ?? []).find((item) => item.id === id)
  if (!decision) {
    console.error(`⚠️  그런 결정이 없다: ${id} (있는 것: ${(plan.decisions ?? []).map((item) => item.id).join(', ')})`)
    process.exit(1)
  }
  if (!decision.options.some((item) => item.label === label)) console.log(`   ${id}: '${label}' 는 선택지 label 과 다르다 — 그대로 기록한다`)
  decision.decided = label
}
plan.mdFile = mdFile

const currentPane = () => {
  try {
    return screenSync(['pane', 'current']).pane.id
  } catch {
    return ''
  }
}
const previousPane = (() => {
  try {
    const previous = parsePlanLiteral(current[2])
    return previous.leadPane || previous.hermesPane || ''  // hermesPane — 이름 변경 전 계획서(2026-10)
  } catch {
    return ''
  }
})()
// 리뷰 뒤 결정(--add)은 그 결정을 덧붙인 pane(작업 에이전트)으로 보낸다 — 처음 계획서를 만든 아테나가 아니라
const savedPane = plan.leadPane || plan.hermesPane
// 저장된 pane 이 지금 화면에 없으면 버린다 — 화면(스튜디오 데몬 등)을 다시 띄우면 옛 id 가 사라져 [이대로 진행] 이 보낼 곳을 못 찾았다.
// 지금 pane 을 모르면(화면 계층을 못 부름) 확인할 수 없으니 그대로 둔다
const paneExists = (id) => {
  try {
    return screenSync(['pane', 'get', id]).pane?.id === id
  } catch {
    return false
  }
}
const nowPane = currentPane()
const usable = (id) => Boolean(id) && (!nowPane || id === nowPane || paneExists(id))
plan.leadPane = addPath
  ? option('pane') || nowPane || savedPane || previousPane
  : option('pane') || [savedPane, previousPane].find(usable) || nowPane
// 틀을 늘 지금 템플릿으로 다시 쓰므로 옛 이름(hermesPane)을 읽는 콘솔 코드는 남지 않는다
delete plan.hermesPane

// PLAN 안의 < 는 \u003c 로 — 문자열에 </script> 가 있어도 블록이 끊기지 않게
const planJson = JSON.stringify(plan, null, 2).replace(/</g, '\\u003c')
body = body.replace(planBlock, (_, open, __, close) => `${open}const PLAN = ${planJson}\n${close}`)
// 본문 안의 닫는 태그(대소문자 변형 포함)가 블록을 끊지 않게 — commit.sh 와 같은 방식
const markdown = readFileSync(mdPath, 'utf8').replace(/<\/(script)/gi, '<\\/$1')
body = body.replace(/(<script id="plan-md" type="text\/markdown">\n)[\s\S]*?(<\/script>)/, (_, open, close) => `${open}${markdown}\n${close}`)
writeAtomic(htmlPath, head + body)

const decided = (plan.decisions ?? []).filter((decision) => decision.decided != null).length
console.log(`${relative(ROOT, htmlPath)} · 결정 ${decided}/${plan.decisions?.length ?? 0} 확정 · 보낼 pane ${plan.leadPane || '(없음 — 복사로만)'}`)
// 요청은 곁가지 — 못 열어도 결정 콘솔은 그대로 쓴다
try {
  const { request } = syncPlanRequest(ROOT, { mdFile, htmlFile: relative(ROOT, htmlPath), plan })
  if (request) console.log(`   요청 ${request.id} · ${request.state}`)
} catch (error) {
  console.log(`   ⚠️ 요청을 열지 못했다 — ${error.message}`)
}
