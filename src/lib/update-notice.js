// @ts-check
// 개발 앱 ⚙ 업데이트 — 앱이 꺼진 사이 도우미(scripts/dev-app.js restart)가 띄우는 맥 알림.
// 그 사이엔 앱 화면 · 트레이가 없어 heavy.sh 잠금 대기 · npm install 실패를 보일 곳이 맥 알림뿐이다.
// 문구는 앱 사전(src/i18n/<언어>.json)을 그대로 읽는다 — 언어는 앱이 --lang 으로 넘긴다(없으면 시스템 언어 → 영어).
// JS(CommonJS)인 까닭: dev-app.js 가 PATH 의 node 로도 돈다(studio-home.js 와 같음) — 그래서 i18n.mts 를 싣지 않고 자리 채우기만 따로 둔다.
const fs = require('fs')
const path = require('path')

const I18N_DIR = path.join(__dirname, '..', 'i18n')
const LANGUAGES = ['ko', 'en', 'ja', 'zh'] // src/lib/i18n.mts LANGUAGES 와 같게
const FALLBACK_LANGUAGE = 'ko'
const UNKNOWN_LANGUAGE = 'en'
const SCRIPT_FILE = /\.(sh|m?js|mts|ts|py)$/
// 앞에 붙는 실행기 · 환경 변수 — 무엇이 도는지 이름으로 보일 때 건너뛴다
const RUNNERS = new Set(['bash', 'sh', 'zsh', 'node', 'env', 'python', 'python3'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'npx'])

/** @param {unknown} locale */
function normalize(locale) {
  if (typeof locale !== 'string') return null
  const base = locale.trim().toLowerCase().split(/[-_]/)[0] || ''
  return LANGUAGES.includes(base) ? base : null
}

// 넘긴 언어 → 시스템 언어 → 영어(i18n.mts pickLanguage 와 같은 순서)
/** @param {unknown} setting @param {unknown} systemLocale */
function pickLanguage(setting, systemLocale) {
  return normalize(setting) || normalize(systemLocale) || UNKNOWN_LANGUAGE
}

/** @param {string} language @returns {Record<string, unknown>} */
function readDictionary(language) {
  try {
    return JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${language}.json`), 'utf8'))
  } catch {
    return {}
  }
}

// say(키, 값) — 없는 키는 한국어 사전 → 키 이름(i18n.mts t 와 같은 규칙)
/** @param {string} language @returns {(key: string, values?: Record<string, unknown>) => string} */
function translator(language) {
  const dictionary = readDictionary(language)
  const fallback = language === FALLBACK_LANGUAGE ? dictionary : readDictionary(FALLBACK_LANGUAGE)
  return (key, values = {}) => {
    const found = [dictionary[key], fallback[key]].find((text) => typeof text === 'string')
    const text = typeof found === 'string' ? found : key
    return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name] ?? '') : whole))
  }
}

// heavy.sh 잠금의 what("<누가> · <명령…>") → 짧은 이름: 스크립트면 파일 이름(syung.sh), npm 류면 "npm install", 아니면 첫 명령 이름
/** @param {string} what */
function commandName(what) {
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

// heavy.sh 가 기다리며 찍는 줄(athena/scripts/heavy.sh note) → { kind: 'lock', what } | { kind: 'load', load } | null
//   "⏳ 대기 30초 — 다른 무거운 명령이 도는 중: <what>" · "⏳ 대기 0초 — 부하 12.3 > 한도 9.6 (코어 8)"
/** @param {string} line @returns {{ kind: 'lock', what: string } | { kind: 'load', load: string } | null} */
function parseWaitLine(line) {
  const match = /^⏳ 대기 \d+초 — (.*)$/.exec(line.trim())
  if (!match) return null
  const reason = match[1] || ''
  const lock = /^다른 무거운 명령이 도는 중: (.*)$/.exec(reason)
  if (lock) return { kind: 'lock', what: commandName(lock[1] || '') }
  const load = /^부하 (\S+) >/.exec(reason)
  if (load) return { kind: 'load', load: load[1] || '?' }
  return null
}

// 알림 문구 — title · body
/** @param {(key: string, values?: Record<string, unknown>) => string} say
 *  @param {{ kind: 'lock', what: string } | { kind: 'load', load: string } | { kind: 'gave-up' } | { kind: 'install-failed' }} event */
function noticeText(say, event) {
  const title = say('dialog.appUpdate.message')
  if (event.kind === 'lock') return { title, body: say('notify.appUpdate.waitLock', { what: event.what }) }
  if (event.kind === 'load') return { title, body: say('notify.appUpdate.waitLoad', { load: event.load }) }
  if (event.kind === 'gave-up') return { title, body: say('notify.appUpdate.gaveUp') }
  return { title, body: say('notify.appUpdate.installFailed') }
}

// osascript 인자 — 글은 argv 로 넘긴다(스크립트 문자열에 끼우지 않아 따옴표가 섞여도 깨지지 않는다)
/** @param {string} title @param {string} body */
function notifyArgs(title, body) {
  return ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
}

module.exports = { pickLanguage, translator, commandName, parseWaitLine, noticeText, notifyArgs }
