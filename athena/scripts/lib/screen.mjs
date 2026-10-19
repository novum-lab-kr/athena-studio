// 화면 계층(node) — pane·탭·workspace 는 scripts/screen 을 불러 다룬다(데몬 CLI 를 직접 부르지 않는다).
// 계약·백엔드 고르기는 파이썬 쪽 정본 scripts/lib/screen.py 에 있다 — 여기는 부르고 JSON 을 읽기만 한다.
//   await screen(['pane', 'list'])                → { panes: [...] } · 실패면 null (바꾸는 동작은 성공하면 {})
//   screenSync(['pane', 'current'])               → { pane: {...} } · 실패면 예외
//   screenName()                                  → 안내 글에 쓸 화면 이름(지금 백엔드)
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

export const screenSync = (args, options = {}) => parse(execFileSync(SCREEN, args, { encoding: 'utf8', ...options }))

// 주소 열기 — 기다리지 않는다(브라우저가 뜨는 동안 부른 쪽을 막지 않게 · 실패는 조용히)
export const openUrl = (url) => spawn(SCREEN, ['open-url', url], { stdio: 'ignore', detached: true }).unref()

// 주소 열기 — 끝날 때까지 기다린다 · 실패면 예외
export const openUrlSync = (url) => execFileSync(SCREEN, ['open-url', url], { stdio: 'ignore', timeout: 30000 })

// 안내 글에 쓸 화면 이름(Athena Studio …) — 실패해도 글자는 돌려준다
export const screenName = () => {
  try {
    return execFileSync(SCREEN, ['name'], { encoding: 'utf8', timeout: 5000 }).trim() || '화면 터미널'
  } catch {
    return '화면 터미널'
  }
}
