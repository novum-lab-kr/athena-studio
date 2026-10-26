#!/usr/bin/env node
/**
 * Jev 키 등록 — 사람이 직접 치는 입력 창. 키는 대화창·계획서·로그 어디에도 지나가지 않는다.
 * 첫 실행(docs/setup.md 8-1)이 묻고, 나중에 "Jev 키 등록해줘" 라고 해도 같은 창을 띄운다.
 *
 *   node scripts/jev-key.mjs             키를 입력받아(화면에 안 보임) 맞는지 확인하고 ~/.config/athena/typesafe.key 에 저장(권한 600)
 *   node scripts/jev-key.mjs --status    있는지 · 어디서(환경 변수/파일) · 길이만. --check 를 붙이면 HTTP 상태도
 *   node scripts/jev-key.mjs --remove    저장한 키 파일을 지운다
 *
 * 키 받는 곳: https://console.typesafe.ai/keys (유료 · 사용량은 키 주인에게 청구) — 사람마다 본인 키, 나눠 쓰지 않는다
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { JEV_KEY_FILE, checkJevKey, jevKeySource } from './lib/jev.mjs'

const argv = process.argv.slice(2)
const say = (line = '') => process.stdout.write(`${line}\n`)
const statusText = (code) => (code === 200 ? '맞음(HTTP 200)' : code === 401 || code === 403 ? `키가 맞지 않음(HTTP ${code})` : code === 0 ? '확인 못 함(네트워크 실패)' : `확인 못 함(HTTP ${code})`)

// 화면에 안 보이게 한 글자씩 읽는다 — 붙여 넣기도 된다. Enter 로 끝, Ctrl+C 로 그만
const readHidden = (prompt) => new Promise((done, fail) => {
  const input = process.stdin
  if (!input.isTTY) return fail(new Error('입력 창(터미널)에서 직접 돌려 주세요 — 키는 대화창이나 파이프로 받지 않아요'))
  process.stdout.write(prompt)
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')
  let value = ''
  const finish = (error) => {
    input.setRawMode(false)
    input.pause()
    input.removeListener('data', onData)
    process.stdout.write('\n')
    if (error) fail(error)
    else done(value.trim())
  }
  const onData = (chunk) => {
    for (const char of chunk) {
      if (char === '\r' || char === '\n') return finish()
      if (char === '\u0003') return finish(new Error('그만뒀어요 — 아무것도 저장하지 않았어요'))
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
      else if (char >= ' ') value += char
    }
  }
  input.on('data', onData)
})

async function status() {
  const source = jevKeySource()
  if (!source) {
    say('Jev 키: 없음 — Jev 없이 그대로 돈다. 등록하려면 node scripts/jev-key.mjs')
    return
  }
  const length = source === 'env' ? process.env.TYPESAFE_API_KEY.length : readFileSync(JEV_KEY_FILE, 'utf8').trim().length
  say(`Jev 키: 있음 — ${source === 'env' ? '환경 변수 TYPESAFE_API_KEY' : JEV_KEY_FILE} · ${length}자${process.env.ATHENA_JEV === 'off' ? ' · 지금은 꺼 둠(ATHENA_JEV=off)' : ''}`)
  if (source === 'env' && existsSync(JEV_KEY_FILE)) say(`  (파일 ${JEV_KEY_FILE} 도 있지만 환경 변수가 먼저다)`)
  if (argv.includes('--check')) say(`  확인: ${statusText(await checkJevKey())}`)
}

function remove() {
  if (!existsSync(JEV_KEY_FILE)) {
    say(`지울 키 파일이 없어요 (${JEV_KEY_FILE})`)
    return
  }
  rmSync(JEV_KEY_FILE)
  say(`키 파일을 지웠어요 — ${JEV_KEY_FILE}${process.env.TYPESAFE_API_KEY ? ' · 환경 변수 TYPESAFE_API_KEY 는 남아 있어요(셸 설정에서 지우세요)' : ' · 이제 Jev 없이 돈다'}`)
}

async function register() {
  say('🔑 TypeSafe Jev 키 등록')
  say('   키 받는 곳: https://console.typesafe.ai/keys (유료 · 사용량은 키 주인에게 청구 · 나눠 쓰지 않아요)')
  say('   입력한 글자는 화면에 보이지 않아요. 붙여 넣고 Enter. 그만두려면 Ctrl+C')
  const key = await readHidden('   키: ')
  if (!key) {
    say('비어 있어서 저장하지 않았어요')
    process.exitCode = 1
    return
  }
  const code = await checkJevKey(key)
  say(`   확인: ${statusText(code)}`)
  if (code === 401 || code === 403) {
    say('저장하지 않았어요 — 콘솔에서 키를 다시 복사해 주세요')
    process.exitCode = 1
    return
  }
  mkdirSync(dirname(JEV_KEY_FILE), { recursive: true, mode: 0o700 })
  writeFileSync(JEV_KEY_FILE, `${key}\n`, { mode: 0o600 })
  chmodSync(JEV_KEY_FILE, 0o600)
  say(`✅ 저장했어요 — ${JEV_KEY_FILE} (이 컴퓨터에만 · 권한 600)${code === 200 ? '' : ' · 확인은 못 했으니 나중에 --status --check 로 다시 보세요'}`)
  if (process.env.TYPESAFE_API_KEY) say('   참고: 환경 변수 TYPESAFE_API_KEY 가 있어서 그게 먼저 쓰여요')
  say('   일감·배우기 검토는 다시 켜지 않아도 다음 판정부터 Jev 를 써요. 이 창은 닫아도 돼요')
}

try {
  if (argv.includes('--status')) await status()
  else if (argv.includes('--remove')) remove()
  else await register()
} catch (error) {
  say(error.message)
  process.exitCode = 1
}
