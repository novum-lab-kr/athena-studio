// 화면 문구가 사전(src/i18n)을 거치는지 — 코드가 부르는 키가 사전에 있고, 범위 안 파일에 한국어 글이 새로 남지 않는다.
// 범위: 스튜디오 화면 · 메뉴 · 대화상자 · 트레이. 코어 명령 출력 · 일감 · 로그 · 내부 오류는 밖(아래 허용 목록)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const korean = JSON.parse(read('src/i18n/ko.json'))
const HANGUL = /[가-힣]/

const SCRIPT_FILES = ['src/main.mts', 'src/renderer/renderer.js', 'src/renderer/tray.js', 'src/lib/pack.mts', 'src/lib/tray-model.mts', 'src/main/monitor-logs.mts', 'src/main/files.mts', 'src/main/board.mts', 'src/main/core-runner.mts', 'src/main/app-updater.mts', 'src/main/tray.mts', 'src/main/explorer-panel.mts', 'src/main/athena-agent.mts', 'src/main/pack-repos.mts', 'src/main/work.mts', 'src/main/daemon-link.mts', 'src/main/workspaces.mts', 'src/main/agent-monitor.mts', 'src/main/pane-watch.mts', 'src/main/catch-up.mts', 'src/main/athena-dir.mts', 'src/main/packs.mts', 'src/main/side-browser.mts', 'src/main/pack-window.mts', 'src/renderer/ui/settings-pop.tsx', 'src/renderer/ui/work-pop.tsx', 'src/renderer/ui/monitor.tsx']
const HTML_FILES = ['src/renderer/index.html', 'src/renderer/tray.html']

// 범위 밖이라 한국어로 두는 글 — 파일별로 그 줄에 들어 있는 글 조각
const ALLOWED = {
  // 예전 터미널 모니터 칸 이름표(이미 떠 있는 pane 을 찾는 값) · 일감 로그 머리줄 · pack.log 원문 표시 · 내부 IPC 오류 · 데몬 오류 글 맞추기
  'src/main.mts': ['잘못된 경계 값', '/모르는 동작/', '앱 화면에서만 부를 수 있어요'],
  'src/main/monitor-logs.mts': ['🛰 에이전트 모니터'],
  'src/main/board.mts': ['일감 시작 (포트'],
  'src/main/core-runner.mts': ['[JSON 이 아닌 마지막 줄]'],
  // 본체 출력 해석 중 던지고 바로 잡는 내부 예외
  // · 본체 new-branch.sh 출력 맞추기(워크트리 자리 · 이미 있음)
  'src/lib/pack.mts': ["new Error('객체가 아님')", '워크트리:', '워크트리 경로가 이미 있다:', "'이미 있다'", "'로컬'", "'(커밋 없음)'"],
}

// 주석을 뺀 줄 — 줄 전체 주석(JSX 의 {/* … */} 포함)과 ' // ' 뒤(주소의 :// 는 앞에 공백이 없어 남는다)
function codeLines(text) {
  return text.split('\n').map((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('{/*')) return { number: index + 1, code: '' }
    const comment = line.indexOf(' // ')
    return { number: index + 1, code: comment >= 0 ? line.slice(0, comment) : line }
  })
}

test('화면 문구: 코드 · HTML 이 부르는 사전 키가 한국어 사전에 모두 있다', () => {
  const missing = []
  for (const file of [...SCRIPT_FILES, ...HTML_FILES]) {
    const text = read(file)
    const keys = [...text.matchAll(/say\(\s*'([^']+)'/g), ...text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g), ...text.matchAll(/setSetupTitle\('([^']+)'\)/g)].map((match) => match[1])
    for (const key of keys) if (!(key in korean)) missing.push(`${file}: ${key}`)
  }
  assert.deepEqual(missing, [])
})

test('화면 문구: 범위 안 스크립트에 한국어 글이 남지 않는다(주석 · 허용 목록 밖)', () => {
  const left = []
  for (const file of SCRIPT_FILES) {
    const allowed = ALLOWED[file] || []
    for (const { number, code } of codeLines(read(file))) {
      if (!HANGUL.test(code) || allowed.some((piece) => code.includes(piece))) continue
      left.push(`${file}:${number} ${code.trim()}`)
    }
  }
  assert.deepEqual(left, [])
})

test('화면 문구: HTML 의 한국어는 data-i18n 이 덮는 기본 글뿐이다', () => {
  const left = []
  for (const file of HTML_FILES) {
    const html = read(file)
      .replace(/<!--[\s\S]*?-->/g, '')
      // 글을 사전으로 바꾸는 요소의 기본 글
      .replace(/<(\w+)([^>]*\sdata-i18n="[^"]+"[^>]*)>[^<]*<\/\1>/g, '<$1$2></$1>')
    for (const tag of html.match(/<[^>]+>/g) || []) {
      for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (!HANGUL.test(value)) continue
        if (!tag.includes(`data-i18n-${name}=`)) left.push(`${file}: ${name}="${value}"`)
      }
    }
    for (const text of html.replace(/<[^>]+>/g, '\n').split('\n')) if (HANGUL.test(text)) left.push(`${file}: ${text.trim()}`)
  }
  assert.deepEqual(left, [])
})

test('순수 로직: pack · tray-model 은 넘긴 언어의 say 로 쓴다(안 넘기면 한국어)', () => {
  const i18n = require('../src/lib/i18n')
  const pack = require('../src/lib/pack.mts')
  const tray = require('../src/lib/tray-model.mts')
  const english = i18n.translator(JSON.parse(read('src/i18n/en.json')), korean)
  assert.equal(pack.packErrorText({ ok: false, error: 'locked' }, english), 'Packs are being swapped elsewhere — try again when it finishes')
  assert.match(pack.packErrorText({ ok: false, error: 'busy', busy: [{ kind: 'heavy', what: 'npm ci' }] }, english), /· heavy command — npm ci/)
  assert.equal(pack.parseProgressLine('progress: verify', english).text, 'Checking the new pack')
  assert.equal(pack.parseProgressLine('progress: verify 본체 설명', english).text, '본체 설명')
  assert.equal(pack.packSummary({ repos: 2, hasWork: true, source: 'local' }, english), 'repos: 2 · has work history · local')
  const notifier = new tray.Notifier()
  notifier.updateRequests([])
  assert.equal(notifier.updateRequests([{ id: 'r1', kind: 'decision', state: 'open', title: 't' }], english)[0].title, 'A decision is needed')
  const now = new Date(2026, 9, 18, 12, 0).getTime()
  assert.equal(tray.resetClock(new Date(2026, 9, 19, 9, 30).getTime(), now, english), 'tomorrow 09:30')
  const bundled = tray.bundle([{ kind: 'waiting', title: 'Done', body: 'a — x' }, { kind: 'waiting', title: 'Done', body: 'b — y' }], english)
  assert.equal(bundled[0].title, 'Done (2)')
  assert.equal(bundled[0].body, 'a, b')
})
