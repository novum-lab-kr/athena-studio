// 개발 앱 ⚙ 업데이트 — 앱이 꺼진 사이 도우미(scripts/dev-app.js restart)가 띄우는 맥 알림.
// 그 사이엔 앱 화면 · 트레이가 없어 heavy.sh 잠금 대기 · npm install 실패를 보일 곳이 맥 알림뿐이다.
// 문구는 앱 사전(src/i18n/<언어>.json)을 그대로 읽는다 — 언어는 앱이 --lang 으로 넘긴다(없으면 시스템 언어 → 영어 · i18n.mts pickLanguage).
// dev-app.js(CommonJS)가 require 한다 — Node 22.18 이상은 .mts 를 타입만 지우고 읽는다
import fs from 'node:fs'
import path from 'node:path'
import * as i18n from './i18n.mts'
import type { Dictionary, Say } from './i18n.mts'

export type WaitEvent = { kind: 'lock'; what: string } | { kind: 'load'; load: string }
export type NoticeEvent = WaitEvent | { kind: 'gave-up' } | { kind: 'install-failed' } | { kind: 'killed' }

const I18N_DIR = path.join(import.meta.dirname, '..', 'i18n')
const SCRIPT_FILE = /\.(sh|m?js|mts|ts|py)$/
// 앞에 붙는 실행기 — 무엇이 도는지 이름으로 보일 때 건너뛴다(환경 변수 KEY=값 도)
const RUNNERS = new Set(['bash', 'sh', 'zsh', 'node', 'env', 'python', 'python3'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'npx'])

export const pickLanguage = i18n.pickLanguage

function readDictionary(language: string): Dictionary {
  try {
    return JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${language}.json`), 'utf8')) as Dictionary
  } catch {
    return {}
  }
}

// 그 언어 사전의 say — 없는 키는 한국어 사전 → 키 이름(i18n.mts 규칙)
export function translator(language: string): Say {
  return i18n.translator(readDictionary(language), readDictionary(i18n.FALLBACK_LANGUAGE))
}

// heavy.sh 잠금의 what("<누가> · <명령…>") → 짧은 이름: 스크립트면 파일 이름(syung.sh), npm 류면 "npm install", 아니면 첫 명령 이름
export function commandName(what: string): string {
  const command = what.includes(' · ') ? what.slice(what.indexOf(' · ') + 3) : what
  const words = command.trim().split(/\s+/).filter(Boolean)
  const script = words.find((word) => SCRIPT_FILE.test(word))
  if (script) return path.basename(script)
  const first = words.findIndex((word) => !word.includes('=') && !RUNNERS.has(path.basename(word)))
  if (first < 0) return what.trim() || '?'
  const name = path.basename(words[first] || '')
  const next = words[first + 1]
  return PACKAGE_MANAGERS.has(name) && next && !next.startsWith('-') ? `${name} ${next}` : name
}

// "자리1: a · b · 자리2: c · d" → "a · b" (자리 표시가 없으면 그대로)
function firstSlot(text: string): string {
  return text.replace(/^자리\d+:\s*/, '').split(/ · 자리\d+: /)[0] || ''
}

// heavy.sh 가 기다리며 찍는 줄(athena/scripts/heavy.sh note) → 잠금 · 부하 대기 | null
//   "⏳ 대기 30초 — 다른 무거운 명령이 도는 중: <what>" · "⏳ 대기 0초 — 부하 12.3 > 한도 9.6 (코어 8)"
export function parseWaitLine(line: string): WaitEvent | null {
  const match = /^⏳ 대기 \d+초 — (.*)$/.exec(line.trim())
  if (!match) return null
  const reason = match[1] || ''
  // 옛 heavy.sh 는 "…도는 중: <what>" · 자리가 둘이 된 뒤는 "…도는 중 — 자리1: <what> · 자리2: <what>" — 앞 자리 것을 이름으로
  const lock = /^다른 무거운 명령이 도는 중(?::| —) (.*)$/.exec(reason)
  if (lock) return { kind: 'lock', what: commandName(firstSlot(lock[1] || '')) }
  const load = /^부하 (\S+) >/.exec(reason)
  if (load) return { kind: 'load', load: load[1] || '?' }
  return null
}

// 알림 문구 — 제목은 앱 업데이트 대화상자와 같은 말
export function noticeText(say: Say, event: NoticeEvent): { title: string; body: string } {
  const title = say('dialog.appUpdate.message')
  if (event.kind === 'lock') return { title, body: say('notify.appUpdate.waitLock', { what: event.what }) }
  if (event.kind === 'load') return { title, body: say('notify.appUpdate.waitLoad', { load: event.load }) }
  if (event.kind === 'gave-up') return { title, body: say('notify.appUpdate.gaveUp') }
  if (event.kind === 'killed') return { title, body: say('notify.appUpdate.installKilled') }
  return { title, body: say('notify.appUpdate.installFailed') }
}

// osascript 인자 — 글은 argv 로 넘긴다(스크립트 문자열에 끼우지 않아 따옴표가 섞여도 깨지지 않는다)
export function notifyArgs(title: string, body: string): string[] {
  return ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
}
