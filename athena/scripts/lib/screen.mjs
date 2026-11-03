// 화면 계층(node) — pane·탭·workspace 는 scripts/screen 을 불러 다룬다(데몬 CLI 를 직접 부르지 않는다).
// 계약·백엔드 고르기는 파이썬 쪽 정본 scripts/lib/screen.py 에 있다 — 여기는 부르고 JSON 을 읽기만 한다.
//   await screen(['pane', 'list'])                → { panes: [...] } · 실패면 null (바꾸는 동작은 성공하면 {})
//   await screenText(['pane', 'read', id])      → 화면 글 그대로 · 실패면 null
//   await submitToPane(id, text)                  → 글 + Enter 공통 전송 — 'sent' · 'wait'(안 들어감 · 다시 보내도 됨) · 실패 글
//   screenSync(['pane', 'current'])               → { pane: {...} } · 실패면 예외
//   screenName()                                  → 안내 글에 쓸 화면 이름(지금 백엔드)
//   callerPane(options)                           → 부른 pane id(scripts/screen self) · 화면 밖이면 포커스된 pane(pane current) · 둘 다 없으면 ''
//   nameLeadPane(title, { planText, agents })     → 아테나 pane 이름을 '<레포> · <제목 앞 30자>' 로(레포 모르면 제목만 · 에이전트 pane · 화면 밖이면 안 함 · 실패는 조용히)
//   openUrl(url) · openUrlSync(url)               → 주소 열기(studio 면 그 창 옆 브라우저 · 아니면 기본 브라우저 — scripts/screen open-url)
import { execFile, execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paneNameOfPlan } from './pane-name.mjs'

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

// 글 + Enter 를 공통 전송 경로로 — scripts/screen pane send-text <pane> <글> --enter(데몬 pane run: 글이 들어갔는지 · 입력칸이 비었는지 확인하고
// 같은 입력이 남았을 때만 Enter 를 다시 누른다 · lead-send.py 와 같은 길). 돌려주는 값:
//   'sent' — 전송 확인 · 'wait' — 데몬이 쓰기 전에 거절했다(질문 창이 열려 있음 · 다른 전송 중 — 글은 안 들어갔으니 나중에 다시 보내도 된다)
//   그 밖의 글 — 실패(글이 입력칸에 들어갔는지 모른다 — 같은 글을 다시 보내지 않는다)
// 데몬이 전송 확인 · Enter 재시도를 하느라 몇 초 걸려 시간 한도는 screen() 보다 넉넉히
const NOT_WRITTEN = ['입력을 기다리는 질문이 열려 있다', '이 pane 에 입력을 보내는 중이다']
export const submitToPane = (paneId, text, options = {}) =>
  new Promise((resolve) => {
    execFile(SCREEN, ['pane', 'send-text', paneId, text, '--enter'], { encoding: 'utf8', timeout: 30000, ...options }, (error, _stdout, stderr) => {
      if (!error) return resolve('sent')
      let failure = {}
      try {
        failure = JSON.parse(String(stderr ?? '').trim().split('\n').at(-1) ?? '') ?? {}
      } catch {
        // 약속한 모양({"error","message"})이 아니면 아래에서 오류 글로
      }
      const message = typeof failure.message === 'string' ? failure.message : ''
      if (failure.error === 'unavailable' && NOT_WRITTEN.some((mark) => message.includes(mark))) return resolve('wait')
      resolve(message || `pane ${paneId} 에 입력을 보내지 못했다`)
    })
  })

export const screenSync = (args, options = {}) => parse(execFileSync(SCREEN, args, { encoding: 'utf8', ...options }))

// 주소 열기 — 기다리지 않는다(브라우저가 뜨는 동안 부른 쪽을 막지 않게 · 실패는 조용히)
export const openUrl = (url) => spawn(SCREEN, ['open-url', url], { stdio: 'ignore', detached: true }).unref()

// 주소 열기 — 끝날 때까지 기다린다 · 실패면 예외
export const openUrlSync = (url) => execFileSync(SCREEN, ['open-url', url], { stdio: 'ignore', timeout: 30000 })

// 아테나 pane 이름을 '<레포> · <제목 앞 30자>' 로 — 현황판 [작업 시작](board/server.mjs openHermesPane)과 같은 형식(lib/pane-name.mjs).
// 레포는 맡은 계획서(planText · agents)에서 읽고, 못 정하면 제목만. 아테나 작업 공간 안이라 '아테나' 접두어는 붙이지 않는다.
// 에이전트 pane(ATHENA_AGENT — delegate.sh 가 넣는다)이면 건드리지 않고, 화면 밖(부른 pane 없음)이면 아무것도 안 한다.
// 실패는 조용히 — 바꾼 이름을 돌려주고 못 바꾸면 ''
export const nameLeadPane = (title, plan = {}) => {
  if (process.env.ATHENA_AGENT || !title) return ''
  try {
    const paneId = screenSync(['self'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).pane_id
    if (!paneId) return ''
    const label = paneNameOfPlan(title, plan)
    if (!label) return ''
    screenSync(['pane', 'rename', paneId, label], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return label
  } catch {
    return ''
  }
}

// 이 명령을 부른 pane — 결정 콘솔 · 요청 · QA 런이 답을 돌려보낼 곳(GitHub #107).
// pane current 는 '포커스된 pane'(사용자가 보고 있는 다른 pane 일 수 있다)이라 먼저 self(부른 pane)를 보고,
// 화면 밖(self.inside === false — 현황판 서버 등)일 때만 pane current 로 넘어간다. options 는 screenSync 에 그대로(stdio 등)
export const callerPane = (options = {}) => {
  try {
    const self = screenSync(['self'], { timeout: 5000, ...options })
    if (self.pane_id) {
      return screenSync(['pane', 'get', self.pane_id], { timeout: 5000, ...options }).pane?.id === self.pane_id ? self.pane_id : ''
    }
    // 화면 밖임을 확인한 경우에만 기존 포커스 대안을 쓴다. self 실패·pane 안의 빈 ID 는 다른 대화로 보내지 않는다.
    if (self.inside !== false) return ''
  } catch {
    return ''
  }
  try {
    return screenSync(['pane', 'current'], options).pane?.id ?? ''
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
