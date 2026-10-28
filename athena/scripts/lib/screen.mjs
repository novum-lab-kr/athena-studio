// 화면 계층(node) — pane·탭·workspace 는 scripts/screen 을 불러 다룬다(데몬 CLI 를 직접 부르지 않는다).
// 계약·백엔드 고르기는 파이썬 쪽 정본 scripts/lib/screen.py 에 있다 — 여기는 부르고 JSON 을 읽기만 한다.
//   await screen(['pane', 'list'])                → { panes: [...] } · 실패면 null (바꾸는 동작은 성공하면 {})
//   await screenText(['pane', 'read', id])      → 화면 글 그대로 · 실패면 null
//   screenSync(['pane', 'current'])               → { pane: {...} } · 실패면 예외
//   screenName()                                  → 안내 글에 쓸 화면 이름(지금 백엔드)
//   nameLeadPane(title)                           → 아테나 pane 이름을 '🧭 아테나 · <제목>' 으로(에이전트 pane · 화면 밖이면 안 함 · 실패는 조용히)
//   openUrl(url) · openUrlSync(url)               → 주소 열기(studio 면 그 창 옆 브라우저 · 아니면 기본 브라우저 — scripts/screen open-url)
import { execFile, execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCREEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'screen')

const parse = (stdout) => (stdout.trim() ? JSON.parse(stdout) : {})

export const screen = (args, options = {}) =>
  new Promise((resolve) => {
    execFile(SCREEN, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        resolve(parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })

// 글로 답하는 동작(pane read) — 출력 그대로 · 실패면 null
export const screenText = (args, options = {}) =>
  new Promise((resolve) => {
    execFile(SCREEN, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout) => resolve(error ? null : stdout))
  })

export const screenSync = (args, options = {}) => parse(execFileSync(SCREEN, args, { encoding: 'utf8', ...options }))

// 주소 열기 — 기다리지 않는다(브라우저가 뜨는 동안 부른 쪽을 막지 않게 · 실패는 조용히)
export const openUrl = (url) => spawn(SCREEN, ['open-url', url], { stdio: 'ignore', detached: true }).unref()

// 주소 열기 — 끝날 때까지 기다린다 · 실패면 예외
export const openUrlSync = (url) => execFileSync(SCREEN, ['open-url', url], { stdio: 'ignore', timeout: 30000 })

// 아테나 pane 이름을 맡은 계획서 제목으로 — 일감 [작업 시작](board/server.mjs openHermesPane)과 같은 형식 '🧭 아테나 · <제목 앞 30자>'.
// 에이전트 pane(ATHENA_AGENT — delegate.sh 가 넣는다)이면 건드리지 않고, 화면 밖(부른 pane 없음)이면 아무것도 안 한다.
// 실패는 조용히 — 바꾼 이름을 돌려주고 못 바꾸면 ''
export const nameLeadPane = (title) => {
  if (process.env.ATHENA_AGENT || !title) return ''
  try {
    const paneId = screenSync(['self'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).pane_id
    if (!paneId) return ''
    const label = `🧭 아테나 · ${title.slice(0, 30).trim()}`
    screenSync(['pane', 'rename', paneId, label], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return label
  } catch {
    return ''
  }
}

// 안내 글에 쓸 화면 이름(Athena Studio …) — 실패해도 글자는 돌려준다
export const screenName = () => {
  try {
    return execFileSync(SCREEN, ['name'], { encoding: 'utf8', timeout: 5000 }).trim() || '화면 터미널'
  } catch {
    return '화면 터미널'
  }
}
